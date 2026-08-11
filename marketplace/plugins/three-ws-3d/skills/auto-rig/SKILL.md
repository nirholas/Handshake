---
name: auto-rig
description: Make a 3D model animation-ready — add a humanoid skeleton and skin weights to an existing GLB, or generate a rigged avatar from text/images in one call. Use when you or the user want to rig a mesh, auto-rig a GLB, make a model animatable, get a character that plays idle/walk animations, or go from prompt straight to a rigged avatar. Covers "rig this GLB", "make it animatable", "text to rigged avatar". Paid lane ($0.20 / $0.45 USDC via x402).
---

# Auto-Rig — skeleton + skin weights for animation

Two paths, depending on whether you already have a mesh.

## Tools

Both on the three.ws MCP server (`@three-ws/mcp-server`).

### `rig_mesh` — rig an existing GLB ($0.20 USDC)

Auto-rig a static GLB: adds a humanoid skeleton and per-vertex skin weights via the three.ws rig pipeline (Make-It-Animatable by default).

| Param | Required | Notes |
| --- | --- | --- |
| `glb_url` | yes | http(s) URL to the static GLB to rig — e.g. the `glbUrl` returned by `forge-3d` (`forge_free`), `mesh-forge`, or `text-to-avatar`. |

Returns the **rigged** `glbUrl` and a three.ws pose-studio link (`https://three.ws/forge?action=rig...`) where the model plays the canonical idle/walk clip library.

### `forge_avatar` — text/image → rigged avatar in one call ($0.45 USDC)

Chains the whole pipeline: Granite prompt director → FLUX + TRELLIS/Hunyuan3D mesh → Make-It-Animatable auto-rig, so the model loads straight into the pose studio.

| Param | Required | Notes |
| --- | --- | --- |
| `prompt` | one of prompt/images | A single humanoid character, e.g. `"a friendly cartoon astronaut in a glossy white suit"`. |
| `image_url` / `image_urls` | one of prompt/images | Single image, or 1–4 angles (front/back/left/right) for higher-fidelity reconstruction. |
| `direct` | no | Run the Granite prompt-director stage (text mode). Default `true`. |
| `aspect_ratio` | no | Reference aspect ratio (text mode). Default `3:4` (portrait — best for a full-body figure). |
| `allow_non_humanoid` | no | Off by default. A clearly non-humanoid subject (furniture, vehicle, quadruped) is **rejected without charge**. Set `true` only to force-rig a non-character. |

Returns the rigged `glbUrl`, the intermediate mesh URL, a pose-studio link, the directed prompt, and per-stage timing. **You are not charged if no rigged avatar is produced.**

## Which to use

- Already have a GLB (from `forge-3d`, `mesh-forge`, `text-to-avatar`, or the user's own file) → `rig_mesh` ($0.20).
- Starting from just a prompt or photos and want it rigged → `forge_avatar` ($0.45, generation + rig bundled).

## How to run

1. Pick the tool by whether a GLB already exists.
2. Call it. Both are PAID over x402 — on a `PaymentRequired` result, surface the price and funding path; do not retry blindly.
3. For `forge_avatar`, if the humanoid gate rejects a non-character prompt (no charge), suggest `mesh-forge` or `forge-3d` for that object instead.
4. Return the rigged `glbUrl` and the pose-studio link so the user can preview the idle/walk animation.

## Notes

- Rigged output drives the three.ws canonical clip library — any humanoid skeleton is retargeted (no curated rig allowlist).
- x402 settlement is in USDC; `$THREE` is the platform's only token.
