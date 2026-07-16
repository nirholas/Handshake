FROM nvidia/cuda:12.1.1-cudnn8-devel-ubuntu22.04

# devel (not runtime) base: TripoSG pulls diso (differentiable iso-surface
# extraction), which compiles a CUDA extension at install time and needs nvcc.
# TORCH_CUDA_ARCH_LIST targets the Cloud Run L4 (compute capability 8.9).
# PYTHONPATH carries both the package root (triposg.pipelines.*) and scripts/
# (image_process + briarmbg preprocessing helpers used by main.py).
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    DEBIAN_FRONTEND=noninteractive \
    TORCH_CUDA_ARCH_LIST="8.9+PTX" \
    PYTHONPATH=/opt/triposg:/opt/triposg/scripts

RUN apt-get update && apt-get install -y --no-install-recommends \
        python3.10 python3.10-dev python3-pip \
        git curl wget build-essential ninja-build \
        libgl1 libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/* \
    && ln -sf /usr/bin/python3.10 /usr/bin/python3 \
    && ln -sf /usr/bin/python3.10 /usr/bin/python \
    && pip install --upgrade pip setuptools wheel

# torch first (cached layer), matching the CUDA 12.1 base.
RUN pip install torch==2.3.1 torchvision==0.18.1 --index-url https://download.pytorch.org/whl/cu121

# TripoSG is not a pip package (no setup.py/pyproject) — clone it, install its
# own deps (incl. diso, which compiles here), and put it on PYTHONPATH.
# --no-build-isolation: diso's sdist build needs torch (already installed
# above) visible to detect CUDA capability; pip's default isolated build env
# hides it, failing with "ModuleNotFoundError: No module named 'torch'".
# Every other requirement here resolves to a prebuilt wheel (no build step),
# so this only changes behavior for the one package that needs it.
RUN git clone --depth 1 https://github.com/VAST-AI-Research/TripoSG.git /opt/triposg \
    && pip install --no-build-isolation -r /opt/triposg/requirements.txt

COPY requirements.txt /app/requirements.txt
RUN pip install -r /app/requirements.txt

WORKDIR /app
COPY worker_security.py /app/worker_security.py
COPY main.py /app/main.py

EXPOSE 8080

CMD ["uvicorn", "main:app", \
     "--host", "0.0.0.0", \
     "--port", "8080", \
     "--workers", "1", \
     "--timeout-keep-alive", "300"]
