const path = require('path');
const fs = require('fs');
const os = require('os');
const express = require('express');
const multer = require('multer');
const { randomUUID } = require('crypto');
const config = require('./config');
const {
  resolveDownloadPath,
  isAudioFile,
  requireJson,
  validateDownloadUrl,
  rateLimitMiddleware,
  mutatingRateLimit,
} = require('./security');
const { readMetadata, getCoverArt, validateCoverArt } = require('./metadata-read');
const { writeMetadata, canEmbedCover } = require('./metadata');
const { MBID_RE, clampLimit, searchRecordings, getCoverImage } = require('./musicbrainz');
const { trimAudio, getDuration } = require('./trim');
const { getSettings, saveSettings, setCookiesState } = require('./settings');
const { getYtDlpStatus } = require('./ytdlpStatus');
const { inspectUrl } = require('./inspect');
const { getThumb } = require('./thumb');
const { readEntryTags, walkAudioFiles } = require('./library');

function isFilePath(filePath) {
  try {
    return fs.statSync(filePath).isFile();
  } catch (_) {
    return false;
  }
}

function mapTrimError(err, res) {
  const msg = (err && err.message) || 'Trim failed';
  if (/file not found/i.test(msg)) {
    res.status(404).json({ error: 'File not found' });
    return;
  }
  if (/busy|timed out/i.test(msg)) {
    const code = /busy/i.test(msg) ? 429 : 504;
    res.status(code).json({ error: msg });
    return;
  }
  if (/^invalid/i.test(msg)) {
    res.status(400).json({ error: msg });
    return;
  }
  console.error('[trim] failed:', msg);
  if (/libopus encoder missing/i.test(msg)) {
    res.status(500).json({ error: 'FFmpeg libopus encoder missing' });
    return;
  }
  res.status(500).json({ error: 'Trim failed' });
}

// Thumbnail uploads are capped; anything larger is rejected before it reaches
// ffmpeg. Cover art is validated (magic bytes + integrity) after upload.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024,
    files: 1,
    fields: 20,
    parts: 30,
    fieldSize: 256 * 1024,
  },
});

const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

function setupRoutes(app, downloadManager) {
  const router = express.Router();

  // Stricter cap on mutating (POST) API calls; the LAN-wide ceiling is applied
  // earlier in index.js.
  router.use((req, res, next) => {
    if (req.method !== 'POST') return next();
    return rateLimitMiddleware(mutatingRateLimit)(req, res, next);
  });

  // ---- Queue -------------------------------------------------------------

  router.get('/queue', (req, res) => {
    res.json(downloadManager.getQueue());
  });

  router.post('/queue', requireJson, (req, res) => {
    const urls = req.body && req.body.urls;
    if (!Array.isArray(urls) || urls.some((url) => typeof url !== 'string')) {
      res.status(400).json({ error: 'URLs must be an array of strings' });
      return;
    }

    const cleaned = urls.map((url) => url.trim()).filter(Boolean);
    if (cleaned.length === 0) {
      res.status(400).json({ error: 'No URLs provided' });
      return;
    }
    if (cleaned.length > config.maxUrlsPerRequest) {
      res.status(400).json({
        error: `Too many URLs (max ${config.maxUrlsPerRequest} per request)`,
      });
      return;
    }

    // SSRF guard: reject non-http(s) URLs and private/loopback literal targets.
    for (const url of cleaned) {
      const reason = validateDownloadUrl(url);
      if (reason) {
        res.status(400).json({ error: `URL blocked: ${reason}` });
        return;
      }
    }

    if (downloadManager.getQueue().length + cleaned.length > config.maxQueueSize) {
      res.status(400).json({ error: `Queue is full (max ${config.maxQueueSize} jobs)` });
      return;
    }

    const result = downloadManager.addJobs(cleaned);
    res.json(result);
  });

  router.post('/cancel', requireJson, (req, res) => {
    downloadManager.cancelAll();
    res.json({ ok: true });
  });

  router.post('/queue/retry', requireJson, (req, res) => {
    const id = req.body && req.body.id;
    if (typeof id !== 'string' || !id) {
      res.status(400).json({ error: 'id must be a string' });
      return;
    }
    const existing = downloadManager.getQueue().find((j) => j.id === id);
    if (!existing) {
      res.status(404).json({ error: 'Job not found' });
      return;
    }
    if (existing.status !== 'Failed') {
      res.status(409).json({ error: 'Only failed jobs can be retried' });
      return;
    }
    const job = downloadManager.retryJob ? downloadManager.retryJob(id) : null;
    if (!job || job === 'inactive') {
      res.status(409).json({ error: 'Job cannot be retried' });
      return;
    }
    const { process: _p, cancelled: _c, ...safeJob } = job;
    res.json({ ok: true, job: safeJob });
  });

  router.delete('/queue/:id', (req, res) => {
    const existing = downloadManager.getQueue().find((j) => j.id === req.params.id);
    if (!existing) {
      res.status(404).json({ error: 'Job not found' });
      return;
    }
    const ok = downloadManager.removeJob ? downloadManager.removeJob(req.params.id) : false;
    if (!ok) {
      res.status(404).json({ error: 'Job not found' });
      return;
    }
    res.json({ ok: true });
  });

  router.post('/cancel/:id', requireJson, (req, res) => {
    const existing = downloadManager.getQueue().find((j) => j.id === req.params.id);
    if (!existing) {
      res.status(404).json({ error: 'Job not found' });
      return;
    }
    const active = ['Pending', 'Fetching', 'Processing'].includes(existing.status);
    if (!active) {
      res.status(409).json({ error: 'Only active jobs can be cancelled' });
      return;
    }
    const result = downloadManager.cancelJob(req.params.id);
    if (result === false) {
      res.status(404).json({ error: 'Job not found' });
      return;
    }
    if (result === 'inactive') {
      res.status(409).json({ error: 'Only active jobs can be cancelled' });
      return;
    }
    res.json({ ok: true });
  });

  // Delete files from the download dir — but ONLY files that belong to a
  // currently "Complete" queue job. This preserves the desktop app's guard
  // against arbitrary file deletion via the API.
  router.post('/delete-files', requireJson, (req, res) => {
    const filePaths = req.body && req.body.filePaths;
    if (!Array.isArray(filePaths) || filePaths.some((fp) => typeof fp !== 'string')) {
      res.status(400).json({ error: 'filePaths must be an array of strings' });
      return;
    }

    const allowedPaths = new Set(
      downloadManager
        .getQueue()
        .filter((job) => job.status === 'Complete' && job.outputPath)
        .map((job) => path.resolve(job.outputPath))
    );

    const results = [];
    for (const fp of filePaths) {
      let resolved;
      try {
        resolved = resolveDownloadPath(fp);
      } catch (err) {
        results.push({ path: fp, deleted: false, reason: err.message });
        continue;
      }
      if (!allowedPaths.has(resolved)) {
        results.push({ path: fp, deleted: false, reason: 'not an active completed download' });
        continue;
      }
      try {
        if (fs.existsSync(resolved)) {
          fs.unlinkSync(resolved);
          results.push({ path: fp, deleted: true });
        } else {
          results.push({ path: fp, deleted: false, reason: 'not found' });
        }
      } catch (err) {
        results.push({ path: fp, deleted: false, reason: err.message });
      }
    }
    res.json(results);
  });

  // ---- File browser (lists the download directory; the desktop app uses
  // a native "Open File" dialog for this instead) -------------
  router.get('/files', (req, res) => {
    const dir = (req.query.dir && String(req.query.dir)) || config.downloadDir;
    let resolvedDir;
    try {
      resolvedDir = resolveDownloadPath(dir);
    } catch (err) {
      res.status(400).json({ error: err.message });
      return;
    }
    let isDir = false;
    try {
      isDir = fs.existsSync(resolvedDir) && fs.statSync(resolvedDir).isDirectory();
    } catch (_) {
      isDir = false; // deleted/moved between resolve and stat — treat as invalid
    }
    if (!isDir) {
      res.status(400).json({ error: 'Not a directory' });
      return;
    }

    let names;
    try {
      names = fs.readdirSync(resolvedDir, { withFileTypes: true });
    } catch (err) {
      console.error('[files] failed to read directory:', err.message);
      res.status(500).json({ error: 'Failed to read directory' });
      return;
    }

    const entries = names
      .filter((dirent) => {
        // Hide staging/transient artifacts from the browser list view.
        if (dirent.name.startsWith('.')) return false;
        if (dirent.name.includes('_trim_') || dirent.name.includes('_temp_')) return false;
        if (dirent.name.endsWith('.part') || dirent.name.endsWith('.tmp')) return false;
        return true;
      })
      .map((dirent) => {
        const fullPath = path.join(resolvedDir, dirent.name);
        const isDirectory = dirent.isDirectory();
        return {
          name: dirent.name,
          path: fullPath,
          isDirectory,
          isAudio: isDirectory ? false : isAudioFile(fullPath),
        };
      })
      .sort((a, b) => {
        if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
        return a.name.localeCompare(b.name);
      });

    const parentDir = path.dirname(resolvedDir);
    const relParent = path.relative(config.downloadDir, parentDir);
    const inDownloadDir = relParent !== '..' && !path.isAbsolute(relParent);

    res.json({
      dir: resolvedDir,
      parent: inDownloadDir ? parentDir : null,
      entries,
    });
  });

  // ---- Download / open a completed file ---------------------------------
  router.get('/file', (req, res) => {
    let filePath;
    try {
      filePath = resolveDownloadPath(req.query.path);
    } catch (err) {
      res.status(400).json({ error: err.message });
      return;
    }
    if (!isFilePath(filePath)) {
      res.status(404).json({ error: 'File not found' });
      return;
    }

    const asDownload = req.query.download === '1';
    res.set('Cache-Control', 'no-store');
    res.set('X-Content-Type-Options', 'nosniff');
    // Non-audio files are always served as attachments: serving e.g. an HTML
    // or SVG file inline would execute it in the app's origin, where script
    // could read the stored API key and call the API (stored XSS).
    if (asDownload || !isAudioFile(filePath)) {
      const encoded = encodeURIComponent(path.basename(filePath)).replace(
        /['()]/g,
        (c) => `%${c.charCodeAt(0).toString(16)}`
      );
      res.set('Content-Disposition', `attachment; filename*=UTF-8''${encoded}`);
    }
    res.sendFile(filePath);
  });

  // ---- Metadata read -----------------------------------------------------
  router.get('/metadata', asyncHandler(async (req, res) => {
    let filePath;
    try {
      filePath = resolveDownloadPath(req.query.path);
    } catch (err) {
      res.status(400).json({ error: err.message });
      return;
    }
    if (!fs.existsSync(filePath)) {
      res.status(404).json({ error: 'File not found' });
      return;
    }
    const result = await readMetadata(filePath);
    res.json({ ...result, path: filePath });
  }));

  // Cover art as an image so the editor can use <img src="/api/cover?...">.
  // MIME is derived from magic bytes, never from the declared picture format:
  // unknown bytes are served as octet-stream attachments so HTML/SVG in a
  // picture block can never execute inline.
  function detectCoverMime(buf) {
    if (!buf || buf.length < 12) return null;
    if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
    if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
    if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 && buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) return 'image/webp';
    if (buf[0] === 0x42 && buf[1] === 0x4d) return 'image/bmp';
    if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return 'image/gif';
    return null;
  }
  router.get('/cover', asyncHandler(async (req, res) => {
    let filePath;
    try {
      filePath = resolveDownloadPath(req.query.path);
    } catch (err) {
      res.status(400).json({ error: err.message });
      return;
    }
    if (!fs.existsSync(filePath)) {
      res.status(404).json({ error: 'File not found' });
      return;
    }
    const cover = await getCoverArt(filePath);
    if (!cover) {
      res.status(404).json({ error: 'No cover art' });
      return;
    }
    const ALLOWED = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/bmp', 'image/gif', 'image/avif']);
    const magicMime = detectCoverMime(cover.data);
    const declared = String(cover.format || '').toLowerCase();
    const mime = magicMime || null;
    if (!mime || !ALLOWED.has(mime)) {
      res.set('Content-Type', 'application/octet-stream');
      res.set('Content-Disposition', 'attachment; filename="cover.bin"');
      res.set('Cache-Control', 'no-store');
      res.set('X-Content-Type-Options', 'nosniff');
      res.send(cover.data);
      return;
    }
    // Only serve when declared format agrees with magic (or declared missing).
    if (declared && declared !== mime && !(declared === 'image/jpg' && mime === 'image/jpeg')) {
      res.set('Content-Type', 'application/octet-stream');
      res.set('Content-Disposition', 'attachment; filename="cover.bin"');
      res.set('Cache-Control', 'no-store');
      res.set('X-Content-Type-Options', 'nosniff');
      res.send(cover.data);
      return;
    }
    res.set('Content-Type', mime);
    res.set('Cache-Control', 'no-store');
    res.set('X-Content-Type-Options', 'nosniff');
    res.send(cover.data);
  }));

  // ---- Metadata write ----------------------------------------------------
  // Single handler that works for both a plain JSON tag write and a
  // multipart write with an optional thumbnail file. multer ignores requests
  // that aren't multipart/form-data, so JSON bodies (parsed by app-level
  // express.json) flow through req.body unchanged.
  router.post('/metadata', upload.single('thumbnail'), (req, res) => {
    const body = { ...req.body };
    if (typeof body.tags === 'string') {
      try {
        body.tags = JSON.parse(body.tags);
      } catch (_) {
        res.status(400).json({ error: 'tags must be a JSON object' });
        return;
      }
    }

    // Resolve + validate the target file first.
    let filePath;
    try {
      filePath = resolveDownloadPath(body.path);
    } catch (err) {
      res.status(400).json({ error: err.message });
      return;
    }
    if (!fs.existsSync(filePath)) {
      res.status(404).json({ error: 'File not found' });
      return;
    }

    // Ogg Opus / Ogg Vorbis covers are stored as a METADATA_BLOCK_PICTURE
    // Vorbis comment (not an attached-picture stream), which writeMetadata
    // handles natively. WAV / raw AAC / WebM cannot carry a cover at all, so
    // reject those up front instead of failing inside ffmpeg.
    if (req.file && !canEmbedCover(filePath)) {
      res.status(400).json({
        error: `Cover art cannot be embedded in ${path.extname(filePath) || 'this file'} files`,
      });
      return;
    }

    const tags = (body.tags && typeof body.tags === 'object') ? body.tags : {};

    // No thumbnail: just write tags.
    if (!req.file) {
      writeMetadata(filePath, tags)
        .then((result) => res.json({ success: true, filePath: result }))
        .catch((err) => {
          console.error('[metadata] write failed:', err.message);
          res.status(500).json({ error: 'Failed to write metadata' });
        });
      return;
    }

    // Validate the uploaded image before it ever reaches ffmpeg.
    const validation = validateCoverArt(req.file.buffer, req.file.mimetype);
    if (!validation.valid) {
      res.status(400).json({ error: `Invalid image: ${validation.reason || 'unsupported format'}` });
      return;
    }

    const tempFile = path.join(os.tmpdir(), `stow-thumb-${randomUUID()}.img`);
    try {
      fs.writeFileSync(tempFile, req.file.buffer);
    } catch (err) {
      res.status(500).json({ error: `Failed to store thumbnail: ${err.message}` });
      return;
    }

    writeMetadata(filePath, tags, tempFile)
      .then((result) => res.json({ success: true, filePath: result }))
      .catch((err) => {
        console.error('[metadata] write failed:', err.message);
        res.status(500).json({ error: 'Failed to write metadata' });
      })
      .finally(() => {
        try { fs.unlinkSync(tempFile); } catch (_) {}
      });
  });

  // ---- MusicBrainz lookup --------------------------------------------------
  router.get('/mb/search', asyncHandler(async (req, res) => {
    const title = req.query.title != null ? String(req.query.title).trim() : '';
    const artist = req.query.artist != null ? String(req.query.artist).trim() : '';
    const album = req.query.album != null ? String(req.query.album).trim() : '';
    if (!title && !artist && !album) {
      res.status(400).json({ error: 'At least one of title, artist, album is required' });
      return;
    }
    if (title.length > 200 || artist.length > 200 || album.length > 200) {
      res.status(400).json({ error: 'Search fields must be 200 characters or fewer' });
      return;
    }
    let limit = clampLimit(req.query.limit, 5);
    try {
      const results = await searchRecordings({ title, artist, album, limit });
      res.json({ results });
    } catch (err) {
      const msg = (err && err.message) || 'MusicBrainz lookup failed';
      const status = err && err.status;
      if (/busy/i.test(msg)) {
        res.status(429).json({ error: msg });
        return;
      }
      if (status === 429 || status === 503) {
        if (status === 429) res.set('Retry-After', '1');
        res.status(status).json({ error: 'MusicBrainz is rate-limiting requests, try again shortly' });
        return;
      }
      if (/timed out/i.test(msg)) {
        res.status(504).json({ error: 'MusicBrainz lookup timed out' });
        return;
      }
      if (/^invalid/i.test(msg)) {
        res.status(400).json({ error: msg });
        return;
      }
      console.error('[mb/search] failed:', msg);
      res.status(502).json({ error: 'MusicBrainz lookup failed' });
    }
  }));

  router.get('/mb/cover', asyncHandler(async (req, res) => {
    const releaseId = req.query.releaseId != null ? String(req.query.releaseId) : '';
    if (!releaseId || !MBID_RE.test(releaseId)) {
      res.status(400).json({ error: 'Invalid releaseId' });
      return;
    }
    try {
      const cover = await getCoverImage(releaseId);
      if (!cover || !cover.found) {
        res.status(404).json({ error: 'No cover art' });
        return;
      }
      res.set('Content-Type', cover.contentType || 'image/jpeg');
      // Private: with STOW_API_KEY the key travels in ?apikey=, which would
      // otherwise become part of the cache key in shared caches.
      res.set('Cache-Control', 'private, max-age=86400');
      res.set('X-Content-Type-Options', 'nosniff');
      res.send(cover.data);
    } catch (err) {
      const msg = (err && err.message) || 'Cover fetch failed';
      const status = err && err.status;
      if (/busy/i.test(msg)) {
        res.status(429).json({ error: msg });
        return;
      }
      if (status === 429 || status === 503) {
        if (status === 429) res.set('Retry-After', '1');
        res.status(status).json({ error: 'Cover service is rate-limiting requests, try again shortly' });
        return;
      }
      if (/timed out/i.test(msg)) {
        res.status(504).json({ error: 'Cover fetch timed out' });
        return;
      }
      if (/too large/i.test(msg)) {
        res.status(502).json({ error: msg });
        return;
      }
      console.error('[mb/cover] failed:', msg);
      res.status(502).json({ error: 'Cover fetch failed' });
    }
  }));

  // ---- Duration + trim -----------------------------------------------------
  router.get('/duration', asyncHandler(async (req, res) => {
    let filePath;
    try {
      filePath = resolveDownloadPath(req.query.path);
    } catch (err) {
      res.status(400).json({ error: err.message });
      return;
    }
    if (!fs.existsSync(filePath)) {
      res.status(404).json({ error: 'File not found' });
      return;
    }
    if (!isAudioFile(filePath) || !isFilePath(filePath)) {
      res.status(400).json({ error: 'Not an audio file' });
      return;
    }
    try {
      const duration = await getDuration(filePath);
      res.json({ path: filePath, duration });
    } catch (err) {
      const msg = (err && err.message) || 'Failed to read duration';
      if (/^invalid/i.test(msg)) {
        res.status(400).json({ error: 'Invalid audio file' });
      } else if (/busy|timed out/i.test(msg)) {
        const code = /busy/i.test(msg) ? 429 : 504;
        res.status(code).json({ error: msg });
      } else {
        console.error('[duration] failed:', msg);
        res.status(500).json({ error: 'Failed to read duration' });
      }
    }
  }));

  router.post('/trim', requireJson, asyncHandler(async (req, res) => {
    let filePath;
    try {
      filePath = resolveDownloadPath(req.body && req.body.path);
    } catch (err) {
      res.status(400).json({ error: err.message });
      return;
    }
    if (!fs.existsSync(filePath)) {
      res.status(404).json({ error: 'File not found' });
      return;
    }
    // Note: no isAudioFile pre-check here on purpose — trimAudio() owns format
    // validation so non-Opus audio gets its accurate "Opus/Ogg only" message
    // via mapTrimError instead of a misleading "Not an audio file".
    if (!isFilePath(filePath)) {
      res.status(404).json({ error: 'File not found' });
      return;
    }
    const start = Number(req.body && req.body.start);
    const end = Number(req.body && req.body.end);
    if (!Number.isFinite(start) || !Number.isFinite(end)) {
      res.status(400).json({ error: 'Invalid trim range: start and end must be numbers' });
      return;
    }
    try {
      const result = await trimAudio(filePath, start, end);
      res.json({ success: true, ...result });
    } catch (err) {
      mapTrimError(err, res);
    }
  }));

// ---- Health ------------------------------------------------------------
  router.get('/healthz', (req, res) => {
    res.json({ status: 'ok' });
  });

// ---- System + settings -------------------------------------------------
  router.get('/system', (req, res) => {
    try {
      const ytdlp = getYtDlpStatus();
      const settings = getSettings();
      res.json({
        ytdlp: {
          version: ytdlp.version || '',
          error: ytdlp.error || '',
          jsRuntime: ytdlp.jsRuntime || '',
          denoAvailable: Boolean(ytdlp.denoAvailable),
          ejsAvailable: ytdlp.ejsAvailable,
        },
        server: { node: process.version, platform: process.platform },
        settings: {
          embedChapters: Boolean(settings.embedChapters),
          sponsorblock: settings.sponsorblock || null,
          opusPreferred: settings.opusPreferred !== false,
          autoUpdateYtDlp: settings.autoUpdateYtDlp !== false,
          cookiesConfigured: Boolean(settings.cookiesConfigured),
          cookiesUpdatedAt: settings.cookiesUpdatedAt || null,
        },
      });
    } catch (err) {
      res.status(500).json({ error: 'Failed to read system status' });
    }
  });

  router.get('/settings', (req, res) => {
    res.json(getSettings());
  });

  router.post('/settings', requireJson, (req, res) => {
    try {
      const patch = (req.body && typeof req.body === 'object') ? req.body : {};
      const next = saveSettings({
        embedChapters: patch.embedChapters,
        sponsorblock: patch.sponsorblock === undefined ? undefined : (patch.sponsorblock || null),
        opusPreferred: patch.opusPreferred,
        autoUpdateYtDlp: patch.autoUpdateYtDlp,
      });
      res.json(next);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // ---- Cookies (Netscape cookies.txt for age-restricted videos) ----------
  const cookiesUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 256 * 1024, files: 1 },
  });

  function cookiesFilePath() {
    return path.join(config.configDir, 'cookies.txt');
  }

  function validateCookiesText(text) {
    if (typeof text !== 'string' || !text.trim()) return 'Empty cookies file';
    const lines = text.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
    if (!lines.length) return 'No cookie entries found (export Netscape cookies.txt)';
    // Netscape format: domain\tflag\tpath\tsecure\texpiry\tname\tvalue
    const bad = lines.filter((l) => l.split('\t').length < 6);
    if (bad.length > lines.length / 2) return 'Not a Netscape cookies.txt file';
    return null;
  }

  router.get('/cookies/status', (req, res) => {
    const s = getSettings();
    res.json({ configured: Boolean(s.cookiesConfigured), updatedAt: s.cookiesUpdatedAt || null });
  });

  router.post('/cookies', cookiesUpload.single('cookies'), (req, res) => {
    try {
      let text = '';
      if (req.file && req.file.buffer) text = req.file.buffer.toString('utf8');
      else if (typeof req.body?.cookies === 'string') text = req.body.cookies;
      else if (typeof req.body?.text === 'string') text = req.body.text;
      // multer parses multipart; JSON bodies arrive via express.json.
      if (!text && typeof req.body === 'string') text = req.body;
      const errMsg = validateCookiesText(text);
      if (errMsg) {
        res.status(400).json({ error: errMsg });
        return;
      }
      const dest = cookiesFilePath();
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      const tmp = `${dest}.tmp-${process.pid}`;
      fs.writeFileSync(tmp, text, { mode: 0o600, encoding: 'utf8' });
      try { fs.chmodSync(tmp, 0o600); } catch (_) {}
      fs.renameSync(tmp, dest);
      const updatedAt = new Date().toISOString();
      setCookiesState(true, updatedAt);
      res.json({ ok: true, updatedAt });
    } catch (err) {
      res.status(500).json({ error: 'Failed to store cookies' });
    }
  });

  router.delete('/cookies', requireJson, (req, res) => {
    try {
      try { fs.unlinkSync(cookiesFilePath()); } catch (_) {}
      setCookiesState(false, null);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: 'Failed to remove cookies' });
    }
  });

  // ---- Inspect (video/playlist preview without downloading) --------------
  router.post('/inspect', requireJson, asyncHandler(async (req, res) => {
    const url = req.body && req.body.url != null ? String(req.body.url).trim() : '';
    if (!url) {
      res.status(400).json({ error: 'url is required' });
      return;
    }
    const reason = validateDownloadUrl(url);
    if (reason) {
      res.status(400).json({ error: `URL blocked: ${reason}` });
      return;
    }
    const playlistEnd = Math.min(Math.max(Number(req.body.playlistEnd) || 20, 1), 50);
    try {
      const result = await inspectUrl(url, { playlistEnd });
      res.json(result);
    } catch (err) {
      const status = err.status || 502;
      res.status(status).json({ error: (err.message || 'Inspect failed').slice(0, 300) });
    }
  }));

  // ---- Thumbnail proxy (keeps the strict img-src CSP) --------------------
  router.get('/thumb', asyncHandler(async (req, res) => {
    const remote = req.query.url != null ? String(req.query.url) : '';
    if (!remote) {
      res.status(400).json({ error: 'url is required' });
      return;
    }
    const reason = validateDownloadUrl(remote);
    if (reason) {
      res.status(400).json({ error: `URL blocked: ${reason}` });
      return;
    }
    try {
      const img = await getThumb(remote);
      res.set('Content-Type', img.contentType || 'image/jpeg');
      res.set('Cache-Control', 'private, max-age=3600');
      res.set('X-Content-Type-Options', 'nosniff');
      res.send(img.data);
    } catch (err) {
      const status = err.status || 502;
      res.status(status).json({ error: (err.message || 'Thumbnail fetch failed').slice(0, 200) });
    }
  }));

  // ---- Library batch (tags for the cover grid) ---------------------------
  router.get('/library', asyncHandler(async (req, res) => {
    const q = (req.query.q != null ? String(req.query.q) : '').trim().toLowerCase();
    const sort = String(req.query.sort || 'name');
    const order = String(req.query.order || 'asc') === 'desc' ? 'desc' : 'asc';
    const limit = Math.min(Math.max(Number(req.query.limit) || 200, 1), 1000);
    const offset = Math.max(Number(req.query.offset) || 0, 0);

    const isTransient = (f) => {
      const base = path.basename(f);
      return base.includes('_trim_') || base.includes('_temp_') ||
        base.endsWith('.part') || base.endsWith('.tmp');
    };

    const allFiles = walkAudioFiles(config.downloadDir, { maxDepth: 4, maxFiles: 2000 })
      .filter((f) => !isTransient(f));

    // Fast path: no search and name sort — sort filenames first, parse only the page.
    if (!q && sort === 'name') {
      const sorted = allFiles.sort((a, b) => {
        const cmp = path.basename(a).toLowerCase() < path.basename(b).toLowerCase() ? -1 :
          path.basename(a).toLowerCase() > path.basename(b).toLowerCase() ? 1 : 0;
        return order === 'desc' ? -cmp : cmp;
      });
      const page = sorted.slice(offset, offset + limit);
      const entries = [];
      for (const f of page) {
        const tags = await readEntryTags(f);
        if (!tags) continue;
        const name = path.basename(f);
        entries.push({
          path: f,
          name,
          title: tags.title || name.replace(/\.[^.]+$/, ''),
          artist: tags.artist || '',
          album: tags.album || '',
          track: tags.track || '',
          genre: tags.genre || '',
          year: tags.year || '',
          duration: tags.duration,
          hasCover: Boolean(tags.hasCover),
        });
      }
      res.json({ total: sorted.length, offset, limit, entries });
      return;
    }

    const withTags = [];
    for (const f of allFiles) {
      const tags = await readEntryTags(f);
      if (!tags) continue;
      const name = path.basename(f);
      if (q) {
        const hay = `${name} ${tags.title} ${tags.artist} ${tags.album}`.toLowerCase();
        if (!hay.includes(q)) continue;
      }
      withTags.push({
        path: f,
        name,
        title: tags.title || name.replace(/\.[^.]+$/, ''),
        artist: tags.artist || '',
        album: tags.album || '',
        track: tags.track || '',
        genre: tags.genre || '',
        year: tags.year || '',
        duration: tags.duration,
        hasCover: Boolean(tags.hasCover),
      });
    }

    const sortKey = (e) => {
      if (sort === 'artist') return (e.artist || '').toLowerCase();
      if (sort === 'album') return (e.album || '').toLowerCase();
      if (sort === 'year') return (e.year || '').toLowerCase();
      if (sort === 'duration') return Number(e.duration) || 0;
      return (e.name || '').toLowerCase();
    };
    withTags.sort((a, b) => {
      const ka = sortKey(a); const kb = sortKey(b);
      const cmp = ka < kb ? -1 : ka > kb ? 1 : 0;
      return order === 'desc' ? -cmp : cmp;
    });

    res.json({ total: withTags.length, offset, limit, entries: withTags.slice(offset, offset + limit) });
  }));

  app.use('/api', router);
}

module.exports = { setupRoutes };
