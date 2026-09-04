import React, { useState, useEffect, useCallback } from 'react';
import { useTheme } from './context/ThemeContext';
import UrlInput from './components/UrlInput';
import QueuePanel from './components/QueuePanel';
import MetadataEditor from './components/MetadataEditor';

export default function App() {
  const { theme, toggleTheme } = useTheme();
  const [queue, setQueue] = useState([]);
  const [selectedFile, setSelectedFile] = useState(null);
  const [showMetadata, setShowMetadata] = useState(false);
  const [showClearConfirm, setShowClearConfirm] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [toast, setToast] = useState(null);

  const showToast = useCallback((message, type = 'success') => {
    setToast({ message, type });
    setTimeout(() => setToast(null), 3000);
  }, []);

  // Load initial queue state
  useEffect(() => {
    if (window.electronAPI) {
      window.electronAPI.getQueue().then(setQueue).catch(console.error);
    }
  }, []);

  // Listen for queue updates from main process
  useEffect(() => {
    if (!window.electronAPI) return;

    const cleanupQueue = window.electronAPI.onQueueUpdated((updatedQueue) => {
      setQueue(updatedQueue);
    });

    const cleanupProgress = window.electronAPI.onDownloadProgress((progress) => {
      setQueue((prev) =>
        prev.map((job) =>
          job.id === progress.id
            ? { ...job, progress: progress.progress, speed: progress.speed, eta: progress.eta }
            : job
        )
      );
    });

    const cleanupComplete = window.electronAPI.onDownloadComplete((result) => {
      showToast(`Download complete: ${result.outputPath}`, 'success');
    });

    const cleanupAllDone = window.electronAPI.onAllDownloadsComplete(() => {
      showToast('All downloads complete!', 'success');
    });

    return () => {
      cleanupQueue();
      cleanupProgress();
      cleanupComplete();
      cleanupAllDone();
    };
  }, [showToast]);

  const handleStartDownloads = async (urls) => {
    try {
      const result = await window.electronAPI.startDownloads(urls);
      if (result && result.skipped > 0) {
        showToast(`Skipped ${result.skipped} duplicate(s) — URL(s) already in the active download queue (not a program error)`, 'warning');
      }
    } catch (err) {
      showToast(`Failed to start downloads: ${err.message}`, 'error');
      throw err;
    }
  };

  const handleCancelAll = () => {
    setShowClearConfirm(true);
  };

  const handleClearConfirm = async (deleteFiles) => {
    setClearing(true);
    setShowClearConfirm(false);

    try {
      if (deleteFiles) {
        const completeJobs = queue.filter(
          (j) => j.status === 'Complete' && j.outputPath
        );
        if (completeJobs.length > 0) {
          const paths = completeJobs.map((j) => j.outputPath);
          const results = await window.electronAPI.deleteFiles(paths);
          const deleted = results.filter((r) => r.deleted).length;
          const failed = results.filter((r) => !r.deleted).length;
          if (deleted > 0) {
            showToast(`Deleted ${deleted} audio file(s)`, 'success');
          }
          if (failed > 0) {
            showToast(`${failed} file(s) could not be deleted`, 'warning');
          }
        }
      }
      await window.electronAPI.cancelDownloads();
    } catch (err) {
      showToast(`Failed: ${err.message}`, 'error');
      try {
        await window.electronAPI.cancelDownloads();
      } catch (_) {}
    }
    setQueue([]);
    setClearing(false);
  };

  const handleCancelJob = async (jobId) => {
    try {
      await window.electronAPI.cancelJob(jobId);
    } catch (err) {
      showToast(`Failed to cancel job: ${err.message}`, 'error');
    }
  };

  const handleOpenFile = async () => {
    try {
      const filePath = await window.electronAPI.openFileDialog();
      if (filePath) {
        setSelectedFile(filePath);
        setShowMetadata(true);
      }
    } catch (err) {
      showToast(`Failed to open file: ${err.message}`, 'error');
    }
  };

  const handleEditDownloadedFile = (filePath) => {
    setSelectedFile(filePath);
    setShowMetadata(true);
  };

  const handleCloseMetadata = () => {
    setShowMetadata(false);
    setSelectedFile(null);
  };

  const hasQueue = queue.length > 0;

  return (
    <div className="app-container">
      {/* Center section: title + search bar */}
      <div className={`center-section${hasQueue ? ' has-queue' : ''}`}>
        {!hasQueue && <div className="center-title">Stow</div>}
        <UrlInput onStartDownloads={handleStartDownloads} />
      </div>

      {/* Queue section: below the search bar */}
      <div className="queue-section">
        <QueuePanel
          queue={queue}
          onCancelAll={handleCancelAll}
          onCancelJob={handleCancelJob}
          onEditFile={handleEditDownloadedFile}
        />
      </div>

      {/* Clear Confirmation Dialog */}
      {showClearConfirm && (
        <div className="modal-overlay" onClick={(e) => {
          if (e.target === e.currentTarget) setShowClearConfirm(false);
        }}>
          <div className="modal-dialog" style={{ maxWidth: '400px' }}>
            <div style={{ padding: '24px 20px 20px' }}>
              <h3 style={{ fontSize: '16px', fontWeight: 600, marginBottom: '8px' }}>
                Clear all downloads?
              </h3>
              <p style={{ fontSize: '13px', color: 'var(--text-secondary)', marginBottom: '20px', lineHeight: '1.5' }}>
                {queue.filter(j => j.status === 'Complete' && j.outputPath).length > 0
                  ? `There ${queue.filter(j => j.status === 'Complete' && j.outputPath).length === 1 ? 'is' : 'are'} ${queue.filter(j => j.status === 'Complete' && j.outputPath).length} completed download(s) with audio files on disk.`
                  : 'No completed downloads with files to clean up.'}
              </p>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                <div style={{ display: 'flex', gap: '8px' }}>
                  <button
                    className="btn btn-secondary"
                    style={{ flex: 1, textAlign: 'center' }}
                    onClick={() => setShowClearConfirm(false)}
                  >
                    Cancel
                  </button>
                  <button
                    className="btn btn-secondary"
                    style={{ flex: 1, textAlign: 'center' }}
                    onClick={() => handleClearConfirm(false)}
                  >
                    Clear List Only
                  </button>
                </div>
                {queue.filter(j => j.status === 'Complete' && j.outputPath).length > 0 && (
                  <button
                    className="btn btn-danger"
                    style={{ width: '100%', padding: '12px 20px', fontSize: '15px', fontWeight: 700 }}
                    onClick={() => handleClearConfirm(true)}
                    disabled={clearing}
                  >
                    Clear & Delete Files
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Bottom bar: Open File & Theme toggle */}
      <div className="bottom-bar">
        <div className="bottom-bar-left">
          <button className="btn-icon" onClick={handleOpenFile}>
            <span className="icon">📂</span>
            Open File
          </button>
        </div>
        <div className="bottom-bar-right">
          <button className="btn-icon" onClick={toggleTheme}>
            <span className="icon">{theme === 'dark' ? '☀️' : '🌙'}</span>
            {theme === 'dark' ? 'Light' : 'Dark'}
          </button>
        </div>
      </div>

      {/* Metadata Modal */}
      {showMetadata && (
        <div className="modal-overlay" onClick={(e) => {
          if (e.target === e.currentTarget) handleCloseMetadata();
        }}>
          <div className="modal-dialog">
            <MetadataEditor
              filePath={selectedFile}
              onClose={handleCloseMetadata}
              showToast={showToast}
            />
          </div>
        </div>
      )}

      {/* Toast */}
      {toast && (
        <div className={`toast ${toast.type}`}>
          {toast.message}
        </div>
      )}
    </div>
  );
}
