/**
 * Shared cover-art validation for Stow apps.
 *
 * Canonical source (extracted from apps/stowed-web/server/metadata-read.js).
 * Both the Electron client (src/main/ipc/metadataHandlers.js) and the web
 * server use these validators; only the transport of the image bytes differs
 * (IPC structured clone vs HTTP /api/cover).
 */

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

module.exports = { MIN_VALID_IMAGE_SIZE, isValidJpeg, isValidPng, validateCoverArt };
