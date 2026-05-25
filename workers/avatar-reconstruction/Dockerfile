# ── Stage: base ───────────────────────────────────────────────────────────────
# CUDA runtime for rembg[gpu] (onnxruntime-gpu).  The L4 GPU is only used for
# background removal; the rest of the pipeline (MediaPipe, TPS, GLB ops) is
# CPU-bound and benefits from the generous CPU allocation on Cloud Run.
FROM nvidia/cuda:12.1.1-cudnn8-runtime-ubuntu22.04

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    DEBIAN_FRONTEND=noninteractive \
    PIP_NO_CACHE_DIR=1

# ── System dependencies ───────────────────────────────────────────────────────
RUN apt-get update && apt-get install -y --no-install-recommends \
        python3.10 python3.10-dev python3-pip \
        git curl wget \
        # OpenCV headless runtime deps
        libgl1 libglib2.0-0 libsm6 libxext6 libxrender1 \
        # MediaPipe runtime deps
        libgomp1 \
    && rm -rf /var/lib/apt/lists/* \
    && ln -sf /usr/bin/python3.10 /usr/bin/python3 \
    && ln -sf /usr/bin/python3.10 /usr/bin/python \
    && pip install --upgrade pip setuptools wheel

# ── Python dependencies ───────────────────────────────────────────────────────
COPY requirements.txt /app/requirements.txt
RUN pip install -r /app/requirements.txt

# ── App code ──────────────────────────────────────────────────────────────────
WORKDIR /app
COPY main.py          /app/main.py
COPY face_pipeline.py /app/face_pipeline.py
COPY glb_ops.py       /app/glb_ops.py
COPY precompute_uv.py /app/precompute_uv.py

# ── Template GLBs ─────────────────────────────────────────────────────────────
# Bake both gender variants into the image so cold starts are instant.
# The repo's default.glb is a Wolf3D unisex base; add male/female variants as
# they become available. For now, all body_type values fall back to default.glb.
RUN mkdir -p /app/templates
COPY templates/ /app/templates/

# ── UV pre-computation ────────────────────────────────────────────────────────
# Run once at image build time.  Generates face_uv_map.json from the
# canonical MediaPipe face model and the Wolf3D_Head mesh in default.glb.
# Requires network access during build (downloads ~200 KB OBJ from GitHub).
RUN python /app/precompute_uv.py /app/templates/default.glb

EXPOSE 8080

# Two workers: CPU pipeline parallelism; GPU is shared via process-level mutex
# inside rembg (onnxruntime handles it).
CMD ["uvicorn", "main:app", \
     "--host", "0.0.0.0", \
     "--port", "8080", \
     "--workers", "1", \
     "--timeout-keep-alive", "300"]
