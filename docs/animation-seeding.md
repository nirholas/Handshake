# Generated animation seeding

three.ws generates its own animation clips. A prompt from `data/motion-prompts.json`
goes to our self-hosted text-to-motion GPU worker, the result is measured against a
quality gate, and the keepers are published into the same clip library the curated
Mixamo import already serves.

This document covers what the gate measures and why, because the "why" is the part
that is easy to get catastrophically wrong.

## The pieces

| Piece | What it does |
|---|---|
| `data/motion-prompts.json` | The prompt library: 137 prompts across 10 categories. Data, never a hardcoded list. |
| `workers/model-text2motion/` | The GPU worker. Samples a motion-diffusion model and returns a three.js `AnimationClip` JSON. |
| `api/forge-motion.js` | The public route: `POST` a prompt, poll for a clip. Rate limited per IP. |
| `api/_lib/motion-seed.js` | The prompt loader, the quality gate, the publishing shape, the free-subset rotation. |
| `scripts/gcp/seed-motion.mjs` | The resumable bulk runner. |
| `api/animations/library.js` | Serves the clip manifest that generated clips are merged into. |

Generated clips are named `gen-<prompt id>-<hash>`, so they are distinguishable from
the `mx-` Mixamo import everywhere: in the manifest, the gallery, and any report.

## Format: nothing to convert

The worker already emits clips on the canonical skeleton, and a generated clip's
track names are a strict **subset** of the library's: the 23 body bones, with no
finger tracks and no foreign bone names. An unanimated finger holds bind pose, which
is correct rather than a defect. So publishing is a rename plus a `userData`
provenance record, not a format conversion.

## The gate

Run `gateMotionClip(clip, { expectedDuration })`. It returns
`{ ok, reasons[], metrics }`, and every threshold in `MOTION_GATE` was derived by
measuring a 60-clip sample of the authored Mixamo library, not chosen by taste.

### Judge positions, not rotations

This is the important part.

The sampler routinely emits a **180 degree twist about a bone's own axis which the
child bone immediately cancels**. Measured on the local quaternion tracks that looks
like a catastrophic pop: in one "idle breathing" clip the left shoulder and left
forearm each flipped a half turn on 39 of 119 frames. Measured where it matters, the
hand never moved more than 1.1 cm in a single frame. The flip is a property of the
representation, not of the animation, and it is invisible on a rendered mesh.

A first version of this gate tested adjacent local quaternions and **rejected 100% of
generated clips** while the motion was in fact fine. So the gate runs forward
kinematics over `src/animation-canonical-rest.js` and judges world-space joint
positions, which is what a viewer actually sees:

- **`world_discontinuity`**: the largest single-frame step of any witness joint
  (hands, feet, toes, head, hips), divided by that joint's own 95th-percentile step.
  Dividing by the clip's own scale makes the test speed-independent, so a sprint and
  an idle are held to the same standard. Authored clips score a median of 1.69 and a
  worst case of 5.79 (a heavy push), so the ceiling is **6.5**.
- **`frozen_clip`**: the longest path any witness joint walks, in metres. The
  library's static *pose* assets score 0.00 and its quietest real animation 0.11, so
  the floor is **0.35**.
- **`foot_sliding`**: real foot contact. A foot counts as planted only when it is
  within 6 cm of the clip's own floor level **and** the hips are at least 0.55 m above
  that floor. Without the upright test, floor work (a fall, a crawl, a breakdance
  flair) reads as skating, because the "lower" foot is merely the one that happens to
  be less high. Slide is then scored against the stride the clip actually covers.
- Plus the cheap structural checks: NaN or infinite keyframes, non-monotonic times,
  quaternions off the unit sphere, missing body bones, bones the canonical skeleton
  does not have, frame count, and a duration that does not match what was ordered.

`maxFrameJumpRad` and `totalMotionRad` are still **reported** in `metrics`, because
they are useful for spotting worker regressions. They are deliberately **not gated**.

### Calibration

Against 60 authored library clips the gate accepts 87%. The rejects are all clips
that are legitimately out of spec for *generated* content rather than gate errors:
sliced sub-clips a few frames long, static pose assets with zero motion, and one hit
reaction that genuinely slides. Generated clips are held to a duration we ordered and
motion we asked for, so those rules are correct where they are applied.

Re-run the calibration whenever a threshold changes, and inspect rejected clips before
touching a number. A broken pipeline looks exactly like a strict gate.

## Running a batch

```bash
# Measure quality without publishing. Needs no credentials.
node scripts/gcp/seed-motion.mjs --count 20 --dry-run

# A real run, where R2 and DATABASE_URL live.
node scripts/gcp/seed-motion.mjs --count 200 --concurrency 6
```

Useful flags: `--categories locomotion,dance` to seed one slice, `--checkpoint PATH`
to keep runs separate, `--price` and `--free-size` to set the listing terms.

**Use the in-process transport for anything bulk.** `/api/forge-motion` is a public
endpoint rate limited per IP: a 40-clip run through it generates two clips and then
takes a 429 with a 49 minute `retry_after`. With `GCP_TEXT2MOTION_URL` set the runner
calls the provider directly and no limiter applies. `--origin` forces the HTTP path,
which is worth doing on a handful of clips to prove the deployed route works.

The run is **resumable**: every prompt's outcome is written to the checkpoint as it
lands, and a re-run skips anything already terminal, so killing the process costs at
most the clips in flight.

The run is **lane-asserted**. `/api/forge-motion` and the provider both return a job
id that names the worker the job was dispatched to, and the runner decodes it and
aborts the entire batch unless the host is our own `model-text2motion` Cloud Run
service. Bulk generation must never fall through to a paid third party.

## Pricing and the rotating free subset

Generated clips are listed in the marketplace under the platform creator (`three`)
and are paid by default. A fixed-size subset is free for one epoch at a time.

The subset is chosen by hashing each clip name together with the epoch number
(`freeClipNames`). That makes it deterministic, so every server instance agrees
without coordination or a database write; stable for a whole epoch, so a visitor
never watches a price flicker on reload; and evenly spread, because each clip's hash
ordering differs per epoch, so the free slot rotates instead of favouring the same
names. The epoch is one week and the subset is 12 clips (`FREE_ROTATION`).

The subset is computed over the **whole** generated collection rather than the current
batch, so a later batch cannot hand out a second set of free clips.

## Scale: what happens as the library grows

Measured 2026-09-02 against the live site, with 2,874 clips in the library and
58,544 avatars in the catalog.

`GET /api/animations/library` already supports paging (`?limit=`, `?offset=`), and a
paged response is small: 24.6 KB for `?limit=60`. **With no `?limit` it returns the
entire manifest**, which is 1.12 MB uncompressed today (about 100 KB on the wire,
since the CDN serves it brotli-compressed). That un-paged form is the documented
backward-compatible contract, and three consumers still use it:

- `src/animations-gallery.js` (the `/animations` gallery)
- `src/animation-library.js` (pose deep-link lookup by clip name)
- `src/avatar-embed.js` (the embed viewer)

At 5 to 10 times the current library those three each parse 6 to 11 MB of JSON on
load. The gallery is the one to fix first, because it only ever renders a page at a
time and has no reason to hold the whole manifest; the other two look a clip up by
name, so they need either a name-indexed endpoint or a cached shard rather than
simple paging. None of this is urgent at 2,874 clips and all of it bites well before
30,000.

The other list surfaces are already scale-safe and need no change. Measured at
58,544 avatars, each returns a bounded first page even with **no** `?limit` given:

| Endpoint | No limit | `?limit=24` |
|---|---|---|
| `/api/marketplace` | 22.8 KB | 22.8 KB |
| `/api/avatars/public` | 38.3 KB | 38.3 KB |
| `/api/marketplace/animations` | cursor-paged, `limit` ceiling 60 | 
| `/api/animations/library` | **1.12 MB, the whole manifest** | 24.6 KB |

So the clip library is the single unbounded response on the platform, and the fix is
the three consumers above rather than the endpoint, which already pages.
