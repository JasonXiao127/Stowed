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

# Pin yt-dlp via PyPI rather than pulling "latest", so image builds are
# reproducible. Override with:  docker build --build-arg YTDLP_VERSION=2026.x.x
# v1.0.0 shipped the PyInstaller "onefile" yt-dlp_linux binary, which failed
# to start in the hardened container ("libz.so.1: failed to map segment from
# shared object"). Installing yt-dlp as a pure-Python package links the system
# zlib (the one curl already loads fine) and skips the onefile extraction
# entirely. --break-system-packages is required for Debian's externally-managed
# Python environment.
ARG YTDLP_VERSION=2026.07.04
RUN python3 -m pip install --no-cache-dir --break-system-packages \
      "yt-dlp==${YTDLP_VERSION}"

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