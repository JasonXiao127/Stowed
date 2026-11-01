import React, { useState, useEffect, useCallback, useRef, Suspense, lazy } from 'react';
import { XIcon } from '@stowed/shared-ui';
import api from '../api';

const WaveformTrim = lazy(() => import('./WaveformTrim'));

const EMPTY_TAGS = {
  title: '',
  artist: '',
  album: '',
  track: '',
  genre: '',
  year: '',
};

export default function MetadataEditor({ filePath, onClose, showToast }) {
  const [tags, setTags] = useState(EMPTY_TAGS);
  const [coverArt, setCoverArt] = useState(null);
  const [coverArtUrl, setCoverArtUrl] = useState(null);
  const [isLoading, setIsLoading] = useState(false);
  const [loadError, setLoadError] = useState(null);
  const [isSaving, setIsSaving] = useState(false);
  const [mbResults, setMbResults] = useState([]);
  const [mbLoading, setMbLoading] = useState(false);
  const [mbPreviewId, setMbPreviewId] = useState(null);
  const [trimCount, setTrimCount] = useState(0);
  const [activeTab, setActiveTab] = useState('details');
  const [chapters, setChapters] = useState([]);
  const isOpusFile = /\.opus$|\.ogg$/i.test(filePath || '');
  // WAV / raw AAC / WebM cannot carry embedded cover art (the API rejects
  // those uploads with a 400), so the picker is disabled for them instead of
  // letting the save fail.
  const coverSupported = /\.(mp3|m4a|mp4|flac|opus|ogg|oga)$/i.test(filePath || '');
  const baseName = (filePath || '').split('/').filter(Boolean).pop() || 'Metadata';
  const dirPath = filePath && filePath.lastIndexOf('/') > 0
    ? filePath.slice(0, filePath.lastIndexOf('/'))
    : '';
  const mountedRef = useRef(true);
  const reqIdRef = useRef(0);
  const mbReqIdRef = useRef(0);
  const fileInputRef = useRef(null);
  const initialTagsRef = useRef(EMPTY_TAGS);
  const isDirty = JSON.stringify(tags) !== JSON.stringify(initialTagsRef.current);

  // Track mount state to avoid setting state on unmounted component
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const loadMetadata = useCallback(async (path) => {
    if (!path) return;

    // Ignore stale responses when the user switches files mid-load, so an
    // older file's tags can never overwrite the newly selected file.
    const reqId = reqIdRef.current + 1;
    reqIdRef.current = reqId;
    setIsLoading(true);
    setLoadError(null);
    // Clear stale state so switching files never flashes the previous
    // file's tags, cover, or MB matches while the new file loads.
    setTags({ ...EMPTY_TAGS });
    setMbResults([]);
    setCoverArt(null);
    setCoverArtUrl(null);
    setMbPreviewId(null);
    try {
      const result = await api.readMetadata(path);
      if (!mountedRef.current || reqIdRef.current !== reqId) return;

      setTags({ ...EMPTY_TAGS, ...(result.tags || {}) });
      initialTagsRef.current = { ...EMPTY_TAGS, ...(result.tags || {}) };
      setChapters(Array.isArray(result.chapters) ? result.chapters : []);

      const art = result.coverArt || null;
      setCoverArt(art);

      // Cover art is served as an image by /api/cover; add a timestamp to
      // bust the browser cache after an edit. Use the keyed URL so the
      // image loads when STOW_API_KEY is set (<img> can't send headers).
      setCoverArtUrl(art ? `${api.coverUrlWithKey(path)}&t=${Date.now()}` : null);
    } catch (err) {
      if (!mountedRef.current || reqIdRef.current !== reqId) return;
      console.error('[MetadataEditor] loadMetadata error:', err);
      setLoadError(err.message || 'Failed to read metadata');
      showToast(`Failed to read metadata: ${err.message}`, 'error');
    } finally {
      if (mountedRef.current && reqIdRef.current === reqId) {
        setIsLoading(false);
      }
    }
  }, [showToast]);

  useEffect(() => {
    loadMetadata(filePath);
  }, [filePath, loadMetadata]);

  // One guarded close for Escape, backdrop click, and Close button.
  const requestClose = useCallback(() => {
    const dirty = JSON.stringify(tags) !== JSON.stringify(initialTagsRef.current);
    if (dirty && !window.confirm('Discard unsaved tag changes?')) return;
    onClose?.();
  }, [tags, onClose]);

  useEffect(() => {
    window.__stowRequestMetadataClose = requestClose;
    return () => {
      if (window.__stowRequestMetadataClose === requestClose) {
        delete window.__stowRequestMetadataClose;
      }
    };
  }, [requestClose]);

  // Escape closes the editor, but warns when there are unsaved tag edits.
  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      requestClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [requestClose]);

  const handleChange = (field) => (e) => {
    setTags((prev) => ({ ...prev, [field]: e.target.value }));
  };

  const handleSave = async () => {
    if (!filePath) return;

    setIsSaving(true);
    const saveReqId = reqIdRef.current;
    try {
      await api.writeMetadata(filePath, tags);
      if (!mountedRef.current || reqIdRef.current !== saveReqId) return;
      initialTagsRef.current = { ...tags };
      setMbPreviewId(null);
      showToast('Metadata saved', 'success');
    } catch (err) {
      if (!mountedRef.current) return;
      showToast(`Failed to save metadata: ${err.message}`, 'error');
    } finally {
      if (mountedRef.current) setIsSaving(false);
    }
  };

  const triggerThumbnailPicker = () => {
    if (fileInputRef.current) fileInputRef.current.click();
  };

  const handleMbLookup = async () => {
    if (!tags.title?.trim() && !tags.artist?.trim()) {
      showToast('Enter a title or artist before looking up', 'warning');
      return;
    }
    const lookupId = mbReqIdRef.current + 1;
    mbReqIdRef.current = lookupId;
    // Capture the file path at lookup time; ignore the response if the user
    // switched files while the request was in flight.
    const lookupPath = filePath;
    setMbLoading(true);
    try {
      const res = await api.mbSearch({
        title: tags.title?.trim(),
        artist: tags.artist?.trim(),
        album: tags.album?.trim(),
        limit: 5,
      });
      if (!mountedRef.current || mbReqIdRef.current !== lookupId || filePath !== lookupPath) return;
      const results = (res && res.results) || [];
      setMbResults(results.slice(0, 5));
      if (!results.length) showToast('No MusicBrainz matches found', 'warning');
    } catch (err) {
      if (!mountedRef.current || mbReqIdRef.current !== lookupId || filePath !== lookupPath) return;
      setMbResults([]);
      showToast(`MusicBrainz lookup failed: ${err.message}`, 'error');
    } finally {
      if (mountedRef.current && mbReqIdRef.current === lookupId && filePath === lookupPath) setMbLoading(false);
    }
  };

  const handleMbPick = (r) => {
    setTags((prev) => ({
      ...prev,
      title: r.title || prev.title,
      artist: r.artist || prev.artist,
      album: r.album || prev.album,
      year: r.year || prev.year,
    }));
    if (r.releaseId) {
      setCoverArtUrl(api.mbCoverUrl(r.releaseId));
      setMbPreviewId(r.releaseId);
    }
  };

  const handleMbUseCover = async (r) => {
    if (!r.releaseId) return;
    const coverPath = filePath;
    const coverReqId = reqIdRef.current;
    let coverRes;
    try {
      coverRes = await fetch(api.mbCoverUrl(r.releaseId));
    } catch (err) {
      if (mountedRef.current) showToast(`Cover fetch failed: ${err.message}`, 'error');
      return;
    }
    if (!coverRes.ok) {
      if (mountedRef.current) {
        if (coverRes.status === 401 || coverRes.status === 403) {
          showToast('API key rejected — re-enter it in Settings', 'error');
        } else {
          showToast(coverRes.status === 404 ? 'No cover art for this release' : `Cover fetch failed (${coverRes.status})`, 'warning');
        }
      }
      return;
    }
    let file;
    try {
      const blob = await coverRes.blob();
      file = new File([blob], 'cover.jpg', { type: blob.type || 'image/jpeg' });
    } catch (err) {
      if (mountedRef.current) showToast(`Cover fetch failed: ${err.message}`, 'error');
      return;
    }
    // The user may have switched files while the cover was downloading —
    // never write a fetched cover to the wrong file.
    if (!mountedRef.current || filePath !== coverPath || reqIdRef.current !== coverReqId) return;
    // Snapshot the tags at write time so concurrent edits are not lost.
    const tagsAtWrite = { ...tags };
    try {
      await api.writeMetadata(coverPath, tagsAtWrite, file);
      if (!mountedRef.current || filePath !== coverPath) return;
      showToast('Cover art saved', 'success');
      setCoverArtUrl(null);
      setMbPreviewId(null);
      await loadMetadata(coverPath);
    } catch (err) {
      const msg = err && err.message ? err.message : String(err);
      showToast(`Failed to save cover: ${msg}`, 'error');
    }
  };

  const handleThumbnailChange = async (e) => {
    const file = e.target.files && e.target.files[0];
    // Reset the input so re-selecting the same file still fires change.
    e.target.value = '';
    if (!file) return;

    const thumbPath = filePath;
    const thumbReqId = reqIdRef.current;
    const tagsAtWrite = { ...tags };
    try {
      setIsSaving(true);
      await api.writeMetadata(thumbPath, tagsAtWrite, file);
      if (!mountedRef.current || filePath !== thumbPath || reqIdRef.current !== thumbReqId) return;
      // Show success toast BEFORE reloading metadata to avoid double-toast risk
      showToast('Cover art updated', 'success');
      // Clear current cover art so it doesn't flash stale image during reload
      setCoverArtUrl(null);
      setCoverArt(null);
      await loadMetadata(filePath);
    } catch (err) {
      if (!mountedRef.current) return;
      showToast(`Failed to update thumbnail: ${err.message}`, 'error');
    } finally {
      if (mountedRef.current) setIsSaving(false);
    }
  };

  return (
    <>
      {/* Modal Header */}
      <div className="modal-header">
        <div className="modal-title-wrap">
          <h2 title={filePath}>{baseName}</h2>
          {dirPath && <div className="modal-subtitle" title={filePath}>{dirPath}</div>}
        </div>
        <button className="modal-close-btn" onClick={requestClose} aria-label="Close metadata editor"><XIcon size={16} /></button>
      </div>

      {/* Modal Body */}
      <div className="modal-body">
        {!filePath ? (
          <div className="metadata-empty">
            <div>No file selected</div>
            <div className="sub">
              Open an audio file to edit its metadata.
            </div>
          </div>
        ) : isLoading ? (
          <div className="metadata-empty">
            <div>Loading metadata...</div>
          </div>
        ) : loadError ? (
          <div className="metadata-empty">
            <div>Failed to read metadata</div>
            <div className="sub">{loadError}</div>
            <div className="form-actions form-actions-save">
              <button
                className="btn btn-secondary btn-small"
                onClick={() => loadMetadata(filePath)}
              >
                Retry
              </button>
            </div>
          </div>
        ) : (
          <div className="metadata-panel">
            <div className="metadata-tabs segmented" role="tablist" aria-label="Metadata sections">
              {['details', 'artwork', 'trim', 'chapters'].map((t) => (
                <button
                  key={t}
                  role="tab"
                  aria-selected={activeTab === t}
                  className={activeTab === t ? 'active' : ''}
                  onClick={() => setActiveTab(t)}
                >
                  {t === 'details' ? 'Details' : t === 'artwork' ? 'Artwork' : t === 'trim' ? 'Trim' : `Chapters${chapters.length ? ` (${chapters.length})` : ''}`}
                </button>
              ))}
            </div>
            <div className="metadata-content">
              {activeTab === 'artwork' && (
              <div className="cover-card">
                <div className="cover-thumb">
                  {coverArtUrl ? (
                    <img
                      className="thumbnail-image"
                      src={coverArtUrl}
                      alt="Cover Art"
                      onError={() => setCoverArtUrl(null)}
                    />
                  ) : (
                    <div className="thumbnail-placeholder">No Cover Art</div>
                  )}
                </div>
                <div className="cover-side">
                  {mbPreviewId && coverArtUrl ? (
                    <div className="form-hint form-hint-left">
                      Preview from MusicBrainz — not saved yet. Use Save cover to keep it.
                    </div>
                  ) : !coverSupported ? (
                    <div className="form-hint form-hint-left">
                      This file format cannot store cover art — tags still save.
                    </div>
                  ) : (
                    <div className="form-hint form-hint-left">
                      JPG, PNG, WebP, BMP or GIF, up to 10 MB.
                    </div>
                  )}
                  <button
                    className="btn btn-secondary btn-small"
                    onClick={triggerThumbnailPicker}
                    disabled={isSaving || isLoading || !coverSupported}
                    title={coverSupported ? 'Choose a cover image' : 'Cover art cannot be embedded in this file format'}
                  >
                    Change Cover Art
                  </button>
                </div>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/jpeg,image/png,image/webp,image/bmp,image/gif"
                  className="hidden-input"
                  onChange={handleThumbnailChange}
                />
              </div>
              )}

              {activeTab === 'details' && (
              <>
              {/* Details */}
              <h3 className="section-title">Details</h3>
              <div className="metadata-form">
                <div className="form-group full">
                  <label className="form-label" htmlFor="meta-title">Title</label>
                  <input
                    id="meta-title"
                    className="form-input"
                    type="text"
                    value={tags.title}
                    onChange={handleChange('title')}
                    placeholder="Song title"
                  />
                </div>

                <div className="form-group">
                  <label className="form-label" htmlFor="meta-artist">Artist</label>
                  <input
                    id="meta-artist"
                    className="form-input"
                    type="text"
                    value={tags.artist}
                    onChange={handleChange('artist')}
                    placeholder="Artist name"
                  />
                </div>

                <div className="form-group">
                  <label className="form-label" htmlFor="meta-album">Album</label>
                  <input
                    id="meta-album"
                    className="form-input"
                    type="text"
                    value={tags.album}
                    onChange={handleChange('album')}
                    placeholder="Album name"
                  />
                </div>

                <div className="form-group">
                  <label className="form-label" htmlFor="meta-track">Track</label>
                  <input
                    id="meta-track"
                    className="form-input"
                    type="text"
                    value={tags.track}
                    onChange={handleChange('track')}
                    placeholder="Track number"
                  />
                </div>

                <div className="form-group">
                  <label className="form-label" htmlFor="meta-genre">Genre</label>
                  <input
                    id="meta-genre"
                    className="form-input"
                    type="text"
                    value={tags.genre}
                    onChange={handleChange('genre')}
                    placeholder="Genre"
                  />
                </div>

                <div className="form-group full">
                  <label className="form-label" htmlFor="meta-year">Year</label>
                  <input
                    id="meta-year"
                    className="form-input"
                    type="text"
                    value={tags.year}
                    onChange={handleChange('year')}
                    placeholder="Year"
                  />
                </div>

                <div className="form-actions mb-lookup-row">
                  <button
                    className="btn btn-secondary btn-small"
                    onClick={handleMbLookup}
                    disabled={isSaving || isLoading || mbLoading}
                  >
                    {mbLoading ? 'Searching...' : 'Search MusicBrainz'}
                  </button>
                  <span className="form-hint form-hint-left">
                    Optional — auto-fill title, artist, album and year, or type them yourself.
                  </span>
                </div>

                {mbResults.length > 0 && (
                  <>
                    <h3 className="section-title">MusicBrainz matches</h3>
                    <ul className="mb-results">
                      {mbResults.map((r, idx) => (
                        <li
                          key={r.recordingId || r.releaseId || `${r.title}-${r.artist}-${idx}`}
                          className="mb-result"
                        >
                          <span className="fb-name">
                            {r.title} — {r.artist}
                            {r.album ? ` [${r.album}${r.year ? ` (${r.year})` : ''}]` : ''}
                          </span>
                          {typeof r.score === 'number' && (
                            <span className="mb-result-score" title="MusicBrainz match score" aria-label={`Match score ${r.score}`}>{r.score}</span>
                          )}
                          <span className="mb-result-actions">
                            <button
                              className="btn btn-secondary btn-small"
                              onClick={() => handleMbPick(r)}
                              title={`Fill tags from ${r.title} — ${r.artist}`}
                              disabled={isSaving || isLoading}
                            >
                              Apply
                            </button>
                            {r.releaseId && (
                              <button
                                className="btn btn-secondary btn-small"
                                onClick={() => handleMbUseCover(r)}
                                title={`Save cover art from ${r.album || r.title}`}
                                disabled={isSaving || isLoading}
                              >
                                Save cover
                              </button>
                            )}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </>
                )}

              </div>
              </>
              )}

              {activeTab === 'trim' && (
              <>
              {/* Trim re-encodes to Opus in place, so the UI is gated to
                  Opus/Ogg even though the API accepts any audio file. */}
              {filePath && !isLoading && !loadError && isOpusFile && (
                <Suspense fallback={<div className="waveform-loading">Loading trim editor...</div>}>
                  <WaveformTrim
                    key={`${filePath}#${trimCount}`}
                    filePath={filePath}
                    onTrimmed={() => { setTrimCount((c) => c + 1); loadMetadata(filePath); }}
                    showToast={showToast}
                  />
                </Suspense>
              )}
              {filePath && !isLoading && !loadError && !isOpusFile && (
                <div className="waveform-section">
                  <h3 className="section-title">Trim audio</h3>
                  <div className="waveform-fallback">
                    Trim is available for Opus/Ogg files. This file format is not supported for trimming.
                  </div>
                </div>
              )}
              </>
              )}

              {activeTab === 'chapters' && (
                <div className="waveform-section">
                  <h3 className="section-title">Chapters</h3>
                  {chapters.length === 0 ? (
                    <div className="waveform-fallback">
                      No embedded chapters found. Enable “Embed chapters” in Settings for future downloads.
                    </div>
                  ) : (
                    <ul className="chapter-list">
                      {chapters.map((c, i) => (
                        <li key={i}>
                          <span className="chapter-time">{Number(c.start).toFixed(1)}s</span>
                          <span>{c.title || `Chapter ${i + 1}`}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {filePath && !isLoading && !loadError && (
        <div className="modal-footer">
          <button
            className="btn btn-secondary"
            onClick={requestClose}
            disabled={isSaving}
          >
            Close
          </button>
          <button
            className="btn btn-primary"
            onClick={handleSave}
            disabled={isSaving || isLoading || !isDirty}
          >
            {isSaving ? 'Saving…' : 'Save changes'}
          </button>
        </div>
      )}
    </>
  );
}