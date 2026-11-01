import React from 'react';
import {
  XIcon,
  PlayIcon,
  DownloadIcon,
  PencilIcon,
  RetryIcon,
  NoteIcon,
} from './Icons.jsx';

/**
 * Shared queue panel for Stow apps — flat rows, no cards.
 */

function getStatusLabel(status, stage) {
  if (status === 'Complete') return 'Downloaded';
  if (status === 'Failed') return 'Failed';
  if (status === 'Pending') return 'Pending';
  const stages = {
    fetching: 'Fetching video info',
    downloading: 'Downloading',
    converting: 'Converting',
    tagging: 'Tagging',
    cover: 'Embedding cover',
    finishing: 'Finishing',
    chapters: 'Chapters',
    processing: 'Processing',
    queued: 'Pending',
    done: 'Downloaded',
    failed: 'Failed',
  };
  if (stage && stages[stage]) return stages[stage];
  const labels = {
    Pending: 'Pending',
    Fetching: 'Fetching video info',
    Processing: 'Downloading',
    Complete: 'Downloaded',
    Failed: 'Failed',
  };
  return labels[status] || status;
}

function formatBytes(n) {
  const num = Number(n);
  if (!Number.isFinite(num) || num < 0) return '';
  if (num >= 1e9) return `${(num / 1e9).toFixed(1)} GB`;
  if (num >= 1e6) return `${(num / 1e6).toFixed(1)} MB`;
  if (num >= 1e3) return `${(num / 1e3).toFixed(1)} KB`;
  return `${num.toFixed(0)} B`;
}

function formatDuration(sec) {
  const n = Number(sec);
  if (!Number.isFinite(n) || n < 0) return '';
  const m = Math.floor(n / 60);
  const s = Math.floor(n % 60);
  if (m >= 60) {
    const h = Math.floor(m / 60);
    return `${h}:${String(m % 60).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }
  return `${m}:${String(s).padStart(2, '0')}`;
}

function hostnameOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch (_) {
    return '';
  }
}

function sourceBadge(url) {
  const u = String(url || '').toLowerCase();
  if (!u) return '';
  if (u.includes('youtube.com') || u.includes('youtu.be') || u.includes('music.youtube')) return 'YouTube';
  if (u.includes('soundcloud.com')) return 'SoundCloud';
  if (u.includes('bandcamp.com')) return 'Bandcamp';
  if (u.includes('vimeo.com')) return 'Vimeo';
  if (u.includes('tiktok.com')) return 'TikTok';
  if (u.includes('instagram.com')) return 'Instagram';
  if (u.includes('twitter.com') || u.includes('x.com')) return 'X';
  if (u.includes('reddit.com')) return 'Reddit';
  if (u.includes('archive.org')) return 'Archive';
  if (u.includes('apple.com') || u.includes('podcasts')) return 'Apple';
  if (u.startsWith('ytsearch')) return 'Search';
  return hostnameOf(url);
}

function formatSpeed(speed) {
  if (!speed || speed === 'N/A' || speed === 'None') return '';
  const num = parseFloat(speed);
  if (!isFinite(num)) return '';
  if (num >= 1e6) return `${(num / 1e6).toFixed(1)} MB/s`;
  if (num >= 1e3) return `${(num / 1e3).toFixed(1)} KB/s`;
  return `${num.toFixed(0)} B/s`;
}

function formatEta(eta) {
  if (!eta || eta === 'N/A' || eta === 'None') return '';
  const num = parseInt(eta, 10);
  if (!isFinite(num)) return '';
  if (num >= 3600) {
    const h = Math.floor(num / 3600);
    const m = Math.floor((num % 3600) / 60);
    return `${h}h ${m}m left`;
  }
  if (num >= 60) {
    const m = Math.floor(num / 60);
    const s = num % 60;
    return `${m}m ${s}s left`;
  }
  return `${num}s left`;
}

export default function QueuePanel({ queue, onCancelAll, onCancelJob, onEditFile, onShowInFolder, onRetryJob, onRemoveJob, onPlayFile, thumbUrlFor }) {
  if (queue.length === 0) return null;

  const isActiveJob = (j) => ['Pending', 'Fetching', 'Processing'].includes(j.status) ||
    (j.stage && !['done', 'failed'].includes(j.stage) && j.status !== 'Complete' && j.status !== 'Failed');
  const active = queue.filter(isActiveJob);
  const completed = queue.filter((j) => j.status === 'Complete');
  const failed = queue.filter((j) => j.status === 'Failed');

  const renderJob = (job) => {
    const status = (job && job.status) || 'Pending';
    const stage = job.stage || '';
    const isActive = status === 'Pending' || status === 'Fetching' || status === 'Processing' ||
      (stage && !['done', 'failed'].includes(stage) && status !== 'Complete' && status !== 'Failed');
    const source = sourceBadge(job.url);
    const thumb = thumbUrlFor?.(job) || '';
    const pct = Number(job.progress) || 0;
    const hasTotal = Number.isFinite(Number(job.totalBytes)) && Number(job.totalBytes) > 0;
    const title = job.title || hostnameOf(job.url) || 'Untitled';
    const metaParts = [job.uploader, job.duration != null ? formatDuration(job.duration) : '', source].filter(Boolean);
    const speed = formatSpeed(job.speed);
    const eta = formatEta(job.eta);
    const activeLine = isActive
      ? [getStatusLabel(status, stage), pct > 0 ? `${Math.round(pct)}%` : '', speed, eta].filter(Boolean).join(' · ')
      : '';
    const fileName = (job.outputPath || '').split('/').pop();

    return (
      <div key={job.id} className={`queue-row ${status.toLowerCase()}`}>
        <div className="queue-cover">
          {thumb ? (
            <img
              src={thumb}
              alt=""
              loading="lazy"
              onError={(e) => { e.currentTarget.style.display = 'none'; }}
            />
          ) : (
            <span className="queue-cover-fallback" aria-hidden="true"><NoteIcon size={18} /></span>
          )}
        </div>
        <div className="queue-main">
          <div className="queue-title" title={job.title || job.url}>
            {title}
          </div>
          {metaParts.length > 0 && (
            <div className="queue-meta">{metaParts.join(' · ')}</div>
          )}
          {isActive && activeLine && (
            <div className="queue-status">{activeLine}</div>
          )}
          {status === 'Complete' && (
            <div className="queue-status queue-status-done">
              <span className="status-dot" aria-hidden="true" />
              Downloaded
            </div>
          )}
          {status === 'Failed' && job.error && (
            <div className="queue-status queue-status-failed" title={job.error}>
              <span className="status-dot" aria-hidden="true" />
              {job.error}
            </div>
          )}
          {job.warnings && job.warnings.length > 0 && (
            <div className="queue-status queue-status-warn" title={job.warnings.join('\n')}>
              {job.warnings.length} warning{job.warnings.length === 1 ? '' : 's'}
            </div>
          )}
        </div>
        <div className="queue-actions">
          {isActive && (
            <button
              className="icon-btn"
              onClick={() => onCancelJob(job.id)}
              title="Cancel"
              aria-label={`Cancel download ${title}`}
            >
              <XIcon size={16} />
            </button>
          )}
          {status === 'Complete' && job.outputPath && (
            <>
              {onPlayFile && (
                <button
                  className="icon-btn"
                  onClick={() => onPlayFile?.(job.outputPath)}
                  title="Play"
                  aria-label={`Play ${fileName}`}
                >
                  <PlayIcon size={16} />
                </button>
              )}
              <button
                className="icon-btn"
                onClick={() => onShowInFolder?.(job.outputPath)}
                title="Save file"
                aria-label={`Save file ${fileName}`}
              >
                <DownloadIcon size={16} />
              </button>
              <button
                className="icon-btn"
                onClick={() => onEditFile?.(job.outputPath)}
                title="Edit metadata"
                aria-label={`Edit metadata for ${fileName}`}
              >
                <PencilIcon size={16} />
              </button>
            </>
          )}
          {status === 'Failed' && (
            <>
              {onRetryJob && (
                <button
                  className="icon-btn"
                  onClick={() => onRetryJob(job.id)}
                  title="Retry download"
                  aria-label={`Retry download ${title}`}
                >
                  <RetryIcon size={16} />
                </button>
              )}
              {onRemoveJob && (
                <button
                  className="icon-btn"
                  onClick={() => onRemoveJob(job.id)}
                  title="Remove from list"
                  aria-label={`Remove ${title}`}
                >
                  <XIcon size={16} />
                </button>
              )}
            </>
          )}
        </div>
        {isActive && (
          <div
            className="queue-progress"
            role="progressbar"
            aria-valuenow={Math.round(pct)}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label={`Download progress for ${title}`}
          >
            <div
              className="queue-progress-fill"
              style={(hasTotal || pct > 0) ? { width: `${Math.max(pct, 2)}%` } : undefined}
              data-indeterminate={!(hasTotal || pct > 0)}
            />
          </div>
        )}
      </div>
    );
  };

  const renderGroup = (label, jobs) => {
    if (jobs.length === 0) return null;
    return (
      <div className="queue-group">
        <h3 className="queue-group-label">{label}</h3>
        <div className="queue-rows">{jobs.map(renderJob)}</div>
      </div>
    );
  };

  return (
    <section className="section queue-section-block" aria-label="Download queue">
      <div className="section-header">
        <h2 className="section-title-main">Downloads <span className="count">{queue.length}</span></h2>
        {queue.length > 0 && (
          <button className="btn btn-ghost" onClick={onCancelAll}>
            Clear list
          </button>
        )}
      </div>
      {renderGroup('Active', active)}
      {renderGroup('Completed', completed)}
      {renderGroup('Failed', failed)}
      {active.length === 0 && completed.length === 0 && failed.length === 0 && (
        <div className="queue-rows">{queue.map(renderJob)}</div>
      )}
    </section>
  );
}
