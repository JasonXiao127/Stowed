import React, { useState, useEffect, useRef } from 'react';
import { PlayIcon, PauseIcon, XIcon } from '@stowed/shared-ui';
import api from '../api';

export default function PlayerBar({ filePath, onClose }) {
  const audioRef = useRef(null);
  const [playing, setPlaying] = useState(false);
  const [title, setTitle] = useState('');
  const [coverUrl, setCoverUrl] = useState(null);

  useEffect(() => {
    if (!filePath) return;
    let cancelled = false;
    setPlaying(false);
    setTitle((filePath || '').split('/').pop() || '');
    setCoverUrl(`${api.coverUrlWithKey(filePath)}&t=${Date.now()}`);
    api.readMetadata(filePath).then((r) => {
      if (cancelled) return;
      const t = r?.tags || {};
      if (t.title || t.artist) setTitle(`${t.title || 'Unknown'}${t.artist ? ` — ${t.artist}` : ''}`);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [filePath]);

  useEffect(() => {
    const el = audioRef.current;
    if (!el) return;
    if (filePath) {
      el.src = api.fileUrlWithKey(filePath);
      el.play().then(() => setPlaying(true)).catch(() => setPlaying(false));
    } else {
      el.pause();
      el.removeAttribute('src');
      el.load();
    }
  }, [filePath]);

  if (!filePath) return null;

  const toggle = () => {
    const el = audioRef.current;
    if (!el) return;
    if (el.paused) el.play().then(() => setPlaying(true)).catch(() => {});
    else { el.pause(); setPlaying(false); }
  };

  return (
    <div className="player-bar" role="region" aria-label="Now playing">
      <audio
        ref={audioRef}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => setPlaying(false)}
      />
      {coverUrl && (
        <img
          className="player-cover"
          src={coverUrl}
          alt=""
          onError={() => setCoverUrl(null)}
        />
      )}
      <div className="player-info">
        <div className="player-title" title={title}>{title}</div>
        <div className="player-sub" title={filePath}>{(filePath || '').split('/').pop()}</div>
      </div>
      <div className="player-controls">
        <button className="icon-btn" onClick={toggle} aria-label={playing ? 'Pause' : 'Play'}>
          {playing ? <PauseIcon size={16} /> : <PlayIcon size={16} />}
        </button>
        <button className="icon-btn" onClick={onClose} aria-label="Close player"><XIcon size={16} /></button>
      </div>
    </div>
  );
}
