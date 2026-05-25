# ── Stage: base ────────────────────────────────────────────────────────────────
# CUDA 12.4 matches LongCat's torch==2.6.0+cu124 requirement.
# L4 GPU on Cloud Run (24 GB VRAM) runs Avatar-1.5 with INT8 quantization
# (~14 GB footprint at inference time).
FROM nvidia/cuda:12.4.1-cudnn-runtime-ubuntu22.04

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    DEBIAN_FRONTEND=noninteractive \
    PIP_NO_CACHE_DIR=1 \
    HF_HUB_DISABLE_PROGRESS_BARS=1

# ── System dependencies ────────────────────────────────────────────────────────
RUN apt-get update && apt-get install -y --no-install-recommends \
        python3.10 python3.10-dev python3-pip \
        git curl wget ffmpeg \
        libgl1 libglib2.0-0 libsm6 libxext6 libxrender1 \
        libgomp1 libsndfile1 \
    && rm -rf /var/lib/apt/lists/* \
    && ln -sf /usr/bin/python3.10 /usr/bin/python3 \
    && ln -sf /usr/bin/python3.10 /usr/bin/python \
    && pip install --upgrade pip setuptools wheel

# ── Clone LongCat repo ─────────────────────────────────────────────────────────
RUN git clone --depth=1 https://github.com/meituan-longcat/LongCat-Video.git /longcat

# ── Install PyTorch first (cu124 wheel) ────────────────────────────────────────
RUN pip install torch==2.6.0 torchvision torchaudio \
        --index-url https://download.pytorch.org/whl/cu124

# ── Install FlashAttention-2 pre-built wheel ───────────────────────────────────
# Build from source is ~30 min; use the pre-built cu124 + sm89 wheel for L4.
RUN pip install flash-attn==2.7.4.post1 --no-build-isolation

# ── Install LongCat model requirements (minus torch, minus flash-attn) ─────────
RUN pip install \
        numpy==1.26.4 \
        transformers==4.41.0 \
        loguru==0.7.2 \
        diffusers==0.35.1 \
        einops==0.8.0 \
        ftfy==6.2.0 \
        psutil==6.0.0 \
        av==12.0.0 \
        opencv-python-headless==4.9.0.80 \
        imageio==2.37.0 \
        imageio-ffmpeg==0.6.0 \
        librosa==0.11.0 \
        soundfile==0.13.1

# ── Install service requirements ───────────────────────────────────────────────
COPY requirements.txt /app/requirements.txt
RUN pip install -r /app/requirements.txt

# ── App code ───────────────────────────────────────────────────────────────────
WORKDIR /app
COPY main.py /app/main.py

# Model weights are NOT baked into the image (13.6 B params = ~27 GB bf16 /
# ~14 GB int8). They are downloaded at first startup into WEIGHTS_DIR, which
# should be a Cloud Run volume mount backed by a persistent GCS bucket so
# subsequent cold starts reuse the cached weights.

EXPOSE 8080

# Single worker — GPU is not re-entrant across processes.
CMD ["uvicorn", "main:app", \
     "--host", "0.0.0.0", \
     "--port", "8080", \
     "--workers", "1", \
     "--timeout-keep-alive", "600"]
