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
const { writeMetadata } = require('./metadata');

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

  router.post('/cancel/:id', requireJson, (req, res) => {
    downloadManager.cancelJob(req.params.id);
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

  // ---- File browser (replaces the native "Open File" dialog) -------------
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
      res.status(500).json({ error: `Failed to read directory: ${err.message}` });
      return;
    }

    const entries = names
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
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
      res.status(404).json({ error: 'File not found' });
      return;
    }

    const asDownload = req.query.download === '1';
    res.set('Cache-Control', 'no-store');
    res.set('X-Content-Type-Options', 'nosniff');
    if (asDownload) {
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
    res.set('Content-Type', cover.format || 'image/jpeg');
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

    // FFmpeg cannot store an attached-picture (cover) stream in the Ogg/Opus
    // container, so reject that combination with a clear message instead of a
    // cryptic 500 later.
    const fileExt = path.extname(filePath).toLowerCase();
    if (req.file && (fileExt === '.opus' || fileExt === '.ogg')) {
      res.status(400).json({
        error: 'Cover art cannot be replaced on Ogg/Opus files (this container cannot store an attached picture).',
      });
      return;
    }

    const tags = (body.tags && typeof body.tags === 'object') ? body.tags : {};

    // No thumbnail: just write tags.
    if (!req.file) {
      writeMetadata(filePath, tags)
        .then((result) => res.json({ success: true, filePath: result }))
        .catch((err) => res.status(500).json({ error: err.message }));
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
      .catch((err) => res.status(500).json({ error: err.message }))
      .finally(() => {
        try { fs.unlinkSync(tempFile); } catch (_) {}
      });
  });

// ---- Health ------------------------------------------------------------
  router.get('/healthz', (req, res) => {
    res.json({ status: 'ok' });
  });

  app.use('/api', router);
}

module.exports = { setupRoutes };
