const { spawn } = require('child_process');
const { getYtDlpPath, getJsRuntime, getDenoPath } = require('./binaries');
const path = require('path');

function pickThumbnail(thumbnails) {
  if (!Array.isArray(thumbnails) || !thumbnails.length) return '';
  // Prefer the largest resolution thumbnail with a URL.
  let best = null;
  let bestArea = -1;
  for (const t of thumbnails) {
    if (!t || !t.url) continue;
    const area = (Number(t.width) || 0) * (Number(t.height) || 0);
    if (area >= bestArea) { bestArea = area; best = t; }
  }
  return (best && best.url) || '';
}

function normalizeEntry(e, fallbackUrl) {
  if (!e) return null;
  const id = e.id || '';
  const url = e.webpage_url || e.url || (id && fallbackUrl && fallbackUrl.includes('playlist') ? `https://www.youtube.com/watch?v=${id}` : fallbackUrl) || '';
  return {
    id,
    title: e.title || id || 'Untitled',
    uploader: e.uploader || e.channel || '',
    duration: Number.isFinite(Number(e.duration)) ? Number(e.duration) : null,
    thumbnail: pickThumbnail(e.thumbnails) || e.thumbnail || '',
    url,
  };
}

/**
 * Inspect a URL without downloading: returns video or playlist metadata.
 * Uses `yt-dlp -J --flat-playlist` with a timeout and output cap.
 */
function inspectUrl(url, { playlistEnd = 20 } = {}) {
  return new Promise((resolve, reject) => {
    let bin;
    try {
      bin = getYtDlpPath();
    } catch (e) {
      return reject(new Error(e.message));
    }
    let jsRuntime = 'node';
    try { jsRuntime = getJsRuntime(); } catch (_) {}
    let denoDir = '';
    try {
      const p = getDenoPath();
      if (p) denoDir = path.dirname(p);
    } catch (_) {}

    const args = [
      '--js-runtimes', jsRuntime,
      '--impersonate', 'chrome',
      '--no-warnings',
      '--no-playlist',
      '-J',
      '--flat-playlist',
      '--playlist-end', String(Math.min(Math.max(Number(playlistEnd) || 20, 1), 50)),
      '--socket-timeout', '15',
      '--', url,
    ];

    // Playlists need full extraction; single videos can skip --no-playlist.
    // Try playlist-aware first: if the URL is a playlist, --no-playlist would
    // collapse it to one entry, so drop that flag for list URLs.
    if (/[?&]list=|playlist/i.test(url)) {
      const i = args.indexOf('--no-playlist');
      if (i !== -1) args.splice(i, 1);
    }

    const child = spawn(bin, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        PATH: [denoDir, process.env.PATH].filter(Boolean).join(path.delimiter),
      },
    });

    let stdout = '';
    let stderr = '';
    const MAX_BYTES = 1024 * 1024;
    let killed = false;
    const timer = setTimeout(() => {
      killed = true;
      try { child.kill('SIGKILL'); } catch (_) {}
      reject(Object.assign(new Error('Inspect timed out'), { status: 504 }));
    }, 30000);
    if (timer.unref) timer.unref();

    child.stdout.on('data', (d) => {
      stdout += d.toString();
      if (stdout.length > MAX_BYTES) {
        try { child.kill('SIGKILL'); } catch (_) {}
      }
    });
    child.stderr.on('data', (d) => { if (stderr.length < 4096) stderr += d.toString(); });
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(new Error(e.message));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (killed) return;
      if (stdout.length > MAX_BYTES) {
        return reject(Object.assign(new Error('Inspect response too large'), { status: 502 }));
      }
      if (code !== 0) {
        const msg = (stderr.trim().split('\n').pop() || `yt-dlp exited with code ${code}`).slice(0, 300);
        return reject(new Error(msg));
      }
      let json;
      try {
        json = JSON.parse(stdout);
      } catch (_) {
        return reject(Object.assign(new Error('Could not parse video information'), { status: 502 }));
      }
      // Playlist: has entries array. Single video: flat object.
      if (json && Array.isArray(json.entries)) {
        const entries = json.entries.filter(Boolean).slice(0, 50).map((e) => normalizeEntry(e, url)).filter(Boolean);
        return resolve({
          type: 'playlist',
          title: json.title || 'Playlist',
          uploader: json.uploader || json.channel || '',
          count: json.playlist_count || entries.length,
          entries,
        });
      }
      const single = normalizeEntry(json, url);
      if (!single) return reject(Object.assign(new Error('Could not parse video information'), { status: 502 }));
      return resolve({ type: 'video', ...single });
    });
  });
}

module.exports = { inspectUrl, pickThumbnail, normalizeEntry };
