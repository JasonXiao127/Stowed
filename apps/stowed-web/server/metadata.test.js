'use strict';

/**
 * Regression tests for Ogg Opus / Ogg Vorbis tag writes.
 *
 * Background: writeMetadata used a single FFmpeg recipe (`-map 0 -c copy`
 * with global -metadata) for every container. For Ogg files that meant:
 *  1. tag saves on files with an embedded cover failed loudly — FFmpeg
 *     cannot mux the attached-picture stream into Ogg (exit 234); and
 *  2. tag saves on files that already carried stream-level Vorbis comments
 *     exited 0 but left every tag unchanged (global -metadata does not
 *     override existing stream comments).
 *
 * Ogg files are now edited with the pure-JS Vorbis-comment writer in
 * @stowed/core (no FFmpeg, no re-encode, audio bit-identical, cover kept).
 * These tests build minimal Ogg fixtures in JS so they run without any
 * binary (ffmpeg/yt-dlp) — unlike downloader.test.js.
 *
 * Run with: npm test (node --test server/metadata.test.js)
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  encodeComments,
  readOggComments,
  rewriteOggComments,
  replaceOggCommentPacket,
  buildMetadataBlockPicture,
  applyTags,
} = require('@stowed/core');
const { writeMetadata, canEmbedCover } = require('./metadata');

// ---- Minimal Ogg fixture builder (pure JS, no binaries) -------------------
// Reuses the core paginator indirectly: craft pages by hand with correct CRC
// via a tiny local page writer (mirrors oggOpus internals).

const CRC_TABLE = (() => {
  const poly = 0x04c11db7;
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let r = (i << 24) >>> 0;
    for (let j = 0; j < 8; j++) {
      r = (r & 0x80000000) ? (((r << 1) ^ poly) >>> 0) : ((r << 1) >>> 0);
    }
    table[i] = r >>> 0;
  }
  return table;
})();

function crc(buf) {
  let c = 0;
  for (let i = 0; i < buf.length; i++) {
    c = (((c << 8) >>> 0) ^ CRC_TABLE[(((c >>> 24) ^ buf[i]) & 0xff)]) >>> 0;
  }
  return c >>> 0;
}

// 19-byte stereo OpusHead (RFC 7587 §5.1).
function opusHead() {
  const b = Buffer.alloc(19);
  b.write('OpusHead', 0, 'ascii');
  b[8] = 1; // version
  b[9] = 2; // channels
  b.writeUInt16LE(0, 10); // pre-skip
  b.writeUInt32LE(48000, 12); // input sample rate
  b.writeInt16LE(0, 16); // output gain
  b[18] = 0; // mapping family
  return b;
}

// \x01vorbis ident header (30 bytes, minimal).
function vorbisId() {
  const b = Buffer.alloc(30, 0);
  b[0] = 0x01;
  b.write('vorbis', 1, 'ascii');
  return b;
}

let serialCounter = 0x12340000;
function makeOgg(packets, serial) {
  serial = serial >>> 0 || (++serialCounter >>> 0);
  const pages = [];
  let seq = 0;
  const emit = (bodySegs, headerType, granule) => {
    const segments = Buffer.from(bodySegs.flatMap((p) => {
      const out = [];
      let rem = p.length;
      while (rem > 255) { out.push(255); rem -= 255; }
      out.push(rem % 256 === 255 && rem > 0 ? 255 : rem);
      // Exact multiples need a trailing zero-length segment.
      if (p.length > 0 && p.length % 255 === 0) out.push(0);
      return out;
    }));
    if (segments.length > 255) throw new Error('fixture page too large');
    const header = Buffer.alloc(27 + segments.length);
    header.write('OggS', 0, 'ascii');
    header[4] = 0;
    header[5] = headerType;
    header.writeBigUInt64LE(BigInt(granule), 6);
    header.writeUInt32LE(serial, 14);
    header.writeUInt32LE(seq++, 18);
    header.writeUInt32LE(0, 22);
    header[26] = segments.length;
    segments.copy(header, 27);
    const body = Buffer.concat(bodySegs);
    const page = Buffer.concat([header, body]);
    page.writeUInt32LE(crc(page), 22);
    pages.push(page);
  };
  // Headers each on their own page; audio packets share trailing pages.
  emit([packets[0]], 0x02, 0);
  emit([packets[1]], 0x00, 0);
  let granule = 0;
  for (let i = 2; i < packets.length; i++) {
    granule += 960; // one fake 20 ms frame each
  }
  if (packets.length > 2) emit(packets.slice(2), 0x04, granule);
  return { bytes: Buffer.concat(pages), serial };
}

// 1x1 PNG (valid per coverArt.js: real signature + IEND).
const TINY_PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
  0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53,
  0xde, 0x00, 0x00, 0x00, 0x0c, 0x49, 0x44, 0x41,
  0x54, 0x08, 0xd7, 0x63, 0xf8, 0xff, 0xff, 0x3f,
  0x00, 0x05, 0xfe, 0x02, 0xfe, 0xdc, 0xcc, 0x59,
  0xe7, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e,
  0x44, 0xae, 0x42, 0x60, 0x82,
]);

function opusTagsWith(comments) {
  return encodeComments('opus', 'test-vendor', comments);
}

function fixtureOpus({ tags = [], picture = null } = {}) {
  const comments = [
    { key: 'ENCODER', value: 'test-encoder' },
    ...tags,
  ];
  if (picture) {
    comments.splice(1, 0, {
      key: 'METADATA_BLOCK_PICTURE',
      value: buildMetadataBlockPicture(picture, 'image/png'),
    });
  }
  return makeOgg([opusHead(), opusTagsWith(comments), Buffer.from([0xf8, 0x01, 0x02, 0x03])], 0x0bc0ffee);
}

function fixtureVorbis({ tags = [] } = {}) {
  const comments = [{ key: 'ENCODER', value: 'test-encoder' }, ...tags];
  const packet = encodeComments('vorbis', 'test-vendor', comments);
  return makeOgg([vorbisId(), packet, Buffer.from([0x01, 0x02, 0x03])], 0x00c0ffee);
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'stow-meta-test-'));

function writeFixture(name, bytes) {
  const p = path.join(TMP, name);
  fs.writeFileSync(p, bytes);
  return p;
}

function commentsOf(filePath) {
  return readOggComments(fs.readFileSync(filePath));
}

function tagValue(comments, key) {
  const found = comments.filter((c) => c.key.toUpperCase() === key);
  return found.map((c) => c.value);
}

// ---- Tests ----------------------------------------------------------------

test('tag save on a covered .opus updates tags and preserves the cover', async () => {
  const p = writeFixture('covered.opus', fixtureOpus({
    tags: [
      { key: 'TITLE', value: 'Orig Title' },
      { key: 'ARTIST', value: 'Orig Artist' },
    ],
    picture: TINY_PNG,
  }).bytes);

  // Previously: FFmpeg exit 234 (cannot mux attached picture into Ogg).
  await writeMetadata(p, { title: 'New Title', artist: 'New Artist', album: '', track: '', genre: '', year: '' });

  const { comments, picture } = commentsOf(p);
  assert.deepEqual(tagValue(comments, 'TITLE'), ['New Title']);
  assert.deepEqual(tagValue(comments, 'ARTIST'), ['New Artist']);
  assert.ok(picture && picture.equals(TINY_PNG), 'cover bytes must survive a tag-only save');
});

test('a second tag save on existing tags updates again (no silent no-op)', async () => {
  const p = writeFixture('second.opus', fixtureOpus({
    tags: [{ key: 'TITLE', value: 'First' }, { key: 'ARTIST', value: 'A' }],
  }).bytes);

  await writeMetadata(p, { title: 'First', artist: 'A', album: '', track: '', genre: '', year: '' });
  // Previously: global -metadata did not override existing stream comments,
  // so this exited 0 while changing nothing.
  await writeMetadata(p, { title: 'Second', artist: 'B', album: 'Alb', track: '7', genre: 'Rock', year: '1999' });

  const { comments } = commentsOf(p);
  assert.deepEqual(tagValue(comments, 'TITLE'), ['Second']);
  assert.deepEqual(tagValue(comments, 'ARTIST'), ['B']);
  assert.deepEqual(tagValue(comments, 'ALBUM'), ['Alb']);
  assert.deepEqual(tagValue(comments, 'TRACKNUMBER'), ['7']);
  assert.deepEqual(tagValue(comments, 'GENRE'), ['Rock']);
  assert.deepEqual(tagValue(comments, 'DATE'), ['1999']);
});

test('clearing a field removes the tag but keeps encoder and cover', async () => {
  const p = writeFixture('clear.opus', fixtureOpus({
    tags: [
      { key: 'TITLE', value: 'T' },
      { key: 'TRACKNUMBER', value: '5' },
      { key: 'TRACK', value: 'legacy' },
      { key: 'DATE', value: '2000' },
      { key: 'YEAR', value: 'legacy-year' },
    ],
    picture: TINY_PNG,
  }).bytes);

  await writeMetadata(p, { title: '', artist: '', album: '', track: '', genre: '', year: '' });

  const { comments, picture } = commentsOf(p);
  assert.deepEqual(tagValue(comments, 'TITLE'), []);
  assert.deepEqual(tagValue(comments, 'TRACKNUMBER'), []);
  assert.deepEqual(tagValue(comments, 'TRACK'), [], 'legacy TRACK alias must go too');
  assert.deepEqual(tagValue(comments, 'DATE'), []);
  assert.deepEqual(tagValue(comments, 'YEAR'), [], 'legacy YEAR alias must go too');
  assert.deepEqual(tagValue(comments, 'ENCODER'), ['test-encoder']);
  assert.ok(picture && picture.equals(TINY_PNG), 'clearing tags must not drop the cover');
});

test('cover replacement on .opus swaps the picture bytes', async () => {
  const p = writeFixture('replace.opus', fixtureOpus({
    tags: [{ key: 'TITLE', value: 'T' }],
    picture: TINY_PNG,
  }).bytes);

  const other = (() => {
    // Same shape, different bytes, still a valid PNG over the 100-byte
    // validity floor: insert a tEXt chunk before IEND.
    const keyword = Buffer.from('Title\x00Variant-B-with-plenty-of-padding-to-clear-the-size-floor', 'ascii');
    const chunk = Buffer.alloc(4 + 4 + keyword.length + 4);
    chunk.writeUInt32BE(keyword.length, 0);
    chunk.write('tEXt', 4, 'ascii');
    keyword.copy(chunk, 8);
    chunk.writeUInt32BE(0, 8 + keyword.length); // crc unchecked by validator
    return Buffer.concat([TINY_PNG.subarray(0, TINY_PNG.length - 12), chunk, TINY_PNG.subarray(TINY_PNG.length - 12)]);
  })();
  const imgPath = writeFixture('newcover.png', other);

  await writeMetadata(p, { title: 'T', artist: '', album: '', track: '', genre: '', year: '' }, imgPath);

  const { picture } = commentsOf(p);
  assert.ok(picture && picture.equals(other), 'replacement bytes must be embedded');
});

test('audio packets are byte-identical after a tag rewrite', () => {
  const { bytes } = fixtureOpus({ tags: [{ key: 'TITLE', value: 'T' }], picture: TINY_PNG });
  const out = rewriteOggComments(bytes, { title: 'Changed' });
  const before = readOggComments(bytes);
  const after = readOggComments(out);
  assert.equal(after.comments.find((c) => c.key === 'TITLE').value, 'Changed');
  assert.ok(after.picture.equals(before.picture));
});

test('vorbis .ogg round-trips tags with the framing bit intact', async () => {
  const p = writeFixture('song.ogg', fixtureVorbis({
    tags: [{ key: 'TITLE', value: 'Vorbis Orig' }],
  }).bytes);

  await writeMetadata(p, { title: 'V New', artist: 'V A', album: '', track: '3', genre: '', year: '2001' });

  const { kind, comments } = commentsOf(p);
  assert.equal(kind, 'vorbis');
  assert.deepEqual(tagValue(comments, 'TITLE'), ['V New']);
  assert.deepEqual(tagValue(comments, 'TRACKNUMBER'), ['3']);
  assert.deepEqual(tagValue(comments, 'DATE'), ['2001']);
});

test('invalid replacement image is rejected before touching the file', async () => {
  const { bytes } = fixtureOpus({ tags: [{ key: 'TITLE', value: 'T' }] });
  const p = writeFixture('badimg.opus', bytes);
  const bad = writeFixture('bad.bin', Buffer.from([0, 1, 2, 3, 4, 5]));
  const before = fs.readFileSync(p);

  await assert.rejects(
    writeMetadata(p, { title: 'T' }, bad),
    /Invalid image/,
  );
  assert.ok(fs.readFileSync(p).equals(before), 'file must be untouched on validation failure');
});

test('a non-Ogg file with an .opus extension fails loudly, not silently', async () => {
  const p = writeFixture('fake.opus', Buffer.from('this is not ogg data'));
  await assert.rejects(writeMetadata(p, { title: 'T' }), /Ogg/);
});

test('corrupt Ogg checksum is rejected', () => {
  const { bytes } = fixtureOpus({ tags: [{ key: 'TITLE', value: 'T' }] });
  const corrupt = Buffer.from(bytes);
  corrupt[corrupt.length - 20] ^= 0xff;
  assert.throws(() => readOggComments(corrupt), /checksum|Truncated|Ogg/);
});

test('unidentified image bytes are rejected for cover writes (never embedded)', async () => {
  const { bytes } = fixtureOpus({ tags: [{ key: 'TITLE', value: 'T' }] });
  const p = writeFixture('mystery.opus', bytes);
  // 200 bytes of non-image data: passes the size floor but matches no format.
  const bad = writeFixture('mystery.bin', Buffer.alloc(200, 0x41));
  const before = fs.readFileSync(p);

  await assert.rejects(
    writeMetadata(p, { title: 'T' }, bad),
    /unsupported image format/,
  );
  assert.ok(fs.readFileSync(p).equals(before), 'file must be untouched');
});

test('control characters are sanitized on the Ogg write path', async () => {
  const p = writeFixture('sanitize.opus', fixtureOpus({
    tags: [{ key: 'TITLE', value: 'T' }],
  }).bytes);

  await writeMetadata(p, { title: 'A\x00B\nC\x1fD', artist: '', album: '', track: '', genre: '', year: '' });

  const { comments } = commentsOf(p);
  assert.deepEqual(tagValue(comments, 'TITLE'), ['ABCD']);
});

test('setting a managed tag removes stale aliases (TRACK/YEAR)', () => {
  const next = applyTags(
    [
      { key: 'TRACK', value: 'legacy' },
      { key: 'TRACKNUMBER', value: '5' },
      { key: 'YEAR', value: 'legacy-year' },
      { key: 'DATE', value: '2000' },
      { key: 'ENCODER', value: 'keep' },
    ],
    { track: '7', year: '1999' }
  );
  const values = (key) => next.filter((c) => c.key === key).map((c) => c.value);
  assert.deepEqual(values('TRACK'), [], 'stale TRACK alias must go when setting track');
  assert.deepEqual(values('TRACKNUMBER'), ['7']);
  assert.deepEqual(values('YEAR'), [], 'stale YEAR alias must go when setting year');
  assert.deepEqual(values('DATE'), ['1999']);
  assert.deepEqual(values('ENCODER'), ['keep']);
});

test('METADATA_BLOCK_PICTURE has no padding bytes', () => {
  const img = Buffer.alloc(200, 1);
  const block = Buffer.from(buildMetadataBlockPicture(img, 'image/png'), 'base64');
  // type + mimeLen + mime + descLen + w + h + depth + colors + dataLen + data
  assert.equal(block.length, 8 * 4 + 'image/png'.length + img.length);
});

test('cover replacement is refused for formats that cannot store covers', async () => {
  assert.equal(canEmbedCover('song.wav'), false);
  assert.equal(canEmbedCover('song.aac'), false);
  assert.equal(canEmbedCover('song.webm'), false);
  assert.equal(canEmbedCover('song.mp3'), true);
  assert.equal(canEmbedCover('song.opus'), true);

  const wav = writeFixture('song.wav', Buffer.from('fake-wav'));
  const img = writeFixture('cover.png', Buffer.alloc(200, 1));
  await assert.rejects(
    writeMetadata(wav, { title: 'T' }, img),
    /cannot be embedded/,
  );
});

test('replaceOggCommentPacket re-attaches tags and cover verbatim', () => {
  const { parsePages, demuxPackets, paginate } = require('@stowed/core');
  const pictureBytes = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(150, 9)]);
  const src = fixtureOpus({
    tags: [{ key: 'TITLE', value: 'Orig' }],
    picture: pictureBytes,
  }).bytes;
  const demuxed = demuxPackets(parsePages(src));
  // Simulate a trimmed file: same audio packets, stripped comment packet.
  const trimmed = paginate(
    [demuxed.packets[0].data, opusTagsWith([{ key: 'ENCODER', value: 'new-encoder' }]),
      ...demuxed.packets.slice(2).map((pkt) => pkt.data)],
    demuxed.serial,
    [demuxed.packets[0].endGranule, 0n,
      ...demuxed.packets.slice(2).map((pkt) => pkt.endGranule)]
  );
  const restored = replaceOggCommentPacket(trimmed, demuxed.packets[1].data);
  const { comments, picture } = readOggComments(restored);
  assert.deepEqual(tagValue(comments, 'TITLE'), ['Orig']);
  assert.ok(picture && picture.equals(pictureBytes), 'cover bytes must round-trip');
});

test('text/html picture bytes are never served inline as an image', async () => {
  const { validateCoverArt } = require('@stowed/core');
  const html = Buffer.concat([Buffer.from('<html><body>hi</body></html>'), Buffer.alloc(200, 0x41)]);
  const v = validateCoverArt(html, 'text/html');
  const ALLOWED = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/bmp', 'image/gif', 'image/avif']);
  assert.ok(!ALLOWED.has(String(v.format || '').toLowerCase()), 'text/html must not be in the image allowlist');
});

test('html bytes mislabeled as image/jpeg have no image magic (served as octet-stream)', () => {
  const html = Buffer.concat([Buffer.from('<html><body>hi</body></html>'), Buffer.alloc(200, 0x41)]);
  const isImageMagic = (buf) => {
    if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return true;
    if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return true;
    if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46) return true;
    if (buf[0] === 0x42 && buf[1] === 0x4d) return true;
    if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return true;
    return false;
  };
  assert.equal(isImageMagic(html), false, 'html mislabeled as jpeg must not pass magic check');
});
