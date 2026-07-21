# syntax=docker/dockerfile:1
#
# hood-alerts: one long-running process runs the detection engine, the HTTP
# server (/healthz + premium x402), and both bots (env-gated). Min-instances 1
# on Cloud Run; this is a service, not a job.
#
# Standalone build: hoodchain/hoodkit/hood402 are ordinary published npm
# dependencies (see package.json) — no monorepo siblings, no special build
# context. Build from this directory:
#
#   docker build -t hood-alerts .

# ---- build: full install (better-sqlite3 needs a toolchain) + tsc ----
FROM node:22-slim AS build
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm install --no-audit --no-fund
COPY tsconfig.json ./tsconfig.json
COPY src ./src
COPY scripts ./scripts
RUN npm run build

# ---- prod-deps: runtime node_modules only (no tsc/tsx/vitest) ----
FROM node:22-slim AS prod-deps
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm install --omit=dev --no-audit --no-fund

# ---- runtime ----
FROM node:22-slim AS runtime
ENV NODE_ENV=production
ENV PORT=8080
ENV HOOD_ALERTS_DB=/data/hood-alerts.db
WORKDIR /app
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./package.json
# SQLite lives on a mounted volume so subscriptions survive restarts.
RUN mkdir -p /data
VOLUME ["/data"]
EXPOSE 8080
CMD ["node", "dist/src/index.js"]
