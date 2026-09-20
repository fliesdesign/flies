# syntax=docker/dockerfile:1
# Production image for apps/web. Build from the repository root:
#   docker build -t flies-web .
#   docker run --rm -p 8080:8080 flies-web

FROM oven/bun:1.4.2 AS build
WORKDIR /app

COPY package.json bun.lock ./
COPY patches ./patches
COPY apps/web/package.json apps/web/package.json
COPY apps/desktop/package.json apps/desktop/package.json
COPY packages/canvas/package.json packages/canvas/package.json

RUN bun ci

COPY vite.config.ts tsconfig.json ./
COPY packages/canvas packages/canvas
COPY apps/web apps/web

RUN bun run --cwd apps/web build

FROM caddy:2-alpine AS runtime
COPY apps/web/Caddyfile /etc/caddy/Caddyfile
COPY --from=build /app/apps/web/dist /usr/share/caddy
EXPOSE 8080
