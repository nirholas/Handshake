# three.ws Garment Manifest v1

The document that describes one wearable asset (a top, a pair of shoes, a hairstyle, a pair of glasses) well enough for the runtime to attach it to **any** humanoid avatar the platform can load, without knowing where the avatar came from.

- **Type URI:** `https://three.ws/specs/garment-manifest-v1`
- **Runtime consumer:** [`src/avatar-garment.js`](../src/avatar-garment.js) (`attachGarment`, `applySkinOcclusion`)
- **Slot taxonomy shared with:** [`src/avatar-wardrobe.js`](../src/avatar-wardrobe.js) (the subtractive hide/tint panel)
- **Companion specs:** [3D_AGENT_CARD.md](3D_AGENT_CARD.md) (model URI + hash conventions, reused verbatim here), [PROVENANCE_3D.md](PROVENANCE_3D.md)

## Why

A wardrobe only works if a garment and an avatar that have never met can be combined at runtime. The usual industry answer is to author every garment against one vendor-controlled skeleton, which makes attachment trivial and makes the wardrobe useless for any avatar produced elsewhere.

We take the harder contract because we already normalise arbitrary rigs to a canonical bone set in [`glb-canonicalize.js`](../src/glb-canonicalize.js). A garment therefore does **not** need to match the avatar's skeleton, its bone naming convention, or its rest pose. It needs to declare enough for the runtime to *reconcile* those differences, and to know what part of the body it hides.

This spec pins exactly that minimum.

## The document

```json
{
  "spec": "https://three.ws/specs/garment-manifest-v1",
  "id": "oxford-shirt-white",
  "name": "Oxford Shirt",
  "slot": "top",
  "version": 1,
  "model": {
    "uri": "https://storage.googleapis.com/three-ws-model-weights/garments/top/oxford-shirt-white/v1/garment.glb",
    "format": "gltf-binary",
    "sha256": "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
    "sizeBytes": 184320,
    "triangleCount": 4812
  },
  "rig": {
    "skeleton": "three.ws-canonical-v1",
    "bindPose": "a-pose",
    "bones": ["Hips", "Spine", "Spine1", "Spine2", "LeftArm", "LeftForeArm", "RightArm", "RightForeArm"]
  },
  "occludes": ["torso", "upperArms"],
  "materials": { "tintable": true, "palette": "garment" },
  "license": "CC0-1.0",
  "source": { "kind": "authored", "author": "three.ws" },
  "preview": { "thumbnail": "…/v1/thumb.webp" }
}
```

### Required fields

| Field | Notes |
|---|---|
| `spec` | Pins the version. Consumers MUST reject an unknown spec URI rather than guess. |
| `id` | Stable, kebab-case, unique within a slot. Forms the storage path. |
| `slot` | One of the slots below. One garment per slot; attaching evicts the incumbent. |
| `model.uri` | HTTPS or `ipfs://`. Must be CORS-readable by the viewer origin. |
| `model.format` | `gltf-binary` today. The runtime binds GLB skinned meshes. |
| `model.sha256` | Lowercase hex of the model bytes, so a consumer can verify independently. Same convention as [3D_AGENT_CARD.md](3D_AGENT_CARD.md). |
| `rig.skeleton` | `three.ws-canonical-v1` means every bone name canonicalises to a member of `CANONICAL_BONES`. |
| `occludes` | Body regions this garment covers. `[]` is legal for a garment that hides nothing (glasses, earrings). |
| `license` | SPDX identifier. A garment with no clear commercial licence MUST NOT enter the catalog. |

### Slots

`top`, `bottom`, `footwear`, `outerwear`, `hair`, `headwear`, `glasses`, `accessory`.

Mirrors `GARMENT_SLOTS` in [`avatar-garment.js`](../src/avatar-garment.js). A garment covering torso and legs as one mesh (a dress, a jumpsuit) takes `top` and declares both regions in `occludes`.

### Body regions

`torso`, `upperArms`, `lowerArms`, `hands`, `hips`, `upperLegs`, `lowerLegs`, `feet`, `neck`, `scalp`.

The runtime hides the avatar's skin in every declared region so it cannot poke through the cloth. Over-declaring is safer than under-declaring: a hidden square centimetre of skin is invisible, an exposed one is the single most obvious artefact in any additive wardrobe.

### Rest pose is free, naming is not

`rig.bindPose` is **advisory**. The runtime reconciles a divergent rest pose automatically by carrying the garment's own bone inverses through the rebind, so a T-pose garment lands correctly on an A-pose avatar. Authors do not need to match a reference pose.

Bone **naming** is likewise free at authoring time: `mixamorig:LeftArm`, `arm_L`, `J_Bip_L_UpperArm` all canonicalise. What is *not* free is bone **coverage**. The runtime refuses any garment that binds under **60%** of its skin weight to bones the avatar actually has (`MIN_BIND_COVERAGE`), because below that the mesh deforms into garbage. Coverage is measured by weight, not bone count: a garment may leave twenty unused twist joints unresolved and still bind perfectly.

Bones the avatar lacks fall back to their nearest mapped ancestor, so helper and twist joints degrade gracefully rather than dropping their vertices.

### Rigid garments

A garment whose meshes are **not** skinned (a hat, glasses, an earring) needs no rig block beyond `rig.skeleton`. The runtime parents it to a single joint instead of deforming it. Declare the joint with `rig.attachBone` (canonical name, e.g. `Head`). Rigid meshes keep their authored offset relative to that joint, so position them against a reference avatar at the origin.

### Provenance

`source.kind` is `authored` or `generated`. Generated garments MUST record what produced them, so a catalog entry is reproducible and auditable:

```json
"source": {
  "kind": "generated",
  "prompt": "a white oxford cotton dress shirt, long sleeves, buttoned",
  "model": "hunyuan3d-2.1",
  "seed": 41552,
  "pipeline": "garment-forge@1"
}
```

## Catalog

A catalog is a JSON array of manifests served from one URL, so the wardrobe panel does one fetch:

```
gs://three-ws-model-weights/garments/catalog.json
```

Storage layout, one immutable directory per version so a published garment is never mutated under a live client:

```
gs://three-ws-model-weights/garments/<slot>/<id>/v<version>/
    garment.glb
    manifest.json
    thumb.webp
```

Publishing a change means writing `v<n+1>` and appending to the catalog, never overwriting `v<n>`.

## Validation

A manifest is valid when all of the following hold. Rejection is the correct response to any failure; a broken garment must not reach a user's avatar.

1. `spec` matches a known version URI.
2. `slot` is a member of the slot list.
3. Every entry in `occludes` is a member of the region list.
4. `model.sha256` matches the fetched bytes.
5. The GLB loads, and its skinned meshes bind at or above `MIN_BIND_COVERAGE` against the canonical skeleton.
6. `license` is a recognised SPDX identifier permitting commercial use.
