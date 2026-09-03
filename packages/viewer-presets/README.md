<p align="center">
  <a href="https://three.ws"><img src="https://three.ws/three-ws-mcp-icon.svg" width="72" height="72" alt="three.ws" /></a>
</p>

<h1 align="center">@three-ws/viewer-presets</h1>

<p align="center"><strong>Tuned light rig, floor reflection, and bloom presets for three.ws avatar viewers — visage-derived, framework-agnostic.</strong></p>

<p align="center">
  <a href="https://www.npmjs.com/package/@three-ws/viewer-presets"><img alt="npm" src="https://img.shields.io/npm/v/@three-ws/viewer-presets?logo=npm&color=cb3837"></a>
  <a href="https://www.npmjs.com/package/@three-ws/viewer-presets"><img alt="downloads" src="https://img.shields.io/npm/dm/@three-ws/viewer-presets?color=cb3837"></a>
  <img alt="license" src="https://img.shields.io/npm/l/@three-ws/viewer-presets?color=3b82f6">
  <img alt="node" src="https://img.shields.io/node/v/@three-ws/viewer-presets?color=339933&logo=node.js">
</p>

<p align="center">
  <a href="#install">Install</a> ·
  <a href="#usage">Usage</a> ·
  <a href="#presets">Presets</a> ·
  <a href="#api">API</a> ·
  <a href="https://three.ws">three.ws</a>
</p>

---

> `@three-ws/viewer-presets` is a small, data-first package of visual presets for
> 3D avatar viewers: a five-light rig, floor-reflection parameters, and a bloom
> configuration. The tuning values are derived from Ready Player Me's open-source
> [`visage`](https://github.com/readyplayerme/visage) viewer (MIT) and re-tuned for
> three.ws, so avatars render color-accurate to that reference setup. It's
> framework-agnostic: presets are plain frozen objects, and the one factory
> (`buildLightRig`) takes your `THREE` namespace as an argument instead of importing
> Three.js itself.

## Install

```bash
npm install @three-ws/viewer-presets
```

`three` (`>=0.150.0`) is an **optional** peer dependency — only `buildLightRig()`
touches it, and you pass your own `THREE` namespace in. The preset constants and the
`floorReflectionConfig` / `bloomConfig` helpers are pure data and need nothing.

## Usage

```js
import * as THREE from 'three';
import { buildLightRig, floorReflectionConfig, bloomConfig } from '@three-ws/viewer-presets';

// 1. Build the five-light avatar rig as a THREE.Group and add it to your scene.
const { group, headTarget, shoeTarget } = buildLightRig(THREE);
scene.add(group);

// 2. Floor reflection config — `color` must match your canvas background.
const floor = floorReflectionConfig({ color: '#0b0b12' });
// feed `floor` into MeshReflectorMaterial (or your own reflector)

// 3. Bloom config — feed into the `postprocessing` Bloom effect (or equivalent).
const bloom = bloomConfig({ intensity: 0.15 });
```

You can also import each preset from its own subpath:

```js
import { LIGHT_CONFIG, buildLightRig } from '@three-ws/viewer-presets/lights';
import { FLOOR_REFLECTION_DEFAULTS, floorReflectionConfig } from '@three-ws/viewer-presets/floor';
import { BLOOM_DEFAULTS, bloomConfig } from '@three-ws/viewer-presets/bloom';
```

## Presets

### Light rig (`./lights`)

`buildLightRig(THREE, overrides?)` returns a `THREE.Group` containing five spotlights
— fill (blue rim), back (warm rim), key (soft face fill), lift (body/shoe wash), and
silhouette (arms/legs) — plus a head target and shoe target the lights aim at.
Positions, angles, intensities, and colors come from `LIGHT_CONFIG`; `overrides`
patches the `defaults` block (e.g. `keyLightIntensity`, `fillLightColor`,
`backLightPosition`, `lightTarget`).

### Floor reflection (`./floor`)

`FLOOR_REFLECTION_DEFAULTS` holds reflector parameters (`resolution`, `mixBlur`,
`mixStrength`, `blur`, `mirror`, depth thresholds, `planeSize`, fog range, …) using
the same names as visage's `FloorReflection` component. `floorReflectionConfig(props)`
merges your overrides; `color` is **required** and should match the canvas background
so the plane fades in seamlessly.

### Bloom (`./bloom`)

`BLOOM_DEFAULTS` is a verbatim-tuned bloom config (`luminanceThreshold`,
`luminanceSmoothing`, `mipmapBlur`, `intensity`, `kernelSize`).
`bloomConfig(overrides?)` merges your changes over it.

### Materials (`./materials`)

Where the rig above tunes how a scene is *lit*, this module tunes how a model's
*surfaces* read. `MATERIAL_PRESETS` is a curated set of physically-plausible
looks — `chrome`, `gold`, `copper`, `brushedSteel`, `gunmetal`, `matte`,
`glossy`, `rubber`, `ceramic`, `glass`, `realGlass`, `wood`, `stone`, `fabric`,
`skin`, `carPaint`, `neon`, `holographic` — each a frozen parameter set.

Most presets are plain `MeshStandardMaterial` fields (color, metalness,
roughness, emissive, envMapIntensity, transparency for the legacy `glass`).
A few use **measured, physically-real** `MeshPhysicalMaterial`-only fields —
`applyMaterialPreset` writes these when the target material has the field and
silently skips them on a plain Standard material:

| Preset | Physical fields | Real-world basis |
|---|---|---|
| `skin` | `sheen`, `sheenColor`, `sheenRoughness`, `specularIntensity` | roughness 0.45–0.6 (measured bare-skin range), 0 metalness, sheen approximates subsurface scattering, specular F0 below the 0.04 default (skin reflects ~2.8%) |
| `carPaint` | `clearcoat`, `clearcoatRoughness` | KHR_materials_clearcoat — a near-mirror lacquer layer over a metallic base coat |
| `realGlass` | `transmission`, `thickness`, `ior`, `attenuationColor`, `attenuationDistance` | KHR_materials_transmission — real refraction, not alpha blending; `ior: 1.45` is soda-lime glass |
| `brushedSteel` | `anisotropy`, `anisotropyRotation` | KHR_materials_anisotropy — directional micro-groove scattering from brushing |
| `fabric` | `sheen`, `sheenColor`, `sheenRoughness` | soft grazing-angle highlight woven cloth shows |

`realGlass` and `glass` are deliberately both kept: `glass` is the cheap
opacity-blend look (works on any renderer, any material type); `realGlass`
needs a `MeshPhysicalMaterial` and the renderer's transmission pass but
actually refracts what's behind it.

```js
import { applyMaterialPreset, materialVariants } from '@three-ws/viewer-presets/materials';

// Re-skin every standard material on a loaded glTF, non-destructively:
const handle = applyMaterialPreset(THREE, gltf.scene, 'chrome');
// … later, put it back exactly as it was:
handle.restore();

// Fan a base look out into reproducible colorway variants (same seed → same set):
const variants = materialVariants('gold', { seed: 42, count: 6 });
variants.forEach((v) => console.log(v.label, v.config.color));
```

`applyMaterialPreset` only touches materials that expose the standard PBR knobs
(a `MeshBasicMaterial`, sprite, or line material is skipped), captures the prior
values, and hands back a `restore()` — so edits are a reversible layer over the
original asset. `materialVariants` is pure and deterministic per `seed`, aligning
with Forge's `seed` semantics so a variant set is shareable by number.

## API

| Export | Signature |
|---|---|
| `buildLightRig(THREE, overrides?)` | `(THREE, Partial<LightingOverrides>) => { group, headTarget, shoeTarget }` |
| `LIGHT_CONFIG` | Frozen `LightConfig` (angles, positions, and a `defaults` overrides block). |
| `floorReflectionConfig(props)` | `(Partial<FloorReflectionProps> & { color }) => FloorReflectionProps`; throws if `color` is missing. |
| `FLOOR_REFLECTION_DEFAULTS` | Frozen floor-reflection defaults (no `color`). |
| `bloomConfig(overrides?)` | `(Partial<BloomProps>) => BloomProps` |
| `BLOOM_DEFAULTS` | Frozen bloom defaults. |
| `MATERIAL_PRESETS` / `MATERIAL_PRESET_NAMES` | Frozen map of PBR presets, and their ids in order. |
| `materialPreset(idOrConfig, overrides?)` | `(string \| Partial<MaterialPreset>, overrides?) => MaterialPreset`; throws on unknown id. |
| `applyMaterialPreset(THREE, root, idOrConfig, opts?)` | `(THREE, Object3D, preset) => { restore(), count }` — non-destructive. |
| `materialVariants(base, opts?)` | `(preset, { seed, count, hueSpread, jitter }) => MaterialVariant[]` — seeded, reproducible. |

## Requirements

- Node `>=18`.
- Optional peer dependency: `three` `>=0.150.0` (only for `buildLightRig`; passed in, not imported).
- Run the test suite with `npm test` (Node's built-in `node:test`).

## Attribution

Preset values are derived from Ready Player Me's `visage` viewer (MIT) and re-tuned
for three.ws. See [NOTICE](./NOTICE) for details. This package is distributed under
the Apache-2.0 license; see [LICENSE](./LICENSE).

## Related packages

- [`@three-ws/avatar`](https://www.npmjs.com/package/@three-ws/avatar) — the avatar SDK whose viewer these presets are tuned for.
- [`@three-ws/agent-ui`](https://www.npmjs.com/package/@three-ws/agent-ui) — the avatar-overlay SDK.

## Links

- Homepage: https://three.ws
- Changelog: https://three.ws/changelog
- Issues: https://github.com/nirholas/three.ws/issues
- License: Apache-2.0, see [LICENSE](./LICENSE)

---

<p align="center">
  <sub>
    Part of the <a href="https://three.ws">three.ws</a> SDK suite — 3D AI agents, on-chain identity, and agent payments.<br/>
    <a href="https://three.ws">Website</a> · <a href="https://three.ws/changelog">Changelog</a> · <a href="https://github.com/nirholas/three.ws">GitHub</a>
  </sub>
</p>
