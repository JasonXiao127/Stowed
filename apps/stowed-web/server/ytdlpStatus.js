const { spawn, spawnSync } = require('child_process');
const { getYtDlpPath, getJsRuntime, getDenoPath } = require('./binaries');
const { parseVersion } = require('@stowed/core');

let cache = { at: 0, value: { version: '', error: '', jsRuntime: '', denoAvailable: false, ejsAvailable: null } };
const CACHE_TTL_MS = 60_000;
let refreshing = false;

function readStatic() {
  let jsRuntime = '';
  try { jsRuntime = getJsRuntime(); } catch (_) {}
  let denoAvailable = false;
  try { denoAvailable = Boolean(getDenoPath()); } catch (_) {}
  return { jsRuntime, denoAvailable };
}

function refreshInBackground() {
  if (refreshing) return;
  refreshing = true;
  let bin;
  try {
    bin = getYtDlpPath();
  } catch (e) {
    const { jsRuntime, denoAvailable } = readStatic();
    cache = { at: Date.now(), value: { version: '', error: e.message, jsRuntime, denoAvailable, ejsAvailable: null } };
    refreshing = false;
    return;
  }
  const child = spawn(bin, ['--version'], { timeout: 15000 });
  let out = '';
  child.stdout.on('data', (d) => { out += d.toString(); });
  child.stderr.on('data', (d) => { out += d.toString(); });
  const done = (version, error) => {
    const { jsRuntime, denoAvailable } = readStatic();
    // EJS is bundled with official binaries and the Docker `default` extra.
    // No live YouTube probe: the old verbose --simulate request blocked the
    // /api/system request path for up to 20s. Report unknown; the UI handles it.
    cache = { at: Date.now(), value: { version, error, jsRuntime, denoAvailable, ejsAvailable: null } };
    refreshing = false;
  };
  child.on('error', (e) => done('', e.message));
  child.on('close', (code) => {
    const version = parseVersion(out.trim());
    if (version) done(version, '');
    else done('', code ? `exit ${code}` : '');
  });
  setTimeout(() => {
    try { child.kill(); } catch (_) {}
  }, 15000).unref?.();
}

function getYtDlpStatus(force = false) {
  const now = Date.now();
  if (cache.value && now - cache.at < CACHE_TTL_MS && !force) return cache.value;
  // Serve cached immediately; refresh in background so the request path never blocks.
  if (!cache.value || force) {
    // First call: try a fast sync version read (local, no network), fall back to background.
    try {
      const bin = getYtDlpPath();
      const r = spawnSync(bin, ['--version'], { encoding: 'utf8', timeout: 5000 });
      const version = parseVersion(((r.stdout || '') + (r.stderr || '')).trim());
      const { jsRuntime, denoAvailable } = readStatic();
      const value = { version, error: version ? '' : (r.error ? r.error.message : `exit ${r.status}`), jsRuntime, denoAvailable, ejsAvailable: null };
      cache = { at: now, value };
      // Schedule a background refresh to keep the cache warm without blocking.
      if (now - cache.at >= CACHE_TTL_MS) refreshInBackground();
      return value;
    } catch (e) {
      refreshInBackground();
      return cache.value;
    }
  }
  refreshInBackground();
  return cache.value;
}

module.exports = { getYtDlpStatus };
