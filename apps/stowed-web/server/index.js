const http = require('http');
const path = require('path');
const fs = require('fs');
const express = require('express');
const { WebSocketServer } = require('ws');
const config = require('./config');
const {
  originGuard,
  apiKeyGuard,
  hostGuard,
  securityHeaders,
  isOriginAllowed,
  isHostAllowed,
  hasValidKey,
  rateLimitMiddleware,
  apiRateLimit,
} = require('./security');
const DownloadManager = require('./downloader');
const { setupRoutes } = require('./routes');

// Make sure the configured directories exist (with clear errors if they are
// not writable — this is usually a host-folder ownership mismatch).
for (const dir of [config.downloadDir, config.configDir]) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.accessSync(dir, fs.constants.W_OK);
  } catch (err) {
    console.error(
      `Cannot use directory "${dir}": ${err.message}\n` +
        'Check your volume mounts and that the container user owns them ' +
        '(e.g. chown -R 1000:1000 ./downloads ./config for PUID/PGID 1000).'
    );
    process.exit(1);
  }
}

const app = express();
const server = http.createServer(app);

app.set('trust proxy', false);
app.disable('x-powered-by');
app.use(securityHeaders);
app.use(originGuard);
// LAN-wide sanity cap on every request (cheap, runs before body parsing so a
// flood of oversized bodies is rejected early).
app.use(rateLimitMiddleware(apiRateLimit));
app.use(express.json({ limit: '1mb' }));
app.use('/api', hostGuard);
app.use('/api', apiKeyGuard);

const downloadManager = new DownloadManager();

// ---- Real-time events: main -> WebSocket clients ------------------------
const wss = new WebSocketServer({ noServer: true });

function broadcast(type, data) {
  const msg = JSON.stringify({ type, data });
  for (const ws of wss.clients) {
    if (ws.readyState === ws.OPEN) ws.send(msg);
  }
}

downloadManager.on('queue-updated', (queue) => broadcast('queue-updated', queue));
downloadManager.on('download-progress', (p) => broadcast('download-progress', p));
downloadManager.on('download-complete', (r) => broadcast('download-complete', r));
downloadManager.on('all-complete', () => broadcast('all-downloads-complete', {}));

// ---- HTTP API + static UI -----------------------------------------------
setupRoutes(app, downloadManager);

// Root-level health endpoint (used by the compose healthcheck) — no auth.
app.get('/healthz', (req, res) => {
  res.json({ status: 'ok' });
});

// 404 for unknown API routes (must precede the SPA fallback).
app.use('/api', (req, res) => {
  res.status(404).json({ error: 'Not found' });
});

const distDir = path.join(__dirname, '..', 'dist');
if (config.isDev) {
  // Development: proxy the renderer to the Vite dev server for live HMR.
  // This runs even if a stale dist/ build exists, so "npm run dev:*" always
  // serves the current source instead of an old production bundle. The API
  // (/api) and WebSocket (/ws) are still handled here, so open the page at
  // the Node server port (http://localhost:5183), not Vite's own port.
  const devTarget = new URL(process.env.VITE_DEV_URL || 'http://localhost:5173');
  app.use((req, res, next) => {
    if (req.path.startsWith('/api') || req.path.startsWith('/ws')) return next();
    const proxyReq = http.request(
      {
        hostname: devTarget.hostname,
        port: devTarget.port,
        path: req.originalUrl,
        method: req.method,
        headers: { ...req.headers, host: devTarget.host },
      },
      (proxyRes) => {
        res.writeHead(proxyRes.statusCode, proxyRes.headers);
        proxyRes.pipe(res);
      }
    );
    proxyReq.on('error', () => {
      res.status(502).send('Vite dev server unavailable at ' + devTarget.origin);
    });
    req.pipe(proxyReq);
  });
} else if (fs.existsSync(path.join(distDir, 'index.html'))) {
  app.use(express.static(distDir));
  // SPA fallback: serve the app shell for any non-API GET.
  app.use((req, res, next) => {
    if (req.method !== 'GET' || req.path.startsWith('/api') || req.path.startsWith('/ws')) {
      next();
      return;
    }
    res.sendFile(path.join(distDir, 'index.html'));
  });
} else {
  console.error('No built renderer found in dist/. Run "npm run build:web" first.');
  process.exit(1);
}

// Global error handler: normalize any thrown error to JSON (never leak an HTML
// 500 to API/file-browser clients). Registered after all routes/middleware.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  // Log only the path, never the query string, so credentials that arrive in
  // the URL (e.g. ?apikey=...) can't leak into logs.
  const safePath = (req.originalUrl || req.url || '').split('?')[0];
  console.error('[server]', req.method, safePath, err && err.message);
  // Oversized thumbnail/multipart uploads should be reported as 413.
  const status = (err && err.code === 'LIMIT_FILE_SIZE')
    ? 413
    : ((err && typeof err.status === 'number') ? err.status : 500);
  res.status(status).json({ error: (err && err.message) || 'Internal server error' });
});

// ---- WebSocket handshake ------------------------------------------------
// Generous sensible default: under Docker every LAN client shares the relay IP,
// so this cap is effectively LAN-wide — 0 disables it (STOW_MAX_WS_PER_IP=0).
const MAX_WS_PER_IP = config.maxWsPerIp > 0 ? config.maxWsPerIp : Infinity;
const wsConnections = new Map(); // ip -> active connection count

server.on('upgrade', (req, socket, head) => {
  let parsed;
  try {
    parsed = new URL(req.url, 'http://localhost');
  } catch (_) {
    socket.destroy();
    return;
  }

  if (parsed.pathname !== '/ws') {
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
    socket.destroy();
    return;
  }

  const fakeReq = { headers: req.headers, query: Object.fromEntries(parsed.searchParams) };
  // Origin + Host checks close the DNS-rebinding / drive-by CSRF hole; the API
  // key (when set) gates the actual data.
  if (!isHostAllowed(fakeReq) || !isOriginAllowed(fakeReq) || !hasValidKey(fakeReq)) {
    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
    socket.destroy();
    return;
  }

  // Per-IP connection cap so a flood of sockets can't pile up on the event loop.
  const ip = socket.remoteAddress || 'unknown';
  const current = wsConnections.get(ip) || 0;
  if (current >= MAX_WS_PER_IP) {
    socket.write('HTTP/1.1 429 Too Many Requests\r\n\r\n');
    socket.destroy();
    return;
  }
  wsConnections.set(ip, current + 1);

  wss.handleUpgrade(req, socket, head, (ws) => {
    ws.on('close', () => {
      const c = wsConnections.get(ip) || 1;
      if (c <= 1) wsConnections.delete(ip);
      else wsConnections.set(ip, c - 1);
    });
    wss.emit('connection', ws, req);
  });
});

wss.on('connection', (ws) => {
  // Send the current queue to a freshly connected client.
  ws.send(JSON.stringify({ type: 'queue-updated', data: downloadManager.getQueue() }));
});

// ---- File-existence polling (mirrors the desktop app) -------------------
const pollInterval = setInterval(() => {
  downloadManager.syncFileStatuses();
}, 3000);

// ---- Startup & graceful shutdown ----------------------------------------
downloadManager.resume();

server.listen(config.port, config.host, () => {
  console.log('Stow web server listening on http://%s:%d', config.host, config.port);
  console.log('  Downloads:  %s', config.downloadDir);
  console.log('  Config dir: %s', config.configDir);
  console.log('  Auth:       %s', config.apiKey ? 'enabled (STOW_API_KEY)' : 'disabled (local network only)');
});

function shutdown() {
  console.log('Shutting down Stow...');
  clearInterval(pollInterval);
  downloadManager.shutdown();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);