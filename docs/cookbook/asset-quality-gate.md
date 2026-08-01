# Gate 3D assets in CI

Generated geometry fails quietly. A model downloads fine, validates against the
glTF spec perfectly, and is still a 400k-triangle monster that drops a phone to
8fps. Nothing in the pipeline complains, because nothing in the pipeline was
asked to.

**[Download `asset_gate.py`](/cookbook/recipes/asset_gate.py)** and point it at
anything:

```bash
python3 asset_gate.py model.glb                       # a local file
python3 asset_gate.py https://example.com/model.glb   # or a URL
python3 asset_gate.py assets/*.glb --max-triangles 50000
```

```
PASS  176ed971-0be5-4fc6-b2ff-3370aa499e13.glb       19,074 tris     1.6 MB   1 mat   1 tex

1/1 assets passed the budget
```

![The wicker basket this gate rejected at 147,617 triangles, which looks perfectly fine](figure:img:/cookbook/posters/asset-quality-gate.png)

Exit codes are the whole point: **0** everything passed, **1** at least one asset
busted its budget, **2** the gate itself could not run. Wire it into CI and a bad
asset fails the build instead of the launch.

## What it checks

| Check | Default | Flag |
|---|---|---|
| Valid glTF/GLB container | required | |
| Khronos validator errors | zero | |
| Triangle ceiling | 100,000 | `--max-triangles` |
| Triangle floor (collapsed generation) | 100 | `--min-triangles` |
| File size | 8 MB | `--max-size-mb` |
| Material count | 16 | `--max-materials` |
| Has materials | advisory | `--require-materials` |
| Has textures | advisory | `--require-textures` |

The floor matters more than it looks. When generation partially collapses you
get a valid GLB containing almost nothing, which passes every other check on the
list. A minimum triangle count is the cheapest way to catch it.

## The bug this recipe had, and why it is in the docs

The first version of this gate failed any model with zero materials, on the
reasoning that a model with no material renders untextured. Run against three
freshly generated models, it failed all three:

```
FAIL  a-brass-watering-can.glb    46,348 tris   0.6 MB   0 mat   0 tex
      fail: no materials: the model would render untextured
```

Except the renders were in full color. The models were **vertex-colored**: color
lives in a `COLOR_0` mesh attribute rather than a PBR material, which the free
draft lane produces routinely. The gate was not catching a bad asset, it was
inventing one, and a gate that cries wolf gets switched off within a week.

The fix is to say what is true and let the caller decide:

```python
if materials == 0:
    if budget["require_materials"]:
        report.failures.append("no materials, and --require-materials was set")
    else:
        report.advisories.append(
            "no materials: likely vertex-colored geometry, which renders in color "
            "but ignores your lighting setup. Pass --require-materials to fail on it."
        )
```

If your scene has a carefully built lighting rig, vertex colors ignoring it may
genuinely be a defect, so `--require-materials` is there. It is just not the
default, because for most uses it is not a defect at all.

## Failures versus advisories

The distinction runs through the whole script. A **failure** blocks the build. An
**advisory** prints and is recorded in the JSON report, but exits zero:

```
PASS  a-woven-wicker-basket.glb   147,617 tris   2.8 MB   0 mat   0 tex
      note: no materials: likely vertex-colored geometry ...
```

Validator warnings and the inspect API's own optimization recommendations land
in the same bucket. They are worth reading and they are not worth blocking on.

## In a CI job

```yaml
- name: Gate 3D assets
  run: |
    python3 asset_gate.py assets/**/*.glb \
      --max-triangles 80000 \
      --max-size-mb 5 \
      --json asset-report.json
```

When it fails and `GITHUB_STEP_SUMMARY` is set, the gate writes a readable
summary of exactly which assets busted which limits, so the failure is legible
from the run page without opening logs:

```python
if failed and os.environ.get("GITHUB_STEP_SUMMARY"):
    with open(os.environ["GITHUB_STEP_SUMMARY"], "a", encoding="utf-8") as summary:
        summary.write(f"### 3D asset gate: {len(failed)} failed\n")
```

`--json` writes the full report including the budget it was judged against,
which is the artifact you want when someone asks why a model that passed last
month fails today.

## Local files and URLs take different paths

A URL is inspected by reference, so nothing is uploaded:

```
GET /api/3d/inspect?url=https://example.com/model.glb
```

A local file is sent as raw bytes in the request body. The endpoint treats any
non-JSON POST body as the model itself, so there is no multipart envelope:

```python
content_type = "model/gltf+json" if filename.endswith(".gltf") else "model/gltf-binary"
req = urllib.request.Request(url, data=payload, headers={"content-type": content_type})
```

Both paths return byte-identical statistics for the same model, which is worth
knowing: you can gate a URL in staging and the same file locally in CI and trust
the numbers to match.

## What the inspect API gives you

Beyond the counts the gate reads, every response carries prioritized
recommendations with a concrete fix:

```jsonc
{
  "severity": "info",
  "issue": "Apply Draco compression to geometry for ~60-80% smaller vertex buffers. (~869 KB potential savings)",
  "fix": "Apply KHR_draco_mesh_compression to the geometry buffers."
}
```

Those are advisories here, but they are a good backlog for whatever ships the
assets.

## Where to go next

- **Generate the assets this gates** → [Build a whole asset pack in parallel](/cookbook/parallel-asset-pack)
- **Gate with a vision model instead of numbers** → [A self-correcting 3D collectible set](/cookbook/self-correcting-3d)
- **The full endpoint reference** → [3D API docs](/docs/3d-api)
