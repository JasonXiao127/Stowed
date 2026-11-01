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
  '.opus', '.ogg', '.oga', '.mp3', '.m4a', '.flac', '.wav', '.webm', '.aac',
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
 * like a URL (including http(s) targets written without "//", which URL
 * parsers and yt-dlp still treat as fetch targets), and (b) rejecting literal
 * loopback/private/link-local/reserved IP targets (cloud metadata, routers,
 * other LAN hosts) unless the operator opts out with STOW_ALLOW_PRIVATE_IP_URLS=1.
 * IPv6 transition forms (mapped/translated/compatible/NAT64/6to4/Teredo)
 * carrying a private IPv4 address are rejected via byte-level classification.
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

  // Anything without "://" is a bare ID / search query — except http(s) URLs
  // written without slashes (e.g. "http:169.254.169.254"), which WHATWG URL
  // parsing (and yt-dlp) still treat as real fetch targets. Any other
  // "scheme:" prefix (file:, ftp:, javascript:, data:, ...) must also be
  // validated so it cannot bypass the http(s)-only check. Known yt-dlp
  // search prefixes (ytsearch10:, ytmusicsearch:, scsearch:, ...) remain
  // pass-through since yt-dlp resolves them to YouTube lookups.
  const schemeMatch = s.match(/^([a-zA-Z][a-zA-Z0-9+.-]*):/);
  if (schemeMatch && !s.includes('://')) {
    const scheme = schemeMatch[1].toLowerCase();
    if (/^(ytsearch|ytmusicsearch|scsearch|soundcloudsearch|bandcampsearch)[a-z0-9]*$/.test(scheme)) return null;
    if (!/^https?$/.test(scheme)) {
      // Fall through to URL validation below, which rejects non-http(s).
    } else {
      // http: without "//" — fall through to validation (private-IP check applies).
    }
  } else if (!s.includes('://')) {
    return null;
  }

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
    let hostname = parsed.hostname.replace(/^\[|\]$/g, '');
    // A trailing dot ("localhost.") does not change the target.
    if (!hostname.includes(':')) hostname = hostname.replace(/\.+$/, '');
    if (hostname.toLowerCase() === 'localhost' || isPrivateIpLiteral(hostname)) {
      return `target "${parsed.host}" is a local/private/reserved address`;
    }
  }

  return null;
}

/**
 * True if the string is an IP literal (v4 or v6) in a private, loopback,
 * link-local, CGNAT, multicast, or reserved range — the classic SSRF targets.
 *
 * IPv6 is normalized to bytes before classification: Node's URL parser emits
 * compressed hex (e.g. "[::ffff:127.0.0.1]" becomes "::ffff:7f00:1"), so
 * string-prefix checks alone miss IPv4-mapped / compatible / NAT64 / 6to4 /
 * Teredo forms that still route to a private IPv4 address.
 */
function isPrivateIpLiteral(hostname) {
  let h = hostname.toLowerCase();
  // Strip a zone id ("%eth0") if one ever arrives unparsed.
  const zone = h.indexOf('%');
  if (zone !== -1) h = h.slice(0, zone);

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

/**
 * Expand a validated IPv6 literal to its 16 bytes. Handles "::" compression
 * and an embedded dotted-quad tail (e.g. "::ffff:1.2.3.4"). Returns null when
 * the literal does not parse.
 */
function expandIPv6(addr) {
  const clean = addr.toLowerCase();
  const halves = clean.split('::');
  if (halves.length > 2) return null;
  const parsePart = (part) => {
    const groups = [];
    if (part === '') return groups;
    for (const g of part.split(':')) {
      if (g.includes('.')) {
        const q = g.split('.');
        if (q.length !== 4) return null;
        const nums = q.map(Number);
        if (nums.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
        groups.push((nums[0] << 8) | nums[1], (nums[2] << 8) | nums[3]);
      } else {
        if (g.length === 0 || g.length > 4) return null;
        const n = parseInt(g, 16);
        if (!Number.isInteger(n) || n < 0 || n > 0xffff) return null;
        groups.push(n);
      }
    }
    return groups;
  };
  const head = parsePart(halves[0]);
  if (!head) return null;
  if (halves.length === 1) {
    if (head.length !== 8) return null;
    return head.flatMap((g) => [(g >>> 8) & 0xff, g & 0xff]);
  }
  const tail = parsePart(halves[1]);
  if (!tail || head.length + tail.length > 8) return null;
  const full = [...head, ...new Array(8 - head.length - tail.length).fill(0), ...tail];
  return full.flatMap((g) => [(g >>> 8) & 0xff, g & 0xff]);
}

function isPrivateIPv6(addr) {
  const b = expandIPv6(addr);
  // Fail closed: something net.isIP accepted but we cannot expand.
  if (!b) return true;
  const zero = (from, to) => {
    for (let i = from; i < to; i++) if (b[i] !== 0) return false;
    return true;
  };
  const embeddedV4 = [b[12], b[13], b[14], b[15]];

  // First 80 bits zero (::/96): IPv4-mapped (::ffff:w.x.y.z),
  // IPv4-translated (::ffff:0:w.x.y.z, SIIT), and IPv4-compatible (::w.x.y.z)
  // forms all carry the target IPv4 address in the last 32 bits.
  // ("::" and "::1" also land here and are correctly classified.)
  if (zero(0, 10)) {
    return isPrivateIPv4(embeddedV4);
  }
  // IPv4-translated ::ffff:0:w.x.y.z/96 (SIIT) — v4 address in last 32 bits.
  if (zero(0, 8) && b[8] === 0xff && b[9] === 0xff) {
    return isPrivateIPv4(embeddedV4);
  }
  // 6to4 2002::/16 — bytes 2..5 are the embedded IPv4 address.
  if (b[0] === 0x20 && b[1] === 0x02) {
    return isPrivateIPv4([b[2], b[3], b[4], b[5]]);
  }
  // Teredo 2001::/32 — client IPv4 is bitwise-NOTed into the last 32 bits.
  if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0x00 && b[3] === 0x00) {
    return isPrivateIPv4(embeddedV4.map((o) => (~o) & 0xff));
  }
  // NAT64 well-known prefix 64:ff9b::/96 — last 32 bits are the IPv4 address.
  if (b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b && zero(4, 10)) {
    return isPrivateIPv4(embeddedV4);
  }
  // ISATAP ::0:5efe:w.x.y.z — last 32 bits are the embedded IPv4 address.
  if (zero(8, 10) && b[10] === 0x5e && b[11] === 0xfe) {
    return isPrivateIPv4(embeddedV4);
  }

  return (
    (b[0] === 0xfe && (b[1] & 0xc0) === 0x80) ||  // fe80::/10 link-local
    (b[0] === 0xfe && (b[1] & 0xc0) === 0xc0) ||  // fec0::/10 site-local (deprecated)
    (b[0] & 0xfe) === 0xfc ||                     // fc00::/7 ULA
    b[0] === 0xff ||                              // ff00::/8 multicast
    (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0x0d && b[3] === 0xb8) // 2001:db8::/32 documentation
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
      if (now >= entry.resetAt) hits.delete(key);
    }
  }, Math.max(windowMs, 1000));
  if (prune.unref) prune.unref();

  function check(req) {
    const now = Date.now();
    const key = clientKey(req);
    const entry = hits.get(key);
    if (!entry || now >= entry.resetAt) {
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
      if (now >= entry.resetAt) fails.delete(key);
    }
  }, Math.max(windowMs, 1000));
  if (prune.unref) prune.unref();

  return function record(req) {
    const now = Date.now();
    const key = clientKey(req);
    const entry = fails.get(key);
    if (!entry || now >= entry.resetAt) {
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
const apiRateLimit = createRateLimiter({ windowMs: 60_000, max: 600 });
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
