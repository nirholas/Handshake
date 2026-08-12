# syntax=docker/dockerfile:1
# three.ws node operator client.
#
# CPU builds work out of the box. GPU builds layer the NVIDIA Container
# Toolkit on top: `docker run --gpus all ...` with the same image; the
# @xenova/transformers ONNX runtime picks up CUDA execution providers when
# the drivers are present, and stays on CPU otherwise. No separate image.
FROM node:22-bookworm-slim

WORKDIR /app

# Install dependencies first (layer cached unless package.json changes).
COPY package.json ./
RUN npm install --omit=dev

# Copy the client source.
COPY src ./src

# Weights cache + identity persist across restarts when the operator mounts
# these as volumes. Identity is written 0600 by the client itself.
ENV NODE_ENV=production \
    PLATFORM_URL=https://three.ws \
    MODEL=Xenova/all-MiniLM-L6-v2 \
    CAPABILITY=text-embedding \
    POLL_INTERVAL_MS=5000 \
    MAX_CONCURRENCY=1 \
    IDENTITY_PATH=/app/node-identity.json \
    HF_HOME=/app/models

VOLUME ["/app/models"]

# Run as the node user the base image ships: the operator's keypair and
# downloaded weights never need root.
USER node

CMD ["node", "src/index.js"]
