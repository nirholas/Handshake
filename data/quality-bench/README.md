# Realism quality bench

The measurement loop for the forge realism campaign: a fixed 23-prompt benchmark,
a generate → render → judge pipeline that runs the REAL `/api/forge` path and
scores the result with Vertex Gemini vision, and a dashboard so "did quality go
up" is a number, not a vibe.

## What's here

- `prompts.json` — the fixed benchmark set. 20 text prompts spanning people
  (portrait, full body), animals, food, vehicles, tools, furniture,
  architecture, nature, and fantasy, plus 3 image→3D cases that reconstruct a
  real CC0 reference photo (`refs/chair.jpg`, `refs/sneaker.jpg`,
  `refs/teapot.jpg` — sources in `refs/SOURCES.md`). Each entry has an `id`,
  `subjectClass`, `prompt`, `mode` (`text` or `image`), and a `watch` list of
  the realism failure modes to specifically look for on that subject
  (plastic skin, melted text/detail, blob geometry, texture tiling, etc.).
  **Never edit an existing id's prompt/subjectClass/watch once a run has been
  committed against it** — scores across runs are only comparable when the
  input is byte-identical. Add a new id instead.
- `runs/` — one committed JSON file per run, append-only (a run file is never
  edited after `finishedAt` is set; a re-run creates a new file). This is the
  full history the dashboard reads.
- `refs/` — the 3 CC0 reference photos for the image→3D cases, plus
  `SOURCES.md` documenting where each came from and its license.

## Running the bench

```sh
# Full sweep: every live image-capable lane, standard + high tier
node scripts/quality-bench.mjs

# One lane, one tier, a couple of prompts (fast iteration)
node scripts/quality-bench.mjs --lane=trellis_selfhost --tier=standard --prompts=qb01,qb09

# Four lanes at once (tasks are ordered so simultaneous work lands on
# different backends, not four jobs queued behind one GPU worker)
node scripts/quality-bench.mjs --lane=nvidia,huggingface,hunyuan3d,trellis_selfhost --concurrency=4

# Against a non-production deployment
node scripts/quality-bench.mjs --base-url=https://staging.three.ws

# See what would run without spending anything
node scripts/quality-bench.mjs --dry-run

# Resume a run that crashed or was interrupted — never re-submits a completed
# (prompt, lane, tier) combo
node scripts/quality-bench.mjs --resume=run-2026-07-23T12-00-00-000Z.json
```

Flags: `--lane=<id|id,id|all>` (default `all` = every lane `/api/forge?catalog`
reports as `configured`), `--tier=<draft|standard|high|all>` (default
`standard,high`), `--prompts=<id,id,...|all>` (default `all`), `--base-url`
(default `https://three.ws`), `--resume=<run file>`, `--concurrency=<n>`
(default `1`), `--dry-run`.

`--concurrency` matters because a full sweep is long: one `(prompt, lane, tier)`
combo costs a generation plus 3 renders plus 6 judge calls, so 23 prompts x 4
lanes x 2 tiers is many hours serially. The runner keeps a single run file and
serialises its writes, so resumability is unchanged at any concurrency. Keep it
at or below the number of lanes being swept — beyond that, extra workers just
queue behind the same GPU backend.

**Credentials.** Forge generation needs nothing locally — the script calls the
live `/api/forge` HTTP path on `--base-url`, which runs against that
deployment's own configured lanes and credentials. The High tier is the one
exception: `forge.high` is $THREE hold-or-pay gated, so an anonymous submit gets
a 402 and every high-tier combo would record as a lane failure. Set
`CRON_SECRET` (or `QUALITY_BENCH_FORGE_SEED`) to the target deployment's value
and the bench submits as an internal seed request, which the gate exempts.
Scoring needs
`GOOGLE_CLOUD_PROJECT` set and GCP credentials resolvable the same way every
other Vertex Gemini caller in this repo resolves them (`GCP_SERVICE_ACCOUNT_JSON`
env var, or the ambient Cloud Run/GCE metadata server) — see
`api/_lib/gcp-auth.js`. Without those, the script still runs real generations
and renders, but every view's score comes back as an error (never a fabricated
number) and that (prompt, lane, tier) combo is recorded with `status:
"scoring_failed"`.

**Idempotency / cost control.** The runner writes the run file to disk after
every single completed `(prompt, lane, tier)` result, so a crash loses at most
one in-flight generation. `--resume` skips every combo already recorded.
`/api/forge` itself caches identical `(prompt, tier, backend)` submissions, so
re-running an already-generated combo doesn't re-spend GPU time — it reuses the
prior real generation.

## Reading a run

Each run file (`runs/run-<timestamp>.json`) has:

```jsonc
{
  "runId": "run-2026-07-23T12-00-00-000Z",
  "startedAt": "...", "finishedAt": "...",
  "baseUrl": "https://three.ws",
  "judgeModel": "google/gemini-2.5-pro",
  "judgePromptVersion": 1,
  "lanes": ["trellis_selfhost", "hunyuan3d", ...],
  "tiers": ["standard", "high"],
  "results": [
    {
      "promptId": "qb01", "subjectClass": "people-portrait",
      "lane": "trellis_selfhost", "tier": "standard",
      "status": "ok", "glbUrl": "...", "creationId": "...",
      "effectiveLane": "trellis_selfhost", "cached": false,
      "views": [
        { "view": "front", "scores": [ { "photorealism": 7, "geometryIntegrity": 6, "textureFidelity": 7, "promptAdherence": 8, "critique": "...", "modelVersion": "gemini-2.5-pro-..." }, { /* 2nd scoring */ } ], "avg": { "photorealism": 7, "...": "...", "mean": 6.8 } },
        { "view": "three-quarter", "...": "..." },
        { "view": "side", "...": "..." }
      ],
      "meanScore": 6.6
    }
  ]
}
```

`lane` is the lane the sweep ASKED for; `effectiveLane` is the lane that
actually produced the GLB, as reported by `/api/forge`. They differ whenever the
router failed over (a cooling NVIDIA NIM gateway reroutes to the reconstruct
lane, an exhausted HF Space hands off to a self-host worker), so always read
per-lane means off `effectiveLane` — a run where every `nvidia` row carries
`effectiveLane: "huggingface"` measured Hugging Face twice, not NVIDIA once.
`cached` marks a result `/api/forge` served from its own result cache rather
than re-running the GPU pipeline (the same real generation, no double spend).

`meanScore` on a result averages that combo's per-view means (each view's mean
already averages its two independent judge scorings). A `lane_failed` result
means the lane was down or the generation errored (`error` field has the
reason) — recorded as `meanScore: 0`, never dropped, so an outage shows up as a
visible dip rather than a gap in the data. A `scoring_failed` result means
generation and render succeeded but the judge couldn't be reached — `meanScore`
is `null` (excluded from means) and each view's `error` explains why.

The dashboard at `/quality-bench` (`api/quality-bench.js` +
`pages/quality-bench.html`) renders this run history: score trends by lane,
tier, and subject class, a worst-5 gallery with critiques, and a full results
table. It's an internal path (not in `data/pages.json`) — no changelog entry
unless it's made public.

## Regression gate

```sh
node scripts/quality-bench.mjs --compare=latest,previous
# or by explicit filename:
node scripts/quality-bench.mjs --compare=run-2026-07-30T00-00-00-000Z.json,run-2026-07-23T12-00-00-000Z.json
```

Exits nonzero (and prints `REGRESSION: ...`) when the first run's overall mean
score dropped more than 1.0 point versus the second. Run this before/after any
forge change that could affect output quality (a new tier's sampler budget, a
new lane, a prompt-enhancement change) — see the note in `docs/forge.md`
(or wherever the forge pipeline is documented) linking back here.

A separate weekly Cloud Scheduler job (`api/cron/quality-bench.js`, schedule
`23 3 * * 1` in `vercel.json`) runs a small 3-prompt smoke sweep against the
platform's default standard-tier lane and logs a structured summary line
(`[cron] quality-bench smoke run {...}` or `... REGRESSION {...}`) comparing
against every committed run's mean for that lane/tier — Cloud Run's filesystem
is ephemeral so it can't commit a run file itself; check
`gcloud logging read 'resource.type="cloud_run_revision" textPayload:"quality-bench"' --freshness=7d`
for its output. The full, authoritative baseline is the one committed by
running `scripts/quality-bench.mjs` by hand (or from CI) and checking the
resulting `runs/*.json` file in.

## Extending the bench

Add a new prompt: append an entry to `prompts.json` with a fresh `id` (next in
sequence), pick the narrowest `subjectClass` that fits, and write a `watch`
list naming the specific realism failures that subject tends to produce (not
generic ones already covered — check existing entries first). Never reuse or
edit an existing id.

Add a new lane: nothing to do here — `scripts/quality-bench.mjs` reads live
lanes from `/api/forge?catalog`, so a new backend in
`api/_lib/forge-tiers.js` is picked up automatically once it reports
`configured: true`.
