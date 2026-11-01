'use strict';

const MB_BASE = 'https://musicbrainz.org/ws/2';
const USER_AGENT = 'Stowed/1.0.0 ( https://github.com/JasonXiao127/Stowed )';

const MBID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---- Process-wide 1 req/sec throttle (serialized, bounded) -------------------
let lastRequestTime = 0;
let gate = Promise.resolve();
let pendingCount = 0;
const MAX_PENDING = 8;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function rateLimitedFetch(url, options = {}) {
  if (pendingCount >= MAX_PENDING) {
    throw new Error('MusicBrainz busy: too many pending requests, try again shortly');
  }
  pendingCount += 1;
  const run = gate.then(async () => {
    const now = Date.now();
    const delay = Math.max(0, 1100 - (now - lastRequestTime));
    if (delay > 0) await sleep(delay);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    try {
      const res = await fetch(url, { ...options, signal: controller.signal });
      return res;
    } catch (err) {
      if (err && err.name === 'AbortError') {
        throw new Error('Request timed out');
      }
      throw err;
    } finally {
      clearTimeout(timeout);
      lastRequestTime = Date.now();
    }
  });
  gate = run.catch(() => {}).finally(() => { pendingCount -= 1; });
  return run;
}

// ---- Simple in-memory caches ------------------------------------------------
const SEARCH_TTL_MS = 10 * 60 * 1000;
const SEARCH_MAX = 200;
const searchCache = new Map(); // key -> { expires, value }

const COVER_TTL_MS = 60 * 60 * 1000;
const COVER_MISS_TTL_MS = 10 * 60 * 1000;
// Bounded by entries AND bytes: covers average <1 MB but can reach the
// 10 MB cap, so 8 entries keeps worst-case RSS around 80 MB in small containers.
const COVER_MAX = 8;
const COVER_MAX_BYTES = 10 * 1024 * 1024;
const coverCache = new Map(); // releaseId -> { expires, value }

function cacheGet(map, key) {
  const entry = map.get(key);
  if (!entry) return undefined;
  if (Date.now() > entry.expires) {
    map.delete(key);
    return undefined;
  }
  return entry.value;
}

function cacheSet(map, key, value, ttlMs, maxEntries) {
  if (map.has(key)) map.delete(key);
  while (map.size >= maxEntries) {
    const oldest = map.keys().next().value;
    map.delete(oldest);
  }
  map.set(key, { expires: Date.now() + ttlMs, value });
}

function escapeLucene(value) {
  // Strip ASCII control chars (incl. newlines) that would corrupt the query,
  // then escape backslash + double quote inside quoted phrases.
  return String(value)
    .replace(/[\x00-\x1f\x7f]/g, ' ')
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"');
}

function clampLimit(limit, fallback = 5) {
  const n = Number(limit);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(10, Math.max(1, Math.floor(n)));
}

/**
 * Search MusicBrainz recordings.
 * @returns {Promise<Array>} simplified recording results
 */
async function searchRecordings({ title = '', artist = '', album = '', limit = 5 } = {}) {
  const t = typeof title === 'string' ? title.trim().slice(0, 200) : '';
  const a = typeof artist === 'string' ? artist.trim().slice(0, 200) : '';
  const al = typeof album === 'string' ? album.trim().slice(0, 200) : '';
  if (!t && !a && !al) {
    throw new Error('Invalid search: at least one of title, artist, album is required');
  }
  const clamped = clampLimit(limit, 5);

  const cacheKey = JSON.stringify({ title: t, artist: a, album: al, limit: clamped });
  const cached = cacheGet(searchCache, cacheKey);
  if (cached) return cached;

  const parts = [];
  if (t) parts.push(`recording:"${escapeLucene(t)}"`);
  if (a) parts.push(`artist:"${escapeLucene(a)}"`);
  if (al) parts.push(`release:"${escapeLucene(al)}"`);
  const q = parts.join(' AND ');

  const url =
    `${MB_BASE}/recording/?query=${encodeURIComponent(q)}` +
    `&fmt=json&limit=${clamped}&offset=0&inc=artist-credits+releases`;

  const res = await rateLimitedFetch(url, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
  });
  if (!res.ok) {
    const err = new Error(`MusicBrainz search failed: HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  let json;
  try {
    json = await res.json();
  } catch (_) {
    throw new Error('MusicBrainz returned invalid response');
  }
  const recordings = json && Array.isArray(json.recordings) ? json.recordings : [];

  const results = recordings.map((rec) => {
    const releases = Array.isArray(rec.releases) ? rec.releases : [];
    const first = releases[0] || {};
    const albumTitle = typeof first.title === 'string' ? first.title : '';
    const date = typeof first.date === 'string' ? first.date : '';
    const year = /^\d{4}/.test(date) ? date.slice(0, 4) : '';
    const releaseId = typeof first.id === 'string' ? first.id : null;

    let artistName = '';
    if (Array.isArray(rec['artist-credit']) && rec['artist-credit'].length > 0) {
      artistName = rec['artist-credit']
        .map((c) => (c && (c.name || (c.artist && c.artist.name))) || '')
        .filter(Boolean)
        .join(', ');
    } else if (typeof rec.artist === 'string') {
      artistName = rec.artist;
    }

    return {
      recordingId: typeof rec.id === 'string' ? rec.id : '',
      title: typeof rec.title === 'string' ? rec.title : '',
      artist: artistName,
      album: albumTitle,
      date,
      year,
      releaseId,
      score: Number.isFinite(rec.score) ? rec.score : 0,
      coverUrl: releaseId ? `https://coverartarchive.org/release/${releaseId}/front-500` : null,
    };
  });

  cacheSet(searchCache, cacheKey, results, SEARCH_TTL_MS, SEARCH_MAX);
  return results;
}

/**
 * Fetch front cover for a MusicBrainz release id.
 * @returns {Promise<{found:boolean, data?:Buffer, contentType?:string}>}
 */
async function getCoverImage(releaseId) {
  if (typeof releaseId !== 'string' || !MBID_RE.test(releaseId)) {
    throw new Error('Invalid releaseId: must be a MusicBrainz MBID');
  }

  const cached = cacheGet(coverCache, releaseId);
  if (cached) return cached;

  const url = `https://coverartarchive.org/release/${releaseId}/front-500`;
  const res = await rateLimitedFetch(url, {
    headers: { 'User-Agent': USER_AGENT },
  });

  if (!res.ok) {
    // Only 404 is a definitive "no cover" worth caching. Transient 429/5xx
    // and client 400s must not poison the cache.
    if (res.status === 404) {
      const miss = { found: false };
      cacheSet(coverCache, releaseId, miss, COVER_MISS_TTL_MS, COVER_MAX);
      return miss;
    }
    const err = new Error(`Cover Art Archive request failed: HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }

  const headerGet = (name) => {
    try {
      if (res.headers && typeof res.headers.get === 'function') {
        return res.headers.get(name) || '';
      }
    } catch (_) {}
    return '';
  };
  const contentType = headerGet('content-type');
  const normalizedType = contentType.split(';')[0].trim().toLowerCase();
  const ALLOWED_COVER_TYPES = new Set([
    'image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/gif', 'image/bmp', 'image/avif',
  ]);
  if (!ALLOWED_COVER_TYPES.has(normalizedType)) {
    // A 200 with a non-image body is usually a transient upstream error page,
    // not a definitive miss — don't cache it.
    return { found: false };
  }

  const announced = headerGet('content-length');
  const announcedLen = announced !== '' ? Number(announced) : NaN;
  if (Number.isFinite(announcedLen) && announcedLen > COVER_MAX_BYTES) {
    // Don't leave the socket hanging for GC: best-effort consume/cancel.
    try {
      if (res.body && typeof res.body.cancel === 'function') {
        await res.body.cancel();
      } else {
        await res.arrayBuffer();
      }
    } catch (_) {}
    throw new Error('Cover image too large (>10MB)');
  }

  // Stream with an incremental cap so a lying/missing content-length can't
  // force a huge allocation before the size check.
  const buf = await readBodyCapped(res, COVER_MAX_BYTES);
  const hit = { found: true, data: buf, contentType: normalizedType };
  cacheSet(coverCache, releaseId, hit, COVER_TTL_MS, COVER_MAX);
  return hit;
}

function _clearCaches() {
  searchCache.clear();
  coverCache.clear();
}

function _resetRateLimit() {
  lastRequestTime = 0;
  pendingCount = 0;
  gate = Promise.resolve();
}

/**
 * Read a fetch body with an incremental byte cap (test-friendly: falls back
 * to arrayBuffer when streaming reader is unavailable, e.g. in unit mocks).
 * @returns {Promise<Buffer>}
 */
async function readBodyCapped(res, maxBytes) {
  if (!res.body || typeof res.body.getReader !== 'function') {
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > maxBytes) {
      throw new Error('Cover image too large (>10MB)');
    }
    return buf;
  }
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      total += chunk.length;
      if (total > maxBytes) {
        try { await reader.cancel(); } catch (_) {}
        throw new Error('Cover image too large (>10MB)');
      }
      chunks.push(chunk);
    }
  } finally {
    try { reader.releaseLock(); } catch (_) {}
  }
  return Buffer.concat(chunks, total);
}

module.exports = {
  MBID_RE,
  clampLimit,
  searchRecordings,
  getCoverImage,
  _clearCaches,
  _resetRateLimit,
};
