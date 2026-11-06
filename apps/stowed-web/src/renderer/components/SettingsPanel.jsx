import React, { useState, useEffect } from 'react';
import api from '../api';

export default function SettingsPanel({ showToast }) {
  const [system, setSystem] = useState(null);
  const [settings, setSettings] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [cookiesText, setCookiesText] = useState('');
  const [cookiesStatus, setCookiesStatus] = useState(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    Promise.all([api.getSystem().catch(() => null), api.getSettings().catch(() => null), api.getCookiesStatus().catch(() => null)])
      .then(([sys, s, c]) => {
        if (cancelled) return;
        setSystem(sys);
        setSettings(s);
        setCookiesStatus(c);
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  const save = async (patch) => {
    setSaving(true);
    try {
      const next = await api.saveSettings(patch);
      setSettings(next);
      setSystem((prev) => prev ? { ...prev, settings: { ...prev.settings, ...patch } } : prev);
      showToast?.('Settings saved', 'success');
    } catch (err) {
      showToast?.(`Failed to save settings: ${err.message}`, 'error');
    } finally {
      setSaving(false);
    }
  };

  const saveCookies = async () => {
    if (!cookiesText.trim()) {
      showToast?.('Paste cookies.txt contents first', 'warning');
      return;
    }
    try {
      await api.saveCookies(cookiesText);
      setCookiesText('');
      const st = await api.getCookiesStatus().catch(() => null);
      setCookiesStatus(st);
      showToast?.('Cookies saved', 'success');
    } catch (err) {
      showToast?.(`Failed to save cookies: ${err.message}`, 'error');
    }
  };

  const saveCookiesFile = async (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try {
      await api.saveCookiesFile(file);
      const st = await api.getCookiesStatus().catch(() => null);
      setCookiesStatus(st);
      showToast?.('Cookies saved', 'success');
    } catch (err) {
      showToast?.(`Failed to save cookies: ${err.message}`, 'error');
    }
  };

  const removeCookies = async () => {
    try {
      await api.removeCookies();
      setCookiesStatus({ configured: false, updatedAt: null });
      showToast?.('Cookies removed', 'success');
    } catch (err) {
      showToast?.(`Failed to remove cookies: ${err.message}`, 'error');
    }
  };

  if (loading) return <div className="settings-loading">Loading settings…</div>;
  if (!settings && !system) return <div className="settings-loading">Failed to load settings.</div>;

  const ytdlp = system?.ytdlp || {};
  const challenge = ytdlp.ejsAvailable == null ? 'Unknown' : ytdlp.ejsAvailable ? 'Automatic' : 'Missing';
  const cookiesConfigured = Boolean(cookiesStatus?.configured);

  return (
    <>
      <section className="settings-section" aria-label="Engine">
        <h3 className="settings-section-title">Engine</h3>
        <div className="settings-row">
          <span className="settings-label">Version</span>
          <span className="settings-value">{ytdlp.version || 'unknown'}{ytdlp.error ? ` (${ytdlp.error})` : ''}</span>
        </div>
        <div className="settings-row">
          <span className="settings-label">JS runtime</span>
          <span className="settings-value">{ytdlp.jsRuntime || 'unknown'}{ytdlp.denoAvailable ? ' (Deno bundled)' : ''}</span>
        </div>
        <div className="settings-row">
          <span className="settings-label">Challenge support</span>
          <span className="settings-value">{challenge}</span>
        </div>
      </section>

      <section className="settings-section" aria-label="Downloads">
        <h3 className="settings-section-title">Downloads</h3>
        <label className="settings-check">
          <input
            type="checkbox"
            checked={settings?.opusPreferred !== false}
            disabled={saving}
            onChange={(e) => save({ opusPreferred: e.target.checked })}
          />
          <span>Prefer Opus source (no re-encode when possible)</span>
        </label>
        <label className="settings-check">
          <input
            type="checkbox"
            checked={Boolean(settings?.embedChapters)}
            disabled={saving}
            onChange={(e) => save({ embedChapters: e.target.checked })}
          />
          <span>Embed chapters when available</span>
        </label>
        <div className="settings-row">
          <span className="settings-label">SponsorBlock</span>
          <select
            className="form-input"
            value={settings?.sponsorblock || ''}
            disabled={saving}
            onChange={(e) => save({ sponsorblock: e.target.value || null })}
            aria-label="SponsorBlock"
          >
            <option value="">Off</option>
            <option value="mark:all">Mark all (chapters only)</option>
            <option value="mark:music_offtopic">Mark off-topic music</option>
            <option value="remove:music_offtopic">Remove off-topic music (cuts audio)</option>
            <option value="remove:sponsor">Remove sponsors (cuts audio)</option>
          </select>
        </div>
        <p className="form-hint">Remove cuts audio and cannot be undone. Mark only adds chapters.</p>
      </section>

      <section className="settings-section" aria-label="Cookies">
        <h3 className="settings-section-title">Cookies</h3>
        <div className="settings-row">
          <span className="settings-label">Status</span>
          <span className="settings-value">
            <span className={cookiesConfigured ? 'status-dot-ok' : 'status-dot-missing'} aria-hidden="true" />
            {cookiesConfigured ? `Configured${cookiesStatus.updatedAt ? ` · ${cookiesStatus.updatedAt.slice(0, 10)}` : ''}` : 'Not configured'}
          </span>
        </div>
        <p className="form-hint">Needed for age-restricted or members-only videos. Export Netscape cookies.txt from your browser.</p>
        <textarea
          className="form-input cookies-textarea"
          placeholder="# Netscape HTTP Cookie File…"
          value={cookiesText}
          onChange={(e) => setCookiesText(e.target.value)}
          rows={3}
          aria-label="Cookies file contents"
        />
        <div className="settings-actions">
          <button className="btn btn-secondary btn-small" onClick={saveCookies}>Save</button>
          <label className="btn btn-secondary btn-small" style={{ cursor: 'pointer' }}>
            Upload file
            <input type="file" accept=".txt" className="hidden-input" onChange={saveCookiesFile} style={{ display: 'none' }} />
          </label>
          {cookiesConfigured && (
            <button className="btn btn-ghost btn-small" onClick={removeCookies}>Remove</button>
          )}
        </div>
      </section>
    </>
  );
}
