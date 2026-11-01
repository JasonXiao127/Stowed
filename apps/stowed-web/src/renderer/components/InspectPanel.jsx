import React, { useState, useRef } from 'react';
import api from '../api';

function fmtDuration(sec) {
  const n = Number(sec);
  if (!Number.isFinite(n) || n < 0) return '';
  const m = Math.floor(n / 60);
  const s = Math.floor(n % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

export default function InspectPanel({ showToast, onDownload }) {
  const [url, setUrl] = useState('');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null);
  const [selected, setSelected] = useState(new Set());
  const reqIdRef = useRef(0);

  const entryKey = (e, i) => e?.url || e?.id || String(i);

  const inspect = async () => {
    const u = url.trim();
    if (!u || loading) return;
    const reqId = reqIdRef.current + 1;
    reqIdRef.current = reqId;
    setLoading(true);
    setResult(null);
    setSelected(new Set());
    try {
      const r = await api.inspectUrl(u, 20);
      if (reqIdRef.current !== reqId) return;
      setResult(r);
      if (r.type === 'playlist' && r.entries) {
        setSelected(new Set(r.entries.map((e, i) => entryKey(e, i)).filter(Boolean)));
      }
    } catch (err) {
      if (reqIdRef.current !== reqId) return;
      showToast?.(`Inspect failed: ${err.message}`, 'error');
    } finally {
      if (reqIdRef.current === reqId) setLoading(false);
    }
  };

  const toggle = (key) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const downloadSelected = async () => {
    const urls = [...selected];
    if (!urls.length) {
      showToast?.('Select at least one video', 'warning');
      return;
    }
    try {
      await onDownload?.(urls);
      setResult(null);
      setSelected(new Set());
      setUrl('');
    } catch (_) {}
  };

  const playlistCount = result?.count || result?.entries?.length || 0;

  return (
    <section className="section inspect-panel" aria-label="Preview">
      <div className="section-header">
        <h2 className="section-title-main">Preview</h2>
      </div>
      <p className="section-sub">Check a video or playlist before downloading.</p>
      <div className="inspect-row" style={{ marginTop: '12px' }}>
        <input
          className="form-input"
          placeholder="Paste a link to preview…"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') inspect(); }}
          aria-label="Preview URL"
        />
        <button className="btn btn-secondary" onClick={inspect} disabled={loading || !url.trim()}>
          {loading ? 'Checking…' : 'Preview'}
        </button>
      </div>
      {result && result.type === 'video' && (
        <div className="inspect-single">
          {result.thumbnail && (
            <img className="inspect-thumb" src={api.thumbUrl(result.thumbnail)} alt="" loading="lazy" onError={(e) => { e.currentTarget.style.display = 'none'; }} />
          )}
          <div className="inspect-info">
            <div className="inspect-title">{result.title}</div>
            <div className="inspect-sub">{[result.uploader, fmtDuration(result.duration)].filter(Boolean).join(' · ')}</div>
            <div className="inspect-actions">
              <button className="btn btn-primary btn-small" onClick={() => onDownload?.([result.url || url.trim()])}>
                Download
              </button>
            </div>
          </div>
        </div>
      )}
      {result && result.type === 'playlist' && (
        <div className="inspect-playlist">
          <div className="inspect-playlist-header">
            <span>
              <span className="inspect-playlist-title">{result.title}</span>{' '}
              <span className="inspect-playlist-count">
                {result.count && result.count > result.entries.length
                  ? `first ${result.entries.length} of ${result.count}`
                  : `${playlistCount} video${playlistCount === 1 ? '' : 's'}`}
              </span>
            </span>
            <span className="inspect-actions" style={{ marginTop: 0 }}>
              <button className="btn btn-ghost btn-small" onClick={() => setSelected(new Set(result.entries.map((e, i) => entryKey(e, i))))}>
                Select all
              </button>
              <button className="btn btn-ghost btn-small" onClick={() => setSelected(new Set())}>
                Clear
              </button>
              <button className="btn btn-primary btn-small" onClick={downloadSelected} disabled={selected.size === 0}>
                {selected.size > 0 ? `Download ${selected.size}` : 'Download'}
              </button>
            </span>
          </div>
          <ul className="inspect-list">
            {(result.entries || []).map((e, i) => {
              const key = entryKey(e, i);
              const checked = selected.has(key);
              return (
                <li key={key} className="inspect-item">
                  <label className="inspect-check">
                    <input type="checkbox" checked={checked} onChange={() => toggle(key)} aria-label={`Select ${e.title || key}`} />
                    {e.thumbnail && (
                      <img className="inspect-thumb-small" src={api.thumbUrl(e.thumbnail)} alt="" loading="lazy" onError={(ev) => { ev.currentTarget.style.display = 'none'; }} />
                    )}
                    <span className="inspect-item-info">
                      <span className="inspect-item-title">{e.title}</span>
                      <span className="inspect-item-sub">{[e.uploader, fmtDuration(e.duration)].filter(Boolean).join(' · ')}</span>
                    </span>
                  </label>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </section>
  );
}
