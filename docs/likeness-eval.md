# Likeness evaluation

**Does the avatar look like the person in the photos?** This is the harness that
answers it with a number instead of an opinion.

Phase 1 of the [roadmap](../README.md#roadmap) is verified on a likeness score:
users complete a capture and mint an agent of themselves "with >=4/5 likeness
score". Until this landed, nothing produced that number for a real generation.
The platform could assert likeness; it could not measure it.

## What was already measured, and why it was not enough

Two quality instruments existed before this one, and neither answers the
identity question:

| Instrument | Asks | Blind to |
|---|---|---|
| [Realism quality bench](../data/quality-bench/README.md) (`api/_lib/quality-bench.js`) | Is the generated asset photorealistic, coherent, on-brief? | Whose face it is. A beautiful render of a stranger scores perfectly. |
| [Identity Shape Error](../workers/avatar-reconstruction/eval/README.md) (`eval/identity_eval.py`) | Does the head have this person's face *shape*? | Texture, by design. Offline, against a synthetic reference set, and stores nothing per generation. |

The gap between them is the whole product claim. A pipeline that paints a
selfie onto a template head can score well on realism and poorly on shape while
still reading, to the person looking at it, as *them* or as *not them*. That
perception is what a face-recognition embedding measures.

## The metric

For one finished reconstruction:

1. The avatar is rendered head-framed at three yaws: **head-on (0°)**,
   **three-quarter (35°)**, and **profile (65°)**, using the platform's own
   `headshot` scene preset so the framing matches what a user actually sees on a
   thumbnail or share card.
2. Each render and each input capture is passed through a face detector
   (**YuNet**) and an identity embedder (**SFace**), producing a 128-dimensional
   L2-normalised vector per face.
3. Each view is scored as the **cosine similarity** between its render vector
   and the best-matching capture vector.
4. The headline **likeness score** is the head-on view's cosine, mapped to 1-5.

`profile` is 65° rather than a true 90° on purpose. A full side-on view presents
at most three of the five landmarks the alignment step needs, so no model of
this family can measure it. 65° is the steepest turn that still yields a
measurable face, and it is well past the point where a frontal-only texture
transfer stops covering the head.

### Why 1-5 means what it means

The mapping is anchored to the embedding model's own calibration, not to taste:

| Cosine | Score | Meaning |
|---|---|---|
| 0.000 | 1.0 | No relationship between the faces |
| 0.363 | 3.0 | OpenCV's published SFace decision boundary: the exact point where the model stops calling this the same person |
| 0.682 | 4.0 | The roadmap gate |
| 1.000 | 5.0 | Identical embedding |

So **4/5 is a cosine of 0.68, roughly twice the same-identity threshold**: not
"arguably the same person" but "confidently the same person". Between the
anchors the mapping is linear.

### What the harness refuses to do

A missing input is reported as a status, never scored as a zero, because these
are three different findings that a single low number would hide:

- `captures_unusable`: no input photo contained a findable face. A
  capture-quality problem; nothing can be concluded about the avatar.
- `render_unusable`: no render contained a findable face. The reconstruction
  did not produce something recognisable as a head.
- `ok` with a low score: the avatar has a face, and it is not this person's.

`budget_exhausted` is a fourth: a sweep cut short by its time budget covers
fewer views than a complete one, so its score is withheld rather than compared
against runs that were not truncated.

### Secondary readings

- **turn falloff**: head-on cosine minus the worst view's. A pipeline that only
  holds up frontally is visible here and in no single-view number.
- **capture cohesion**: mean pairwise cosine among the input photos. A selfie
  set whose own photos only agree at 0.5 cannot support a claim about the avatar
  at 0.6.
- **captures embedded / total**: how much of the input the measurement rests on.

## The models, and why these two

Both are pulled from [OpenCV Zoo](https://github.com/opencv/opencv_zoo) at a
pinned commit and verified against a hardcoded SHA-256 before they are loaded.

| Role | Model | License | Size |
|---|---|---|---|
| Detection + 5 landmarks | YuNet (`face_detection_yunet_2023mar`) | MIT | 233 KB |
| Identity embedding | SFace (`face_recognition_sface_2021dec`) | Apache-2.0 | 39 MB |

Both licenses are commercially clean, which is the same bar the reconstruction
worker holds ("no non-commercial 3DMM": no FLAME, BFM or SMPL weights anywhere
in the pipeline). The widely-cited alternative, InsightFace's `buffalo_l`
ArcFace pack, is materially stronger on benchmarks and is released for
**non-commercial research use only**, so it is not available to us at any
quality.

They run on [`onnxruntime-web`](https://www.npmjs.com/package/onnxruntime-web)'s
WASM backend (MIT) rather than `onnxruntime-node`. The node binding's installer
downloads CUDA provider packages from NuGet during `npm install` and fails
outright on a machine with no GPU tree, which would make the repository
uninstallable. WASM has no native install step and behaves identically on a
laptop and on Cloud Run.

Weights are **not** vendored into git. They are fetched once from the pinned
URL, hash-verified, and cached under `FACE_MODEL_CACHE_DIR` (default: the system
temp directory).

> opencv_zoo stores its weights in Git LFS, so `raw.githubusercontent.com`
> serves a 130-byte pointer file rather than the model. The fetch uses
> `github.com/<repo>/raw/<commit>/…`, which resolves LFS. The SHA-256 check is
> what caught the difference.

## Running it

### Weekly, automatically

`/api/cron/likeness-eval` runs Mondays at 03:47 UTC, 24 minutes after the
realism bench, on the same cadence. It takes finished reconstructions the
current scorer version has not measured, scores them, and files the results. It
bounds itself to a 280-second budget and skips any subject it cannot finish, so
it never collects a Cloud Run 504 the way an unbounded sweep does. A sweep whose
mean falls below the 4.0 gate logs at `warn` level:

```bash
gcloud logging read 'resource.type="cloud_run_revision" textPayload:"likeness-eval"' --freshness=7d
```

### On demand

```bash
# Score everything the current scorer version has not seen (needs DATABASE_URL)
node --env-file=.env scripts/likeness-eval.mjs --backfill

# Run 10 reconstructions through the real production pipeline and score them
node --env-file=.env scripts/likeness-eval.mjs --live=10 --out=reports/likeness.json
```

`--live` signs in with the QA account, submits real reconstructions built from
**synthesised** subject descriptions (never real people's photos, for the same
reason the reconstruction worker synthesises its reference set), polls each to
completion, and scores the finished avatar against the exact reference image the
pipeline built it from.

Both modes print a **cross-subject control**: every avatar is also scored
against every *other* subject's captures. A likeness number is unfalsifiable
without it, because a scorer that returned 0.8 for any two faces would look
identical to a working one on the matched pairs alone. The separation between
the two distributions is the evidence the instrument works.

## Reading the results

`/likeness-bench` (internal, admin or `x-ops-secret`) renders the distribution:
the fraction clearing the 4/5 gate, the histogram, mean turn falloff, the
outcome breakdown, and the most recent individual scores. The same data is
available as JSON:

```bash
curl -H "x-ops-secret: $OPS_SECRET" 'https://three.ws/api/likeness-bench?days=30&limit=50'
```

Scores are keyed on the generation record (`forge_creations.id`) and stamped
with `scorer_version`. **A score is only comparable to another score taken by
the same scorer version.** When the model, the alignment template or the view
angles change, the version changes with them, old rows stay valid, and
`where scorer_version <> $current` is the backfill query.

## What is deliberately not stored

No capture URLs, no crops, and **no embeddings**. A face embedding is biometric
data; this table holds the measurement, not the person. The stored report
carries per-view statuses and cosines, and records a rejected capture by index
and reason only.

## Related

- [Selfie to avatar](./selfie-to-avatar.md): the capture flow being measured
- [Avatar fidelity program](./avatar-fidelity-program.md): the tracks this
  metric scores
- [Realism quality bench](../data/quality-bench/README.md): the sibling harness
  for photorealism
- [Reconstruction fidelity evaluation](../workers/avatar-reconstruction/eval/README.md): the geometry-side metric
