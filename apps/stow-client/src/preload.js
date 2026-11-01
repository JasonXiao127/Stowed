const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // Download operations
  startDownloads: (urls) => ipcRenderer.invoke('start-downloads', urls),
  cancelDownloads: () => ipcRenderer.invoke('cancel-downloads'),
  cancelJob: (jobId) => ipcRenderer.invoke('cancel-job', jobId),
  retryJob: (jobId) => ipcRenderer.invoke('retry-job', jobId),
  removeJob: (jobId) => ipcRenderer.invoke('remove-job', jobId),
  getQueue: () => ipcRenderer.invoke('get-queue'),

  // yt-dlp runtime diagnostics + updater
  getSystem: () => ipcRenderer.invoke('ytdlp-system'),
  checkYtDlpUpdate: () => ipcRenderer.invoke('ytdlp-check-update'),
  updateYtDlp: () => ipcRenderer.invoke('ytdlp-update'),
  rollbackYtDlp: () => ipcRenderer.invoke('ytdlp-rollback'),

  // Metadata operations
  readMetadata: (filePath) => ipcRenderer.invoke('read-metadata', filePath),
  writeMetadata: (filePath, tags, newThumbnailPath) =>
    ipcRenderer.invoke('write-metadata', filePath, tags, newThumbnailPath),

  // Dialog operations
  openFileDialog: () => ipcRenderer.invoke('open-file-dialog'),
  openImageDialog: () => ipcRenderer.invoke('open-image-dialog'),

  // File system operations
  showInFolder: (filePath) => ipcRenderer.invoke('show-in-folder', filePath),
  deleteFiles: (filePaths) => ipcRenderer.invoke('delete-files', filePaths),

  // Event listeners (main -> renderer)
  onDownloadProgress: (callback) => {
    const listener = (event, data) => callback(data);
    ipcRenderer.on('download-progress', listener);
    return () => ipcRenderer.removeListener('download-progress', listener);
  },

  onDownloadComplete: (callback) => {
    const listener = (event, data) => callback(data);
    ipcRenderer.on('download-complete', listener);
    return () => ipcRenderer.removeListener('download-complete', listener);
  },

  onQueueUpdated: (callback) => {
    const listener = (event, data) => callback(data);
    ipcRenderer.on('queue-updated', listener);
    return () => ipcRenderer.removeListener('queue-updated', listener);
  },

  onAllDownloadsComplete: (callback) => {
    const listener = () => callback();
    ipcRenderer.on('all-downloads-complete', listener);
    return () => ipcRenderer.removeListener('all-downloads-complete', listener);
  },
});