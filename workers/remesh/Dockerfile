FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    QUADRIFLOW_BIN=/usr/local/bin/quadriflow

# ── Build QuadriFlow (MIT) from source ───────────────────────────────────────
# Field-aligned quad-dominant remesher. MIT-licensed (commercial-OK); invoked as
# a standalone CLI so its permissive transitive deps never link into our code.
RUN apt-get update && apt-get install -y --no-install-recommends \
        build-essential cmake git ca-certificates \
        libboost-dev libboost-program-options-dev libeigen3-dev \
    && rm -rf /var/lib/apt/lists/*

RUN git clone --depth 1 --recursive https://github.com/hjwdzh/QuadriFlow /tmp/quadriflow \
    && cmake -S /tmp/quadriflow -B /tmp/quadriflow/build -DCMAKE_BUILD_TYPE=Release \
    && cmake --build /tmp/quadriflow/build -j "$(nproc)" \
    && install -m 0755 /tmp/quadriflow/build/quadriflow /usr/local/bin/quadriflow \
    && rm -rf /tmp/quadriflow

# ── Runtime deps for trimesh / open3d / assimp / usd / Blender ───────────────
# The X11/GL libs are for the `bpy` (Blender) module, which links against them
# even when running headless for FBX export.
RUN apt-get update && apt-get install -y --no-install-recommends \
        libgl1 libglib2.0-0 libgomp1 \
        libassimp-dev libassimp5 \
        libopenblas-dev \
        libegl1 libxrender1 libxi6 libxxf86vm1 libxfixes3 libxkbcommon0 \
        libxrandr2 libxcursor1 libxinerama1 libsm6 libice6 libxext6 \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt /app/requirements.txt
RUN pip install -r /app/requirements.txt

WORKDIR /app
COPY worker_security.py /app/worker_security.py
COPY blender_fbx.py /app/blender_fbx.py
COPY verify_fbx.py /app/verify_fbx.py
COPY main.py /app/main.py

# Core-path gate: geometry, unwrap, bake, every export format, and the rigged
# GLB to FBX round trip run against synthetic fixtures at build time, so a
# regression fails the image instead of reaching Cloud Run. No network, no GCS.
COPY test_remesh.py /app/test_remesh.py
RUN API_KEY=build-gate GCS_BUCKET=build-gate python test_remesh.py

EXPOSE 8080
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8080", "--workers", "1"]
