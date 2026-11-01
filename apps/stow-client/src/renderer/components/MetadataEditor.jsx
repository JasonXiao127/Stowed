import React, { useState, useEffect, useCallback, useRef } from 'react';
import { XIcon } from '@stowed/shared-ui';

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
  const [isSaving, setIsSaving] = useState(false);
  const [loadError, setLoadError] = useState(null);
  const coverArtUrlRef = useRef(null);
  const reqIdRef = useRef(0);
  const mountedRef = useRef(true);
  const initialTagsRef = useRef(EMPTY_TAGS);

  // Track mount state to avoid setting state on unmounted component
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  // Revoke previous object URL to avoid memory leaks
  const revokeCoverArtUrl = useCallback(() => {
    if (coverArtUrlRef.current) {
      URL.revokeObjectURL(coverArtUrlRef.current);
      coverArtUrlRef.current = null;
    }
  }, []);

  const makeCoverArtUrl = useCallback((art) => {
    if (!art || !art.data) return null;
    // art.data is a Uint8Array from IPC (structured clone)
    try {
      const blob = new Blob([art.data], { type: art.format });
      const url = URL.createObjectURL(blob);
      return url;
    } catch (err) {
      console.error('[MetadataEditor] Failed to create Blob URL:', err);
      return null;
    }
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
    // file's tags or cover while the new file loads.
    setTags({ ...EMPTY_TAGS });
    setCoverArt(null);
    setCoverArtUrl(null);
    revokeCoverArtUrl();
    try {
      const result = await window.electronAPI.readMetadata(path);
      if (!mountedRef.current || reqIdRef.current !== reqId) return; // stale

      setTags({ ...EMPTY_TAGS, ...(result.tags || {}) });
      initialTagsRef.current = { ...EMPTY_TAGS, ...(result.tags || {}) };

      const art = result.coverArt || null;
      setCoverArt(art);

      if (art) {
        const url = makeCoverArtUrl(art);
        if (url) {
          coverArtUrlRef.current = url;
          setCoverArtUrl(url);
        } else {
          setCoverArtUrl(null);
        }
      } else {
        setCoverArtUrl(null);
      }
    } catch (err) {
      if (!mountedRef.current || reqIdRef.current !== reqId) return;
      console.error('[MetadataEditor] loadMetadata error:', err);
      // Keep the form hidden until a successful load: saving the empty
      // defaults over a file whose real tags failed to read would wipe them.
      setLoadError(err.message || 'Failed to read metadata');
      showToast(`Failed to read metadata: ${err.message}`, 'error');
    } finally {
      if (mountedRef.current && reqIdRef.current === reqId) {
        setIsLoading(false);
      }
    }
  }, [showToast, revokeCoverArtUrl, makeCoverArtUrl]);

  // Cleanup object URL on unmount
  useEffect(() => {
    return () => revokeCoverArtUrl();
  }, [revokeCoverArtUrl]);

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
    if (!filePath || loadError) return;

    setIsSaving(true);
    try {
      await window.electronAPI.writeMetadata(filePath, tags, null);
      initialTagsRef.current = { ...tags };
      showToast('Metadata saved', 'success');
    } catch (err) {
      showToast(`Failed to save metadata: ${err.message}`, 'error');
    } finally {
      setIsSaving(false);
    }
  };

  const handleChangeThumbnail = async () => {
    if (loadError) return;
    try {
      const imagePath = await window.electronAPI.openImageDialog();
      if (imagePath) {
        setIsSaving(true);
        await window.electronAPI.writeMetadata(filePath, tags, imagePath);
        // Show success toast BEFORE reloading metadata to avoid double-toast risk
        showToast('Cover art updated', 'success');
        // Clear current cover art so it doesn't flash stale image during reload
        setCoverArtUrl(null);
        setCoverArt(null);
        revokeCoverArtUrl();
        await loadMetadata(filePath);
      }
    } catch (err) {
      showToast(`Failed to update thumbnail: ${err.message}`, 'error');
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <>
      {/* Modal Header */}
      <div className="modal-header">
        <div className="modal-title-wrap">
          <h2 title={filePath}>{(filePath || '').split('/').filter(Boolean).pop() || 'Metadata'}</h2>
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
            <div className="metadata-content">
              {/* File Path */}
              <div className="file-selector">
                <div className="file-path" title={filePath}>
                  {filePath}
                </div>
              </div>

              {/* Thumbnail */}
              <div className="thumbnail-container">
                {coverArtUrl ? (
                  <img
                    className="thumbnail-image"
                    src={coverArtUrl}
                    alt="Cover Art"
                  />
                ) : (
                  <div className="thumbnail-placeholder">No Cover Art</div>
                )}
                <button
                  className="btn btn-secondary btn-small"
                  onClick={handleChangeThumbnail}
                  disabled={isSaving}
                >
                  Change Thumbnail
                </button>
              </div>

              {/* Metadata Form */}
              <div className="metadata-form">
                <div className="form-group">
                  <label className="form-label">Title</label>
                  <input
                    className="form-input"
                    type="text"
                    value={tags.title}
                    onChange={handleChange('title')}
                    placeholder="Song Title"
                  />
                </div>

                <div className="form-group">
                  <label className="form-label">Artist</label>
                  <input
                    className="form-input"
                    type="text"
                    value={tags.artist}
                    onChange={handleChange('artist')}
                    placeholder="Artist Name"
                  />
                </div>

                <div className="form-group">
                  <label className="form-label">Album</label>
                  <input
                    className="form-input"
                    type="text"
                    value={tags.album}
                    onChange={handleChange('album')}
                    placeholder="Album Name"
                  />
                </div>

                <div className="form-group">
                  <label className="form-label">Track</label>
                  <input
                    className="form-input"
                    type="text"
                    value={tags.track}
                    onChange={handleChange('track')}
                    placeholder="Track Number"
                  />
                </div>

                <div className="form-group">
                  <label className="form-label">Genre</label>
                  <input
                    className="form-input"
                    type="text"
                    value={tags.genre}
                    onChange={handleChange('genre')}
                    placeholder="Genre"
                  />
                </div>

                <div className="form-group">
                  <label className="form-label">Year</label>
                  <input
                    className="form-input"
                    type="text"
                    value={tags.year}
                    onChange={handleChange('year')}
                    placeholder="Year"
                  />
                </div>

                <div className="form-actions">
                  <button
                    className="btn btn-primary"
                    onClick={handleSave}
                    disabled={isSaving || JSON.stringify(tags) === JSON.stringify(initialTagsRef.current)}
                  >
                    {isSaving ? 'Saving…' : 'Save changes'}
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </>
  );
}