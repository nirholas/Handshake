---
name: create-3d-avatar
description: Turn a text prompt (or reference image) into a rigged, animation-ready 3D avatar (GLB). Use when you or the user want to create, generate, or make a 3D avatar, character, or humanoid figure that can be posed and animated — "make a 3D avatar of a knight", "generate a character I can animate", "create a rigged astronaut". Generates the mesh and adds a humanoid skeleton in one step. Returns a GLB URL plus a pose-studio link.
when_to_use: User wants a posable/animatable humanoid character. For a static object or prop, use generate-3d-model. To rig a GLB you already have, use rig-a-model.
license: MIT
metadata:
  category: 3d/creative
  cross-platform-safe: true
  pack: three-ws-skills
---

# Create a rigged 3D avatar

Turn a text prompt or a reference image into a **rigged, animation-ready** humanoid
avatar (GLB). One call generates the textured mesh, then auto-rigs it — adding a
humanoid skeleton and skin weights — so the model can be posed and play animation
clips immediately.

The result is a **`glbUrl`** for the rigged model plus a **pose-studio link** that
opens the avatar ready to pose in the browser.

## When to use which tool

| Goal | Use |
| --- | --- |
| A posable humanoid **character** from text/image | this skill |
| A static object / prop / creature | `generate-3d-model` |
| Add a skeleton to a GLB you already generated | `rig-a-model` |

Auto-rigging assumes a **humanoid figure**. A clearly non-humanoid subject
(furniture, vehicle, quadruped) is steered to `generate-3d-model` instead.

## Fastest path — the MCP tool

If the three.ws MCP server is connected, call the one-step avatar tool:

- **Tool:** `forge_avatar`
- **Input:** `{ "prompt": "<character description>" }` or
  `{ "image_url": "<https URL to a reference image>" }`
  - `prompt` — describe a **single full-body humanoid** in a neutral standing pose:
    `"a friendly cartoon astronaut in a glossy white suit"`.
  - `image_url` — reconstruct and rig a character from a photo/render.
  - `allow_non_humanoid` — set `true` only to rig a non-humanoid subject anyway.
- **Returns:** the rigged `glbUrl` (or `riggedGlbUrl`), the intermediate mesh URL,
  a pose-studio link, and per-stage timing.

For a fast unrigged figure (no skeleton), use `text_to_avatar` instead — same
inputs, mesh only.

## Portable path — the hosted HTTP endpoint

No MCP client needed. The free hosted lane is a public JSON-RPC endpoint at
`https://three.ws/api/mcp-studio`:

```bash
curl -s -X POST https://three.ws/api/mcp-studio \
  -H 'content-type: application/json' \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "tools/call",
    "params": {
      "name": "forge_avatar",
      "arguments": { "prompt": "a friendly cartoon astronaut in a glossy white suit" }
    }
  }'
```

`structuredContent` returns the rigged model:

```json
{
  "kind": "avatar",
  "glbUrl": "https://three.ws/cdn/creations/def456/rigged.glb",
  "viewerUrl": "https://three.ws/viewer?src=https%3A%2F%2Fthree.ws%2F...",
  "format": "glb",
  "rigged": true,
  "prompt": "a friendly cartoon astronaut in a glossy white suit"
}
```

## Manual two-step (REST)

`forge_avatar` is generate-then-rig bundled. You can run the steps yourself over
`POST /api/forge` — generate a mesh, then rig it:

```bash
# 1. Generate the figure (see generate-3d-model/reference.md for the submit/poll shape)
#    "tier": "high" matches what forge_avatar/text_to_avatar request automatically —
#    it is the tier the router maps to the self-host Hunyuan3D lane for IRL realism.
curl -s -X POST https://three.ws/api/forge -H 'content-type: application/json' \
  -d '{ "prompt": "a friendly cartoon astronaut in a glossy white suit", "tier": "high" }'

# 2. Rig the resulting GLB (see rig-a-model)
curl -s -X POST "https://three.ws/api/forge?action=rig" -H 'content-type: application/json' \
  -d '{ "glb_url": "<glbUrl from step 1>" }'
```

## What to do with the result

1. Give the user the **pose-studio / viewer link** — they can pose and preview the
   rigged avatar in the browser.
2. Give the **`glbUrl`** for download / import into a 3D engine; it already carries
   a humanoid skeleton and skin weights, so animation clips play on it.

## Prompting tips

- One **full-body humanoid**, neutral standing pose, arms slightly away from the
  body — best for a clean rig.
- Name the silhouette and materials: `"a tall slender elf ranger in green leather
  armor"`. Avoid scenes, props held in hand, or multiple characters.
- Hands are the hardest part of the mesh to get right. `forge_avatar` /
  `text_to_avatar` already direct the generator toward relaxed, open hands with
  fingers separated and visible (never a fist, never a hand hidden behind the
  body or in a pocket) — do not fight that by asking for "hands on hips" or
  "arms crossed" unless you accept a higher chance of fused-finger geometry.
- Both avatar tools always request the platform's `high` quality tier under the
  hood — the self-host Hunyuan3D lane (people/organic-subject strength, portrait
  realism cues on the reference image) instead of the faster draft/standard
  default. This is automatic; no input needed.

## Higher-fidelity & paid lanes

The full three.ws MCP server also exposes higher-fidelity, art-directed and paid
avatar lanes. The free hosted path above is the cross-platform-safe one. The rig
internals (skeleton convention, what makes a model riggable) live in the
`rig-a-model` skill.

## Errors

- `rate_limited` / `busy` — honor `retryAfter` and retry.
- `not_configured` — lane momentarily cold; retry shortly.
- Generation succeeded but rigging failed — you still get the unrigged mesh URL;
  hand it back and offer to retry rigging via `rig-a-model`.

Never report a dead or empty link as success.
