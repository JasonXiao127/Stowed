# ---------- Build stage: install all deps + build the web renderer ----------
FROM node:24-slim AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY . .
RUN npm run build:web && rm -rf node_modules

# ---------- Runtime stage ----------
FROM node:24-slim
ENV DEBIAN_FRONTEND=noninteractive \
    NODE_ENV=production \
    # yt-dlp writes its cache under $XDG_CACHE_HOME; point it at the tmpfs so
    # the container can run with a read-only root filesystem.
    XDG_CACHE_HOME=/tmp

# ffmpeg for remuxing/cover art, curl for the healthcheck, ca-certificates so
# yt-dlp can talk to YouTube over TLS, python3+pip to host the pinned yt-dlp.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
         ffmpeg curl ca-certificates python3 python3-pip \
    && rm -rf /var/lib/apt/lists/*

# Install the LATEST yt-dlp NIGHTLY build (rolling). Nightly carries the newest
# YouTube player-client fixes; stable 2026.07.04 hit "unable to download video
# data: HTTP Error 403: Forbidden", while nightly 2026.08.18.122307 does not
# (verified in a live container). To grab a newer nightly on rebuild, use:
#   docker compose build --no-cache stow
# Nightly builds install as a pure-Python package from the yt-dlp-nightly-builds
# GitHub release tarball, so there is no PyInstaller bootloader (the v1.0.0
# "libz.so.1: failed to map segment from shared object" crash cannot occur).
# curl_cffi enables browser impersonation for the YouTube player clients.
# --break-system-packages is required for Debian's externally-managed Python.
RUN python3 -m pip install --no-cache-dir --break-system-packages \
      "yt-dlp@https://github.com/yt-dlp/yt-dlp-nightly-builds/releases/latest/download/yt-dlp.tar.gz" \
      "curl_cffi" "mutagen" "pycryptodomex" "brotli"

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

# Built renderer + server code (node_modules from the runtime stage above).
COPY --from=build /app/dist ./dist
COPY --from=build /app/server ./server

ENV STOW_DOWNLOAD_DIR=/downloads \
    STOW_CONFIG_DIR=/config \
    STOW_HOST=0.0.0.0 \
    STOW_PORT=5183

# Volumes are created as the container user's uid:gid via the compose
# "user:" setting; the entrypoint does not chown so it works as any uid.
VOLUME ["/downloads", "/config"]

EXPOSE 5183

# The official Node base image already ships a non-root `node` user with
# uid/gid 1000 — the arr-stack convention. (Creating our own uid-1000 user
# would fail: useradd exits 4 when the UID already exists.) The compose file
# overrides the effective user with PUID/PGID at runtime, so this is just the
# default for non-compose runs (e.g. docker run without --user).
USER node
CMD ["node", "server/index.js"]