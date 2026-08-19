# Stow

**Download YouTube audio as high-quality Opus files — the way YouTube actually sounds, not a lie.**

Ported over version of Stow into a web client that can be deployed directly onto a home server. 

## Deploy with Docker (web)

Stow runs as a self-contained web app: a Node server serves the same React UI
and handles downloads, and you open it from any device on your network at
`http://<machine-ip>:5183`.


### Quick start — pull the Docker Hub image

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
  stow:
    image: maraudermarauder/stowed:latest
    container_name: stow
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

If you cloned this repo or want to change the code, the checked-in
`docker-compose.yml` includes a `build:` block (and pins a specific yt-dlp
release via `YTDLP_VERSION`). Build a local image and run it instead:

```bash
docker compose up -d --build
```

To rebuild and push your own image to Docker Hub (`maraudermarauder/stowed`),
the compose `image:` is already tagged correctly:

```bash
docker login
docker compose build stow
docker compose push stow
```

### Files, config & permissions

| Variable    | Default  | Purpose                                                |
|-------------|----------|--------------------------------------------------------|
| `PUID`      | `1000`   | Container user id (set `user:` ownership)              |
| `PGID`      | `1000`   | Container group id                                     |
| `STOW_PORT` | `5183`   | Web UI port → `http://<machine-ip>:<port>`. Set it in `docker-compose.yml` via the `x-stow-port: &stow_port` anchor (or the `STOW_PORT` env when running outside Docker) |
| `STOW_DOWNLOAD_DIR` | `/downloads` | Where completed files are written (volume `./downloads`) |
| `STOW_CONFIG_DIR`   | `/config`    | Where `queue-state.json` lives (volume `./config`)     |
| `STOW_API_KEY`      | *(blank)*     | Optional shared secret for LAN access                  |
| `YTDLP_VERSION`     | pinned | Build arg pinning the yt-dlp release — only relevant when building from source (override via `.env`) |

> **Port configuration:** the web UI port is set directly in `docker-compose.yml`
> via the `x-stow-port: &stow_port` anchor (default **5183**). A `STOW_PORT`
> value in `.env` no longer affects the Compose deployment — edit the anchor in
> the compose file instead. `STOW_PORT` only matters when running the Node
> server outside Docker.

> The **files never leave whatever directory compose gives the container.** To
> move downloads elsewhere, change the mount, e.g. `./music:/downloads`. The app
> only ever writes inside `STOW_DOWNLOAD_DIR`/`STOW_CONFIG_DIR`.

### Behavior differences vs. the desktop app

- **"Open File"** browses audio files already in the download directory (server-side).
- **"Show in Folder"** downloads/opens the file in the browser instead of a file manager.
- Editing **tags** works on any supported format. Replacing **cover art** works on
  formats that support an attached-picture stream (MP3/MP4/FLAC/M4A); Ogg Opus
  files carry their cover as embedded metadata at download time and cannot have it
  swapped via FFmpeg (same limitation as the desktop app).
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

```bash
npm install
npm run build:web     # build the renderer into dist/
npm test              # run the queue state-machine unit tests (node --test)
npm run start:server      # serve UI + API at http://localhost:5183
# or hot-reload UI:  npm run dev:web  (Vite on :5173)  then  npm run dev:server
```

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
- Queue management: add multiple URLs, cancel one or all
- Persistent queue that resumes across app restarts; detects already downloaded files
- Duplicate URL detection prevents downloading the same video twice
- Dark and light theme
- Self-hosted web UI — run it in Docker and open it from any device on your network 

## How It Works

1. Paste one or more YouTube URLs.
2. Stow downloads the raw Opus stream using yt-dlp and repackages it with ffmpeg — no re-encoding.
3. Thumbnails and metadata (title, channel, upload date, etc.) are embedded automatically.
4. Optionally open the built-in editor to fix any tag or swap the cover art.
5. Enjoy your Opus files.

## Tech Stack

- **React** (Vite) — the web UI, served by the Node server (Docker-ready)
- **yt-dlp** — downloads the audio stream from YouTube
- **ffmpeg** — remuxes the Opus stream into an `.opus` container
- **music-metadata** (Node.js) — reads/writes metadata and cover art
- **Node.js** (Express + WebSocket) — web server, download management and queue state
