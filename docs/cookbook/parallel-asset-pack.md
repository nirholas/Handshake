# Build a whole asset pack in parallel

One model is a demo. A game level, a product catalog, or a scene needs twenty,
and generating them one at a time means waiting half an hour for something that
should take three minutes.

**[Download `asset_pack.py`](/cookbook/recipes/asset_pack.py)** (it imports
[`text_to_3d.py`](/cookbook/recipes/text_to_3d.py), so keep both in the same
folder) and run:

```bash
python3 asset_pack.py "a clay flower pot with a saucer" "a woven wicker basket" "a brass watering can" --out ./garden-pack
```

```
building 3 models with 3 workers into garden-pack/
  [ok  ] a clay flower pot with a saucer                         82s
  [ok  ] a woven wicker basket                                   85s
  [ok  ] a brass watering can                                   101s

3/3 built in 101s
open garden-pack/index.html
```

101 seconds for three models, not 268. The slowest job sets the wall clock.

![A clay flower pot, one of the three models this run built in parallel](figure:img:/cookbook/posters/parallel-asset-pack.png)

## What it writes

```
garden-pack/
  manifest.json          every prompt, its GLB URL, local paths, timings
  index.html             an interactive gallery (orbit, zoom, AR on phones)
  models/<slug>.glb      the downloaded models
  stills/<slug>.png      a 1024px render of each model
```

`manifest.json` is the part you build on. It records what succeeded, what failed
and why, and how long each took, so a later step can retry only the failures:

```jsonc
{
  "generator": "three.ws cookbook / parallel-asset-pack",
  "tier": "free draft",
  "seconds": 101.4,
  "assets": [
    {
      "prompt": "a woven wicker basket",
      "slug": "a-woven-wicker-basket",
      "ok": true,
      "glb_url": "https://.../cf3af68b.glb",
      "glb_path": "models/a-woven-wicker-basket.glb",
      "still_path": "stills/a-woven-wicker-basket.png",
      "seconds": 85.1,
      "warnings": []
    }
  ]
}
```

Feed prompts from a file when there are more than a handful:

```bash
python3 asset_pack.py --prompts-file props.txt --out ./level-01 --workers 3
```

Blank lines and `#` comments in the file are skipped, so it doubles as a
readable asset list you can keep in version control.

## Three decisions worth copying

### Concurrency is deliberately low

```python
DEFAULT_WORKERS = 3
```

The free lane is a shared GPU pool. Twenty concurrent submissions do not finish
sooner; they queue behind each other while every one of them burns poll requests
against the flood guard. Two or three is the sweet spot. Raise it only after you
have measured that the lane keeps up.

### A failed still is a warning, a failed generation is a failure

```python
try:
    render_still(asset.glb_url, still_path)
    asset.still_path = str(still_path.relative_to(out))
except (ForgeError, urllib.error.URLError, OSError) as exc:
    asset.warnings.append(f"still render skipped: {exc}")

asset.ok = True
```

The still is a convenience. If the renderer is briefly unavailable, the model is
still perfectly good, and failing the whole asset over a missing thumbnail would
be the pipeline sabotaging itself. Generation failing is different: there is no
asset, so the entry is marked failed and carries its error into the manifest.

This is the same principle the [self-correcting 3D notebook](/cookbook/self-correcting-3d)
applies to its vision critic: a guardrail that can take down the pipeline it
guards is worse than no guardrail.

### Results keep their input order

`as_completed` yields futures in finish order, which is not submission order.
Writing results into a pre-sized list by index keeps the manifest and the gallery
in the order you asked for:

```python
assets = [None] * len(prompts)
futures = {pool.submit(build_one, prompt, out, slug): i for i, (...) in enumerate(...)}
for future in concurrent.futures.as_completed(futures):
    assets[futures[future]] = future.result()
```

Small detail, but a pack whose order shuffles on every run is miserable to diff.

## The gallery

`index.html` is written from a template in the script. It uses
`<model-viewer>` from a CDN for orbit, zoom, and AR on phones, and it degrades
honestly: failed prompts render as dashed cards carrying their error text, so a
partial pack looks partial instead of looking complete.

Filenames are deduplicated before anything is written:

```python
def unique_slugs(prompts):
    """Stable, collision-free filenames even when two prompts slugify alike."""
```

Two prompts that slugify to the same string would otherwise silently overwrite
each other's GLB, and you would ship a pack with a duplicate model in it.

## Gate the output

A pack is exactly the point where you want a budget check before anything ships:

```bash
python3 asset_gate.py garden-pack/models/*.glb --max-triangles 100000
```

See [Gate 3D assets in CI](/cookbook/asset-quality-gate).

## Run it without installing anything

The [Pipeline Studio](/cookbook/pipeline) is this recipe plus the gate above,
running in a browser tab against the same free API. It fans prompts out at the
same concurrency, renders every result, grades each one, and then prints the
`asset_pack.py` and `asset_gate.py` commands that reproduce the run on your
machine. Useful for picking a triangle budget before you commit to one.

![The Studio mid-run: finished models already graded while the last one is still generating](figure:img:/cookbook/media/pipeline-studio-midrun.png)

## Where to go next

- **The single-model client this builds on** → [Text to 3D from the command line](/cookbook/text-to-3d-cli)
- **The same pipeline, no install** → [Pipeline Studio](/cookbook/pipeline)
- **Let a model choose the prompts** → [A self-correcting 3D collectible set](/cookbook/self-correcting-3d)
- **The full endpoint reference** → [3D API docs](/docs/3d-api)
