# gltfpack (zeux/meshoptimizer, MIT) decodes EXT_meshopt_compression, which
# trimesh cannot read and which most three.ws avatars ship as. Pinned by release
# tag and checksum so the image never picks up a binary we did not audit.
FROM python:3.11-slim AS gltfpack
ARG GLTFPACK_VERSION=v1.2
ARG GLTFPACK_SHA256=ebc236f5f6c08c7e5c5750476a187d24805d44d8c680449c4b7369c333f817b1
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl unzip \
    && curl -fsSL -o /tmp/gltfpack.zip \
        https://github.com/zeux/meshoptimizer/releases/download/${GLTFPACK_VERSION}/gltfpack-ubuntu.zip \
    && echo "${GLTFPACK_SHA256}  /tmp/gltfpack.zip" | sha256sum -c - \
    && unzip -j /tmp/gltfpack.zip gltfpack -d /usr/local/bin \
    && chmod +x /usr/local/bin/gltfpack \
    && /usr/local/bin/gltfpack -v

FROM nvidia/cuda:12.1.1-cudnn8-runtime-ubuntu22.04
COPY --from=gltfpack /usr/local/bin/gltfpack /usr/local/bin/gltfpack

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    DEBIAN_FRONTEND=noninteractive \
    PYOPENGL_PLATFORM=egl

RUN apt-get update && apt-get install -y --no-install-recommends \
        python3.11 python3.11-dev python3-pip \
        libgl1-mesa-glx libgl1 libglib2.0-0 libgomp1 \
        libegl1-mesa libgles2-mesa \
    && rm -rf /var/lib/apt/lists/* \
    && ln -sf /usr/bin/python3.11 /usr/bin/python3 \
    && ln -sf /usr/bin/python3.11 /usr/bin/python \
    && pip install --upgrade pip

# torch first (big, cached layer)
RUN pip install torch==2.3.1 torchvision==0.18.1 --index-url https://download.pytorch.org/whl/cu121

# xformers alongside torch, from the same cu121 index, exactly as
# workers/model-trellis does. Two reasons it is not in requirements.txt: every
# xformers release pins one exact torch version (0.0.27 is the one built for
# 2.3.1), so listing it there made pip refuse the whole file as unsolvable
# against our torch pin; and the PyPI wheel is built against a different CUDA
# than the base image, which fails at import rather than at install.
RUN pip install xformers==0.0.27 --index-url https://download.pytorch.org/whl/cu121

COPY requirements.txt /app/requirements.txt
RUN pip install -r /app/requirements.txt

# Pre-cache the ControlNet weights during build to cut cold-start latency.
# This deliberately does NOT live under /weights: Cloud Run mounts the weights
# bucket there, and the mount shadows whatever the image baked at that path, so
# a cache written to /weights would be invisible at runtime. /opt/hf-cache is
# always reachable and is the loader's last-resort fallback when GCS staging
# (WEIGHTS_GCS_URI) is unset or the staging prefix is empty.
#
# The fp16 variant, matching WEIGHT_VARIANT in main.py. Caching the
# full-precision files instead would put 4.7 GiB in the image that the runtime
# then ignores while it downloads the 2.3 GiB it actually asked for.
ARG CONTROLNET_MODEL=diffusers/controlnet-depth-sdxl-1.0
ARG WEIGHT_VARIANT=fp16
# No space after the opening quote: a line continuation collapses to one, and
# python -c rejects a leading space as an IndentationError before it runs a
# single statement. That is how this layer failed for as long as it existed.
RUN python3 -c "import torch; \
from diffusers import ControlNetModel; \
ControlNetModel.from_pretrained('${CONTROLNET_MODEL}', torch_dtype=torch.float16, use_safetensors=True, variant='${WEIGHT_VARIANT}', cache_dir='/opt/hf-cache'); \
print('ControlNet cached')"

WORKDIR /app
COPY worker_security.py /app/worker_security.py
COPY gltf_meshopt.py /app/gltf_meshopt.py
COPY texture_projection.py /app/texture_projection.py
COPY test_texture_projection.py /app/test_texture_projection.py
COPY test_gltf_meshopt.py /app/test_gltf_meshopt.py
COPY stage_weights.py /app/stage_weights.py
COPY main.py /app/main.py

# Core-path gate: the UV rasterizer and back-projection that decide where a
# generated pixel lands, and the meshopt decode every caller mesh passes
# through. Both are CPU-only, so a regression fails the image instead of
# reaching a user mid-retexture.
RUN python3 /app/test_texture_projection.py && python3 /app/test_gltf_meshopt.py

EXPOSE 8080
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8080", "--workers", "1"]
