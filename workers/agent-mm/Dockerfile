# agent-mm — long-lived Node worker (Launch Copilot market-maker engine).
#
# Build from the REPO ROOT (it imports api/_lib/*, api/agents/*, and the
# @three-ws/agent-payments workspace, so it needs the full install):
#
#   docker build -f workers/agent-mm/Dockerfile -t agent-mm .
#   docker run --env-file .env agent-mm
#
# Deploy target is Cloud Run as a background-daemon SERVICE. It's not
# request-driven, but index.js binds a tiny liveness endpoint on $PORT so the
# startup probe passes. Deploy with --no-cpu-throttling and --min-instances=1 so
# the sweep timer keeps ticking between probes. See workers/agent-mm/cloudbuild.yaml.

FROM node:24-slim

WORKDIR /app

# Install deps first for layer caching. See agent-sniper/Dockerfile for why
# .npmrc (legacy-peer-deps) and devDeps (the agent-payments SDK build) are needed.
COPY .npmrc package.json package-lock.json* ./
COPY agent-payments-sdk/package.json ./agent-payments-sdk/
RUN npm ci --ignore-scripts || npm install --ignore-scripts

# Source needed at runtime, then build the SDK's dist/ explicitly.
COPY agent-payments-sdk ./agent-payments-sdk
COPY api ./api
COPY src ./src
COPY workers/agent-mm ./workers/agent-mm
RUN npm run build --prefix agent-payments-sdk

RUN npm prune --omit=dev --ignore-scripts || true

ENV NODE_ENV=production \
    MM_MODE=simulate

CMD ["node", "workers/agent-mm/index.js"]
