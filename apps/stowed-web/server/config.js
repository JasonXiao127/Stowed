const path = require('path');

/**
 * Environment-driven configuration for the Stow web server.
 *
 * Every path is resolved from environment variables so a docker-compose
 * deployment controls where files are written (see docker-compose.yml).
 */

function envStr(name, fallback) {
  const v = process.env[name];
  return typeof v === 'string' && v.trim().length > 0 ? v.trim() : fallback;
}

function envInt(name, fallback) {
  const v = parseInt(process.env[name], 10);
  return Number.isFinite(v) ? v : fallback;
}

const config = {
  host: envStr('STOW_HOST', '0.0.0.0'),
  port: envInt('STOW_PORT', 5183),

  // Where downloaded audio files are written. This is the directory that
  // docker-compose mounts from the host, so its ownership is controlled by
  // the container user (e.g. PUID/PGID = 1000:1000 for an arr-style stack).
  downloadDir: path.resolve(envStr('STOW_DOWNLOAD_DIR', '/downloads')),

  // Where persistent state (queue-state.json) lives.
  configDir: path.resolve(envStr('STOW_CONFIG_DIR', '/config')),

  // Optional shared-secret gate for /api/* and the WebSocket handshake.
  // Empty string (the default) disables authentication entirely, which is
  // appropriate for a trusted LAN deployment.
  apiKey: envStr('STOW_API_KEY', ''),

  // Additional hosts (optionally "host:port") allowed to talk to the API.
  // Same-origin and localhost are always allowed. Used as a DNS-rebinding /
  // drive-by-CSRF defence for LAN deployments.
  allowedOrigins: envStr('STOW_ALLOWED_ORIGINS', '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),

  // Hostnames (optionally "host:port") allowed to reach the API/WebSocket.
  // Loopback and bare IP literals are always accepted; if you open Stow via a
  // hostname you must list it here (this is what actually stops DNS rebinding).
  allowedHosts: envStr('STOW_ALLOWED_HOSTS', '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),

  // SSRF guard: when set to '1', yt-dlp URLs pointing at loopback/private/
  // link-local/reserved addresses are allowed (e.g. you intentionally download
  // from LAN hosts). Leave unset to keep the guard on.
  allowPrivateIpUrls: envStr('STOW_ALLOW_PRIVATE_IP_URLS', '') === '1',

  // Resource limits: max queue length and max URLs per /api/queue request.
  maxQueueSize: envInt('STOW_MAX_QUEUE', 500),
  maxUrlsPerRequest: envInt('STOW_MAX_URLS_PER_REQUEST', 100),

  // Max concurrent WebSocket connections per client IP (all LAN clients share
  // the relay IP under Docker, so keep this generous). 0 = unlimited.
  maxWsPerIp: envInt('STOW_MAX_WS_PER_IP', 32),

  // Set to 'production' when NOT serving from the Vite dev server.
  isDev: process.env.NODE_ENV === 'development',
};

module.exports = config;
