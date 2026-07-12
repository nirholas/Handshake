# hood-launcher — autonomous coin launcher for Robinhood Chain.
#
# Runs the HTTP API by default (src/api/server.ts). For the autonomous
# scheduler loop instead, override the command:
#   docker run <image> node dist/cli-auto.js loop --interval-minutes 60
#
# Build:  docker build -t hood-launcher .
# Run:    docker run --env-file .env -p 8787:8787 -v hood-launcher-data:/app/.hood-launcher hood-launcher

FROM node:20-slim AS build
WORKDIR /app

# solc's WASM binary + @openzeppelin/contracts source only need to compile once,
# at image-build time — contracts/*.json ships the result, no C++ toolchain needed.
COPY package.json package-lock.json* ./
RUN npm install
COPY tsconfig.json tsup.config.ts vitest.config.ts ./
COPY contracts ./contracts
COPY scripts ./scripts
COPY src ./src
COPY bin ./bin
RUN npm run compile:contract && npm run build

FROM node:20-slim AS runtime
ENV NODE_ENV=production
RUN useradd --create-home --uid 1001 hood
WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY --from=build /app/dist ./dist
COPY --from=build /app/contracts ./contracts
COPY examples ./examples

RUN mkdir -p /app/.hood-launcher && chown -R hood:hood /app
USER hood

ENV PORT=8787
ENV HOOD_LAUNCHER_DATA_DIR=/app/.hood-launcher
EXPOSE 8787

CMD ["node", "dist/api-server.js"]
