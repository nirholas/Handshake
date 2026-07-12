# syntax=docker/dockerfile:1.7-labs
# three.ws production image for Google Cloud Run.
# Runs server/index.mjs: the static frontend (dist/), the vercel.json route
# table, and every api/** handler with Vercel-parity routing. See
# server/README.md.
#
# Layering is cache-oriented (built via server/cloudbuild.yaml with BuildKit):
# manifests are copied alone so the `npm ci` layer survives source-only
# changes — the common case during the migration — cutting rebuilds from
# ~10 min to ~3. Dependency lifecycle scripts and the root postinstall (which
# builds the workspace SDKs from source) run after the full copy.
FROM node:24-slim

WORKDIR /app

# node-gyp toolchain: native deps (better-sqlite3, bigint bindings) have no
# Node 24 prebuilts, so `npm rebuild` compiles them from source.
#
# The lib*/fonts block is the shared-library runtime for headless chromium
# (@sparticuz/chromium-min downloads the binary to /tmp at first use, but it
# still links against system libs). Without it every avatar-thumbnail render
# on Cloud Run dies at launch with "libnspr4.so: cannot open shared object
# file" — see api/_lib/render-glb.js and api/cron/avatar-thumbnail-backfill.js.
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
       libnspr4 libnss3 libdbus-1-3 libatk1.0-0 libatk-bridge2.0-0 libcups2 \
       libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 \
       libgbm1 libasound2 libpango-1.0-0 libcairo2 libx11-6 libxcb1 libxext6 \
       libexpat1 libglib2.0-0 fonts-liberation ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Same browser-download skips as the Vercel install command.
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    PUPPETEER_SKIP_DOWNLOAD=1

# 1. Manifests only → cacheable `npm ci` layer. --parents preserves the
#    workspace directory structure (requires the dockerfile 1.7-labs syntax).
COPY --parents package.json package-lock.json .npmrc* **/package.json /app/
RUN npm ci --ignore-scripts --no-audit --no-fund

# 2. Full source, then run the deferred lifecycle scripts: native/module
#    install hooks (npm rebuild) and the root postinstall (SDK builds).
COPY . .
RUN npm rebuild && npm run postinstall

# 3. Shed devDependencies (playwright, vite, typescript, vitest, esbuild, jsdom…)
#    now that the SDK builds above are done. The server and every api/** handler
#    import only production deps at runtime — the frontend is pre-built into
#    dist/ and served as static files — so nothing here is load-bearing at boot.
#    --ignore-scripts: the lifecycle hooks already ran; prune must not re-trigger
#    a workspace rebuild against a now-partial tree.
RUN npm prune --omit=dev --ignore-scripts --no-audit --no-fund

ENV NODE_ENV=production \
    NODE_OPTIONS=--no-deprecation

# Drop root: Cloud Run has no reason to run this as uid 0. The node:24 base ships
# an unprivileged `node` user (uid 1000). The app never writes to /app at
# runtime — persona/ledger disk fallbacks target os.tmpdir(), and headless
# chromium downloads to /tmp — so a read-only, root-owned app tree is fine.
#
# But `COPY . .` preserves the build context's file modes, and a context built
# with an unusual umask (e.g. a git worktree on some CI filesystems yields dirs
# without the world-traverse bit) leaves directories the `node` user cannot enter
# — the container then dies at boot with a misleading `Cannot find module
# '/app/server/index.mjs'` (really EACCES on the path, surfaced as MODULE_NOT_FOUND).
# Normalize to world-readable + traversable before dropping privileges so the
# image boots regardless of the source umask. `a+rX` adds read to everything and
# the execute/traverse bit only to directories (and already-executable files).
RUN chmod -R a+rX /app
USER node

EXPOSE 8080
CMD ["node", "server/index.mjs"]
