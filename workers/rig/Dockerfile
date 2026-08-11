FROM nvidia/cuda:12.1.1-runtime-ubuntu22.04

# runtime (not devel) base: every heavy dependency (torch, torch-cluster,
# pytorch3d) installs from prebuilt cu121 wheels, so no nvcc is needed.
# Python 3.11 is a hard requirement of the bpy==4.3.0 wheel MIA imports while
# building its Mixamo kinematic tree.
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    DEBIAN_FRONTEND=noninteractive \
    MPLBACKEND=Agg \
    GRADIO_ANALYTICS_ENABLED=False \
    HF_HUB_DISABLE_TELEMETRY=1 \
    DO_NOT_TRACK=1

RUN apt-get update && apt-get install -y --no-install-recommends \
        python3.11 python3.11-dev python3.11-venv python3-pip \
        git curl \
        libgl1 libglib2.0-0 libsm6 libxext6 libxrender1 \
        libxi6 libxxf86vm1 libxfixes3 libxkbcommon0 \
    && rm -rf /var/lib/apt/lists/* \
    && ln -sf /usr/bin/python3.11 /usr/bin/python3 \
    && ln -sf /usr/bin/python3.11 /usr/bin/python \
    && python3 -m pip install --upgrade pip setuptools wheel

# torch first, as its own cached layer: the cu121 wheels are multi-GB and
# some downstream packages import torch during their own install.
RUN pip install torch==2.1.2 torchvision==0.16.2 \
    --index-url https://download.pytorch.org/whl/cu121

COPY requirements.txt /app/requirements.txt
RUN pip install -r /app/requirements.txt

# Make-It-Animatable (MIT), pinned. Vendored as source because upstream has no
# package layout; engine_mia.py imports its app module directly. The empty
# util/auto_rig_pro directory only matters for the animation-baking path we
# never call.
ARG MIA_COMMIT=d60cc7e01ff8da46448e458dbf450e8967b34e77
RUN git clone https://github.com/jasongzy/Make-It-Animatable.git /app/mia \
    && git -C /app/mia checkout ${MIA_COMMIT} \
    && rm -rf /app/mia/.git

WORKDIR /app
COPY worker_security.py rig_glb.py blendshapes.py engine_mia.py main.py entrypoint.sh /app/
COPY test_rig_glb.py test_blendshapes.py test_pipeline.py /app/
RUN chmod +x /app/entrypoint.sh

# Build-time guards, the same pattern workers/garment-forge uses. These three
# suites need no GPU and no weights, so they run here in seconds and the image
# does not ship if the rig contract broke: skin authoring (skeleton, unit-sum
# weights, morph targets), ARKit transfer (head mask, alignment, falloff), and
# the composed core path (the 52 Mixamo bone names the platform canonicalizer
# keys on, ARKit-52 targetNames on the head only, textures byte-preserved).
RUN python3 /app/test_rig_glb.py \
    && python3 /app/test_blendshapes.py \
    && python3 /app/test_pipeline.py

# Weights, Mixamo bone templates, and the baked ARKit template are staged in
# GCS (stage-assets.sh) and mounted at /weights by Cloud Run; entrypoint.sh
# links them into the MIA tree before serving.

EXPOSE 8080

CMD ["/app/entrypoint.sh"]
