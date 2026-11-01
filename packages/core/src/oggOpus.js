/**
 * Minimal Ogg Opus / Ogg Vorbis tag reader/writer for Stow apps.
 *
 * Why this exists: FFmpeg cannot mux an attached-picture video stream into
 * Ogg/Opus, and its global `-metadata` options do not reliably update the
 * stream-level Vorbis comments that Opus files already carry. The result was:
 *  - tag saves on covered .opus files failed loudly (exit 234), and
 *  - tag saves on tagged-but-coverless .opus files exited 0 but changed nothing.
 *
 * This module edits the OpusTags / Vorbis-comment packet in place (pure JS,
 * no re-encode, audio bit-identical) while preserving every other packet,
 * including an existing METADATA_BLOCK_PICTURE cover.
 *
 * Ogg layout notes:
 *  - Packet 0: OpusHead ("OpusHead") or Vorbis ident ("\x01vorbis").
 *  - Packet 1: OpusTags ("OpusTags") or Vorbis comments ("\x03vorbis").
 *  - Rest: audio packets. Header pages carry granule 0.
 */

const OPUS_HEAD_MAGIC = Buffer.from('OpusHead', 'ascii');
const OPUS_TAGS_MAGIC = Buffer.from('OpusTags', 'ascii');
const VORBIS_ID_MAGIC = Buffer.from([0x01, ...Buffer.from('vorbis', 'ascii')]);
const VORBIS_COMMENT_MAGIC = Buffer.from([0x03, ...Buffer.from('vorbis', 'ascii')]);

// Ogg CRC32 (poly 0x04C11DB7, init 0). Not the IEEE/zlib variant.
const CRC_TABLE = (() => {
  const poly = 0x04c11db7;
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let r = (i << 24) >>> 0;
    for (let j = 0; j < 8; j++) {
      if (r & 0x80000000) r = (((r << 1) ^ poly) >>> 0);
      else r = ((r << 1) >>> 0);
    }
    table[i] = r >>> 0;
  }
  return table;
})();

function oggCrc(buf) {
  let crc = 0;
  for (let i = 0; i < buf.length; i++) {
    crc = (((crc << 8) >>> 0) ^ CRC_TABLE[(((crc >>> 24) ^ buf[i]) & 0xff)]) >>> 0;
  }
  return crc >>> 0;
}

/**
 * Parse a buffer into Ogg pages.
 * @returns {Array<{headerType:number, granule:bigint, serial:number, seq:number, segments:Buffer, body:Buffer}>}
 */
function parsePages(buf) {
  const pages = [];
  let pos = 0;
  while (pos + 27 <= buf.length) {
    if (buf[pos] !== 0x4f || buf[pos + 1] !== 0x67 || buf[pos + 2] !== 0x67 || buf[pos + 3] !== 0x53) {
      throw new Error('Not an Ogg file (bad page magic)');
    }
    const headerType = buf[pos + 5];
    const granule = buf.readBigUInt64LE(pos + 6);
    const serial = buf.readUInt32LE(pos + 14);
    const seq = buf.readUInt32LE(pos + 18);
    const nseg = buf[pos + 26];
    if (pos + 27 + nseg > buf.length) throw new Error('Truncated Ogg page header');
    const segments = buf.subarray(pos + 27, pos + 27 + nseg);
    const bodyLen = Array.from(segments).reduce((a, b) => a + b, 0);
    const bodyStart = pos + 27 + nseg;
    if (bodyStart + bodyLen > buf.length) throw new Error('Truncated Ogg page body');
    const body = buf.subarray(bodyStart, bodyStart + bodyLen);

    // Verify checksum (zero the crc field first).
    const stored = buf.readUInt32LE(pos + 22);
    const pageBytes = Buffer.from(buf.subarray(pos, bodyStart + bodyLen));
    pageBytes.writeUInt32LE(0, 22);
    if (oggCrc(pageBytes) !== stored) {
      throw new Error('Ogg page checksum mismatch (file may be corrupt)');
    }

    pages.push({ headerType, granule, serial, seq, segments: Buffer.from(segments), body: Buffer.from(body) });
    pos = bodyStart + bodyLen;
  }
  if (pages.length === 0) throw new Error('Not an Ogg file (no pages)');
  return pages;
}

/**
 * Demux pages into packets, tracking the granule position of the page on
 * which each packet ends.
 * @returns {{packets: Array<{data: Buffer, endGranule: bigint}>, serial: number}}
 */
function demuxPackets(pages) {
  const packets = [];
  let cur = [];
  let curLen = 0;
  const serial = pages[0].serial;
  for (const page of pages) {
    let bodyOff = 0;
    for (let i = 0; i < page.segments.length; i++) {
      const segLen = page.segments[i];
      cur.push(page.body.subarray(bodyOff, bodyOff + segLen));
      curLen += segLen;
      bodyOff += segLen;
      if (segLen < 255) {
        packets.push({ data: Buffer.concat(cur, curLen), endGranule: page.granule });
        cur = [];
        curLen = 0;
      }
    }
  }
  // A well-formed file ends every packet; a trailing partial is corrupt.
  if (cur.length > 0) throw new Error('Truncated Ogg packet at end of file');
  return { packets, serial };
}

function isOpusHead(p) {
  return p.length >= 8 && p.subarray(0, 8).equals(OPUS_HEAD_MAGIC);
}

function isVorbisId(p) {
  return p.length >= 7 && p.subarray(0, 7).equals(VORBIS_ID_MAGIC);
}

/** @returns {{kind: 'opus'|'vorbis', headerLen: number}} */
function commentPacketInfo(p) {
  if (p.length >= 8 && p.subarray(0, 8).equals(OPUS_TAGS_MAGIC)) {
    return { kind: 'opus', headerLen: 8 };
  }
  if (p.length >= 7 && p.subarray(0, 7).equals(VORBIS_COMMENT_MAGIC)) {
    return { kind: 'vorbis', headerLen: 7 };
  }
  return null;
}

/**
 * Decode a Vorbis-comments style packet body (after the magic header).
 * @returns {{vendor: string, comments: Array<{key: string, value: string}>}}
 */
function decodeComments(packet, headerLen) {
  let off = headerLen;
  const vendorLen = packet.readUInt32LE(off); off += 4;
  const vendor = packet.subarray(off, off + vendorLen).toString('utf8'); off += vendorLen;
  const count = packet.readUInt32LE(off); off += 4;
  const comments = [];
  for (let i = 0; i < count; i++) {
    if (off + 4 > packet.length) throw new Error('Truncated Vorbis comment');
    const len = packet.readUInt32LE(off); off += 4;
    if (off + len > packet.length) throw new Error('Truncated Vorbis comment');
    const raw = packet.subarray(off, off + len).toString('utf8'); off += len;
    const eq = raw.indexOf('=');
    if (eq === -1) comments.push({ key: raw, value: '' });
    else comments.push({ key: raw.slice(0, eq), value: raw.slice(eq + 1) });
  }
  return { vendor, comments };
}

function encodeComments(kind, vendor, comments) {
  const parts = [];
  parts.push(kind === 'opus' ? Buffer.from(OPUS_TAGS_MAGIC) : Buffer.from(VORBIS_COMMENT_MAGIC));
  const vendorBuf = Buffer.from(vendor, 'utf8');
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32LE(vendorBuf.length, 0);
  parts.push(lenBuf, vendorBuf);
  const countBuf = Buffer.alloc(4);
  countBuf.writeUInt32LE(comments.length, 0);
  parts.push(countBuf);
  for (const { key, value } of comments) {
    const s = Buffer.from(`${key}=${value}`, 'utf8');
    const lb = Buffer.alloc(4);
    lb.writeUInt32LE(s.length, 0);
    parts.push(lb, s);
  }
  if (kind === 'vorbis') parts.push(Buffer.from([0x01])); // framing bit
  return Buffer.concat(parts);
}

// UI tag key -> canonical Vorbis comment key.
const TAG_TO_VORBIS = {
  title: 'TITLE',
  artist: 'ARTIST',
  album: 'ALBUM',
  track: 'TRACKNUMBER',
  genre: 'GENRE',
  year: 'DATE',
};

// Keys removed when the corresponding UI field is cleared (aliases included).
const CLEAR_ALIASES = {
  title: ['TITLE'],
  artist: ['ARTIST'],
  album: ['ALBUM'],
  track: ['TRACKNUMBER', 'TRACK'],
  genre: ['GENRE'],
  year: ['DATE', 'YEAR'],
};

/**
 * Apply UI tags onto a Vorbis comment list. Empty/missing values delete the
 * key (so clearing a field removes the tag). All other keys — including
 * ENCODER and METADATA_BLOCK_PICTURE — are preserved byte-for-value.
 */
function applyTags(comments, tags) {
  const wanted = new Map(); // UPPER canonical key -> string|null (null = delete)
  const doomed = new Set(); // every managed UPPER key, aliases included
  for (const [uiKey, vorbisKey] of Object.entries(TAG_TO_VORBIS)) {
    for (const alias of (CLEAR_ALIASES[uiKey] || [vorbisKey])) doomed.add(alias);
    const raw = tags?.[uiKey];
    const value = typeof raw === 'string' ? raw : '';
    wanted.set(vorbisKey, value === '' ? null : value);
  }
  // Drop every existing entry whose key is managed (case-insensitive), so a
  // stale TRACK alias can never survive setting TRACKNUMBER (and vice versa).
  const kept = comments.filter((c) => !doomed.has(c.key.toUpperCase()));
  // Append managed keys in stable UI order.
  for (const uiKey of Object.keys(TAG_TO_VORBIS)) {
    const vorbisKey = TAG_TO_VORBIS[uiKey];
    const value = wanted.get(vorbisKey);
    if (value !== null) kept.push({ key: vorbisKey, value });
  }
  return kept;
}

function detectImageMime(data) {
  if (!data || data.length < 4) return 'image/jpeg';
  if (data[0] === 0xff && data[1] === 0xd8) return 'image/jpeg';
  if (data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47) return 'image/png';
  if (data[0] === 0x47 && data[1] === 0x49 && data[2] === 0x46) return 'image/gif';
  if (data[0] === 0x52 && data[1] === 0x49 && data[2] === 0x46 && data[3] === 0x46) return 'image/webp';
  if (data[0] === 0x42 && data[1] === 0x4d) return 'image/bmp';
  return 'image/jpeg';
}

function pngDimensions(data) {
  try {
    if (data.length >= 24 && data[0] === 0x89 && data[1] === 0x50) {
      return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
    }
  } catch (_) {}
  return { width: 0, height: 0 };
}

function jpegDimensions(data) {
  try {
    let off = 2;
    while (off + 4 < data.length) {
      if (data[off] !== 0xff) break;
      const marker = data[off + 1];
      if (marker === 0xd8 || marker === 0xd9) { off += 2; continue; }
      const len = data.readUInt16BE(off + 2);
      if (marker >= 0xc0 && marker <= 0xc3) {
        return { width: data.readUInt16BE(off + 7), height: data.readUInt16BE(off + 5) };
      }
      off += 2 + len;
    }
  } catch (_) {}
  return { width: 0, height: 0 };
}

/**
 * Build a FLAC METADATA_BLOCK_PICTURE value (base64 of the Picture block)
 * for embedding image bytes as an Ogg Vorbis comment.
 */
function buildMetadataBlockPicture(imageData, mime) {
  const m = mime || detectImageMime(imageData);
  let width = 0;
  let height = 0;
  if (m === 'image/png') ({ width, height } = pngDimensions(imageData));
  else if (m === 'image/jpeg') ({ width, height } = jpegDimensions(imageData));
  const mimeBuf = Buffer.from(m, 'ascii');
  // type + mimeLen + mime + descLen + w + h + depth + colors + dataLen + data
  const block = Buffer.alloc(8 * 4 + mimeBuf.length + imageData.length);
  let off = 0;
  block.writeUInt32BE(3, off); off += 4; // front cover
  block.writeUInt32BE(mimeBuf.length, off); off += 4;
  mimeBuf.copy(block, off); off += mimeBuf.length;
  block.writeUInt32BE(0, off); off += 4; // empty description
  block.writeUInt32BE(width, off); off += 4;
  block.writeUInt32BE(height, off); off += 4;
  block.writeUInt32BE(24, off); off += 4; // depth (best effort)
  block.writeUInt32BE(0, off); off += 4; // colors
  block.writeUInt32BE(imageData.length, off); off += 4;
  Buffer.from(imageData).copy(block, off);
  return block.toString('base64');
}

/**
 * Paginate packets into Ogg pages. Header packets (first two) get granule 0;
 * audio pages carry the end granule of the last audio packet completing on
 * the page. Large packets are split across pages with the continued flag.
 */
function paginate(packets, serial, packetGranules) {
  const pages = [];
  let seq = 0;
  let curSegments = []; // lengths
  let curBody = [];
  let curLen = 0;
  let curHasPacketEnd = false;
  let curLastGranule = 0n;
  let curStartsContinued = false;

  const MAX_SEGMENTS = 100;

  function flushPage(headerTypeOverride, granuleOverride) {
    const segments = Buffer.from(curSegments);
    const header = Buffer.alloc(27 + segments.length);
    header.write('OggS', 0, 'ascii');
    header[4] = 0;
    let ht = headerTypeOverride;
    if (ht === null) {
      ht = 0;
      if (pages.length === 0) ht |= 0x02; // BOS on first page
      if (curStartsContinued) ht |= 0x01;
    }
    header[5] = ht;
    header.writeBigUInt64LE(BigInt(granuleOverride), 6);
    header.writeUInt32LE(serial, 14);
    header.writeUInt32LE(seq, 18);
    header.writeUInt32LE(0, 22); // crc placeholder
    header[26] = segments.length;
    segments.copy(header, 27);
    const body = Buffer.concat(curBody, curLen);
    const page = Buffer.concat([header, body]);
    page.writeUInt32LE(oggCrc(page), 22);
    pages.push(page);
    seq += 1;
    curSegments = [];
    curBody = [];
    curLen = 0;
    curHasPacketEnd = false;
    curStartsContinued = false;
  }

  // Packet 0 (headers) each in their own page to keep it simple and valid.
  // Packet 0: BOS page (granule 0). Packet 1 (tags): granule -1 (0xFF..FF),
  // matching yt-dlp/ffmpeg output — music-metadata rejects 0 here for
  // multi-page headers.
  const HEADER_GRANULE = 18446744073709551615n;
  appendPacket(packets[0], 0n, true);
  // Packet 1 (tags): own page(s), granule -1. Flush so audio starts on a
  // fresh page (headers must not share a page with audio for strict parsers).
  appendPacket(packets[1], HEADER_GRANULE, false);
  if (curSegments.length > 0 || curBody.length > 0) {
    flushPage(null, HEADER_GRANULE);
    curStartsContinued = false;
  }

  for (let i = 2; i < packets.length; i++) {
    appendPacket(packets[i], packetGranules[i], false);
  }
  if (curSegments.length > 0 || curBody.length > 0) {
    flushPage(null, curLastGranule);
  }
  // Mark EOS on the final page.
  if (pages.length > 0) {
    const last = pages[pages.length - 1];
    last[5] = last[5] | 0x04;
    last.writeUInt32LE(0, 22);
    last.writeUInt32LE(oggCrc(last), 22);
  }
  return Buffer.concat(pages);

  function appendPacket(packet, endGranule, isBos) {
    let off = 0;
    let first = true;
    while (off < packet.length) {
      const spaceSegs = MAX_SEGMENTS - curSegments.length;
      // Reserve at least one segment slot; flush if full.
      if (spaceSegs === 0) {
        flushPage(null, curLastGranule);
        curStartsContinued = true;
        continue;
      }
      // How many bytes can we take? Each segment holds up to 255 bytes.
      // If this is the final chunk of the packet, the last segment must be
      // < 255 (0 for exact multiples) to terminate the packet.
      const remaining = packet.length - off;
      // Max bytes we can fit in remaining segment slots if we end the packet
      // here: (spaceSegs - 1) * 255 + 254 (last short segment).
      // Simpler: take up to spaceSegs*255, then fix up termination.
      let take = Math.min(remaining, spaceSegs * 255);
      const isFinal = take === remaining;
      // Build lacing for this chunk.
      const lacing = [];
      let chunkOff = off;
      let chunkRemaining = take;
      if (!isFinal) {
        // Non-final chunk must be all 255s (continuation).
        const nseg = Math.ceil(take / 255);
        for (let s = 0; s < nseg; s++) {
          lacing.push(255);
          curSegments.push(255);
          const slen = 255;
          curBody.push(packet.subarray(chunkOff, chunkOff + slen));
          curLen += slen;
          chunkOff += slen;
        }
        off += take;
        curStartsContinued = curStartsContinued || !first;
        first = false;
        flushPage(isBos && pages.length === 0 ? 0x02 : null, 18446744073709551615n);
        curStartsContinued = true;
        continue;
      }
      // Final chunk: lacing must end short.
      let full = Math.floor(take / 255);
      let rest = take % 255;
      if (rest === 0 && take > 0) {
        // Exact multiple: needs a trailing 0-length segment, which requires
        // an extra slot. If it doesn't fit, split.
        if (full + 1 > spaceSegs) {
          // Fill this page completely with 255s and continue.
          for (let s = 0; s < spaceSegs; s++) {
            curSegments.push(255);
            curBody.push(packet.subarray(chunkOff, chunkOff + 255));
            curLen += 255;
            chunkOff += 255;
          }
          off += spaceSegs * 255;
          first = false;
          flushPage(isBos && pages.length === 0 ? 0x02 : null, 18446744073709551615n);
          curStartsContinued = true;
          continue;
        }
        for (let s = 0; s < full; s++) lacing.push(255);
        lacing.push(0);
      } else {
        for (let s = 0; s < full; s++) lacing.push(255);
        lacing.push(rest);
      }
      for (const slen of lacing) {
        curSegments.push(slen);
        if (slen > 0) {
          curBody.push(packet.subarray(chunkOff, chunkOff + slen));
          curLen += slen;
          chunkOff += slen;
        }
      }
      off += take;
      curHasPacketEnd = true;
      curLastGranule = BigInt(endGranule);
      first = false;
      void chunkRemaining;
    }
    if (isBos) {
      // BOS packet always ends its page.
      flushPage(0x02, 0n);
    } else if (curSegments.length > 0 && (packet.length <= 65000 || curHasPacketEnd)) {
      // For header-sized packets, flush promptly so tags get their own page.
      // Audio packets flow on and share pages until full.
      if (endGranule === 0n) flushPage(null, 0n);
    }
  }
}

/**
 * Read decoded tags + cover presence from an Ogg Opus/Vorbis file.
 * @returns {{kind: 'opus'|'vorbis', vendor: string, comments: Array, picture: Buffer|null, pictureMime: string|null}}
 */
function readOggComments(fileBuf) {
  const pages = parsePages(fileBuf);
  const { packets } = demuxPackets(pages);
  if (packets.length < 2) throw new Error('Ogg file has no comment packet');
  if (!isOpusHead(packets[0].data) && !isVorbisId(packets[0].data)) {
    throw new Error('Not an Ogg Opus or Ogg Vorbis file');
  }
  const info = commentPacketInfo(packets[1].data);
  if (!info) throw new Error('Ogg comment packet not found');
  const { vendor, comments } = decodeComments(packets[1].data, info.headerLen);
  let picture = null;
  let pictureMime = null;
  for (const c of comments) {
    if (c.key.toUpperCase() === 'METADATA_BLOCK_PICTURE' && c.value) {
      try {
        const block = Buffer.from(c.value, 'base64');
        // Parse Picture block to extract mime + image bytes.
        let o = 0;
        o += 4; // type
        const mimeLen = block.readUInt32BE(o); o += 4;
        pictureMime = block.subarray(o, o + mimeLen).toString('ascii'); o += mimeLen;
        const descLen = block.readUInt32BE(o); o += 4; o += descLen;
        o += 16; // w/h/depth/colors
        const dataLen = block.readUInt32BE(o); o += 4;
        picture = block.subarray(o, o + dataLen);
      } catch (_) {
        picture = null;
      }
      break;
    }
  }
  return { kind: info.kind, vendor, comments, picture, pictureMime };
}

/**
 * Rewrite the comment packet of an Ogg Opus/Vorbis buffer.
 * @param {Buffer} fileBuf
 * @param {object} tags - UI tags {title,artist,album,track,genre,year}
 * @param {object} [options] - {coverImage?: Buffer, coverMime?: string, removeCover?: boolean}
 * @returns {Buffer} new file bytes
 */
function rewriteOggComments(fileBuf, tags, options = {}) {
  const pages = parsePages(fileBuf);
  const { packets, serial } = demuxPackets(pages);
  if (packets.length < 2) throw new Error('Ogg file has no comment packet');
  if (!isOpusHead(packets[0].data) && !isVorbisId(packets[0].data)) {
    throw new Error('Not an Ogg Opus or Ogg Vorbis file');
  }
  const info = commentPacketInfo(packets[1].data);
  if (!info) throw new Error('Ogg comment packet not found');
  const { vendor, comments } = decodeComments(packets[1].data, info.headerLen);

  let next = applyTags(comments, tags);

  if (options.coverImage) {
    const b64 = buildMetadataBlockPicture(Buffer.from(options.coverImage), options.coverMime);
    next = next.filter((c) => c.key.toUpperCase() !== 'METADATA_BLOCK_PICTURE');
    next.push({ key: 'METADATA_BLOCK_PICTURE', value: b64 });
  } else if (options.removeCover) {
    next = next.filter((c) => c.key.toUpperCase() !== 'METADATA_BLOCK_PICTURE');
  }

  const newPacket1 = encodeComments(info.kind, vendor, next);
  const newPackets = [packets[0].data, newPacket1, ...packets.slice(2).map((p) => p.data)];
  const granules = packets.map((p) => p.endGranule);
  // New tags packet ends at granule 0.
  const newGranules = [granules[0], 0n, ...granules.slice(2)];
  return paginate(newPackets, serial, newGranules);
}

/**
 * Splice a ready-made comment packet (packet 1) into an Ogg Opus/Vorbis
 * buffer, keeping every other packet byte-identical. Used by trim: the
 * ffmpeg re-encode cannot carry Vorbis comments (tags and the embedded
 * METADATA_BLOCK_PICTURE cover) into Ogg, so the original comment packet is
 * captured before trimming and re-attached afterwards.
 *
 * @param {Buffer} fileBuf - Ogg file to patch (e.g. fresh ffmpeg output)
 * @param {Buffer} commentPacket - complete packet-1 bytes (magic + comments)
 * @returns {Buffer} new file bytes
 */
function replaceOggCommentPacket(fileBuf, commentPacket) {
  const pages = parsePages(fileBuf);
  const { packets, serial } = demuxPackets(pages);
  if (packets.length < 2) throw new Error('Ogg file has no comment packet');
  if (!isOpusHead(packets[0].data) && !isVorbisId(packets[0].data)) {
    throw new Error('Not an Ogg Opus or Ogg Vorbis file');
  }
  const info = commentPacketInfo(packets[1].data);
  if (!info) throw new Error('Ogg comment packet not found');
  const replacement = commentPacketInfo(commentPacket);
  if (!replacement || replacement.kind !== info.kind) {
    throw new Error('Replacement comment packet kind mismatch');
  }
  const newPackets = [packets[0].data, Buffer.from(commentPacket), ...packets.slice(2).map((p) => p.data)];
  const granules = packets.map((p) => p.endGranule);
  const newGranules = [granules[0], 0n, ...granules.slice(2)];
  return paginate(newPackets, serial, newGranules);
}

module.exports = {
  parsePages,
  demuxPackets,
  paginate,
  decodeComments,
  encodeComments,
  commentPacketInfo,
  applyTags,
  readOggComments,
  rewriteOggComments,
  replaceOggCommentPacket,
  buildMetadataBlockPicture,
  detectImageMime,
};
