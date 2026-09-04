import React, { useState } from 'react';

export default function UrlInput({ onStartDownloads }) {
  const [urls, setUrls] = useState('');
  const [isLoading, setIsLoading] = useState(false);

  const handleSubmit = async () => {
    const urlList = urls
      .split('\n')
      .map((u) => u.trim())
      .filter((u) => u.length > 0);

    if (urlList.length === 0) return;

    setIsLoading(true);
    try {
      await onStartDownloads(urlList);
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
      <div className="url-input-container">
        <textarea
          className="url-textarea"
          placeholder="Paste YouTube URLs here (one per line)..."
          value={urls}
          onChange={(e) => setUrls(e.target.value)}
          onKeyDown={handleKeyDown}
          rows={2}
          disabled={isLoading}
        />
        <button
          className="btn btn-primary"
          onClick={handleSubmit}
          disabled={isLoading || urls.trim().length === 0}
        >
          {isLoading ? 'Adding...' : 'Download All'}
        </button>
      </div>
    </div>
  );
}