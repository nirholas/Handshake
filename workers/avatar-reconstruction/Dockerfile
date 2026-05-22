# ── Stage: base ──────────────────────────────────────────────────────────────
# NVIDIA CUDA 12.1 + cuDNN 8 runtime on Ubuntu 22.04.
# We use the devel variant so that torch extensions can compile native ops.
FROM nvidia/cuda:12.1.1-cudnn8-devel-ubuntu22.04

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    DEBIAN_FRONTEND=noninteractive \
    PIP_NO_CACHE_DIR=1 \
    HF_HOME=/models/hf_home \
    TRANSFORMERS_CACHE=/models/hf_home \
    TORCH_HOME=/models/torch_home \
    PYTHONPATH=/opt/instantmesh

# ── System dependencies ───────────────────────────────────────────────────────
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3.10 python3.10-dev python3-pip \
    git curl wget \
    libgl1 libglib2.0-0 libsm6 libxext6 libxrender1 \
    libgomp1 \
    && rm -rf /var/lib/apt/lists/* \
    && ln -sf /usr/bin/python3.10 /usr/bin/python3 \
    && ln -sf /usr/bin/python3.10 /usr/bin/python

# ── Clone InstantMesh ─────────────────────────────────────────────────────────
RUN git clone --depth 1 https://github.com/TencentARC/InstantMesh /opt/instantmesh

# ── Python dependencies ───────────────────────────────────────────────────────
# Torch must be installed first with the CUDA-specific index URL so we get the
# GPU wheel rather than the CPU-only default from pypi.org.
RUN pip install --upgrade pip setuptools wheel
RUN pip install \
    torch==2.1.0+cu121 \
    torchvision==0.16.0+cu121 \
    --index-url https://download.pytorch.org/whl/cu121

# InstantMesh repo requirements
WORKDIR /opt/instantmesh
RUN pip install -r requirements.txt

# Our server-specific dependencies (on top of InstantMesh's)
COPY requirements.txt /app/requirements.txt
RUN pip install -r /app/requirements.txt

# ── App code ──────────────────────────────────────────────────────────────────
COPY main.py /app/main.py
WORKDIR /app

EXPOSE 8080

# Single worker — GPU inference is synchronous and one job at a time.
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8080", "--workers", "1", "--timeout-keep-alive", "600"]
