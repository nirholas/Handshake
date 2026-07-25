# Avatar fidelity program — owning selfie → avatar end to end

**Goal:** a selfie-to-avatar engine that beats the leading commercial
selfie-avatar products on identity fidelity, runs entirely on infrastructure we
own, and costs nothing per avatar. Not "good enough to avoid a bill" — better
than the thing we would have paid for.

This is the program plan. The subsystem it improves is documented in
[avatar-reconstruction.md](avatar-reconstruction.md); the worker lives in
[`workers/avatar-reconstruction/`](../workers/avatar-reconstruction).

## Why we are not buying this

Commercial vendors sell exactly this capability, metered per avatar. Two
reasons we build instead:

1. **It is the product.** three.ws is an avatar platform. Renting the step that
   turns a person into an avatar means the core of the product is someone
   else's, priced by them, rate-limited by them, and deprecable by them.
2. **The architecture is already ours.** The worker fits a person onto a
   pre-rigged fixed-topology template — the same approach the major commercial
   avatar platforms use. The output is born rigged with 52 ARKit blendshapes
   and 15 visemes. What is missing is fidelity, and fidelity is a compute-and-research
   problem, which is precisely what ~$100k of Google Cloud credits buys.

Every stage is commercial-clean (Apache-2.0 / MIT / BSD / CC0). Holding that
line is a hard constraint, not a preference: the highest-quality published face
models are almost all built on a non-commercial 3DMM (FLAME, BFM, SMPL) or
carry non-commercial weights. See the licence section in
[avatar-reconstruction.md](avatar-reconstruction.md#licensing--why-this-stack)
for the verdicts, including why FaceLift was evaluated and rejected.

## The spine: measure before optimising

Every track below is judged by one number, **Identity Shape Error (ISE)** —
texture-blind, pose- and scale-invariant, dimensionless. Full definition and
usage: [`workers/avatar-reconstruction/eval/README.md`](../workers/avatar-reconstruction/eval/README.md).

Without it, "better than the commercial benchmark" is an opinion and a research
track can burn GPU-months moving a number nobody measured. With it, every
change is a diff:

```bash
python -m eval.run_eval --compare eval/reports/v1.json eval/reports/v2.json
```

Rule for this program: **no fidelity claim without a report, and no report
without naming the reference set it scored.**

## What actually binds

Not money. Two things:

- **L4 GPU quota = 3 for us-central1**, shared by six warm GPU services. The
  fleet is permanently at its ceiling. See
  [ops/gcp-credits-plan.md](ops/gcp-credits-plan.md). An RTX PRO 6000 (Blackwell,
  96 GB) is already granted and validated live at 1 instance, but needs a CUDA
  12.8 / torch cu128 rebuild — L4 images do not run on it.
- **Training-data licensing.** The reason to prefer per-subject optimisation
  over training an identity regressor: a regressor needs a face dataset, and the
  commercially-usable ones are thin. Optimisation needs only the user's own
  photo. This is the central design decision of the program.

## Tracks

Tracks 1-3 are independent and can run in parallel. Track 0 gates the claims of
all of them.

### Track 0 — Measurement `[done, needs a reference set]`

The ISE metric, batch runner, revision comparator and property tests. Built and
passing. What remains is the reference set itself: 30-50 frontal selfies
spanning skin tone, age, face shape, facial hair, glasses, head covering and
lighting, mirrored to `gs://three-ws-avatar-reconstructions/eval-refs/` so every
agent scores against an identical set. Photos are never committed.

### Track 1 — Ship the morph that is already written `[in flight]`

`face_geometry.py` (Phase 2 head-shape morph) is written, tested, and has never
been deployed: production `/health` reports `face_texture_transfer_v1` and omits
the `geometry_morph` field entirely, so the running image predates the work.
Production is texture-only today — a person's face painted on a generic skull.

Deploying it is one build. Then: baseline v1 vs v2 on the reference set, and
tune `strength` / `falloff` / `max_displacement_frac` against ISE rather than
against taste.

Cost: negligible. Expected to be the single largest fidelity jump per unit of
effort in the whole program, because the work is already paid for.

### Track 2 — Full-head photoreal texture (Vertex AI Imagen)

A selfie shows one side of a face under one lighting condition. Cheeks in
shadow, ears, the scalp, under the jaw — none of it is in the photo, and today
those regions fall back to a tinted template texture. That mismatch is what
reads as "avatar" rather than "person" the moment the head turns.

Imagen inpainting on Vertex AI fills the unseen regions conditioned on the
observed face, in UV space so the result stays inside the template's texture
layout. Pure GCP, pre-approved, no licence exposure, usage-priced.

ISE will not move — it is a geometry metric. This track needs a texture metric
alongside it, and that is part of the track: masked SSIM / LPIPS against held-out
views, plus a seam-continuity check across the UV boundary.

### Track 3 — Dense identity geometry by per-subject optimisation

The Phase-2 morph is driven by 468 sparse landmarks diffused across 2162 head
vertices. It captures gross proportion — face width, jaw, nose projection, brow
— and cannot capture fine structure, because the signal is not there.

The unencumbered path to dense identity is **analysis-by-synthesis**: render the
current head, compare to the photo, backpropagate to vertex positions, repeat.

- **Differentiable rasteriser: PyTorch3D (BSD-3-Clause).** Commercially clean.
  Deliberately *not* nvdiffrast, whose NVIDIA Source Code License is
  non-commercial.
- **Regularisation** with a Laplacian smoothness term and a displacement bound,
  so the head stays on a plausible face manifold and every ARKit blendshape
  survives. Vertex count and order never change, so `glb_ops.set_head_geometry`
  writes the result back without touching skinning or morph targets — the
  property `test_face_geometry.py` already pins.
- **Multi-view from one photo:** synthesise consistent 3/4 and profile views
  with Vertex image models, then fit against all views at once. Single-view
  depth ambiguity is the ceiling on shape accuracy, and this attacks it directly.
  The multi-view fusion pattern already exists in `workers/model-hunyuan3d`.

No third-party weights, no face dataset, no licence question: it optimises
against the user's own photo. It is GPU-hungry per avatar, which is exactly the
resource we have.

Alternative shortcut, **requires owner approval because it is external spend**:
a commercial FLAME licence from MPI unlocks MICA for dense identity in one
forward pass. Cheaper in engineering time, adds a licensing dependency, and
`register_head_to_target` is already model-agnostic so it drops straight in if
the owner wants it. Recommendation: build the optimisation path first, since it
is unencumbered and permanent.

### Track 4 — Capacity

Fidelity work is throughput-bound before it is idea-bound: Track 3 is minutes of
GPU per avatar against a fleet already at its ceiling.

- Chase the L4 quota preference (`l4-no-zonal-us-central1-8`, preferred 16). On
  a grant ≥ 8, the fleet-wide scale-up commands are pre-approved and listed in
  [ops/gcp-credits-plan.md](ops/gcp-credits-plan.md).
- Port the reconstruction worker to the granted RTX PRO 6000 (CUDA 12.8 / torch
  cu128; platform minimum 20 CPU / 80 Gi). `workers/model-hunyuan3d/Dockerfile.hunyuan21rtx`
  is the first mover to copy. 96 GB of VRAM makes the Track 3 optimisation loop
  practical at interactive latency.
- Vertex AI custom jobs for any batch experiment, so research load never competes
  with the serving fleet for the same three L4s.

### Track 5 — Fully-owned body (v3)

The reconstruction template is a Wolf3D/RPM base — the last third-party asset in
the pipeline. **The replacement already exists in this repo** and the roadmap
entry above is out of date: [`public/avatars/parametric-base.glb`](../public/avatars)
is a CC0 MakeHuman/MPFB2 body (vendored via [naver/anny](https://github.com/naver/anny)
in [`avatar-sources/anny/`](../avatar-sources/anny)) carrying **122 baked morph
sliders** — nose, ears, mouth, eyes, jaw, cheeks, head shape, neck, plus gender,
muscle, weight, age, height, torso, hips, limbs — on a 52-bone `mixamorig:*`
skeleton, built by [`scripts/build-parametric-base.mjs`](../scripts/build-parametric-base.mjs)
and already live in Avatar Studio's base switcher.

That turns this track from "build a body" into "retarget reconstruction onto the
body we ship", and it changes the shape of the whole program: the 122 sliders are
a **parametric identity basis**. Fitting a person becomes solving for slider
values, which is a far better-conditioned problem than free-form vertex
optimisation — bounded, always on the face manifold, and interpretable. Track 3's
differentiable fit should target this basis first and fall back to free-form
vertex displacement only for residual detail.

Work: rebuild `face_uv_map.json` against the parametric base (`precompute_uv.py`
is already parameterised by template), transfer the ARKit-52 expression set with
ICT-FaceKit (MIT) since the Anny base does not ship visemes, and re-baseline
every ISE report — scores are only comparable within one template.

## Where the credits go

| Line | Rough monthly | Notes |
|---|---|---|
| Warm GPU serving (current 6-service fleet) | $4-6k | Already running |
| RTX PRO 6000 warm instance | ~$2-3k | Track 3 serving + Track 4 headroom |
| Vertex AI custom training/experiment jobs | $2-5k while active | Track 3 sweeps, Track 2 evaluation |
| Vertex Imagen inference | usage-based, small | Track 2 |

Steady state stays in the range [ops/gcp-credits-plan.md](ops/gcp-credits-plan.md)
already sets out: comfortably over a year of runway on the grant. The standing
directive is to spend on quality and never downgrade to conserve credits.

## Owner decisions

Everything above proceeds without asking, per the standing GCP approvals. Two
items do not:

1. **Commercial FLAME/MICA licence from MPI** — external paid dependency
   (Track 3 alternative). Not needed if the optimisation path lands.
2. **Production deploys of the main API/frontend.** GPU worker deploys and
   config-only `gcloud run services update` changes are pre-approved.
