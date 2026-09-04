const { ipcMain, shell, dialog, app } = require('electron');
const fs = require('fs');

function setupDownloadHandlers(downloadManager) {
  // Start downloads
  ipcMain.handle('start-downloads', (event, urls) => {
    if (!Array.isArray(urls) || urls.some((url) => typeof url !== 'string')) {
      throw new TypeError('URLs must be an array of strings');
    }
    const result = downloadManager.addJobs(urls);
    return result;
  });

  // Show file in system file manager (Explorer on Windows, Finder on macOS)
  ipcMain.handle('show-in-folder', async (event, filePath) => {
    const fs = require('fs');
    if (!filePath || !fs.existsSync(filePath)) {
      await dialog.showMessageBox({
        type: 'warning',
        title: 'File Not Found',
        message: 'The file could not be found.',
        detail: filePath
          ? `This file does not exist:\n${filePath}\n\nIt may have been moved, deleted, or the download may not have completed successfully.`
          : 'No file path was provided.',
        buttons: ['OK'],
      });
      return;
    }
    shell.showItemInFolder(filePath);
  });

  // Delete files from disk (used when clearing queue with cleanup)
  ipcMain.handle('delete-files', async (event, filePaths) => {
    if (!Array.isArray(filePaths) || filePaths.some((filePath) => typeof filePath !== 'string')) {
      throw new TypeError('File paths must be an array of strings');
    }

    const allowedPaths = new Set(
      downloadManager
        .getQueue()
        .filter((job) => job.status === 'Complete' && job.outputPath)
        .map((job) => job.outputPath)
    );

    const results = [];
    for (const fp of filePaths) {
      if (!allowedPaths.has(fp)) {
        results.push({ path: fp, deleted: false, reason: 'not an active completed download' });
        continue;
      }
      try {
        if (fs.existsSync(fp)) {
          fs.unlinkSync(fp);
          results.push({ path: fp, deleted: true });
        } else {
          results.push({ path: fp, deleted: false, reason: 'not found' });
        }
      } catch (err) {
        results.push({ path: fp, deleted: false, reason: err.message });
      }
    }
    return results;
  });

  // Cancel all downloads
  ipcMain.handle('cancel-downloads', () => {
    downloadManager.cancelAll();
    return true;
  });

  // Cancel a specific job
  ipcMain.handle('cancel-job', (event, jobId) => {
    downloadManager.cancelJob(jobId);
    return true;
  });

  // Get current queue state
  ipcMain.handle('get-queue', () => {
    return downloadManager.getQueue();
  });

  // Start polling for deleted files every 3 seconds
  const pollInterval = setInterval(() => {
    downloadManager.syncFileStatuses();
  }, 3000);

  // Clean up polling on app quit
  app.on('before-quit', () => {
    clearInterval(pollInterval);
  });

  // Forward events to the renderer
  const sendToRenderer = (channel, data) => {
    const win = require('electron').BrowserWindow.getAllWindows()[0];
    if (win && !win.isDestroyed()) {
      win.webContents.send(channel, data);
    }
  };

  downloadManager.on('queue-updated', (queue) => {
    sendToRenderer('queue-updated', queue);
  });

  downloadManager.on('download-progress', (progress) => {
    sendToRenderer('download-progress', progress);
  });

  downloadManager.on('download-complete', (result) => {
    sendToRenderer('download-complete', result);
  });

  downloadManager.on('all-complete', () => {
    sendToRenderer('all-downloads-complete');
  });
}

module.exports = { setupDownloadHandlers };
