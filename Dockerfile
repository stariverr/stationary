# syntax=docker/dockerfile:1

# Build artifacts are plain JS, so compile on the builder's own platform; bun crashes under emulation.
FROM --platform=$BUILDPLATFORM oven/bun:alpine AS build
WORKDIR /app
COPY package.json bun.lock bunfig.toml .npmrc ./
COPY apps/server/package.json apps/server/package.json
COPY apps/web/package.json apps/web/package.json

RUN --mount=type=cache,id=stationary-bun,target=/root/.bun/install/cache \
    bun install --frozen-lockfile

# 1. Build Server (index.js, worker.js, db/migrate.js)
COPY apps/server/tsconfig.json apps/server/tsconfig.json
COPY apps/server/src apps/server/src
WORKDIR /app/apps/server
RUN bun run build && \
    bun -e 'const pkg = await Bun.file("/app/apps/server/node_modules/@napi-rs/image/package.json").json(); await Bun.write("/tmp/napi-image.version", pkg.version);'

# 2. Build Web
WORKDIR /app
COPY apps/web/package.json apps/web/tsconfig.json apps/web/components.json apps/web/nuxt.config.ts ./apps/web/
COPY apps/web/app ./apps/web/app
COPY apps/web/public ./apps/web/public
COPY apps/web/i18n ./apps/web/i18n
WORKDIR /app/apps/web
ENV NODE_ENV=production
ENV NITRO_PRESET=node-server
RUN bun run build

# Native runtime dependencies kept external by `bun build` (version pinned from bun.lock)
FROM oven/bun:alpine AS server-deps
WORKDIR /app
COPY --from=build /tmp/napi-image.version /tmp/napi-image.version
RUN bun add --no-save "@napi-rs/image@$(cat /tmp/napi-image.version)"

# K8s target 1: lightweight Nuxt SSR runner
FROM node:22-alpine AS web-release
WORKDIR /app
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3000

COPY --from=build --chown=node:node /app/apps/web/.output /app/web/.output
USER node

EXPOSE 3000
ENTRYPOINT [ "node", "/app/web/.output/server/index.mjs" ]

# K8s target 2: Bun API / Worker / Migration runner
FROM oven/bun:alpine AS server-release
WORKDIR /app
ENV NODE_ENV=production

USER root
RUN apk add --no-cache ffmpeg imagemagick imagemagick-heic imagemagick-jxl
USER bun

COPY --from=build --chown=bun:bun /app/apps/server/dist /app/server
COPY --chown=bun:bun apps/server/drizzle /app/server/drizzle
COPY --from=server-deps --chown=bun:bun /app/node_modules /app/node_modules

EXPOSE 9400
ENTRYPOINT [ "bun", "run", "--bun", "/app/server/index.js" ]

# Default release stage: unified runner for single-host Docker Compose (with Caddy)
FROM oven/bun:alpine AS release
WORKDIR /app
ENV NODE_ENV=production

# Install Node.js for Nuxt, Caddy for single-port reverse proxy, and FFmpeg / ImageMagick for media processing
USER root
RUN apk add --no-cache nodejs caddy ffmpeg imagemagick imagemagick-heic imagemagick-jxl
USER bun

# Copy compiled Server and Web artifacts, native addons, Caddy configuration, and process entrypoint
COPY --from=build --chown=bun:bun /app/apps/server/dist /app/server
COPY --chown=bun:bun apps/server/drizzle /app/server/drizzle
COPY --from=server-deps --chown=bun:bun /app/node_modules /app/node_modules
COPY --from=build --chown=bun:bun /app/apps/web/.output /app/web/.output
COPY --chown=bun:bun docker/Caddyfile /app/Caddyfile
COPY --chown=bun:bun docker/entrypoint.ts /app/entrypoint.ts

EXPOSE 4000
ENTRYPOINT [ "bun", "run", "/app/entrypoint.ts" ]
