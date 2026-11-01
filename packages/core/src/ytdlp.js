/**
 * Shared yt-dlp invocation helpers for Stow (web + desktop).
 *
 * Centralizes the argument list, output markers, and stdout parsing so the
 * two DownloadManagers cannot drift. The markers use explicit STOW_ prefixes
 * because yt-dlp's own "download:" / "postprocess:" prefixes are consumed by
 * yt-dlp itself and never reach our stdout parser (the old
 * `line.startsWith('download:[')` check never fired on real output).
 *
 * Real yt-dlp progress arrives as CR-separated fragments like:
 *   [NA|1024|3433755|...]\r[NA|3072|3433755|...]\r
 * so callers must split on BOTH \r and \n before calling parseLine().
 */

const path = require('path');

const OUTPUT_TEMPLATE = '%(title)s [%(id)s].%(ext)s';
const FORMAT_SELECTOR = 'bestaudio[acodec=opus]/bestaudio';

// Unit separator — effectively never appears in titles/URLs.
const FIELD_SEP = '\x1f';

const META_PREFIX = 'STOW_META:';
const FILE_PREFIX = 'STOW_FILE:';
const PROGRESS_PREFIX = 'STOW_PROGRESS:';
const PP_PREFIX = 'STOW_PP:';

// before_dl marker: id, title, uploader, duration, webpage_url, upload_date, thumbnail
const META_TEMPLATE = [
  'before_dl:',
  META_PREFIX,
  `%(id)s${FIELD_SEP}%(title)s${FIELD_SEP}%(uploader)s${FIELD_SEP}`,
  `%(duration)s${FIELD_SEP}%(webpage_url)s${FIELD_SEP}%(upload_date)s${FIELD_SEP}%(thumbnail)s`,
].join('');

const FILE_TEMPLATE = 'after_move:STOW_FILE:%(filepath)s';

const DOWNLOAD_PROGRESS_TEMPLATE =
  `download:${PROGRESS_PREFIX}` +
  '%(progress.downloaded_bytes)s|%(progress.total_bytes)s|' +
  '%(progress.total_bytes_estimate)s|%(progress.speed)s|' +
  '%(progress.eta)s|%(progress.elapsed)s';

const PP_PROGRESS_TEMPLATE =
  `postprocess:${PP_PREFIX}` +
  '%(progress.status)s|%(progress.postprocessor)s';

/**
 * Build the yt-dlp argument list for a single audio download.
 *
 * @param {object} opts
 * @param {string} opts.url - video/page URL (appended after `--`).
 * @param {string} opts.downloadDir - final destination (via -P home:).
 * @param {string} [opts.tempDir] - per-job staging dir (via -P temp:).
 * @param {string} [opts.jsRuntime='deno'] - 'deno' or 'node'.
 * @param {string} [opts.cookiesPath] - path to a Netscape cookies.txt file.
 * @param {boolean} [opts.embedChapters=false] - pass --embed-chapters.
 * @param {string|null} [opts.sponsorblock=null] - e.g. 'remove:music_offtopic' or 'mark:all'.
 * @returns {string[]}
 */
function buildYtDlpArgs({
  url,
  downloadDir,
  tempDir,
  jsRuntime = 'deno',
  cookiesPath,
  embedChapters = false,
  sponsorblock = null,
  opusPreferred = true,
} = {}) {
  if (!url) throw new TypeError('url is required');
  if (!downloadDir) throw new TypeError('downloadDir is required');

  const formatSelector = opusPreferred === false ? 'bestaudio' : FORMAT_SELECTOR;
  const args = [
    '--js-runtimes', jsRuntime,
    '--impersonate', 'chrome',
    '--force-overwrites',
    '--newline',
    '--color', 'never',
    '--progress-delta', '1',
    '--retries', '10',
    '--fragment-retries', '10',
    '--socket-timeout', '15',
    '--trim-filenames', '200',
    '-f', formatSelector,
    '-x',
    '--audio-format', 'opus',
    '--audio-quality', '0',
    '--embed-thumbnail',
    '--embed-metadata',
    '-P', `home:${downloadDir}`,
    '-o', OUTPUT_TEMPLATE,
    '--no-playlist',
    '--progress',
    '--progress-template', DOWNLOAD_PROGRESS_TEMPLATE,
    '--progress-template', PP_PROGRESS_TEMPLATE,
    '--print', META_TEMPLATE,
    '--print', FILE_TEMPLATE,
  ];

  if (tempDir) {
    // Insert temp path right after the home path so both -P flags stay together.
    const homeIdx = args.indexOf(`home:${downloadDir}`);
    args.splice(homeIdx + 1, 0, '-P', `temp:${tempDir}`);
  }

  if (cookiesPath) {
    args.push('--cookies', cookiesPath);
  }
  if (embedChapters) {
    args.push('--embed-chapters');
  }
  if (sponsorblock) {
    // Expected forms: 'remove:CATEGORY[,..]' or 'mark:CATEGORY[,..]'.
    const [mode, cats] = String(sponsorblock).split(/:(.+)/);
    if (mode === 'remove' && cats) args.push('--sponsorblock-remove', cats);
    else if (mode === 'mark' && cats) args.push('--sponsorblock-mark', cats);
  }

  args.push('--', url);
  return args;
}

/** Split a raw stdout chunk on CR and LF (yt-dlp uses CR for progress). */
function splitOutputLines(chunk) {
  return String(chunk).split(/[\r\n]+/);
}

function toNumOrNull(v) {
  if (v == null || v === '' || v === 'NA' || v === 'None') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Parse one trimmed stdout line. Returns a tagged object or null.
 *
 * Types:
 *  { type: 'meta', id, title, uploader, duration, webpageUrl, uploadDate, thumbnail }
 *  { type: 'progress', downloadedBytes, totalBytes, speed, eta, elapsed, progress }
 *  { type: 'postprocess', status, postprocessor }
 *  { type: 'file', path }
 */
function parseLine(rawLine) {
  if (!rawLine) return null;
  const line = String(rawLine).trim();
  if (!line) return null;

  if (line.startsWith(META_PREFIX)) {
    const payload = line.slice(META_PREFIX.length);
    const parts = payload.split(FIELD_SEP);
    const [id, title, uploader, durationRaw, webpageUrl, uploadDate, thumbnail] = parts;
    return {
      type: 'meta',
      id: id || '',
      title: title || '',
      uploader: uploader && uploader !== 'NA' ? uploader : '',
      duration: toNumOrNull(durationRaw),
      webpageUrl: webpageUrl && webpageUrl !== 'NA' ? webpageUrl : '',
      uploadDate: uploadDate && uploadDate !== 'NA' ? uploadDate : '',
      thumbnail: thumbnail && thumbnail !== 'NA' ? thumbnail : '',
    };
  }

  if (line.startsWith(FILE_PREFIX)) {
    const p = line.slice(FILE_PREFIX.length).trim();
    if (!p) return null;
    // Guard against Windows "C:\" being treated as relative elsewhere.
    if (!path.isAbsolute(p) && !/^[a-zA-Z]:[\\/]/.test(p)) return null;
    return { type: 'file', path: p };
  }

  if (line.startsWith(PROGRESS_PREFIX)) {
    const payload = line.slice(PROGRESS_PREFIX.length);
    const [dlRaw, totalRaw, estRaw, speedRaw, etaRaw, elapsedRaw] = payload.split('|');
    const downloadedBytes = toNumOrNull(dlRaw);
    const totalBytes = toNumOrNull(totalRaw) ?? toNumOrNull(estRaw);
    const speed = toNumOrNull(speedRaw);
    const eta = toNumOrNull(etaRaw);
    const elapsed = toNumOrNull(elapsedRaw);
    let progress = null;
    if (downloadedBytes != null && totalBytes) {
      progress = Math.min(100, Math.max(0, (downloadedBytes / totalBytes) * 100));
    }
    return { type: 'progress', downloadedBytes, totalBytes, speed, eta, elapsed, progress };
  }

  if (line.startsWith(PP_PREFIX)) {
    const payload = line.slice(PP_PREFIX.length);
    const [status, postprocessor] = payload.split('|');
    if (!status) return null;
    return { type: 'postprocess', status, postprocessor: postprocessor && postprocessor !== 'NA' ? postprocessor : '' };
  }

  return null;
}

/** Map a postprocessor name to a user-facing queue stage. */
function stageForPostprocessor(name) {
  const n = String(name || '').toLowerCase();
  if (n.includes('extractaudio')) return 'Converting';
  if (n.includes('metadata')) return 'Tagging';
  if (n.includes('embedthumbnail')) return 'Embedding cover';
  if (n.includes('movefiles') || n.includes('move')) return 'Finishing';
  if (n.includes('sponsorblock')) return 'Removing segments';
  if (n.includes('splitchapters') || n.includes('chapters')) return 'Chapters';
  return 'Processing';
}

/**
 * Parse `yt-dlp --version` output (e.g. "2026.10.29.232701").
 * Returns the version string or '' when unparseable.
 */
function parseVersion(output) {
  const v = String(output || '').trim().split(/[\r\n]+/)[0].trim();
  if (/^\d{4}\.\d{2}\.\d{2}(\.\d+)?$/.test(v)) return v;
  return '';
}

/**
 * Compare nightly/stable version strings. Returns -1/0/1.
 * Non-parseable versions sort below parseable ones.
 */
function compareVersions(a, b) {
  const pa = String(a || '').split('.').map(Number);
  const pb = String(b || '').split('.').map(Number);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const x = pa[i] || 0;
    const y = pb[i] || 0;
    if (Number.isNaN(x) || Number.isNaN(y)) continue;
    if (x < y) return -1;
    if (x > y) return 1;
  }
  return 0;
}

module.exports = {
  OUTPUT_TEMPLATE,
  FORMAT_SELECTOR,
  FIELD_SEP,
  META_PREFIX,
  FILE_PREFIX,
  PROGRESS_PREFIX,
  PP_PREFIX,
  META_TEMPLATE,
  FILE_TEMPLATE,
  DOWNLOAD_PROGRESS_TEMPLATE,
  PP_PROGRESS_TEMPLATE,
  buildYtDlpArgs,
  splitOutputLines,
  parseLine,
  stageForPostprocessor,
  parseVersion,
  compareVersions,
};
