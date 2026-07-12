# hood-traders — autonomous trading fleet for Robinhood Chain.
# Multi-stage build; final image runs the fleet + dashboard in paper mode by
# default (docker-compose.yml sets no live-trading env vars).

FROM node:20-slim AS build
WORKDIR /app

# better-sqlite3 needs a C++ toolchain to compile its native addon.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* ./
RUN npm install
COPY tsconfig.json tsup.config.ts ./
COPY src ./src
RUN npm run build

FROM node:20-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --create-home --uid 1001 hood

COPY package.json package-lock.json* ./
RUN npm install --omit=dev && npm rebuild better-sqlite3 && \
    apt-get purge -y python3 make g++ 2>/dev/null || true

COPY --from=build /app/dist ./dist
COPY dashboard ./dashboard

RUN mkdir -p /app/data && chown -R hood:hood /app
USER hood

EXPOSE 4670
VOLUME ["/app/data"]

CMD ["node", "dist/main.js"]
