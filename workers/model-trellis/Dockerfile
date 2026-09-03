# TRELLIS (Microsoft, MIT) — single-image → textured 3D mesh on an L4 (24 GB).
#
# This image translates the upstream conda `setup.sh` into a reproducible pip
# build. Reliability choices that matter for Cloud Build + Cloud Run L4:
#   • CUDA 12.1 *devel* base — nvcc is required to compile diffoctreerast /
#     nvdiffrast / diff-gaussian-rasterization from source. The runtime image
#     keeps them; we don't strip nvcc because cold imports JIT a little.
#   • torch 2.4.0 + cu121, the matrix every TRELLIS extension has wheels/【builds】for.
#   • Attention backend = xformers, NOT flash-attn. flash-attn compiles from
#     source for 30+ min and routinely OOMs the builder; xformers is an upstream-
#     supported backend and an L4 (sm_89) runs it well. Set via ATTN_BACKEND.
#   • TORCH_CUDA_ARCH_LIST=8.9 — build CUDA kernels only for the L4 (Ada). This
#     cuts compile time massively vs. building every arch.
FROM nvidia/cuda:12.1.1-cudnn8-devel-ubuntu22.04

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    DEBIAN_FRONTEND=noninteractive \
    # Build kernels only for the L4 (Ada, sm_89) — keeps source compiles fast.
    TORCH_CUDA_ARCH_LIST="8.9" \
    # TRELLIS runtime backends (read at import time in main.py).
    ATTN_BACKEND=xformers \
    SPCONV_ALGO=native \
    # TRELLIS repo lives here and is imported off PYTHONPATH (not a pip package).
    PYTHONPATH=/app/TRELLIS

RUN apt-get update && apt-get install -y --no-install-recommends \
        python3.10 python3.10-dev python3-pip \
        git curl wget build-essential ninja-build \
        libgl1 libglib2.0-0 libgomp1 \
    && rm -rf /var/lib/apt/lists/* \
    && ln -sf /usr/bin/python3.10 /usr/bin/python3 \
    && ln -sf /usr/bin/python3.10 /usr/bin/python \
    && pip install --upgrade pip setuptools wheel

# ── 1. Torch first (own layer; every extension below links against it) ────────
RUN pip install torch==2.4.0 torchvision==0.19.0 --index-url https://download.pytorch.org/whl/cu121

# ── 2. setup.sh --basic + utils3d ─────────────────────────────────────────────
# transformers MUST stay pinned to a torch-2.4-compatible release. Unpinned, the
# 2026-07-16 rebuild resolved a version whose CLIP modeling imports DTensor from
# torch.distributed.tensor (public only since torch 2.5), so the pipeline failed
# to load at boot and every inference on the revision failed. 4.46.3 is the
# TRELLIS-era release verified against torch 2.4.0/cu121.
RUN pip install \
        pillow imageio imageio-ffmpeg tqdm easydict opencv-python-headless \
        scipy ninja rembg onnxruntime trimesh open3d xatlas pyvista pymeshfix \
        igraph "transformers==4.46.3" \
    && pip install git+https://github.com/EasternJournalist/utils3d.git@9a4eb15e4021b67b12c460c7057d642626897ec8

# ── 3. setup.sh --xformers / --spconv / --kaolin (prebuilt wheels) ────────────
RUN pip install xformers==0.0.27.post2 --index-url https://download.pytorch.org/whl/cu121
RUN pip install spconv-cu120
RUN pip install kaolin -f https://nvidia-kaolin.s3.us-east-2.amazonaws.com/torch-2.4.0_cu121.html

# ── 4. setup.sh --nvdiffrast / --diffoctreerast / --mipgaussian (compiled) ────
# These build CUDA kernels with nvcc; TORCH_CUDA_ARCH_LIST=8.9 scopes them to L4.
# --no-build-isolation is REQUIRED: each extension's setup.py `import torch` at
# build time, but PEP517 isolation hides the torch installed in step 1 — nvdiffrast
# aborts with "Cannot compile nvdiffrast CUDA extension … run pip install with
# --no-build-isolation". The flag makes the build reuse the image's torch. setuptools/
# wheel are already present (installed in the apt layer), so no build deps are missing.
RUN git clone https://github.com/NVlabs/nvdiffrast.git /tmp/ext/nvdiffrast \
    && pip install --no-build-isolation /tmp/ext/nvdiffrast
RUN git clone --recurse-submodules https://github.com/JeffreyXiang/diffoctreerast.git /tmp/ext/diffoctreerast \
    && pip install --no-build-isolation /tmp/ext/diffoctreerast
RUN git clone https://github.com/autonomousvision/mip-splatting.git /tmp/ext/mip-splatting \
    && pip install --no-build-isolation /tmp/ext/mip-splatting/submodules/diff-gaussian-rasterization/ \
    && rm -rf /tmp/ext

# ── 5. Server deps ────────────────────────────────────────────────────────────
# pytest is here for the build-time gate at the bottom of this file, the same
# pattern workers/garment-forge uses: the request policy is unit tested during
# `docker build`, so a broken tier table or clamp can never reach a revision.
RUN pip install \
        "fastapi==0.115.0" "uvicorn[standard]==0.32.0" "pydantic>=2.0.0" \
        "httpx>=0.27.0" "google-cloud-storage==2.18.0" "safetensors>=0.4.0" \
        "pytest>=8.0.0"

# ── 6. TRELLIS source (imported via PYTHONPATH, pinned for reproducibility) ───
# --recurse-submodules is REQUIRED: TRELLIS vendors FlexiCubes (its mesh
# extractor) as a git submodule at trellis/representations/mesh/flexicubes. A
# plain clone leaves that dir a bare gitlink, so `from .flexicubes.flexicubes
# import FlexiCubes` fails at model load with ModuleNotFoundError and the worker
# crashes on startup before binding the port.
# Pinned (2026-07-16): a moving `main` broke this worker's rebuild once already
# (the transformers pin below exists for the same reason). This sha is verified
# to carry run_multi_image, which main.py uses for multi-view fusion.
RUN git clone --recurse-submodules https://github.com/microsoft/TRELLIS.git /app/TRELLIS \
    && git -C /app/TRELLIS checkout 442aa1e1afb9014e80681d3bf604e8d728a86ee7 \
    && git -C /app/TRELLIS submodule update --init --recursive

# ── 7. dinov2 image conditioner, baked so the model load never calls out ──────
# pipeline.json sets image_cond_model=dinov2_vitl14_reg, and TRELLIS resolves it
# with torch.hub.load("facebookresearch/dinov2", ...) with no branch pinned. That
# call hits github.com on every load just to discover the default branch, and
# torch re-raises any non-404 there before it ever looks at its own cache. Cloud
# Run egresses from shared Google IPs that GitHub rate-limits, so the load had a
# standing dependency on somebody else's quota: on 2026-09-02 a single "HTTP
# Error 403: rate limit exceeded" failed it, and the latched error held the
# default free image lane down for 12 hours. Baking the repo and its checkpoint
# removes that dependency; main.py routes torch.hub at this checkout.
# The checkpoint filename is the one torch.hub.load_state_dict_from_url derives
# from the upstream URL, so the pre-baked copy is a cache hit rather than a
# second download.
ENV TORCH_HOME=/opt/torch \
    DINOV2_LOCAL_DIR=/opt/dinov2
RUN git clone https://github.com/facebookresearch/dinov2.git /opt/dinov2 \
    && git -C /opt/dinov2 checkout 7764ea0f912e53c92e82eb78a2a1631e92725fc8 \
    && mkdir -p /opt/torch/hub/checkpoints \
    && curl -fsSL -o /opt/torch/hub/checkpoints/dinov2_vitl14_reg4_pretrain.pth \
         https://dl.fbaipublicfiles.com/dinov2/dinov2_vitl14/dinov2_vitl14_reg4_pretrain.pth \
    && python3 -c "import os; p='/opt/torch/hub/checkpoints/dinov2_vitl14_reg4_pretrain.pth'; s=os.path.getsize(p); assert s > 1_000_000_000, f'dinov2 checkpoint truncated: {s} bytes'"

WORKDIR /app
COPY worker_security.py /app/worker_security.py
COPY request_policy.py /app/request_policy.py
COPY main.py /app/main.py
COPY test_request_policy.py test_app_contract.py /app/

# Build-time gate, neither half of which needs a GPU:
#   1. The quality tiers, the clamps that keep a caller value from crashing the
#      nvdiffrast bake, and the image-fetch retry policy are pure logic, proven
#      here rather than in production.
#   2. The served contract, against the exact dependency set that will run: the
#      TRELLIS import chain (FlexiCubes submodule included), the auth boundary,
#      the probe surfaces, request validation, and the SSRF guard.
RUN python3 -m pytest /app/test_request_policy.py -q \
    && python3 /app/test_app_contract.py

EXPOSE 8080

CMD ["uvicorn", "main:app", \
     "--host", "0.0.0.0", \
     "--port", "8080", \
     "--workers", "1", \
     "--timeout-keep-alive", "300"]
