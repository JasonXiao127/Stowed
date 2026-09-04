const { ipcMain, dialog } = require('electron');
const fs = require('fs');
const { spawn } = require('child_process');
const { writeMetadata } = require('../metadata');
const { getFfmpegPath, getFfprobePath } = require('../binaries');

/**
 * Minimum expected size for a valid JPEG thumbnail (in bytes).
 * Anything smaller is definitely corrupt or not a real image.
 */
const MIN_VALID_IMAGE_SIZE = 100;

/**
 * Validate that a JPEG data buffer appears complete by checking for the
 * End-of-Image marker (FF D9) and at least one Start-of-Scan marker (FF DA).
 * Also validates the Start-of-Image marker (FF D8).
 * Returns true if valid, false if truncated or corrupt.
 *
 * The SOS check catches files that have intact SOI/EOI wrappers but
 * contain no actual scan data (or corrupt entropy-coded data between
 * marker wrappers). libjpeg-turbo (used by Chromium) will decode a
 * partial image from such files without firing onError, resulting in
 * a "top slice only" render of roughly 10-15% of the image.
 */
function isValidJpeg(data) {
  if (!data || data.length < MIN_VALID_IMAGE_SIZE) return false;
  // Check SOI marker: FF D8
  if (data[0] !== 0xFF || data[1] !== 0xD8) return false;
  // Check EOI marker: FF D9 at the end
  if (data[data.length - 2] !== 0xFF || data[data.length - 1] !== 0xD9) return false;
  // Check for at least one SOS (FF DA) marker — validates scan data exists
  let hasSos = false;
  for (let i = 0; i < data.length - 1; i++) {
    if (data[i] === 0xFF && data[i + 1] === 0xDA) { hasSos = true; break; }
  }
  if (!hasSos) return false;
  return true;
}

/**
 * Validate that a PNG data buffer appears complete by checking for the
 * IEND chunk at the end. Also validates the PNG signature header.
 * Returns true if valid, false if truncated or corrupt.
 */
function isValidPng(data) {
  if (!data || data.length < MIN_VALID_IMAGE_SIZE) return false;
  // Check PNG signature: 89 50 4E 47 0D 0A 1A 0A
  const pngSig = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
  for (let i = 0; i < pngSig.length; i++) {
    if (data[i] !== pngSig[i]) return false;
  }
  // Check IEND chunk at the end: 00 00 00 00 49 45 4E 44 AE 42 60 82
  // (4 bytes length = 0, "IEND", 4 bytes CRC)
  const iendSig = Buffer.from([0x49, 0x45, 0x4E, 0x44]);
  const iendStart = data.length - 8; // 4 bytes CRC + 4 bytes "IEND"
  if (iendStart < 0) return false;
  // Check for 0-length chunk preceding IEND (4 bytes)
  for (let i = 0; i < 4; i++) {
    if (data[iendStart - 4 + i] !== 0x00) return false;
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

  // Detect actual format from magic bytes, regardless of what the tag says
  let detectedFormat = null;
  let valid = false;
  let reason = null;

  // Check magic bytes
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
    // WebP validation: complete if we have the file size from the RIFF header
    valid = data.length > 50;
    if (!valid) reason = 'WebP data too small';
  } else if (data[0] === 0x42 && data[1] === 0x4D) {
    detectedFormat = 'image/bmp';
    const fileSize = data.readUInt32LE(2);
    valid = fileSize <= data.length && data.length > 50;
    if (!valid) reason = 'BMP header size mismatch or too small';
  } else if (data[0] === 0x47 && data[1] === 0x49 && data[2] === 0x46) {
    detectedFormat = 'image/gif';
    // GIF: check for trailer 0x3B
    valid = data[data.length - 1] === 0x3B;
    if (!valid) reason = 'GIF missing trailer (truncated)';
  } else {
    detectedFormat = currentFormat || 'unknown';
    // Unknown format: accept but warn
    valid = true;
    reason = 'Unknown image format, no validation available';
  }

  return { valid, format: detectedFormat, reason };
}

/**
 * Log image data diagnostic information at key stages.
 */
function logImageDiagnostics(source, data, format) {
  if (!data) {
    console.log(`[${source}] No image data`);
    return;
  }
  const isView = data instanceof Uint8Array || ArrayBuffer.isView(data);
  console.log(`[${source}] Image data:`, {
    size: data.length,
    format,
    type: data.constructor?.name || typeof data,
    isBuffer: Buffer.isBuffer(data),
    isView,
    firstBytes: data.length > 0 ? Array.from(data.slice(0, 4)).map(b => b.toString(16).padStart(2, '0')).join(' ') : 'empty',
    lastBytes: data.length > 0 ? Array.from(data.slice(-4)).map(b => b.toString(16).padStart(2, '0')).join(' ') : 'empty',
  });
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
    const proc = spawn(ffprobePath, args, { windowsHide: true });

    proc.stdout.on('data', (data) => { stdout += data.toString(); });
    proc.stderr.on('data', (data) => { stderrBuf += data.toString(); });

    proc.on('close', (code) => {
      if (code !== 0) {
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

        console.log('[ffprobe] extracted tags:', result);
        resolve(result);
      } catch (err) {
        console.error('[ffprobe] JSON parse failed:', err.message);
        resolve({});
      }
    });

    proc.on('error', (err) => {
      console.error('[ffprobe] spawn failed:', err.message);
      resolve({});
    });
  });
}

/**
 * Fallback: extract embedded cover art using ffmpeg.
 * Writes the first attached picture stream to stdout as raw JPEG bytes.
 * Returns { data: Uint8Array, format: 'image/jpeg' } or null.
 *
 * Security: stderr is no longer discarded; errors and warnings are captured
 * so we can detect when ffmpeg encounters problems mid-stream.
 */
function readCoverArtViaFfmpeg(filePath) {
  return new Promise((resolve) => {
    const ffmpegPath = getFfmpegPath();
    // ffmpeg -v error -i <file> -map 0:v -c:v mjpeg -q:v 2 -f image2pipe -frames:v 1 pipe:1
    // Using -v error instead of -v quiet so we get actual error messages
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
    let stderrBuf = '';
    const proc = spawn(ffmpegPath, args, { windowsHide: true });

    proc.stdout.on('data', (chunk) => chunks.push(chunk));
    proc.stderr.on('data', (data) => { stderrBuf += data.toString(); });

    proc.on('close', (code) => {
      const rawData = Buffer.concat(chunks);

      // Log diagnostics even on failure
      logImageDiagnostics('ffmpeg-cover-extract', rawData, 'image/jpeg');

      if (code !== 0 || rawData.length === 0) {
        console.log('[ffmpeg cover] no embedded cover art found (exit code:', code, ')');
        if (stderrBuf) {
          console.warn('[ffmpeg cover] stderr:', stderrBuf.slice(0, 500));
        }
        return resolve(null);
      }

      // If stderr has any content, it may indicate truncation/skip issues
      if (stderrBuf) {
        console.warn('[ffmpeg cover] stderr had warnings:', stderrBuf.slice(0, 500));
      }

      // Validate the extracted data before returning
      const validation = validateCoverArt(rawData, 'image/jpeg');
      if (!validation.valid) {
        console.warn('[ffmpeg cover] extracted image failed validation:', validation.reason);
        return resolve(null);
      }

      console.log('[ffmpeg cover] extracted cover art, size:', rawData.length, 'bytes');
      resolve({
        data: Uint8Array.from(rawData),
        format: validation.format, // use validated/detected format
        type: { id: 3, name: 'Cover (front)' },
      });
    });

    proc.on('error', (err) => {
      console.error('[ffmpeg cover] spawn failed:', err.message);
      resolve(null);
    });
  });
}

/**
 * Read metadata using music-metadata (primary parser).
 * Returns { tags, coverArt } or throws on error.
 *
 * Cover art data is validated for integrity before returning.
 * If validation fails, coverArt is set to null (so the caller can
 * decide whether to fall back to FFmpeg for just the cover).
 */
async function readMetadataPrimary(filePath) {
  const musicMetadata = require('music-metadata');
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
  let coverValidationFailed = false; // track whether we had pictures but they failed
  if (metadata.common.picture && metadata.common.picture.length > 0) {
    const picture = metadata.common.picture[0];
    const rawData = picture.data; // Buffer from music-metadata

    // Log raw data from music-metadata parser
    logImageDiagnostics('music-metadata-raw', rawData, picture.format);

    // Normalize format to a valid MIME type
    let format = picture.format;
    if (!format || !format.includes('/')) {
      const formatMap = {
        jpg: 'image/jpeg', jpeg: 'image/jpeg', 'image/jpg': 'image/jpeg',
        png: 'image/png', webp: 'image/webp', bmp: 'image/bmp', gif: 'image/gif',
      };
      format = formatMap[format] || 'image/jpeg';
    }

    // Validate image integrity
    const validation = validateCoverArt(rawData, format);
    console.log('[music-metadata] cover art validation:', validation);

    if (validation.valid) {
      coverArt = {
        data: Uint8Array.from(rawData),
        format: validation.format || format, // prefer detected format
        type: picture.type,
      };
    } else {
      console.warn('[music-metadata] cover art failed validation, discarding:', validation.reason);
      coverValidationFailed = true; // signal caller that ffmpeg fallback is worth trying
      // coverArt stays null — caller can try ffmpeg fallback
    }
  }

  return { tags, coverArt, _hasValidatedCover: coverValidationFailed };
}

/**
 * Read metadata using FFmpeg fallback when music-metadata fails entirely.
 * Returns { tags, coverArt }.
 */
async function readMetadataFallback(filePath) {
  console.log('[metadataHandlers] using FFmpeg fallback for:', filePath);
  const [tags, coverArt] = await Promise.all([
    readTagsViaFfprobe(filePath),
    readCoverArtViaFfmpeg(filePath),
  ]);

  // Merge: ffprobe tags are the base; fill missing with empty strings
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

/**
 * Attempt to extract cover art via FFmpeg as a targeted fallback.
 * Used when music-metadata succeeds for tags but fails to provide
 * valid cover art data.
 */
async function readCoverArtFallback(filePath) {
  console.log('[metadataHandlers] running cover-art-only FFmpeg fallback for:', filePath);
  return readCoverArtViaFfmpeg(filePath);
}

function setupMetadataHandlers() {
  // Open file dialog for audio files
  ipcMain.handle('open-file-dialog', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters: [
        { name: 'Audio Files', extensions: ['mp3', 'm4a', 'opus', 'ogg', 'flac', 'wav', 'webm'] },
        { name: 'All Files', extensions: ['*'] },
      ],
    });

    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }

    return result.filePaths[0];
  });

  // Open image dialog for thumbnail replacement
  ipcMain.handle('open-image-dialog', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters: [
        { name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'webp', 'bmp'] },
      ],
    });

    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }

    return result.filePaths[0];
  });

  // Read metadata from a file
  ipcMain.handle('read-metadata', async (event, filePath) => {
    try {
      if (!fs.existsSync(filePath)) {
        throw new Error(`File not found: ${filePath}`);
      }

      // Primary: use music-metadata (handles most files correctly)
      let result;
      try {
        result = await readMetadataPrimary(filePath);
        console.log('[metadataHandlers] music-metadata succeeded:', filePath);

        // If music-metadata returned tags but cover art failed validation,
        // try FFmpeg as a targeted fallback for just the cover art.
        if (result.coverArt === null && result._hasValidatedCover) {
          console.log('[metadataHandlers] tags OK but cover validation failed, trying FFmpeg cover fallback');
          const coverArt = await readCoverArtFallback(filePath);
          if (coverArt) {
            console.log('[metadataHandlers] FFmpeg cover fallback succeeded');
            result.coverArt = coverArt;
          } else {
            console.log('[metadataHandlers] FFmpeg cover fallback also returned no cover');
          }
        }
      } catch (primaryErr) {
        // music-metadata can fail on files with corrupt/non-standard text encodings
        // in ID3v2/MP4 tags (TextDecoder throws "The string to be decoded is not
        // correctly encoded"). Fall back to FFmpeg which is more tolerant.
        console.warn('[metadataHandlers] music-metadata failed:', primaryErr.message);
        console.warn('[metadataHandlers] falling back to FFmpeg');
        result = await readMetadataFallback(filePath);
      }

      // Log final result diagnostics
      console.log('[metadataHandlers] final result:', {
        hasTags: !!result.tags,
        hasCoverArt: !!result.coverArt,
        coverSize: result.coverArt?.data?.length || 0,
        coverFormat: result.coverArt?.format || 'none',
      });

      return result;
    } catch (err) {
      throw new Error(`Failed to read metadata: ${err.message}`);
    }
  });

  // Write metadata to a file
  ipcMain.handle('write-metadata', async (event, filePath, tags, newThumbnailPath) => {
    try {
      const result = await writeMetadata(filePath, tags, newThumbnailPath || null);
      return { success: true, filePath: result };
    } catch (err) {
      throw new Error(`Failed to write metadata: ${err.message}`);
    }
  });
}

module.exports = { setupMetadataHandlers };
