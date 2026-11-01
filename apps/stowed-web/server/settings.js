const fs = require('fs');
const path = require('path');
const config = require('./config');

const SETTINGS_FILE = path.join(config.configDir, 'settings.json');

const DEFAULTS = {
  // yt-dlp behaviour
  embedChapters: false,
  sponsorblock: null, // e.g. 'remove:music_offtopic' or 'mark:all'
  opusPreferred: true, // format selector prefers Opus; false forces re-encode path
  // cookies.txt handling (Netscape format). Stored at configDir/cookies.txt.
  cookiesConfigured: false,
  cookiesUpdatedAt: null,
  autoUpdateYtDlp: true,
};

function settingsPath() {
  return process.env.STOW_SETTINGS_FILE || SETTINGS_FILE;
}

function getSettings() {
  try {
    const p = settingsPath();
    if (!fs.existsSync(p)) return { ...DEFAULTS };
    const raw = fs.readFileSync(p, 'utf8');
    const parsed = JSON.parse(raw);
    // Allowlist known keys only; ignore unknown/stale keys.
    const out = { ...DEFAULTS };
    for (const k of Object.keys(DEFAULTS)) {
      if (parsed[k] !== undefined) out[k] = parsed[k];
    }
    // cookiesConfigured is derived from the actual file when present.
    try {
      const cookiesFile = path.join(config.configDir, 'cookies.txt');
      if (fs.existsSync(cookiesFile)) {
        out.cookiesConfigured = true;
        if (!out.cookiesUpdatedAt) {
          out.cookiesUpdatedAt = fs.statSync(cookiesFile).mtime.toISOString();
        }
      } else {
        out.cookiesConfigured = false;
        out.cookiesUpdatedAt = null;
      }
    } catch (_) {}
    return out;
  } catch (_) {
    return { ...DEFAULTS };
  }
}

function saveSettings(patch) {
  const current = getSettings();
  const next = { ...current };
  for (const k of Object.keys(DEFAULTS)) {
    if (patch[k] !== undefined) next[k] = patch[k];
  }
  // Validation
  if (typeof next.embedChapters !== 'boolean') throw new Error('embedChapters must be a boolean');
  if (next.sponsorblock !== null && typeof next.sponsorblock !== 'string') {
    throw new Error('sponsorblock must be a string or null');
  }
  if (next.sponsorblock && !/^(remove|mark):[a-z_,]+$/i.test(next.sponsorblock)) {
    throw new Error('Invalid sponsorblock value (expected remove:<cats> or mark:<cats>)');
  }
  if (typeof next.opusPreferred !== 'boolean') throw new Error('opusPreferred must be a boolean');
  if (typeof next.autoUpdateYtDlp !== 'boolean') throw new Error('autoUpdateYtDlp must be a boolean');
  // cookiesConfigured/cookiesUpdatedAt are managed by the cookies endpoints.
  next.cookiesConfigured = Boolean(current.cookiesConfigured);
  next.cookiesUpdatedAt = current.cookiesUpdatedAt || null;

  const p = settingsPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8');
  fs.renameSync(tmp, p);
  return next;
}

function setCookiesState(configured, updatedAt) {
  const p = settingsPath();
  const current = getSettings();
  const next = { ...current, cookiesConfigured: Boolean(configured), cookiesUpdatedAt: updatedAt || null };
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8');
  fs.renameSync(tmp, p);
  return next;
}

module.exports = { DEFAULTS, getSettings, saveSettings, setCookiesState, settingsPath };
