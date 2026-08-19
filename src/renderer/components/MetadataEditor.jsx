import React, { useState, useEffect, useCallback, useRef } from 'react';
import api from '../api';

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
  const mountedRef = useRef(true);
  const fileInputRef = useRef(null);

  // Track mount state to avoid setting state on unmounted component
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const loadMetadata = useCallback(async (path) => {
    if (!path) return;

    setIsLoading(true);
    setCoverArtUrl(null);
    try {
      const result = await api.readMetadata(path);
      if (!mountedRef.current) return; // component unmounted during load

      setTags(result.tags || EMPTY_TAGS);

      const art = result.coverArt || null;
      setCoverArt(art);

      // Cover art is served as an image by /api/cover; add a timestamp to
      // bust the browser cache after an edit.
      setCoverArtUrl(art ? `${api.coverUrl(path)}&t=${Date.now()}` : null);
    } catch (err) {
      if (!mountedRef.current) return;
      console.error('[MetadataEditor] loadMetadata error:', err);
      showToast(`Failed to read metadata: ${err.message}`, 'error');
    } finally {
      if (mountedRef.current) {
        setIsLoading(false);
      }
    }
  }, [showToast]);

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
      await api.writeMetadata(filePath, tags);
      showToast('Metadata saved successfully!', 'success');
    } catch (err) {
      showToast(`Failed to save metadata: ${err.message}`, 'error');
    } finally {
      setIsSaving(false);
    }
  };

  const triggerThumbnailPicker = () => {
    if (fileInputRef.current) fileInputRef.current.click();
  };

  const handleThumbnailChange = async (e) => {
    const file = e.target.files && e.target.files[0];
    // Reset the input so re-selecting the same file still fires change.
    e.target.value = '';
    if (!file) return;

    try {
      setIsSaving(true);
      await api.writeMetadata(filePath, tags, file);
      // Show success toast BEFORE reloading metadata to avoid double-toast risk
      showToast('Thumbnail updated successfully!', 'success');
      // Clear current cover art so it doesn't flash stale image during reload
      setCoverArtUrl(null);
      setCoverArt(null);
      await loadMetadata(filePath);
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
                  onClick={triggerThumbnailPicker}
                  disabled={isSaving}
                >
                  Change Thumbnail
                </button>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/jpeg,image/png,image/webp,image/bmp,image/gif"
                  style={{ display: 'none' }}
                  onChange={handleThumbnailChange}
                />
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