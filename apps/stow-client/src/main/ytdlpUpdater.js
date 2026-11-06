const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { app } = require('electron');

const { parseVersion, compareVersions } = require('@stowed/core');

const NIGHTLY_LATEST_BASE = 'https://github.com/yt-dlp/yt-dlp-nightly-builds/releases/latest/download';
const NIGHTLY_API_LATEST = 'https://api.github.com/repos/yt-dlp/yt-dlp-nightly-builds/releases/latest';

function platformDir() {
  if (process.platform === 'win32') return 'win32';
  if (process.platform === 'darwin') return 'darwin';
  return 'linux';
}

function assetName() {
  if (process.platform === 'win32') return 'yt-dlp.exe';
  if (process.platform === 'darwin') return 'yt-dlp_macos';
  return 'yt-dlp_linux';
}

function getUserBinDir() {
  return path.join(app.getPath('userData'), 'bin', platformDir());
}

function getBundledBinDir() {
  if (app.isPackaged) return path.join(process.resourcesPath, 'bin', platformDir());
  return path.join(__dirname, '..', '..', 'bin', platformDir());
}

function currentBinaryPath() {
  const ext = process.platform === 'win32' ? '.exe' : '';
  const userPath = path.join(getUserBinDir(), `yt-dlp${ext}`);
  if (fs.existsSync(userPath)) return userPath;
  return path.join(getBundledBinDir(), `yt-dlp${ext}`);
}

function currentVersion() {
  try {
    const bin = currentBinaryPath();
    if (!fs.existsSync(bin)) return '';
    const r = spawnSync(bin, ['--version'], { encoding: 'utf8', timeout: 15000 });
    const out = (r.stdout || '') + (r.stderr || '');
    return parseVersion(out);
  } catch (_) {
    return '';
  }
}

function fetchTextWithRedirects(url, maxRedirects = 5) {
  return new Promise((resolve, reject) => {
    const get = (u, redirects) => {
      https.get(u, { headers: { 'User-Agent': 'stow-ytdlp-updater' } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          if (redirects > maxRedirects) {
            res.resume();
            return reject(new Error('Too many redirects'));
          }
          const next = res.headers.location.startsWith('http')
            ? res.headers.location
            : new URL(res.headers.location, u).toString();
          res.resume();
          return get(next, redirects + 1);
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        }
        let d = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { d += c; });
        res.on('end', () => resolve(d));
      }).on('error', reject);
    };
    get(url, 0);
  });
}

function fetchJson(url) {
  return fetchTextWithRedirects(url).then((text) => JSON.parse(text));
}

function downloadFile(url, destPath) {
  return new Promise((resolve, reject) => {
    const get = (u, redirects = 0) => {
      const file = fs.createWriteStream(destPath);
      file.on('error', reject);
      https.get(u, { headers: { 'User-Agent': 'stow-ytdlp-updater' } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          if (redirects > 5) {
            res.resume();
            file.close();
            return reject(new Error('Too many redirects'));
          }
          const next = res.headers.location.startsWith('http')
            ? res.headers.location
            : new URL(res.headers.location, u).toString();
          res.resume();
          file.close();
          return get(next, redirects + 1);
        }
        if (res.statusCode !== 200) {
          res.resume();
          file.close();
          return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        }
        res.pipe(file);
        file.on('finish', () => { file.close(); resolve(); });
      }).on('error', (e) => {
        try { file.close(); } catch (_) {}
        reject(e);
      });
    };
    get(url);
  });
}

async function latestNightlyTag() {
  const rel = await fetchJson(NIGHTLY_API_LATEST);
  return { tag: rel.tag_name || '', publishedAt: rel.published_at || '' };
}

async function checkForUpdate() {
  const current = currentVersion();
  let latest = '';
  try {
    const info = await latestNightlyTag();
    latest = info.tag || '';
  } catch (e) {
    return { current, latest: '', updateAvailable: false, error: e.message };
  }
  const cmp = latest && current ? compareVersions(current, latest) : 0;
  return { current, latest, updateAvailable: Boolean(latest && current && cmp < 0) };
}

/**
 * Download the latest nightly to the user bin dir (atomic + SHA verified).
 * Keeps a `.prev` backup copy for manual recovery. Only call when no download
 * is running.
 */
async function performUpdate(onProgress) {
  const dir = getUserBinDir();
  fs.mkdirSync(dir, { recursive: true });
  const asset = assetName();
  const url = `${NIGHTLY_LATEST_BASE}/${asset}`;
  const dest = path.join(dir, process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');
  const tmp = `${dest}.download-${process.pid}`;
  const sumsUrl = `${NIGHTLY_LATEST_BASE}/SHA2-256SUMS`;

  onProgress?.({ stage: 'downloading' });
  await downloadFile(url, tmp);

  // SHA256 verification against the release sums file (follows 302s).
  // Fail closed: missing sums, missing entry, or mismatch aborts the update.
  const sums = await fetchTextWithRedirects(sumsUrl).catch((e) => {
    try { fs.unlinkSync(tmp); } catch (_) {}
    throw new Error(`Could not verify checksum (unverified): ${e.message}`);
  });
  const line = sums.split('\n').find((l) => l.trim().endsWith(asset));
  if (!line) {
    try { fs.unlinkSync(tmp); } catch (_) {}
    throw new Error('Could not verify checksum (unverified): entry missing from SHA2-256SUMS');
  }
  const expected = line.trim().split(/\s+/)[0].toLowerCase();
  const hash = crypto.createHash('sha256');
  await new Promise((resolve, reject) => {
    const s = fs.createReadStream(tmp);
    s.on('data', (d) => hash.update(d));
    s.on('end', resolve);
    s.on('error', reject);
  });
  const actual = hash.digest('hex').toLowerCase();
  if (actual !== expected) {
    try { fs.unlinkSync(tmp); } catch (_) {}
    throw new Error('Checksum mismatch — update aborted');
  }

  if (process.platform !== 'win32') fs.chmodSync(tmp, 0o755);

  // Rollback copy of the previous binary.
  try {
    if (fs.existsSync(dest)) fs.copyFileSync(dest, `${dest}.prev`);
  } catch (_) {}

  // Windows-safe replace: backup then replace, with rollback on failure
  // (rename over an in-use exe fails on Windows).
  if (process.platform === 'win32') {
    const backup = `${dest}.backup-${process.pid}`;
    try {
      if (fs.existsSync(dest)) fs.renameSync(dest, backup);
      try {
        fs.renameSync(tmp, dest);
      } catch (replaceErr) {
        if (!fs.existsSync(dest) && fs.existsSync(backup)) {
          try { fs.renameSync(backup, dest); } catch (_) {}
        }
        throw replaceErr;
      }
      try { if (fs.existsSync(backup)) fs.unlinkSync(backup); } catch (_) {}
    } catch (e) {
      try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch (_) {}
      throw e;
    }
  } else {
    fs.renameSync(tmp, dest);
  }
  const version = currentVersion();
  onProgress?.({ stage: 'done', version });
  return { version, path: dest };
}

module.exports = {
  currentBinaryPath,
  currentVersion,
  checkForUpdate,
  performUpdate,
  getUserBinDir,
};
