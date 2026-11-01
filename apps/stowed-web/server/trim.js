'use strict';

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { randomUUID } = require('crypto');
const { getFfmpegPath, getFfprobePath } = require('./binaries');
const { isAudioFile } = require('./security');
const { parsePages, demuxPackets, commentPacketInfo, replaceOggCommentPacket } = require('@stowed/core');

/**
 * Best-effort kill for a child process (avoids surfacing a stray throw).
 */
function safeKill(proc) {
  try { proc.kill(); } catch (_) { /* already gone */ }
}

// Max concurrent trims: each spawns a 5-min ffmpeg re-encode. Bound LAN-wide
// CPU/disk usage; routes map the busy error to 429.
let activeTrims = 0;
const MAX_CONCURRENT_TRIMS = 2;

// ffprobe duration reads are cheap but still spawn a process per call.
let activeProbes = 0;
const MAX_CONCURRENT_PROBES = 6;

/**
 * Probe audio duration in seconds via ffprobe.
 * @returns {Promise<number>}
 */
function getDuration(filePath) {
  if (!filePath || typeof filePath !== 'string') {
    return Promise.reject(new Error('Invalid file path'));
  }
  let ffprobePath;
  try {
    ffprobePath = getFfprobePath();
  } catch (err) {
    return Promise.reject(err);
  }
  if (activeProbes >= MAX_CONCURRENT_PROBES) {
    return Promise.reject(new Error('Server busy: too many duration reads, try again shortly'));
  }
  activeProbes += 1;
  return new Promise((resolve, reject) => {
    let settled = false;
    // Declared before use: early validation above runs before the counter,
    // so done() never observes `guard` in TDZ and slots never leak.
    let guard;
    const done = (fn, ...args) => {
      if (settled) return;
      settled = true;
      clearTimeout(guard);
      activeProbes -= 1;
      fn(...args);
    };

    const args = [
      '-v', 'quiet',
      '-print_format', 'json',
      '-show_entries', 'format=duration',
      filePath,
    ];

    let stdout = '';
    let proc;
    try {
      proc = spawn(ffprobePath, args);
    } catch (_) {
      return done(reject, new Error('Failed to start ffprobe'));
    }

    const MAX_STDOUT = 64 * 1024;
    guard = setTimeout(() => {
      safeKill(proc);
      done(reject, new Error('Timed out reading audio duration'));
    }, 15_000);

    proc.stdout.on('data', (data) => {
      if (stdout.length >= MAX_STDOUT) { safeKill(proc); return; }
      stdout += data.toString();
    });
    // Drain stderr so a noisy/corrupt file can't fill the pipe and stall
    // the probe until the timeout guard fires.
    proc.stderr.on('data', () => {});

    proc.on('close', (code) => {
      if (stdout.length >= MAX_STDOUT) {
        return done(reject, new Error('Invalid audio duration: ffprobe output too large'));
      }
      if (code !== 0) {
        if (code == null) {
          return done(reject, new Error('Timed out reading audio duration'));
        }
        return done(reject, new Error('Invalid audio duration'));
      }
      try {
        const parsed = JSON.parse(stdout);
        const raw = parsed && parsed.format && parsed.format.duration;
        const duration = parseFloat(raw);
        if (!Number.isFinite(duration) || duration <= 0) {
          return done(reject, new Error('Invalid audio duration'));
        }
        done(resolve, duration);
      } catch (_) {
        done(reject, new Error('Invalid audio duration'));
      }
    });

    proc.on('error', () => {
      done(reject, new Error('Failed to start ffprobe'));
    });
  });
}

/**
 * Best-effort re-attachment of Ogg metadata after a trim. FFmpeg cannot carry
 * Vorbis comments (tags and the embedded METADATA_BLOCK_PICTURE cover) into
 * Ogg on re-encode, so without this every trim silently stripped the file's
 * tags and cover art. Non-fatal: if the restore fails the trim itself still
 * succeeded, so warn instead of throwing.
 */
function restoreOggCommentPacket(filePath, commentPacket) {
  const ext = path.extname(filePath);
  const dir = path.dirname(filePath);
  const baseName = path.basename(filePath, ext);
  const tempPath = path.join(dir, `${baseName}_trimmeta_${randomUUID()}${ext}`);
  try {
    const restored = replaceOggCommentPacket(fs.readFileSync(filePath), commentPacket);
    fs.writeFileSync(tempPath, restored);
    if (process.platform === 'win32') {
      const backupPath = `${filePath}.backup-${randomUUID()}`;
      fs.renameSync(filePath, backupPath);
      try {
        fs.renameSync(tempPath, filePath);
      } catch (replaceErr) {
        if (!fs.existsSync(filePath) && fs.existsSync(backupPath)) {
          fs.renameSync(backupPath, filePath);
        }
        throw replaceErr;
      }
      try {
        fs.unlinkSync(backupPath);
      } catch (cleanupErr) {
        console.warn('Failed to remove trim backup:', cleanupErr.message);
      }
    } else {
      fs.renameSync(tempPath, filePath);
    }
    return true;
  } catch (err) {
    try {
      if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
    } catch (_) {}
    console.warn('[trim] audio trimmed but tags/cover could not be restored:', err.message);
    return false;
  }
}

/**
 * Trim an audio file in place (atomic replace) via ffmpeg re-encode to Opus.
 * V1 scope: Opus/Ogg only (Stowed downloads are Opus). Other containers would
 * need per-codec settings and would otherwise produce mislabeled files.
 * Callers must pass a path already confined via resolveDownloadPath().
 * @returns {Promise<{path:string, start:number, end:number, duration:number}>}
 */
async function trimAudio(filePath, startSec, endSec) {
  if (!filePath || typeof filePath !== 'string') {
    throw new Error('Invalid file path');
  }
  if (!fs.existsSync(filePath)) {
    throw new Error('File not found');
  }
  if (!isAudioFile(filePath)) {
    throw new Error('Invalid file type: not an audio file');
  }
  const extLower = path.extname(filePath).toLowerCase();
  if (extLower !== '.opus' && extLower !== '.ogg') {
    throw new Error('Invalid file type: trim currently supports Opus/Ogg only');
  }

  const start = Number(startSec);
  const end = Number(endSec);
  if (!Number.isFinite(start) || !Number.isFinite(end)) {
    throw new Error('Invalid trim range: start and end must be numbers');
  }
  if (start < 0) {
    throw new Error('Invalid trim range: start must be >= 0');
  }
  if (!(end > start)) {
    throw new Error('Invalid trim range: end must be greater than start');
  }
  if ((end - start) < 1.0) {
    throw new Error('Invalid trim range: duration must be at least 1 second');
  }

  const duration = await getDuration(filePath);
  if (!(start < duration)) {
    throw new Error('Invalid trim range: start is beyond file duration');
  }
  const clampedEnd = Math.min(end, duration);
  if (!((clampedEnd - start) >= 1.0)) {
    throw new Error('Invalid trim range: duration must be at least 1 second');
  }

  // Capture the original comment packet (tags + embedded cover) before ffmpeg
  // touches the file: the re-encode cannot carry Vorbis comments into Ogg, so
  // it is re-attached afterwards. Best-effort — a file without a comment
  // packet still trims normally.
  let originalCommentPacket = null;
  try {
    const { packets } = demuxPackets(parsePages(fs.readFileSync(filePath)));
    if (packets.length >= 2 && commentPacketInfo(packets[1].data)) {
      originalCommentPacket = packets[1].data;
    }
  } catch (_) {
    originalCommentPacket = null;
  }

  const ext = path.extname(filePath);
  const dir = path.dirname(filePath);
  const baseName = path.basename(filePath, ext);
  const tempPath = path.join(dir, `${baseName}_trim_${randomUUID()}${ext}`);

  let ffmpegPath;
  try {
    ffmpegPath = getFfmpegPath();
  } catch (err) {
    throw err;
  }

  const trimLen = clampedEnd - start;
  const args = [
    '-y',
    '-nostdin',
    '-hide_banner', '-loglevel', 'error',
    '-ss', String(start),
    '-i', filePath,
    '-t', String(trimLen),
    '-map_metadata', '0',
    '-vn',
    '-c:a', 'libopus',
    '-b:a', '160k',
    tempPath,
  ];

  if (activeTrims >= MAX_CONCURRENT_TRIMS) {
    throw new Error('Trim busy: another trim is already running, try again shortly');
  }
  activeTrims += 1;
  try {
    await new Promise((resolve, reject) => {
    let settled = false;
    // Declared before use: a synchronous spawn() throw calls settle() before
    // the timeout below is assigned, so guard must not be a const in TDZ.
    let guard;
    const settle = (fn, ...args) => {
      if (settled) return;
      settled = true;
      clearTimeout(guard);
      fn(...args);
    };
    let childProc;
    try {
      childProc = spawn(ffmpegPath, args);
    } catch (_) {
      return settle(reject, new Error('Failed to start FFmpeg'));
    }

    let stderr = '';
    let timedOut = false;
    guard = setTimeout(() => {
      timedOut = true;
      safeKill(childProc);
      if (fs.existsSync(tempPath)) {
        try { fs.unlinkSync(tempPath); } catch (_) {}
      }
      settle(reject, new Error('Timed out trimming audio'));
    }, 300_000);

    childProc.stderr.on('data', (data) => {
      if (stderr.length < 8 * 1024) {
        stderr += data.toString();
        if (stderr.length > 8 * 1024) stderr = stderr.slice(0, 8 * 1024);
      }
    });

    childProc.on('close', (code) => {
      if (timedOut) return;
      clearTimeout(guard);
      if (code === 0) {
        const backupPath = process.platform === 'win32'
          ? `${filePath}.backup-${randomUUID()}`
          : null;
        try {
          if (backupPath) {
            fs.renameSync(filePath, backupPath);
            try {
              fs.renameSync(tempPath, filePath);
            } catch (replaceErr) {
              try {
                if (!fs.existsSync(filePath) && fs.existsSync(backupPath)) {
                  fs.renameSync(backupPath, filePath);
                } else if (fs.existsSync(backupPath) && fs.existsSync(filePath)) {
                  // Replace failed but original slot is occupied — drop the
                  // orphaned backup so it doesn't accumulate.
                  try { fs.unlinkSync(backupPath); } catch (_) {}
                }
              } catch (_) { /* restore best-effort */ }
              throw replaceErr;
            }
            try {
              fs.unlinkSync(backupPath);
            } catch (cleanupErr) {
              console.warn('Failed to remove trim backup:', cleanupErr.message);
            }
          } else {
            fs.renameSync(tempPath, filePath);
          }
          resolve();
        } catch (_) {
          if (fs.existsSync(tempPath)) {
            try { fs.unlinkSync(tempPath); } catch (_) {}
          }
          settle(reject, new Error('Failed to replace original file'));
        }
      } else {
        if (fs.existsSync(tempPath)) {
          try { fs.unlinkSync(tempPath); } catch (_) {}
        }
        if (code == null) {
          settle(reject, new Error('Timed out trimming audio'));
        } else if (/Unknown encoder|libopus/i.test(stderr)) {
          console.error('[trim] ffmpeg libopus missing:', stderr.slice(0, 500));
          settle(reject, new Error(`FFmpeg failed (code ${code}): ffmpeg libopus encoder missing`));
        } else {
          console.error('[trim] ffmpeg failed:', stderr.slice(0, 500));
          settle(reject, new Error(`FFmpeg failed (code ${code})`));
        }
      }
    });

    childProc.on('error', () => {
      if (timedOut) return;
      clearTimeout(guard);
      if (fs.existsSync(tempPath)) {
        try { fs.unlinkSync(tempPath); } catch (_) {}
      }
      settle(reject, new Error('Failed to start FFmpeg'));
    });
  });
  } finally {
    activeTrims -= 1;
  }

  let metaRestored = true;
  if (originalCommentPacket) {
    metaRestored = restoreOggCommentPacket(filePath, originalCommentPacket);
  }

  return { path: filePath, start, end: clampedEnd, duration, metaRestored };
}

function _resetTrimState() {
  activeTrims = 0;
  activeProbes = 0;
}

module.exports = { getDuration, trimAudio, _resetTrimState };
