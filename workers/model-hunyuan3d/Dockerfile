FROM nvidia/cuda:12.1.1-cudnn8-devel-ubuntu22.04

# devel (not runtime) base: hy3dgen's texture pipeline compiles CUDA extensions
# (custom_rasterizer + differentiable_renderer) at install time and needs nvcc +
# a C++ toolchain. TORCH_CUDA_ARCH_LIST targets the Cloud Run L4 (compute
# capability 8.9) so the kernels build for it.
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    DEBIAN_FRONTEND=noninteractive \
    TORCH_CUDA_ARCH_LIST="8.9+PTX"

RUN apt-get update && apt-get install -y --no-install-recommends \
        python3.10 python3.10-dev python3-pip \
        git curl wget build-essential ninja-build \
        libgl1 libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/* \
    && ln -sf /usr/bin/python3.10 /usr/bin/python3 \
    && ln -sf /usr/bin/python3.10 /usr/bin/python \
    && pip install --upgrade pip setuptools wheel

# torch first (cached layer), matching the CUDA 12.1 base. torchvision is a hard
# dependency of hy3dgen's shape + paint pipelines (image backbones / transforms)
# and is not pulled in transitively, so it's pinned alongside torch here.
RUN pip install torch==2.3.1 torchvision==0.18.1 --index-url https://download.pytorch.org/whl/cu121

COPY requirements.txt /app/requirements.txt
RUN pip install -r /app/requirements.txt

# hy3dgen from a pinned Tencent/Hunyuan3D-2 clone (moving `main` broke the
# reproducibility bar today on model-trellis; never build from a branch). The
# texgen pipeline needs two in-tree extensions compiled against the image's
# torch: custom_rasterizer (CUDA) and differentiable_renderer's mesh_processor
# (pybind11). --no-build-isolation is REQUIRED — their setup.py imports torch
# at build time and PEP517 isolation would hide the one installed above.
# --no-deps is EQUALLY required: hy3dgen's own install_requires resolves
# unpinned transformers/diffusers releases that silently REPLACE the pinned,
# torch-2.3-compatible stack from requirements.txt (the first deploy shipped a
# transformers that demands torch>=2.4 and a diffusers whose FLAX imports it
# breaks — the paint pipeline import died at model load). Every runtime dep the
# package needs is already pinned in requirements.txt.
RUN git clone https://github.com/Tencent/Hunyuan3D-2.git /tmp/hy3d \
    && cd /tmp/hy3d \
    && git checkout f8db63096c8282cb27354314d896feba5ba6ff8a \
    && pip install --no-build-isolation --no-deps . \
    && cd hy3dgen/texgen/custom_rasterizer \
    && pip install --no-build-isolation --no-deps . \
    && cd ../differentiable_renderer \
    && pip install --no-build-isolation --no-deps . \
    && rm -rf /tmp/hy3d

# Fail the BUILD (not the deploy) if the dependency stack ever drifts again:
# every import the shape + paint pipelines pull at load time must resolve
# against the pinned torch. A broken stack here costs a build retry; the same
# break at model load costs a dead revision serving 500s.
RUN python -c "import torch, torchvision, transformers, diffusers, skimage, cv2, pymeshlab, xatlas, trimesh, rembg; \
import hy3dgen.shapegen, hy3dgen.texgen, hy3dgen.rembg; \
print('deps ok:', torch.__version__, torchvision.__version__, transformers.__version__, diffusers.__version__)"

WORKDIR /app
COPY worker_security.py /app/worker_security.py
COPY image_source.py /app/image_source.py
COPY main.py /app/main.py

EXPOSE 8080

CMD ["uvicorn", "main:app", \
     "--host", "0.0.0.0", \
     "--port", "8080", \
     "--workers", "1", \
     "--timeout-keep-alive", "300"]
