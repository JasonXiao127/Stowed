/**
 * Shared tag sanitizing for Stow apps.
 *
 * Canonical source: the web variant (apps/stowed-web/server/metadata.js),
 * which preserves meaningful interior whitespace instead of trimming it.
 * A value consisting only of whitespace normalizes to empty.
 */

/**
 * Sanitize a string for use in FFmpeg command arguments.
 * Removes null bytes and control characters that could be used for
 * command injection.
 */
function sanitizeTagValue(value) {
  if (typeof value !== 'string') return '';
  // Remove null bytes and control characters, but preserve meaningful leading/
  // trailing whitespace (some tag values legitimately contain it). A value that
  // consists only of whitespace is normalized to empty.
  const cleaned = value.replace(/[\x00-\x1f\x7f]/g, '');
  return cleaned.trim() === '' ? '' : cleaned;
}

module.exports = { sanitizeTagValue };
