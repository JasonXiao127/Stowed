'use strict';

/**
 * Route-level tests for the MusicBrainz / duration / trim endpoints.
 * Mounts setupRoutes() on a standalone express app (no auth guards — those
 * live in index.js) with stubbed ./musicbrainz and ./trim modules, so no
 * network or ffmpeg is touched. Verifies validation + status-code mapping.
 *
 * Run with: node --test server/routes.test.js
 */

const path = require('path');
const os = require('os');
const fs = require('fs');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'stow-routes-test-'));
process.env.STOW_DOWNLOAD_DIR = TMP;
process.env.STOW_CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'stow-routes-cfg-'));

fs.writeFileSync(path.join(TMP, 'song.opus'), Buffer.from('fake-audio'));
fs.writeFileSync(path.join(TMP, 'song.mp3'), Buffer.from('fake-audio'));

// ---- Stub ./musicbrainz + ./trim BEFORE routes loads them -------------------
const MBID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MBID = '123e4567-e89b-12d3-a456-426614174000';

const mbHandlers = {
  searchRecordings: async () => [],
  getCoverImage: async () => ({ found: false }),
};
const mbStub = {
  MBID_RE,
  clampLimit: (v, fb = 5) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return fb;
    return Math.min(10, Math.max(1, Math.floor(n)));
  },
  // Delegate: routes.js destructures these at load, so tests mutate handlers.
  searchRecordings: (...args) => mbHandlers.searchRecordings(...args),
  getCoverImage: (...args) => mbHandlers.getCoverImage(...args),
};

const trimHandlers = {
  getDuration: async () => 100,
  trimAudio: async () => ({ path: 'x', start: 0, end: 5, duration: 100 }),
};
const trimStub = {
  getDuration: (...args) => trimHandlers.getDuration(...args),
  trimAudio: (...args) => trimHandlers.trimAudio(...args),
};

const mbPath = require.resolve('./musicbrainz');
require.cache[mbPath] = { id: mbPath, filename: mbPath, loaded: true, exports: mbStub };
const trimPath = require.resolve('./trim');
require.cache[trimPath] = { id: trimPath, filename: trimPath, loaded: true, exports: trimStub };

const express = require('express');
const { setupRoutes } = require('./routes');

const stubManager = {
  getQueue: () => [],
  addJobs: () => ({ added: 0 }),
  cancelAll: () => {},
  cancelJob: () => {},
  retryJob: () => null,
  removeJob: () => false,
};

let server;
let base;

before(async () => {
  const app = express();
  app.use(express.json());
  setupRoutes(app, stubManager);
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

async function get(p) {
  const res = await fetch(`${base}${p}`);
  let body = null;
  try { body = await res.json(); } catch (_) {}
  return { status: res.status, body, headers: res.headers };
}

async function postJson(p, obj) {
  const res = await fetch(`${base}${p}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(obj),
  });
  let body = null;
  try { body = await res.json(); } catch (_) {}
  return { status: res.status, body, headers: res.headers };
}

test('GET /api/mb/search requires at least one field', async () => {
  const r = await get('/api/mb/search');
  assert.equal(r.status, 400);
});

test('GET /api/mb/search rejects overlong fields', async () => {
  const r = await get(`/api/mb/search?title=${'x'.repeat(201)}`);
  assert.equal(r.status, 400);
});

test('GET /api/mb/search returns results', async () => {
  const r = await get('/api/mb/search?title=Song&limit=3');
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.body.results));
});

test('GET /api/mb/search maps upstream 429 with Retry-After', async () => {
  const origSearch = mbHandlers.searchRecordings;
  mbHandlers.searchRecordings = async () => {
    const err = new Error('MusicBrainz search failed: HTTP 429');
    err.status = 429;
    throw err;
  };
  try {
    const r = await get('/api/mb/search?title=Song');
    assert.equal(r.status, 429);
    assert.equal(r.headers.get('retry-after'), '1');
  } finally {
    mbHandlers.searchRecordings = origSearch;
  }
});

test('GET /api/mb/cover validates MBID', async () => {
  const r = await get('/api/mb/cover?releaseId=nope');
  assert.equal(r.status, 400);
});

test('GET /api/mb/cover returns 404 when unfound', async () => {
  const r = await get(`/api/mb/cover?releaseId=${MBID}`);
  assert.equal(r.status, 404);
});

test('POST /api/trim rejects non-JSON bodies', async () => {
  const res = await fetch(`${base}/api/trim`, { method: 'POST', body: 'x' });
  assert.equal(res.status, 415);
});

test('POST /api/trim rejects path traversal', async () => {
  const r = await postJson('/api/trim', { path: '../evil.opus', start: 0, end: 5 });
  assert.equal(r.status, 400);
});

test('POST /api/trim returns 404 for missing files', async () => {
  const r = await postJson('/api/trim', { path: 'nope.opus', start: 0, end: 5 });
  assert.equal(r.status, 404);
});

test('POST /api/trim rejects non-Opus audio with the Opus-only message', async () => {
  const origTrim = trimHandlers.trimAudio;
  trimHandlers.trimAudio = async () => {
    throw new Error('Invalid file type: trim currently supports Opus/Ogg only');
  };
  try {
    const r = await postJson('/api/trim', { path: 'song.mp3', start: 0, end: 5 });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /Opus\/Ogg only/);
  } finally {
    trimHandlers.trimAudio = origTrim;
  }
});

test('POST /api/trim maps busy/timeout/generic errors', async () => {
  const origTrim2 = trimHandlers.trimAudio;
  try {
    trimHandlers.trimAudio = async () => { throw new Error('Trim busy: wait'); };
    assert.equal((await postJson('/api/trim', { path: 'song.opus', start: 0, end: 5 })).status, 429);
    trimHandlers.trimAudio = async () => { throw new Error('Timed out trimming audio'); };
    assert.equal((await postJson('/api/trim', { path: 'song.opus', start: 0, end: 5 })).status, 504);
    trimHandlers.trimAudio = async () => { throw new Error('kaboom'); };
    const r = await postJson('/api/trim', { path: 'song.opus', start: 0, end: 5 });
    assert.equal(r.status, 500);
    assert.equal(r.body.error, 'Trim failed');
  } finally {
    trimHandlers.trimAudio = origTrim2;
  }
});

test('GET /api/duration rejects traversal and missing files', async () => {
  assert.equal((await get('/api/duration?path=../evil.opus')).status, 400);
  assert.equal((await get('/api/duration?path=nope.opus')).status, 404);
});

test('GET /api/duration returns duration', async () => {
  const r = await get('/api/duration?path=song.opus');
  assert.equal(r.status, 200);
  assert.equal(r.body.duration, 100);
});

test('GET /api/file forces attachment for non-audio files', async () => {
  // Serving user-controlled HTML/SVG inline would run script in the app's
  // origin (stored XSS with access to the API key); non-audio must download.
  fs.writeFileSync(path.join(TMP, 'evil.html'), '<script>alert(1)</script>');
  const html = await get('/api/file?path=evil.html');
  assert.equal(html.status, 200);
  assert.match(html.headers.get('content-disposition') || '', /attachment/);
  const audio = await get('/api/file?path=song.opus');
  assert.equal(audio.status, 200);
  assert.equal(audio.headers.get('content-disposition'), null);
});

test('GET /api/system exposes yt-dlp status and settings', async () => {
  const r = await get('/api/system');
  assert.equal(r.status, 200);
  assert.ok(r.body.ytdlp);
  assert.ok('version' in r.body.ytdlp);
  assert.ok(r.body.server);
  assert.ok(r.body.settings);
});

test('GET /api/settings and POST /api/settings round-trip', async () => {
  const g = await get('/api/settings');
  assert.equal(g.status, 200);
  const p = await postJson('/api/settings', { embedChapters: true, sponsorblock: 'remove:music_offtopic' });
  assert.equal(p.status, 200);
  assert.equal(p.body.embedChapters, true);
  // Invalid sponsorblock is rejected.
  const bad = await postJson('/api/settings', { sponsorblock: 'bogus' });
  assert.equal(bad.status, 400);
});

test('POST /api/inspect rejects blocked URLs', async () => {
  const r = await postJson('/api/inspect', { url: 'file:///etc/passwd' });
  assert.equal(r.status, 400);
});

test('GET /api/thumb rejects disallowed hosts', async () => {
  const r = await get('/api/thumb?url=https://example.com/a.jpg');
  assert.equal(r.status, 400);
});

test('GET /api/library lists audio with tags', async () => {
  const r = await get('/api/library?limit=10');
  assert.equal(r.status, 200);
  assert.ok(typeof r.body.total === 'number');
  assert.ok(Array.isArray(r.body.entries));
});

test('GET /api/library supports order and offset with Showing counts', async () => {
  const asc = await get('/api/library?sort=name&order=asc&limit=10&offset=0');
  assert.equal(asc.status, 200);
  assert.ok(typeof asc.body.total === 'number');
  assert.ok(typeof asc.body.offset === 'number');
  const desc = await get('/api/library?sort=name&order=desc&limit=1&offset=0');
  assert.equal(desc.status, 200);
  assert.ok(Array.isArray(desc.body.entries));
});

test('POST /api/queue/retry and DELETE /api/queue/:id handle missing jobs', async () => {
  assert.equal((await postJson('/api/queue/retry', { id: 'nope' })).status, 404);
  const del = await fetch(`${base}/api/queue/nope`, { method: 'DELETE' });
  assert.equal(del.status, 404);
});

test('POST /api/cancel/:id rejects missing (404) and non-active (409)', async () => {
  assert.equal((await postJson('/api/cancel/nope', {})).status, 404);
});

test('POST /api/queue/retry rejects non-Failed jobs with 409', async () => {
  const express2 = require('express');
  const { setupRoutes: setup2 } = require('./routes');
  const app2 = express2();
  app2.use(express2.json());
  const mgr = {
    getQueue: () => [{ id: 'j1', status: 'Complete' }],
    retryJob: () => 'inactive',
    removeJob: () => false,
    cancelAll: () => {},
    cancelJob: () => 'inactive',
    addJobs: () => ({ added: 0 }),
  };
  setup2(app2, mgr);
  const srv = await new Promise((resolve) => {
    const s = app2.listen(0, '127.0.0.1', () => resolve(s));
  });
  try {
    const port = srv.address().port;
    const res = await fetch(`http://127.0.0.1:${port}/api/queue/retry`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'j1' }),
    });
    assert.equal(res.status, 409);
    const cancelRes = await fetch(`http://127.0.0.1:${port}/api/cancel/j1`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    assert.equal(cancelRes.status, 409);
  } finally {
    await new Promise((resolve) => srv.close(resolve));
  }
});
