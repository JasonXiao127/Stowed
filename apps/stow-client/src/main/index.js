const { app, BrowserWindow } = require('electron');
const path = require('path');
const DownloadManager = require('./download');
const { setupDownloadHandlers } = require('./ipc/downloadHandlers');
const { setupMetadataHandlers } = require('./ipc/metadataHandlers');

// Disable GPU cache to suppress "Unable to move the cache: Access is denied" errors
// on Windows when the Chromium cache folder is locked or has permission issues.
app.commandLine.appendSwitch('disable-gpu-cache');
app.commandLine.appendSwitch('disable-software-rasterizer');

let mainWindow = null;
let downloadManager = null;

// Handle creating/removing shortcuts on Windows when installing/uninstalling.
if (require('electron-squirrel-startup')) {
  app.quit();
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    title: 'Stow - YouTube Audio Downloader',
    icon: path.join(__dirname, '..', '..', 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
    show: false,
  });

  // In development mode (electron-forge start), the Vite dev server runs on localhost:5173
  // We try to load from it, with a fallback to the local file in production
  const { isPackaged } = app;

  if (!isPackaged) {
    // Development mode: load from Vite dev server (started by electron-forge)
    mainWindow.loadURL('http://localhost:5173');
  } else {
    // Production mode: load the Vite-built renderer
    // The Forge Vite plugin builds renderer to .vite/renderer/main_window/ during packaging
    // __dirname is the .vite/main/ directory in the packaged app
    const rendererPath = path.join(__dirname, '..', 'renderer', 'main_window', 'index.html');
    mainWindow.loadFile(rendererPath);
  }

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(() => {
  downloadManager = new DownloadManager();
  setupDownloadHandlers(downloadManager);
  setupMetadataHandlers();
  createWindow();
  downloadManager.resume();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  if (downloadManager) {
    downloadManager.shutdown();
  }
});
