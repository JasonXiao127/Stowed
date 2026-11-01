const path = require('path');
const fs = require('fs');
const { app } = require('electron');

function getUserBinDir() {
  const platform = process.platform === 'win32' ? 'win32' : process.platform === 'darwin' ? 'darwin' : 'linux';
  try {
    return path.join(app.getPath('userData'), 'bin', platform);
  } catch (_) {
    return null;
  }
}

function getBundledBinDir() {
  const platform = process.platform === 'win32' ? 'win32' : process.platform === 'darwin' ? 'darwin' : 'linux';
  if (app.isPackaged) {
    // In production, binaries are in the app resources
    return path.join(process.resourcesPath, 'bin', platform);
  }
  // In development, binaries are in the project's bin directory
  return path.join(__dirname, '..', '..', 'bin', platform);
}

function getBinDir() {
  // yt-dlp may live in userData/bin (writable nightly updates); everything
  // else (ffmpeg/ffprobe/deno) must resolve to the bundled resources dir so
  // an updated yt-dlp can never shadow them.
  const platform = process.platform === 'win32' ? 'win32' : process.platform === 'darwin' ? 'darwin' : 'linux';
  try {
    const userDir = path.join(app.getPath('userData'), 'bin', platform);
    const ext = process.platform === 'win32' ? '.exe' : '';
    if (fs.existsSync(path.join(userDir, `yt-dlp${ext}`))) return userDir;
  } catch (_) {}
  return getBundledBinDir();
}

function getDenoPath() {
  const bundled = getBundledBinDir();
  const ext = process.platform === 'win32' ? '.exe' : '';
  const denoPath = path.join(bundled, `deno${ext}`);
  if (fs.existsSync(denoPath)) return denoPath;
  return null;
}

function getJsRuntime() {
  // Prefer the bundled Deno; fall back to Node (bundled with Electron).
  if (getDenoPath()) return 'deno';
  return 'node';
}

function getYtDlpPath() {
  const binDir = getBinDir();
  const ext = process.platform === 'win32' ? '.exe' : '';
  const ytDlpPath = path.join(binDir, `yt-dlp${ext}`);

  if (!fs.existsSync(ytDlpPath)) {
    throw new Error(
      `yt-dlp not found at ${ytDlpPath}. Please run "npm run setup-binaries" to download it.`
    );
  }

  return ytDlpPath;
}

function getFfmpegPath() {
  const binDir = getBundledBinDir();
  const ext = process.platform === 'win32' ? '.exe' : '';
  const ffmpegPath = path.join(binDir, `ffmpeg${ext}`);

  if (!fs.existsSync(ffmpegPath)) {
    throw new Error(
      `FFmpeg not found at ${ffmpegPath}. Please run "npm run setup-binaries" to download it.`
    );
  }

  return ffmpegPath;
}

function getFfprobePath() {
  const binDir = getBundledBinDir();
  const ext = process.platform === 'win32' ? '.exe' : '';
  return path.join(binDir, `ffprobe${ext}`);
}

module.exports = { getYtDlpPath, getFfmpegPath, getFfprobePath, getBinDir, getBundledBinDir, getUserBinDir, getDenoPath, getJsRuntime };
