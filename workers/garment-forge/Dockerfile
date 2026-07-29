# garment-forge: CPU orchestrator, no GPU. Mesh generation and rigging run on
# the already-deployed GPU workers; this image only needs Python + geometry
# libraries + the reference body GLB.
FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

COPY requirements.txt /app/requirements.txt
RUN pip install --upgrade pip && pip install -r /app/requirements.txt

WORKDIR /app
COPY worker_security.py /app/worker_security.py
COPY canonical_bones.py /app/canonical_bones.py
COPY garment_glb.py     /app/garment_glb.py
COPY pipeline.py        /app/pipeline.py
COPY job_queue.py       /app/job_queue.py
COPY main.py            /app/main.py
COPY test_garment_glb.py /app/test_garment_glb.py
COPY test_job_queue.py  /app/test_job_queue.py
COPY test_reference_image.py /app/test_reference_image.py

# The canonical reference body (public/avatars/parametric-base.glb), staged
# into assets/ by cloudbuild.yaml so the repo does not carry a second copy.
COPY assets/ /app/assets/

# Build-time guard: the pure glTF pipeline (compose → extract → stats →
# validate) must pass its unit suite or the image does not ship.
RUN python /app/test_garment_glb.py

# Build-time guard: the durable job-queue policy (who may claim a job, and what
# happens to one whose instance was reclaimed) must pass its unit suite. A
# regression here silently drops submitted work.
RUN python /app/test_job_queue.py

# Build-time guard: the reference-image stage must re-roll a model response that
# returned 200 with no image rather than failing the job outright. Losing that
# re-roll throws away queued work on a single stochastic refusal.
RUN python /app/test_reference_image.py

EXPOSE 8080
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8080", "--workers", "1"]
