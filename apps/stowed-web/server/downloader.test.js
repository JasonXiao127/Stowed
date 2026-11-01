'use strict';

/**
 * Unit tests for the DownloadManager queue state machine.
 *
 * We stub `child_process` (replacing it in the require cache BEFORE loading
 * ./downloader) so no real yt-dlp/ffmpeg is ever invoked. Each FakeChild lets a
 * test drive stdout/stderr/'close'/'error' events to simulate a download.
 *
 * Run with:  npm test   (node --test server/downloader.test.js)
 */

const path = require('path');
const os = require('os');
const fs = require('fs');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

// ---- Isolate config + download paths to a temp dir BEFORE loading the app --
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'stow-test-'));
process.env.STOW_DOWNLOAD_DIR = path.join(TMP, 'downloads');
process.env.STOW_CONFIG_DIR = path.join(TMP, 'config');
fs.mkdirSync(process.env.STOW_DOWNLOAD_DIR, { recursive: true });
fs.mkdirSync(process.env.STOW_CONFIG_DIR, { recursive: true });

// ---- Stub child_process ----------------------------------------------------
class FakeChild extends EventEmitter {
  constructor() {
    super();
    this.pid = 1000 + Math.floor(Math.random() * 1e6);
    this.stdin = { write() {}, end() {} };
    this.stdout = new EventEmitter();
    this.stderr = new EventEmitter();
    this.killed = false;
  }
  kill() { this.killed = true; }
}

const spawnedAll = [];
const childProcessStub = {
  spawn(file, args, options) {
    const child = new FakeChild();
    child.file = file;
    child.args = args;
    child.options = options;
    spawnedAll.push(child);
    return child;
  },
  execSync() { /* no-op in tests */ },
};

const cpPath = require.resolve('child_process');
require.cache[cpPath] = {
  id: cpPath,
  filename: cpPath,
  loaded: true,
  exports: childProcessStub,
};

// ---- Stub ./binaries so no real yt-dlp/ffmpeg lookup is needed -------------
// (downloader.js resolves tool paths at job start; without this the suite
// fails on machines without bin/ or system tools installed.)
const binariesPath = require.resolve('./binaries');
require.cache[binariesPath] = {
  id: binariesPath,
  filename: binariesPath,
  loaded: true,
  exports: {
    getYtDlpPath: () => '/fake/yt-dlp',
    getFfmpegPath: () => '/fake/ffmpeg',
    getFfprobePath: () => '/fake/ffprobe',
    getJsRuntime: () => 'node',
    getDenoPath: () => null,
  },
};

// Stub ./settings so tests don't touch the real config dir settings.
try {
  const settingsPath = require.resolve('./settings');
  require.cache[settingsPath] = {
    id: settingsPath,
    filename: settingsPath,
    loaded: true,
    exports: {
      getSettings: () => ({}),
      saveSettings: () => ({}),
      setCookiesState: () => ({}),
    },
  };
} catch (_) {}

const DownloadManager = require('./downloader');
const QUEUE_FILE = path.join(process.env.STOW_CONFIG_DIR, 'queue-state.json');

function freshManager() {
  try { fs.unlinkSync(QUEUE_FILE); } catch (_) {}
  return new DownloadManager();
}

function childFor(url) {
  return spawnedAll.find((c) => c.args[c.args.length - 1] === url);
}

function makeOutputFile(name) {
  const p = path.join(process.env.STOW_DOWNLOAD_DIR, name);
  fs.writeFileSync(p, Buffer.from([0x4f, 0x67, 0x67, 0x53])); // "OggS"
  return p;
}

// Drive a fake child to a successful exit with a real output file on disk.
// Uses the real STOW_* markers and CR-separated progress (as yt-dlp emits).
function completeChild(child, outputPath, meta = {}) {
  const SEP = '\x1f';
  const m = [
    meta.id || 'abc',
    meta.title || 'Song One',
    meta.uploader || 'Uploader',
    meta.duration != null ? String(meta.duration) : '213',
    meta.webpageUrl || 'https://example.com/watch?v=abc',
    meta.uploadDate || '20240101',
    meta.thumbnail || '',
  ].join(SEP);
  // Simulate CR-separated live progress followed by meta + file markers.
  child.stdout.emit('data', Buffer.from(
    `STOW_META:${m}\r` +
    `STOW_PROGRESS:1024|3433755|3433755|1000|5|1.2\r` +
    `STOW_PROGRESS:3433755|3433755|3433755|2000|0|2.0\r` +
    `STOW_PP:started|ExtractAudio\n` +
    `STOW_PP:finished|ExtractAudio\n` +
    `STOW_FILE:${outputPath}\n`
  ));
  child.emit('close', 0);
}

// ---- Tests ----------------------------------------------------------------

test('addJobs enqueues unique URLs, skips duplicates, starts the first job', () => {
  const m = freshManager();
  const res = m.addJobs(['https://a', 'https://a', 'https://b']);
  assert.equal(res.jobs.length, 2);
  assert.equal(res.skipped, 1);
  const queue = m.getQueue();
  assert.equal(queue.length, 2);
  // First job is already running (Fetching); second is still Pending.
  assert.equal(queue.filter((j) => j.status === 'Fetching').length, 1);
  assert.equal(queue.filter((j) => j.status === 'Pending').length, 1);
  assert.ok(childFor('https://a'), 'first URL should have been spawned');
});

test('a genuine completion emits one download-complete and all-downloads-complete', () => {
  const m = freshManager();
  let allComplete = 0;
  const completeEvents = [];
  m.on('all-complete', () => allComplete++);
  m.on('download-complete', (r) => completeEvents.push(r));

  m.addJobs(['https://s1']);
  const child = childFor('https://s1');
  assert.ok(child, 'yt-dlp should have been spawned');
  const out = makeOutputFile('Song One [abc].opus');
  completeChild(child, out);

  assert.equal(allComplete, 1);
  assert.equal(completeEvents.length, 1);
  const queue = m.getQueue();
  assert.equal(queue.length, 1);
  assert.equal(queue[0].status, 'Complete');
  assert.equal(queue[0].outputPath, out);
  assert.equal(queue[0].progress, 100);
});

test('status transitions Fetching -> Processing once bytes flow', () => {
  const m = freshManager();
  m.addJobs(['https://s2']);
  const child = childFor('https://s2');
  assert.equal(m.getQueue()[0].status, 'Fetching');
  // Real yt-dlp emits CR-separated STOW_PROGRESS fragments.
  child.stdout.emit('data', Buffer.from('STOW_PROGRESS:15360|3433755|3433755|1000|30|1.0\rSTOW_PROGRESS:31744|3433755|3433755|1200|20|1.5\r'));
  const q = m.getQueue()[0];
  assert.equal(q.status, 'Processing');
  assert.equal(q.stage, 'downloading');
  assert.ok(q.progress > 0);
});

test('before_dl meta fills title/uploader/duration/thumbnail', () => {
  const m = freshManager();
  m.addJobs(['https://meta1']);
  const child = childFor('https://meta1');
  const SEP = '\x1f';
  child.stdout.emit('data', Buffer.from(
    `STOW_META:vid1${SEP}My Title${SEP}My Uploader${SEP}123${SEP}https://example.com/v/vid1${SEP}20240102${SEP}https://example.com/t.jpg\n`
  ));
  const q = m.getQueue()[0];
  assert.equal(q.title, 'My Title');
  assert.equal(q.uploader, 'My Uploader');
  assert.equal(q.duration, 123);
  assert.equal(q.thumbnailUrl, 'https://example.com/t.jpg');
  assert.equal(q.status, 'Processing');
});

test('spawns yt-dlp with newline, per-job temp, and opus-preferred format', () => {
  const m = freshManager();
  m.addJobs(['https://args1']);
  const child = childFor('https://args1');
  assert.ok(child, 'yt-dlp should have been spawned');
  assert.ok(child.args.includes('--newline'), 'should pass --newline');
  assert.ok(child.args.includes('--color'), 'should pass --color never');
  assert.ok(child.args.includes('bestaudio[acodec=opus]/bestaudio'), 'should prefer Opus');
  assert.ok(!child.args.includes('ejs:github'), 'should not fetch remote EJS components');
  const tempIdx = child.args.indexOf('-P');
  assert.ok(tempIdx !== -1, 'should set -P paths');
  const job = m.getQueue()[0];
  assert.ok(job.tempDir && job.tempDir.length > 0, 'job should own a temp dir');
});

test('cancelling the active job starts the next and does not announce complete', () => {
  const m = freshManager();
  let allComplete = 0;
  m.on('all-complete', () => allComplete++);

  m.addJobs(['https://c1', 'https://c2']);
  assert.ok(childFor('https://c1'));
  const job1 = m.getQueue().find((j) => j.url === 'https://c1');
  m.cancelJob(job1.id);

  const queue = m.getQueue();
  assert.equal(queue.find((j) => j.url === 'https://c1').status, 'Failed');
  assert.equal(queue.find((j) => j.url === 'https://c1').error, 'Cancelled by user');
  assert.ok(childFor('https://c2'), 'next job should have been started');
  assert.equal(allComplete, 0);
});

test('cancelling the only job does not fire all-downloads-complete', () => {
  const m = freshManager();
  let allComplete = 0;
  m.on('all-complete', () => allComplete++);
  m.addJobs(['https://last1']);
  const job = m.getQueue()[0];
  m.cancelJob(job.id);
  assert.equal(m.getQueue()[0].status, 'Failed');
  assert.equal(allComplete, 0);
});

test('cancelAll empties the whole queue', () => {
  const m = freshManager();
  m.addJobs(['https://ca1', 'https://ca2']);
  assert.ok(childFor('https://ca1'));
  m.cancelAll();
  assert.equal(m.getQueue().length, 0);
});

test('a non-zero exit marks the job Failed and does not announce complete', () => {
  const m = freshManager();
  let allComplete = 0;
  m.on('all-complete', () => allComplete++);
  m.addJobs(['https://f1']);
  const child = childFor('https://f1');
  child.stderr.emit('data', Buffer.from('Video unavailable'));
  child.emit('close', 1);
  const j = m.getQueue()[0];
  assert.equal(j.status, 'Failed');
  assert.equal(j.error, 'Video unavailable');
  assert.equal(allComplete, 0);
});

test('queue persists across restarts; interrupted jobs resume as Pending', async () => {
  // Flush any debounced saves scheduled by earlier tests so they don't
  // overwrite the seed file below.
  await new Promise((r) => setTimeout(r, 350));

  const out = makeOutputFile('Persist Song [x1].opus');
  const seed = [
    { id: 'j_complete', url: 'https://p1', status: 'Complete', progress: 100, speed: '', eta: '', outputPath: out, error: '', title: 'complete', cancelled: false },
    { id: 'j_pending', url: 'https://p2', status: 'Pending', progress: 0, speed: '', eta: '', outputPath: '', error: '', title: '', cancelled: false },
    { id: 'j_fetching', url: 'https://p3', status: 'Fetching', progress: 40, speed: '1024', eta: '5', outputPath: '', error: '', title: '', cancelled: false },
    { id: 'j_failed', url: 'https://p4', status: 'Failed', progress: 0, speed: '', eta: '', outputPath: '', error: 'boom', title: '', cancelled: false },
  ];
  fs.writeFileSync(QUEUE_FILE, JSON.stringify(seed, null, 2));

  const m = new DownloadManager(); // loads from disk
  const q = m.getQueue();
  assert.equal(q.find((j) => j.id === 'j_complete').status, 'Complete');
  assert.equal(q.find((j) => j.id === 'j_pending').status, 'Pending');
  assert.equal(q.find((j) => j.id === 'j_failed').status, 'Failed');

  const fetching = q.find((j) => j.id === 'j_fetching');
  assert.equal(fetching.status, 'Pending');
  assert.equal(fetching.progress, 0);
  assert.equal(fetching.speed, '');
  assert.equal(fetching.error, '');
});

test('cancelJob only cancels active jobs (inactive returns inactive)', () => {
  const m = freshManager();
  m.addJobs(['https://active1']);
  const active = m.getQueue()[0];
  assert.equal(m.cancelJob(active.id), true);
  assert.equal(m.getQueue().find((j) => j.id === active.id).status, 'Failed');
  // Cancelling again (now Failed) is not actionable.
  assert.equal(m.cancelJob(active.id), 'inactive');
  assert.equal(m.cancelJob('nope'), false);
});

test('retryJob only retries Failed jobs', () => {
  const m = freshManager();
  m.addJobs(['https://r1']);
  const pending = m.getQueue()[0];
  assert.equal(m.retryJob(pending.id), 'inactive');
  assert.equal(m.retryJob('nope'), null);
  // Fail it then retry.
  const child = childFor('https://r1');
  child.stderr.emit('data', Buffer.from('boom'));
  child.emit('close', 1);
  const failed = m.getQueue()[0];
  assert.equal(failed.status, 'Failed');
  const retried = m.retryJob(failed.id);
  assert.ok(retried && ['Pending', 'Fetching', 'Processing'].includes(retried.status));
});

test('removeJob returns false for missing jobs', () => {
  const m = freshManager();
  m.addJobs(['https://rm1']);
  const job = m.getQueue()[0];
  assert.equal(m.removeJob('nope'), false);
  assert.equal(m.removeJob(job.id), true);
});

test('stderr STOW_ markers are parsed, never stored as errors', () => {
  const m = freshManager();
  m.addJobs(['https://stderr1']);
  const child = childFor('https://stderr1');
  const SEP = '\x1f';
  child.stderr.emit('data', Buffer.from(
    `STOW_META:vid1${SEP}T${SEP}U${SEP}123${SEP}https://example.com/v${SEP}20240101${SEP}\n` +
    `STOW_PROGRESS:1024|2048|2048|500|5|1.0\n` +
    `STOW_PP:finished|MoveFiles\n`
  ));
  const q = m.getQueue()[0];
  assert.equal(q.title, 'T');
  assert.equal(q.error, '');
  assert.equal(q.status, 'Processing');
});

test('per-job temp dirs stage under downloadDir/.stow-tmp/', () => {
  const m = freshManager();
  m.addJobs(['https://tmp1']);
  const job = m.getQueue()[0];
  assert.ok(job.tempDir.includes('.stow-tmp'), `temp ${job.tempDir} should be under .stow-tmp`);
  assert.ok(job.tempDir.startsWith(process.env.STOW_DOWNLOAD_DIR), 'temp must share filesystem with downloads');
});

