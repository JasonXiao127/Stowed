/**
 * Backend adapter shape shared by both Stow apps.
 *
 * Any backend (Electron IPC bridge or web HTTP/WebSocket client) must provide:
 *   startDownloads(urls) -> { skipped }
 *   cancelDownloads() / cancelJob(jobId) / getQueue() / deleteFiles(paths)
 *   onQueueUpdated(cb) / onDownloadProgress(cb) / onDownloadComplete(cb) / onAllDownloadsComplete(cb)
 * Each `on*` returns an unsubscribe function.
 *
 * Both existing backends already match this shape:
 * - Electron: window.electronAPI (see apps/stow-client/src/preload.js)
 * - Web: the default export of apps/stowed-web/src/renderer/api.js
 *
 * These helpers just bind a backend object so App shells can treat them
 * uniformly.
 */

export function createElectronBackend(electronAPI) {
  return {
    startDownloads: (urls) => electronAPI.startDownloads(urls),
    cancelDownloads: () => electronAPI.cancelDownloads(),
    cancelJob: (jobId) => electronAPI.cancelJob(jobId),
    getQueue: () => electronAPI.getQueue(),
    deleteFiles: (paths) => electronAPI.deleteFiles(paths),
    onQueueUpdated: (cb) => electronAPI.onQueueUpdated(cb),
    onDownloadProgress: (cb) => electronAPI.onDownloadProgress(cb),
    onDownloadComplete: (cb) => electronAPI.onDownloadComplete(cb),
    onAllDownloadsComplete: (cb) => electronAPI.onAllDownloadsComplete(cb),
  };
}

export function createWebBackend(api) {
  return {
    startDownloads: (urls) => api.startDownloads(urls),
    cancelDownloads: () => api.cancelDownloads(),
    cancelJob: (jobId) => api.cancelJob(jobId),
    getQueue: () => api.getQueue(),
    deleteFiles: (paths) => api.deleteFiles(paths),
    onQueueUpdated: (cb) => api.onQueueUpdated(cb),
    onDownloadProgress: (cb) => api.onDownloadProgress(cb),
    onDownloadComplete: (cb) => api.onDownloadComplete(cb),
    onAllDownloadsComplete: (cb) => api.onAllDownloadsComplete(cb),
  };
}
