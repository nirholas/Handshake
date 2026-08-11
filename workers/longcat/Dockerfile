# ── Stage: base ────────────────────────────────────────────────────────────────
# CUDA 12.4 matches LongCat's torch==2.6.0+cu124 requirement. The *runtime*
# image is enough because every CUDA extension in this image arrives as a
# pre-built wheel; nothing compiles here, so nvcc is not needed.
#
# Target hardware is a single 80 GB GPU (A100-80GB or H100-80GB, compute
# capability sm_80/sm_90, both covered by the cu124 wheels). See README.md for
# why an L4 is not enough: the resident weight set is about 45 GB.
FROM nvidia/cuda:12.4.1-cudnn-runtime-ubuntu22.04

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    DEBIAN_FRONTEND=noninteractive \
    PIP_NO_CACHE_DIR=1 \
    HF_HUB_DISABLE_PROGRESS_BARS=1

# ── System dependencies ────────────────────────────────────────────────────────
# ffmpeg carries ffprobe, which the service uses to size the segment count from
# the real audio duration, and which upstream's save_video_ffmpeg shells out to.
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

# ── Install FlashAttention-2 from a pre-built wheel ────────────────────────────
# The shipped avatar-1.5 config sets enable_flashattn2: true, so flash_attn is a
# hard runtime import, not an optimisation. Do NOT switch this back to
# "pip install flash-attn": that is an sdist, it needs nvcc (absent from the
# runtime base image), and a from-source build takes ~40 minutes and routinely
# OOMs the builder. The ABI tag is read from the installed torch rather than
# hardcoded, because picking the wrong one yields an undefined-symbol crash at
# import time, long after the build reports success.
ARG FLASH_ATTN_VERSION=2.7.4.post1
RUN ABI=$(python -c "import torch; print('TRUE' if torch._C._GLIBCXX_USE_CXX11_ABI else 'FALSE')") \
    && echo "torch cxx11 abi: ${ABI}" \
    && pip install "https://github.com/Dao-AILab/flash-attention/releases/download/v${FLASH_ATTN_VERSION}/flash_attn-${FLASH_ATTN_VERSION}+cu12torch2.6cxx11abi${ABI}-cp310-cp310-linux_x86_64.whl" \
    && python -c "import flash_attn; from flash_attn import flash_attn_func; print('flash_attn', flash_attn.__version__)"

# ── Install LongCat model + avatar requirements ────────────────────────────────
COPY requirements-model.txt constraints.txt /app/
RUN pip install -c /app/constraints.txt -r /app/requirements-model.txt

# ── Install service requirements ───────────────────────────────────────────────
COPY requirements.txt /app/requirements.txt
RUN pip install -c /app/constraints.txt -r /app/requirements.txt

# Fail the build, not the first job, if a transitive resolution replaced the CUDA
# torch build or moved numpy to 2.x. A copied script rather than a RUN heredoc:
# Cloud Build's docker builder does not enable BuildKit, and RUN heredocs need
# the 1.4+ Dockerfile frontend.
COPY check_pins.py /app/check_pins.py
RUN python /app/check_pins.py

# ── App code ───────────────────────────────────────────────────────────────────
WORKDIR /app
COPY worker_security.py  /app/worker_security.py
COPY model_weights.py    /app/model_weights.py
COPY inference_plan.py   /app/inference_plan.py
COPY main.py             /app/main.py

# ── Build gates ────────────────────────────────────────────────────────────────
# Pure-logic tests, run at build time so a regression in the segment math, the
# output-file choice, the weights layout, or the auth path fails the image
# instead of shipping. Each is also runnable on a laptop:
#   python3 workers/longcat/test_inference_plan.py
COPY test_inference_plan.py /app/test_inference_plan.py
COPY test_model_weights.py  /app/test_model_weights.py
COPY test_app_smoke.py      /app/test_app_smoke.py
RUN python /app/test_inference_plan.py \
    && python /app/test_model_weights.py \
    && python /app/test_app_smoke.py

# Model weights are NOT baked into the image (about 45 GB across two HuggingFace
# repos). They are staged once into a GCS bucket with stage-weights.sh and
# mounted at WEIGHTS_DIR. The service reports an incomplete staging on /health
# and answers 503 from /generate rather than accepting jobs it cannot run.

EXPOSE 8080

# Single worker: the GPU is not re-entrant across processes.
CMD ["uvicorn", "main:app", \
     "--host", "0.0.0.0", \
     "--port", "8080", \
     "--workers", "1", \
     "--timeout-keep-alive", "600"]
