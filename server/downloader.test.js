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
function completeChild(child, outputPath) {
  child.stdout.emit('data', Buffer.from(`download:[99.9|1024|1]\n${outputPath}\n`));
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
  child.stdout.emit('data', Buffer.from('download:[12.5|2048|30]\n'));
  assert.equal(m.getQueue()[0].status, 'Processing');
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

