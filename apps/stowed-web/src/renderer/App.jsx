import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useTheme, UrlInput, QueuePanel, SettingsIcon, SunIcon, MoonIcon, XIcon, NoteIcon } from '@stowed/shared-ui';
import MetadataEditor from './components/MetadataEditor';
import Library from './components/Library';
import InspectPanel from './components/InspectPanel';
import SettingsPanel from './components/SettingsPanel';
import PlayerBar from './components/PlayerBar';
import api from './api';

let toastId = 0;

export default function App() {
  const { theme, toggleTheme } = useTheme();
  const [queue, setQueue] = useState([]);
  const [selectedFile, setSelectedFile] = useState(null);
  const [showMetadata, setShowMetadata] = useState(false);
  const [showClearConfirm, setShowClearConfirm] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [toasts, setToasts] = useState([]);
  const [apiKeyInput, setApiKeyInput] = useState(api.getApiKey());
  const [libraryKey, setLibraryKey] = useState(0);
  const [nowPlaying, setNowPlaying] = useState(null);
  const timersRef = useRef(new Map());
  const settingsInputRef = useRef(null);

  const toArr = (value) => (Array.isArray(value) ? value : []);

  const dismissToast = useCallback((id) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
    const timer = timersRef.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timersRef.current.delete(id);
    }
  }, []);

  const showToast = useCallback((message, type = 'success') => {
    const id = ++toastId;
    setToasts((prev) => [...prev.slice(-2), { id, message, type }]);
    const timer = setTimeout(() => dismissToast(id), 4000);
    timersRef.current.set(id, timer);
  }, [dismissToast]);

  useEffect(() => {
    const timers = timersRef.current;
    return () => {
      timers.forEach((t) => clearTimeout(t));
      timers.clear();
    };
  }, []);

  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      if (showClearConfirm) setShowClearConfirm(false);
      else if (showSettings) setShowSettings(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [showClearConfirm, showSettings]);

  const settingsButtonRef = useRef(null);
  const wasSettingsOpen = useRef(false);
  useEffect(() => {
    if (showSettings) {
      wasSettingsOpen.current = true;
      const t = setTimeout(() => settingsInputRef.current?.focus?.(), 50);
      return () => clearTimeout(t);
    } else if (wasSettingsOpen.current) {
      wasSettingsOpen.current = false;
      settingsButtonRef.current?.focus?.();
    }
  }, [showSettings]);

  useEffect(() => {
    api.getQueue().then((q) => setQueue(toArr(q))).catch((err) => {
      console.error(err);
      showToast('Failed to load queue', 'error');
    });
  }, [showToast]);

  useEffect(() => {
    const cleanupAuth = api.onAuthRejected ? api.onAuthRejected(() => {
      showToast('API key rejected — re-enter it in Settings', 'error');
    }) : () => {};

    const cleanupQueue = api.onQueueUpdated((updatedQueue) => {
      setQueue(toArr(updatedQueue));
    });

    const cleanupProgress = api.onDownloadProgress((progress) => {
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

    const cleanupComplete = api.onDownloadComplete((result) => {
      showToast(`Downloaded ${(result.outputPath || '').split('/').pop()}`, 'success');
      setLibraryKey((k) => k + 1);
    });

    const cleanupAllDone = api.onAllDownloadsComplete(() => {
      showToast('All downloads finished', 'success');
      setLibraryKey((k) => k + 1);
    });

    return () => {
      cleanupAuth();
      cleanupQueue();
      cleanupProgress();
      cleanupComplete();
      cleanupAllDone();
    };
  }, [showToast]);

  const handleStartDownloads = async (urls) => {
    try {
      const result = await api.startDownloads(urls);
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
          const results = await api.deleteFiles(paths);
          const deleted = results.filter((r) => r.deleted).length;
          const failed = results.filter((r) => !r.deleted).length;
          if (deleted > 0 && failed === 0) {
            showToast(`Deleted ${deleted} audio file(s)`, 'success');
          } else if (deleted > 0) {
            showToast(`Deleted ${deleted} file(s), ${failed} could not be deleted`, 'warning');
          } else if (failed > 0) {
            showToast(`${failed} file(s) could not be deleted`, 'warning');
          }
        }
      }
      await api.cancelDownloads();
      setQueue([]);
      setLibraryKey((k) => k + 1);
    } catch (err) {
      showToast(`Failed to clear downloads: ${err.message}`, 'error');
    }
    setClearing(false);
  };

  const handleCancelJob = async (jobId) => {
    try {
      await api.cancelJob(jobId);
    } catch (err) {
      showToast(`Failed to cancel job: ${err.message}`, 'error');
    }
  };

  const handleRetryJob = async (jobId) => {
    try {
      await api.retryJob(jobId);
    } catch (err) {
      showToast(`Failed to retry job: ${err.message}`, 'error');
    }
  };

  const handleRemoveJob = async (jobId) => {
    try {
      await api.removeJob(jobId);
      setQueue((prev) => prev.filter((j) => j.id !== jobId));
    } catch (err) {
      showToast(`Failed to remove job: ${err.message}`, 'error');
    }
  };

  const thumbUrlFor = useCallback((job) => {
    if (job && job.thumbnailUrl) {
      try {
        return api.thumbUrl(job.thumbnailUrl);
      } catch (_) {
        return '';
      }
    }
    return '';
  }, []);

  const handleSaveApiKey = () => {
    const key = (apiKeyInput || '').trim();
    api.setApiKey(key);
    showToast(key ? 'API key saved' : 'API key cleared', 'success');
    setShowSettings(false);
  };

  const handleShowInFolder = (filePath) => {
    const win = api.openFile(filePath);
    if (!win) {
      showToast('Popup blocked — allow popups to download the file', 'warning');
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
  const completedCount = queue.filter((j) => j.status === 'Complete' && j.outputPath).length;

  return (
    <div className="app-container">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">
            <NoteIcon size={15} />
          </span>
          <span className="brand-name">Stow</span>
        </div>
        <div className="topbar-actions">
          <button
            ref={settingsButtonRef}
            className="btn-icon"
            onClick={() => setShowSettings(true)}
            aria-label="Settings"
            aria-expanded={showSettings}
            title="Settings"
          >
            <SettingsIcon size={16} />
            <span className="btn-icon-text">Settings</span>
          </button>
          <button
            className="btn-icon"
            onClick={toggleTheme}
            aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}
            title="Toggle theme"
          >
            {theme === 'dark' ? <SunIcon size={16} /> : <MoonIcon size={16} />}
          </button>
        </div>
      </header>

      <main className="main">
        {!hasQueue && (
          <section className="hero">
            <h1 className="hero-title">Download audio from YouTube</h1>
            <p className="hero-sub">Paste a link. Get a tagged Opus file.</p>
          </section>
        )}
        <UrlInput onStartDownloads={handleStartDownloads} />

        {hasQueue && (
          <QueuePanel
            queue={queue}
            onCancelAll={handleCancelAll}
            onCancelJob={handleCancelJob}
            onRetryJob={handleRetryJob}
            onRemoveJob={handleRemoveJob}
            onEditFile={handleEditDownloadedFile}
            onShowInFolder={handleShowInFolder}
            onPlayFile={setNowPlaying}
            thumbUrlFor={thumbUrlFor}
          />
        )}

        <InspectPanel showToast={showToast} onDownload={handleStartDownloads} />

        <Library onEdit={handleEditDownloadedFile} onDownload={handleShowInFolder} onPlay={setNowPlaying} reloadKey={libraryKey} />
      </main>

      <PlayerBar filePath={nowPlaying} onClose={() => setNowPlaying(null)} />

      {showSettings && (
        <div
          className="modal-overlay"
          onClick={(e) => { if (e.target === e.currentTarget) setShowSettings(false); }}
        >
          <div className="modal-dialog settings-dialog" role="dialog" aria-modal="true" aria-label="Settings">
            <div className="modal-header">
              <h2>Settings</h2>
              <button className="modal-close-btn" onClick={() => setShowSettings(false)} aria-label="Close settings">
                <XIcon size={16} />
              </button>
            </div>
            <div className="modal-body">
              <div className="settings-body">
                <section className="settings-section" aria-label="Access">
                  <h3 className="settings-section-title">Access</h3>
                  <label className="form-label" htmlFor="api-key-input">API key</label>
                  <div className="api-key-row">
                    <input
                      id="api-key-input"
                      ref={settingsInputRef}
                      className="form-input api-key-input"
                      type="password"
                      placeholder="Optional"
                      value={apiKeyInput}
                      onChange={(e) => setApiKeyInput(e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter') handleSaveApiKey(); }}
                      autoComplete="off"
                    />
                    <button className="btn btn-secondary btn-small" onClick={handleSaveApiKey}>
                      Save
                    </button>
                  </div>
                  <p className="form-hint">Only needed if STOW_API_KEY is set server-side.</p>
                </section>
                <SettingsPanel showToast={showToast} onClose={() => setShowSettings(false)} />
              </div>
            </div>
            <div className="modal-footer">
              <button className="btn btn-primary" onClick={() => setShowSettings(false)}>
                Done
              </button>
            </div>
          </div>
        </div>
      )}

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

      <div className="toast-stack" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.type}`} role="status">
            <span className={`toast-dot`} aria-hidden="true" />
            <span className="toast-msg">{t.message}</span>
            <button
              className="toast-close"
              onClick={() => dismissToast(t.id)}
              aria-label="Dismiss notification"
            >
              <XIcon size={14} />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
