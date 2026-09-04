const https = require('https');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const PLATFORM = process.platform;
const BIN_DIR = path.join(__dirname, '..', 'bin', PLATFORM === 'win32' ? 'win32' : PLATFORM === 'darwin' ? 'darwin' : 'linux');

const BINARIES = {
  'yt-dlp': {
    win32: 'https://github.com/yt-dlp/yt-dlp-nightly-builds/releases/latest/download/yt-dlp.exe',
    darwin: 'https://github.com/yt-dlp/yt-dlp-nightly-builds/releases/latest/download/yt-dlp_macos',
    linux: 'https://github.com/yt-dlp/yt-dlp-nightly-builds/releases/latest/download/yt-dlp_linux',
  },
  'ffmpeg': {
    win32: {
      url: 'https://github.com/BtbN/FFmpeg-Builds/releases/latest/download/ffmpeg-master-latest-win64-gpl.zip',
      archiveExtension: '.zip',
      ffmpegExtract: 'ffmpeg-master-latest-win64-gpl/bin/ffmpeg.exe',
      ffprobeExtract: 'ffmpeg-master-latest-win64-gpl/bin/ffprobe.exe',
      requiresFfprobe: true,
    },
    darwin: {
      url: 'https://evermeet.cx/ffmpeg/ffmpeg-7.1.zip',
      archiveExtension: '.zip',
      ffmpegExtract: 'ffmpeg',
      ffprobeExtract: 'ffprobe',
      requiresFfprobe: false,
    },
    linux: {
      url: 'https://github.com/BtbN/FFmpeg-Builds/releases/latest/download/ffmpeg-master-latest-linux64-gpl.tar.xz',
      archiveExtension: '.tar.xz',
      ffmpegExtract: 'ffmpeg-master-latest-linux64-gpl/bin/ffmpeg',
      ffprobeExtract: 'ffmpeg-master-latest-linux64-gpl/bin/ffprobe',
      requiresFfprobe: true,
    },
  },
};

function downloadFile(url, destPath) {
  return new Promise((resolve, reject) => {
    console.log(`Downloading ${url}...`);
    const file = fs.createWriteStream(destPath);
    https.get(url, (response) => {
      if (response.statusCode === 302 || response.statusCode === 301) {
        file.close();
        fs.unlinkSync(destPath);
        return downloadFile(response.headers.location, destPath).then(resolve).catch(reject);
      }
      if (response.statusCode !== 200) {
        file.close();
        fs.unlinkSync(destPath);
        return reject(new Error(`HTTP ${response.statusCode} for ${url}`));
      }
      response.pipe(file);
      file.on('finish', () => {
        file.close();
        resolve();
      });
    }).on('error', (err) => {
      file.close();
      fs.unlinkSync(destPath, () => {});
      reject(err);
    });
  });
}

function extractZip(archivePath, extractDir) {
  console.log(`Extracting ${archivePath}...`);
  if (process.platform === 'win32') {
    // Use PowerShell to extract
    const cmd = `powershell -Command "Expand-Archive -Path '${archivePath}' -DestinationPath '${extractDir}' -Force"`;
    execSync(cmd, { stdio: 'inherit' });
  } else {
    const AdmZip = require('adm-zip');
    const zip = new AdmZip(archivePath);
    zip.extractAllTo(extractDir, true);
  }
}

async function downloadBinaries() {
  console.log(`Platform: ${PLATFORM}`);
  console.log(`Binary directory: ${BIN_DIR}`);

  if (!fs.existsSync(BIN_DIR)) {
    fs.mkdirSync(BIN_DIR, { recursive: true });
  }

  // Download yt-dlp
  const ytDlpUrl = BINARIES['yt-dlp'][PLATFORM];
  if (!ytDlpUrl) {
    console.error(`Unsupported platform: ${PLATFORM}`);
    process.exit(1);
  }

  const ytDlpExt = PLATFORM === 'win32' ? '.exe' : '';
  const ytDlpPath = path.join(BIN_DIR, `yt-dlp${ytDlpExt}`);

  if (!fs.existsSync(ytDlpPath)) {
    await downloadFile(ytDlpUrl, ytDlpPath);
    if (PLATFORM !== 'win32') {
      fs.chmodSync(ytDlpPath, 0o755);
    }
    console.log(`yt-dlp downloaded to ${ytDlpPath}`);
  } else {
    console.log('yt-dlp already exists, skipping.');
  }

  // Download FFmpeg
  const ffmpegConfig = BINARIES['ffmpeg'][PLATFORM];
  const ffmpegPath = path.join(BIN_DIR, PLATFORM === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
  const ffprobePath = path.join(BIN_DIR, PLATFORM === 'win32' ? 'ffprobe.exe' : 'ffprobe');

  if (!fs.existsSync(ffmpegPath) || (ffmpegConfig.requiresFfprobe && !fs.existsSync(ffprobePath))) {
    const archivePath = path.join(BIN_DIR, `ffmpeg${ffmpegConfig.archiveExtension}`);
    await downloadFile(ffmpegConfig.url, archivePath);

    // Extract
    const extractDir = path.join(BIN_DIR, 'ffmpeg-extract');
    if (!fs.existsSync(extractDir)) {
      fs.mkdirSync(extractDir, { recursive: true });
    }

    if (ffmpegConfig.archiveExtension === '.zip') {
      extractZip(archivePath, extractDir);
    } else if (ffmpegConfig.archiveExtension === '.tar.xz') {
      execSync(`tar -xf "${archivePath}" -C "${extractDir}"`, { stdio: 'inherit' });
    } else {
      throw new Error(`Unsupported FFmpeg archive type: ${ffmpegConfig.archiveExtension}`);
    }

    // Move ffmpeg binary
    const extractedFfmpeg = path.join(extractDir, ffmpegConfig.ffmpegExtract);
    if (fs.existsSync(extractedFfmpeg)) {
      fs.copyFileSync(extractedFfmpeg, ffmpegPath);
      if (PLATFORM !== 'win32') {
        fs.chmodSync(ffmpegPath, 0o755);
      }
      console.log(`FFmpeg downloaded to ${ffmpegPath}`);
    } else {
      console.error(`Could not find ffmpeg in extracted files at ${extractedFfmpeg}`);
      throw new Error(`Could not find ffmpeg in extracted files at ${extractedFfmpeg}`);
    }

    // BtbN archives include ffprobe. Some macOS distributions do not, so
    // install it when present without making it mandatory there.
    const extractedFfprobe = path.join(extractDir, ffmpegConfig.ffprobeExtract);
    if (fs.existsSync(extractedFfprobe)) {
      fs.copyFileSync(extractedFfprobe, ffprobePath);
      if (PLATFORM !== 'win32') {
        fs.chmodSync(ffprobePath, 0o755);
      }
      console.log(`FFprobe downloaded to ${ffprobePath}`);
    }

    // Cleanup
    fs.unlinkSync(archivePath);
    fs.rmSync(extractDir, { recursive: true, force: true });
  } else {
    console.log('FFmpeg already exists, skipping.');
  }

  console.log('All binaries downloaded successfully!');
}

downloadBinaries().catch((err) => {
  console.error('Failed to download binaries:', err.message);
  process.exit(1);
});
