/**
 * Web API client for the Stow renderer.
 *
 * The UI talks to the Node server over plain HTTP (fetch) for requests and a
 * WebSocket for real-time events (queue updates, download progress).
 */

// Optional shared secret used to authenticate against the backend when
// STOW_API_KEY is set. Persisted locally so the built UI can actually use the
// auth feature: fetches send the key as an X-API-Key header; the WebSocket uses
// ?apikey= because browsers cannot set custom headers on a WS handshake.
let apiKey = '';
try {
  apiKey = window && window.localStorage ? (localStorage.getItem('stow-api-key') || '') : '';
} catch (_) { /* storage unavailable (e.g. private mode) */ }

function authHeaders(headers) {
  const out = { ...headers };
  if (apiKey) out['X-API-Key'] = apiKey;
  return out;
}

function jsonRequest(url, options = {}) {
  return fetch(url, {
    ...options,
    headers: authHeaders(options.headers || {}),
  }).then(async (res) => {
    if (!res.ok) {
      let message = res.statusText;
      try {
        const body = await res.json();
        message = body.error || message;
      } catch (_) {
        /* non-JSON error body */
      }
      throw new Error(message || `Request failed (${res.status})`);
    }
    const ct = res.headers.get('content-type') || '';
    return ct.includes('application/json') ? res.json() : res.text();
  });
}

const api = {
  // ---- Queue -------------------------------------------------------------
  startDownloads: (urls) =>
    jsonRequest('/api/queue', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ urls }),
    }),
  cancelDownloads: () =>
    jsonRequest('/api/cancel', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    }),
  cancelJob: (jobId) =>
    jsonRequest(`/api/cancel/${encodeURIComponent(jobId)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    }),
  getQueue: () => jsonRequest('/api/queue'),
  deleteFiles: (filePaths) =>
    jsonRequest('/api/delete-files', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filePaths }),
    }),

  // ---- Files -------------------------------------------------------------
  listFiles: (dir) =>
    jsonRequest(`/api/files?dir=${encodeURIComponent(dir || '')}`),
  fileUrl: (filePath, download = false) =>
    `/api/file?path=${encodeURIComponent(filePath)}&download=${download ? 1 : 0}`,
  openFile: (filePath) => {
    window.open(api.fileUrl(filePath, true), '_blank');
  },

  // ---- Metadata ----------------------------------------------------------
  readMetadata: (filePath) =>
    jsonRequest(`/api/metadata?path=${encodeURIComponent(filePath)}`),
  writeMetadata: (filePath, tags, thumbnailFile = null) => {
    if (thumbnailFile) {
      const fd = new FormData();
      fd.append('path', filePath);
      fd.append('tags', JSON.stringify(tags));
      fd.append('thumbnail', thumbnailFile);
      return jsonRequest('/api/metadata', { method: 'POST', body: fd });
    }
    return jsonRequest('/api/metadata', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: filePath, tags }),
    });
  },
  coverUrl: (filePath) => `/api/cover?path=${encodeURIComponent(filePath)}`,
};

// ---- WebSocket real-time events -----------------------------------------
const listeners = {
  'download-progress': [],
  'download-complete': [],
  'queue-updated': [],
  'all-downloads-complete': [],
};

let ws = null;
let reconnectTimer = null;

function connectSocket() {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  // Browsers cannot attach custom headers to a WebSocket handshake, so the key
  // travels in the query string (the one place server security.js also accepts it).
  const keyQuery = apiKey ? `?apikey=${encodeURIComponent(apiKey)}` : '';
  try {
    ws = new WebSocket(`${proto}//${window.location.host}/ws${keyQuery}`);
  } catch (_) {
    reconnectTimer = setTimeout(connectSocket, 3000);
    return;
  }

  ws.onmessage = (e) => {
    let msg;
    try {
      msg = JSON.parse(e.data);
    } catch (_) {
      return;
    }
    (listeners[msg.type] || []).forEach((cb) => cb(msg.data));
  };

  ws.onclose = () => {
    ws = null;
    reconnectTimer = setTimeout(connectSocket, 3000);
  };
  ws.onerror = () => {
    try { ws.close(); } catch (_) {}
  };
}
connectSocket();

function on(type, callback) {
  if (!listeners[type]) listeners[type] = [];
  listeners[type].push(callback);
  return () => {
    const i = listeners[type].indexOf(callback);
    if (i >= 0) listeners[type].splice(i, 1);
  };
}

api.onDownloadProgress = (cb) => on('download-progress', cb);
api.onDownloadComplete = (cb) => on('download-complete', cb);
api.onQueueUpdated = (cb) => on('queue-updated', cb);
api.onAllDownloadsComplete = (cb) => on('all-downloads-complete', cb);

// ---- Optional API-key auth -------------------------------------------------
api.setApiKey = (key) => {
  apiKey = String(key || '').trim();
  try { localStorage.setItem('stow-api-key', apiKey); } catch (_) {}
  // Reconnect the socket so the new/cleared key takes effect immediately.
  if (ws) { try { ws.close(); } catch (_) {} }
};
api.getApiKey = () => apiKey;

export default api;
