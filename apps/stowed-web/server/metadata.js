const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { randomUUID } = require('crypto');
const { getFfmpegPath } = require('./binaries');
const { sanitizeTagValue, rewriteOggComments, detectImageMime, validateCoverArt } = require('@stowed/core');

function isOggContainer(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return ext === '.opus' || ext === '.ogg' || ext === '.oga';
}

// Containers the FFmpeg write path can actually attach a picture to (MJPEG
// video stream). WAV / raw AAC cannot carry video; WebM rejects MJPEG.
// Ogg-family files never reach ffmpeg (native Vorbis-comment path instead).
function canEmbedCover(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return ['.mp3', '.m4a', '.mp4', '.flac', '.opus', '.ogg', '.oga'].includes(ext);
}

// Image MIME types accepted for cover writes. validateCoverArt() accepts
// unknown byte patterns with a warning (needed for tolerant reads), but a
// write must never embed unidentified bytes or an "unknown" MIME label.
const WRITABLE_IMAGE_MIMES = new Set([
  'image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/bmp',
]);

function atomicReplace(tempPath, filePath) {
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
      console.warn('Failed to remove metadata backup:', cleanupErr.message);
    }
  } else {
    fs.renameSync(tempPath, filePath);
  }
}

function safeUnlink(p) {
  try {
    if (p && fs.existsSync(p)) fs.unlinkSync(p);
  } catch (_) {
    // best effort cleanup
  }
}

/**
 * Write tags (and optionally a cover) to an Ogg Opus / Ogg Vorbis file with
 * a pure-JS Vorbis-comment editor. FFmpeg cannot mux an attached picture into
 * Ogg and its global -metadata does not update existing stream comments, so
 * Ogg files must not go through the FFmpeg path. Audio is untouched and any
 * existing METADATA_BLOCK_PICTURE cover is preserved unless a replacement
 * image is given.
 */
function writeOggMetadata(filePath, tags, newThumbnailPath) {
  let imageData = null;
  let imageMime = null;
  if (newThumbnailPath) {
    if (!fs.existsSync(newThumbnailPath)) {
      throw new Error(`Thumbnail file not found: ${newThumbnailPath}`);
    }
    imageData = fs.readFileSync(newThumbnailPath);
    const validation = validateCoverArt(imageData, null);
    if (!validation.valid) {
      throw new Error(`Invalid image: ${validation.reason || 'unsupported format'}`);
    }
    imageMime = validation.format || detectImageMime(imageData);
    if (!WRITABLE_IMAGE_MIMES.has(imageMime)) {
      throw new Error('Invalid image: unsupported image format');
    }
  }
  // Same sanitizing as the FFmpeg path: strip control characters (incl. NUL)
  // so they can never land in a Vorbis comment.
  const cleanTags = {};
  for (const key of ['title', 'artist', 'album', 'track', 'genre', 'year']) {
    cleanTags[key] = sanitizeTagValue(tags?.[key]);
  }
  const original = fs.readFileSync(filePath);
  const updated = rewriteOggComments(original, cleanTags, imageData
    ? { coverImage: imageData, coverMime: imageMime }
    : {});
  const dir = path.dirname(filePath);
  const ext = path.extname(filePath);
  const baseName = path.basename(filePath, ext);
  const tempPath = path.join(dir, `${baseName}_temp_${randomUUID()}${ext}`);
  try {
    fs.writeFileSync(tempPath, updated);
    atomicReplace(tempPath, filePath);
  } catch (err) {
    safeUnlink(tempPath);
    throw err;
  }
  return filePath;
}

/**
 * Write metadata tags to an audio file using FFmpeg.
 * Uses atomic write: writes to a temp file first, then replaces the original.
 *
 * @param {string} filePath - Path to the audio file
 * @param {object} tags - Metadata tags { title, artist, album, track, genre, year }
 * @param {string|null} newThumbnailPath - Path to a new thumbnail image, or null to keep existing
 * @returns {Promise<string>} - The path to the updated file
 */
function writeMetadata(filePath, tags, newThumbnailPath = null) {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(filePath)) {
      return reject(new Error(`File not found: ${filePath}`));
    }

    // Ogg Opus / Ogg Vorbis files are handled natively: FFmpeg can neither
    // embed an attached picture into Ogg nor reliably update existing
    // Vorbis comments via global -metadata, so it must not be used here.
    if (isOggContainer(filePath)) {
      try {
        const result = writeOggMetadata(filePath, tags, newThumbnailPath);
        resolve(result);
      } catch (err) {
        reject(err);
      }
      return;
    }

    if (newThumbnailPath && !canEmbedCover(filePath)) {
      return reject(new Error(
        `Cover art cannot be embedded in ${path.extname(filePath) || 'this file'} files`
      ));
    }

    const ffmpegPath = getFfmpegPath();
    const ext = path.extname(filePath);
    const dir = path.dirname(filePath);
    const baseName = path.basename(filePath, ext);
    const tempPath = path.join(dir, `${baseName}_temp_${randomUUID()}${ext}`);

    // FFmpeg argument ordering:
    //   ffmpeg [global] -i input0 [-i input1] [output_options] output
    // All -metadata options are output options and must come AFTER all -i inputs.
    const args = ['-y', '-i', filePath];

    // Add second input (thumbnail image) BEFORE output options
    if (newThumbnailPath) {
      if (!fs.existsSync(newThumbnailPath)) {
        return reject(new Error(`Thumbnail file not found: ${newThumbnailPath}`));
      }
      args.push('-i', newThumbnailPath);
    }

    // Output options: metadata tags (must be after all -i inputs)
    const metadataMap = {
      title: 'title',
      artist: 'artist',
      album: 'album',
      track: 'track',
      genre: 'genre',
      year: 'date',
    };

    for (const [key, ffmpegKey] of Object.entries(metadataMap)) {
      const value = sanitizeTagValue(tags?.[key]);
      // Emit empty values too so clearing a field in the editor removes the
      // existing tag instead of silently preserving it.
      args.push('-metadata', `${ffmpegKey}=${value}`);
    }

    // Output options: stream mapping and codec
    if (newThumbnailPath) {
      args.push('-map', '0:a');                     // keep audio streams from input 0
      args.push('-map', '1:v');                     // map video (cover art) from input 1
      args.push('-c:a', 'copy');                    // copy audio without re-encoding
      args.push('-c:v', 'mjpeg');                   // transcode cover to MJPEG (required by MP3 container)
      args.push('-q:v', '2');                       // high quality JPEG (1-31, lower is better)
      args.push('-disposition:v:0', 'attached_pic'); // mark the mapped video as attached picture
    } else {
      args.push('-map', '0');                       // keep all streams from input 0
      args.push('-c', 'copy');
    }

    args.push(tempPath);

    const childProc = spawn(ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });

    let stderr = '';
    const STDERR_CAP = 16 * 1024;
    // Guard against hung FFmpeg (network thumb input, stuck encoder): kill
    // after 120s. Output here is local-file only so this is a backstop.
    const FFMPEG_TIMEOUT_MS = 120_000;
    const killTimer = setTimeout(() => {
      try { childProc.kill('SIGKILL'); } catch (_) {}
    }, FFMPEG_TIMEOUT_MS);
    if (killTimer.unref) killTimer.unref();

    childProc.stderr.on('data', (data) => {
      if (stderr.length < STDERR_CAP) stderr += data.toString().slice(0, STDERR_CAP - stderr.length);
    });

    childProc.on('close', (code) => {
      clearTimeout(killTimer);
      if (code === 0) {
        // Replace the original while keeping a recovery path on Windows,
        // where renameSync cannot overwrite an existing destination.
        try {
          atomicReplace(tempPath, filePath);
          resolve(filePath);
        } catch (err) {
          // Clean up temp file on failure
          safeUnlink(tempPath);
          reject(new Error(`Failed to replace original file: ${err.message}`));
        }
      } else {
        // Clean up temp file on failure
        safeUnlink(tempPath);
        reject(new Error(`FFmpeg exited with code ${code}: ${stderr}`));
      }
    });

    childProc.on('error', (err) => {
      clearTimeout(killTimer);
      safeUnlink(tempPath);
      reject(new Error(`Failed to start FFmpeg: ${err.message}`));
    });
  });
}

module.exports = { writeMetadata, sanitizeTagValue, canEmbedCover, isOggContainer };