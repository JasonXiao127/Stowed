# Stow

**Download YouTube audio as high-quality Opus files — the way YouTube actually sounds, not a lie.**

Ported over version of Stow into a web client that can be deployed directly onto a home server. 

## Deploy with Docker (web)

Stow runs as a self-contained web app: a Node server serves the same React UI
and handles downloads, and you open it from any device on your network at
`http://<machine-ip>:5183`.


### Quick start — pull the GitHub Container Registry image

**1.** *(first time)* create the data folders owned by your uid/gid. Use the
**same** uid as your *arr stack (e.g. `1000:1000`) so downloaded files match
your media-folder permissions:

```bash
mkdir -p downloads config
sudo chown -R 1000:1000 downloads config
```

**2.** Save this as `docker-compose.yml`:

```yaml
services:
  stowed-web:
    image: ghcr.io/jasonxiao127/stowed:latest
    container_name: stowed-web
    # ---- Web UI port (edit this ONE line to change it) ----
    x-stow-port: &stow_port 5183

    ports:
      - target: *stow_port
        published: *stow_port
        protocol: tcp

    environment:
      STOW_DOWNLOAD_DIR: /downloads
      STOW_CONFIG_DIR: /config
      STOW_HOST: 0.0.0.0
      STOW_PORT: *stow_port
      # Optional: shared secret for LAN access (blank = no auth, trusted LAN).
      STOW_API_KEY: ${STOW_API_KEY:-}
      PUID: ${PUID:-1000}
      PGID: ${PGID:-1000}

    # Run as your uid:gid so files match your media-folder permissions.
    user: "${PUID:-1000}:${PGID:-1000}"
    # ---- Hardening ------------------------------------------------------
    read_only: true
    tmpfs:
      - /tmp
    security_opt:
      - no-new-privileges:true
    cap_drop:
      - ALL
    init: true
    volumes:
      - ./downloads:/downloads
      - ./config:/config

    restart: unless-stopped
    healthcheck:
      test: ["CMD-SHELL", "curl -fsS http://localhost:$$STOW_PORT/healthz"]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 10s
```

**3.** Fetch the image and start it:

```bash
# If the GHCR package is private:
# docker login ghcr.io
docker compose pull
docker compose up -d
```

**4.** Open it — `http://<machine-ip>:5183`

One-line unauthenticated LAN setup:

```bash
mkdir -p downloads config && sudo chown -R 1000:1000 downloads config && docker compose pull && docker compose up -d && echo "Web UI: http://$(hostname -I | awk '{print $1}'):5183"
```
(The port in the `echo` matches the `x-stow-port: &stow_port` anchor above;
update it if you change that line.)

### Build from source (optional)

If you cloned this repo or want to change the code, the repo-root
`docker-compose.yml` includes a `build:` block (context is the repo root, image
recipe in `apps/stowed-web/Dockerfile`). Build a local image and run it instead:

yt-dlp is installed as the LATEST NIGHTLY build (a pure-Python package from the
yt-dlp-nightly-builds GitHub release), so it always carries the newest YouTube
player-client fixes — stable 2026.07.04 failed with `HTTP Error 403: Forbidden`
on media downloads. It avoids the crash-prone PyInstaller "onefile" binary from
v1.0.0 (`libz.so.1: failed to map segment from shared object`) and works on any
CPU architecture. Rebuild with `docker compose build --no-cache stowed-web` to fetch
a newer nightly.

```bash
docker compose up -d --build
```

To rebuild and push your own image to GitHub Container Registry
(`ghcr.io/jasonxiao127/stowed`), the compose `image:` is already tagged
correctly:

```bash
docker login ghcr.io
docker compose build stowed-web
docker tag ghcr.io/jasonxiao127/stowed:latest ghcr.io/jasonxiao127/stowed:1.0.3
docker compose push stowed-web
docker push ghcr.io/jasonxiao127/stowed:1.0.3
```

> GHCR packages are private by default. To allow unauthenticated pulls, open the
> package settings on GitHub and set its visibility to public. For private
> pulls, run `docker login ghcr.io` with a token that has `read:packages`.

### Files, config & permissions

| Variable    | Default  | Purpose                                                |
|-------------|----------|--------------------------------------------------------|
| `PUID`      | `1000`   | Container user id (set `user:` ownership)              |
| `PGID`      | `1000`   | Container group id                                     |
| `STOW_PORT` | `5183`   | Web UI port → `http://<machine-ip>:<port>`. Set it in `docker-compose.yml` via the `x-stow-port: &stow_port` anchor (or the `STOW_PORT` env when running outside Docker) |
| `STOW_DOWNLOAD_DIR` | `/downloads` | Where completed files are written (volume `./downloads`) |
| `STOW_CONFIG_DIR`   | `/config`    | Where `queue-state.json` lives (volume `./config`)     |
| `STOW_API_KEY`      | *(blank)*     | Optional shared secret for LAN access                  |
| `YTDLP_VERSION`     | *(removed)* | yt-dlp is always the latest nightly build (no pin needed) |

> **Port configuration:** the web UI port is set directly in `docker-compose.yml`
> via the `x-stow-port: &stow_port` anchor (default **5183**). A `STOW_PORT`
> value in `.env` no longer affects the Compose deployment — edit the anchor in
> the compose file instead. `STOW_PORT` only matters when running the Node
> server outside Docker.

> The **files never leave whatever directory compose gives the container.** To
> move downloads elsewhere, change the mount, e.g. `./music:/downloads`. The app
> only ever writes inside `STOW_DOWNLOAD_DIR`/`STOW_CONFIG_DIR` (per-job
> intermediates stage under `STOW_DOWNLOAD_DIR/.stow-tmp/`, hidden from the
> library and cleaned per job; yt-dlp cache uses the `/tmp` tmpfs).

### Behavior differences vs. the desktop app

- The home page has a **Library** panel browsing audio files already in the
  download directory (server-side), with per-file Edit and Download actions.
- **"Show in Folder"** downloads/opens the file in the browser instead of a file manager.
- The **API key** lives under Settings (gear icon, top-right), not a bottom bar.
- Editing **tags** works on any supported format. Replacing **cover art** works on
  MP3/MP4/FLAC/M4A via an attached-picture stream, and Ogg Opus/Ogg Vorbis via
  an embedded `METADATA_BLOCK_PICTURE` comment (written natively, since FFmpeg
  cannot mux an attached picture into Ogg). WAV, raw AAC and WebM cannot store
  cover art, so the cover picker is disabled for those.
- **Library, preview, MusicBrainz, waveform trim, chapters, settings and player
  are web-only.** The desktop client is intentionally minimal: queue + metadata
  editor, with automatic nightly yt-dlp updates.
- All real-time progress is pushed over a WebSocket; the client reconnects and
  re-syncs the queue automatically.

### Security notes (for a LAN / not-internet deployment)

- No auth by default — only run this on a trusted network. To require a shared
  secret, set `STOW_API_KEY=...` in `.env`; every `/api/*` request and the
  WebSocket handshake then needs it (`?apikey=...`, `X-API-Key`, or
  `Authorization: Bearer ...`).
- The API is confined to the download directory: path-traversal, symlink escapes,
  and arbitrary file deletion are blocked (deletion is limited to files belonging
  to *completed* queue jobs).
- Cross-origin requests are rejected (DNS-rebinding / drive-by CSRF guard), JSON
  bodies are enforced on mutating endpoints, and thumbnail uploads are size-limited
  and validated before they reach ffmpeg.
- Never expose it to the public internet without `STOW_API_KEY` — it can make the
  server fetch arbitrary URLs (an inherent property of a YouTube downloader).

### Local development (no Docker)

Run from the repo root (this app lives at `apps/stowed-web` in the Stowed monorepo):

```bash
npm install
npm run build:web     # build the renderer into apps/stowed-web/dist/
npm test              # run the unit tests (node --test: queue, security, MusicBrainz, trim)
npm run start:web     # serve UI + API at http://localhost:5183
# Hot-reload UI (runs Node server + Vite together; open http://localhost:5183):
#   npm run dev:web
# Server-only / Vite-only pieces: npm run dev:web:server, npm run dev:web:ui
```

### Metadata API (MusicBrainz lookup + trim)

The metadata editor is backed by four extra endpoints (all use the existing
`/api` auth: `X-API-Key` header or `?apikey=` query):

- `GET /api/mb/search?title=&artist=&album=&limit=` — MusicBrainz recording
  search, proxied server-side (correct `User-Agent`, 1 req/sec throttle,
  10-min cache). Returns `{ results: [{ recordingId, title, artist, album,
  date, year, releaseId, score }] }`.
- `GET /api/mb/cover?releaseId=` — front cover from the Cover Art Archive,
  proxied (MBID-validated, image-type + 10 MB caps, 404s cached 10 min).
- `GET /api/duration?path=` — ffprobe duration in seconds (`{ path, duration }`).
- `POST /api/trim` `{ path, start, end }` — keeps `[start, end)` (min 1 s) via
  ffmpeg `libopus` re-encode with metadata preserved, atomically replacing the
  original. Opus/Ogg only; max 2 concurrent trims (429 when busy).

### System, settings, inspect, library API

- `GET /api/system` — yt-dlp version, JS runtime (Deno/Node), EJS status,
  plus sanitized settings for the Settings panel.
- `GET /api/settings` / `POST /api/settings` — `embedChapters` (bool),
  `sponsorblock` (`null` or `remove:<cats>`/`mark:<cats>`), `opusPreferred`.
  Unknown keys are ignored.
- `GET /api/cookies/status`, `POST /api/cookies`, `DELETE /api/cookies` —
  Netscape cookies.txt for age-restricted videos (stored `0600`, never echoed).
- `POST /api/inspect` `{ url, playlistEnd? }` — video/playlist preview via
  `yt-dlp -J --flat-playlist` (30 s timeout, 1 MB cap, SSRF-checked).
- `GET /api/thumb?url=` — same-origin thumbnail proxy (CDN allowlist,
  image-type + 10 MB caps) so the strict `img-src 'self'` CSP holds.
- `GET /api/library?q=&sort=&order=&limit=&offset=` — batched tags for the
  cover grid (cached music-metadata reads, max 200/track page).
- `POST /api/queue/retry` `{ id }` / `DELETE /api/queue/:id` — retry a failed
  job or remove it from the queue.

## Why Stow?

Most “YouTube to MP3” sites and apps lie about quality. They claim 320 kbps MP3, but behind the scenes they fetch a low-bitrate stream and re-encode it — a lossy-to-lossy conversion that permanently degrades the audio that somehow takes up more space.

YouTube stores audio as Opus. For 1080p videos that’s usually around 160 kbps, a bitrate where Opus is audibly transparent. For 99% of the population, they shouldn't be able to tell the difference (especially with VBR). In controlled listening tests, Opus at 160 kbps consistently beats 320 kbps MP3.

Stow uses yt-dlp to grab the **real** Opus stream straight from YouTube. No conversion, no lies. You get exactly what YouTube serves and its untouched.

Served as a self-hosted web app on your LAN — no ads, no “download our app” pop-ups, no file size limits.

## Features

- Downloads the best audio stream directly from YouTube (no re-encoding, no quality loss)
- Outputs `.opus` containers — uses the same Opus codec YouTube serves internally
- Auto-embeds thumbnails and metadata (title, artist, album, etc.)
- Built-in metadata editor to fix or change tags and cover art after download
- MusicBrainz match picker: search recordings, fill title/artist/album/year, fetch cover art
- Waveform trim editor: keep a time range (drag region or type times), preview, overwrite in place (Opus/Ogg)
- Link preview: inspect single videos and playlists before downloading, pick tracks
- Library: cover grid + list views, search/sort, inline play, edit, download
- Rich queue cards: stage (fetching → downloading → converting → tagging → cover), bytes, speed, ETA, warnings, retry/remove
- Bottom player with cover art; Settings for yt-dlp version, SponsorBlock, chapters, cookies
- Queue management: add multiple URLs, cancel one or all, retry failed, remove
- Persistent queue that resumes across app restarts; detects already downloaded files
- Duplicate URL detection prevents downloading the same video twice
- Dark and light theme
- Self-hosted web UI — run it in Docker and open it from any device on your network 

## How It Works

1. Paste one or more YouTube URLs.
2. Stow downloads the raw Opus stream using yt-dlp and repackages it with ffmpeg — no re-encoding.
3. Thumbnails and metadata (title, channel, upload date, etc.) are embedded automatically.
4. Optionally open the built-in editor to fix any tag or swap the cover art.
   Use MusicBrainz search to fill tags from the correct release, and trim
   silence/intros with the waveform editor (Opus files are re-encoded at
   160k Opus with tags preserved).
5. Enjoy your Opus files.

## Tech Stack

- **React** (Vite) — the web UI, served by the Node server (Docker-ready)
- **wavesurfer.js** — waveform display + keep-range region for trimming
- **MusicBrainz / Cover Art Archive** (proxied) — recording search + cover fetch
- **yt-dlp** — downloads the audio stream from YouTube
- **ffmpeg** — remuxes the Opus stream into an `.opus` container
- **ffprobe** — duration reads for the trim editor
- **music-metadata** (Node.js) — reads/writes metadata and cover art
- **Node.js** (Express + WebSocket) — web server, download management and queue state
