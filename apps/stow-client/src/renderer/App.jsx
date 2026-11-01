import React, { useState, useEffect, useCallback } from 'react';
import { useTheme, UrlInput, QueuePanel, SunIcon, MoonIcon, XIcon, FolderIcon } from '@stowed/shared-ui';
import MetadataEditor from './components/MetadataEditor';

export default function App() {
  const { theme, toggleTheme } = useTheme();
  const [queue, setQueue] = useState([]);
  const [selectedFile, setSelectedFile] = useState(null);
  const [showMetadata, setShowMetadata] = useState(false);
  const [showClearConfirm, setShowClearConfirm] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [toast, setToast] = useState(null);

  const dismissToast = useCallback(() => setToast(null), []);

  const showToast = useCallback((message, type = 'success') => {
    setToast({ message, type });
    setTimeout(() => setToast(null), 3000);
  }, []);

  useEffect(() => {
    if (window.electronAPI) {
      window.electronAPI.getQueue().then(setQueue).catch(console.error);
    }
  }, []);

  useEffect(() => {
    if (!window.electronAPI) return;

    const cleanupQueue = window.electronAPI.onQueueUpdated((updatedQueue) => {
      setQueue(updatedQueue);
    });

    const cleanupProgress = window.electronAPI.onDownloadProgress((progress) => {
      setQueue((prev) =>
        prev.map((job) =>
          job.id === progress.id
            ? {
                ...job,
                progress: progress.progress ?? job.progress,
                downloadedBytes: progress.downloadedBytes ?? job.downloadedBytes,
                totalBytes: progress.totalBytes ?? job.totalBytes,
                speed: progress.speed ?? job.speed,
                eta: progress.eta ?? job.eta,
                elapsed: progress.elapsed ?? job.elapsed,
                stage: progress.stage || job.stage,
                status: progress.status || job.status,
              }
            : job
        )
      );
    });

    const cleanupComplete = window.electronAPI.onDownloadComplete((result) => {
      showToast(`Downloaded ${(result.outputPath || '').split('/').pop()}`, 'success');
    });

    const cleanupAllDone = window.electronAPI.onAllDownloadsComplete(() => {
      showToast('All downloads finished', 'success');
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
        showToast(`Skipped ${result.skipped} duplicate(s) — already in the queue`, 'warning');
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

  const handleRetryJob = async (jobId) => {
    try {
      if (window.electronAPI.retryJob) await window.electronAPI.retryJob(jobId);
    } catch (err) {
      showToast(`Failed to retry job: ${err.message}`, 'error');
    }
  };

  const handleRemoveJob = async (jobId) => {
    try {
      if (window.electronAPI.removeJob) {
        await window.electronAPI.removeJob(jobId);
        setQueue((prev) => prev.filter((j) => j.id !== jobId));
      }
    } catch (err) {
      showToast(`Failed to remove job: ${err.message}`, 'error');
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

  const handleShowInFolder = async (filePath) => {
    try {
      await window.electronAPI.showInFolder(filePath);
    } catch (err) {
      showToast(`Failed to open file location: ${err.message}`, 'error');
    }
  };

  const handleCloseMetadata = () => {
    setShowMetadata(false);
    setSelectedFile(null);
  };

  const hasQueue = queue.length > 0;
  const completedCount = queue.filter((j) => j.status === 'Complete' && j.outputPath).length;

  return (
    <div className="app-container">
      <div className={`center-section${hasQueue ? ' has-queue' : ''}`}>
        {!hasQueue && (
          <>
            <div className="center-title">Download audio from YouTube</div>
            <p className="hero-sub">Paste a link. Get a tagged Opus file.</p>
          </>
        )}
        <UrlInput onStartDownloads={handleStartDownloads} />
      </div>

      <div className="queue-section">
        <QueuePanel
          queue={queue}
          onCancelAll={handleCancelAll}
          onCancelJob={handleCancelJob}
          onRetryJob={handleRetryJob}
          onRemoveJob={handleRemoveJob}
          onEditFile={handleEditDownloadedFile}
          onShowInFolder={handleShowInFolder}
          thumbUrlFor={(job) => job?.thumbnailUrl || ''}
        />
      </div>

      {showClearConfirm && (
        <div className="modal-overlay" onClick={(e) => {
          if (e.target === e.currentTarget) setShowClearConfirm(false);
        }}>
          <div className="modal-dialog modal-dialog-narrow" role="dialog" aria-modal="true" aria-label="Clear downloads">
            <div className="confirm-dialog">
              <h3 className="confirm-title">
                Clear downloads?
              </h3>
              <p className="confirm-text">
                {completedCount > 0
                  ? `There ${completedCount === 1 ? 'is' : 'are'} ${completedCount} completed download(s) with audio files on disk.`
                  : 'No completed downloads with files to clean up.'}
              </p>
              <div className="confirm-actions">
                <div className="confirm-row">
                  <button
                    className="btn btn-ghost btn-block"
                    onClick={() => setShowClearConfirm(false)}
                    disabled={clearing}
                  >
                    Cancel
                  </button>
                  <button
                    className="btn btn-secondary btn-block"
                    onClick={() => handleClearConfirm(false)}
                    disabled={clearing}
                  >
                    {clearing ? 'Clearing…' : 'Clear list'}
                  </button>
                </div>
                {completedCount > 0 && (
                  <button
                    className="btn btn-danger btn-block confirm-danger"
                    onClick={() => handleClearConfirm(true)}
                    disabled={clearing}
                  >
                    {clearing ? 'Clearing…' : 'Clear and delete files'}
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      <div className="bottom-bar">
        <div className="bottom-bar-left">
          <button className="btn-icon" onClick={handleOpenFile} aria-label="Open file">
            <FolderIcon size={16} />
            <span className="btn-icon-text">Open file</span>
          </button>
        </div>
        <div className="bottom-bar-right">
          <button className="btn-icon" onClick={toggleTheme} aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`} title="Toggle theme">
            {theme === 'dark' ? <SunIcon size={16} /> : <MoonIcon size={16} />}
            <span className="btn-icon-text">{theme === 'dark' ? 'Light' : 'Dark'}</span>
          </button>
        </div>
      </div>

      {showMetadata && (
        <div className="modal-overlay" onClick={(e) => {
          if (e.target === e.currentTarget) {
            if (typeof window !== 'undefined' && window.__stowRequestMetadataClose) window.__stowRequestMetadataClose();
            else handleCloseMetadata();
          }
        }}>
          <div className="modal-dialog modal-dialog-wide" role="dialog" aria-modal="true" aria-label="Metadata editor">
            <MetadataEditor
              filePath={selectedFile}
              onClose={handleCloseMetadata}
              showToast={showToast}
            />
          </div>
        </div>
      )}

      {toast && (
        <div className="toast-stack" aria-live="polite">
          <div className={`toast ${toast.type}`} role="status">
            <span className="toast-dot" aria-hidden="true" />
            <span className="toast-msg">{toast.message}</span>
            <button className="toast-close" onClick={dismissToast} aria-label="Dismiss notification">
              <XIcon size={14} />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
