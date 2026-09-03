# @three-ws/retarget

> **Retarget animations onto any humanoid GLB.** One package that maps any rig's bone names onto a canonical skeleton, retargets clips onto it with rest-pose and hip-axis correction, and drives them with a crossfading runtime, so no humanoid ever freezes in a T-pose.

This is the animation engine behind every avatar on [three.ws](https://three.ws): the same code that lets [`@three-ws/walk`](https://www.npmjs.com/package/@three-ws/walk), [`@three-ws/tour`](https://www.npmjs.com/package/@three-ws/tour), and the platform's viewers animate a GLB from **any** source without a curated rig allowlist. Extracted here so you can use it with plain Three.js.

**Rig conventions it understands out of the box:** Mixamo (`mixamorig:LeftArm`), Avaturn / Wolf3D, VRM 0.x / VRoid (`J_Bip_L_UpperArm`), VRM 1.0, Daz/Genesis, MakeHuman, Unreal mannequin, HumanIK/Maya, Blender `.L`/`.R`, bare `shoulderL`-style names, and casing/separator variants of all of them. A rig that genuinely isn't a skinned humanoid is detected and refused cleanly, never half-animated.

---

## Install

```bash
npm install @three-ws/retarget three
```

`three` is a peer dependency (>= 0.150).

## Quick start: play a clip on a rig it was never made for

```js
import { AnimationMixer } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { canonicalizeGLBBones, retargetClipToObject, parseClipJSON } from '@three-ws/retarget';

// 1. Canonicalize the avatar's bone names (byte-safe GLB rewrite, in memory).
//    three.ws GLBs are meshopt-compressed, hence the decoder.
const raw = await fetch('https://three.ws/avatars/xbot.glb').then((r) => r.arrayBuffer());
const { buffer } = canonicalizeGLBBones(raw);
const loader = new GLTFLoader();
loader.setMeshoptDecoder(MeshoptDecoder);
const gltf = await loader.parseAsync(buffer, '');

// 2. Retarget a canonical-space clip onto it. Rest-pose (A/T-pose) skew and
//    hip up-axis differences are corrected automatically.
const clipJSON = await fetch('https://three.ws/animations/clips/walk.json').then((r) => r.json());
const clip = parseClipJSON(clipJSON, 'walk');
const result = retargetClipToObject(clip, gltf.scene);
// result: { clip, coverage, matched, total, dropped, hipScale, face }

// 3. Play it with your own mixer (result.clip is null below the coverage gate).
if (result.clip) {
  const mixer = new AnimationMixer(gltf.scene);
  mixer.clipAction(result.clip).play();
}
```

When bone coverage is below `MIN_COVERAGE` (50%), the result comes back with `clip: null` plus the honest `coverage` / `dropped` breakdown. That is the "this isn't a humanoid" gate. Handle it; don't force-play.

## Or let the runtime drive everything

`AnimationManager` owns the mixer: it loads a clip library from a manifest, retargets per-rig, crossfades between states, layers one-shot overlays (wave, jump) over a base loop (idle, walk), and rejects clips that would leave the character fallen or broken.

```js
import { AnimationManager } from '@three-ws/retarget';

const manager = new AnimationManager();
manager.attach(gltf.scene);

if (manager.supportsCanonicalClips()) {
  manager.setAnimationDefs([
    { name: 'idle', url: 'https://three.ws/animations/clips/idle.json', loop: true },
    { name: 'walk', url: 'https://three.ws/animations/clips/walk.json', loop: true },
    { name: 'wave', url: 'https://three.ws/animations/clips/wave.json', loop: false },
  ]);
  await manager.loadAll();
  manager.crossfadeTo('idle', 0.25);
}

// per frame:
manager.update(deltaSeconds);
```

The clip URLs above are real: three.ws serves its shared clip library with open CORS, so the snippet runs as-is. Ship your own clips in production if you need guaranteed availability.

## API surface

**Canonicalize** (`glb-canonicalize`):
| Export | What it does |
| --- | --- |
| `CANONICAL_BONES` | The frozen 53-bone canonical humanoid set |
| `canonicalizeBoneName(name)` | One bone name → canonical name (or passthrough) |
| `canonicalizeJointNodes(json)` | Rename joints across a parsed glTF JSON tree |
| `canonicalizeArmatureOrientation(json)` | Normalize armature up-axis quirks |
| `canonicalizeGLBBones(arrayBuffer)` | The whole pipeline on a GLB binary, byte-exact when nothing needs changing |

**Retarget** (`animation-retarget`):
| Export | What it does |
| --- | --- |
| `retargetClipToObject(clip, root, opts?)` | Clip → any Object3D hierarchy (most common). Returns `{ clip, coverage, matched, total, dropped, hipScale, face }`; `clip` is `null` below the coverage gate |
| `retargetClipToRig(clip, rig, opts?)` / `retargetClip(clip, map, opts?)` | Lower-level variants when you already hold a rig/node map |
| `canonicalNodeMapFromObject/FromRig`, `canonicalRestMapFrom…`, `canonicalWorldRestMapFrom…` | Build the bone/rest lookups yourself |
| `hipsParentWorldQuat`, `hipRestHeight`, `hipRestLocalHeight`, `clipHipBaselineY` | Hip-space helpers (root motion, height normalization) |
| `scaleClipSpeed(clip, factor)`, `parseClipJSON(json, name)` | Clip utilities |
| `MIN_COVERAGE` | The humanoid-coverage gate (0.5) |

**Drive** (`animation-manager`):
| Export | What it does |
| --- | --- |
| `AnimationManager` | attach/detach, `setAnimationDefs`, `loadAll`, `crossfadeTo`, overlays, `supportsCanonicalClips()`, fallen-pose guards, `update(dt)` |
| `measureHipsTiltDeg(clip, model, map)` | Diagnostic: how far a retargeted clip tilts the hips |

**Reference data:** `CANONICAL_REST` and `CANONICAL_REST_WORLD` hold the canonical rig's rest quaternions the corrections are computed against.

## How it works

Retargeting quality comes from doing the correction in world space: for each bone the engine computes `q' = L · q · R`, where `L`/`R` are derived from the difference between the clip's canonical rest pose and the target rig's actual rest pose (so an A-pose character plays T-pose clips without shoulder skew), plus a hip-space fix for rigs whose hips aren't Y-up. Coverage below 50% of the canonical bones aborts the retarget instead of producing a half-puppet.

Hit a skeleton convention it doesn't know? Add the bone-name mapping to the canonicalizer and it works everywhere at once; that's the design: **map names once, never maintain a rig allowlist.**

## Related packages

- [`@three-ws/walk`](https://www.npmjs.com/package/@three-ws/walk): a walking avatar companion for any site, built on this engine
- [`@three-ws/tour`](https://www.npmjs.com/package/@three-ws/tour): guided site tours with a walking narrator
- [`@three-ws/page-agent`](https://www.npmjs.com/package/@three-ws/page-agent): a docked, talking page narrator

## License

Apache-2.0. See [LICENSE](./LICENSE).
