# robinhood-feed: long-lived Node worker (Cloud Run service, HTTP + WS + SSE).
#
# Build from the REPO ROOT: the worker depends on the local hoodchain SDK via
# `file:../../robinhood/robinhood-chain-sdk`, so that directory has to be inside
# the build context. A context scoped to workers/robinhood-feed alone (what
# `gcloud run deploy --source workers/robinhood-feed` would send) cannot resolve
# the dependency and fails at install time.
#
#   docker build -f workers/robinhood-feed/Dockerfile -t robinhood-feed .
#   docker run -p 8788:8788 -e PORT=8788 robinhood-feed

# ── stage 1: build the SDK's dist/ (TypeScript source, dist/ is gitignored) ────
FROM node:24-slim AS sdk

WORKDIR /sdk
COPY robinhood/robinhood-chain-sdk/package.json robinhood/robinhood-chain-sdk/package-lock.json ./
# devDeps on purpose: tsup + typescript build the dist/ every export resolves into.
RUN npm ci --no-audit --no-fund
COPY robinhood/robinhood-chain-sdk ./
RUN npm run build

# ── stage 2: runtime ──────────────────────────────────────────────────────────
FROM node:24-slim

WORKDIR /app

# The built SDK, shaped as a consumable package (its own `files` list: dist +
# package.json + docs). Path matches the worker's file: specifier.
COPY --from=sdk /sdk/package.json /sdk/README.md /sdk/LICENSE ./robinhood/robinhood-chain-sdk/
COPY --from=sdk /sdk/dist ./robinhood/robinhood-chain-sdk/dist

# Worker deps first for layer caching. The file: dependency resolves to the
# directory copied above, which now carries dist/.
#
# The symlink is load-bearing, not a shortcut. npm installs a file: dependency
# as a symlink to its source directory, and Node resolves modules from the REAL
# path, so hoodchain's code runs at /app/robinhood/robinhood-chain-sdk/dist and
# looks for its peer deps (viem, ws) in the ancestors of THAT path, never in the
# worker's own node_modules. Without a node_modules an ancestor of both trees,
# the image builds clean and then dies on the first import with
# "Cannot find package 'viem'". Verified by running the image.
COPY workers/robinhood-feed/package.json workers/robinhood-feed/package-lock.json ./workers/robinhood-feed/
RUN npm --prefix workers/robinhood-feed ci --omit=dev --no-audit --no-fund \
    && ln -s workers/robinhood-feed/node_modules /app/node_modules

COPY workers/robinhood-feed ./workers/robinhood-feed

# Cloud Run injects PORT; 8788 is the local default the README and the API's
# ROBINHOOD_FEED_URL fallback both use.
ENV NODE_ENV=production \
    PORT=8788
EXPOSE 8788

CMD ["node", "workers/robinhood-feed/index.js"]
