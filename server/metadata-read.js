const { spawn } = require('child_process');
const { getFfmpegPath, getFfprobePath } = require('./binaries');
const musicMetadata = require('music-metadata');

/**
 * Best-effort kill for a child process (avoids surfacing a stray throw).
 */
function safeKill(proc) {
  try { proc.kill(); } catch (_) { /* already gone */ }
}

/** Minimum expected size for a valid cover-art image (in bytes). */
const MIN_VALID_IMAGE_SIZE = 100;

/**
 * Validate that a JPEG data buffer appears complete by checking for the
 * End-of-Image marker (FF D9) and at least one Start-of-Scan marker (FF DA).
 */
function isValidJpeg(data) {
  if (!data || data.length < MIN_VALID_IMAGE_SIZE) return false;
  if (data[0] !== 0xFF || data[1] !== 0xD8) return false; // SOI
  if (data[data.length - 2] !== 0xFF || data[data.length - 1] !== 0xD9) return false; // EOI
  let hasSos = false;
  for (let i = 0; i < data.length - 1; i++) {
    if (data[i] === 0xFF && data[i + 1] === 0xDA) { hasSos = true; break; }
  }
  return hasSos;
}

/**
 * Validate that a PNG data buffer appears complete by checking for the
 * IEND chunk at the end. Also validates the PNG signature header.
 */
function isValidPng(data) {
  if (!data || data.length < MIN_VALID_IMAGE_SIZE) return false;
  const pngSig = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
  for (let i = 0; i < pngSig.length; i++) {
    if (data[i] !== pngSig[i]) return false;
  }
  const iendSig = Buffer.from([0x49, 0x45, 0x4E, 0x44]);
  const iendStart = data.length - 8; // 4 bytes CRC + 4 bytes "IEND"
  if (iendStart < 0) return false;
  for (let i = 0; i < 4; i++) {
    if (data[iendStart - 4 + i] !== 0x00) return false; // 0-length chunk before IEND
  }
  for (let i = 0; i < iendSig.length; i++) {
    if (data[iendStart + i] !== iendSig[i]) return false;
  }
  return true;
}

/**
 * Validate cover art image data for integrity.
 * Returns { valid: boolean, format: string|null, reason: string|null }
 */
function validateCoverArt(data, currentFormat) {
  if (!data || data.length === 0) {
    return { valid: false, format: null, reason: 'No data' };
  }

  if (data.length < MIN_VALID_IMAGE_SIZE) {
    return { valid: false, format: currentFormat, reason: `Data too small: ${data.length} bytes` };
  }

  let detectedFormat = null;
  let valid = false;
  let reason = null;

  if (data[0] === 0xFF && data[1] === 0xD8) {
    detectedFormat = 'image/jpeg';
    valid = isValidJpeg(data);
    if (!valid) reason = 'JPEG missing EOI marker (truncated)';
  } else if (data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4E && data[3] === 0x47) {
    detectedFormat = 'image/png';
    valid = isValidPng(data);
    if (!valid) reason = 'PNG missing IEND chunk (truncated)';
  } else if (
    data[0] === 0x52 && data[1] === 0x49 && data[2] === 0x46 && data[3] === 0x46 &&
    data[8] === 0x57 && data[9] === 0x45 && data[10] === 0x42 && data[11] === 0x50
  ) {
    detectedFormat = 'image/webp';
    valid = data.length > 50;
    if (!valid) reason = 'WebP data too small';
  } else if (data[0] === 0x42 && data[1] === 0x4D) {
    detectedFormat = 'image/bmp';
    const fileSize = data.readUInt32LE(2);
    valid = fileSize <= data.length && data.length > 50;
    if (!valid) reason = 'BMP header size mismatch or too small';
  } else if (data[0] === 0x47 && data[1] === 0x49 && data[2] === 0x46) {
    detectedFormat = 'image/gif';
    valid = data[data.length - 1] === 0x3B;
    if (!valid) reason = 'GIF missing trailer (truncated)';
  } else {
    detectedFormat = currentFormat || 'unknown';
    valid = true; // Unknown format: accept but warn
    reason = 'Unknown image format, no validation available';
  }

  return { valid, format: detectedFormat, reason };
}

/**
 * Fallback: read metadata tags using ffprobe (JSON output).
 * Returns tags in the same shape as music-metadata's common tags.
 */
function readTagsViaFfprobe(filePath) {
  return new Promise((resolve) => {
    const ffprobePath = getFfprobePath();
    const args = [
      '-v', 'quiet',
      '-print_format', 'json',
      '-show_entries', 'format_tags:format',
      filePath,
    ];

    let stdout = '';
    let stderrBuf = '';
    const proc = spawn(ffprobePath, args);

    // Guard against a hung/corrupt file tying up the request forever or an
    // unbounded stdout buffer spiking memory. Tag JSON is tiny; cap generously.
    const MAX_STDOUT = 1024 * 1024;
    const guard = setTimeout(() => safeKill(proc), 30_000);

    proc.stdout.on('data', (data) => {
      if (stdout.length >= MAX_STDOUT) { safeKill(proc); return; }
      stdout += data.toString();
    });
    proc.stderr.on('data', (data) => {
      if (stderrBuf.length < 4096) stderrBuf += data.toString();
    });

    proc.on('close', (code) => {
      clearTimeout(guard);
      if (code !== 0 || stdout.length > MAX_STDOUT) {
        if (stderrBuf) console.error('[ffprobe] stderr:', stderrBuf.slice(0, 200));
        return resolve({});
      }
      try {
        const parsed = JSON.parse(stdout);
        const fmt = parsed.format || {};
        const tags = fmt.tags || {};

        const result = {
          title: tags.title || '',
          artist: tags.artist || '',
          album: tags.album || '',
          track: tags.track || '',
          genre: tags.genre || '',
          year: tags.date || tags.year || '',
        };

        // Some containers put track as "track_number"
        if (!result.track && tags.track_number) {
          result.track = tags.track_number;
        }

        resolve(result);
      } catch (err) {
        console.error('[ffprobe] JSON parse failed:', err.message);
        resolve({});
      }
    });

    proc.on('error', (err) => {
      clearTimeout(guard);
      console.error('[ffprobe] spawn failed:', err.message);
      resolve({});
    });
  });
}

/**
 * Fallback: extract embedded cover art using ffmpeg.
 * Writes the first attached picture stream to stdout as raw JPEG bytes.
 * Returns { data: Buffer, format: 'image/jpeg' } or null.
 */
function readCoverArtViaFfmpeg(filePath) {
  return new Promise((resolve) => {
    const ffmpegPath = getFfmpegPath();
    const args = [
      '-v', 'error',
      '-i', filePath,
      '-map', '0:v',
      '-c:v', 'mjpeg',
      '-q:v', '2',
      '-f', 'image2pipe',
      '-frames:v', '1',
      'pipe:1',
    ];

    const chunks = [];
    let bytesRead = 0;
    const MAX_BYTES = 25 * 1024 * 1024; // cap extracted cover to avoid OOM
    let stderrBuf = '';
    const proc = spawn(ffmpegPath, args);

    // Guard against a hung/corrupt file (no output, never closes) and memory spikes.
    const guard = setTimeout(() => safeKill(proc), 30_000);

    proc.stdout.on('data', (chunk) => {
      bytesRead += chunk.length;
      if (bytesRead > MAX_BYTES) { safeKill(proc); return; }
      chunks.push(chunk);
    });
    proc.stderr.on('data', (data) => {
      if (stderrBuf.length < 8192) stderrBuf += data.toString();
    });

    proc.on('close', (code) => {
      clearTimeout(guard);
      const rawData = Buffer.concat(chunks);

      if (code !== 0 || rawData.length === 0 || bytesRead > MAX_BYTES) {
        return resolve(null);
      }

      if (stderrBuf) {
        console.warn('[ffmpeg cover] stderr had warnings:', stderrBuf.slice(0, 500));
      }

      // Validate the extracted data before returning
      const validation = validateCoverArt(rawData, 'image/jpeg');
      if (!validation.valid) {
        console.warn('[ffmpeg cover] extracted image failed validation:', validation.reason);
        return resolve(null);
      }

      resolve({
        data: rawData,
        format: validation.format,
        type: { id: 3, name: 'Cover (front)' },
      });
    });

    proc.on('error', (err) => {
      clearTimeout(guard);
      console.error('[ffmpeg cover] spawn failed:', err.message);
      resolve(null);
    });
  });
}

/**
 * Read metadata using music-metadata (primary parser).
 * Returns { tags, coverArt } or throws on error.
 * Cover art is validated; if validation fails, coverArt is null.
 */
async function readMetadataPrimary(filePath) {
  const metadata = await musicMetadata.parseFile(filePath);

  const tags = {
    title: metadata.common.title || '',
    artist: metadata.common.artist || '',
    album: metadata.common.album || '',
    track: metadata.common.track?.no ? String(metadata.common.track.no) : '',
    genre: metadata.common.genre?.[0] || '',
    year: metadata.common.year ? String(metadata.common.year) : '',
  };

  let coverArt = null;
  let coverValidationFailed = false;
  if (metadata.common.picture && metadata.common.picture.length > 0) {
    const picture = metadata.common.picture[0];
    const rawData = picture.data; // Buffer from music-metadata

    // Normalize format to a valid MIME type
    let format = picture.format;
    if (!format || !format.includes('/')) {
      const formatMap = {
        jpg: 'image/jpeg', jpeg: 'image/jpeg', 'image/jpg': 'image/jpeg',
        png: 'image/png', webp: 'image/webp', bmp: 'image/bmp', gif: 'image/gif',
      };
      format = formatMap[format] || 'image/jpeg';
    }

    const validation = validateCoverArt(rawData, format);
    if (validation.valid) {
      coverArt = {
        data: Buffer.from(rawData),
        format: validation.format || format,
        type: picture.type,
      };
    } else {
      console.warn('[metadata] cover art failed validation, discarding:', validation.reason);
      coverValidationFailed = true;
    }
  }

  return { tags, coverArt, _hasValidatedCover: coverValidationFailed };
}

/**
 * Read metadata using FFmpeg fallback when music-metadata fails entirely.
 */
async function readMetadataFallback(filePath) {
  const [tags, coverArt] = await Promise.all([
    readTagsViaFfprobe(filePath),
    readCoverArtViaFfmpeg(filePath),
  ]);

  const mergedTags = {
    title: tags.title || '',
    artist: tags.artist || '',
    album: tags.album || '',
    track: tags.track || '',
    genre: tags.genre || '',
    year: tags.year || '',
  };

  return { tags: mergedTags, coverArt, _hasValidatedCover: true };
}

/** Targeted cover-art-only FFmpeg fallback (used when tags parse but cover fails). */
async function readCoverArtFallback(filePath) {
  return readCoverArtViaFfmpeg(filePath);
}

/**
 * High-level reader used by the API. Returns tags plus cover-art *descriptor*
 * (no image bytes), so the UI can show the cover via /api/cover separately.
 *
 * @returns {Promise<{tags: object, coverArt: {format, type}|null}>}
 */
async function readMetadata(filePath) {
  let result;
  try {
    result = await readMetadataPrimary(filePath);

    // If tags parsed but cover failed validation, try FFmpeg for the cover.
    if (result.coverArt === null && result._hasValidatedCover) {
      const coverArt = await readCoverArtFallback(filePath);
      if (coverArt) result.coverArt = coverArt;
    }
  } catch (primaryErr) {
    // music-metadata can fail on corrupt/non-standard text encodings; FFmpeg
    // is more tolerant.
    console.warn('[metadata] music-metadata failed:', primaryErr.message, '-> falling back to FFmpeg');
    result = await readMetadataFallback(filePath);
  }

  const { tags, coverArt } = result;
  return {
    tags,
    coverArt: coverArt
      ? { format: coverArt.format, type: coverArt.type }
      : null,
  };
}

/**
 * Read just the embedded cover art so it can be streamed as an image.
 * @returns {Promise<{data: Buffer, format: string}|null>}
 */
async function getCoverArt(filePath) {
  let cover = null;
  try {
    const primary = await readMetadataPrimary(filePath);
    if (primary.coverArt) {
      cover = { data: primary.coverArt.data, format: primary.coverArt.format };
    } else if (primary._hasValidatedCover) {
      cover = await readCoverArtFallback(filePath);
    }
  } catch (_) {
    cover = await readCoverArtViaFfmpeg(filePath);
  }
  return cover ? { data: cover.data, format: cover.format } : null;
}

module.exports = {
  validateCoverArt,
  readMetadata,
  getCoverArt,
};