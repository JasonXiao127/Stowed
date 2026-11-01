'use strict';

/**
 * Offline unit tests for ./musicbrainz (global.fetch stubbed, no network).
 * Run with: node --test server/musicbrainz.test.js
 */

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const mb = require('./musicbrainz');

let fetchCalls;
let fetchHandler;

beforeEach(() => {
  mb._clearCaches();
  mb._resetRateLimit();
  fetchCalls = [];
  global.fetch = async (url, options) => {
    fetchCalls.push({ url, options });
    return fetchHandler(url, options);
  };
});

function jsonResponse(obj, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => 'application/json' },
    json: async () => obj,
    arrayBuffer: async () => Buffer.from(JSON.stringify(obj)).buffer,
  };
}

function imageResponse(bytes, contentType = 'image/jpeg', status = 200) {
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k) => (String(k).toLowerCase() === 'content-type' ? contentType : null) },
    json: async () => ({}),
    arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
  };
}

const MBID = '123e4567-e89b-12d3-a456-426614174000';

test('searchRecordings throws when all query fields are empty', async () => {
  await assert.rejects(() => mb.searchRecordings({ title: '', artist: '', album: '' }), /at least one/i);
  assert.equal(fetchCalls.length, 0);
});

test('searchRecordings builds Lucene query, parses results, sets coverUrl', async () => {
  fetchHandler = async () => jsonResponse({
    recordings: [
      {
        id: 'rec-1',
        title: 'Song',
        score: 99,
        'artist-credit': [{ name: 'Artist A' }, { name: 'Artist B' }],
        releases: [{ id: MBID, title: 'Album X', date: '2020-05-01' }],
      },
      {
        id: 'rec-2',
        title: 'Other',
        score: 50,
        'artist-credit': [],
        releases: [],
      },
    ],
  });

  const results = await mb.searchRecordings({ title: 'Song', artist: 'Artist', limit: 5 });
  assert.equal(fetchCalls.length, 1);
  const { url, options } = fetchCalls[0];
  assert.match(url, /musicbrainz\.org\/ws\/2\/recording\//);
  assert.match(url, /fmt=json/);
  assert.match(url, /limit=5/);
  assert.ok(options.headers['User-Agent'].startsWith('Stowed/1.0.0'));
  assert.equal(options.headers.Accept, 'application/json');

  assert.equal(results.length, 2);
  assert.equal(results[0].recordingId, 'rec-1');
  assert.equal(results[0].artist, 'Artist A, Artist B');
  assert.equal(results[0].album, 'Album X');
  assert.equal(results[0].date, '2020-05-01');
  assert.equal(results[0].year, '2020');
  assert.equal(results[0].releaseId, MBID);
  assert.equal(results[0].coverUrl, `https://coverartarchive.org/release/${MBID}/front-500`);
  assert.equal(results[1].releaseId, null);
  assert.equal(results[1].coverUrl, null);
  assert.equal(results[1].date, '');
  assert.equal(results[1].year, '');
});

test('searchRecordings caches results (second call hits cache)', async () => {
  let n = 0;
  fetchHandler = async () => { n++; return jsonResponse({ recordings: [] }); };
  await mb.searchRecordings({ title: 'Cached' });
  await mb.searchRecordings({ title: 'Cached' });
  assert.equal(n, 1);
});

test('searchRecordings escapes double quotes in query', async () => {
  fetchHandler = async () => jsonResponse({ recordings: [] });
  await mb.searchRecordings({ title: 'Say "hi"' });
  // The encoded query must contain an escaped quote (\") before encoding.
  assert.match(fetchCalls[0].url, /query=/);
  assert.ok(fetchCalls[0].url.includes(encodeURIComponent('\\"')));
});

test('getCoverImage rejects invalid MBID without fetching', async () => {
  let called = false;
  fetchHandler = async () => { called = true; return imageResponse([1, 2, 3]); };
  await assert.rejects(() => mb.getCoverImage('not-a-mbid'), /Invalid releaseId/);
  assert.equal(called, false);
});

test('getCoverImage returns found:false on 404 and caches it', async () => {
  let n = 0;
  fetchHandler = async () => { n++; return { ok: false, status: 404, headers: { get: () => null } }; };
  const r1 = await mb.getCoverImage(MBID);
  const r2 = await mb.getCoverImage(MBID);
  assert.deepEqual(r1, { found: false });
  assert.deepEqual(r2, { found: false });
  assert.equal(n, 1);
});

test('getCoverImage returns Buffer on image content-type, rejects non-image', async () => {
  fetchHandler = async () => imageResponse(Buffer.from([1, 2, 3, 4]), 'image/jpeg');
  const hit = await mb.getCoverImage(MBID);
  assert.equal(hit.found, true);
  assert.ok(Buffer.isBuffer(hit.data));
  assert.equal(hit.contentType, 'image/jpeg');

  mb._clearCaches();
  mb._resetRateLimit();
  fetchHandler = async () => imageResponse(Buffer.from('nope'), 'text/html');
  const miss = await mb.getCoverImage(MBID);
  assert.deepEqual(miss, { found: false });
});

test('getCoverImage does not cache transient errors (503 retries fetch)', async () => {
  let n = 0;
  fetchHandler = async () => { n++; return { ok: false, status: 503, headers: { get: () => null } }; };
  await assert.rejects(() => mb.getCoverImage(MBID), /HTTP 503/);
  await assert.rejects(() => mb.getCoverImage(MBID), /HTTP 503/);
  assert.equal(n, 2);
});

test('getCoverImage accepts image/jpg alias', async () => {
  fetchHandler = async () => imageResponse(Buffer.from([1, 2]), 'image/jpg');
  const hit = await mb.getCoverImage(MBID);
  assert.equal(hit.found, true);
  assert.equal(hit.contentType, 'image/jpg');
});
