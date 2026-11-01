import React, { useState, useEffect, useCallback, useRef } from 'react';
import { SearchIcon, ArrowUpIcon, ArrowDownIcon, ListIcon, GridIcon, PlayIcon, DownloadIcon, PencilIcon, FolderIcon, NoteIcon } from '@stowed/shared-ui';
import api from '../api';

export default function Library({ onEdit, onDownload, onPlay, reloadKey }) {
  const [view, setView] = useState(() => {
    try { return localStorage.getItem('stow-library-view') || 'list'; } catch (_) { return 'list'; }
  });
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState('name');
  const [order, setOrder] = useState('asc');
  const [offset, setOffset] = useState(0);
  const [dir, setDir] = useState('');
  const [dirName, setDirName] = useState('');
  const [parent, setParent] = useState(null);
  const [entries, setEntries] = useState([]);
  const [libEntries, setLibEntries] = useState([]);
  const [libTotal, setLibTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const requestRef = useRef(0);
  const dirRef = useRef('');
  const PAGE_SIZE = 200;

  const load = useCallback((targetDir) => {
    const id = requestRef.current + 1;
    requestRef.current = id;
    dirRef.current = targetDir || '';
    setLoading(true);
    setError(null);
    api
      .listFiles(targetDir)
      .then((data) => {
        if (requestRef.current !== id) return;
        setDir(data.dir);
        setDirName((data.dir || '').split('/').filter(Boolean).pop() || 'Downloads');
        setParent(data.parent);
        setEntries(data.entries);
      })
      .catch((err) => {
        if (requestRef.current !== id) return;
        setError(err.message);
        setEntries([]);
      })
      .finally(() => {
        if (requestRef.current === id) setLoading(false);
      });
  }, []);

  const loadLibrary = useCallback((q, s, o, off = 0, append = false) => {
    const id = requestRef.current + 1;
    requestRef.current = id;
    setLoading(true);
    setError(null);
    api
      .getLibrary({ q, sort: s, order: o, limit: PAGE_SIZE, offset: off })
      .then((data) => {
        if (requestRef.current !== id) return;
        if (append) {
          setLibEntries((prev) => [...prev, ...(data.entries || [])]);
        } else {
          setLibEntries(data.entries || []);
        }
        setLibTotal(data.total || 0);
      })
      .catch((err) => {
        if (requestRef.current !== id) return;
        setError(err.message);
        if (!append) setLibEntries([]);
      })
      .finally(() => {
        if (requestRef.current === id) setLoading(false);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (view === 'grid') { setOffset(0); loadLibrary(query, sort, order, 0, false); }
    else load('');
  }, [view, load, loadLibrary]);

  useEffect(() => {
    if (reloadKey > 0) {
      if (view === 'grid') { setOffset(0); loadLibrary(query, sort, order, 0, false); }
      else load(dirRef.current);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reloadKey, load, loadLibrary]);

  useEffect(() => {
    if (view !== 'grid') return;
    const t = setTimeout(() => { setOffset(0); loadLibrary(query, sort, order, 0, false); }, 250);
    return () => clearTimeout(t);
  }, [query, sort, order, view, loadLibrary]);

  const setViewMode = (v) => {
    setView(v);
    try { localStorage.setItem('stow-library-view', v); } catch (_) {}
  };

  const dirs = entries.filter((e) => e.isDirectory);
  const audio = entries.filter((e) => !e.isDirectory && e.isAudio);
  const paginated = libTotal > libEntries.length;
  const countLabel = view === 'grid'
    ? (paginated ? `Showing ${libEntries.length} of ${libTotal}` : `${libTotal} track${libTotal === 1 ? '' : 's'}`)
    : dirName;

  const fmtDur = (s) => {
    const n = Number(s);
    if (!Number.isFinite(n) || n < 0) return '';
    const m = Math.floor(n / 60);
    const sec = Math.floor(n % 60);
    return `${m}:${String(sec).padStart(2, '0')}`;
  };

  return (
    <section className="section library" aria-label="Library">
      <div className="section-header">
        <h2 className="section-title-main">Library <span className="count">{view === 'grid' ? `${libTotal} track${libTotal === 1 ? '' : 's'}` : dirName}</span></h2>
        <span className="segmented library-view-toggle" role="group" aria-label="Library view">
          <button
            className={view === 'list' ? 'active' : ''}
            onClick={() => setViewMode('list')}
            aria-pressed={view === 'list'}
          >
            <ListIcon size={15} />List
          </button>
          <button
            className={view === 'grid' ? 'active' : ''}
            onClick={() => setViewMode('grid')}
            aria-pressed={view === 'grid'}
          >
            <GridIcon size={15} />Grid
          </button>
        </span>
      </div>

      {view === 'grid' && (
        <div className="library-toolbar">
          <span className="library-search-wrap">
            <span className="search-icon" aria-hidden="true"><SearchIcon size={15} /></span>
            <input
              className="form-input library-search"
              placeholder="Search title, artist, album…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              aria-label="Search library"
            />
          </span>
          <select
            className="form-input library-sort"
            value={sort}
            onChange={(e) => { setOffset(0); setSort(e.target.value); }}
            aria-label="Sort library"
          >
            <option value="name">Name</option>
            <option value="artist">Artist</option>
            <option value="album">Album</option>
            <option value="year">Year</option>
            <option value="duration">Duration</option>
          </select>
          <button
            className="icon-btn"
            onClick={() => { const next = order === 'asc' ? 'desc' : 'asc'; setOrder(next); setOffset(0); loadLibrary(query, sort, next, 0, false); }}
            aria-label={`Sort order ${order === 'asc' ? 'ascending' : 'descending'}, activate to toggle`}
            title={`Order: ${order === 'asc' ? 'ascending' : 'descending'}`}
          >
            {order === 'asc' ? <ArrowUpIcon size={16} /> : <ArrowDownIcon size={16} />}
          </button>
        </div>
      )}

      {view === 'list' && parent && (
        <button className="file-browser-item dir" onClick={() => load(parent)}>
          <span className="fb-icon" aria-hidden="true"><FolderIcon size={15} /></span>
          <span className="fb-name">Up a folder</span>
        </button>
      )}

      {loading ? (
        <div className="library-empty"><div>Loading…</div></div>
      ) : error ? (
        <div className="library-empty">
          <div>{error}</div>
          <button className="btn btn-secondary btn-small" onClick={() => (view === 'grid' ? loadLibrary(query, sort, order, 0, false) : load(dir))}>
            Retry
          </button>
        </div>
      ) : view === 'grid' ? (
        libEntries.length === 0 ? (
          <div className="library-empty">
            <span className="library-empty-icon" aria-hidden="true"><NoteIcon size={28} /></span>
            <div className="library-empty-title">No tracks yet</div>
            <div>Paste a link above to get started.</div>
          </div>
        ) : (
          <>
          <ul className="library-grid">
            {libEntries.map((entry) => (
              <li key={entry.path} className="library-card">
                <button className="library-card-cover" onClick={() => onPlay?.(entry.path)} title={`Play ${entry.title}`} aria-label={`Play ${entry.title}`}>
                  {entry.hasCover ? (
                    <img src={api.coverUrlWithKey(entry.path)} alt="" loading="lazy" onError={(e) => { e.currentTarget.style.display = 'none'; }} />
                  ) : (
                    <span className="library-card-placeholder" aria-hidden="true"><NoteIcon size={28} /></span>
                  )}
                  <span className="library-card-play" aria-hidden="true"><PlayIcon size={16} /></span>
                </button>
                <div className="library-card-info">
                  <div className="library-card-title" title={entry.title}>{entry.title}</div>
                  <div className="library-card-sub" title={`${entry.artist || ''} — ${entry.album || ''}`}>
                    {[entry.artist, entry.album].filter(Boolean).join(' — ') || entry.name}
                  </div>
                </div>
                <div className="library-actions">
                  <button className="icon-btn" onClick={() => onEdit(entry.path)} title={`Edit ${entry.title}`} aria-label={`Edit ${entry.title}`}>
                    <PencilIcon size={15} />
                  </button>
                  <button className="icon-btn" onClick={() => onDownload(entry.path)} title={`Save ${entry.title}`} aria-label={`Save ${entry.title}`}>
                    <DownloadIcon size={15} />
                  </button>
                </div>
              </li>
            ))}
          </ul>
          {paginated && (
            <>
              <div className="library-count">{countLabel}</div>
              <div className="library-more">
                <button
                  className="btn btn-ghost"
                  onClick={() => {
                    const next = libEntries.length;
                    setOffset(next);
                    loadLibrary(query, sort, order, next, true);
                  }}
                >
                  Load more
                </button>
              </div>
            </>
          )}
          </>
        )
      ) : dirs.length === 0 && audio.length === 0 ? (
        <div className="library-empty">
          <span className="library-empty-icon" aria-hidden="true"><NoteIcon size={28} /></span>
          <div className="library-empty-title">No tracks yet</div>
          <div>Paste a link above to get started.</div>
        </div>
      ) : (
        <ul className="library-list library-rows-flat">
          {dirs.map((entry) => (
            <li key={entry.path}>
              <button
                className="file-browser-item dir"
                onClick={() => load(entry.path)}
              >
                <span className="fb-icon" aria-hidden="true"><FolderIcon size={15} /></span>
                <span className="fb-name">{entry.name}</span>
              </button>
            </li>
          ))}
          {audio.map((entry) => (
            <li key={entry.path} className="library-row">
              <button className="library-row-play" onClick={() => onPlay?.(entry.path)} title={`Play ${entry.name}`} aria-label={`Play ${entry.name}`}>
                <PlayIcon size={14} />
              </button>
              <span className="library-row-thumb" aria-hidden="true">
                {entry.hasCover ? (
                  <img src={api.coverUrlWithKey(entry.path)} alt="" loading="lazy" onError={(e) => { e.currentTarget.style.display = 'none'; }} />
                ) : (
                  <NoteIcon size={15} />
                )}
              </span>
              <span className="fb-name" title={entry.name}>{entry.name}</span>
              {entry.duration != null && entry.duration !== '' && (
                <span className="duration">{fmtDur(entry.duration)}</span>
              )}
              <span className="library-actions">
                <button
                  className="icon-btn"
                  onClick={() => onEdit(entry.path)}
                  title={`Edit metadata for ${entry.name}`}
                  aria-label={`Edit ${entry.name}`}
                >
                  <PencilIcon size={15} />
                </button>
                <button
                  className="icon-btn"
                  onClick={() => onDownload(entry.path)}
                  title={`Save ${entry.name}`}
                  aria-label={`Save ${entry.name}`}
                >
                  <DownloadIcon size={15} />
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
