# Avatar Composer

A modular avatar generation engine. It assembles a rigged, expression-ready GLB
by mixing skinned body parts across the platform's Ready-Player-Me / Wolf3D base
bodies onto **one shared skeleton**, then recolors each part and scales the rig.
This is the same "one skeleton, many swappable parts" architecture Ready Player
Me and Avaturn use for customization: built here in pure JavaScript on
`@gltf-transform`, with no GPU, no external service, and no per-avatar cost.

## Why it exists

The old studio lane (`api/_lib/studio-avatar.js`) could only **recolor one of
five fixed base bodies**. Every "East Asian senior woman" and "Nordic young
woman" was the same mesh with a different tint, so the gallery filled with
people who looked alike. The composer instead treats those base bodies as a
**parts kit**: each one ships its hair, top, bottom, footwear, and glasses as
separate skinned meshes on a byte-identical 67-joint skeleton, so a hairstyle
from one body and an outfit from another compose onto a third body's face and
skin. Combined with per-part recolor and height scaling, one diversity profile
now yields tens of thousands of genuinely distinct avatars.

## How it works

1. **Identity**: one base provides the face, body, eyes, teeth (and their 60+
   ARKit expression blendshapes). This matches the requested gender.
2. **Swappable slots**: hair, top, bottom, footwear, glasses are each sourced
   independently from any base in the identity's **rest-pose group** (see below).
   A borrowed part keeps its **own** inverse-bind matrices (the only ones correct
   for that part's region) but has its skin's joints remapped onto the identity
   skeleton, so the whole avatar animates as one rig.
3. **Recolor**: each part's material `baseColorFactor` is multiplied by the
   colorway channel (skin / hair / top / bottom / footwear).
4. **Scale**: a uniform height multiplier on the rig root.
5. **Optimize**: `dedup` → `prune` → `meshopt`, written as a single-buffer GLB.

### Rest-pose groups

A part is authored to fit one body's proportions. Grafted onto a body with a
different skeleton *rest pose*, it keeps its own vertices and can float or misfit
(measured: the feet detach across groups). Bases are therefore grouped by rest
pose, and the composer only mixes parts **within a group**, where the fit is
exact:

| Group | Bases | Hips bind height |
|---|---|---|
| `a` | `realistic-male`, `realistic-female` | 0.967, 1.009 |
| `b` | `default`, `selfie-girl` | 1.037 |

Cross-group mixing (which needs true vertex rebinding) is the planned v2.

## Public API

```js
import { composeStudioAvatar } from './index.js';
```

- `composeStudioAvatar({ profile, seed, loadBase })` → `{ bytes, recipe, descriptor, meshes, recolored }`
  End-to-end: selects a recipe from the profile + seed, loads the needed bases via
  your `loadBase(id)`, and returns the composed GLB bytes. Deterministic on `seed`.
- `selectRecipe(profile, seed)` → recipe `{ identity, slots, colorway, scale, descriptor }`
- `basesNeeded(recipe)` → `string[]` of base ids the recipe requires bytes for
- `composeAvatar(recipe, bytesByBase)` → `{ bytes, meshes, recolored }` (the pure core)
- `combinationCount()` → rough count of distinct part-mesh combinations
- `BASES`, `BASE_BY_ID`: the parts catalog

`profile` fields (all optional): `gender` (`'male'|'female'`), `ethnicityKey`,
`ageKey`, `grayBias`, `build`. These come from `pickDiversityProfile()` in
`api/_lib/avaturn-seed.js`; the colorway and scale reuse `api/_lib/studio-avatar.js`.

## Example

```js
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { composeStudioAvatar } from './index.js';

// loadBase returns a base body's GLB bytes by id. On disk here; in the seed cron
// it fetches https://three.ws/avatars/<id>.glb.
const loadBase = async (id) =>
  new Uint8Array(readFileSync(resolve('public/avatars', `${id}.glb`)));

const { bytes, descriptor } = await composeStudioAvatar({
  profile: { gender: 'female', ethnicityKey: 'east-asian', ageKey: 'young-adult', build: 'slim' },
  seed: 'demo-seed-1',
  loadBase,
});

console.log(descriptor.identity, descriptor.parts); // e.g. selfie-girl { hair:'default', top:'selfie-girl', ... }
// `bytes` is a valid, rigged, ARKit-expression-ready GLB: write it to R2, etc.
```

## Consumers

- `api/cron/avaturn-seed-cron.js`: the studio seed lane composes each avatar
  here (falling back to the legacy single-base recolor if composition fails).

## Tests

`tests/avatar-composer.test.js`: selection determinism, the rest-pose-group
rule, and a full compose validated with `gltf-validator` (0 errors) that checks
the output is rigged and carries ARKit blendshapes.

## Limits / roadmap

- **Cross-group part mixing** needs vertex rebinding (deform a part to the target
  rest pose); today it is restricted to same-group for an exact fit.
- **Body-shape variety** (weight, height, proportions) needs real body morphs,
  which the RPM bases don't carry: a parametric-body backbone (MakeHuman CC0 /
  Google GHUM Apache-2.0) is the path.
- **Bone-attached accessories** (`public/accessories/` hats, glasses, earrings)
  ride a bone, not the skin, so they compose cross-base safely: a clean next add
  via the existing `api/_lib/bake.js` merge.
