# Selfie → Avatar Reconstruction

This is the subsystem that turns a **user's photo** (or a text→image reference)
into a rigged, animation-ready 3D avatar. It is distinct from the Forge
generation lane in the [Avatar Pipeline](avatar-pipeline.md): the Forge generates
an *arbitrary* mesh from a prompt, whereas reconstruction fits a *specific
person* onto a fixed, pre-rigged template — the same architecture Avaturn and
Ready Player Me use, and the reason the output is born-rigged with facial
blendshapes instead of a bare mesh that still needs auto-rigging.

- **Worker:** [`workers/avatar-reconstruction/`](../workers/avatar-reconstruction) — FastAPI on a Cloud Run L4 GPU.
- **Backend provider:** [`api/_providers/gcp.js`](../api/_providers/gcp.js), selected by `AVATAR_REGEN_PROVIDER=gcp` (see [`api/_lib/regen-provider.js`](../api/_lib/regen-provider.js)).
- **User entry points:** the selfie/upload flow and text→avatar prompt flow in [`api/avatars/_actions.js`](../api/avatars/_actions.js) (`POST /api/avatars/reconstruct`).

## How it works

The avatar is a fixed-topology Wolf3D/RPM template that ships **pre-rigged** with
a humanoid skeleton and **52 ARKit blendshapes + 15 visemes**. Reconstruction
never generates a new mesh; it fits the person onto that template in two phases.

### Phase 1 — Face texture transfer

`face_pipeline.py`: MediaPipe FaceLandmarker finds 468 landmarks on the best
frontal photo, a thin-plate-spline warp maps the face into the template's skin-UV
space, it is composited over the face-oval region, and skin / hair / eye colours
are sampled and tinted for consistency. Output: the template body wearing the
person's face *texture*.

### Phase 2 — Face geometry morph

Texture alone leaves the *shape* generic — same jaw, nose, brow and face width as
the template, so the avatar looks like a sticker on a mannequin. `face_geometry.py`
closes that gap:

1. Umeyama similarity-aligns the 468 detected landmarks onto MediaPipe's neutral
   **canonical face model**, so the person's face and the reference share a frame.
2. The residual `(person − canonical)` on a **stable identity subset** (face
   oval, nose, cheeks, brow, jaw — expression-prone eye/lip points excluded) is
   the person's shape deviation from neutral.
3. That displacement is carried onto the head's corresponding vertices (a
   nearest-vertex map precomputed by `precompute_uv.py`), scaled into head units,
   and clamped to reject landmark/pose outliers.
4. A **normalised-Gaussian RBF** (partition of unity — local, bounded, no
   extrapolation) diffuses the sparse displacements across all 2162 head vertices,
   with a locality mask that fades the morph to zero off the face so the scalp,
   ears and neck stay put.

Because vertex count and order never change, `glb_ops.set_head_geometry` writes
the morphed positions (and recomputed normals) back **without disturbing the
skinning weights or any of the 67 blendshape morph targets** — the rig and every
ARKit expression survive intact. This is verified end-to-end in
[`test_face_geometry.py`](../workers/avatar-reconstruction/test_face_geometry.py).

Toggle Phase 2 with the `GEOMETRY_MORPH` env var (default `1`). It degrades
cleanly to texture-only if anything fails; the shape refinement never fails a job.

> **Fixed in this change:** `precompute_uv.py` and `glb_ops` previously read the
> interleaved head buffer stride-unaware, so `face_uv_map.json` was built on
> corrupted vertex data. The reader is now stride-aware, which also repairs the
> Phase-1 texture correspondence.

## Licensing — why this stack

Every stage is commercial-clean (Apache-2.0 / MIT / CC0). The dominant constraint
in single-image avatar reconstruction is that the best-known 3D face and body
models are **non-commercial**: FLAME and the Basel Face Model (BFM) are academic
licences, and the whole SMPL/SMPL-X family is Max-Planck non-commercial. Anything
built on them (DECA, EMOCA, MICA, ICON, ECON, PIFuHD, …) inherits that restriction.
The Phase-2 morph uses only **MediaPipe Face Mesh** (Apache-2.0) — no 3DMM — so it
is unencumbered.

## Roadmap — beating Avaturn on fidelity

Phase 2 captures gross face identity (proportions, projection) but not fine
geometry. The path to and past Avaturn quality, with the verified licence for
each link:

| Version | Upgrade | Model | Licence verdict |
|---|---|---|---|
| **v1 (this)** | Real face-shape morph | MediaPipe Face Mesh | Apache-2.0 — clean |
| **v2** | Dense, detailed face geometry via non-rigid ICP onto the template | **FaceLift** (ICCV'25) or HRN re-based on **FLAME-2023-Open** | FaceLift Apache-2.0; FLAME-2023-Open CC-BY-4.0 — clean (verify FaceLift base weights) |
| **v2** | Full-head photoreal texture (fills cheeks/ears/scalp the selfie can't see) | **Imagen** inpaint on Vertex AI | GCP — pre-approved |
| **v3** | Drop the RPM-template dependency for a fully-owned body | **Anny** (parametric body) + **ICT-FaceKit** (ARKit-52) + deformation transfer | Anny Apache-2.0 + CC0; ICT-FaceKit + DT MIT — clean |

Auto-rigging for the reconstruct-the-whole-body variant would use
**Make-It-Animatable** (Apache) or **UniRig** (MIT) → a Mixamo-standard skeleton
that drives the existing pre-baked clip library. The whole recommended chain runs
on one L4 (24 GB); an A100 is only needed for throughput, not any single stage.

## Deploy

The worker is already provisioned on Cloud Run GPU. From a clean tree:

```bash
gcloud builds submit \
  --config workers/avatar-reconstruction/cloudbuild.yaml \
  --substitutions _GCS_BUCKET=three-ws-avatar-reconstructions,SHORT_SHA=manual$(date +%s)
```

The backend needs no change — Phase 2 ships inside the same image and the
`POST /reconstruct` → `GET /jobs/:id` contract is unchanged. Verify with
`GET /health` (`"pipeline": "face_texture_transfer_v2"`, `"geometry_morph": true`).
Full runbook: [`docs/ops/gcp-production.md`](ops/gcp-production.md).
