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
COPY worker_security.py /app/worker_security.py
COPY segment_core.py /app/segment_core.py
COPY main.py /app/main.py

# Build gate: the geometry engine is pure CPU and needs no credentials, so its
# tests run here. A merge pass that regresses to the pre-2026-08-11 cost, or a
# segmentation that stops being reproducible, fails the image instead of
# reaching production.
COPY test_segment_core.py /app/test_segment_core.py
RUN python3 test_segment_core.py

EXPOSE 8080
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8080", "--workers", "1"]
