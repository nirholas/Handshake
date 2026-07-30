---
name: rig-a-model
description: Auto-rig a static 3D GLB model into an animation-ready one. Use when you or the user have an existing GLB and want to rig it, add a skeleton, add bones, make it posable, or make it animatable — "rig this model", "add a skeleton to my GLB", "make this character animation-ready". Takes a GLB URL, adds a humanoid skeleton plus skin weights, and returns the rigged GLB URL and a pose-studio link.
when_to_use: User already has a GLB (a URL) and wants it rigged. To generate a new model from text, use generate-3d-model; to generate an already-rigged character in one step, use create-3d-avatar.
license: MIT
metadata:
  category: 3d/creative
  cross-platform-safe: true
  pack: three-ws-skills
---

# Rig a 3D model

Turn a **static GLB** into an **animation-ready** one. The three.ws auto-rig
pipeline (VAST-AI UniRig) adds a humanoid skeleton and per-vertex skin weights,
so the model can be posed and play animation clips.

The result is a **`riggedGlbUrl`** plus a **pose-studio link** that opens the
rigged model in the browser, ready to pose.

## When to use which tool

| Goal | Use |
| --- | --- |
| Add a skeleton to a GLB you already have | this skill |
| A new static object / prop from text | `generate-3d-model` |
| A new rigged character from text/image in one call | `create-3d-avatar` |

Rigging assumes a roughly **humanoid figure** (head, torso, two arms, two legs,
standing). Props, furniture, and vehicles won't rig meaningfully.

## Fastest path — the MCP tool

If the three.ws MCP server is connected, call the rig tool directly:

- **Tool:** `rig_mesh`
- **Input:** `{ "glb_url": "<https URL to the static GLB>" }`
  - Any reachable GLB URL works — a `glbUrl` from `generate-3d-model`, a CDN
    link, or a model you host yourself.
- **Returns:** `riggedGlbUrl`, `sourceGlbUrl`, `poseStudioUrl`, `jobId`,
  `creationId`, `durationMs`.

## Portable path — the hosted HTTP endpoint

No MCP client needed. `rig_mesh` is exposed free on the hosted studio JSON-RPC
endpoint at `https://three.ws/api/mcp-studio` (no key, no account):

```bash
curl -s -X POST https://three.ws/api/mcp-studio \
  -H 'content-type: application/json' \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "tools/call",
    "params": {
      "name": "rig_mesh",
      "arguments": { "glb_url": "https://three.ws/avatars/cesium-man.glb" }
    }
  }'
```

`structuredContent` returns the rigged model:

```json
{
  "ok": true,
  "riggedGlbUrl": "https://three.ws/cdn/creations/def456/rigged.glb",
  "sourceGlbUrl": "https://three.ws/avatars/cesium-man.glb",
  "poseStudioUrl": "https://three.ws/pose?src=https%3A%2F%2Fthree.ws%2F...",
  "jobId": "r9k2m7x4",
  "durationMs": 48000
}
```

## Raw REST pipeline

The MCP tool is a thin client over the public rig endpoint. Submit, then poll:

```bash
# 1. Start the rig job
curl -s -X POST "https://three.ws/api/forge?action=rig" \
  -H 'content-type: application/json' \
  -d '{ "glb_url": "https://three.ws/avatars/cesium-man.glb" }'
# → { "job_id": "r9k2m7x4", ... }

# 2. Poll until done (every ~3s, budget ~180s)
curl -s "https://three.ws/api/forge?job=r9k2m7x4" -H 'accept: application/json'
# → { "status": "done", "glb_url": "https://.../rigged.glb" }  (or "failed" / still "running")
```

Build the pose-studio link yourself from any rigged GLB URL:
`https://three.ws/pose?src=<URL-encoded riggedGlbUrl>`.

## What to do with the result

1. Give the user the **pose-studio link** — pose and preview in the browser.
2. Give the **`riggedGlbUrl`** for download / import; it carries a humanoid
   skeleton and skin weights, so animation clips retarget onto it.
3. The original mesh is never modified — `sourceGlbUrl` stays valid.

## Errors

- `rate_limited` / `429` — the rigger is busy; honor `retryAfter` and retry.
- `not_configured` / `503` — auto-rigging momentarily unavailable; retry shortly.
- `rig_failed` — the model couldn't be rigged (usually not humanoid enough).
  Tell the user why and suggest `create-3d-avatar` to generate a riggable figure.
- `timeout` — the job outlived the poll budget; the response includes a
  `resumeUrl` — keep polling it rather than restarting the job.

Never report a dead or empty link as success — only return a `riggedGlbUrl` the
job actually produced.
