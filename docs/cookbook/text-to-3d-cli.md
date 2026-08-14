# Text to 3D from the command line

**[Download `text_to_3d.py`](/cookbook/recipes/text_to_3d.py)** and run it:

```bash
python3 text_to_3d.py "a wooden treasure chest with iron bands"
```

```
prompt: a wooden treasure chest with iron bands
  glb:    https://pub-2534e921bf9c4314addcd4d8a6e98b7b.r2.dev/forge/.../176ed971.glb
  viewer: https://three.ws/viewer?src=...
  ar:     https://three.ws/api/ar?src=...  (open on a phone to place it in your room)
saved 1651 KB to a-wooden-treasure-chest-with-iron-bands.glb
```

![The treasure chest that command produced, rendered by the platform renderer](figure:img:/cookbook/posters/text-to-3d-cli.png)

That is the whole recipe. No API key, no account, no `pip install`. The file is
about 170 lines of standard-library Python, and roughly a third of it is there
to handle the two things that actually go wrong in production.

## What you get

A single file with three reusable pieces:

| Function | What it does |
|---|---|
| `generate(prompt)` | Submits the prompt, waits out the queue, returns the finished payload |
| `download(url, path)` | Streams a GLB to disk without loading it all into memory |
| `slugify(text)` | Turns a prompt into a safe filename |

Import it as a module and you have a text-to-3D client:

```python
from text_to_3d import generate, download

result = generate("a small ceramic teapot with a bamboo handle")
download(result["glbUrl"], "teapot.glb")
print(result["viewerUrl"])
```

## The two things that go wrong

### 1. The response has two shapes, not one

`POST /api/3d/generate` answers **inline** when the draft finishes quickly:

```jsonc
{ "status": "done", "glbUrl": "https://.../model.glb", "viewerUrl": "...", "arUrl": "..." }
```

and hands back a **job handle** when the shared GPU lane is busy:

```jsonc
{ "status": "pending", "job": "f1.eyJ...", "retryAfter": 8, "etaSeconds": 45 }
```

A client that only handles the first shape works perfectly in testing and breaks
the first time the lane is under load. The recipe folds both into one loop that
always ends at the same place:

```python
payload = _request(API, {"prompt": prompt, "format": "glb"})

while payload.get("status") == "pending":
    ...
    time.sleep(delay)
    payload = _request(f"{API}?job={job}&title={prompt}")
```

### 2. Polling faster than you were told

Every pending response carries `retryAfter` in seconds, and the endpoint sets
the standard `Retry-After` header alongside it. Ignore it and you trip the poll
flood guard, get a 429, and slow down the exact lane you are waiting on.

```python
def _poll_delay(payload):
    """Honor the server's retryAfter hint, clamped to a sane range."""
    hint = payload.get("retryAfter")
    try:
        seconds = float(hint)
    except (TypeError, ValueError):
        return MIN_POLL_SECONDS
    return max(MIN_POLL_SECONDS, min(MAX_POLL_SECONDS, seconds))
```

The clamp only ever fires when the hint is missing or absurd. Inside the 2 to 30
second window, the server's number wins. This is the polite-client pattern, and
it is the difference between a script that scales and one that gets rate limited.

## Errors you can act on

`urllib` raises `HTTPError` with the body still unread, so the useful part of a
failure is easy to lose. The recipe reads it and surfaces the API's own message:

```python
except urllib.error.HTTPError as exc:
    body = exc.read().decode(errors="replace")
    detail = json.loads(body).get("error_description")
    raise ForgeError(f"HTTP {exc.code} from {url}: {detail}")
```

So a rejected prompt tells you why:

```
generation failed: HTTP 400 from https://three.ws/api/3d/generate: prompt must be at least 3 characters
```

instead of the stack trace you would otherwise get.

## What the free tier actually is

The free lane is NVIDIA NIM TRELLIS. Be honest with yourself about what it
produces:

- **Single subject.** "a brass watering can" works. "a kitchen scene with a
  table, three chairs and a window" does not; you get a blob.
- **Draft fidelity.** Expect 20k to 150k triangles of reasonable silhouette with
  soft detail.
- **Often vertex-colored, with no material.** Color lives in a `COLOR_0`
  attribute rather than a PBR material. It renders in full color and ignores
  your lighting rig. The [asset quality gate](/cookbook/asset-quality-gate)
  recipe explains how to check for this.
- **No rigging.** Nothing to animate. Rigged, animation-ready characters are a
  paid tier.

Every response links to the paid tiers in an `upgrade` block if you need more.

## Timing

Measured on the live lane while writing this recipe: a single model took roughly
60 to 105 seconds end to end, including the download. Anything much longer means
the lane is queued, which is exactly when `retryAfter` starts mattering.

## Where to go next

- **Many prompts at once** → [Build a whole asset pack in parallel](/cookbook/parallel-asset-pack)
- **Give the tool to an AI assistant** → [Give your AI assistant a 3D tool](/cookbook/mcp-3d-tool)
- **Stop bad models reaching production** → [Gate 3D assets in CI](/cookbook/asset-quality-gate)
- **The full endpoint reference** → [3D API docs](/docs/3d-api)
