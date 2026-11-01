const https = require('https');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const PLATFORM = process.platform;
const ARCH = process.arch === 'arm64' ? 'arm64' : 'x64';
const BIN_DIR = path.join(__dirname, '..', 'bin', PLATFORM === 'win32' ? 'win32' : PLATFORM === 'darwin' ? 'darwin' : 'linux');
const FORCE = process.argv.includes('--force') || process.env.FORCE === '1';

function denoAsset() {
  if (PLATFORM === 'win32') {
    return ARCH === 'arm64'
      ? 'deno-aarch64-pc-windows-msvc.zip'
      : 'deno-x86_64-pc-windows-msvc.zip';
  }
  if (PLATFORM === 'darwin') {
    return ARCH === 'arm64'
      ? 'deno-aarch64-apple-darwin.zip'
      : 'deno-x86_64-apple-darwin.zip';
  }
  return ARCH === 'arm64'
    ? 'deno-aarch64-unknown-linux-gnu.zip'
    : 'deno-x86_64-unknown-linux-gnu.zip';
}

const BINARIES = {
  'yt-dlp': {
    win32: 'https://github.com/yt-dlp/yt-dlp-nightly-builds/releases/latest/download/yt-dlp.exe',
    darwin: 'https://github.com/yt-dlp/yt-dlp-nightly-builds/releases/latest/download/yt-dlp_macos',
    linux: 'https://github.com/yt-dlp/yt-dlp-nightly-builds/releases/latest/download/yt-dlp_linux',
  },
  'yt-dlp-sha': 'https://github.com/yt-dlp/yt-dlp-nightly-builds/releases/latest/download/SHA2-256SUMS',
  deno: `https://github.com/denoland/deno/releases/latest/download/${denoAsset()}`,
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

function getFfmpegConfig() {
  const base = BINARIES.ffmpeg[PLATFORM];
  if (!base) throw new Error(`Unsupported platform for FFmpeg: ${PLATFORM}`);
  if (PLATFORM === 'linux' && ARCH === 'arm64') {
    const prefix = 'ffmpeg-master-latest-linuxarm64-gpl';
    return {
      url: `https://github.com/BtbN/FFmpeg-Builds/releases/latest/download/${prefix}.tar.xz`,
      archiveExtension: '.tar.xz',
      ffmpegExtract: `${prefix}/bin/ffmpeg`,
      ffprobeExtract: `${prefix}/bin/ffprobe`,
      requiresFfprobe: true,
    };
  }
  if (PLATFORM === 'win32' && ARCH === 'arm64') {
    const prefix = 'ffmpeg-master-latest-winarm64-gpl';
    return {
      url: `https://github.com/BtbN/FFmpeg-Builds/releases/latest/download/${prefix}.zip`,
      archiveExtension: '.zip',
      ffmpegExtract: `${prefix}/bin/ffmpeg.exe`,
      ffprobeExtract: `${prefix}/bin/ffprobe.exe`,
      requiresFfprobe: true,
    };
  }
  if (PLATFORM === 'darwin' && ARCH === 'arm64') {
    console.warn('macOS arm64: using x64 FFmpeg build (runs under Rosetta 2).');
  }
  return base;
}

function downloadFile(url, destPath) {
  return new Promise((resolve, reject) => {
    console.log(`Downloading ${url}...`);
    const file = fs.createWriteStream(destPath);
    const get = (currentUrl, redirects = 0) => {
      if (redirects > 5) {
        file.close();
        fs.unlinkSync(destPath);
        return reject(new Error(`Too many redirects for ${url}`));
      }
      https.get(currentUrl, (response) => {
        if (response.statusCode === 302 || response.statusCode === 301 || response.statusCode === 303 || response.statusCode === 307 || response.statusCode === 308) {
          const loc = response.headers.location;
          response.resume();
          file.close();
          try { fs.unlinkSync(destPath); } catch (_) {}
          if (!loc) return reject(new Error(`Redirect without location for ${currentUrl}`));
          const next = loc.startsWith('http') ? loc : new URL(loc, currentUrl).toString();
          // Re-create the write stream for the follow-up request.
          const fresh = fs.createWriteStream(destPath);
          fresh.on('error', reject);
          downloadToStream(next, fresh, redirects + 1).then(resolve).catch(reject);
          return;
        }
        if (response.statusCode !== 200) {
          file.close();
          try { fs.unlinkSync(destPath); } catch (_) {}
          response.resume();
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
    };
    get(url);
  });
}

function downloadToStream(url, file, redirects = 0) {
  return new Promise((resolve, reject) => {
    https.get(url, (response) => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        if (redirects > 5) return reject(new Error('Too many redirects'));
        const loc = response.headers.location;
        const next = loc.startsWith('http') ? loc : new URL(loc, url).toString();
        response.resume();
        return downloadToStream(next, file, redirects + 1).then(resolve).catch(reject);
      }
      if (response.statusCode !== 200) {
        response.resume();
        return reject(new Error(`HTTP ${response.statusCode} for ${url}`));
      }
      response.pipe(file);
      file.on('finish', () => {
        file.close();
        resolve();
      });
    }).on('error', reject);
  });
}

function fetchText(url, redirects = 0) {
  const MAX_REDIRECTS = 5;
  if (redirects > MAX_REDIRECTS) {
    return Promise.reject(new Error(`Too many redirects for ${url}`));
  }
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const loc = res.headers.location;
        const next = loc.startsWith('http') ? loc : new URL(loc, url).toString();
        res.resume();
        return fetchText(next, redirects + 1).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { data += c; if (data.length > 1024 * 1024) res.destroy(); });
      res.on('end', () => resolve(data));
      res.on('error', reject);
    }).on('error', reject);
  });
}

async function verifyYtDlpChecksum(filePath, assetName) {
  try {
    const sums = await fetchText(BINARIES['yt-dlp-sha']);
    const line = sums.split('\n').find((l) => l.trim().endsWith(assetName));
    if (!line) {
      console.warn(`Checksum entry not found for ${assetName}; skipping verification.`);
      return;
    }
    const expected = line.trim().split(/\s+/)[0].toLowerCase();
    const crypto = require('crypto');
    const hash = crypto.createHash('sha256');
    await new Promise((resolve, reject) => {
      const s = fs.createReadStream(filePath);
      s.on('data', (d) => hash.update(d));
      s.on('end', resolve);
      s.on('error', reject);
    });
    const actual = hash.digest('hex').toLowerCase();
    if (actual !== expected) {
      fs.unlinkSync(filePath);
      throw new Error(`Checksum mismatch for ${assetName}: expected ${expected}, got ${actual}`);
    }
    console.log(`Checksum verified for ${assetName}.`);
  } catch (err) {
    if (/checksum mismatch/i.test(err.message)) throw err;
    console.warn(`Checksum verification skipped: ${err.message}`);
  }
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
  const ytDlpAsset = PLATFORM === 'win32' ? 'yt-dlp.exe' : PLATFORM === 'darwin' ? 'yt-dlp_macos' : 'yt-dlp_linux';

  if (!fs.existsSync(ytDlpPath) || FORCE) {
    const tmpPath = `${ytDlpPath}.download`;
    try { fs.unlinkSync(tmpPath); } catch (_) {}
    await downloadFile(ytDlpUrl, tmpPath);
    await verifyYtDlpChecksum(tmpPath, ytDlpAsset);
    fs.renameSync(tmpPath, ytDlpPath);
    if (PLATFORM !== 'win32') {
      fs.chmodSync(ytDlpPath, 0o755);
    }
    console.log(`yt-dlp downloaded to ${ytDlpPath}`);
  } else {
    console.log('yt-dlp already exists, skipping (use --force to update).');
  }

  // Download Deno (JS runtime for yt-dlp's YouTube challenge solver).
  const denoName = PLATFORM === 'win32' ? 'deno.exe' : 'deno';
  const denoPath = path.join(BIN_DIR, denoName);
  if (!fs.existsSync(denoPath) || FORCE) {
    const archivePath = path.join(BIN_DIR, `deno-${ARCH}.zip`);
    try { fs.unlinkSync(archivePath); } catch (_) {}
    await downloadFile(BINARIES.deno, archivePath);
    const extractDir = path.join(BIN_DIR, 'deno-extract');
    if (!fs.existsSync(extractDir)) fs.mkdirSync(extractDir, { recursive: true });
    extractZip(archivePath, extractDir);
    const extracted = path.join(extractDir, denoName);
    if (!fs.existsSync(extracted)) {
      throw new Error(`Could not find deno in extracted files at ${extracted}`);
    }
    fs.copyFileSync(extracted, denoPath);
    if (PLATFORM !== 'win32') fs.chmodSync(denoPath, 0o755);
    fs.unlinkSync(archivePath);
    fs.rmSync(extractDir, { recursive: true, force: true });
    console.log(`Deno downloaded to ${denoPath}`);
  } else {
    console.log('Deno already exists, skipping (use --force to update).');
  }

  // Download FFmpeg (arch-aware: BtbN publishes linuxarm64/winarm64;
  // evermeet macOS zip is x64-only, runs under Rosetta on arm64).
  const ffmpegConfig = getFfmpegConfig();
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
