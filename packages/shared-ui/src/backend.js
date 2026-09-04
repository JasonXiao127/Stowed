/**
 * Backend adapter shape shared by both Stow apps.
 *
 * Common shape (both backends must provide):
 *   startDownloads(urls) -> { skipped }
 *   cancelDownloads() / cancelJob(jobId) / getQueue() / deleteFiles(paths)
 *   readMetadata(filePath) / writeMetadata(filePath, tags, thumbnail?)
 *   onQueueUpdated(cb) / onDownloadProgress(cb) / onDownloadComplete(cb) / onAllDownloadsComplete(cb)
 * Each `on*` returns an unsubscribe function.
 *
 * Electron-only (see apps/stow-client/src/preload.js):
 *   openFileDialog() / openImageDialog() / showInFolder(filePath)
 *
 * Web-only (see apps/stowed-web/src/renderer/api.js):
 *   openFile(filePath) / listFiles(dir) / fileUrl(filePath) / coverUrl(filePath)
 *
 * These helpers just bind a backend object so App shells can treat them
 * uniformly. Optional methods are only present when the underlying API
 * provides them.
 */

function bindIfPresent(source, name) {
  return typeof source?.[name] === 'function'
    ? (...args) => source[name](...args)
    : undefined;
}

export function createElectronBackend(electronAPI) {
  return {
    startDownloads: (urls) => electronAPI.startDownloads(urls),
    cancelDownloads: () => electronAPI.cancelDownloads(),
    cancelJob: (jobId) => electronAPI.cancelJob(jobId),
    getQueue: () => electronAPI.getQueue(),
    deleteFiles: (paths) => electronAPI.deleteFiles(paths),
    readMetadata: bindIfPresent(electronAPI, 'readMetadata'),
    writeMetadata: bindIfPresent(electronAPI, 'writeMetadata'),
    openFileDialog: bindIfPresent(electronAPI, 'openFileDialog'),
    openImageDialog: bindIfPresent(electronAPI, 'openImageDialog'),
    showInFolder: bindIfPresent(electronAPI, 'showInFolder'),
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
    readMetadata: bindIfPresent(api, 'readMetadata'),
    writeMetadata: bindIfPresent(api, 'writeMetadata'),
    openFile: bindIfPresent(api, 'openFile'),
    listFiles: bindIfPresent(api, 'listFiles'),
    fileUrl: bindIfPresent(api, 'fileUrl'),
    coverUrl: bindIfPresent(api, 'coverUrl'),
    onQueueUpdated: (cb) => api.onQueueUpdated(cb),
    onDownloadProgress: (cb) => api.onDownloadProgress(cb),
    onDownloadComplete: (cb) => api.onDownloadComplete(cb),
    onAllDownloadsComplete: (cb) => api.onAllDownloadsComplete(cb),
  };
}
