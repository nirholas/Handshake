"""
Effectful stages of the garment forge: every function here talks to a real
service: Vertex AI image generation, the deployed mesh-generation workers
(model-hunyuan3d-21-rtx → model-hunyuan3d-21 → model-trellis), the deployed
auto-rigger (model-rig), and Cloud Storage. The pure geometry/manifest logic
lives in garment_glb.py so it stays unit-testable without any of this.

Auth model: one shared bearer secret (the platform's avatar-reconstruction
key) authenticates this worker's own API and its calls to the other workers.
Vertex AI and GCS use the service account Cloud Run runs as (ADC).
"""

from __future__ import annotations

import base64
import io
import json
import logging
import os
import time
from urllib.parse import urlparse

import google.auth
import google.auth.transport.requests
import httpx
from google.api_core.exceptions import NotFound, PreconditionFailed
from google.cloud import storage
from PIL import Image

log = logging.getLogger("garment-forge.pipeline")

VERTEX_MODEL = os.environ.get("VERTEX_IMAGEN_MODEL", "gemini-2.5-flash-image")
VERTEX_LOCATION = os.environ.get("VERTEX_IMAGEN_LOCATION", "global")
VERTEX_IMAGE_SIZE = os.environ.get("VERTEX_IMAGE_SIZE", "2K").upper()
# How many times to ask the image model for a reference photo before giving up.
# Counts only the "answered 200, drew nothing" case; transport failures are
# already retried inside _post_with_retry.
_IMAGE_ATTEMPTS = max(1, int(os.environ.get("VERTEX_IMAGE_ATTEMPTS", "3")))

MESH_POLL_S = float(os.environ.get("MESH_POLL_S", "5"))
MESH_TIMEOUT_S = float(os.environ.get("MESH_TIMEOUT_S", "1200"))
RIG_TIMEOUT_S = float(os.environ.get("RIG_TIMEOUT_S", "600"))

_credentials = None


def _access_token() -> str:
    global _credentials
    if _credentials is None:
        _credentials, _ = google.auth.default(
            scopes=["https://www.googleapis.com/auth/cloud-platform"])
    if not _credentials.valid:
        _credentials.refresh(google.auth.transport.requests.Request())
    return _credentials.token


def _vertex_host(location: str) -> str:
    return ("https://aiplatform.googleapis.com" if location == "global"
            else f"https://{location}-aiplatform.googleapis.com")


# How each slot should be photographed so the generated mesh matches the
# reference body's A-pose and the slot box's fit axis. The ghost-mannequin
# framing gives the mesh generator a worn, volume-filled shape instead of a
# flat-lay it cannot infer depth from.
_SLOT_POSE_HINTS = {
    "top": "shown worn in three-dimensional filled-out shape as if on an invisible "
           "person standing upright in an A-pose, arms angled 45 degrees downward",
    "outerwear": "shown worn in three-dimensional filled-out shape as if on an "
                 "invisible person standing upright in an A-pose, arms angled 45 "
                 "degrees downward",
    "bottom": "shown worn in three-dimensional filled-out shape as if on invisible "
              "legs standing upright, legs straight and slightly apart",
    "footwear": "the pair side by side, both facing forward, soles on the ground",
    "hair": "shown in three-dimensional shape as if on an invisible head, facing forward",
    "headwear": "shown in three-dimensional shape as if worn on an invisible head, "
                "facing forward",
    "glasses": "shown front-on in three-dimensional shape as if worn on an invisible face",
    "accessory": "shown in three-dimensional worn shape, facing forward",
}


def _post_with_retry(client: httpx.Client, url: str, *, json_body: dict,
                     headers: dict, attempts: int = 3) -> httpx.Response:
    """POST with bounded backoff on transient failures (429/5xx/network).
    4xx other than 429 returns immediately: the caller handles semantics."""
    last_exc: Exception | None = None
    for attempt in range(attempts):
        try:
            res = client.post(url, json=json_body, headers=headers)
            if res.status_code == 429 or res.status_code >= 500:
                last_exc = RuntimeError(f"{url} returned {res.status_code}")
            else:
                return res
        except httpx.HTTPError as exc:
            last_exc = exc
        time.sleep(2.0 * (attempt + 1))
    raise RuntimeError(f"gave up after {attempts} attempts: {last_exc}")


def generate_reference_image(prompt: str, slot: str) -> tuple[bytes, str]:
    """Text prompt → ghost-mannequin product photo via the platform's live
    Vertex AI image lane. Returns (png/jpeg bytes, model label)."""
    pose = _SLOT_POSE_HINTS.get(slot, _SLOT_POSE_HINTS["accessory"])
    full_prompt = (
        f"Professional ghost mannequin product photograph of {prompt}, {pose}. "
        "Front view, centered, the entire item visible with a small margin, "
        "plain uniform light gray studio background, soft even lighting, "
        "no person, no mannequin, no props, no text, no watermark."
    )
    project = os.environ["GOOGLE_CLOUD_PROJECT"]
    endpoint = (
        f"{_vertex_host(VERTEX_LOCATION)}/v1/projects/{project}/locations/"
        f"{VERTEX_LOCATION}/publishers/google/models/{VERTEX_MODEL}:generateContent"
    )
    body = {
        "contents": [{"role": "user", "parts": [{"text": full_prompt}]}],
        "generationConfig": {
            "responseModalities": ["IMAGE"],
            "imageConfig": {"aspectRatio": "1:1", "imageSize": VERTEX_IMAGE_SIZE},
        },
    }
    headers = {"authorization": f"Bearer {_access_token()}",
               "content-type": "application/json"}

    def _attempt() -> tuple[bytes | None, str | None]:
        """One generation call. Returns (image_bytes, None) on success, or
        (None, finish_reason) when the model answered 200 with no image."""
        with httpx.Client(timeout=120) as client:
            res = _post_with_retry(client, endpoint, json_body=body, headers=headers)
            if res.status_code == 400:
                # Older image models reject the imageSize knob; retry without it.
                del body["generationConfig"]["imageConfig"]["imageSize"]
                res = _post_with_retry(client, endpoint, json_body=body, headers=headers)
            res.raise_for_status()
            data = res.json()
        candidate = (data.get("candidates") or [{}])[0]
        parts = candidate.get("content", {}).get("parts", [])
        img_part = next((p for p in parts if p.get("inlineData", {}).get("data")), None)
        if not img_part:
            return None, candidate.get("finishReason") or "no finishReason"
        return base64.b64decode(img_part["inlineData"]["data"]), None

    # A 200 carrying no image is a DIFFERENT failure from the transport errors
    # _post_with_retry covers: the request succeeded and the model simply
    # declined to draw this time (a safety/recitation filter, or an empty
    # candidate under load). Image generation is stochastic, so re-rolling the
    # same prompt usually succeeds — and without a re-roll one such response
    # permanently loses a job that has already been queued, paid for in GPU
    # time downstream, and counted against the batch.
    last_reason = None
    for attempt in range(_IMAGE_ATTEMPTS):
        image, last_reason = _attempt()
        if image is not None:
            if attempt:
                log.info("reference image took %d attempt(s) (prior: %s)", attempt + 1, last_reason)
            return image, f"vertex-ai/{VERTEX_MODEL}"
        if attempt + 1 >= _IMAGE_ATTEMPTS:
            break  # budget spent; fall through to the raise below
        log.warning("Vertex returned no image data (finishReason: %s); re-rolling "
                    "attempt %d/%d", last_reason, attempt + 2, _IMAGE_ATTEMPTS)
        time.sleep(1.5 * (attempt + 1))
    raise RuntimeError(f"Vertex returned no image data after {_IMAGE_ATTEMPTS} attempts "
                       f"(last finishReason: {last_reason})")


def _mesh_backend_label(url: str) -> str:
    host = urlparse(url).hostname or url
    if "trellis" in host:
        return "trellis"
    if "hunyuan3d" in host:
        return "hunyuan3d-2.1"
    return host


def _poll_task(client: httpx.Client, base_url: str, task_id: str, api_key: str,
               timeout_s: float, result_field: str) -> str:
    deadline = time.time() + timeout_s
    headers = {"authorization": f"Bearer {api_key}"}
    # A single flaky poll (worker restarting, LB hiccup, 502) must not kill a
    # multi-minute GPU job; only a persistent failure streak is a real outage.
    consecutive_errors = 0
    while time.time() < deadline:
        try:
            res = client.get(f"{base_url}/tasks/{task_id}", headers=headers)
            res.raise_for_status()
            task = res.json()
        except (httpx.HTTPError, ValueError) as exc:
            consecutive_errors += 1
            if consecutive_errors >= 6:
                raise RuntimeError(
                    f"lost contact with {base_url} while polling {task_id}: {exc}"
                ) from exc
            time.sleep(MESH_POLL_S)
            continue
        consecutive_errors = 0
        status = task.get("status")
        if status == "done":
            url = task.get(result_field)
            if not url:
                raise RuntimeError(f"task {task_id} done but no {result_field}")
            return url
        if status == "failed":
            raise RuntimeError(f"task {task_id} failed: {task.get('error')}")
        time.sleep(MESH_POLL_S)
    raise TimeoutError(f"task {task_id} on {base_url} exceeded {timeout_s:.0f}s")


def download_gcs_url(url: str) -> bytes:
    """Download an https://storage.googleapis.com/<bucket>/<name> object via
    the storage client, so worker-to-worker transfers never depend on public
    object ACLs."""
    parsed = urlparse(url)
    if parsed.hostname != "storage.googleapis.com":
        raise ValueError(f"not a GCS URL: {url}")
    bucket_name, _, blob_name = parsed.path.lstrip("/").partition("/")
    return storage.Client().bucket(bucket_name).blob(blob_name).download_as_bytes()


def generate_mesh(image_bytes: bytes, mesh_urls: list[str], api_key: str,
                  tier: str = "high") -> tuple[bytes, str]:
    """Image → textured GLB through the deployed mesh-generation failover
    chain. Every backend speaks the same /infer + /tasks contract."""
    data_uri = "data:image/png;base64," + base64.b64encode(image_bytes).decode()
    errors: list[str] = []
    with httpx.Client(timeout=60) as client:
        for url in mesh_urls:
            label = _mesh_backend_label(url)
            try:
                res = client.post(
                    f"{url}/infer",
                    json={"images": [data_uri], "tier": tier},
                    headers={"authorization": f"Bearer {api_key}"},
                )
                res.raise_for_status()
                task_id = res.json()["task_id"]
                log.info("mesh task %s queued on %s", task_id, label)
                result_url = _poll_task(client, url, task_id, api_key,
                                        MESH_TIMEOUT_S, "result_gcs_url")
                return download_gcs_url(result_url), label
            except Exception as exc:  # noqa: BLE001: try the next rung
                log.warning("mesh backend %s failed: %s", label, exc)
                errors.append(f"{label}: {exc}")
    raise RuntimeError("every mesh backend failed: " + " | ".join(errors))


def rig_composite(composite_bytes: bytes, rig_url: str, api_key: str,
                  bucket: storage.Bucket, job_id: str) -> bytes:
    """Composite GLB → rigged GLB via the deployed model-rig worker. The
    composite is staged to GCS because /rig takes a URL, not bytes."""
    blob = bucket.blob(f"garments/tmp/{job_id}-composite.glb")
    blob.upload_from_string(composite_bytes, content_type="model/gltf-binary")
    composite_url = f"https://storage.googleapis.com/{bucket.name}/{blob.name}"

    with httpx.Client(timeout=60) as client:
        res = client.post(
            f"{rig_url}/rig",
            json={"mesh_gcs_url": composite_url, "blendshapes": False},
            headers={"authorization": f"Bearer {api_key}"},
        )
        res.raise_for_status()
        task_id = res.json()["task_id"]
        log.info("rig task %s queued", task_id)
        result_url = _poll_task(client, rig_url, task_id, api_key,
                                RIG_TIMEOUT_S, "rigged_gcs_url")
    rigged = download_gcs_url(result_url)
    blob.delete()
    return rigged


def make_thumbnail(image_bytes: bytes, size: int = 512) -> bytes:
    """Reference image → square WEBP thumbnail for the catalog card."""
    img = Image.open(io.BytesIO(image_bytes)).convert("RGB")
    img.thumbnail((size, size), Image.LANCZOS)
    out = io.BytesIO()
    img.save(out, format="WEBP", quality=88)
    return out.getvalue()


def _try_make_public(blob: storage.Blob) -> None:
    """Garment assets must be CORS/anonymously readable by the viewer. On a
    fine-grained-ACL bucket this sets the object ACL; if the bucket enforces
    uniform access this is a no-op handled at the bucket IAM level instead."""
    try:
        blob.make_public()
    except Exception as exc:  # noqa: BLE001: bucket-level policy takes over
        log.warning("make_public failed for %s (bucket-level policy governs): %s",
                    blob.name, exc)


def publish(bucket: storage.Bucket, slot: str, garment_id: str, version: int,
            glb_bytes: bytes, manifest: dict, thumb_bytes: bytes) -> dict:
    """Write the immutable v<n> directory and append to the catalog."""
    prefix = f"garments/{slot}/{garment_id}/v{version}"
    uploads = [
        (f"{prefix}/garment.glb", glb_bytes, "model/gltf-binary"),
        (f"{prefix}/manifest.json", json.dumps(manifest, indent=2).encode(),
         "application/json"),
        (f"{prefix}/thumb.webp", thumb_bytes, "image/webp"),
    ]
    for name, data, ctype in uploads:
        blob = bucket.blob(name)
        blob.cache_control = "public, max-age=31536000, immutable"
        blob.upload_from_string(data, content_type=ctype)
        _try_make_public(blob)

    append_to_catalog(bucket, manifest)
    base = f"https://storage.googleapis.com/{bucket.name}/{prefix}"
    return {
        "glb_url": f"{base}/garment.glb",
        "manifest_url": f"{base}/manifest.json",
        "thumb_url": f"{base}/thumb.webp",
    }


def append_to_catalog(bucket: storage.Bucket, manifest: dict,
                      attempts: int = 6) -> None:
    """Append one manifest to garments/catalog.json with an optimistic
    generation-match loop, so concurrent publishes never lose entries."""
    blob_name = "garments/catalog.json"
    for attempt in range(attempts):
        blob = bucket.blob(blob_name)
        try:
            blob.reload()
            generation = blob.generation
            catalog = json.loads(blob.download_as_bytes())
            if not isinstance(catalog, list):
                raise RuntimeError("garments/catalog.json is not a JSON array")
        except NotFound:
            generation = 0
            catalog = []
        catalog.append(manifest)
        blob.cache_control = "public, max-age=60"
        try:
            blob.upload_from_string(
                json.dumps(catalog, indent=2), content_type="application/json",
                if_generation_match=generation,
            )
            _try_make_public(blob)
            return
        except PreconditionFailed:
            log.info("catalog append raced (attempt %d), retrying", attempt + 1)
            time.sleep(0.5 * (attempt + 1))
    raise RuntimeError(f"catalog append lost {attempts} generation races")


def next_version(bucket: storage.Bucket, slot: str, garment_id: str) -> int:
    """1 + highest published version of slot/id in the catalog (spec: publish
    a change as v<n+1>, never overwrite v<n>)."""
    try:
        catalog = json.loads(bucket.blob("garments/catalog.json").download_as_bytes())
    except NotFound:
        return 1
    versions = [int(m.get("version", 0)) for m in catalog
                if m.get("slot") == slot and m.get("id") == garment_id]
    return max(versions, default=0) + 1
