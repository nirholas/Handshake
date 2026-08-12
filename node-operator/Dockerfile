# three.ws inference node operator client (CPU image).
#
# Build:  docker build -t three-ws/node-operator .
# Run:    docker run --rm -e NODE_SECRET_KEY=... -e NODE_WORKER_SECRET=... \
#           -e BASE_URL=https://three.ws three-ws/node-operator
#
# The model (distilgpt2 ONNX, ~80 MB quantized) downloads into
# /app/.model-cache on first run; mount a volume to keep it warm:
#   -v node-model-cache:/app/.model-cache
#
# For NVIDIA GPUs use Dockerfile.gpu, which layers the CUDA build of
# onnxruntime-node on top of the NVIDIA CUDA runtime and needs
# `docker run --gpus all` (nvidia-container-toolkit on the host).

FROM node:24-bookworm-slim

ENV NODE_ENV=production \
    MODEL_CACHE_DIR=/app/.model-cache

WORKDIR /app

# Install dependencies first so the layer caches across source changes.
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev --no-audit --no-fund

COPY src ./src
COPY README.md ./

# Run as a non-root operator; the cache dir must be writable by it.
RUN useradd --system --uid 10001 --home /app node && \
    mkdir -p /app/.model-cache && \
    chown -R node:node /app
USER node

# Default command runs the daemon. `generate-key`, `register`, `verify`, and
# `selftest` are the other subcommands (see README.md).
CMD ["node", "src/cli.js", "run"]
