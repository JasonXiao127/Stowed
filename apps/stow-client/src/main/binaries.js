const path = require('path');
const fs = require('fs');
const { app } = require('electron');

function getBinDir() {
  const platform = process.platform === 'win32' ? 'win32' : process.platform === 'darwin' ? 'darwin' : 'linux';
  if (app.isPackaged) {
    // In production, binaries are in the app resources
    return path.join(process.resourcesPath, 'bin', platform);
  }
  // In development, binaries are in the project's bin directory
  return path.join(__dirname, '..', '..', 'bin', platform);
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
  const binDir = getBinDir();
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
  const binDir = getBinDir();
  const ext = process.platform === 'win32' ? '.exe' : '';
  return path.join(binDir, `ffprobe${ext}`);
}

module.exports = { getYtDlpPath, getFfmpegPath, getFfprobePath, getBinDir };
