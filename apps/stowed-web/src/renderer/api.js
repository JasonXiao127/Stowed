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
  retryJob: (jobId) =>
    jsonRequest('/api/queue/retry', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: jobId }),
    }),
  removeJob: (jobId) =>
    jsonRequest(`/api/queue/${encodeURIComponent(jobId)}`, { method: 'DELETE' }),
  deleteFiles: (filePaths) =>
    jsonRequest('/api/delete-files', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filePaths }),
    }),

  // ---- Files -------------------------------------------------------------
  listFiles: (dir) =>
    jsonRequest(`/api/files?dir=${encodeURIComponent(dir || '')}`),
  fileUrlWithKey: (filePath, download = false) => {
    const key = api.getApiKey ? api.getApiKey() : '';
    const base = `/api/file?path=${encodeURIComponent(filePath)}&download=${download ? 1 : 0}`;
    return key ? `${base}&apikey=${encodeURIComponent(key)}` : base;
  },
  // Legacy aliases — kept so any caller using the bare versions still gets an
  // authed URL (<audio>/<img>/wavesurfer can't send headers).
  fileUrl: (filePath, download = false) =>
    api.fileUrlWithKey(filePath, download),
  openFile: (filePath) => {
    return window.open(api.fileUrlWithKey(filePath, true), '_blank');
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
  coverUrlWithKey: (filePath) => {
    const key = api.getApiKey ? api.getApiKey() : '';
    const base = `/api/cover?path=${encodeURIComponent(filePath)}`;
    return key ? `${base}&apikey=${encodeURIComponent(key)}` : base;
  },
  coverUrl: (filePath) => api.coverUrlWithKey(filePath),

  // ---- MusicBrainz -------------------------------------------------------
  mbSearch: ({ title, artist, album, limit } = {}) => {
    const q = new URLSearchParams();
    if (title) q.set('title', title);
    if (artist) q.set('artist', artist);
    if (album) q.set('album', album);
    if (limit) q.set('limit', String(limit));
    return jsonRequest(`/api/mb/search?${q.toString()}`);
  },
  mbCoverUrl: (releaseId) => {
    const key = api.getApiKey ? api.getApiKey() : '';
    const base = `/api/mb/cover?releaseId=${encodeURIComponent(releaseId)}`;
    return key ? `${base}&apikey=${encodeURIComponent(key)}` : base;
  },

  // ---- Audio trim --------------------------------------------------------
  getDuration: (filePath) =>
    jsonRequest(`/api/duration?path=${encodeURIComponent(filePath)}`),
  trimAudio: (filePath, start, end) =>
    jsonRequest('/api/trim', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: filePath, start, end }),
    }),

  // ---- System / settings -------------------------------------------------
  getSystem: () => jsonRequest('/api/system'),
  getSettings: () => jsonRequest('/api/settings'),
  saveSettings: (patch) =>
    jsonRequest('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    }),

  // ---- Inspect / library / thumb -----------------------------------------
  inspectUrl: (url, playlistEnd = 20) =>
    jsonRequest('/api/inspect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, playlistEnd }),
    }),
  getLibrary: ({ q, sort, order, limit, offset } = {}) => {
    const params = new URLSearchParams();
    if (q) params.set('q', q);
    if (sort) params.set('sort', sort);
    if (order) params.set('order', order);
    if (limit) params.set('limit', String(limit));
    if (offset) params.set('offset', String(offset));
    return jsonRequest(`/api/library?${params.toString()}`);
  },
  thumbUrl: (remoteUrl) => {
    const key = api.getApiKey ? api.getApiKey() : '';
    const base = `/api/thumb?url=${encodeURIComponent(remoteUrl)}`;
    return key ? `${base}&apikey=${encodeURIComponent(key)}` : base;
  },

  // ---- Cookies ------------------------------------------------------------
  getCookiesStatus: () => jsonRequest('/api/cookies/status'),
  saveCookies: (text) =>
    jsonRequest('/api/cookies', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cookies: text }),
    }),
  saveCookiesFile: (file) => {
    const fd = new FormData();
    fd.append('cookies', file);
    return jsonRequest('/api/cookies', { method: 'POST', body: fd });
  },
  removeCookies: () =>
    jsonRequest('/api/cookies', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    }),
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
let backoffAttempts = 0;
let authRejected = false;
const authRejectedListeners = new Set();

function notifyAuthRejected() {
  if (authRejected) return;
  authRejected = true;
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  authRejectedListeners.forEach((cb) => { try { cb(); } catch (_) {} });
}

function scheduleReconnect() {
  if (authRejected) return;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  const delay = Math.min(30000, 1000 * Math.pow(2, backoffAttempts));
  backoffAttempts += 1;
  reconnectTimer = setTimeout(connectSocket, delay);
}

async function probeAuthAndMaybeStop() {
  // Upgrade rejections surface as code 1006 in browsers; probe HTTP to tell
  // a bad API key (stop + toast) from a transient drop (backoff + retry).
  try {
    const res = await fetch('/api/queue', { headers: authHeaders({}) });
    if (res.status === 401 || res.status === 403) {
      notifyAuthRejected();
      return true;
    }
  } catch (_) {}
  return false;
}

function connectSocket() {
  if (authRejected) return;
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  // Browsers cannot attach custom headers to a WebSocket handshake, so the key
  // travels in the query string (the one place server security.js also accepts it).
  const keyQuery = apiKey ? `?apikey=${encodeURIComponent(apiKey)}` : '';
  try {
    ws = new WebSocket(`${proto}//${window.location.host}/ws${keyQuery}`);
  } catch (_) {
    scheduleReconnect();
    return;
  }

  ws.onopen = () => {
    backoffAttempts = 0;
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  };

  ws.onmessage = (e) => {
    let msg;
    try {
      msg = JSON.parse(e.data);
    } catch (_) {
      return;
    }
    (listeners[msg.type] || []).forEach((cb) => cb(msg.data));
  };

  ws.onclose = (ev) => {
    ws = null;
    const code = ev && ev.code;
    if (code === 401 || code === 403 || code === 4401 || code === 4403) {
      notifyAuthRejected();
      return;
    }
    // Likely an upgrade rejection (bad key) which browsers report as 1006:
    // probe once, stop only when HTTP confirms 401/403.
    probeAuthAndMaybeStop().then((stopped) => {
      if (!stopped) scheduleReconnect();
    });
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
  authRejected = false;
  backoffAttempts = 0;
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  if (ws) { try { ws.close(); } catch (_) {} }
  else connectSocket();
};
api.getApiKey = () => apiKey;
api.onAuthRejected = (cb) => {
  authRejectedListeners.add(cb);
  return () => authRejectedListeners.delete(cb);
};

export default api;
