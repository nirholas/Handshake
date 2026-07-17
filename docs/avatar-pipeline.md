# Avatar Pipeline

This is the end-to-end view of how a text prompt or image becomes a rigged,
animated 3D avatar on three.ws — from generation, through auto-rigging, to the
universal animation system that drives any humanoid skeleton. It ties together the
individual tool docs ([Avatar creation](avatar-creation.md),
[Avatar Studio](character-studio.md), [Animations](animations.md),
[3D asset pipeline](3d-asset-pipeline.md)) into one map.

---

## The stages

```
prompt / image
      │
      ▼
  ① generate mesh ──► ② auto-rig (humanoid gate) ──► ③ canonicalize bones ──► ④ retarget clips
   (textured GLB)        (skeleton added)             (map to canonical set)    (idle/walk/emotes)
```

### ① Generate the mesh

| Lane | Tool / endpoint | Cost | Notes |
|---|---|---|---|
| Free | `forge_free` (MCP) | **Free** | NVIDIA NIM (Microsoft TRELLIS); text → textured GLB + viewer link. |
| Paid | `text_to_3d` / `image_to_3d` (MCP), `POST /api/x402/forge` | tiered | Quality by tier — see below. |
| Paid | `mesh_forge` (MCP) | per call | Text/image → mesh via a Granite-directed model chain. |
| Avatar | `text_to_avatar`, `forge_avatar` (MCP) | per call | Avatar-shaped output; `forge_avatar` chains generation + rigging in one call. |

Generation quality is a **tier** (`forge-tiers.js`): `draft`, `standard`
(default), or `high` — more geometric budget at higher tiers. The tier sets the
price identically across REST and MCP transports (see
[MCP tools](mcp-tools.md), [x402 endpoints](x402-endpoints.md)).

### ② Auto-rig

`rig_mesh` (or the rigging step inside `forge_avatar`) adds an animation-ready
skeleton to a GLB. A **humanoid gate** decides whether the mesh can carry a
canonical humanoid rig; non-humanoid props are left unrigged rather than forced
into a broken skeleton.

The rigging engine is the `model-rig` worker ([workers/rig/](../workers/rig)):
Make-It-Animatable (MIT) predicts the 52-bone Mixamo skeleton, fingers
included, plus per-vertex weights; the worker grafts them into the original
GLB bytes (materials and PBR textures untouched) and transfers the ARKit-52
expression blendshapes from the MIT-licensed ICT-FaceKit template head, so
generated avatars support emotions and lipsync out of the box. Bones come out
`mixamorig:*`-named, which stage ③ maps onto the canonical set at 100%
coverage.

### ③ Canonicalize bones

`src/glb-canonicalize.js` maps an incoming skeleton's bone names onto three.ws's
**canonical bone set**. It understands many rig conventions out of the box —
Mixamo, Avaturn, Unreal, VRM / VRoid, VRM 1.0, Daz / Genesis, MakeHuman, Blender
`.L`/`.R`, and simple `shoulderL`-style rigs.

### ④ Retarget clips

`src/animation-retarget.js` retargets the pre-baked clip library (idle, walk,
emotes — legs included) onto the canonicalized skeleton, using rest-pose and
world-rest maps to transfer motion correctly. `MIN_COVERAGE` (0.5) requires at
least half the canonical bones to be present before clips are driven.

## Universal animation — no rig allowlist

Any humanoid avatar drives the clip library. There is **no curated allowlist of
supported rigs**: support comes from the bone-name mapping in
`glb-canonicalize.js`, not a hardcoded list.

- A rig that genuinely cannot be skeleton-driven (no skin, a non-humanoid prop)
  falls back to the **default rig**, gated by
  `AnimationManager.supportsCanonicalClips()` — never a bind-pose T-pose. When the
  gate is false, emotes and clips are a safe no-op (see `src/agent-screen-stage.js`,
  `src/agent-screen.js`).
- **Hit a new skeleton convention?** Add its bone-name mapping to
  `glb-canonicalize.js` and cover it with a case in
  `tests/glb-canonicalize.test.js`. Do **not** hardcode a curated rig list.

## Output and surfaces

A finished avatar is a GLB (plus optional rig + clips) viewable in the three.ws
viewer, embeddable as a web component, and attachable to an agent. Paid
generation/editing is metered per call over x402; the free studio lane requires no
account. See [Avatar creation](avatar-creation.md) and
[Avatar Studio](character-studio.md) for the authoring UIs, and
[Mesh editing tools](mcp-tools.md) for retexture / stylize / remesh / segment /
pose operations.

## Related

- [Animations](animations.md) — the clip library and retargeting in depth.
- [3D asset pipeline](3d-asset-pipeline.md) — formats, optimization, validation.
- [NVIDIA free models](nvidia-models.md) — the free generation backend.
- [MCP tools](mcp-tools.md) — every generation/editing tool and its price.
