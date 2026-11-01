import React, { useState, useEffect, useRef } from 'react';
import WaveSurfer from 'wavesurfer.js';
import RegionsPlugin from 'wavesurfer.js/plugins/regions';
import api from '../api';

function themeColors() {
  let accent = '';
  let accentHover = '';
  try {
    const cs = getComputedStyle(document.documentElement);
    accent = cs.getPropertyValue('--accent').trim();
    accentHover = cs.getPropertyValue('--accent-hover').trim();
  } catch (_) {}
  const theme = document.documentElement.dataset.theme;
  const fallbackAccent = theme === 'light' ? '#2f5d50' : '#8fc4b2';
  const fallbackProgress = theme === 'light' ? '#264c42' : '#a8d5c5';
  return { wave: accent || fallbackAccent, progress: accentHover || fallbackProgress };
}

function fmt(t) {
  const n = Number(t);
  if (!Number.isFinite(n) || n < 0) return '0:00.0';
  const m = Math.floor(n / 60);
  const s = (n % 60).toFixed(1).padStart(4, '0');
  return `${m}:${s}`;
}

export default function WaveformTrim({ filePath, onTrimmed, showToast }) {
  const containerRef = useRef(null);
  const wsRef = useRef(null);
  const regionRef = useRef(null);
  const [duration, setDuration] = useState(0);
  const [current, setCurrent] = useState(0);
  const [start, setStart] = useState('0');
  const [end, setEnd] = useState('');
  const [playing, setPlaying] = useState(false);
  const [loading, setLoading] = useState(true);
  const [trimming, setTrimming] = useState(false);
  const [waveFailed, setWaveFailed] = useState(false);
  const previewEndRef = useRef(null);

  useEffect(() => {
    if (!filePath || !containerRef.current) return;
    let destroyed = false;
    setLoading(true);
    setWaveFailed(false);
    setCurrent(0);
    setDuration(0);
    setPlaying(false);

    const key = api.getApiKey ? api.getApiKey() : '';
    const fetchParams = key ? { headers: { 'X-API-Key': key } } : undefined;

    const regions = RegionsPlugin.create();
    const { wave, progress } = themeColors();
    const ws = WaveSurfer.create({
      container: containerRef.current,
      waveColor: wave,
      progressColor: progress,
      height: 96,
      normalize: true,
      plugins: [regions],
      ...(fetchParams ? { fetchParams } : {}),
    });
    wsRef.current = ws;

    const onReady = () => {
      if (destroyed) return;
      const d = ws.getDuration() || 0;
      setDuration(d);
      setStart('0');
      setEnd(d ? d.toFixed(1) : '');
      setLoading(false);
      try {
        regionRef.current?.remove?.();
        regionRef.current = regions.addRegion({
          start: 0,
          end: d,
          drag: true,
          resize: true,
          color: 'rgba(47,93,80,0.18)',
        });
      } catch (_) {
        /* region unsupported — inputs still work */
      }
    };
    const onTime = (t) => {
      if (destroyed) return;
      setCurrent(t);
      const stopAt = previewEndRef.current;
      if (stopAt != null && t >= stopAt) {
        previewEndRef.current = null;
        try { ws.pause(); } catch (_) {}
      }
    };
    const onPlay = () => { if (!destroyed) setPlaying(true); };
    const onPause = () => {
      if (!destroyed) setPlaying(false);
      previewEndRef.current = null;
    };
    const onErr = () => {
      if (destroyed) return;
      setWaveFailed(true);
      setLoading(false);
      // Fall back to server-side duration so trim still works.
      api.getDuration(filePath)
        .then((r) => {
          if (destroyed) return;
          const d = Number(r && r.duration) || 0;
          setDuration(d);
          setStart('0');
          setEnd(d ? d.toFixed(1) : '');
        })
        .catch(() => {});
    };

    ws.on('ready', onReady);
    ws.on('timeupdate', onTime);
    ws.on('play', onPlay);
    ws.on('pause', onPause);
    ws.on('error', onErr);
    const syncFromRegion = (r) => {
      if (!r) return;
      setStart(Number(r.start).toFixed(1));
      setEnd(Number(r.end).toFixed(1));
    };
    regions.on('region-update', syncFromRegion);
    regions.on('region-updated', syncFromRegion);

    ws.load(api.fileUrlWithKey(filePath)).catch(() => {
      /* 'error' event already handles fallback UI */
    });

    return () => {
      destroyed = true;
      try { ws.destroy(); } catch (_) {}
      wsRef.current = null;
      regionRef.current = null;
    };
  }, [filePath]);

  const syncRegion = (s, e) => {
    const r = regionRef.current;
    if (!r || !r.setOptions) return;
    if (duration > 0) {
      if (Number.isFinite(s)) s = Math.max(0, Math.min(s, duration));
      if (Number.isFinite(e)) e = Math.max(0, Math.min(e, duration));
    }
    try {
      const opts = {};
      if (Number.isFinite(s)) opts.start = s;
      if (Number.isFinite(e)) opts.end = e;
      if (opts.start != null && opts.end != null && !(opts.end > opts.start)) return;
      r.setOptions(opts);
    } catch (_) {}
  };

  const handleStart = (v) => {
    setStart(v);
    if (v === '' || !Number.isFinite(Number(v))) return;
    syncRegion(Number(v), end === '' ? NaN : Number(end));
  };
  const handleEnd = (v) => {
    setEnd(v);
    if (v === '' || !Number.isFinite(Number(v))) return;
    syncRegion(start === '' ? NaN : Number(start), Number(v));
  };

  const togglePlay = () => {
    const ws = wsRef.current;
    if (!ws) return;
    try { ws.playPause(); } catch (_) {}
  };

  const seekTo = (t) => {
    const ws = wsRef.current;
    if (!ws || !Number.isFinite(t)) return;
    try { ws.setTime(Math.max(0, Math.min(t, duration || t))); } catch (_) {}
  };

  const previewKeep = () => {
    const ws = wsRef.current;
    if (!ws) return;
    const s = Number(start);
    const e = Number(end);
    if (!Number.isFinite(s)) return;
    previewEndRef.current = Number.isFinite(e) && e > s ? e : null;
    seekTo(s);
    // Use play() (not the playPause toggle) so rapid clicks can't leave the
    // playing state inverted vs actual playback.
    try {
      const p = ws.play();
      if (p && typeof p.catch === 'function') p.catch(() => {});
    } catch (_) {}
  };

  const doTrim = async () => {
    const s = Number(start);
    const e = Number(end);
    if (!Number.isFinite(s) || !Number.isFinite(e)) {
      showToast?.('Enter valid start/end times', 'error');
      return;
    }
    if (!(s >= 0 && s < e && (duration <= 0 || e <= duration + 0.01))) {
      showToast?.(`Need 0 ≤ start < end ≤ ${fmt(duration)}`, 'error');
      return;
    }
    if (e - s < 1) {
      showToast?.('Keep range must be at least 1s', 'error');
      return;
    }
    if (!window.confirm(`Keep only ${s.toFixed(1)}s–${e.toFixed(1)}s? The original file will be overwritten. This cannot be undone.`)) return;
    setTrimming(true);
    try {
      const result = await api.trimAudio(filePath, s, e);
      if (result && result.metaRestored === false) {
        showToast?.('Audio trimmed, but tags/cover could not be restored', 'warning');
      } else {
        showToast?.('Audio trimmed', 'success');
      }
      onTrimmed?.(result);
    } catch (err) {
      showToast?.(`Trim failed: ${err.message}`, 'error');
    } finally {
      setTrimming(false);
    }
  };

  const noDuration = !duration || duration <= 0;
  const busy = loading || trimming;
  const interactiveDisabled = loading || waveFailed || noDuration;

  return (
    <div className="waveform-section">
      <h3 className="section-title">Trim audio</h3>
      {!waveFailed && (
        <div className="waveform-container" ref={containerRef}>
          {loading && <div className="waveform-loading">Loading waveform...</div>}
        </div>
      )}
      {waveFailed && (
        <div className="waveform-fallback">
          Waveform unavailable. Use manual times below.
        </div>
      )}
      <div className="waveform-controls">
        <button
          className="btn btn-secondary btn-small"
          onClick={togglePlay}
          disabled={interactiveDisabled}
        >
          {playing ? 'Pause' : 'Play'}
        </button>
        <span className="waveform-time">
          {fmt(current)} / {fmt(duration)}
        </span>
        <button
          className="btn btn-secondary btn-small"
          onClick={previewKeep}
          disabled={interactiveDisabled}
        >
          Preview selection
        </button>
      </div>
      <div className="waveform-controls">
        <label className="waveform-label">
          Start (s)
          <input
            className="form-input waveform-input"
            type="number"
            inputMode="decimal"
            step="0.1"
            min="0"
            value={start}
            onChange={(e) => handleStart(e.target.value)}
          />
        </label>
        <label className="waveform-label">
          End (s)
          <input
            className="form-input waveform-input"
            type="number"
            inputMode="decimal"
            step="0.1"
            min="0"
            value={end}
            onChange={(e) => handleEnd(e.target.value)}
          />
        </label>
        <button
          className="btn btn-secondary btn-small"
          onClick={() => handleStart(Number(current).toFixed(1))}
          disabled={interactiveDisabled}
        >
          Set start to playhead
        </button>
        <button
          className="btn btn-secondary btn-small"
          onClick={() => handleEnd(Number(current).toFixed(1))}
          disabled={interactiveDisabled}
        >
          Set end to playhead
        </button>
      </div>
      <div className="waveform-controls">
        <button
          className="btn btn-danger btn-small btn-block"
          onClick={doTrim}
          disabled={busy || noDuration}
        >
          {trimming ? 'Trimming...' : 'Trim to keep selection'}
        </button>
      </div>
    </div>
  );
}
