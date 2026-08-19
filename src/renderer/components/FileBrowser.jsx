import React, { useState, useEffect, useCallback } from 'react';
import api from '../api';

/**
 * Server-side file browser used in place of the desktop app's native
 * "Open File" dialog. Lists the audio files in the configured download
 * directory (and its subfolders) and lets the user open one in the metadata
 * editor.
 */
export default function FileBrowser({ onSelect, onClose }) {
  const [dir, setDir] = useState('');
  const [parent, setParent] = useState(null);
  const [entries, setEntries] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const load = useCallback((targetDir) => {
    setLoading(true);
    setError(null);
    api
      .listFiles(targetDir)
      .then((data) => {
        setDir(data.dir);
        setParent(data.parent);
        setEntries(data.entries);
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const audioCount = entries.filter((e) => e.isAudio).length;

  return (
    <>
      <div className="modal-header">
        <h2>Open File</h2>
        <button className="modal-close-btn" onClick={onClose}>✕</button>
      </div>

      <div className="modal-body">
        <div className="file-browser-path" title={dir || '(downloads)'}>
          {dir || '(downloads)'}
        </div>

        {error && <div className="metadata-empty"><div>{error}</div></div>}

        {loading ? (
          <div className="metadata-empty"><div>Loading…</div></div>
        ) : (
          <div className="file-browser-list">
            {parent && (
              <button
                className="file-browser-item dir"
                onClick={() => load(parent)}
              >
                <span className="fb-icon">📁</span>
                <span className="fb-name">..</span>
              </button>
            )}
            {entries.map((entry) =>
              entry.isDirectory ? (
                <button
                  key={entry.path}
                  className="file-browser-item dir"
                  onClick={() => load(entry.path)}
                >
                  <span className="fb-icon">📁</span>
                  <span className="fb-name">{entry.name}</span>
                </button>
              ) : (
                <button
                  key={entry.path}
                  className="file-browser-item file"
                  disabled={!entry.isAudio}
                  title={entry.isAudio ? 'Open in Metadata Editor' : 'Not an audio file'}
                  onClick={() => onSelect(entry.path)}
                >
                  <span className="fb-icon">{entry.isAudio ? '🎵' : '📄'}</span>
                  <span className="fb-name">{entry.name}</span>
                  {!entry.isAudio && <span className="fb-tag">unsupported</span>}
                </button>
              )
            )}
            {entries.length === 0 && (
              <div className="metadata-empty"><div>No files in this folder.</div></div>
            )}
          </div>
        )}

        {audioCount > 0 && (
          <div className="file-browser-foot">
            {audioCount} audio file(s) — click one to edit its metadata.
          </div>
        )}
      </div>
    </>
  );
}
