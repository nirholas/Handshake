# syntax=docker/dockerfile:1
#
# hood-alerts: one long-running process runs the detection engine, the HTTP
# server (/healthz + premium x402), and both bots (env-gated). Min-instances 1
# on Cloud Run; this is a service, not a job.
#
# The build context MUST be the parent `robinhood/` directory so the local
# file: siblings (robinhood-chain-sdk, hoodkit, hood402) resolve:
#
#   docker build -f hood-alerts/Dockerfile -t hood-alerts .   # run from robinhood/
#
# Once those packages are published to npm, switch the file: specs in
# package.json to the published versions and the app builds from its own dir.

# ---- build: full install (better-sqlite3 needs a toolchain) + tsc ----
FROM node:22-slim AS build
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /build
# Prebuilt sibling packages (manifest + dist) for the file: links.
COPY robinhood-chain-sdk/package.json ./robinhood-chain-sdk/package.json
COPY robinhood-chain-sdk/dist ./robinhood-chain-sdk/dist
COPY hoodkit/package.json ./hoodkit/package.json
COPY hoodkit/dist ./hoodkit/dist
COPY hood402/package.json ./hood402/package.json
COPY hood402/dist ./hood402/dist
WORKDIR /build/hood-alerts
COPY hood-alerts/package.json ./package.json
# --install-links copies the file: siblings into node_modules as real packages
# (not symlinks), so their `viem` dependency hoists and resolves at runtime.
RUN npm install --install-links --no-audit --no-fund
COPY hood-alerts/tsconfig.json ./tsconfig.json
COPY hood-alerts/src ./src
COPY hood-alerts/scripts ./scripts
RUN npm run build

# ---- prod-deps: runtime node_modules only (no tsc/tsx/vitest) ----
FROM node:22-slim AS prod-deps
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /build
COPY robinhood-chain-sdk/package.json ./robinhood-chain-sdk/package.json
COPY robinhood-chain-sdk/dist ./robinhood-chain-sdk/dist
COPY hoodkit/package.json ./hoodkit/package.json
COPY hoodkit/dist ./hoodkit/dist
COPY hood402/package.json ./hood402/package.json
COPY hood402/dist ./hood402/dist
WORKDIR /build/hood-alerts
COPY hood-alerts/package.json ./package.json
RUN npm install --omit=dev --install-links --no-audit --no-fund

# ---- runtime ----
FROM node:22-slim AS runtime
ENV NODE_ENV=production
ENV PORT=8080
ENV HOOD_ALERTS_DB=/data/hood-alerts.db
WORKDIR /app
COPY --from=prod-deps /build/hood-alerts/node_modules ./node_modules
COPY --from=build /build/hood-alerts/dist ./dist
COPY --from=build /build/hood-alerts/package.json ./package.json
# SQLite lives on a mounted volume so subscriptions survive restarts.
RUN mkdir -p /data
VOLUME ["/data"]
EXPOSE 8080
CMD ["node", "dist/src/index.js"]
