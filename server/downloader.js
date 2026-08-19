const cp = require('child_process');
const path = require('path');
const fs = require('fs');
const { randomUUID } = require('crypto');
const config = require('./config');
const { getYtDlpPath, getFfmpegPath } = require('./binaries');

const QUEUE_FILE = path.join(config.configDir, 'queue-state.json');

/**
 * Buffered, atomic persistence for queue-state.json. Writing to a temp file
 * and renaming avoids corrupting the queue if the container is killed mid-write.
 */
let _saveTimer = null;
let _savePending = false;

/**
 * Serialize a job to a plain, JSON-friendly object for the wire and for
 * persistence. Drops the live `process` handle and the transient `cancelled`
 * flag (a cancelled job is re-derived from its status on load).
 */
function toSafeJob(job) {
  const { process, cancelled, ...safe } = job;
  return safe;
}

function persistQueueState(queue) {
  const safeQueue = queue.map((job) => toSafeJob(job));
  const tmp = `${QUEUE_FILE}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(safeQueue, null, 2), 'utf-8');
  fs.renameSync(tmp, QUEUE_FILE);
}

function scheduleQueueSave(manager) {
  if (_savePending) return;
  _savePending = true;
  _saveTimer = setTimeout(() => {
    _savePending = false;
    try {
      persistQueueState(manager.queue);
    } catch (err) {
      console.error('Failed to save queue state:', err.message);
    }
  }, 250);
}

class DownloadManager {
  constructor() {
    this.queue = [];
    this.currentJob = null;
    this.isProcessing = false;
    // True when the last finished job reached a genuine 'Complete'. We use this
    // to avoid firing the "all downloads complete!" event after a cancel/failure
    // drained the queue (which is not a success).
    this._drainEligible = false;
    this.listeners = new Map();
    this._loadQueueState();
  }

  on(event, callback) {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, []);
    }
    this.listeners.get(event).push(callback);
  }

  _emit(event, data) {
    const callbacks = this.listeners.get(event) || [];
    callbacks.forEach((cb) => cb(data));
  }

  _loadQueueState() {
    try {
      if (fs.existsSync(QUEUE_FILE)) {
        const data = fs.readFileSync(QUEUE_FILE, 'utf-8');
        const savedQueue = JSON.parse(data);
        // Put interrupted jobs back into the queue so the next launch can
        // retry them. Failed jobs remain visible and are not retried.
        this.queue = savedQueue.map((job) => {
          if (job.status !== 'Complete' && job.status !== 'Failed') {
            return {
              ...job,
              status: 'Pending',
              progress: 0,
              speed: '',
              eta: '',
              error: '',
              cancelled: false,
              process: null,
            };
          }
          return job;
        });
        persistQueueState(this.queue);
        this._emit('queue-updated', this._getSafeQueue());
      }
    } catch (err) {
      console.error('Failed to load queue state:', err.message);
      this.queue = [];
    }
  }

  _saveQueueState() {
    // Debounced so bursts of progress don't hammer the disk, then flushed
    // atomically. Explicit calls (job completion, shutdown) flush synchronously.
    scheduleQueueSave(this);
  }

  _flushQueueState() {
    if (_saveTimer) {
      clearTimeout(_saveTimer);
      _saveTimer = null;
      _savePending = false;
    }
    try {
      persistQueueState(this.queue);
    } catch (err) {
      console.error('Failed to save queue state:', err.message);
    }
  }

  addJobs(urls) {
    if (!Array.isArray(urls)) {
      throw new TypeError('URLs must be provided as an array');
    }

    // Refresh completed-file statuses before deciding whether a URL is
    // still active. This permits a re-download after its file was removed.
    this._getSafeQueue();

    // Normalize and deduplicate against active queue jobs
    const normalizedUrls = urls
      .filter((url) => typeof url === 'string')
      .map((url) => url.trim())
      .filter(Boolean);
    const activeUrls = new Set(
      this.queue
        .filter((j) => ['Pending', 'Fetching', 'Processing', 'Complete'].includes(j.status))
        .map((j) => j.url)
    );
    const uniqueUrls = [];
    for (const url of normalizedUrls) {
      if (!activeUrls.has(url)) {
        activeUrls.add(url);
        uniqueUrls.push(url);
      }
    }
    const skipped = normalizedUrls.length - uniqueUrls.length;

    const newJobs = uniqueUrls.map((url) => ({
      id: `job_${Date.now()}_${randomUUID()}`,
      url: url,
      status: 'Pending',
      progress: 0,
      speed: '',
      eta: '',
      outputPath: '',
      error: '',
      title: '',
      cancelled: false,
    }));

    this.queue.push(...newJobs);
    this._saveQueueState();
    this._emit('queue-updated', this._getSafeQueue());

    if (!this.isProcessing && newJobs.length > 0) {
      this._processNext();
    }

    // Return safe copies for the wire (job.process is not serializable).
    return { jobs: newJobs.map((job) => this._getSafeJob(job)), skipped };
  }

  cancelAll() {
    if (this.currentJob) {
      const prev = this.currentJob;
      this._killProcessGroup(prev.process);
      prev.cancelled = true;
      prev.process = null;
      this.currentJob = null;
      this._cleanupPartialFiles(prev);
    }

    this.queue = [];
    this.isProcessing = false;
    this._drainEligible = false;
    this._saveQueueState();
    this._emit('queue-updated', this._getSafeQueue());
  }

  cancelJob(jobId) {
    const jobIndex = this.queue.findIndex((j) => j.id === jobId);
    if (jobIndex === -1) return;

    const job = this.queue[jobIndex];
    if (this.currentJob && this.currentJob.id === jobId) {
      this._killProcessGroup(this.currentJob.process);
      job.cancelled = true;
      job.process = null;
      this.currentJob = null;
      this.isProcessing = false;
      this._cleanupPartialFiles(job);
    }

    job.status = 'Failed';
    job.error = 'Cancelled by user';
    this._drainEligible = false;
    this._saveQueueState();
    this._emit('queue-updated', this._getSafeQueue());

    if (!this.isProcessing) {
      this._processNext();
    }
  }

  /**
   * Kill a yt-dlp child process AND its ffmpeg helpers. On POSIX we spawn the
   * downloader as a process-group leader (detached) so a negative pid kill
   * reaps the whole tree; on Windows we use taskkill /T /F.
   */
  _killProcessGroup(proc) {
    if (!proc || typeof proc.pid !== 'number') {
      try { proc && proc.kill && proc.kill(); } catch (_) {}
      return;
    }
    try {
      if (process.platform === 'win32') {
        // Spawn (not a shell string) so no path/pid is ever interpreted by a shell.
        cp.spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { stdio: 'ignore' });
      } else {
        try {
          process.kill(-proc.pid, 'SIGTERM');
        } catch (_) {
          process.kill(proc.pid, 'SIGTERM');
        }
      }
    } catch (_) {
      try { proc.kill(); } catch (_) {}
    }
  }

  /**
   * Remove yt-dlp's partial (incomplete) output files that belong to a
   * cancelled download, so a later re-download of the same title isn't blocked
   * by a leftover lock/partial file. Only removes *.part files written since the
   * job started.
   */
  _cleanupPartialFiles(job) {
    if (!job || !config.downloadDir) return;
    const cutoff = job.startedAt || (Date.now() - 120000);
    try {
      const files = fs.readdirSync(config.downloadDir);
      for (const file of files) {
        // yt-dlp names partial files "<output>.part"; anchor the match so a
        // legitimately completed file like "song part1.opus" is never touched.
        if (!/\.part$/i.test(file)) continue;
        const full = path.join(config.downloadDir, file);
        try {
          const stat = fs.statSync(full);
          if (stat.isFile() && stat.mtimeMs >= cutoff) fs.unlinkSync(full);
        } catch (_) {
          // File may be locked/missing — skip it
        }
      }
    } catch (_) {
      // Directory issues are non-fatal during a cancel.
    }
  }

  _getSafeJob(job) {
    // Return a plain object with only serializable properties for the wire.
    return toSafeJob(job);
  }

  _getSafeQueue() {
    // When returning the queue, check if any "Complete" job's file still exists
    let changed = false;
    const synced = this.queue.map((job) => {
      if (job.status === 'Complete' && job.outputPath) {
        if (!fs.existsSync(job.outputPath)) {
          changed = true;
          return { ...job, status: 'Failed', error: 'File was deleted or moved' };
        }
      }
      return job;
    });
    if (changed) {
      this.queue = synced;
      this._saveQueueState();
    }
    return synced.map((job) => this._getSafeJob(job));
  }

  _processNext() {
    if (this.isProcessing) return;

    const nextJob = this.queue.find((j) => j.status === 'Pending' && !j.cancelled);
    if (!nextJob) {
      // Only announce "all downloads complete" when the drain really followed a
      // successful completion — not when it followed a cancel/failure.
      if (this._drainEligible) {
        this._drainEligible = false;
        this._emit('all-complete');
      }
      return;
    }

    this.isProcessing = true;
    this.currentJob = nextJob;
    this._startDownload(nextJob);
  }

  resume() {
    if (!this.isProcessing && this.queue.some((job) => job.status === 'Pending')) {
      this._processNext();
    }
  }

  shutdown() {
    if (this.currentJob) {
      const job = this.currentJob;
      job.cancelled = true;
      this._killProcessGroup(job.process);
      job.process = null;
      job.status = 'Pending';
      job.progress = 0;
      job.speed = '';
      job.eta = '';
      job.error = '';
      this.currentJob = null;
    }

    this.isProcessing = false;
    this._flushQueueState();
  }

  /**
   * Normalize a file path for Windows: trailing dots and spaces are not allowed
   * in filenames on Windows, so yt-dlp's --print filename can report a path
   * that differs from what the OS actually writes.
   */
  _normalizeWindowsPath(filePath) {
    if (process.platform !== 'win32') return filePath;
    const dir = path.dirname(filePath);
    const ext = path.extname(filePath);
    const base = path.basename(filePath, ext);
    // Remove trailing dots and spaces from the base name
    const normalizedBase = base.replace(/[. ]+$/, '');
    if (normalizedBase === base) return filePath;
    return path.join(dir, normalizedBase + ext);
  }

  _startDownload(job) {
    job.status = 'Fetching';
    job.startedAt = Date.now();
    this._emit('queue-updated', this._getSafeQueue());

    let ytDlpPath;
    let ffmpegDir;
    try {
      ytDlpPath = getYtDlpPath();
      ffmpegDir = path.dirname(getFfmpegPath());
    } catch (err) {
      job.status = 'Failed';
      job.error = err.message;
      this._saveQueueState();
      this._emit('queue-updated', this._getSafeQueue());
      this.isProcessing = false;
      this.currentJob = null;
      this._processNext();
      return;
    }

    const outputTemplate = path.join(
      config.downloadDir,
      '%(title)s [%(id)s].%(ext)s'
    );

    const args = [
      '--js-runtimes', 'node',
      '--impersonate', 'chrome',
      '--remote-components', 'ejs:github',
      '--force-overwrites',
      '-f', 'bestaudio',
      '-x',
      '--audio-format', 'opus',
      '--embed-thumbnail',
      '--embed-metadata',
      '-o', outputTemplate,
      '--no-playlist',
      '--progress',
      '--progress-template',
      'download:[%(progress.percent)s|%(progress.speed)s|%(progress.eta)s]',
      '--print', 'after_move:filepath',
      '--', job.url,
    ];

    const childProc = cp.spawn(ytDlpPath, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      // On POSIX make yt-dlp the leader of its own process group so a cancel can
      // kill it and its ffmpeg helper together.
      detached: process.platform !== 'win32',
      env: {
        ...process.env,
        PATH: [ffmpegDir, process.env.PATH].filter(Boolean).join(path.delimiter),
      },
    });

    job.process = childProc;
    let stdoutBuffer = '';
    let finalOutputPath = '';
    let settled = false;

    childProc.stdout.on('data', (data) => {
      // Buffer incoming data and split into complete lines
      stdoutBuffer += data.toString();
      const lines = stdoutBuffer.split('\n');
      // Keep the last (potentially incomplete) line in the buffer
      stdoutBuffer = lines.pop() || '';

      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line) continue;

        // Parse progress
        if (line.startsWith('download:[')) {
          const match = line.match(/\[([^|]+)\|([^|]*)\|([^\]]*)\]/);
          if (match) {
            // Format is resolved and bytes are flowing — move out of the
            // info-fetch phase into the actual download phase.
            if (job.status === 'Fetching') {
              job.status = 'Processing';
              this._emit('queue-updated', this._getSafeQueue());
            }
            job.progress = parseFloat(match[1]) || 0;
            job.speed = match[2] || '';
            job.eta = match[3] || '';
            this._emit('download-progress', {
              id: job.id,
              progress: job.progress,
              speed: job.speed,
              eta: job.eta,
            });
          }
        } else if (path.isAbsolute(line)) {
          finalOutputPath = line;
        }
      }
    });

    childProc.stderr.on('data', (data) => {
      const line = data.toString().trim();
      if (line && !line.startsWith('[')) {
        job.error = line;
      }
    });

    childProc.on('close', (code) => {
      if (settled) return;
      settled = true;

      // If the job was already cancelled (by cancelJob/cancelAll), skip processing
      // because the cancellation handler already restarted the queue.
      if (job.cancelled) {
        job.process = null;
        this._saveQueueState();
        this._emit('queue-updated', this._getSafeQueue());
        return;
      }

      if (code === 0) {
        // Prefer yt-dlp's final output path. The directory scan remains a
        // compatibility fallback for older yt-dlp builds.
        const printedPath = this._normalizeWindowsPath(finalOutputPath);
        const foundPath = printedPath && fs.existsSync(printedPath)
          ? printedPath
          : this._findNewestAudioFile(config.downloadDir, job);

        if (foundPath) {
          job.outputPath = foundPath;
          job.title = path.basename(foundPath, path.extname(foundPath));
          job.status = 'Complete';
          job.progress = 100;
          this._drainEligible = true;
          this._emit('download-complete', {
            id: job.id,
            outputPath: job.outputPath,
          });
        } else {
          job.status = 'Failed';
          job.error = 'Download completed but no audio file was found in the download directory';
          this._drainEligible = false;
        }
      } else if (job.status !== 'Failed') {
        job.status = 'Failed';
        job.error = job.error || `Process exited with code ${code}`;
        this._drainEligible = false;
      }

      job.process = null;
      this._saveQueueState();
      this._emit('queue-updated', this._getSafeQueue());

      this.isProcessing = false;
      this.currentJob = null;
      this._processNext();
    });

    childProc.on('error', (err) => {
      if (settled) return;
      settled = true;

      if (job.cancelled) {
        job.process = null;
        return;
      }

      job.status = 'Failed';
      job.error = err.message;
      job.process = null;
      this._drainEligible = false;
      this._saveQueueState();
      this._emit('queue-updated', this._getSafeQueue());
      this.isProcessing = false;
      this.currentJob = null;
      this._processNext();
    });
  }

/**
   * Scan a directory for the most recently modified audio file (.opus or .ogg).
   * Uses the job's startedAt timestamp as the cutoff (with a 30s grace window)
   * to avoid picking up old unrelated files.
   */
  _findNewestAudioFile(dir, job) {
    try {
      const cutoff = job && job.startedAt ? job.startedAt - 5_000 : Date.now() - 60_000;
      const files = fs.readdirSync(dir);
      const extensions = ['.opus', '.ogg'];
      let newestPath = null;
      let newestMtime = 0;

      for (const file of files) {
        const ext = path.extname(file).toLowerCase();
        if (!extensions.includes(ext)) continue;
        const fullPath = path.join(dir, file);
        try {
          const stat = fs.statSync(fullPath);
          if (stat.isFile() && stat.mtimeMs >= cutoff && stat.mtimeMs > newestMtime) {
            newestPath = fullPath;
            newestMtime = stat.mtimeMs;
          }
        } catch {
          // File may be in use/locked — skip it
        }
      }

      return newestPath;
    } catch {
      return null;
    }
  }

  /**
   * Scan all Complete jobs and verify their output files still exist.
   * Marks missing files as Failed. Returns true if any status changed.
   */
  syncFileStatuses() {
    let changed = false;
    for (const job of this.queue) {
      if (job.status === 'Complete' && job.outputPath) {
        if (!fs.existsSync(job.outputPath)) {
          job.status = 'Failed';
          job.error = 'File was deleted or moved';
          changed = true;
        }
      }
    }
    if (changed) {
      this._saveQueueState();
      this._emit('queue-updated', this._getSafeQueue());
    }
    return changed;
  }

  getQueue() {
    return this._getSafeQueue();
  }
}

module.exports = DownloadManager;
