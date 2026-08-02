FROM nvidia/cuda:12.1.1-cudnn8-runtime-ubuntu22.04

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

COPY requirements.txt /app/requirements.txt
RUN pip install -r /app/requirements.txt

# Pre-cache the ControlNet weights during build to cut cold-start latency.
# This deliberately does NOT live under /weights: Cloud Run mounts the weights
# bucket there, and the mount shadows whatever the image baked at that path, so
# a cache written to /weights would be invisible at runtime. /opt/hf-cache is
# always reachable and is the loader's last-resort fallback when GCS staging
# (WEIGHTS_GCS_URI) is unset or the staging prefix is empty.
ARG SDXL_MODEL=stabilityai/stable-diffusion-xl-base-1.0
ARG CONTROLNET_MODEL=diffusers/controlnet-depth-sdxl-1.0
RUN python3 -c " \
from diffusers import ControlNetModel, StableDiffusionXLControlNetPipeline; \
import torch; \
ControlNetModel.from_pretrained('${CONTROLNET_MODEL}', torch_dtype=torch.float16, cache_dir='/opt/hf-cache'); \
print('ControlNet cached') \
"

WORKDIR /app
COPY worker_security.py /app/worker_security.py
COPY main.py /app/main.py

EXPOSE 8080
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8080", "--workers", "1"]
