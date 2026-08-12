FROM python:3.11-slim

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
# oin.py is the shared OIN protocol layer (specs/OPEN_INFERENCE_PROTOCOL.md),
# vendored into this directory exactly like worker_security.py: the build
# context is workers/stylize, so ../ is unreachable. Keep the copy byte-identical.
COPY worker_security.py /app/worker_security.py
COPY oin.py /app/oin.py
COPY oin_upload.py /app/oin_upload.py
COPY main.py /app/main.py
COPY test_stylize.py /app/test_stylize.py

# Build-time guard: the four filters, the color sampler, the export round-trip,
# the memory caps, the SSRF gate, and the upload retry policy must pass their
# unit suite or the image does not ship. This is also the only place open3d's
# decimation path (used by voronoi + lowpoly) is exercised; the local run falls
# back to trimesh.
RUN python /app/test_stylize.py

EXPOSE 8080
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8080", "--workers", "1"]
