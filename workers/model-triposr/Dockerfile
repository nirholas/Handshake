FROM nvidia/cuda:12.1.1-cudnn8-devel-ubuntu22.04

# devel (not runtime) base: TripoSR pulls torchmcubes, which compiles a CUDA
# extension at install time and needs nvcc. TORCH_CUDA_ARCH_LIST targets the
# Cloud Run L4 (compute capability 8.9) so the kernels build for it.
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    DEBIAN_FRONTEND=noninteractive \
    TORCH_CUDA_ARCH_LIST="8.9+PTX" \
    PYTHONPATH=/opt/triposr

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

# TripoSR is not a pip package (no setup.py/pyproject) — clone it, install its
# own deps (incl. torchmcubes, which compiles here), and put it on PYTHONPATH.
RUN git clone --depth 1 https://github.com/VAST-AI-Research/TripoSR.git /opt/triposr \
    && pip install -r /opt/triposr/requirements.txt

COPY requirements.txt /app/requirements.txt
RUN pip install -r /app/requirements.txt

# Bake rembg's matting model into the image. Left unprimed it downloads 176 MB
# from a third-party release URL during the FIRST request each cold instance
# serves: 19 s of measured latency plus an availability dependency inside a
# user job. U2NET_HOME is where rembg looks for it at runtime.
ENV U2NET_HOME=/opt/u2net
RUN python -c "from rembg import new_session; new_session('u2net')"

WORKDIR /app
COPY worker_security.py /app/worker_security.py
COPY image_prep.py /app/image_prep.py
COPY main.py /app/main.py
COPY test_image_prep.py /app/test_image_prep.py

# Build-time guard: the pre-inference path (decode, matte to 3-channel RGB,
# output naming) and the auth + SSRF guards must pass their unit suite or the
# image does not ship. A regression in the matte step fails every job at
# inference time, which is where it cost a day of production in 2026-07.
RUN python /app/test_image_prep.py

EXPOSE 8080

CMD ["uvicorn", "main:app", \
     "--host", "0.0.0.0", \
     "--port", "8080", \
     "--workers", "1", \
     "--timeout-keep-alive", "300"]
