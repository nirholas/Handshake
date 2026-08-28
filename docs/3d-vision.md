# 3D Vision: let an agent see the model

Every text-to-3D API, this platform's included, has always answered with a URL to a binary file. A human clicks it. **An agent cannot.** A `.glb` is opaque to a language model, so the agent that just spent GPU time generating an asset has no way to tell a clean mesh from a melted one. It hands the link to a human and hopes.

That blindness is the reason agentic 3D stalls at one shot. There is no feedback signal to iterate on.

This surface closes the loop. Give it a model, get back **frames a vision-capable model can actually look at**, plus the geometry facts and a plain reading of them. Generate, look, judge, fix.

Free and keyless, like the rest of [the 3D API](./3d-api.md).

---

## Three ways in

| You are | Use | You get |
| --- | --- | --- |
| An MCP client (Claude, any MCP host) | tool `look_at_model` on `/api/mcp-studio` | Frames as **MCP image content blocks**, rendered into the conversation |
| A Node program | [`@three-ws/see`](../packages/see/README.md) | `see(url)` → views, stats, notes |
| Anything that speaks HTTP | `POST /api/3d/look` | JSON with a frame URL per angle |

---

## MCP: the model sees the model

This is the one that matters. MCP content blocks can carry images, so a multimodal client renders the frames straight into the conversation. The agent is not told about its model; it **looks** at it.

```json
{
  "jsonrpc": "2.0", "id": 1, "method": "tools/call",
  "params": {
    "name": "look_at_model",
    "arguments": { "glb_url": "https://example.com/robot.glb" }
  }
}
```

The reply opens with a text block naming what was rendered and what to judge, then one labelled text block and one `image` block per angle. A client that supports images shows them; the model forms an opinion and can immediately regenerate naming the specific fault it saw.

Works on **any** public https `.glb`, not only models generated here.

## REST

```bash
curl -sS -X POST https://three.ws/api/3d/look \
  -H 'content-type: application/json' \
  -d '{"glb_url":"https://example.com/robot.glb"}'
```

```json
{
  "model_url": "https://example.com/robot.glb",
  "size": 512,
  "views": [
    { "view": "three-quarter", "theta": 35, "phi": 78, "image_url": "https://…/a.png" },
    { "view": "front", "theta": 0, "phi": 80, "image_url": "https://…/b.png" },
    { "view": "side", "theta": 90, "phi": 80, "image_url": "https://…/c.png" },
    { "view": "back", "theta": 180, "phi": 80, "image_url": "https://…/d.png" }
  ],
  "stats": { "vertices": 8231, "triangles": 12400, "materials": 2, "textures": 1, "animations": 0 },
  "notes": ["12,400 triangles, a normal real-time budget for a hero prop or character."],
  "viewer_url": "https://three.ws/viewer?src=…",
  "ar_url": "https://three.ws/api/ar?src=…"
}
```

`GET /api/3d/look` returns a discovery doc: every angle, the limits, and a runnable example.

## SDK

```bash
npm install @three-ws/see
```

```js
import { see, toMessageContent } from '@three-ws/see';

const look = await see('https://example.com/robot.glb');
const content = await toMessageContent(look);   // multimodal chat blocks, ready to send
```

Full API, including the generate → look → critique loop against the Claude API: [`packages/see/README.md`](../packages/see/README.md).

---

## The angles, and why these ones

| View | Camera | What it catches |
| --- | --- | --- |
| `three-quarter` | theta 35, phi 78 | Form and depth, the way a product shot reads. Rendered first because it is the single most informative frame. |
| `front` | theta 0, phi 80 | Facing, symmetry, the subject's identity |
| `side` | theta 90, phi 80 | Profile, depth collapse, flattened geometry |
| `back` | theta 180, phi 80 | The half a single-view generator most often leaves unfinished |
| `top` | theta 0, phi 25 | Footprint, layout, whether it is hollow |
| `bottom` | theta 0, phi 155 | Missing caps, inverted normals, floating geometry |

The default set is `three-quarter, front, side, back`: the smallest number of frames that answers "is this model good". More frames cost render seconds and agent context for very little extra signal, which is why the cap is six.

Every frame uses the `full-body` scene preset, which fits the whole bounding box. The humanoid presets crop to a torso or head and would silently cut a prop, a vehicle or a creature in half.

## What it is honest about

- **A partial turntable is not a failure.** If one angle fails to render you get the frames that worked plus `missing_views` naming what did not. Three good views beat an error.
- **Stats are best-effort.** They come from [`/api/3d/inspect`](./3d-api.md), so "what this model is" has exactly one implementation. An inspector hiccup costs you the numbers, never the frames, because the frames are the part you could not get any other way.
- **Unknown angle names are ignored, not rejected.** An agent guessing `"left"` still gets a useful turntable.
- **Nothing is invented.** The geometry reading is derived from measured stats; it never guesses at quality it cannot measure. Judging whether the model is *good* is the vision model's job, which is the entire point.

## Limits

| Limit | Value | Why |
| --- | --- | --- |
| Views per call | 6 | Each frame is seconds of headless render |
| Frame size | 128 to 1024 px | 512 is enough for a model to judge form |
| Rate | shared render bucket, 60 per 10 min per IP | Rendering holds a CPU for seconds; this is a real cost ceiling |
| Model URL | public `https://` only | SSRF-guarded before anything is fetched |

Frames render **sequentially**. The renderer drives one shared headless browser; firing four pages at it in parallel turns a 4-second turntable into an out-of-memory kill under any real concurrency.

## Related

- [Free 3D API](./3d-api.md): generate and inspect
- [MCP servers](./mcp.md): every tool on `/api/mcp-studio`
- [OKX.AI marketplace](./okx-marketplace.md): paid 3D for agents that buy it
