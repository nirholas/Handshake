FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

RUN apt-get update && apt-get install -y --no-install-recommends \
        ffmpeg libgl1 libglib2.0-0 curl \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt /app/requirements.txt
RUN pip install -r /app/requirements.txt

# MediaPipe model bundles (Apache-2.0), baked into the image so the service
# has no weights-bucket dependency and cold-starts ready.
RUN mkdir -p /models \
    && curl -fsSL -o /models/pose_landmarker_heavy.task \
        https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_heavy/float16/latest/pose_landmarker_heavy.task \
    && curl -fsSL -o /models/hand_landmarker.task \
        https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/latest/hand_landmarker.task \
    && curl -fsSL -o /models/selfie_multiclass_256x256.tflite \
        https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_multiclass_256x256/float32/latest/selfie_multiclass_256x256.tflite

WORKDIR /app
COPY worker_security.py /app/worker_security.py
COPY canonical_rest.py /app/canonical_rest.py
COPY pose_solver.py /app/pose_solver.py
COPY main.py /app/main.py

EXPOSE 8080
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8080", "--workers", "1"]
