# One image, three roles.
#
# The api, the worker and the scheduler are the same build — they differ only in
# which file node starts, which is what the `command:` in a compose file (or a
# process group on a PaaS) chooses. Building three images of the same code would
# mean three things to keep in step.
#
#   node dist/api/index.js         serves the dashboard and the JSON API
#   node dist/worker/index.js      runs jobs
#   node dist/scheduler/index.js   retries, dead-worker recovery, orphan sweep

# ---------------------------------------------------------------------------
# 1. Build the dashboard.
# ---------------------------------------------------------------------------
FROM node:22-alpine AS web

WORKDIR /build

# Dependencies before source, so editing a component does not re-install React.
COPY web/package.json web/package-lock.json ./
RUN npm ci

COPY web/ ./
RUN npm run build

# ---------------------------------------------------------------------------
# 2. Build the server.
# ---------------------------------------------------------------------------
FROM node:22-alpine AS server

WORKDIR /build

COPY package.json package-lock.json ./
RUN npm ci

# tsconfig.build.json compiles src/ to dist/ and excludes src/dev — see its
# comment. The test suite is not here at all; .dockerignore keeps it out.
COPY tsconfig.json tsconfig.build.json ./
COPY src/ ./src/
RUN npx tsc -p tsconfig.build.json

# ---------------------------------------------------------------------------
# 3. The image that actually ships.
# ---------------------------------------------------------------------------
FROM node:22-alpine AS runtime

WORKDIR /app
ENV NODE_ENV=production

# Production dependencies only: no typescript, no vite, no vitest.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=server /build/dist ./dist

# The API serves the dashboard from ../../web/dist relative to its own directory —
# dist/api → /app/web/dist. Put the build where that resolves and the existing
# check in src/api/index.ts finds it, with no code change.
COPY --from=web /build/dist ./web/dist

# migrate.js reads ../../db/schema.sql, so it lands at /app/db/schema.sql.
COPY db/ ./db/

# node:alpine ships a `node` user. Running as root inside a container is a
# needless privilege for a process that only opens a socket and talks to two
# databases.
USER node

EXPOSE 4000

CMD ["node", "dist/api/index.js"]
