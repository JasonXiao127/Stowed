# Stowed

**Download YouTube audio as high-quality Opus files — the way YouTube actually sounds, not a lie.**

Monorepo for the Stow apps: a native desktop client and a self-hosted Docker web UI.
Both share the same download engine behavior and the same React UI components.

| App | Directory | What | Run |
|-----|-----------|------|-----|
| **Stow Client** (Electron) | `apps/stow-client` | Native desktop app (Windows/macOS/Linux) | `npm run dev:client` |
| **Stowed Web** (Docker) | `apps/stowed-web` | Self-hosted web UI for your home server / LAN | `docker compose up -d` then `http://<machine-ip>:5183` |

Shared code lives in `packages/`:

| Package | What |
|---------|------|
| `@stowed/shared-ui` | Shared React UI: `UrlInput`, `ThemeContext`, `QueuePanel` (hardened web variant), backend adapter contract (`backend.js`) |
| `@stowed/core` | Shared backend core: cover-art validators + FFmpeg tag sanitizer (web variants are canonical) |

## Quick start

### Web UI (Docker)

```bash
mkdir -p downloads config && sudo chown -R 1000:1000 downloads config
docker compose pull && docker compose up -d
# open http://<machine-ip>:5183
```

Details (permissions, API key, build-from-source, pushing to Docker Hub
`maraudermarauder/stowed`): see [`apps/stowed-web/README.md`](apps/stowed-web/README.md).

### Desktop client (Electron)

```bash
npm install
npm run setup-binaries:client   # download yt-dlp + ffmpeg into apps/stow-client/bin/
npm run dev:client              # or: npm run make:client
```

## Development

```bash
npm install            # install all workspaces (root)
npm test               # web server unit tests (node --test)
npm run build:web      # build the web renderer into apps/stowed-web/dist/
npm run start:web      # serve UI + API at http://localhost:5183
npm run dev:client     # Electron with hot reload (electron-forge start)
npm run make:client    # package installers (Squirrel/zip)
```

Per-app docs: [`apps/stow-client/README.md`](apps/stow-client/README.md),
[`apps/stowed-web/README.md`](apps/stowed-web/README.md).

## Why Stow?

Most "YouTube to MP3" sites and apps lie about quality. They claim 320 kbps MP3, but
behind the scenes they fetch a low-bitrate stream and re-encode it — a lossy-to-lossy
conversion that permanently degrades the audio while taking up more space.

YouTube stores audio as Opus. For 1080p videos that's usually around 160 kbps, a
bitrate where Opus is audibly transparent. Stow uses yt-dlp to grab the **real** Opus
stream straight from YouTube and repackages it with ffmpeg — no re-encoding, no lies.

## Releases & history

- This repo (`JasonXiao127/Stowed`) is the single home for both apps. The old
  standalone Electron repo (`JasonXiao127/Stow`) is archived read-only and points here.
- Full git history from both repos is preserved (subtree merge).
- Version the apps independently with tags: `stow-client-v*` and `stowed-web-v*`.
  Docker images publish as `maraudermarauder/stowed:<version>` / `:latest`.
