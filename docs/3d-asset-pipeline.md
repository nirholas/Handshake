# 3D Asset Pipeline — FBX, GLB, and JSON

This is the canonical reference for how three.ws moves a 3D character or motion from a source file all the way to something the site renders and animates in the browser. It explains the **three formats we work with** — FBX, GLB, and the three.js clip **JSON** — what each one is for, how they convert into each other, what the platform does today, and what you can do with the pipeline.

If you just want to add one animation or upload one avatar, the task guides are shorter:

- [docs/animations.md](animations.md) — the animation registry, runtime loading, and agent slots.
- [docs/avatar-creation.md](avatar-creation.md) — the three ways to create an avatar (photo, builder, upload).
- [docs/tutorials/upload-custom-glb.md](tutorials/upload-custom-glb.md) — Mixamo → GLB, validation, and the common failure modes.

This document is the *why and how* underneath all of those.

---

## The three formats at a glance

| Format | What it is | Carries | Role in three.ws | Where it lives |
|---|---|---|---|---|
| **FBX** | Autodesk's interchange format (binary or ASCII) | Mesh, skeleton, skin weights, animation, materials/textures | **Source only.** What you download from Mixamo or export from a DCC tool. Never loaded in the browser. | `animation-sources/` (gitignored build-time input; `public/animations/` ships no FBX) |
| **GLB** | Binary glTF 2.0 — a single self-contained file | Geometry + skeleton + skin + textures + (optional) animation | **The runtime model format.** Every avatar the site renders is a GLB. | `public/avatars/*.glb` |
| **clip JSON** | A serialized `THREE.AnimationClip` (`AnimationClip.toJSON()`) | **Motion only** — keyframe tracks, no geometry | **The runtime motion format.** Reusable clips that play on *any* rig via retargeting. | `public/animations/clips/*.json` |

The mental model: **GLB is the body, JSON is the motion, FBX is where both come from.** A GLB can hold its own baked-in animation, but the platform's shared library of gestures and dances is stored as format-light clip JSON so one clip can drive every avatar.

---

## How they relate — the data flow

```
                    ┌─────────────────────── SOURCE ───────────────────────┐
                    │                                                       │
                  FBX file  (Mixamo / Blender / Maya export)                │
                    │                                                       │
        ┌───────────┴───────────┐                                          │
        │                       │                                          │
   full character          motion only                                     │
        │                       │                                          │
        ▼                       ▼                                          │
  npm run convert:fbx     npm run build:animations                         │
  (FBX2glTF)              (FBXLoader → retarget → AnimationClip.toJSON)     │
        │                       │                                          │
        ▼                       ▼                                          │
   ┌─────────┐           ┌──────────────┐                                  │
   │  .glb   │           │  clips/*.json │  + manifest.json entry          │
   │ avatar  │           │  (canonical)  │                                  │
   └────┬────┘           └───────┬───────┘                                 │
        │                        │                                         │
   npm run optimize:glb          │                                         │
   (geometry + WebP, ~90% smaller)                                         │
        │                        │                                         │
        └────────── RUNTIME (browser) ──────────┐                          │
                    │                            │                          │
              GLTFLoader loads GLB         fetch + AnimationClip.parse      │
                    │                            │                          │
        glb-canonicalize (rename bones)   animation-retarget (to this rig) │
                    │                            │                          │
                    └────────► AnimationMixer ◄──┘                          │
                                    │                                       │
                          GLTFExporter ── bake clip onto rig ──► animated .glb
```

Two distinct conversions come off the same FBX, and which one you want depends on your goal:

- **You have a character** (mesh + rig, maybe with one baked animation) and want to *display* it → convert to a **GLB** with [`npm run convert:fbx`](#fbx--glb-a-character-or-avatar).
- **You have a motion** (an animation clip) and want it in the shared library so *any* avatar can play it → bake it to **clip JSON** with [`npm run build:animations`](#fbx--clip-json-a-reusable-animation).

---

## What we do today

### FBX → GLB: a character or avatar

Converts a skinned, animated FBX into a single GLB the site can load. Backed by **FBX2glTF** (Meta's converter; the prebuilt binary ships with the `fbx2gltf` dev dependency). It preserves the skeleton, skin weights, animation clips, and textures in one pass.

```bash
npm run convert:fbx -- path/to/your-avatar.fbx
#   → writes public/avatars/<name>.glb and prints a summary:
#     meshes / skins / nodes / textures / animation clip names
```

Source: [scripts/fbx-to-glb.mjs](../scripts/fbx-to-glb.mjs).

Why FBX2glTF and not the alternatives:

- **`scripts/convert-fbx-to-glb.py`** uses `trimesh` — fine for **static props**, but it *drops the skeleton and animation*. Do not use it for characters.
- A **headless three.js `GLTFExporter`** round-trip stalls in Node on FBX materials (no canvas to rasterize textures). It works inside [scripts/build-animations.mjs](../scripts/build-animations.mjs) only because that path exports a clean GLB-sourced rig with animation tracks, not raw FBX materials.

After converting, always optimize before shipping (see [GLB optimization](#glb-optimization)). A raw Mixamo avatar is often 50+ MB; the optimizer takes it to ~5 MB with no visible quality loss.

### FBX → clip JSON: a reusable animation

This is how a motion enters the **shared animation library** that every agent and avatar draws from. The build script reads Mixamo FBX (or GLB) clips, **retargets** them to the canonical three.ws skeleton (`public/avatars/cz.glb`), validates that retargeting succeeded, and writes one JSON clip per motion plus a manifest entry.

```bash
# 1. Drop the FBX into animation-sources/  (build-time input, not shipped)
# 2. Add an entry to scripts/animations.config.json
# 3. Build:
npm run build:animations
#   → retargets to cz.glb, writes public/animations/clips/<name>.json,
#     rewrites public/animations/manifest.json, then re-syncs
#     public/animations/registry.json (sync-animation-registry.mjs) and
#     rebuilds public/animations/signatures.json (build-motion-signatures.mjs)
```

Source: [scripts/build-animations.mjs](../scripts/build-animations.mjs). The config entry shape:

```json
{ "name": "idle", "source": "Idle.fbx", "label": "Idle", "icon": "🧍", "loop": true }
```

**Why pre-bake to JSON instead of shipping FBX or GLB clips?**

- On-chain agents must animate without runtime retargeting fragility.
- Browser cold-loads should never re-parse FBX or guess bone names.
- Build-time validation means clips that *don't* survive retargeting are dropped here, loudly, instead of silently breaking in production. The build requires >60% bone-match coverage.

A GLB that already has a baked animation can be turned into a library clip too — [scripts/extract-glb-animations.mjs](../scripts/extract-glb-animations.mjs) pulls the clip out and feeds it into the same build (`npm run extract:animations`).

### GLB optimization

```bash
npm run optimize:glb -- public/avatars/<name>.glb   # one file
npm run optimize:glb                                # every GLB in assets/, public/, rider/assets/
npm run optimize:glb -- --dry                       # report only, no writes
```

Source: [scripts/optimize-glb.mjs](../scripts/optimize-glb.mjs). Lossless geometry passes (`dedup`, `prune`, `weld`, `resample`) plus a WebP texture re-encode. Compressed inputs are fine: the script registers the meshopt and Draco codecs with gltf-transform, so an `EXT_meshopt_compression` or `KHR_draco_mesh_compression` avatar (most of the ones in production) decodes instead of failing with "Please install extension dependency". Output stays within the **standard glTF 2.0 feature set** (the compression extensions are stripped after decoding, never re-encoded) so it loads in every `GLTFLoader` on the site without wiring a decoder. Typical result: **-90%** file size.

### The format reference

**Clip JSON** is a `THREE.AnimationClip` serialized with `.toJSON()`:

```jsonc
{
  "name": "angry",
  "duration": 19.16,
  "blendMode": 2500,           // THREE.NormalAnimationBlendMode
  "uuid": "…",
  "userData": {},
  "tracks": [
    { "name": "Hips.position", "type": "vector",     "times": [...], "values": [...] },
    { "name": "Hips.quaternion", "type": "quaternion", "times": [...], "values": [...] }
    // …one quaternion track per canonical bone, plus the single Hips position
    // track: 52 + 1 = 53 tracks for a full clip
  ]
}
```

Track names are **canonical bone names** (`Hips`, `Spine`, `LeftArm`, …) so the same clip retargets onto any rig at runtime.

**manifest.json** maps each clip to the UI:

```json
{ "name": "idle", "url": "/animations/clips/idle.json", "label": "Idle", "icon": "🧍", "loop": true }
```

**The canonical skeleton** is the 52-bone humanoid set exported as `CANONICAL_BONES` from [src/glb-canonicalize.js](../src/glb-canonicalize.js): the torso chain (`Hips → Spine → Spine1 → Spine2 → Neck → Head`), both arms (`Shoulder → Arm → ForeArm → Hand`) with full finger chains, and both legs (`UpLeg → Leg → Foot → ToeBase`). `public/avatars/cz.glb` is the reference rig every clip is retargeted against.

---

## How the runtime uses all three

The build pipeline produces GLB + JSON; the browser stitches them back together. The full machine-readable inventory of every animation asset and which pipeline owns it is [public/animations/registry.json](../public/animations/registry.json): read it before touching anything animation-related. Its measured companion is [public/animations/signatures.json](../public/animations/signatures.json), a motion-signature index (energy, speed, per-region movement, loop cleanliness) computed from every baked clip by `npm run build:motion-signatures`; `npm run audit:motion` fails when it is stale.

| Stage | Module | What it does |
|---|---|---|
| Load a GLB | [src/viewer.js](../src/viewer.js) | `GLTFLoader` (with DRACO/KTX2/meshopt support) loads the model, frames the camera in front of the rig's face (`estimateFacingYaw` in `src/viewer/facing.js` reads which way the skeleton was authored to face, so a -Z or +X rig is not framed from behind), builds raycasting BVH, emits the scene to the animation panel. |
| Normalize an uploaded rig | [src/glb-canonicalize.js](../src/glb-canonicalize.js) | Rewrites bone names in the GLB JSON chunk to canonical form (see [the supported conventions](#supported-rig-conventions) below), folds the Mixamo +90°X armature rotation into children, repacks the GLB. |
| Load a clip | [src/animation-manager.js](../src/animation-manager.js) | Fetches clip JSON, `AnimationClip.parse`, drives playback through a `THREE.AnimationMixer` with crossfades (0.35s default), one-shot + settle, and a "fallen pose" safety guard. |
| Retarget a clip to the loaded rig | [src/animation-retarget.js](../src/animation-retarget.js) | Renames canonical tracks to the rig's actual bone names, applies per-bone bind-pose correction (`C = targetRest · sourceRest⁻¹`), rescales hip translation by height ratio, drops the clip if coverage < 50%. |
| The pose/animation studio | `/pose` ([src/animation-library.js](../src/animation-library.js)) | Gallery of preset clips, live preview on the loaded rig, text-to-motion generation, and **export animated GLB**. |
| Export an animated GLB | `GLTFExporter` | Bakes a retargeted clip onto the current rig and downloads `<rig>-<clip>.glb` — closing the loop back to a self-contained GLB. |

Validation gates worth knowing: a rig needs **≥8 canonical bones** to be playable, a retarget must map **≥50%** of a clip's tracks to land, and a hips tilt past **45°** off vertical rejects the retarget and falls back to the bind pose (catches genuinely broken rigs without tripping on dance poses).

---

## Supported rig conventions

There is **no rig allowlist**. [src/glb-canonicalize.js](../src/glb-canonicalize.js) maps bone names from every convention below onto the canonical set, so any humanoid GLB using one of them drives the whole clip library — idle, walk, legs included — the moment it is uploaded.

| Family | Example bone names |
|---|---|
| Mixamo | `mixamorig:LeftArm`, `mixamorig1:Spine`, `mixamorigHead` |
| Blender / Armature | `Armature_Hips`, `Armature/LeftLeg` |
| Rigify | `DEF-forearm.L`, `ORG-Hips`, `MCH-RightLeg` |
| MakeHuman / Blender `.L`/`.R` | `upperarm.L`, `UpperLeg.R`, `shin.L`, `Index2.L` |
| Unreal mannequin | `pelvis`, `clavicle_l`, `upperarm_l`, `thigh_l`, `calf_l`, `ball_l` |
| VRM 0.x / VRoid | `J_Bip_C_Hips`, `J_Bip_L_UpperArm`, `J_Bip_L_Little1` |
| VRM 1.0 | `leftUpperArm`, `rightLowerLeg`, `upperChest`, `leftToes` |
| MikuMikuDance (PMX/PMD) | `センター`, `上半身`, `首`, `左腕`, `左ひじ`, `左ひざ` (Japanese names, `左`/`右` side prefix) |
| UniGLTF / VRM converter | `5.joint_HipMaster`, `10.!joint_LeftToe` |
| Daz3D / Genesis | `hip`, `abdomen`, `lShldr`, `lThigh`, `lShin`, `lCollar` |
| Reallusion CC3 / CC4 | `CC_Base_Hip`, `CC_Base_L_Upperarm`, `CC_Base_NeckTwist01` |
| 3ds Max Biped | `Bip01 Pelvis`, `Bip001 L UpperArm`, `Bip01 L Calf` |
| CharacterStudio | `CH_Hips`, `CH_LeftUpLeg` |
| Autodesk HumanIK / Maya / MotionBuilder | `Character1:Hips`, `subject:LeftArm`, `char:ns:Hips` |
| Advanced Skeleton (Maya) | `Root_M`, `Spine1_M`, `Chest_M`, `Scapula_R`, `IndexFinger1_R` |
| Sketchfab / Maya `j_` exports | `j_pelvis`, `j_L_hip`, `j_L_knee`, `j_spine_0` |
| SMPL / SMPL-X (research, mocap) | `left_hip`, `left_knee`, `left_ankle`, `left_elbow`, `left_collar` |
| Roblox R15 / R6 | `LowerTorso`, `UpperTorso`, `LeftUpperArm`, `Left Arm` |
| Second Life / OpenSim | `mPelvis`, `mChest`, `mCollarLeft`, `mShoulderLeft`, `mKneeRight` |
| Simple / generic rigs | `shoulderL`, `elbowL`, `wristL`, `hipL`, `kneeL`, `ankleL`, `chest` |
| snake / kebab / lowercase | `left_arm`, `Left-Arm`, `leftarm` |

Vendor prefixes (`mixamorig:`, `CC_Base_`, `Bip01 `, `j_`, Maya namespaces) and exporter de-dup suffixes (`_01`, `.001`) are stripped automatically and compose with everything above, so `CH_LeftLeg_03` and `DEF-upper_arm.L` both resolve.

**What deliberately does *not* map**, because mapping it would be worse than falling back:

- **Non-humanoid skeletons** (quadrupeds, prop rigs) — no safe correspondence exists.
- **End effectors and leaf tips** (`HeadTop_End`, `LeftToe_End`, `LeftHandIndex4`) — the clip library drives no such bone.
- **Metacarpals** (`Palm1.L`) — the canonical set has no metacarpal.
- **MMD IK targets and twist bones** (`左足ＩＫ`, `左つま先ＩＫ`, `左腕捩`, `左手捩`). MMD drives the leg chain from the IK target, so binding a clip to it would fight the chain it solves, and the twist bones are secondary deformers that tear the mesh when rotated as a limb.
- **Constraint-driven control rigs** (Auto-Rig-Pro / `cwf_` + `def_` + tracker families). Their deform bones are *leaves* hanging off tracker nodes — `def_arm_1.R` is not a child of `def_arm_0.R` — and glTF has no constraint system, so the Copy-Rotation/Damped-Track constraints that made the rig work in Blender are dropped at export. Rotating a mapped `def_` bone would move its own skin while the next segment stayed put, tearing the limb apart. These fall back to the default rig; the remedy is re-rigging through [workers/rig](../workers/rig), not name mapping.

### Measuring coverage against real avatars

Anticipating a convention is not the same as knowing it works. [scripts/audit-rig-coverage.mjs](../scripts/audit-rig-coverage.mjs) measures the canonicalizer against avatars actually stored in production and reports which rigs animate, which fall back, and — the actionable part — which unmapped bone names appear most often. Every name in that list is a candidate alias.

It never downloads a whole GLB: the glTF JSON chunk always starts at byte 20, so an HTTP Range request for the first 256 KB yields the complete node and skin graph. A 40 MB avatar costs the same as a 2 MB one, which makes sweeping thousands of models practical.

```bash
node scripts/audit-rig-coverage.mjs                  # 300 newest avatars
node scripts/audit-rig-coverage.mjs --source upload  # one ingest lane
node scripts/audit-rig-coverage.mjs --failing        # dump every rig that does NOT animate,
                                                     # with the joint names it shipped
node scripts/audit-rig-coverage.mjs --limit 2000 --json report.json
```

Needs `DATABASE_URL` and `S3_PUBLIC_DOMAIN` (both in `.env`). Output reports the share of skinned rigs that animate, the share with a complete leg chain, a per-ingest-lane breakdown, and the top unmapped joint names with a sample avatar for each. The Advanced Skeleton, Sketchfab `j_`, side-suffix leg, and Blender finger-chain mappings above were all found this way rather than guessed.

---

## What we can do — capabilities

The same FBX/GLB/JSON plumbing is the foundation for the platform's generative 3D features. You don't need an FBX to start; you can generate the whole chain.

**Generate a 3D model from nothing:**

| Capability | Entry point | Output |
|---|---|---|
| Text → 3D (free) | `forge_free` MCP tool · [Forge](https://three.ws/forge) | Textured GLB on the free-lane chain (self-host TRELLIS first, then Hunyuan3D / HuggingFace, NVIDIA NIM as the last-resort fallthrough) |
| Text/image → 3D | `mesh_forge` MCP tool | Textured GLB via a Granite-directed FLUX + reconstruction chain |
| Text → avatar | `text_to_avatar` MCP tool | A humanoid avatar GLB |

**Make it move:**

- **Auto-rig a static mesh**: the `rig_mesh` MCP tool (the Make-It-Animatable engine in [workers/rig](../workers/rig/README.md)) turns a rig-less GLB into an animation-ready one with a 52-bone Mixamo-convention skeleton and skin weights.
- **Retarget any humanoid rig** — drop in a Mixamo, Blender, Rigify, Unreal, or other standard humanoid GLB and the canonicalizer + retargeter let it play every library clip. No manual bone mapping.
- **Text → motion** — the pose studio generates brand-new clips from a text prompt (`/api/forge-motion`), not just presets.
- **Author by hand** — pose with FK/IK gizmos on the `/pose` timeline and export a JSON clip or an animated GLB.

**The full composition chain** — every arrow below is wired:

```
text/image ──► mesh_forge ──► static GLB ──► rig_mesh ──► rigged GLB
                                                              │
                                            load in /pose studio
                                                              │
                              play any library clip (retargeted at runtime)
                                                              │
                                       export animated GLB (GLTFExporter)
```

**Studios that consume the pipeline:**

- **Pose Studio** (`/pose`) — load an avatar, pose it, preview and generate motion, export animated GLB.
- **Scene Studio** (`/scene`) — import GLBs, compose scenes, edit materials/lights, export.
- **character-studio** — full web-first avatar creator (morph targets, LoRA, sprite-atlas pipelines).

---

## Choosing the right tool

| You have… | You want… | Use |
|---|---|---|
| FBX character (mesh + rig) | A GLB to display on the site | `npm run convert:fbx -- file.fbx` |
| FBX motion clip | A reusable library animation | add to `animations.config.json` → `npm run build:animations` |
| GLB with a baked-in animation | That motion as a library clip | `npm run extract:animations` |
| A heavy GLB (textures, 50 MB) | A web-ready GLB | `npm run optimize:glb -- file.glb` |
| FBX static prop (no rig) | A GLB prop | `python3 scripts/convert-fbx-to-glb.py file.fbx` |
| No file at all | A 3D model from a prompt | `forge_free` / `mesh_forge` → `rig_mesh` |
| A rig-less GLB | An animation-ready rig | `rig_mesh` MCP tool |

---

## Pitfalls

- **Don't ship raw converted GLBs.** A Mixamo character converts to 50+ MB; always run `optimize:glb`. The site streams these to every visitor.
- **`trimesh` (the Python script) silently drops rigs.** It is for static geometry only. For anything animated, use `convert:fbx`.
- **No Draco/meshopt in optimized output.** The main viewer and the studios wire Draco/KTX2/meshopt decoders (`getDecoders` in `src/viewer/internal.js`, which serves the decoder binaries from our own origin under `public/three/`, vendored by `scripts/copy-three-decoders.mjs` on every install and checked by `scripts/audit-deploy-artifacts.mjs` at deploy, with unpkg only as the backstop when a HEAD probe of the local copy fails), but many lighter surfaces load GLBs with a bare `GLTFLoader` and no decoder. `optimize:glb` deliberately stays within plain glTF 2.0 so its output loads everywhere; WebP textures do the heavy lifting.
- **FBX is build-time only.** Keep source FBX in `animation-sources/` (gitignored) so it never ships in the deploy bundle. `public/animations/` holds no FBX anymore; the six formerly-orphaned clips are built into the manifest (see `resolved_issues` in [public/animations/registry.json](../public/animations/registry.json)).
- **Bone names matter.** A non-humanoid or oddly-named rig may fall below the 8-bone / 50%-coverage thresholds and refuse to animate. The canonicalizer handles the common conventions; truly custom skeletons need their bones renamed to the canonical set first.
- **`.bak` files.** `optimize:glb` writes a `<name>.glb.bak` alongside its output — delete it before committing.

---

## Reference — scripts and locations

| Path | Role |
|---|---|
| [scripts/fbx-to-glb.mjs](../scripts/fbx-to-glb.mjs) | FBX → GLB (FBX2glTF) — `npm run convert:fbx` |
| [scripts/build-animations.mjs](../scripts/build-animations.mjs) | FBX/GLB → retargeted clip JSON + manifest — `npm run build:animations` |
| [scripts/extract-glb-animations.mjs](../scripts/extract-glb-animations.mjs) | Extract baked animation out of a GLB — `npm run extract:animations` |
| [scripts/sync-animation-registry.mjs](../scripts/sync-animation-registry.mjs) | Regenerate registry.json's `clips` from the built truth: `npm run sync:animation-registry` (chained into `build:animations`) |
| [scripts/build-motion-signatures.mjs](../scripts/build-motion-signatures.mjs) | Measure every baked clip into signatures.json: `npm run build:motion-signatures` (check with `npm run audit:motion`) |
| [scripts/optimize-glb.mjs](../scripts/optimize-glb.mjs) | Geometry + WebP optimization — `npm run optimize:glb` |
| [scripts/convert-fbx-to-glb.py](../scripts/convert-fbx-to-glb.py) | FBX → GLB for **static props only** (trimesh) |
| [scripts/animations.config.json](../scripts/animations.config.json) | The FBX/GLB source list the build reads |
| `public/avatars/*.glb` | Runtime avatar models (`cz.glb` = canonical reference rig) |
| `public/animations/clips/*.json` | Pre-baked, retargeted animation clips |
| `public/animations/manifest.json` | Clip → UI mapping (name, url, label, icon, loop) |
| [public/animations/registry.json](../public/animations/registry.json) | Machine-readable inventory of every animation asset |
| [public/animations/signatures.json](../public/animations/signatures.json) | Measured motion-signature index for every baked clip |
| [src/glb-canonicalize.js](../src/glb-canonicalize.js) | Runtime bone-name normalization + GLB repack |
| [src/animation-retarget.js](../src/animation-retarget.js) | Runtime clip retargeting |
| [src/animation-manager.js](../src/animation-manager.js) | `AnimationMixer` driver |
| [src/animation-library.js](../src/animation-library.js) | `/pose` gallery + export |
