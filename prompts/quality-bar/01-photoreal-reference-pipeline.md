# 01: Photoreal reference-image pipeline (the realism multiplier)

Read `prompts/quality-bar/_shared.md` first. Its operating clause applies: finish 100%, never ask.

## Mission

Make every text→3D generation route through photoreal reference images by default, at every
tier, so the output looks like an IRL object or person instead of a game asset. This is the
single highest-leverage realism change on the platform and it runs entirely on Vertex AI
(pre-approved credits).

## Current state (verify against tree, commits of 2026-07-16)

`api/forge-enhance.js` already leads with a Vertex quality lane and photoreal-by-default
reference images (commit 2faa4ff5d), and the Granite art-director pass is default-on
(776e2a5ab, 94d0f8dc7). Your job is to take this from "shipped" to "excellent and proven at
every tier and entry point", not to rebuild it.

## Tasks

1. **Audit every entry point that reaches the forge router** and confirm each one actually
   gets the reference-image treatment: `/forge` UI, `/api/forge` direct callers, the MCP tools
   (`forge_free`, `mesh_forge`, `text_to_avatar`, `forge_avatar` in `api/_mcp3d/`), the ChatGPT
   GPT lane, and `/api/nim-forge.js`. Any lane that skips enhancement is a realism hole; wire it.
2. **Multi-view consistency.** A single reference image leaves the model guessing the back.
   Where the image→3D backend accepts multiple views (Hunyuan3D does; check TRELLIS worker
   contract in `workers/model-trellis/main.py`), generate a 3-view set (front, 3/4, back) on
   `gemini-2.5-flash-image` with a shared seed/description so the views agree. Studio-lit,
   neutral seamless background, no dramatic shadows, full subject in frame, no crop.
3. **Subject-aware prompt templates.** In `api/_lib/forge-director-prompts.js`, split the
   photoreal template by subject class (person / creature / hard-surface object / food /
   vehicle / architecture). People need explicit skin texture, subsurface scattering cues, and
   catchlight language; objects need material callouts (brushed aluminum, worn leather). Keep
   the existing logo/brand lexicon behavior intact.
4. **Reference-image QA gate.** Before spending GPU time on a bad reference, score the
   generated reference with a cheap Vertex flash vision call: is the subject complete, centered,
   photorealistic, background clean? One retry with corrective feedback on failure, then
   proceed with best-of. Log scores so the eval harness (prompt 09) can correlate.
5. **Cache references.** Same enhanced prompt within 24h should reuse its reference set
   (existing cache patterns in `api/_lib/`; key on enhanced-prompt hash). Credits are approved
   but latency matters for UX.
6. **Prove it.** Run the fixed benchmark prompt set (create it if prompt 09 has not run yet:
   10 prompts covering a person, a face closeup, an animal, food, a vehicle, a household
   object, a tree, a building, a tool, a fantasy subject) through the full pipeline at each
   tier. Save before/after GLB screenshots. At least 8/10 must be visibly more photoreal than
   the pre-change output; iterate on templates until they are.

## Definition of done

- Every entry point verified wired (list them in the report with file:line).
- Multi-view references feeding every backend that accepts them.
- Benchmark screenshots in the report; `data/changelog.json` entry (holder language: "3D
  generations look dramatically more real"); docs updated (`docs/` forge page if it exists).
- Zero new non-GCP APIs. All committed via pathspec commits.

## Anticipated blockers, pre-answered

- Vertex image model name drift: list models with `gcloud ai models list` or check
  `api/_providers/gcp.js` for the exact id in use; use what the code uses.
- Image model refuses a subject (real person's name): the director template must already
  genericize identity prompts; keep that behavior, never generate real-person likenesses from
  names, and note nothing else.
- Hunyuan3D not yet Ready: verify with `gcloud run services describe model-hunyuan3d`; if still
  waiting on quota, prove the pipeline on TRELLIS and note hunyuan verification as a one-command
  re-run for when it lands.
