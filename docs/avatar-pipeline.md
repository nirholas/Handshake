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

Generation quality is a **tier** ([api/_lib/forge-tiers.js](../api/_lib/forge-tiers.js)): `draft`, `standard`
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
`.L`/`.R`, Rigify, SMPL, Roblox, Second Life, anatomical-Latin scan rigs, and
simple `shoulderL`-style rigs. Finger chains are mapped per convention too, which
matters more than it sounds: see the coverage note below.

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
- **Fingers are load-bearing for coverage.** 30 of the 53 tracks in every clip
  address a finger joint, so a rig whose hands do not name-map scores about 40%
  coverage, drops under `MIN_COVERAGE`, and gets **no action built at all**: the
  whole avatar stands frozen, arms and legs included. When you add a convention,
  add its finger spellings too.

### Proving it: the animation dignity sweep

```bash
node scripts/animation-dignity-sweep.mjs            # per-rig report, exit 0/1
node scripts/animation-dignity-sweep.mjs --verbose  # per-limb swing + travel numbers
node scripts/animation-dignity-sweep.mjs --json     # machine-readable
```

The sweep builds ten minimal skinned GLBs, one per naming convention (Mixamo,
Avaturn, Unreal, VRoid, VRM 1.0, Daz, MakeHuman, Rigify, a simple `shoulderL`
rig, and an anatomical-Latin rig), drives the real `idle` and `walk` clips onto
each, and **measures** the result: retarget coverage, per-limb rotation swing in
degrees, and end-effector world travel in hip-heights for both hands and both
feet. It runs each rig down both production paths, ingest-canonicalized and
raw-runtime, and fails the run if any limb does not move. Use it whenever you
touch the canonicalizer or the retargeter; "the tests still pass" does not prove
an avatar still animates.

## Output and surfaces

A finished avatar is a GLB (plus optional rig + clips) viewable in the three.ws
viewer, embeddable as a web component, and attachable to an agent. Paid
generation/editing is metered per call over x402; the free studio lane requires no
account. See [Avatar creation](avatar-creation.md) and
[Avatar Studio](character-studio.md) for the authoring UIs, and
[Mesh editing tools](mcp-tools.md) for retexture / stylize / remesh / segment /
pose operations.

## Related

- [Selfie → Avatar reconstruction](avatar-reconstruction.md) — the separate lane that fits a *person's photo* onto a rigged template (face texture + geometry morph), rather than generating a mesh from a prompt.
- [Animations](animations.md) — the clip library and retargeting in depth.
- [3D asset pipeline](3d-asset-pipeline.md) — formats, optimization, validation.
- [NVIDIA free models](nvidia-models.md) — the free generation backend.
- [MCP tools](mcp-tools.md) — every generation/editing tool and its price.
