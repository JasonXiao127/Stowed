import React, { useState } from 'react';

export default function UrlInput({ onStartDownloads }) {
  const [urls, setUrls] = useState('');
  const [isLoading, setIsLoading] = useState(false);

  const lines = urls
    .split('\n')
    .map((u) => u.trim())
    .filter((u) => u.length > 0);
  const count = lines.length;

  const handleSubmit = async () => {
    if (lines.length === 0 || isLoading) return;
    setIsLoading(true);
    try {
      await onStartDownloads(lines);
      setUrls('');
    } catch (err) {
      console.error('Failed to start downloads:', err);
    } finally {
      setIsLoading(false);
    }
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      handleSubmit();
    }
  };

  return (
    <div className="url-section">
      <div className="url-input-container composer">
        <textarea
          className="url-textarea"
          aria-label="Links, one per line"
          placeholder="Paste links, one per line"
          value={urls}
          onChange={(e) => setUrls(e.target.value)}
          onKeyDown={handleKeyDown}
          rows={3}
          disabled={isLoading}
        />
        <button
          className="btn btn-primary composer-btn"
          onClick={handleSubmit}
          disabled={isLoading || count === 0}
        >
          {isLoading ? 'Adding…' : count > 0 ? `Download ${count}` : 'Download'}
        </button>
      </div>
      <p className="composer-hint">Ctrl/⌘ + Enter to start · saved as tagged Opus</p>
    </div>
  );
}
