# 09: Realism eval harness (measure it or it regresses)

Read `prompts/quality-bar/_shared.md` first. Its operating clause applies: finish 100%, never ask.

## Mission

Build the measurement loop the whole campaign hangs on: a fixed benchmark of prompts, an
automated generate-render-score pipeline using Vertex Gemini vision as judge, and a dashboard
so "did quality go up" is a number, not a vibe. Everything runs on GCP credits.

## Tasks

1. **Benchmark set.** `data/quality-bench/prompts.json`: 20 fixed prompts spanning people
   (portrait, full body), animals, food, vehicles, tools, furniture, architecture, nature,
   fantasy, and 3 image→3D cases (fixed CC0 reference photos stored alongside). Each entry:
   id, prompt, subject class, what realism failure to watch for (plastic skin, melted text,
   blob geometry).
2. **Runner.** `scripts/quality-bench.mjs`: for a given lane/tier (or all), fire each prompt
   through the REAL `/api/forge` path, poll to GLB, render 3 canonical views (reuse the
   headless screenshot harness from the og-image work), and score each view with Vertex
   Gemini (`gemini-2.5-pro` vision): photorealism 1-10, geometry integrity 1-10, texture
   fidelity 1-10, prompt adherence 1-10, one-line critique. Judge prompt must include the
   subject-class failure watchlist. Persist runs to `data/quality-bench/runs/` as JSON
   (append-only, one file per run, committed).
3. **Anti-gaming rules.** The judge sees only rendered images, never the prompt-enhancement
   text; temperature 0; each image scored twice and averaged; keep the judge prompt in the
   repo so scores are comparable across runs.
4. **Dashboard.** A page (internal path is fine, e.g. `/quality-bench`, added to
   `data/pages.json` only if made public) rendering the run history: score trends per lane and
   subject class, worst-5 gallery with critiques, side-by-side of any two runs. Real fetch of
   the committed run JSON, designed states per the platform bar.
5. **Regression gate.** A weekly Cloud Scheduler job runs the bench on the primary lanes and
   posts a summary line into the run log; `scripts/quality-bench.mjs --compare latest,previous`
   exits nonzero on a >1.0 mean drop so any agent can check for regressions before/after a
   forge change. Document that check in the forge docs so future swarm prompts adopt it.
6. **First real runs.** Execute the bench on every live lane at standard and high tiers. This
   baseline is the campaign's before picture; later prompts cite it.

## Definition of done

- Bench set, runner, dashboard, scheduler job all live; baseline runs committed.
- Runner is idempotent and resumable (a crashed run resumes, never double-spends).
- README in `data/quality-bench/` explaining how to run, read, and extend it.
- Changelog entry only if the dashboard is public; otherwise internal (no entry).

## Anticipated blockers, pre-answered

- Cost math: 20 prompts x 3 views x 2 scorings is 120 vision calls per lane-tier, trivially
  within credits; GPU time dominates and is approved. Do not sample down.
- A lane down mid-run: record the failure as a scored zero with reason, continue; the runner
  never aborts a whole run for one lane.
- Judge self-preference drift: scores are comparative over time on fixed inputs; note model
  version (`modelVersion` from the response) in each run file so a Gemini upgrade is visible
  in the data.
