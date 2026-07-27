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
- **Completion:** normally driven by the browser polling `/api/avatars/regenerate-status`, which runs the finalize stages inline. [`api/cron/reconstruct-sweep.js`](../api/cron/reconstruct-sweep.js) is the server-side backstop for when it isn't — see below.

## Who finishes the job

A reconstruct job is advanced by whoever polls it. The `/create/selfie` page
polls every few seconds, and each poll pulls provider status and runs the shared
finalize stages in [`reconstruct-finalize.js`](../api/_lib/reconstruct-finalize.js).

That made the browser tab load-bearing. Close it mid-build and the worker still
finished the GLB and stored it durably in GCS, but nothing ever collected it: the
job row stayed `queued`/`running` forever and the avatar never reached the user's
library. Production had 26 jobs stranded that way, the oldest from 2026-05-31,
invisible to `db-retention` (which only prunes terminal rows).

`reconstruct-sweep` closes that hole. Every 5 minutes it picks up reconstruct
jobs quiet for over 3 minutes and runs **the same finalize stages** the browser
poll would have, so an abandoned job still lands in the library. Design notes:

- **30-day rescue window**, far longer than the auto-rig sweep's 6 hours. The
  worker's GLBs (GCS) and job state (Firestore) are both durable, so a weeks-old
  abandoned job is still genuinely deliverable to a real user.
- Past that window, and for jobs whose provider is no longer pollable with
  platform credentials, rows are failed out with an honest reason — the open set
  must not grow without bound.
- **BYOK jobs (meshy/tripo) stay browser-driven.** They authenticate with the
  user's own key, which the status poll resolves from request context; a cron has
  no user context to decrypt it. They age out via the same window.
- A provider 404 (`gcp_task_missing`) is terminal here, so a job whose worker
  record is genuinely gone resolves instead of being retried forever.

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
4. A **thin-plate spline** interpolates the sparse displacements across all 2162
   head vertices. TPS passes exactly through its control points, so localised
   identity (a wider jaw, a longer nose) survives instead of being averaged away
   — the failure mode of normalised-Gaussian/Shepard weighting. TPS extrapolates
   freely, so a Gaussian locality mask fades the field to zero off the face and
   the scalp, ears and neck stay put.

`strength` and `max_displacement_frac` default to **0.6 / 0.45**, chosen by an
ISE sweep over the 40-face reference set (`python -m eval.tune_morph`), not by
eye. They cut mean ISE 43% against the original 0.75 / 0.18, whose ~1.9 cm
displacement ceiling was throttling genuine facial variation rather than
rejecting outliers. See [avatar-fidelity-program.md](avatar-fidelity-program.md)
for why the sweep's own looser optimum was deliberately not shipped.

Because vertex count and order never change, `glb_ops.set_head_geometry` writes
the morphed positions (and recomputed normals) back **without disturbing the
skinning weights or any of the 67 blendshape morph targets** — the rig and every
ARKit expression survive intact. This is verified end-to-end in
[`test_face_geometry.py`](../workers/avatar-reconstruction/test_face_geometry.py).

Toggle Phase 2 with the `GEOMETRY_MORPH` env var (default `1`). It degrades
cleanly to texture-only if anything fails; the shape refinement never fails a job.

### Phase 3: projective texturing (the rest of the head)

Phases 1 and 2 both stop at the face. The face-oval polygon Phase 1 composites
into is only **10.4% of the head's texels** (9.4% of its surface area), because
MediaPipe's 468 landmarks are face-only: there are no ear, scalp or neck points,
so outside the oval there is no correspondence to warp with. Everything else was
template texture personalised by a single global skin tint.

[`face_projection.py`](../workers/avatar-reconstruction/face_projection.py) takes
the other route. Phase 2 leaves us the head's real 3D shape, which turns the
problem from *find matching points* into *find where each surface point lands in
the photo*:

1. **Fit the camera** with a closed-form Umeyama similarity between the head's
   landmark vertices and MediaPipe's *3D* landmarks. This is the only use of
   landmarks, and they locate the camera rather than establishing surface
   correspondence.

   This started as `cv2.solvePnP` and had to be replaced, which is worth
   recording. `landmark_vtx` is nearest-vertex and **many-to-one**: on the
   shipped template, 468 landmarks collapse onto just **262 distinct head
   vertices**, so hundreds of landmarks share one 3D point while sitting at
   different 2D positions. That is a contradiction no camera can satisfy.
   Measured on the reference faces, RANSAC found 25-35% inliers and returned a
   solution *behind the camera* on half of them, with the depth sign flipping
   between runs and coordinate conventions.

   Because MediaPipe reports 3D landmarks, the alignment is 3D-to-3D rather than
   2D-to-3D, and Umeyama solves it in closed form with a reflection guard: no
   RANSAC, no depth-sign ambiguity, nothing that can diverge. Duplicate
   correspondences are averaged first so a vertex is not weighted by how many
   landmarks happened to land on it. The result is a weak-perspective (scaled
   orthographic) camera, which is the right model for a selfie anyway: head
   depth is centimetres against a camera distance of tens, so foreshortening
   across the head is small. **10 of 10 reference faces now fit**, against 50%
   failure with PnP.
2. **Rasterize the head in UV space** so every texel carries its 3D position and
   normal.
3. **Project and sample.** Each texel's 3D position goes through the camera into
   the photo. Ears, jawline and neck fall out for free.

Four gates decide whether a texel may be painted at all, because projection will
otherwise paint the back of a head with whatever pixel lies behind it. The texel
must land inside the photo, face the camera (confidence falls off as
cos^1.5 of the view angle), survive a depth-buffer occlusion test that catches
the nose shadowing the cheek, and sample a foreground pixel per the rembg alpha.
A texel failing any gate keeps its existing colour rather than inventing one. The
result blends *under* the Phase 1 composite, which stays authoritative where the
landmark warp applies, and is capped at `MAX_BLEND = 0.85` so a slightly-wrong
pose degrades to a tint rather than a visibly wrong image.

Measured on the shipped template by
[`eval/measure_projection_coverage.py`](../workers/avatar-reconstruction/eval/measure_projection_coverage.py),
photographic coverage of the head rises from **10.4% to 37.5%, a 3.6x increase**,
holding up as the subject turns (38.8% at 15 degrees, 39.5% at 30).

Toggle with `PROJECTIVE_TEXTURE` (default `1`). Like the morph, it degrades
cleanly: a pose that will not solve logs and leaves the warp-only skin in place.
It runs *after* the geometry morph, since projecting onto the template and then
morphing would slide the texture off the features it was sampled from.

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

> The active plan built on this roadmap — tracks, owners, capacity and credit
> allocation — is [avatar-fidelity-program.md](avatar-fidelity-program.md).
> Fidelity claims are scored with the ISE metric in
> [`workers/avatar-reconstruction/eval/`](../workers/avatar-reconstruction/eval/README.md).

Phase 2 captures gross face identity (proportions, projection) but not fine
geometry. The path to and past Avaturn quality, with the verified licence for
each link:

| Version | Upgrade | Model | Licence verdict |
|---|---|---|---|
| **v1 (shipped)** | Real face-shape morph (sparse) | MediaPipe Face Mesh | Apache-2.0 — clean |
| **v2 (recommended)** | Dense identity geometry, fused via `register_head_to_target` | **MICA + FLAME**, commercial licence from MPI | Paid MPI commercial licence — clean once signed. FLAME's fixed topology + expression basis map straight to ARKit |
| **v2 (fallback)** | Dense identity, no licence fee | HRN re-based on **FLAME-2023-Open** (CC-BY-4.0) | Clean, but weeks of GPU R&D to retrain the identity regressor |
| **v2 (texture)** SHIPPED | Projective texturing off the morphed mesh: fills ears, jawline and neck from the *same* photo (10.4% to 37.5% of the head) | none, geometry we already have | Clean; no new model or licence |
| **v3 (texture)** | Inpaint what no camera saw (scalp, far cheek) | **Imagen** inpaint on Vertex AI | GCP, pre-approved |
| **v3** | Drop the RPM-template dependency for a fully-owned body | **Anny** (parametric body) + **ICT-FaceKit** (ARKit-52) + deformation transfer | Anny Apache-2.0 + CC0; ICT-FaceKit + DT MIT — clean |

**Rejected: FaceLift (ICCV'25)** — initially floated as the clean v2 model, but
verification killed it: its weights are licensed from Adobe under the
**non-commercial Adobe Research License** (Apache code does not extend to the
weights), and it outputs **3D Gaussian Splats, not a mesh**, so it cannot feed a
rigged-GLB pipeline. This is the recurring trap here: the high-quality
single-image face models are almost all encumbered by a non-commercial 3DMM/
dataset (FLAME, BFM, SMPL) or a non-commercial weight licence. The dense
registration itself (`register_head_to_target`) is model-agnostic and already
validated, so whichever licensed model is chosen drops straight in.

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
