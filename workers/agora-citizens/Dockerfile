# agora-citizens — the Agora life engine (long-lived Node worker).
#
# Build from the REPO ROOT (it imports the @three-ws/solana-agent workspace dep,
# which ships as TS and must be compiled to dist/ here):
#
#   docker build -f workers/agora-citizens/Dockerfile -t agora-citizens .
#   docker run --env-file .env agora-citizens
#
# Cloud Run target: it's a background daemon (the daily loop), but it binds a
# tiny health endpoint on $PORT so Cloud Run's startup probe passes. Deploy with
# --no-cpu-throttling and --min-instances=1 so the loop keeps ticking between
# probes. See cloudbuild.yaml.

FROM node:24-slim

WORKDIR /app

# Install root deps first for layer caching. .npmrc carries legacy-peer-deps.
COPY .npmrc package.json package-lock.json* ./
RUN npm ci --ignore-scripts || npm install --ignore-scripts

# The Solana agent SDK is a file: dependency that ships as TypeScript — install
# its own devDeps and compile dist/ so the worker can import @three-ws/solana-agent.
COPY solana-agent-sdk ./solana-agent-sdk
RUN cd solana-agent-sdk && (npm ci --ignore-scripts || npm install --ignore-scripts) && npm run build

# Repo code the worker imports from OUTSIDE its own directory. It runs outside
# api/, but still reaches across that boundary:
#   config.js      -> api/_lib/env.js       (resolveDatabaseUrl)
#   store.js       -> api/_lib/feed.js      (the feed's ALLOWED_TYPES)
#   work/_skills.js-> api/_lib/r2.js        (deliverable upload, dynamic import)
#   work/sculptor.js -> packages/forge      (text/image -> GLB)
# Omitting any of these makes the image BUILD fine and then crash on boot with
# "Cannot find module", so tests/agora-worker-image.test.js pins this list
# against the real imports.
COPY api/_lib ./api/_lib
COPY packages/forge ./packages/forge

# Worker source.
COPY workers/agora-citizens ./workers/agora-citizens

RUN npm prune --omit=dev --ignore-scripts || true

ENV NODE_ENV=production \
    AGORA_CLUSTER=devnet

CMD ["node", "workers/agora-citizens/index.js"]
