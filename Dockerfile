# syntax=docker/dockerfile:1
# Production image for apps/web. Build from the repository root:
#   docker build -t flies-web .
#   docker run --rm -p 8080:8080 flies-web

FROM oven/bun:1.4.2 AS build
WORKDIR /app

COPY package.json bun.lock ./
COPY apps/web/package.json apps/web/package.json
COPY apps/desktop/package.json apps/desktop/package.json
COPY apps/api/package.json apps/api/package.json
COPY apps/sync/package.json apps/sync/package.json
COPY packages/sync/package.json packages/sync/package.json
COPY packages/canvas/package.json packages/canvas/package.json
COPY packages/firefly/package.json packages/firefly/package.json
COPY packages/html/package.json packages/html/package.json

RUN bun ci

COPY vite.config.ts tsconfig.json ./
COPY packages/sync packages/sync
COPY packages/canvas packages/canvas
COPY packages/firefly packages/firefly
COPY packages/html packages/html
COPY apps/web apps/web

ARG VITE_API_URL
RUN bun run --cwd apps/web build

FROM caddy:2-alpine AS runtime
COPY apps/web/Caddyfile /etc/caddy/Caddyfile
COPY --from=build /app/apps/web/dist /usr/share/caddy
EXPOSE 8080
