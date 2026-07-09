# Hyperfy — world.three.ws
# Multi-stage: build Hyperfy from source, then produce a lean production image.
# The /app/world volume (GCS bucket in production) holds SQLite + uploaded assets so
# the container itself is stateless and can be rebuilt without losing world data.

FROM node:22-alpine AS source
WORKDIR /app
RUN apk add --no-cache git python3 make g++
# Pinned upstream commit so a rebuild never silently pulls new Hyperfy code.
# Update this hash deliberately when pulling in upstream improvements, and
# re-verify the patches in patches/ still apply.
ARG HYPERFY_REF=5d20037435a1d86cda088382bb12737e9f18d5f6
RUN git init -q . \
  && git remote add origin https://github.com/hyperfy-xyz/hyperfy.git \
  && git fetch --depth 1 origin ${HYPERFY_REF} \
  && git checkout -q FETCH_HEAD
# Server-side hardening: enforce PUBLIC_MAX_UPLOAD_SIZE on /api/upload itself
# (upstream hard-codes a 200MB multipart cap on an unauthenticated route), expose
# blueprint assets on /status, and refuse to boot unprotected in production.
COPY patches/ /tmp/patches/
RUN git apply --verbose /tmp/patches/*.patch

FROM source AS builder
RUN npm ci
# No `|| true` here: a swallowed build failure surfaced later as a confusing
# "COPY failed: stat app/dist" and hid the fact that this image never built.
RUN npm run build

FROM node:22-alpine AS runner
WORKDIR /app
# Copy only what the server needs at runtime. `npm run build` emits everything to
# build/ — the server bundle (build/index.js, per package.json "start"), the client
# bundle and its assets (build/public/), and the PhysX wasm. There is no dist/ and
# no top-level public/ in Hyperfy; naming them is what broke every prior build.
COPY --from=builder /app/package*.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/build ./build
COPY --from=builder /app/src ./src
# rootDir is `path.join(__dirname, '../')` = /app/, so WORLD=world resolves to
# /app/world — the mount point for the GCS bucket that persists the world.
RUN mkdir -p /app/world
# Runs as root, deliberately: Cloud Run mounts the gcsfuse volume at /app/world
# root-owned, and the server must write SQLite + uploaded assets there every
# SAVE_INTERVAL. A non-root USER boots fine but silently loses every world save —
# a quieter version of the data loss this hardening exists to prevent. Dropping
# privileges needs gcsfuse uid/gid mount options, not just a USER line.
ENV NODE_ENV=production PORT=3000
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=10s --start-period=20s \
  CMD wget -qO- http://localhost:3000/status || exit 1
CMD ["npm", "start"]
