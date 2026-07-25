# Reconstruction fidelity evaluation

Measures whether a reconstructed avatar actually has **this person's face
shape**, so pipeline changes can be judged on a number instead of on whether a
screenshot looks nice.

The pipeline paints a selfie onto a template head. That flatters a visual check:
from the front, the render already looks like the person while the underlying
skull is still the template's. Turn the head 30 degrees and the illusion breaks.
The metric here ignores texture completely and scores geometry.

## The metric: Identity Shape Error (ISE)

For one (selfie, avatar GLB) pair:

1. MediaPipe detects the selfie's 468 face landmarks.
2. `face_uv_map.json` maps each landmark to a head vertex, so the same 468
   points can be read off the avatar's mesh.
3. Both point sets are Umeyama-aligned onto MediaPipe's neutral canonical face,
   using only the **stable identity landmarks** (face oval, nose, cheeks, brow,
   jaw). Eyes and lips are excluded so a smile or a blink in the selfie is not
   scored as identity.
4. **ISE** = mean distance between the aligned sets, over the stable subset,
   divided by canonical interocular distance.

Dimensionless and comparable across faces, image sizes and body types. **Lower
is better.** Because step 3 quotients out similarity transforms, a pipeline
cannot score better by scaling or tilting the head — only by matching shape.
`eval/test_identity_eval.py` pins that invariance, along with monotonicity
(interpolating a head toward the person must lower the score at every step).

Two numbers give it meaning:

- **template floor** — the same measurement against the unmorphed template. This
  is what a texture-only pipeline scores, and the number to beat.
- **improvement** — the fraction of that floor a run closes. The Phase-2 morph
  moves `strength` (default 0.75) of the way toward the person, so ~0.75 is the
  current implementation's ceiling, not 1.0.

A region breakdown (oval / nose / cheeks / brow / jaw) says *where* the shape is
wrong, which is what decides where the next fidelity push goes.

### What ISE cannot see

- **Anything off the face.** The metric samples the head only at the 468 landmark
  correspondence vertices, which are exactly the morph's control points. The
  scalp, ears, neck and back of the head are never measured, so `falloff` — which
  governs how the displacement decays away from the face — is invisible to ISE by
  construction. Never tune `falloff` against this score; the back-of-head
  assertions in [`test_face_geometry.py`](../test_face_geometry.py) are what guard
  that region.
- **Texture.** By design. A texture change scores identically. Track 2 in
  [the program plan](../../../docs/avatar-fidelity-program.md) needs its own
  metric.
- **Failure modes absent from the reference set.** The set is clean frontal
  portraits, so it contains no landmark mis-detections and cannot tell you
  anything about outlier rejection. This is why `max_displacement_frac` is set on
  physical grounds rather than at the sweep's numerical optimum, and why
  adversarial samples (blurry, off-angle, occluded, low-light) are the most
  valuable addition to the reference set.

## Score one reconstruction

```bash
python -m eval.identity_eval --selfie refs/ana.jpg --glb out/ana.glb
```

```
ana.jpg → ana.glb
  ISE            0.0412   (lower is better)
  worst point    0.0980
  template floor 0.0733
  improvement    +43.8%
  by region:
    jaw      0.0561
    oval     0.0487
    nose     0.0402
    cheeks   0.0331
    brow     0.0298
```

## Score a deployment

```bash
export RECON_KEY=$(gcloud secrets versions access latest \
  --secret=avatar-reconstruction-key --project=aerial-vehicle-466722-p5)

python -m eval.run_eval \
  --photos eval/refs \
  --url https://avatar-reconstruction-lp642k3kpa-uc.a.run.app \
  --out eval/reports/v2.json --keep-glb
```

Submits every photo in the directory, waits for each job, scores the result and
writes a report with per-sample and aggregate numbers.

## Compare two revisions

```bash
python -m eval.run_eval --compare eval/reports/v1.json eval/reports/v2.json
```

Prints the aggregate move, the per-region move, and — importantly — **every
individual face that got worse**. A change can improve the mean while wrecking a
subset of faces; the mean alone hides exactly the regression that matters. Exits
non-zero when the mean did not improve, so it works as a gate.

## Tune the morph against the score

```bash
python -m eval.tune_morph --photos eval/refs --detail
```

Sweeps `strength` x `max_displacement_frac` over every reference face and reports
the best mean ISE, the worst individual face, and how many faces a setting makes
worse than the shipped default. Runs offline — landmarks are detected once, then
each combination is applied in-process — so a full grid is minutes, not a day of
job submissions. This is how the current 0.6 / 0.45 defaults were chosen.

Read its output with the blind spots above in mind. The sweep's numerical optimum
is not automatically the right ship: a benchmark of clean portraits will always
push `max_displacement_frac` toward "no clamping at all", because it contains
nothing for the clamp to reject.

## The reference set

`--photos` is a directory of frontal faces, one file per sample, spanning what
the pipeline must handle: skin tone, age, face shape, facial hair, glasses, head
covering, lighting, camera quality. A mean over a narrow set hides the failures
that matter most.

Build it with:

```bash
python -m eval.make_refs --out eval/refs --upload
```

The faces are **synthesised, not collected** ([`make_refs.py`](make_refs.py)) over
a deterministic grid of the platform's own diversity matrix. That keeps real
people's biometrics out of a benchmark that gets copied between machines and
uploaded to buckets, avoids any licensing question, and lets any agent rebuild
the identical set. They stay gitignored regardless — 40 PNGs do not belong in
git — and mirror to `gs://three-ws-avatar-reconstructions/eval-refs/`:

```bash
gcloud storage rsync -r gs://three-ws-avatar-reconstructions/eval-refs eval/refs
```

A score is only comparable to another score taken on the same reference set.
Record which set a report used before quoting its number.

## Running the tests

```bash
python -m pytest eval/test_identity_eval.py -q
```

Scoring is pure geometry, so the tests need only numpy — no mediapipe, no cv2,
no GPU. The detector is imported lazily, and only when a selfie is actually read.
