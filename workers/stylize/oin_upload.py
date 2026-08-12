"""OIN result storage for the stylize worker.

The OIN protocol (specs/OPEN_INFERENCE_PROTOCOL.md) signs a response that
commits to `output.url`, `output.sha256`, and `output.bytes`. The worker
already uploads results to GCS; this helper is the same sink with the raw
bytes returned to the caller so the OIN layer can hash them before signing.
"""

from __future__ import annotations

import logging
import os
from pathlib import Path
from typing import Optional

from google.cloud import storage
from google.cloud.storage.retry import DEFAULT_RETRY

log = logging.getLogger("oin-upload")


class OINResult:
    """What a worker hands the OIN layer: the artifact and where it landed."""

    def __init__(self, url: str, data: bytes, content_type: str):
        self.url = url
        self.data = data
        self.content_type = content_type


class ResultSink:
    """Uploads OIN job artifacts under an `oin/` prefix in the worker bucket."""

    def __init__(self, bucket: storage.Bucket):
        self._bucket = bucket

    def put(self, job_id: str, data: bytes, content_type: str) -> OINResult:
        blob_name = f"oin/{job_id}.glb"
        blob = self._bucket.blob(blob_name)
        # Same retry policy as the native path: a transient TLS failure must not
        # discard a finished job.
        blob.upload_from_string(data, content_type=content_type, retry=DEFAULT_RETRY, timeout=120)
        url = f"https://storage.googleapis.com/{self._bucket.name}/{blob_name}"
        return OINResult(url=url, data=data, content_type=content_type)


class LocalResultSink:
    """Filesystem sink for local/self-hosted runs with no GCS bucket.

    Writes artifacts under ``root`` and returns ``base_url/<name>`` so the
    signed output URL is fetchable by a verifier pointed at the same host.
    Enabled by setting ``OIN_RESULT_DIR`` + ``OIN_RESULT_BASE_URL``.
    """

    def __init__(self, root: str, base_url: str):
        self._root = Path(root)
        self._base_url = base_url.rstrip("/")
        (self._root / "oin").mkdir(parents=True, exist_ok=True)

    def put(self, job_id: str, data: bytes, content_type: str) -> OINResult:
        name = f"oin/{job_id}.glb"
        (self._root / name).write_bytes(data)
        return OINResult(url=f"{self._base_url}/{name}", data=data, content_type=content_type)


def make_result_sink(bucket: Optional[storage.Bucket]):
    """Pick the sink: local filesystem when OIN_RESULT_DIR is set, else GCS."""
    local_dir = os.environ.get("OIN_RESULT_DIR")
    if local_dir:
        base_url = os.environ.get("OIN_RESULT_BASE_URL")
        if not base_url:
            raise RuntimeError("OIN_RESULT_DIR requires OIN_RESULT_BASE_URL (where the dir is served)")
        log.info("oin result sink: local filesystem at %s (%s)", local_dir, base_url)
        return LocalResultSink(local_dir, base_url)
    if bucket is None:
        raise RuntimeError("no result sink: GCS bucket missing and OIN_RESULT_DIR unset")
    return ResultSink(bucket)
