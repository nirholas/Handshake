FROM nvidia/cuda:12.8.0-cudnn-devel-ubuntu22.04

# devel (not runtime) base: LingBot-Map pulls FlashInfer and NVIDIA Kaolin, which
# build/JIT CUDA kernels and need nvcc + headers. TORCH_CUDA_ARCH_LIST targets the
# Cloud Run L4 (compute capability 8.9) so kernels build for it.
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    DEBIAN_FRONTEND=noninteractive \
    TORCH_CUDA_ARCH_LIST="8.9+PTX" \
    PYTHONPATH=/opt/lingbot-map

RUN apt-get update && apt-get install -y --no-install-recommends \
        python3.10 python3.10-dev python3-pip \
        git curl wget build-essential ninja-build \
        ffmpeg libgl1 libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/* \
    && ln -sf /usr/bin/python3.10 /usr/bin/python3 \
    && ln -sf /usr/bin/python3.10 /usr/bin/python \
    && pip install --upgrade pip setuptools wheel

# torch first (cached layer), matching the CUDA 12.8 base and LingBot-Map's pin.
RUN pip install torch==2.8.0 torchvision==0.23.0 --index-url https://download.pytorch.org/whl/cu128

# LingBot-Map (Apache-2.0). Clone, install the package + its deps, then put the
# repo on PYTHONPATH so demo.py (load_model/load_images/postprocess) is importable.
# The [vis] extra is required, not cosmetic: lingbot_map.vis is where the sanctioned
# sky-segmentation pipeline lives (apply_sky_segmentation + the ONNX runtime), and
# its package __init__ imports the viewer, so the extra's deps must be present for
# `mask_sky` to work at all.
RUN git clone --depth 1 https://github.com/Robbyant/lingbot-map.git /opt/lingbot-map \
    && pip install -e "/opt/lingbot-map[vis]"

# Accelerated paged-KV attention (recommended by upstream for streaming inference).
RUN pip install --index-url https://pypi.org/simple flashinfer-python

COPY requirements.txt /app/requirements.txt
RUN pip install -r /app/requirements.txt

WORKDIR /app
COPY worker_security.py /app/worker_security.py
COPY scene_fusion.py /app/scene_fusion.py
COPY test_scene_fusion.py /app/test_scene_fusion.py
COPY main.py /app/main.py

# Fail the build, not a production request, if the fusion path or the service
# module is broken in the image we are about to ship.
RUN python -m unittest test_scene_fusion \
    && API_KEY=build GCS_BUCKET=build python -c "import main; print('main imports clean')"

EXPOSE 8080

# Long sequences run for minutes — keep the keep-alive generous; Cloud Run's own
# request timeout (cloudbuild --timeout) bounds the synchronous /infer 202 return,
# while the reconstruction itself runs in a FastAPI BackgroundTask.
CMD ["uvicorn", "main:app", \
     "--host", "0.0.0.0", \
     "--port", "8080", \
     "--workers", "1", \
     "--timeout-keep-alive", "600"]
