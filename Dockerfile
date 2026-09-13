# syntax=docker/dockerfile:1

FROM oven/bun:alpine AS base
WORKDIR /app

FROM base AS build
COPY package.json bun.lock bunfig.toml .npmrc ./
COPY apps/server/package.json apps/server/package.json
COPY apps/web/package.json apps/web/package.json

RUN --mount=type=cache,id=stationary-bun,target=/root/.bun/install/cache \
    bun install --frozen-lockfile

# 1. Build Server
COPY apps/server/tsconfig.json apps/server/tsconfig.json
COPY apps/server/drizzle.config.ts apps/server/drizzle.config.ts
COPY apps/server/drizzle apps/server/drizzle
COPY apps/server/src apps/server/src
WORKDIR /app/apps/server
RUN bun run build

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

# Release stage: unified runner
FROM base AS release
WORKDIR /app
ENV NODE_ENV=production

# Install Node.js for Nuxt, Caddy for single-port reverse proxy, and FFmpeg / ImageMagick for media processing
USER root
RUN apk add --no-cache nodejs caddy ffmpeg imagemagick imagemagick-heic imagemagick-jxl
USER bun

# Copy compiled Server and Web artifacts, Caddy configuration, and process entrypoint
COPY --from=build --chown=bun:bun /app/apps/server/dist/index.js /app/server/index.js
COPY --from=build --chown=bun:bun /app/apps/web/.output /app/web/.output
COPY --chown=bun:bun docker/Caddyfile /app/Caddyfile
COPY --chown=bun:bun docker/entrypoint.ts /app/entrypoint.ts

EXPOSE 4000
ENTRYPOINT [ "bun", "run", "/app/entrypoint.ts" ]
