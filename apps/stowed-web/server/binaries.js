const path = require('path');
const fs = require('fs');

/**
 * Locate yt-dlp / ffmpeg / ffprobe.
 *
 * In the Docker image these are installed system-wide (ffmpeg via apt,
 * yt-dlp downloaded into /usr/local/bin), so we check PATH first. For local
 * development we fall back to the same per-platform bin/ folder the desktop
 * app used (bin/<platform>/).
 */

function platform() {
  if (process.platform === 'win32') return 'win32';
  if (process.platform === 'darwin') return 'darwin';
  return 'linux';
}

function findOnPath(name) {
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    const candidate = path.join(dir, name);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch (_) {
      // keep looking
    }
  }
  return null;
}

function resolveTool(name) {
  const suffixed = process.platform === 'win32' ? `${name}.exe` : name;
  const fromPath = findOnPath(suffixed);
  if (fromPath) return fromPath;

  const local = path.join(__dirname, '..', 'bin', platform(), suffixed);
  if (fs.existsSync(local)) return local;

  throw new Error(
    `${name} not found on PATH or in bin/${platform()}/${suffixed}. ` +
      'In Docker it is installed by the image; locally run "npm run setup-binaries".'
  );
}

function getYtDlpPath() {
  return resolveTool('yt-dlp');
}

function getFfmpegPath() {
  return resolveTool('ffmpeg');
}

function getFfprobePath() {
  return resolveTool('ffprobe');
}

module.exports = { getYtDlpPath, getFfmpegPath, getFfprobePath };
