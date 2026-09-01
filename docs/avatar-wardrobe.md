# Additive Wardrobe — dress any avatar from the garment catalog

The wardrobe has two halves. The **subtractive** half has existed for a while:
recolour or hide the garment layers an avatar's GLB already contains
(`src/avatar-wardrobe.js`). This document covers the **additive** half: putting
a garment ON an avatar that was never generated with it — a catalog shirt onto
a Forge-generated character, a hairstyle onto a selfie reconstruction.

Open any avatar in the editor (`/avatar-edit?id=…`), Wardrobe tab. The layer
cards for the model's built-in garments render first; the **Closet** renders
beneath them with one rack per slot (tops, bottoms, footwear, outerwear, hair,
headwear, glasses, accessories). Click a piece to wear it, click again or "Take
off" to remove it. Saving the avatar persists what it wears, and the baked GLB
served to embeds, AR, and external engines includes the garments.

The catalog also has a standalone public surface: `/wardrobe`
([`src/wardrobe-page.js`](../src/wardrobe-page.js)) browses every published
wearable (search, per-slot filter, inline 3D inspection, jump into the editor
to wear it) and runs the text-prompt generator lane over the same
`POST /api/garment-forge` proxy described below.

## Why this is not the usual wardrobe

Commercial avatar platforms author every garment against one skeleton they
control, so "attach" is trivial — and their wardrobe only fits avatars from
their own generator. Ours binds at runtime instead: a garment authored on its
own skeleton, with its own bone naming and its own rest pose, is rebound onto
whatever humanoid is loaded. That works because the platform already
normalises arbitrary rigs to a canonical bone set
([`src/glb-canonicalize.js`](../src/glb-canonicalize.js)) — the same machinery
that lets any humanoid drive the animation clip library.

Concretely, `attachGarment()`:

1. rewrites the garment's skin indices from garment-bone-order into
   avatar-bone-order by canonical name, with helper/twist joints the avatar
   lacks falling back to their nearest mapped ancestor;
2. re-indexes the garment's inverse bind matrices, keeping the **garment's**
   values where the two skeletons correspond — which is what makes a T-pose
   garment land correctly on an A-pose avatar;
3. refuses any garment that binds under 60% of its skin **weight**
   (`MIN_BIND_COVERAGE`) rather than attaching a mesh that would deform into
   garbage;
4. refuses any garment whose bounding extent on any axis exceeds 0.75x the
   avatar's height (`MAX_GARMENT_EXTENT_RATIO`). Bind coverage proves a mesh
   deforms correctly and says nothing about its size; the catalog is public
   and long-lived, so a malformed piece published before the forge's own
   proportion gate, or supplied by a third party, is refused at wear time
   too, not just at publish time;
5. masks the body in the regions the garment declares it covers
   (`occludes`), so skin never pokes through cloth. Declarations are clamped
   at apply time to the slot's plausible region set (`SLOT_OCCLUDABLE` in
   [`src/garment-taxonomy.js`](../src/garment-taxonomy.js)): a shirt cannot
   hide the legs, and headwear/hair can hide nothing at all, because the
   `scalp` region resolves to the Head bone and culling it would take the
   avatar's face with it. The same clamp runs in the server-side baker, so a
   legacy or third-party manifest can never produce a defaced avatar.

A garment with no skin at all (hat, glasses) is parented to a single joint
(`rig.attachBone`) instead of deformed.

## The pieces

| Piece | Where | Job |
|---|---|---|
| Attachment engine | [`src/avatar-garment.js`](../src/avatar-garment.js) | Skin rebind, occlusion, slot occupancy — the runtime core |
| Shared taxonomy | [`src/garment-taxonomy.js`](../src/garment-taxonomy.js) | Slots, body regions, region→bone map, coverage gate |
| Catalog loader | [`src/garment-catalog.js`](../src/garment-catalog.js) | Fetch (three bounded attempts, then the last copy this browser loaded) + validate manifests; drops anything malformed or unlicensed |
| Closet UI + controller | [`src/garment-closet.js`](../src/garment-closet.js) | Racks/tiles in the editor, attach/detach queue, appearance sync |
| Editor wiring | [`src/avatar-edit.js`](../src/avatar-edit.js) | Hydrate on load, persist `appearance.garments`, reset/save |
| Region mask (pixel-exact occlusion) | Baker [`scripts/build-body-region-mask.mjs`](../scripts/build-body-region-mask.mjs) → `public/avatars/parametric-base.regions.png`, sampler [`src/garment-region-mask.js`](../src/garment-region-mask.js) | On the parametric base, worn garments cut the skin via a baked UV mask (alphaMap) instead of triangle culling; any other body falls back to bone-cull |
| Server schema | [`api/_lib/validate.js`](../api/_lib/validate.js) | `appearance.garments` — one garment per slot, catalog-shaped refs |
| Bake pass | [`api/_lib/bake-garments.js`](../api/_lib/bake-garments.js) | Same rebind on the @gltf-transform document, so exports are dressed |
| Manifest contract | [`specs/GARMENT_MANIFEST.md`](../specs/GARMENT_MANIFEST.md) | What a wearable must declare to enter the catalog |

## The catalog

One public JSON array of Garment Manifest v1 documents:

```
https://storage.googleapis.com/three-ws-garments/garments/catalog.json
```

Assets live under `garments/<slot>/<id>/v<version>/` in the same bucket, one
immutable directory per version. Every manifest pins its GLB's `sha256`; both
the client and the baker verify the bytes before attaching, so a swapped or
truncated download is refused, never worn.

Validation is strict and central (`validateManifest`): unknown spec, unknown
slot, unknown body region, malformed hash, or a licence outside the approved
commercial set (CC0, CC-BY, MIT, Apache-2.0, BSD) drops the entry with a
console warning. A broken manifest becomes a missing tile, not a broken avatar.

`loadCatalog()` fetches the file with a 10 s deadline and retries a 5xx or a
dropped connection twice more before giving up; a 4xx is final. When every
attempt fails it falls back to the copy the browser last loaded (kept in
`localStorage` under `three.ws:garment-catalog:<url>` for 24 hours) and logs a
warning, so a bucket blip no longer empties the closet. Only with no cached copy
does the load reject. The server-side baker reads the same URL through the shared
`fetchUpstream` helper (15 s deadline, two attempts) and caches it for five
minutes.

## Generating new garments

The catalog is fed by the Garment Forge
([`workers/garment-forge/`](../workers/garment-forge/README.md)): a text
prompt becomes a rigged, validated, published catalog piece in about seven
minutes. The platform endpoint is a thin proxy over that worker:

```
POST /api/garment-forge   { "prompt": "a red varsity jacket", "slot": "outerwear" }
                          → 202 { job_id, status, eta_seconds }
GET  /api/garment-forge?job=<id>
                          → { status, stage, glb_url, manifest_url, coverage, occludes }
```

The proxy gives a submit one attempt with a 60 s deadline (it starts a GPU job,
so it is not safely repeatable) and a job read three attempts at 10 s each; both
share the `garment-forge-worker` circuit breaker, so a dead worker answers every
caller with `502 garment_forge_unavailable` at once instead of each paying the
full deadline.

`stage` walks `image → mesh → compose → rig → extract → validate → publish`.
When the job reports `done`, the piece is already live in the catalog above;
a closet refresh (`loadCatalog({ force: true })`) shows it immediately. Every
published piece passed the same ≥60% bind-coverage gate the closet enforces,
measured against the canonical body before publish, so a generated garment
can never be a tile the closet then refuses to wear. Offline proof harness:
`node scripts/verify-garment.mjs <manifest url> [avatar.glb]`.

Seven minutes is longer than most people keep a tab open, so `/wardrobe` saves
the job id in `localStorage` under `twx_wardrobe_job` and resumes polling on
the next visit. That resume is deliberately bounded, because a saved id that
can never resolve would otherwise leave the generator disabled forever:

- a `404` (or `job_not_found`) is **terminal**, not a blip. The saved id is
  dropped, the form unlocks, and the page says the job is no longer on the
  forge. Finished jobs are cleared upstream, so this is the normal end state
  for a resume that arrives too late;
- any other poll failure is treated as transient and retried on a longer
  interval, up to six consecutive failures. After that the form unlocks and
  the page says the job is still saved and a reload will pick it back up. The
  id survives, so a genuine outage never destroys a running generation.

## Persistence shape

```json
"appearance": {
  "garments": [
    { "slot": "top", "id": "oxford-shirt-white" },
    { "slot": "footwear", "id": "low-top-sneakers" }
  ]
}
```

One garment per slot, max 8, enforced by the zod schema. Existence against the
live catalog is deliberately NOT checked at save time — a garment retired from
the catalog later degrades to "not worn" on the next load/bake instead of
bricking the avatar.

## Failure posture

- Garment can't reach the skeleton → refused with the measured coverage in the
  reason string; the slot keeps its previous occupant.
- Catalog unreachable → the closet serves the last catalog this browser loaded;
  with no cached copy it shows a retry state. The rest of the editor is
  unaffected either way.
- Bake-time garment failure → logged and skipped; the bake always lands.
- Non-humanoid model → the closet is withheld (`supportsWardrobe` gate), same
  policy as the animation library's humanoid gate.

## Related

- [`docs/avatar-reconstruction.md`](avatar-reconstruction.md) — selfie → avatar
- [`docs/avatar-fidelity-program.md`](avatar-fidelity-program.md) — identity fidelity program
- [`specs/GARMENT_MANIFEST.md`](../specs/GARMENT_MANIFEST.md) — the wearable contract
