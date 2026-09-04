import React, { useState, useEffect, useCallback, useRef } from 'react';

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
  const coverArtUrlRef = useRef(null);
  const mountedRef = useRef(true);

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

    setIsLoading(true);
    revokeCoverArtUrl();
    try {
      const result = await window.electronAPI.readMetadata(path);
      if (!mountedRef.current) return; // component unmounted during load

      setTags(result.tags || EMPTY_TAGS);

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
      if (!mountedRef.current) return;
      console.error('[MetadataEditor] loadMetadata error:', err);
      showToast(`Failed to read metadata: ${err.message}`, 'error');
    } finally {
      if (mountedRef.current) {
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

  const handleChange = (field) => (e) => {
    setTags((prev) => ({ ...prev, [field]: e.target.value }));
  };

  const handleSave = async () => {
    if (!filePath) return;

    setIsSaving(true);
    try {
      await window.electronAPI.writeMetadata(filePath, tags, null);
      showToast('Metadata saved successfully!', 'success');
    } catch (err) {
      showToast(`Failed to save metadata: ${err.message}`, 'error');
    } finally {
      setIsSaving(false);
    }
  };

  const handleChangeThumbnail = async () => {
    try {
      const imagePath = await window.electronAPI.openImageDialog();
      if (imagePath) {
        setIsSaving(true);
        await window.electronAPI.writeMetadata(filePath, tags, imagePath);
        // Show success toast BEFORE reloading metadata to avoid double-toast risk
        showToast('Thumbnail updated successfully!', 'success');
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
        <h2>Metadata Editor</h2>
        <button className="modal-close-btn" onClick={onClose}>✕</button>
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
                    disabled={isSaving}
                  >
                    {isSaving ? 'Saving...' : 'Save Metadata'}
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