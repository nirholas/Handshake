# three.ws integrations

First-party plugins that drive the public **three.ws Forge** generation pipeline
(`/api/forge`) from inside the tools artists already use — so a model can be
generated without leaving the DCC.

| Plugin | Folder | Host |
|---|---|---|
| Blender add-on | [`blender/three_ws/`](blender/three_ws/) | Blender 4.0+ |
| ComfyUI nodes | [`comfyui/three_ws_nodes/`](comfyui/three_ws_nodes/) | ComfyUI |

Driving Blender from an **agent** rather than by hand is a different job, and it
has its own package: [`packages/blender-mcp/`](../packages/blender-mcp) is an MCP
server that runs Blender headlessly (no GUI, no add-on) so an assistant can
inspect, convert, render, and script 3D files, and pull a Forge generation
straight into a scene. The add-on below is the artist-facing surface; the two
install side by side.

Both speak to the same auth-free endpoints:

- `POST /api/forge` — text→3D and image→3D
- `GET /api/forge?job=<id>` — poll
- `GET /api/forge?catalog` — tier/backend matrix
- `POST /api/forge-upload` — presigned image upload (image→3D)

The **image pipeline** (FLUX→TRELLIS) is free and platform-keyed. The
**geometry pipeline** (Meshy/Tripo) is BYOK — supply your own provider key in
the add-on preferences / node input and it travels as `x-forge-provider-key`.

## Single source of truth

The Forge contract lives in exactly one file:
[`_pyclient/three_ws_client.py`](_pyclient/three_ws_client.py) — stdlib-only
(`urllib`), so it runs unmodified in Blender's bundled Python and in ComfyUI with
no `pip install`. Each plugin ships a **byte-identical vendored copy** so it stays
self-contained and distributable (a Blender zip / a ComfyUI clone).

`_pyclient/test_no_drift.py` fails CI if a copy drifts. To update the client,
edit the canonical file and re-copy:

```bash
cp integrations/_pyclient/three_ws_client.py integrations/blender/three_ws/three_ws_client.py
cp integrations/_pyclient/three_ws_client.py integrations/comfyui/three_ws_nodes/three_ws_client.py
```

## Tests

No live network — every test runs an in-process stub of the Forge contract.

```bash
# shared client + drift guard
python -m unittest discover -s integrations/_pyclient -p 'test_*.py'

# comfyui nodes
( cd integrations/comfyui/three_ws_nodes && python -m unittest test_nodes )
```

The Blender add-on is import-guarded on `bpy` (only present inside Blender); its
syntax is validated in CI via `ast.parse`.
