const https = require('https');
const http = require('http');
const crypto = require('crypto');

const ALLOWED_THUMB_HOSTS = [
  /(^|\.)ytimg\.com$/,
  /(^|\.)ggpht\.com$/,
  /(^|\.)googleusercontent\.com$/,
  /(^|\.)sndcdn\.com$/,
  /(^|\.)bandcamp\.com$/,
  /(^|\.)bcbits\.com$/,
  /(^|\.)spotifycdn\.com$/,
  /(^|\.)scdn\.co$/,
  /(^|\.)mzstatic\.com$/,
  /(^|\.)apple\.com$/,
  /(^|\.)akamaihd\.net$/,
  /(^|\.)akamaized\.net$/,
  /(^|\.)cloudfront\.net$/,
  /(^|\.)fbcdn\.net$/,
  /(^|\.)twimg\.com$/,
  /(^|\.)tiktokcdn\.com$/,
  /(^|\.)vimeocdn\.com$/,
];

function isThumbHostAllowed(hostname) {
  const h = String(hostname || '').toLowerCase();
  return ALLOWED_THUMB_HOSTS.some((re) => re.test(h));
}

const cache = new Map(); // hash -> { data, contentType, at }
const CACHE_TTL_MS = 60 * 60 * 1000;
const CACHE_MAX = 50;

function cacheGet(key) {
  const e = cache.get(key);
  if (!e) return null;
  if (Date.now() - e.at > CACHE_TTL_MS) { cache.delete(key); return null; }
  return e;
}

function cacheSet(key, value) {
  if (cache.size >= CACHE_MAX) {
    const oldest = cache.keys().next().value;
    cache.delete(oldest);
  }
  cache.set(key, { ...value, at: Date.now() });
}

function fetchImage(url, redirects = 0) {
  const MAX_REDIRECTS = 5;
  if (redirects > MAX_REDIRECTS) {
    return Promise.reject(Object.assign(new Error('Too many thumbnail redirects'), { status: 502 }));
  }
  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL(url);
    } catch (_) {
      return reject(new Error('Invalid thumbnail URL'));
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      return reject(new Error('Only http(s) thumbnails are allowed'));
    }
    if (!isThumbHostAllowed(parsed.hostname)) {
      return reject(Object.assign(new Error('Thumbnail host not allowed'), { status: 400 }));
    }
    const lib = parsed.protocol === 'https:' ? https : http;
    const req = lib.get(parsed, { timeout: 15000 }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        const next = res.headers.location.startsWith('http')
          ? res.headers.location
          : new URL(res.headers.location, parsed).toString();
        // Re-validate the redirect target.
        let nextHost = '';
        try { nextHost = new URL(next).hostname; } catch (_) {}
        if (!isThumbHostAllowed(nextHost)) {
          return reject(Object.assign(new Error('Thumbnail redirect host not allowed'), { status: 400 }));
        }
        return fetchImage(next, redirects + 1).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(Object.assign(new Error(`Thumbnail fetch failed (${res.statusCode})`), { status: 502 }));
      }
      const ct = (res.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
      if (ct && !ct.startsWith('image/')) {
        res.resume();
        return reject(Object.assign(new Error('Not an image'), { status: 502 }));
      }
      const chunks = [];
      let bytes = 0;
      const MAX_BYTES = 10 * 1024 * 1024;
      res.on('data', (c) => {
        bytes += c.length;
        if (bytes > MAX_BYTES) {
          req.destroy(new Error('Thumbnail too large'));
          return;
        }
        chunks.push(c);
      });
      res.on('end', () => {
        const data = Buffer.concat(chunks);
        // Magic-byte validation (JPEG/PNG/WebP/GIF/BMP).
        const valid = isImageBytes(data);
        if (!valid) return reject(Object.assign(new Error('Invalid image data'), { status: 502 }));
        resolve({ data, contentType: ct || detectImageType(data) });
      });
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('Thumbnail fetch timed out')));
    req.on('error', (e) => {
      e.status = /timed out/i.test(e.message) ? 504 : (e.status || 502);
      reject(e);
    });
  });
}

function isImageBytes(buf) {
  if (!buf || buf.length < 12) return false;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return true; // JPEG
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return true; // PNG
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 && buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) return true; // WEBP
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return true; // GIF
  if (buf[0] === 0x42 && buf[1] === 0x4d) return true; // BMP
  if (buf[0] === 0x89 && buf.toString('ascii', 4, 8) === 'ftyp' && buf.toString('ascii', 8, 12).startsWith('avif')) return true; // AVIF
  return false;
}

function detectImageType(buf) {
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg';
  if (buf[0] === 0x89 && buf[1] === 0x50) return 'image/png';
  if (buf[0] === 0x47 && buf[1] === 0x49) return 'image/gif';
  if (buf[0] === 0x42 && buf[1] === 0x4d) return 'image/bmp';
  return 'image/webp';
}

async function getThumb(url) {
  const hash = crypto.createHash('sha256').update(url).digest('hex');
  const hit = cacheGet(hash);
  if (hit) return hit;
  const img = await fetchImage(url);
  cacheSet(hash, img);
  return img;
}

module.exports = { isThumbHostAllowed, getThumb, fetchImage };
