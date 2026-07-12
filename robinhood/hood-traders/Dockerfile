# hood-traders — autonomous trading fleet for Robinhood Chain.
#
# `hoodchain` is not yet published to npm (see README), so this build depends
# on the sibling `robinhood-chain-sdk` checkout via a `file:` reference and
# expects the Docker build CONTEXT to be the parent directory containing both
# repos side by side:
#
#   docker build -f hood-traders/Dockerfile -t hood-traders ..
#
# `docker compose up` (see docker-compose.yml) sets this context automatically.
# Once `hoodchain` ships to npm, drop the sdk COPY/build below and switch
# hood-traders/package.json's `hoodchain` dependency to a semver range —
# the rest of the Dockerfile is unaffected.

FROM node:20-slim AS build
WORKDIR /app

# better-sqlite3 needs a C++ toolchain to compile its native addon.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

# ── build the sibling SDK first ──────────────────────────────────────────────
COPY robinhood-chain-sdk ./robinhood-chain-sdk
RUN cd robinhood-chain-sdk && npm install && npm run build

# ── build hood-traders against it ────────────────────────────────────────────
COPY hood-traders/package.json hood-traders/package-lock.json* ./hood-traders/
RUN cd hood-traders && npm install
COPY hood-traders/tsconfig.json hood-traders/tsup.config.ts ./hood-traders/
COPY hood-traders/src ./hood-traders/src
RUN cd hood-traders && npm run build

# ── runtime: keep the same /app/robinhood-chain-sdk + /app/hood-traders layout
#    as the build stage so hood-traders' `file:../robinhood-chain-sdk` resolves
#    identically, and so dist/ and dashboard/ stay siblings for static serving.
FROM node:20-slim AS runtime
ENV NODE_ENV=production

RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --create-home --uid 1001 hood

WORKDIR /app/hood-traders
COPY --from=build /app/robinhood-chain-sdk /app/robinhood-chain-sdk
COPY hood-traders/package.json hood-traders/package-lock.json* ./
RUN npm install --omit=dev && npm rebuild better-sqlite3 && \
    apt-get purge -y python3 make g++ 2>/dev/null || true

COPY --from=build /app/hood-traders/dist ./dist
COPY hood-traders/dashboard ./dashboard

RUN mkdir -p /app/hood-traders/data && chown -R hood:hood /app
USER hood

EXPOSE 4670
VOLUME ["/app/hood-traders/data"]

CMD ["node", "dist/main.js"]
