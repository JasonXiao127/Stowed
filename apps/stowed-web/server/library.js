const fs = require('fs');
const path = require('path');
const config = require('./config');
const { isAudioFile } = require('./security');

let musicMetadata = null;
try {
  musicMetadata = require('music-metadata');
} catch (_) {}

/** In-memory tag cache keyed by path+mtime (avoids re-parsing on every poll). */
const tagCache = new Map();
const TAG_CACHE_MAX = 500;

function cacheGet(filePath, mtimeMs) {
  const e = tagCache.get(filePath);
  if (!e || e.mtimeMs !== mtimeMs) return null;
  return e.value;
}

function cacheSet(filePath, mtimeMs, value) {
  if (tagCache.size >= TAG_CACHE_MAX) {
    const oldest = tagCache.keys().next().value;
    tagCache.delete(oldest);
  }
  tagCache.set(filePath, { mtimeMs, value });
}

async function readEntryTags(filePath) {
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch (_) {
    return null;
  }
  const hit = cacheGet(filePath, stat.mtimeMs);
  if (hit) return hit;
  let out = { title: '', artist: '', album: '', track: '', genre: '', year: '', duration: null, hasCover: false };
  try {
    if (musicMetadata) {
      const meta = await musicMetadata.parseFile(filePath, { duration: true });
      const common = meta.common || {};
      out = {
        title: common.title || '',
        artist: common.artist || '',
        album: common.album || '',
        track: common.track && common.track.no ? String(common.track.no) : '',
        genre: (common.genre && common.genre[0]) || '',
        year: common.year ? String(common.year) : (common.date || ''),
        duration: meta.format && Number.isFinite(meta.format.duration) ? meta.format.duration : null,
        hasCover: Boolean(common.picture && common.picture.length),
      };
    }
  } catch (_) {
    // Corrupt/partial files return empty tags rather than failing the batch.
  }
  cacheSet(filePath, stat.mtimeMs, out);
  return out;
}

function walkAudioFiles(rootDir, { maxDepth = 3, maxFiles = 2000 } = {}) {
  const results = [];
  const walk = (dir, depth) => {
    if (results.length >= maxFiles) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (_) {
      return;
    }
    for (const d of entries) {
      if (results.length >= maxFiles) break;
      // Skip hidden dirs and temp/partial artifacts.
      if (d.name.startsWith('.')) continue;
      if (d.name.includes('_trim_') || d.name.includes('_temp_')) continue;
      if (d.name.endsWith('.part') || d.name.endsWith('.tmp')) continue;
      const full = path.join(dir, d.name);
      if (d.isDirectory()) {
        if (depth < maxDepth) walk(full, depth + 1);
      } else if (d.isFile() && isAudioFile(full)) {
        results.push(full);
      }
    }
  };
  walk(rootDir, 0);
  return results;
}

module.exports = { readEntryTags, walkAudioFiles, tagCache };
