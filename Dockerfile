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
# yt-dlp can talk to YouTube over TLS.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Pin yt-dlp rather than pulling "latest", so image builds are reproducible.
# Override with:  docker build --build-arg YTDLP_VERSION=2026.x.x
ARG YTDLP_VERSION=2026.07.04
# SHA-256 of the yt-dlp_linux binary for the pinned release (from SHA2-256SUMS),
# verified at build time so a compromised release/MITM cannot ship a tainted
# binary. Update BOTH args together when bumping the version.
ARG YTDLP_SHA256=6bbb3d314cde4febe36e5fa1d55462e29c974f63444e707871834f6d8cc210ae
RUN curl -fsSL -o /usr/local/bin/yt-dlp \
      "https://github.com/yt-dlp/yt-dlp/releases/download/${YTDLP_VERSION}/yt-dlp_linux" \
    && echo "${YTDLP_SHA256}  /usr/local/bin/yt-dlp" | sha256sum -c - \
    && chmod +x /usr/local/bin/yt-dlp

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