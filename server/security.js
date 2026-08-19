const path = require('path');
const fs = require('fs');
const net = require('net');
const { timingSafeEqual } = require('crypto');
const config = require('./config');

/**
 * Security middleware and helpers for the Stow web server.
 *
 * The desktop app relied on native file dialogs, which meant a user could only
 * ever open/delete files on their own machine. In the web version any LAN
 * client can call the HTTP API, so every path that reaches the filesystem is
 * confined to the configured download directory, and cross-origin requests are
 * rejected to blunt DNS-rebinding / drive-by CSRF attacks.
 */

const AUDIO_EXTENSIONS = new Set([
  '.opus', '.ogg', '.mp3', '.m4a', '.flac', '.wav', '.webm', '.aac',
]);

function isAudioFile(filePath) {
  return AUDIO_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

/**
 * Resolve an arbitrary user-supplied path to a real path that is guaranteed to
 * live inside the configured download directory. Throws on any attempt to
 * escape it (absolute paths elsewhere, `..`, symlink/hardlink tricks).
 *
 * @param {string} input - Absolute path or path relative to the download dir.
 * @returns {string} canonical absolute path inside the download dir.
 */
function resolveDownloadPath(input) {
  if (!input || typeof input !== 'string') {
    throw new Error('Missing file path');
  }
  if (input.includes('\0')) {
    throw new Error('Invalid file path (null byte)');
  }

  const downloadDir = config.downloadDir;
  // Base the real-path comparison on the canonical download dir, so a
  // downloadDir that is itself a symlink (macOS /tmp, host junctions) does not
  // make every existing file look like an escape.
  let downloadDirReal;
  try {
    downloadDirReal = fs.realpathSync(downloadDir);
  } catch (_) {
    downloadDirReal = downloadDir;
  }

  const resolved = path.isAbsolute(input)
    ? path.normalize(input)
    : path.resolve(downloadDir, input);

  const rel = path.relative(downloadDir, resolved);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error('Path is outside the downloads directory');
  }

  // For existing files, ensure real (symlink-resolved) location is still
  // inside the download dir.
  if (fs.existsSync(resolved)) {
    let real;
    try {
      real = fs.realpathSync(resolved);
    } catch (_) {
      throw new Error('Could not resolve file path');
    }
    const realRel = path.relative(downloadDirReal, real);
    if (realRel.startsWith('..') || path.isAbsolute(realRel)) {
      throw new Error('Path resolves outside the downloads directory');
    }
  }

  return resolved;
}

/**
 * True if the given request is from an allowed origin. Same-origin requests
 * (no Origin header) and localhost are always permitted; anything else must be
 * explicitly allow-listed.
 */
function isOriginAllowed(req) {
  const origin = req.headers.origin;
  if (!origin) return true; // same-origin / non-browser client

  let host;
  let hostname;
  try {
    const parsed = new URL(origin);
    host = parsed.host;         // e.g. "machine:5183" or "[::1]:5183"
    hostname = parsed.hostname; // e.g. "machine" or "[::1]" (IPv6 keeps brackets)
  } catch (_) {
    return false;
  }

  // Loopback (incl. IPv6) origins are always allowed.
  const localhosts = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
  if (localhosts.has(hostname)) return true;

  const self = req.headers.host;
  if (host === self) return true;

  return config.allowedOrigins.includes(host);
}

/** Express middleware: enforce the origin policy on HTTP requests. */
function originGuard(req, res, next) {
  if (!isOriginAllowed(req)) {
    res.status(403).json({ error: 'Cross-origin request blocked' });
    return;
  }
  next();
}

/**
 * Check the optional shared secret on an HTTP request. Accepts the secret via
 * `?apikey=` query param, `X-API-Key` header, or `Authorization: Bearer`.
 */
function hasValidKey(req) {
  if (!config.apiKey) return true; // auth disabled

  const fromQuery = req.query && typeof req.query.apikey === 'string' ? req.query.apikey : '';
  const fromHeader = typeof req.headers['x-api-key'] === 'string' ? req.headers['x-api-key'] : '';
  const auth = typeof req.headers.authorization === 'string' ? req.headers.authorization : '';
  const fromBearer = auth.startsWith('Bearer ')
    ? auth.slice('Bearer '.length).trim()
    : '';

  const supplied = fromQuery || fromHeader || fromBearer;
  if (typeof supplied !== 'string' || supplied.length === 0 || supplied.length !== config.apiKey.length) {
    return false;
  }
  // Constant-time comparison so the shared secret is not measurable via timing.
  return timingSafeEqual(Buffer.from(supplied), Buffer.from(config.apiKey));
}

/** Express middleware: gate /api routes and the WS handshake when enabled. */
function apiKeyGuard(req, res, next) {
  if (!hasValidKey(req)) {
    const attempt = authFailureLimiter(req);
    if (attempt.blocked) {
      res.set('Retry-After', String(attempt.retryAfter));
      res.status(429).json({ error: 'Too many failed attempts, try again later' });
      return;
    }
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  next();
}

/** Express middleware: minimal hardening headers on every response. */
function securityHeaders(req, res, next) {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('X-Frame-Options', 'DENY');
  res.set('Referrer-Policy', 'same-origin');
  // Production/proxy CSP. dev adds only what Vite itself needs (see below).
  let csp =
    "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; " +
    "script-src 'self'; connect-src 'self'; object-src 'none'; " +
    "frame-ancestors 'none'; base-uri 'self'";

  // In dev, the renderer is proxied from the Vite dev server, whose HMR client
  // connects to its OWN WebSocket (different port) and whose React plugin
  // injects an inline bootstrap script. Relax only for development so
  // hot-reload works; the Docker/production build keeps the strict CSP above.
  if (config.isDev) {
    let devHost = 'localhost:5173';
    try {
      devHost = new URL(process.env.VITE_DEV_URL || 'http://localhost:5173').host;
    } catch (_) { /* keep the default */ }
    csp = csp
      .replace("script-src 'self'", "script-src 'self' 'unsafe-inline'")
      .replace(
        "connect-src 'self'",
        `connect-src 'self' ws://${devHost} wss://${devHost}`
      );
  }

  res.set('Content-Security-Policy', csp);
  next();
}

/** Require JSON bodies on mutating endpoints (defeats form-based CSRF). */
function requireJson(req, res, next) {
  const ct = req.headers['content-type'] || '';
  if (!ct.toLowerCase().includes('application/json')) {
    res.status(415).json({ error: 'Content-Type must be application/json' });
    return;
  }
  next();
}
/**
 * True if the request's Host header names this server. Loopback hosts and bare
 * IP literals are always accepted; hostnames must be explicitly allow-listed
 * via STOW_ALLOWED_HOSTS ("host" or "host:port").
 *
 * This is the check that actually stops DNS rebinding: a rebinding attack
 * presents the attacker's own domain in the Host header (the browser resolved
 * it to our IP), which can never be loopback, an IP literal, or an allowed
 * name unless the operator explicitly added it.
 */
function isHostAllowed(req) {
  const host = req.headers.host;
  if (typeof host !== 'string' || host.length === 0) return false;

  const hostname = host.startsWith('[')
    ? host.slice(0, host.indexOf(']') + 1)
    : host.split(':')[0];

  const loopbacks = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
  if (loopbacks.has(hostname)) return true;

  // Bare IP literals are fine: DNS rebinding requires a domain name, and a
  // page served from an IP that can already reach us is a same-host situation.
  if (net.isIP(hostname.replace(/^\[|\]$/g, '')) > 0) return true;

  return config.allowedHosts.some(
    (allowed) => allowed === host || allowed === hostname
  );
}

/** Express middleware: reject requests whose Host header is not allowed. */
function hostGuard(req, res, next) {
  if (!isHostAllowed(req)) {
    res.status(403).json({ error: 'Request host not allowed' });
    return;
  }
  next();
}

/**
 * Validate a download URL before it is handed to yt-dlp.
 *
 * Stow is a downloader, so it inherently fetches arbitrary URLs (SSRF). We
 * shrink that surface by (a) only allowing http(s) for anything that looks
 * like a URL, and (b) rejecting literal loopback/private/link-local/reserved
 * IP targets (cloud metadata, routers, other LAN hosts) unless the operator
 * opts out with STOW_ALLOW_PRIVATE_IP_URLS=1.
 *
 * Scheme-less strings (bare YouTube IDs, "ytsearch:...") pass through — yt-dlp
 * can only interpret those as YouTube lookups, so they create no fetch target.
 *
 * NOTE: hostnames that merely *resolve* to private addresses are not blocked
 * here (yt-dlp performs its own DNS lookup; resolving at request time would be
 * a TOCTOU and add latency). Keep the container on a restricted network.
 */
function validateDownloadUrl(input) {
  if (typeof input !== 'string') return 'must be a string';
  const s = input.trim();
  if (s.length === 0) return 'empty';

  if (!s.includes('://')) return null; // bare ID / search query

  let parsed;
  try {
    parsed = new URL(s);
  } catch (_) {
    return 'malformed URL';
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return `unsupported protocol "${parsed.protocol.replace(/:$/, '')}" (only http/https URLs are allowed)`;
  }

  if (!config.allowPrivateIpUrls) {
    const hostname = parsed.hostname.replace(/^\[|\]$/g, '');
    if (hostname.toLowerCase() === 'localhost' || isPrivateIpLiteral(hostname)) {
      return `target "${parsed.host}" is a local/private/reserved address`;
    }
  }

  return null;
}

/**
 * True if the string is an IP literal (v4 or v6) in a private, loopback,
 * link-local, CGNAT, multicast, or reserved range — the classic SSRF targets.
 */
function isPrivateIpLiteral(hostname) {
  // Unwrap IPv4-mapped IPv6 (e.g. ::ffff:127.0.0.1) to the v4 check.
  let h = hostname.toLowerCase();
  if (h.startsWith('::ffff:0:')) h = h.slice(9);
  else if (h.startsWith('::ffff:')) h = h.slice(7);

  const kind = net.isIP(h);
  if (kind === 4) return isPrivateIPv4(h.split('.').map(Number));
  if (kind === 6) return isPrivateIPv6(h);

  // Integer-form IPv4 addresses (e.g. http://2130706433/ == 127.0.0.1).
  if (/^\d+$/.test(h)) {
    const n = Number(h);
    if (Number.isSafeInteger(n) && n >= 0 && n <= 0xffffffff) {
      return isPrivateIPv4([
        (n >>> 24) & 0xff,
        (n >>> 16) & 0xff,
        (n >>> 8) & 0xff,
        n & 0xff,
      ]);
    }
  }
  return false;
}

function isPrivateIPv4(o) {
  const [a, b] = o;
  return (
    a === 10 ||                                        // 10.0.0.0/8
    (a === 172 && b >= 16 && b <= 31) ||               // 172.16.0.0/12
    (a === 192 && b === 168) ||                        // 192.168.0.0/16
    a === 127 ||                                       // loopback
    (a === 169 && b === 254) ||                        // link-local / cloud metadata
    (a === 100 && b >= 64 && b <= 127) ||              // CGNAT 100.64.0.0/10
    a === 0 ||                                         // 0.0.0.0/8
    a >= 224                                           // multicast + reserved
  );
}

function isPrivateIPv6(addr) {
  const lower = addr.toLowerCase();
  return (
    lower === '::' ||                                   // unspecified
    lower === '::1' ||                                  // loopback
    lower.startsWith('fe8') ||                          // fe80::/10 link-local
    lower.startsWith('fe9') ||
    lower.startsWith('fea') ||
    lower.startsWith('feb') ||
    lower.startsWith('fc') ||                           // fc00::/7 ULA
    lower.startsWith('fd') ||
    lower.startsWith('ff') ||                           // multicast
    lower.startsWith('2001:db8')                        // documentation
  );
}


// ---- Minimal in-process sliding-window rate limiters ------------------------
// No external dependency (keeps the supply chain small). Because Docker NATs
// all LAN clients to the bridge gateway IP, these act as LAN-wide sanity caps
// rather than per-user limits; the queue/URL caps in routes.js are the
// per-attacker control.

function clientKey(req) {
  return (
    (req && (req.ip || (req.socket && req.socket.remoteAddress))) || 'unknown'
  );
}

function createRateLimiter({ windowMs = 60_000, max = 60 } = {}) {
  const hits = new Map();
  const prune = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of hits) {
      if (now - entry.resetAt > windowMs) hits.delete(key);
    }
  }, Math.max(windowMs, 1000));
  if (prune.unref) prune.unref();

  function check(req) {
    const now = Date.now();
    const key = clientKey(req);
    const entry = hits.get(key);
    if (!entry || now - entry.resetAt >= windowMs) {
      hits.set(key, { count: 1, resetAt: now + windowMs });
      return { allowed: true, retryAfter: 0 };
    }
    entry.count += 1;
    if (entry.count > max) {
      return { allowed: false, retryAfter: Math.ceil((entry.resetAt - now) / 1000) };
    }
    return { allowed: true, retryAfter: 0 };
  }
  check._hits = hits; // for tests / introspection
  return check;
}

/** Wrap a limiter as Express middleware. */
function rateLimitMiddleware(limiter, message = 'Too many requests, please slow down') {
  return (req, res, next) => {
    const r = limiter(req);
    if (!r.allowed) {
      res.set('Retry-After', String(r.retryAfter));
      res.status(429).json({ error: message });
      return;
    }
    next();
  };
}

/** Failure-counter limiter: `blocked: true` once `max` failures are reached. */
function createFailureLimiter({ windowMs = 60_000, max = 8 } = {}) {
  const fails = new Map();
  const prune = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of fails) {
      if (now - entry.resetAt > windowMs) fails.delete(key);
    }
  }, Math.max(windowMs, 1000));
  if (prune.unref) prune.unref();

  return function record(req) {
    const now = Date.now();
    const key = clientKey(req);
    const entry = fails.get(key);
    if (!entry || now - entry.resetAt >= windowMs) {
      fails.set(key, { count: 1, resetAt: now + windowMs });
      return { blocked: false, retryAfter: 0 };
    }
    entry.count += 1;
    if (entry.count > max) {
      return { blocked: true, retryAfter: Math.ceil((entry.resetAt - now) / 1000) };
    }
    return { blocked: false, retryAfter: 0 };
  };
}

// Instance limits, exported so middleware can mount them.
const apiRateLimit = createRateLimiter({ windowMs: 60_000, max: 240 });
const mutatingRateLimit = createRateLimiter({ windowMs: 60_000, max: 40 });
const authFailureLimiter = createFailureLimiter({ windowMs: 60_000, max: 8 });



module.exports = {
  AUDIO_EXTENSIONS,
  isAudioFile,
  resolveDownloadPath,
  isOriginAllowed,
  originGuard,
  isHostAllowed,
  hostGuard,
  validateDownloadUrl,
  hasValidKey,
  apiKeyGuard,
  securityHeaders,
  requireJson,
  createRateLimiter,
  createFailureLimiter,
  rateLimitMiddleware,
  apiRateLimit,
  mutatingRateLimit,
  authFailureLimiter,
};
