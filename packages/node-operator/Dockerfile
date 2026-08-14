# syntax=docker/dockerfile:1
# three.ws node operator client, CPU image.
#
# This image runs the proof workload on the CPU execution provider, which is
# what the vast majority of operators start on: no drivers, no toolkit, one
# `docker run` and the node is registered and polling.
#
# For an NVIDIA GPU, build Dockerfile.gpu instead. It is a separate image on
# purpose: onnxruntime's CUDA execution provider is a shared library that
# dynamically links the CUDA 12 runtime (libcublasLt.so.12 and friends), and
# those libraries are not in this base image. Running this image with
# `--gpus all` therefore does NOT get you GPU inference; it silently stays on
# the CPU. The client makes that visible either way: it logs the device each
# job actually ran on, and `DEVICE=cuda` fails loudly instead of downgrading.
FROM node:22-bookworm-slim

WORKDIR /app

# Install dependencies first (layer cached unless the manifest changes).
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Copy the client source.
COPY src ./src

# Weights cache + identity persist across restarts when the operator mounts
# these as volumes. Identity is written 0600 by the client itself.
ENV NODE_ENV=production \
    PLATFORM_URL=https://three.ws \
    MODEL=Xenova/all-MiniLM-L6-v2 \
    CAPABILITY=text-embedding \
    DEVICE=cpu \
    POLL_INTERVAL_MS=5000 \
    MAX_CONCURRENCY=1 \
    IDENTITY_PATH=/app/node-identity.json \
    HF_HOME=/app/models

VOLUME ["/app/models"]

# The weights cache and the identity file are written at runtime by the
# unprivileged user, so the mount point has to belong to it before the drop.
RUN mkdir -p /app/models && chown -R node:node /app

# Run as the node user the base image ships: the operator's keypair and
# downloaded weights never need root.
USER node

CMD ["node", "src/index.js"]
