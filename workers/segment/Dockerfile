# gltfpack (zeux/meshoptimizer, MIT) decodes EXT_meshopt_compression, which
# trimesh cannot read and which most three.ws avatars ship as. Pinned by release
# tag and checksum so the image never picks up a binary we did not audit.
FROM python:3.11-slim AS gltfpack
ARG GLTFPACK_VERSION=v1.2
ARG GLTFPACK_SHA256=ebc236f5f6c08c7e5c5750476a187d24805d44d8c680449c4b7369c333f817b1
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl unzip \
    && curl -fsSL -o /tmp/gltfpack.zip \
        https://github.com/zeux/meshoptimizer/releases/download/${GLTFPACK_VERSION}/gltfpack-ubuntu.zip \
    && echo "${GLTFPACK_SHA256}  /tmp/gltfpack.zip" | sha256sum -c - \
    && unzip -j /tmp/gltfpack.zip gltfpack -d /usr/local/bin \
    && chmod +x /usr/local/bin/gltfpack \
    && /usr/local/bin/gltfpack -v

FROM python:3.11-slim
COPY --from=gltfpack /usr/local/bin/gltfpack /usr/local/bin/gltfpack

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

RUN apt-get update && apt-get install -y --no-install-recommends \
        libgl1 libglib2.0-0 libgomp1 \
        libassimp-dev libassimp5 \
        libopenblas-dev \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt /app/requirements.txt
RUN pip install -r /app/requirements.txt

WORKDIR /app
COPY worker_security.py /app/worker_security.py
COPY gltf_meshopt.py /app/gltf_meshopt.py
COPY segment_core.py /app/segment_core.py
COPY main.py /app/main.py

# Build gate: the geometry engine is pure CPU and needs no credentials, so its
# tests run here. A merge pass that regresses to the pre-2026-08-11 cost, or a
# segmentation that stops being reproducible, fails the image instead of
# reaching production.
COPY test_segment_core.py /app/test_segment_core.py
COPY test_gltf_meshopt.py /app/test_gltf_meshopt.py
RUN python3 test_segment_core.py && python3 test_gltf_meshopt.py

EXPOSE 8080
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8080", "--workers", "1"]
