# three.ws Forge Python client (canonical copy)

`three_ws_client.py` is the single source of truth for the Python wrapper around
the public Forge generation contract (`api/forge.js` + `api/forge-upload.js`).
It is stdlib-only (`urllib`), so it runs unmodified inside Blender's bundled
Python and inside ComfyUI without a `pip install` into either host.

The [Blender add-on](../blender/) and the [ComfyUI nodes](../comfyui/) each
vendor a byte-identical copy of this file. Edit the canonical copy here, then
re-copy it into both plugins; [test_no_drift.py](./test_no_drift.py) fails the
suite if any vendored copy diverges.

## Contract wrapped

| Call | Endpoint |
|---|---|
| Text to 3D | `POST /api/forge` with `{prompt, aspect_ratio?, path?, tier?, backend?}` |
| Image to 3D | `POST /api/forge` with `{image_urls[], prompt?, path?, tier?, backend?}` |
| Poll a job | `GET /api/forge?job=<id>` returning `{status, glb_url?, error?, backend?, ...}` |
| Tier/backend/cost matrix | `GET /api/forge?catalog` |
| Image upload presign | `POST /api/forge-upload` with `{content_type, size_bytes, checksum_sha256?}` |

Generation is auth-free (IP rate-limited, scoped to an anonymous client handle
sent as `x-forge-client`). The geometry path (Meshy/Tripo) is BYOK: pass
`provider_key` and it travels as the `x-forge-provider-key` header.

## Public API

- `ThreeWSClient(base_url="https://three.ws", *, provider_key=None, client_handle=None, timeout=30.0)`
  - `generate_text_to_3d(prompt, *, tier, backend, path, aspect_ratio, on_progress, should_cancel, poll_timeout) -> glb_url`
  - `generate_image_to_3d(image_bytes, content_type, *, prompt, tier, backend, path, ...) -> glb_url`
  - Lower-level steps: `submit_text_to_3d(...)`, `submit_image_to_3d(...)`, `upload_image(image_bytes, content_type) -> public_url`, `poll(job_id, ...) -> glb_url`, `download(url, dest_path)`, `get_catalog()`
- `ThreeWSError`: every failure path raises this with a user-safe `message`, a machine `code` (`needs_key`, `unconfigured`, `timeout`, `cancelled`, `failed`, ...), and the HTTP `status` when applicable.
- `content_type_for_path(path)`: maps `.png` / `.jpg` / `.jpeg` / `.webp` to the content type Forge accepts, or raises.
- Constants mirroring `api/_lib/forge-tiers.js`: `TIERS`, `PATHS`, `BACKENDS`, `ASPECT_RATIOS`.

## Example

```python
from three_ws_client import ThreeWSClient, ThreeWSError

client = ThreeWSClient()
try:
    glb_url = client.generate_text_to_3d(
        "a weathered bronze astrolabe",
        tier="standard",
        on_progress=lambda status, elapsed: print(f"{status} ({elapsed:.0f}s)"),
    )
    client.download(glb_url, "astrolabe.glb")
except ThreeWSError as exc:
    print(f"generation failed [{exc.code}]: {exc.message}")
```

## Tests

```bash
python -m pytest integrations/_pyclient
# or directly:
python integrations/_pyclient/test_three_ws_client.py
python integrations/_pyclient/test_no_drift.py
```

- [test_three_ws_client.py](./test_three_ws_client.py) runs a real in-process HTTP server that mimics the Forge contract (no live network) and exercises submit, upload, poll, download, and every error path end to end.
- [test_no_drift.py](./test_no_drift.py) byte-compares the vendored copies in `integrations/blender/three_ws/` and `integrations/comfyui/three_ws_nodes/` against this canonical file and prints the exact `cp` command to fix a drift.

## Editing workflow

1. Change `three_ws_client.py` here.
2. Copy it over both vendored paths:
   `cp integrations/_pyclient/three_ws_client.py integrations/blender/three_ws/three_ws_client.py`
   and
   `cp integrations/_pyclient/three_ws_client.py integrations/comfyui/three_ws_nodes/three_ws_client.py`
3. Run the tests above.
