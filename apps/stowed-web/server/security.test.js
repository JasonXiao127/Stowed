'use strict';

/**
 * Unit tests for the security boundary: path confinement, API-key checks,
 * origin allow-listing, and cover-art validation.
 *
 * Run with:  node --test server/security.test.js
 *
 * Paths/config are isolated into a temp dir BEFORE loading ./security, because
 * security.js caches config at require time.
 */

const path = require('path');
const os = require('os');
const fs = require('fs');
const { test } = require('node:test');
const assert = require('node:assert/strict');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'stow-sec-test-'));
process.env.STOW_DOWNLOAD_DIR = path.join(TMP, 'downloads');
process.env.STOW_CONFIG_DIR = path.join(TMP, 'config');
fs.mkdirSync(process.env.STOW_DOWNLOAD_DIR, { recursive: true });
fs.mkdirSync(process.env.STOW_CONFIG_DIR, { recursive: true });

const {
  resolveDownloadPath,
  hasValidKey,
  isOriginAllowed,
} = require('./security');
const { validateCoverArt } = require('./metadata-read');

const DOWNLOADS = process.env.STOW_DOWNLOAD_DIR;

// ---- Path confinement ------------------------------------------------------

test('resolveDownloadPath accepts absolute and relative paths inside the dir', () => {
  const p = path.join(DOWNLOADS, 'a', 'b.opus');
  assert.equal(resolveDownloadPath(p), path.normalize(p));
  assert.equal(resolveDownloadPath('b.opus'), path.join(DOWNLOADS, 'b.opus'));
  assert.equal(resolveDownloadPath(DOWNLOADS), DOWNLOADS);
});

test('resolveDownloadPath rejects traversal and absolute escapes', () => {
  assert.throws(() => resolveDownloadPath(path.join(DOWNLOADS, '..', 'secret')), /outside/i);
  assert.throws(() => resolveDownloadPath('..'), /outside/i);
  assert.throws(() => resolveDownloadPath('../../etc/passwd'), /outside/i);
  assert.throws(() => resolveDownloadPath('/etc/passwd'), /outside/i);
});

test('resolveDownloadPath rejects null bytes and non-string inputs', () => {
  assert.throws(() => resolveDownloadPath('a\0b'), /null byte/i);
  assert.throws(() => resolveDownloadPath(''), /Missing file path/);
  assert.throws(() => resolveDownloadPath(null), /Missing file path/);
  assert.throws(() => resolveDownloadPath(123), /Missing file path/);
});

test('resolveDownloadPath rejects a symlink that resolves outside the dir', () => {
  const outside = path.join(TMP, 'outside.txt');
  fs.writeFileSync(outside, 'secret');
  const link = path.join(DOWNLOADS, 'link.opus');
  let created = true;
  try { fs.symlinkSync(outside, link); } catch (_) { created = false; } // e.g. no dev-mode on Windows
  if (!created) return; // skip when we cannot create symlinks
  assert.throws(() => resolveDownloadPath(link), /outside/i);
});

// ---- API key ---------------------------------------------------------------

test('hasValidKey accepts header / query / bearer and rejects wrong', () => {
  const config = require('./config');
  const prev = config.apiKey;
  config.apiKey = 'sekret';
  try {
    assert.equal(hasValidKey({ headers: { 'x-api-key': 'sekret' }, query: {} }), true);
    assert.equal(hasValidKey({ headers: {}, query: { apikey: 'sekret' } }), true);
    assert.equal(hasValidKey({ headers: { authorization: 'Bearer sekret' }, query: {} }), true);
    assert.equal(hasValidKey({ headers: { 'x-api-key': 'wrong' }, query: {} }), false);
    assert.equal(hasValidKey({ headers: {}, query: {} }), false);
  } finally {
    config.apiKey = prev;
  }
});

// ---- Origin gating ---------------------------------------------------------

test('isOriginAllowed permits same-origin / localhost / IPv6 loopback and blocks foreign origins', () => {
  assert.equal(isOriginAllowed({ headers: {} }), true); // no Origin header
  assert.equal(
    isOriginAllowed({ headers: { origin: 'http://localhost:5183', host: 'localhost:5183' } }),
    true
  );
  assert.equal(
    isOriginAllowed({ headers: { origin: 'http://127.0.0.1:9', host: 'anything:1' } }),
    true
  );
  assert.equal(
    isOriginAllowed({ headers: { origin: 'http://[::1]:5183', host: '[::1]:5183' } }),
    true
  );
  assert.equal(
    isOriginAllowed({ headers: { origin: 'http://evil.com', host: 'good:5183' } }),
    false
  );
});

// ---- Cover-art validation --------------------------------------------------

test('validateCoverArt accepts a plausible JPEG and rejects tiny/truncated data', () => {
  const jpeg = Buffer.concat([
    Buffer.from([0xff, 0xd8]), // SOI
    Buffer.from([0xff, 0xda]), // SOS
    Buffer.alloc(150, 1),
    Buffer.from([0xff, 0xd9]), // EOI
  ]);
  const v = validateCoverArt(jpeg, 'image/jpeg');
  assert.equal(v.valid, true);
  assert.equal(v.format, 'image/jpeg');

  // Truncated / tiny data must be rejected.
  const trunc = Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.from([0xff, 0xda]), Buffer.alloc(50)]);
  assert.equal(validateCoverArt(trunc, 'image/jpeg').valid, false);

  // Random bytes: unknown format is accepted with a warning (current contract).
  const garbage = Buffer.alloc(200, 0x41);
  const r = validateCoverArt(garbage, 'image/jpeg');
  assert.equal(r.valid, true);
  assert.ok(r.reason);
  assert.equal(validateCoverArt(Buffer.alloc(0), 'image/jpeg').valid, false);
});

// ---- Host-header allowlist (DNS-rebinding defense) --------------------------

test('isHostAllowed accepts loopback and bare IP literals, rejects unknown hostnames', () => {
  const { isHostAllowed } = require('./security');
  assert.equal(isHostAllowed({ headers: { host: 'localhost:5183' } }), true);
  assert.equal(isHostAllowed({ headers: { host: '127.0.0.1:5183' } }), true);
  assert.equal(isHostAllowed({ headers: { host: '[::1]:5183' } }), true);
  assert.equal(isHostAllowed({ headers: { host: '192.168.1.50:5183' } }), true); // LAN IP literal
  // DNS-rebinding: the attacker's own domain lands in the Host header.
  assert.equal(isHostAllowed({ headers: { host: 'attacker.example:5183' } }), false);
  assert.equal(isHostAllowed({ headers: {} }), false); // missing Host -> fail closed
});

test('isHostAllowed honors STOW_ALLOWED_HOSTS entries (with and without port)', () => {
  const { isHostAllowed } = require('./security');
  const config = require('./config');
  const prev = config.allowedHosts;
  config.allowedHosts = ['media-pc:5183', 'stow.local'];
  try {
    assert.equal(isHostAllowed({ headers: { host: 'media-pc:5183' } }), true);
    assert.equal(isHostAllowed({ headers: { host: 'stow.local' } }), true);
    assert.equal(isHostAllowed({ headers: { host: 'other.example:5183' } }), false);
  } finally {
    config.allowedHosts = prev;
  }
});

// ---- Download-URL validation (SSRF guard) -----------------------------------

test('validateDownloadUrl blocks non-http schemes and private/loopback literal targets', () => {
  const { validateDownloadUrl } = require('./security');
  assert.equal(validateDownloadUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ'), null);
  assert.equal(validateDownloadUrl('http://example.com/file.mp4'), null);
  assert.equal(validateDownloadUrl('dQw4w9WgXcQ'), null);           // bare ID
  assert.equal(validateDownloadUrl('ytsearch:never gonna give you up'), null);

  assert.match(validateDownloadUrl('file:///etc/passwd') || '', /unsupported protocol/);
  assert.match(validateDownloadUrl('ftp://example.com/x') || '', /unsupported protocol/);
  assert.match(validateDownloadUrl('http://127.0.0.1/admin') || '', /private/);
  assert.match(validateDownloadUrl('http://10.0.0.5/x') || '', /private/);
  assert.match(validateDownloadUrl('http://172.16.0.1/x') || '', /private/);
  assert.match(validateDownloadUrl('http://192.168.1.50/x') || '', /private/);
  assert.match(validateDownloadUrl('http://169.254.169.254/latest/meta-data/') || '', /private/);
  assert.match(validateDownloadUrl('http://[::1]/x') || '', /private/);
  assert.match(validateDownloadUrl('http://2130706433/') || '', /private/); // 127.0.0.1 as int
  assert.match(validateDownloadUrl('http://localhost/') || '', /private/);
});

test('validateDownloadUrl honors the STOW_ALLOW_PRIVATE_IP_URLS opt-out', () => {
  const { validateDownloadUrl } = require('./security');
  const config = require('./config');
  const prev = config.allowPrivateIpUrls;
  config.allowPrivateIpUrls = true;
  try {
    assert.equal(validateDownloadUrl('http://127.0.0.1:8000/stream'), null);
    assert.equal(validateDownloadUrl('http://192.168.1.50/media/'), null);
  } finally {
    config.allowPrivateIpUrls = prev;
  }
});

// ---- Rate limiters ----------------------------------------------------------

test('createRateLimiter allows max requests then blocks within the window', () => {
  const { createRateLimiter } = require('./security');
  const limiter = createRateLimiter({ windowMs: 60_000, max: 2 });
  const req = () => ({ ip: '10.0.0.1' });
  assert.equal(limiter(req()).allowed, true);
  assert.equal(limiter(req()).allowed, true);
  const third = limiter(req());
  assert.equal(third.allowed, false);
  assert.ok(third.retryAfter > 0);
});

test('authFailureLimiter blocks after max failed attempts', () => {
  const { createFailureLimiter } = require('./security');
  const limiter = createFailureLimiter({ windowMs: 60_000, max: 3 });
  const req = () => ({ ip: '10.0.0.2' });
  assert.equal(limiter(req()).blocked, false);
  assert.equal(limiter(req()).blocked, false);
  assert.equal(limiter(req()).blocked, false);
  assert.equal(limiter(req()).blocked, true);
});
// ---- CSP: strict in production, relaxed only for the Vite dev server ---------

test('CSP is strict in production and relaxed for Vite only in dev', () => {
  const { securityHeaders } = require('./security');
  const config = require('./config');
  const prevDev = config.isDev;
  const prevUrl = process.env.VITE_DEV_URL;
  const headerOf = () => {
    const out = {};
    const res = { status() { return this; }, json() {}, set(k, v) { out[k] = v; } };
    securityHeaders({ headers: {} }, res, () => {});
    return out['Content-Security-Policy'];
  };
  try {
    config.isDev = false;
    delete process.env.VITE_DEV_URL;
    const prod = headerOf();
    const prodScriptSrc = /script-src [^;]*/.exec(prod)[0];
    assert.equal(
      prodScriptSrc.includes('unsafe-inline'),
      false,
      'prod CSP must not allow inline scripts'
    );
    assert.match(prod, /connect-src 'self';/);
    assert.doesNotMatch(prod, /ws:\/\//);

    config.isDev = true;
    const dev = headerOf();
    assert.ok(dev.includes("script-src 'self' 'unsafe-inline'"), 'dev CSP allows Vite inline bootstrap');
    assert.match(dev, /connect-src 'self' ws:\/\/localhost:5173 wss:\/\/localhost:5173/);

    process.env.VITE_DEV_URL = 'http://vite.local:5999';
    assert.match(headerOf(), /ws:\/\/vite.local:5999/);
  } finally {
    config.isDev = prevDev;
    if (prevUrl === undefined) delete process.env.VITE_DEV_URL;
    else process.env.VITE_DEV_URL = prevUrl;
  }
});

