# The catalog quality gate

**Nobody asked for the assets the platform seeds into its own catalog, so they
have to earn their slot.** This is the gate that decides whether a
platform-generated model is published to [/characters](https://three.ws/characters)
and [/objects](https://three.ws/objects), or quarantined and never shown.

It matters because the failure is asymmetric. A user who generates a coarse mesh
in the [Forge](https://three.ws/create) chose to, and can regenerate. A visitor
browsing the catalog did not choose anything: every entry is the platform
vouching for itself. One melted blob on the storefront costs more trust than ten
rejected generations cost compute.

Source: [`api/_lib/seed-quality.js`](../api/_lib/seed-quality.js) ·
Tests: [`tests/seed-quality.test.js`](../tests/seed-quality.test.js) ·
Caller: [`api/cron/forge-seed-cron.js`](../api/cron/forge-seed-cron.js)

## Two stages, cheapest first

```
GLB bytes
   │
   ├─ 1. MESH SANITY ──────────── free, deterministic, no model call
   │      fails ──► quarantine (forge/rejected/) ──► never published
   │      passes
   │
   ├─ 2. VISION JUDGE ─────────── render + Vertex Gemini, ~10-20 s
   │      fails ──► quarantine ──► never published
   │      unreachable ──► publish anyway, flagged vision_unavailable
   │      passes
   │
   └─ published to the public catalog
```

The ordering is the cost control: **a degenerate blob never reaches a vision
model.** It is rejected in stage 1 for the price of a GLB fetch. Stage 2 only
ever sees assets that are already structurally sound.

### Stage 1: mesh sanity

Deterministic, runs on the GLB bytes, no network beyond fetching them. It reuses
[`scoreGlbQuality`](../api/_lib/glb-quality.js), the same scorer the interactive
forge flow already trusts, then applies catalog-specific bounds on top.

| Reason | Meaning | Default bound |
| --- | --- | --- |
| `not_valid_glb` | The bytes are not a binary glTF 2.0 at all | - |
| `degenerate_triangles` | Almost no triangle geometry; renders as nothing | `FORGE_QUALITY_MIN_TRIS` = 80 |
| `vertices_below_floor` | Too coarse to look like anything | `SEED_GATE_MIN_VERTICES` = 1,500 |
| `vertices_above_ceiling` | Runaway output | `SEED_GATE_MAX_VERTICES` = 1,500,000 |
| `file_too_small` | Structurally empty | `SEED_GATE_MIN_BYTES` = 20,000 |
| `file_too_large` | Would blow the viewer's fetch budget | `SEED_GATE_MAX_BYTES` = 80 MB |
| `no_textures` | Flat untextured grey | `SEED_GATE_REQUIRE_TEXTURE` = on |
| `zero_volume` | Collapsed bounding box; renders as a speck | - |
| `too_many_meshes_for_a_character` | A scene, not a character (avatars only, >8 meshes) | - |

Every failing bound is reported at once, not just the first, so tuning works off
the complete picture of what was wrong with an asset.

Two deliberate asymmetries:

- **Stricter than the interactive flow.** The `requireTexture` rule would be
  wrong for a user's own generation; it is right for a storefront.
- **Category-aware.** A prop may legitimately be a loose collection of parts, so
  the mesh-count rule applies to `avatar` only.

### Stage 2: vision judge

Renders one view and asks a vision model two separate questions.

**Realism**, via [`judgeOnce`](../api/_lib/quality-bench.js) from the realism
regression bench. It is *imported, never forked*, so the catalog gate and the
bench can never disagree about what a score of 7 means. Four dimensions on a
1-10 scale: `photorealism`, `geometryIntegrity`, `textureFidelity`,
`promptAdherence`.

| Reason | Default floor |
| --- | --- |
| `geometry_below_floor` | `SEED_GATE_MIN_GEOMETRY` = 5 |
| `prompt_adherence_below_floor` | `SEED_GATE_MIN_ADHERENCE` = 5 |
| `mean_score_below_floor` | `SEED_GATE_MIN_MEAN` = 4.5 (mean of all four) |

An asset can clear both individual floors and still fail on the mean:
structurally sound and prompt-faithful, but too poor overall to earn a slot.

**Rig readiness**, the question the realism bench does not ask: *can this be
rigged and animated at all?* Answered as strict JSON so the gate is a decision,
not a paragraph to interpret.

| Reason | The failure it catches |
| --- | --- |
| `vision_blob` | An amorphous, unrecognisable mass |
| `vision_subject_missing` | The requested subject is not there |
| `vision_multiple_subjects` | A crowd, a duplicated figure, or a scene |
| `vision_incomplete_body` | A waist-up bust or a headless torso |
| `vision_fused_limbs` | Arms welded to the torso, legs melted together |

`vision_fused_limbs` is skipped for `accessory`: a sword has no limbs, and
applying the rule would reject every prop.

## Fail closed on mesh, fail soft on vision

This is the single most important behaviour in the module, and it exists so the
numbers stay honest:

- **Mesh failure is a quality rejection.** Deterministic, reproducible, never
  published.
- **Vision failure is an infrastructure problem, not a quality signal.** If the
  renderer or the judge cannot be reached, the asset is published on the mesh
  verdict alone and marked `vision_unavailable`.

Recording a Vertex quota error as a quality reject would quietly corrupt the
accept-rate statistics, and you would tune thresholds against an outage. The
verdict carries `vision.status` (`judged` / `skipped` / `unavailable`) so the
accept rate can always be computed over the assets that were actually judged.

## A gate that cannot run is retried, not buried

The distinction above (quality verdict vs infrastructure) also decides what
happens to the *job row*. When the gate itself throws before reaching a verdict
(the object-storage read fails, the renderer dies, the judge transport is
unreachable), `api/cron/forge-seed-cron.js` leaves the row in `generated` and
counts the attempt in `forge_seed_jobs.gate_attempts`. The next tick re-gates it.
Only after `GATE_MAX_ATTEMPTS` (3) does the row move to the terminal `gate_error`
state.

That bound matters in both directions. Nothing ever revisits `gate_error`, so
burying a row on the first fault throws away a finished mesh that already cost
GPU time: on 2026-08-12 two seed jobs were lost that way inside one day, both to
the same transient storage error ("We encountered an internal error. Please try
again."). But an unbounded retry would let one ungateable mesh occupy a slot in
the `SEED_CRON_GATE` batch forever and starve every newer generation behind it.
Three attempts costs three ticks (three minutes) and then moves on.

Retries surface as `gate_retry` entries in the tick's `gate_results`, with a
`gate_retries` count on the response, so a lane that keeps blipping is visible
without reading the table.

Every read the gate makes is bounded so one slow host cannot stall the rest of
the tick: a lane's public GLB URL is fetched through the shared `fetchUpstream`
(30 s deadline, two attempts, and a non-2xx is a gate throw rather than an error
page handed to the GLB parser as mesh bytes), and the in-process Vertex judge
call carries a 45 s deadline with no retry.

## Rejects are kept, not deleted

A reject is copied (never moved, so the creator's forge history stays coherent)
to the `forge/rejected/` prefix, with a JSON sidecar beside it:

```
forge/rejected/<id>.glb
forge/rejected/<id>.reason.json
```

The sidecar carries the prompt, the category, the gate version and the entire
verdict. **That is the tuning dataset.** Threshold and prompt-wording changes are
made against real failures instead of guesses.

`SEED_GATE_VERSION` is stored on every verdict and bumped whenever a threshold or
judge prompt changes, because **an accept rate is only comparable within one gate
version.** Comparing last week's 62% against today's under different thresholds
is meaningless.

## Two transports, one gate

The gate runs from two places with different credentials, so the model call is
behind a transport interface. The decision logic is identical either way, which
is the point: the bar cannot drift between how an asset arrives.

| Transport | Runs in | Render | Judge |
| --- | --- | --- | --- |
| `inProcessTransport()` | Cloud Run, GCP service account attached | [`render-clip.js`](../api/_lib/render-clip.js) in process | Vertex Gemini direct |
| `remoteTransport({ origin })` | A workstation with no GCP credentials | `POST /api/render/avatar-clip` | `POST /api/vision` |

## Using it

The two pure functions need no GPU, browser, or model, which is why they carry
the test coverage.

```js
import { gateMesh, decideVisionVerdict } from './api/_lib/seed-quality.js';
import { readFileSync } from 'node:fs';

// Stage 1 only: instant, free, works offline.
const verdict = gateMesh(readFileSync('./candidate.glb'), { category: 'avatar' });
console.log(verdict.pass, verdict.reasons);
// false [ 'vertices_below_floor', 'no_textures' ]
```

The full gate, as the cron runs it:

```js
import { evaluateSeedAsset, inProcessTransport } from './api/_lib/seed-quality.js';

const verdict = await evaluateSeedAsset({
  glbBuffer,                                   // the bytes, for stage 1
  glbUrl: 'https://three.ws/cdn/forge/abc.glb', // a public URL, for the renderer
  prompt: 'a knight in weathered plate armour',
  category: 'avatar',
  transport: inProcessTransport(),             // omit for a mesh-only run
});

if (!verdict.accepted) {
  await quarantineReject({ id, glbKey, prompt, verdict });
}
```

A verdict looks like this:

```json
{
  "gateVersion": 1,
  "accepted": false,
  "reasons": ["vision_incomplete_body"],
  "mesh": { "pass": true, "reasons": [], "flag": "ok", "rigged": true, "jointCount": 65 },
  "vision": {
    "status": "judged",
    "mean": 6.25,
    "realism": { "photorealism": 6, "geometryIntegrity": 7, "textureFidelity": 6, "promptAdherence": 6 },
    "rigReadiness": { "subjectPresent": true, "singleSubject": true, "complete": false, "note": "cut off at the waist" }
  },
  "transport": "in-process",
  "durationMs": 14320
}
```

Passing no `transport` runs stage 1 alone. That is not a degraded mode: it is the
cron's default, and it is a complete, meaningful verdict.

## Configuration

Gate thresholds (read at import, so a change needs a restart):

| Variable | Default |
| --- | --- |
| `SEED_GATE_MIN_VERTICES` / `SEED_GATE_MAX_VERTICES` | 1,500 / 1,500,000 |
| `SEED_GATE_MIN_BYTES` / `SEED_GATE_MAX_BYTES` | 20,000 / 80 MB |
| `SEED_GATE_REQUIRE_TEXTURE` | `1` (set `0` to allow untextured) |
| `SEED_GATE_MIN_GEOMETRY` / `SEED_GATE_MIN_ADHERENCE` | 5 / 5 |
| `SEED_GATE_MIN_MEAN` | 4.5 |

Cron knobs (read per call, so a Cloud Run env update applies on the next tick
with no redeploy):

| Variable | Default | Effect |
| --- | --- | --- |
| `SEED_CRON_BATCH` | 1 | Jobs started per tick, submitted two at a time |
| `SEED_CRON_MAX_PENDING` | 3 x batch | In-flight ceiling |
| `SEED_CRON_VISION` | off | Enables stage 2 inside the cron |
| `SEED_CRON_VISION_MS` | 20,000 | Wall-clock budget for stage 2 |
| `SEED_CRON_RIG` | off | Auto-rigs accepted avatars before publishing |

### Why stage 2 is off by default in the cron

`SEED_CRON_VISION` is deliberately unset in production. The seed cron has a hard
70-second wall and a history of 504s when a phase overruns, while a render plus
two judge calls costs 10-20 seconds of it. **Stage 1 always runs** (it is
deterministic, local, and costs only the GLB fetch), so the catalog is never
ungated: it is gated on structure but not yet on appearance.

Turning it on is a one-variable change with no deploy:

```sh
gcloud run services update three-ws-api --region us-central1 \
  --update-env-vars SEED_CRON_VISION=1
```

Use `--update-env-vars` (merges), never `--set-env-vars` (replaces the entire
set). Watch `forge_creations` and the `forge/rejected/` prefix afterwards: if
ticks start timing out, lower `SEED_CRON_VISION_MS` before turning it back off.

## Tuning the thresholds

1. Let rejects accumulate in `forge/rejected/`.
2. Read the `.reason.json` sidecars and group by `reasons[]`. One reason
   dominating a batch usually means a threshold is wrong, not that the generator
   regressed.
3. Change the threshold, **bump `SEED_GATE_VERSION`**, and compare accept rates
   only within a version.
4. Re-run `npx vitest run tests/seed-quality.test.js`. The tests assert against
   the exported bound constants rather than hardcoded numbers, so a deliberate
   threshold change stays green while a broken decision does not.

## Related

- [Realism quality bench](../data/quality-bench/README.md): the regression
  harness whose scorer this gate imports
- [The 3D viewer](./viewer.md): what a published catalog entry has to render in
- [Production log triage](./ops/production-log-triage.md): the operator runbook
  for the seeding pipeline
