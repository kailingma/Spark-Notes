# Spark Notes, as an image.
#
# The full repository is one npm workspace: three packages consumed as
# TypeScript source (no build step), a Vite client that must be built, and a
# server that runs the source directly with tsx. The port's static assets and
# the space's own plugins are loaded at runtime from this repo's checked-in
# tree, so the runtime stage carries the *whole* repository — the build only
# compiles the client into `apps/web/dist`.
#
# Fonts: `apps/web/public/fonts/` is gitignored and fetched by `npm run fonts`
# (SIL OFL typefaces, ~12 MB). The build copies the directory from the runner's
# checkout if it exists, and the image can regenerate it with
# `npm run fonts` at `docker build --build-arg FETCH_FONTS=1`. Without fonts the
# app still runs — the appearance settings fall back to system faces.

# ---------------------------------------------------------------------------
# Builder: install *all* workspace dev dependencies and build the client.
# Kept as a separate stage so `node_modules` (dev tools and all) never reaches
# the runtime image.
# ---------------------------------------------------------------------------
FROM node:22-bookworm-slim AS builder
WORKDIR /build

COPY package.json package-lock.json tsconfig.json ./
COPY apps/ ./apps/
COPY packages/ ./packages/
COPY scripts/ ./scripts/

# `npm ci` installs every workspace's dependencies in one go; `--no-audit`
# keeps the build quiet. npm's haystack-install scripts gate is the reason
# `npm install` in this repo needs `--ignore-scripts=false`: esbuild's
# postinstall is required by Vite. CI does allow it (npm sets it there), so the
# plain `npm ci` is already correct — this line is just spelling that out.
# `--no-update-notifier` keeps the logs clean.
RUN npm ci --no-audit --no-fund --no-update-notifier

# The fonts directory is gitignored, so a clean checkout has none. Copy the
# runner's if this was built from a checkout that ran `npm run fonts`; with
# the build-arg set, download instead.
ARG FETCH_FONTS=0
COPY apps/web/public/ ./apps/web/public/
RUN if [ -d apps/web/public/fonts ] && ls apps/web/public/fonts/* > /dev/null 2>&1; then \
      echo "Using fonts from the checkout"; \
    elif [ "$FETCH_FONTS" = "1" ]; then \
      node scripts/fetch-fonts.mjs; \
    else \
      echo "No fonts found — the app will fall back to system faces. Rebuild with --build-arg FETCH_FONTS=1 to bundle them."; \
    fi

RUN npm run build

# ---------------------------------------------------------------------------
# Runtime: the repo (source, packages, static assets, and the built client)
# plus a production install — no dev tools.
# ---------------------------------------------------------------------------
FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
ENV PORT=3001
# The server binds 0.0.0.0 (all interfaces) by default, so the container is
# reachable from outside itself. Override with `-e HOST=127.0.0.1` to lock it
# to the loopback.
ENV HOST=0.0.0.0
# The directory the server treats as the database. Mount a named volume here,
# or hand the container a different path with `-e SPARK_SPACE=...`.
ENV SPARK_SPACE=/data/space
# Server-side state (GitHub token, AI key) — keep it out of the notes volume
# and, if you can, out of the container itself.
ENV SPARK_STATE=/data/state

WORKDIR /app
COPY --from=builder /build .

# Production install of every workspace, with a fresh npm cache.
RUN npm ci --omit=dev --no-audit --no-fund --no-update-notifier \
 && npm cache clean --force

# The server runs as the container's default `node` user (uid 1000) — the
# volumes are created by Docker with that id as owner, so the state and space
# directories are writable as-is. Npm workspaces first create `node_modules`
# (and the server's own `.spark` directory on first boot) before anything
# writes to the volumes, which is why the chown comes before the volumes are
# declared.

EXPOSE 3001

WORKDIR /app/apps/server
CMD ["node", "node_modules/tsx/dist/cli.mjs", "src/index.ts"]