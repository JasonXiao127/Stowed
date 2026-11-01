'use strict';

/**
 * Offline unit tests for ./trim (child_process spawn stubbed, no ffmpeg).
 * Run with: node --test server/trim.test.js
 */

const path = require('path');
const os = require('os');
const fs = require('fs');
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

// ---- Stub child_process BEFORE loading ./trim -------------------------------
class FakeChild extends EventEmitter {
  constructor() {
    super();
    this.pid = 2000 + Math.floor(Math.random() * 1e6);
    this.stdin = { write() {}, end() {} };
    this.stdout = new EventEmitter();
    this.stderr = new EventEmitter();
    this.killed = false;
    this.file = null;
    this.args = null;
  }
  kill() { this.killed = true; }
}

const spawned = [];
let spawnHandler = null;

const childProcessStub = {
  spawn(file, args) {
    const child = new FakeChild();
    child.file = file;
    child.args = args;
    spawned.push(child);
    // Let the test drive events on next tick (after listeners attach).
    if (spawnHandler) {
      const handler = spawnHandler;
      process.nextTick(() => handler(child));
    }
    return child;
  },
};

const cpPath = require.resolve('child_process');
const realCp = require(cpPath);
require.cache[cpPath] = {
  id: cpPath,
  filename: cpPath,
  loaded: true,
  exports: childProcessStub,
};

// Stub ./binaries so no real ffmpeg/ffprobe lookup is needed.
const binariesPath = require.resolve('./binaries');
require.cache[binariesPath] = {
  id: binariesPath,
  filename: binariesPath,
  loaded: true,
  exports: {
    getFfmpegPath: () => '/fake/ffmpeg',
    getFfprobePath: () => '/fake/ffprobe',
  },
};

const { getDuration, trimAudio, _resetTrimState } = require('./trim');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'stow-trim-test-'));

function makeAudio(name = 'song.opus') {
  const p = path.join(TMP, `${Date.now()}-${Math.floor(Math.random() * 1e6)}-${name}`);
  fs.writeFileSync(p, Buffer.from('fake-audio'));
  return p;
}

beforeEach(() => {
  spawned.length = 0;
  spawnHandler = null;
  _resetTrimState();
});

function ffprobeSuccess(child, duration) {
  child.stdout.emit('data', Buffer.from(JSON.stringify({ format: { duration: String(duration) } })));
  child.emit('close', 0);
}

test('getDuration parses ffprobe JSON duration', async () => {
  spawnHandler = (child) => ffprobeSuccess(child, 123.45);
  const d = await getDuration(makeAudio());
  assert.equal(d, 123.45);
  assert.match(spawned[0].file, /ffprobe/);
  assert.deepEqual(
    spawned[0].args.slice(0, 5),
    ['-v', 'quiet', '-print_format', 'json', '-show_entries']
  );
});

test('getDuration throws on invalid/zero duration', async () => {
  spawnHandler = (child) => ffprobeSuccess(child, 0);
  await assert.rejects(() => getDuration(makeAudio()), /Invalid audio duration/);
});

test('getDuration throws on non-zero ffprobe exit', async () => {
  spawnHandler = (child) => child.emit('close', 1);
  await assert.rejects(() => getDuration(makeAudio()), /Invalid audio duration/);
});

test('getDuration rejects bad paths without leaking probe slots', async () => {
  await assert.rejects(() => getDuration(null), /Invalid file path/);
  await assert.rejects(() => getDuration(42), /Invalid file path/);
  // Slots must not leak: repeated bad calls then a good one still works.
  for (let i = 0; i < 8; i++) {
    await assert.rejects(() => getDuration(null), /Invalid file path/);
  }
  spawnHandler = (child) => ffprobeSuccess(child, 10);
  assert.equal(await getDuration(makeAudio()), 10);
});

test('trimAudio rejects non-audio files and bad ranges without spawning ffmpeg', async () => {
  const txt = path.join(TMP, 'note.txt');
  fs.writeFileSync(txt, 'hi');
  await assert.rejects(() => trimAudio(txt, 0, 5), /not an audio/i);

  const audio = makeAudio();
  await assert.rejects(() => trimAudio(audio, -1, 5), /Invalid trim range/);
  await assert.rejects(() => trimAudio(audio, 5, 5), /end must be greater/);
  await assert.rejects(() => trimAudio(audio, 0, 0.5), /at least 1 second/);
  assert.equal(spawned.length, 0);
});

test('trimAudio rejects start beyond duration', async () => {
  spawnHandler = (child) => ffprobeSuccess(child, 10);
  await assert.rejects(() => trimAudio(makeAudio(), 20, 30), /beyond.*duration/i);
});

test('trimAudio clamps end to duration, re-encodes, atomically replaces', async () => {
  const audio = makeAudio('clip.opus');
  const orig = fs.readFileSync(audio);

  spawnHandler = (child) => {
    if (child.file.includes('ffprobe')) {
      ffprobeSuccess(child, 100);
      return;
    }
    // ffmpeg: verify fast-seek arg order (-ss before -i) + opus re-encode.
    const ssIdx = child.args.indexOf('-ss');
    const iIdx = child.args.indexOf('-i');
    assert.ok(ssIdx !== -1 && iIdx !== -1 && ssIdx < iIdx, '-ss must precede -i');
    assert.ok(child.args.includes('libopus'));
    // Simulate ffmpeg writing the trimmed output to tempPath (last arg).
    const tempPath = child.args[child.args.length - 1];
    assert.match(tempPath, /_trim_/);
    fs.writeFileSync(tempPath, Buffer.from('trimmed-audio'));
    child.emit('close', 0);
  };

  const result = await trimAudio(audio, 10, 500);
  assert.equal(result.start, 10);
  assert.equal(result.end, 100); // clamped
  assert.equal(result.duration, 100);
  assert.equal(result.path, audio);
  assert.equal(fs.readFileSync(audio).toString(), 'trimmed-audio');
  assert.ok(!fs.existsSync(audio + '.backup-whatever'));
  assert.ok(orig.length > 0);
});

test('trimAudio surfaces libopus-missing hint on Unknown encoder', async () => {
  spawnHandler = (child) => {
    if (child.file.includes('ffprobe')) {
      ffprobeSuccess(child, 60);
      return;
    }
    child.stderr.emit('data', Buffer.from('Unknown encoder libopus'));
    child.emit('close', 1);
  };
  await assert.rejects(
    () => trimAudio(makeAudio(), 0, 10),
    /libopus encoder missing/
  );
});

test('trimAudio cleans up temp file on ffmpeg failure', async () => {
  const audio = makeAudio('fail.opus');
  let tempSeen = null;
  spawnHandler = (child) => {
    if (child.file.includes('ffprobe')) {
      ffprobeSuccess(child, 60);
      return;
    }
    tempSeen = child.args[child.args.length - 1];
    fs.writeFileSync(tempSeen, Buffer.from('partial'));
    child.emit('close', 1);
  };
  await assert.rejects(() => trimAudio(audio, 0, 10), /FFmpeg failed/);
  assert.ok(tempSeen);
  assert.equal(fs.existsSync(tempSeen), false);
  // Original untouched.
  assert.equal(fs.readFileSync(audio).toString(), 'fake-audio');
});

// ---- Ogg metadata preservation ---------------------------------------------
// ffmpeg cannot carry Vorbis comments (tags + embedded cover) into Ogg on
// re-encode, so trimAudio() must re-attach the original comment packet after
// the trim. This builds real (CRC-valid) Ogg fixtures with @stowed/core.

const {
  encodeComments,
  paginate,
  buildMetadataBlockPicture,
  readOggComments,
} = require('@stowed/core');

function opusHeadPacket() {
  const b = Buffer.alloc(19);
  b.write('OpusHead', 0, 'ascii');
  b[8] = 1;
  b[9] = 2;
  b.writeUInt16LE(0, 10);
  b.writeUInt32LE(48000, 12);
  b.writeInt16LE(0, 16);
  b[18] = 0;
  return b;
}

const TEST_PICTURE = (() => {
  const img = Buffer.alloc(200, 7);
  img[0] = 0x89; img[1] = 0x50; img[2] = 0x4e; img[3] = 0x47; // PNG magic
  return img;
})();

function opusFileBytes(comments) {
  return paginate(
    [opusHeadPacket(), encodeComments('opus', 'test-vendor', comments), Buffer.from([0xf8, 0x01, 0x02, 0x03])],
    0x0bc0ffee,
    [0n, 0n, 960n]
  );
}

test('trimAudio preserves tags and embedded cover across the re-encode', async () => {
  const file = path.join(TMP, `covered-${Date.now()}.opus`);
  fs.writeFileSync(file, opusFileBytes([
    { key: 'ENCODER', value: 'test-encoder' },
    { key: 'TITLE', value: 'Keep Me' },
    { key: 'ARTIST', value: 'Keep Artist' },
    { key: 'METADATA_BLOCK_PICTURE', value: buildMetadataBlockPicture(TEST_PICTURE, 'image/png') },
  ]));

  spawnHandler = (child) => {
    if (child.file.includes('ffprobe')) {
      ffprobeSuccess(child, 100);
      return;
    }
    // Simulate ffmpeg output that kept the audio but dropped every Vorbis
    // comment (what a real Ogg re-encode produces).
    const tempPath = child.args[child.args.length - 1];
    fs.writeFileSync(tempPath, opusFileBytes([
      { key: 'ENCODER', value: 'Lavf-fake' },
    ]));
    child.emit('close', 0);
  };

  const result = await trimAudio(file, 10, 20);
  assert.equal(result.path, file);
  assert.equal(result.metaRestored, true, 'restore should succeed');

  const { comments, picture } = readOggComments(fs.readFileSync(file));
  const valueOf = (key) => comments.filter((c) => c.key === key).map((c) => c.value);
  assert.deepEqual(valueOf('TITLE'), ['Keep Me']);
  assert.deepEqual(valueOf('ARTIST'), ['Keep Artist']);
  assert.ok(picture && picture.equals(TEST_PICTURE), 'cover bytes must survive trimming');
});

test('trimAudio reports metaRestored true when no comment packet needs restoring', async () => {
  const audio = makeAudio('nocover.opus');
  spawnHandler = (child) => {
    if (child.file.includes('ffprobe')) {
      ffprobeSuccess(child, 100);
      return;
    }
    const tempPath = child.args[child.args.length - 1];
    fs.writeFileSync(tempPath, Buffer.from('trimmed-audio'));
    child.emit('close', 0);
  };
  const result = await trimAudio(audio, 0, 10);
  assert.equal(result.metaRestored, true);
});
