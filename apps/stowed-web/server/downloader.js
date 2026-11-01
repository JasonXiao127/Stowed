const cp = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { randomUUID } = require('crypto');
const config = require('./config');
const { getYtDlpPath, getFfmpegPath, getJsRuntime, getDenoPath } = require('./binaries');
const {
  buildYtDlpArgs,
  splitOutputLines,
  parseLine,
  stageForPostprocessor,
  parseVersion,
} = require('@stowed/core');

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
              stage: 'queued',
              progress: 0,
              downloadedBytes: null,
              totalBytes: null,
              speed: '',
              eta: '',
              elapsed: null,
              error: '',
              warnings: [],
              tempDir: '',
              startedAt: null,
              cancelled: false,
              process: null,
            };
          }
          // Migrate older queue files that lack the rich fields.
          return {
            warnings: [],
            stage: job.status === 'Complete' ? 'done' : job.stage || 'queued',
            downloadedBytes: null,
            totalBytes: null,
            elapsed: null,
            uploader: '',
            duration: null,
            thumbnailUrl: '',
            webpageUrl: '',
            uploadDate: '',
            tempDir: '',
            startedAt: job.startedAt || null,
            ...job,
          };
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
      stage: 'queued',
      progress: 0,
      downloadedBytes: null,
      totalBytes: null,
      speed: '',
      eta: '',
      elapsed: null,
      outputPath: '',
      error: '',
      warnings: [],
      title: '',
      uploader: '',
      duration: null,
      thumbnailUrl: '',
      webpageUrl: '',
      uploadDate: '',
      tempDir: '',
      startedAt: null,
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
      this._cleanupJobTemp(prev);
    }

    this.queue = [];
    this.isProcessing = false;
    this._drainEligible = false;
    this._saveQueueState();
    this._emit('queue-updated', this._getSafeQueue());
  }

  cancelJob(jobId) {
    const jobIndex = this.queue.findIndex((j) => j.id === jobId);
    if (jobIndex === -1) return false;

    const job = this.queue[jobIndex];
    const isActive = (this.currentJob && this.currentJob.id === jobId) ||
      ['Pending', 'Fetching', 'Processing'].includes(job.status);
    if (!isActive) return 'inactive';

    if (this.currentJob && this.currentJob.id === jobId) {
      this._killProcessGroup(this.currentJob.process);
      job.cancelled = true;
      job.process = null;
      this.currentJob = null;
      this.isProcessing = false;
      this._cleanupJobTemp(job);
    }

    job.status = 'Failed';
    job.stage = 'failed';
    job.error = 'Cancelled by user';
    this._drainEligible = false;
    this._saveQueueState();
    this._emit('queue-updated', this._getSafeQueue());

    if (!this.isProcessing) {
      this._processNext();
    }
    return true;
  }

  /** Re-queue a Failed job as Pending so it can be retried. Returns null if missing. */
  retryJob(jobId) {
    const job = this.queue.find((j) => j.id === jobId);
    if (!job) return null;
    if (this.currentJob && this.currentJob.id === jobId) return 'inactive';
    if (job.status !== 'Failed') return 'inactive';
    job.status = 'Pending';
    job.stage = 'queued';
    job.progress = 0;
    job.downloadedBytes = null;
    job.totalBytes = null;
    job.speed = '';
    job.eta = '';
    job.elapsed = null;
    job.error = '';
    job.warnings = [];
    job.outputPath = '';
    job.tempDir = '';
    job.startedAt = null;
    job.cancelled = false;
    job.process = null;
    this._saveQueueState();
    this._emit('queue-updated', this._getSafeQueue());
    if (!this.isProcessing) this._processNext();
    return job;
  }

  /** Remove a job from the queue (kills it first if active). */
  removeJob(jobId) {
    const idx = this.queue.findIndex((j) => j.id === jobId);
    if (idx === -1) return false;
    const job = this.queue[idx];
    if (this.currentJob && this.currentJob.id === jobId) {
      this._killProcessGroup(this.currentJob.process);
      job.cancelled = true;
      try { this._cleanupJobTemp(job); } catch (_) {}
      this.currentJob = null;
      this.isProcessing = false;
    } else if (job.tempDir) {
      try { this._cleanupJobTemp(job); } catch (_) {}
    }
    this.queue.splice(idx, 1);
    this._saveQueueState();
    this._emit('queue-updated', this._getSafeQueue());
    if (!this.isProcessing) this._processNext();
    return true;
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
   * Remove a job's private temp directory (per-job `-P temp:` staging).
   * Cancelling used to delete every recent `*.part` file in the download
   * directory, which could wipe a concurrent job's partial file. Scoping all
   * intermediates to a per-job temp dir makes cancel cleanup exact.
   */
  _cleanupJobTemp(job) {
    const dir = job && job.tempDir;
    if (!dir) return;
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch (_) {
      // Best effort — temp dirs live under downloadDir/.stow-tmp/ (hidden).
    }
    if (job) job.tempDir = '';
  }

  /**
   * Legacy fallback: remove yt-dlp's partial files that predate per-job temp
   * dirs. Scoped to files only (no directory walk beyond the download dir).
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
      this._cleanupJobTemp(job);
      job.status = 'Pending';
      job.stage = 'queued';
      job.progress = 0;
      job.downloadedBytes = null;
      job.totalBytes = null;
      job.speed = '';
      job.eta = '';
      job.elapsed = null;
      job.error = '';
      job.warnings = [];
      this.currentJob = null;
    }

    this.isProcessing = false;
    this._flushQueueState();
  }

  _getSettings() {
    try {
      // Lazily loaded so tests can stub it; returns {} when no settings file.
      const { getSettings } = require('./settings');
      return getSettings();
    } catch (_) {
      return this._settingsCache || {};
    }
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
    job.stage = 'fetching';
    job.startedAt = Date.now();
    job.progress = 0;
    job.downloadedBytes = null;
    job.totalBytes = null;
    job.speed = '';
    job.eta = '';
    job.elapsed = null;
    job.error = '';
    job.warnings = [];
    this._emit('queue-updated', this._getSafeQueue());

    let ytDlpPath;
    let ffmpegDir;
    let jsRuntime = 'node';
    let denoDir = '';
    try {
      ytDlpPath = getYtDlpPath();
      ffmpegDir = path.dirname(getFfmpegPath());
      jsRuntime = getJsRuntime();
      const denoPath = getDenoPath();
      if (denoPath) denoDir = path.dirname(denoPath);
    } catch (err) {
      job.status = 'Failed';
      job.stage = 'failed';
      job.error = err.message;
      this._saveQueueState();
      this._emit('queue-updated', this._getSafeQueue());
      this.isProcessing = false;
      this.currentJob = null;
      this._processNext();
      return;
    }

    // Per-job temp dir under the download dir (same filesystem, hidden from
    // the library): all intermediates (.part, .webp, .temp) stay scoped to
    // this job so cancel cleanup cannot touch a concurrent download.
    // .stow-tmp/ starts with a dot so walkAudioFiles skips it.
    let jobTempDir = '';
    try {
      const stagingRoot = path.join(config.downloadDir, '.stow-tmp');
      fs.mkdirSync(stagingRoot, { recursive: true });
      jobTempDir = fs.mkdtempSync(path.join(stagingRoot, `job-${job.id.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 32)}-`));
      job.tempDir = jobTempDir;
    } catch (err) {
      job.status = 'Failed';
      job.stage = 'failed';
      job.error = `Could not create temp directory: ${err.message}`;
      this._saveQueueState();
      this._emit('queue-updated', this._getSafeQueue());
      this.isProcessing = false;
      this.currentJob = null;
      this._processNext();
      return;
    }

    let cookiesPath = '';
    try {
      const settings = this._getSettings?.() || {};
      if (settings.cookiesPath && fs.existsSync(settings.cookiesPath)) cookiesPath = settings.cookiesPath;
      else {
        const defaultCookies = path.join(config.configDir, 'cookies.txt');
        if (fs.existsSync(defaultCookies)) cookiesPath = defaultCookies;
      }
      this._settingsCache = settings;
    } catch (_) {}

    const settings = this._settingsCache || {};
    const args = buildYtDlpArgs({
      url: job.url,
      downloadDir: config.downloadDir,
      tempDir: jobTempDir,
      jsRuntime,
      cookiesPath: cookiesPath || undefined,
      embedChapters: Boolean(settings.embedChapters),
      sponsorblock: settings.sponsorblock || null,
      opusPreferred: settings.opusPreferred !== false,
    });

    const childProc = cp.spawn(ytDlpPath, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      // On POSIX make yt-dlp the leader of its own process group so a cancel can
      // kill it and its ffmpeg helper together.
      detached: process.platform !== 'win32',
      env: {
        ...process.env,
        PATH: [denoDir, ffmpegDir, process.env.PATH].filter(Boolean).join(path.delimiter),
      },
    });

    job.process = childProc;
    let stdoutBuffer = '';
    let stderrBuffer = '';
    let finalOutputPath = '';
    let settled = false;

    const emitProgress = () => {
      this._emit('download-progress', {
        id: job.id,
        progress: job.progress,
        downloadedBytes: job.downloadedBytes,
        totalBytes: job.totalBytes,
        speed: job.speed,
        eta: job.eta,
        elapsed: job.elapsed,
        stage: job.stage,
        status: job.status,
      });
    };

    const handleParsed = (parsed) => {
      if (!parsed) return;
      if (parsed.type === 'meta') {
        if (parsed.title) job.title = parsed.title;
        if (parsed.uploader) job.uploader = parsed.uploader;
        if (parsed.duration != null) job.duration = parsed.duration;
        if (parsed.thumbnail) job.thumbnailUrl = parsed.thumbnail;
        if (parsed.webpageUrl) job.webpageUrl = parsed.webpageUrl;
        if (parsed.uploadDate) job.uploadDate = parsed.uploadDate;
        if (job.status === 'Fetching') {
          job.status = 'Processing';
          job.stage = 'downloading';
        }
        this._emit('queue-updated', this._getSafeQueue());
      } else if (parsed.type === 'progress') {
        if (job.status === 'Fetching') {
          job.status = 'Processing';
          this._emit('queue-updated', this._getSafeQueue());
        }
        if (job.stage === 'fetching' || job.stage === 'queued') job.stage = 'downloading';
        if (parsed.downloadedBytes != null) job.downloadedBytes = parsed.downloadedBytes;
        if (parsed.totalBytes != null) job.totalBytes = parsed.totalBytes;
        if (parsed.progress != null) job.progress = parsed.progress;
        job.speed = parsed.speed != null ? String(parsed.speed) : job.speed;
        job.eta = parsed.eta != null ? String(parsed.eta) : job.eta;
        job.elapsed = parsed.elapsed;
        emitProgress();
      } else if (parsed.type === 'postprocess') {
        const stage = parsed.status === 'started' || parsed.status === 'finished'
          ? stageForPostprocessor(parsed.postprocessor)
          : job.stage;
        // Map shared stage names onto the queue stage vocabulary.
        const normalized = /convert/i.test(stage) ? 'converting'
          : /tag/i.test(stage) ? 'tagging'
          : /cover/i.test(stage) ? 'cover'
          : /finish/i.test(stage) ? 'finishing'
          : /chapter|segment/i.test(stage) ? 'chapters'
          : 'processing';
        job.stage = parsed.status === 'finished' && /movefiles|move/i.test(parsed.postprocessor || '')
          ? 'finishing'
          : normalized;
        if (job.status === 'Fetching') job.status = 'Processing';
        this._emit('queue-updated', this._getSafeQueue());
        emitProgress();
      } else if (parsed.type === 'file') {
        finalOutputPath = parsed.path;
      }
    };

    childProc.stdout.on('data', (data) => {
      // yt-dlp emits CR-separated progress fragments; split on both.
      stdoutBuffer += data.toString();
      const lines = splitOutputLines(stdoutBuffer);
      // Keep the trailing incomplete fragment buffered.
      stdoutBuffer = /[\r\n]$/.test(stdoutBuffer) ? '' : (lines.pop() || '');
      for (const rawLine of lines) {
        const parsed = parseLine(rawLine);
        if (parsed) handleParsed(parsed);
      }
    });

    childProc.stderr.on('data', (data) => {
      stderrBuffer += data.toString();
      const lines = splitOutputLines(stderrBuffer);
      stderrBuffer = /[\r\n]$/.test(stderrBuffer) ? '' : (lines.pop() || '');
      for (const rawLine of lines) {
        // yt-dlp progress templates (STOW_*) go to stderr, not stdout —
        // parse them before error classification so they never become errors.
        try {
          const parsedStderr = parseLine(rawLine);
          if (parsedStderr) { handleParsed(parsedStderr); continue; }
        } catch (_) {}
        const line = rawLine.trim();
        if (!line) continue;
        if (/^STOW_(META|PROGRESS|PP|FILE):/.test(line)) continue;
        if (/^WARNING:/i.test(line)) {
          const msg = line.replace(/^WARNING:\s*/i, '').slice(0, 500);
          if (msg && !job.warnings.includes(msg)) {
            job.warnings.push(msg);
            if (job.warnings.length > 5) job.warnings.shift();
          }
        } else if (/^ERROR:/i.test(line)) {
          job.error = line.replace(/^ERROR:\s*/i, '').slice(0, 500);
        } else if (!line.startsWith('[')) {
          // Keep the last meaningful stderr line as the failure reason.
          job.error = line.slice(0, 500);
        }
      }
    });

    childProc.on('close', (code) => {
      if (settled) return;
      settled = true;

      // Flush any trailing fragment that never got a line terminator.
      try {
        if (stdoutBuffer && stdoutBuffer.trim()) {
          const parsed = parseLine(stdoutBuffer);
          if (parsed) handleParsed(parsed);
        }
      } catch (_) {}
      try {
        const tail = (stderrBuffer || '').trim();
        if (tail) {
          let parsedTail = null;
          try { parsedTail = parseLine(tail); } catch (_) {}
          if (parsedTail) { handleParsed(parsedTail); }
          else if (!job.error) {
            if (/^STOW_(META|PROGRESS|PP|FILE):/.test(tail)) {
              // ignore - progress marker fragment
            } else if (/^WARNING:/i.test(tail)) {
              const msg = tail.replace(/^WARNING:\s*/i, '').slice(0, 500);
              if (msg) job.warnings.push(msg);
            } else if (/^ERROR:/i.test(tail)) {
              job.error = tail.replace(/^ERROR:\s*/i, '').slice(0, 500);
            } else if (!tail.startsWith('[')) {
              job.error = tail.slice(0, 500);
            }
          }
        }
      } catch (_) {}

      // If the job was already cancelled (by cancelJob/cancelAll), skip processing
      // because the cancellation handler already restarted the queue.
      if (job.cancelled) {
        job.process = null;
        this._cleanupJobTemp(job);
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
          if (!job.title) job.title = path.basename(foundPath, path.extname(foundPath));
          job.error = '';
          job.status = 'Complete';
          job.stage = 'done';
          job.progress = 100;
          this._drainEligible = true;
          this._emit('download-complete', {
            id: job.id,
            outputPath: job.outputPath,
          });
        } else {
          job.status = 'Failed';
          job.stage = 'failed';
          job.error = job.error || 'Download completed but no audio file was found in the download directory';
          this._drainEligible = false;
        }
      } else if (job.status !== 'Failed') {
        job.status = 'Failed';
        job.stage = 'failed';
        job.error = job.error || `Process exited with code ${code}`;
        this._drainEligible = false;
      } else {
        job.stage = 'failed';
      }

      job.process = null;
      this._cleanupJobTemp(job);
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
        this._cleanupJobTemp(job);
        return;
      }

      job.status = 'Failed';
      job.stage = 'failed';
      job.error = err.message;
      job.process = null;
      this._cleanupJobTemp(job);
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
