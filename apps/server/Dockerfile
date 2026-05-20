# syntax=docker/dockerfile:1

# see all versions at https://hub.docker.com/r/oven/bun/tags
FROM oven/bun:alpine AS base
WORKDIR /app

FROM base AS build
COPY package.json bun.lock bunfig.toml .npmrc ./
COPY apps/server/package.json apps/server/package.json
COPY apps/web/package.json apps/web/package.json
RUN --mount=type=cache,id=stationary-server-bun,target=/root/.bun/install/cache \
    bun install --frozen-lockfile --filter @stationary/backend

COPY apps/server/tsconfig.json apps/server/tsconfig.json
COPY apps/server/src apps/server/src
WORKDIR /app/apps/server
RUN bun run build

FROM base AS release
ENV NODE_ENV=production
COPY --from=build /app/apps/server/dist/index.js index.js

USER bun
EXPOSE 8080/tcp
ENTRYPOINT [ "bun", "run", "--bun", "index.js" ]
