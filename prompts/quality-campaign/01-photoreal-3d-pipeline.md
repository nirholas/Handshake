# 01 - Photoreal objects: multi-view fusion + texture fidelity

Read `README.md` in this directory first (never-stop contract, standing approvals, shared
context). Never end a turn with a question. GCP spend is pre-approved; no new third-party APIs.

## Mission

A text->3D generation on three.ws should look like a photograph of a real object from every
angle. The single-reference-image pipeline guesses the back and sides of every object; the fix
is multi-view: generate front/side/back reference views with the Vertex image model and fuse
them in TRELLIS (`run_multi_image`) and Hunyuan3D (both accept multiple input images; the
worker `/infer` already takes `images: []` as a list). Then close the texture-fidelity gap:
the final mesh texture must carry the reference image's material detail, not a blurred bake.

## Current state (verified 2026-07-16; re-verify against the tree, the swarm moves fast)

- A multi-view synthesis effort was mid-flight in the swarm on 07-16 ("multiview-fusion" tier
  blurbs landed in commit c2e07162a). FIRST ACTION: `git log --oneline -20` and
  `grep -rn "multi_image\|multiview\|multi_view" api/ workers/model-trellis/ workers/model-hunyuan3d/`
  to find what already shipped. Extend what exists; do not duplicate it.
- Reference images: `api/_mcp3d/text-to-image.js` (realism suffixes live here) over
  `api/_mcp3d/vertex-imagen.js` (`gemini-2.5-flash-image`, `:generateContent`). The Gemini
  image model accepts an input image + instruction, which is how you get consistent side/back
  views: pass the generated front view with "same exact object, rotated to a direct side view,
  same lighting and background" rather than re-prompting from text (re-prompting drifts).
- Workers: `workers/model-trellis/main.py` (TRELLIS pipeline; `run_multi_image` exists in the
  TRELLIS library), `workers/model-hunyuan3d/main.py` (`images` list already in the wire
  shape). Worker auth: Secret Manager `avatar-reconstruction-key`. Wire: POST /infer -> task_id,
  GET /tasks/:id -> result_gcs_url, /health.
- Lane plumbing: `api/_providers/gcp.js` (modes `trellis`/`hunyuan`, passes `params.quality`),
  `api/_lib/forge-tiers.js` (per-tier budgets), `api/forge.js` (routing, ~2000 lines).
- Tier semantics: draft = speed, standard = default, high = paid Hunyuan3D lane. Multi-view
  belongs on standard and high (draft stays single-view fast).

## Tasks

1. **Audit what shipped.** Map the current multi-view state end to end. If the swarm finished
   it, skip to task 3 and deepen texture fidelity instead; report which branch you took.
2. **Multi-view reference synthesis.** In `text-to-image.js` (or a sibling module), add
   `textToMultiView(prompt)`: front view from text, then side + back via image+instruction
   edits of the front view for object consistency. Store all views in R2 like single
   references. Wire through `gcp.js` so `images[]` carries all views to TRELLIS
   (`run_multi_image`) and Hunyuan3D on standard/high tiers. Flag-gate:
   `FORGE_MULTIVIEW=1` on by default in code, `0` reverts to single-view. Cost per gen is
   2 extra Vertex images + longer GPU seconds: pre-approved.
3. **Texture fidelity.** The reconstruction's baked texture is the weak link. Options already
   in-house, in preference order: raise texture bake size where the worker clamps it (2048 is
   the current clamp; measure whether 4096 fits L4 VRAM at high tier before enabling);
   Hunyuan3D's paint/texture stage settings in `workers/model-hunyuan3d/main.py`
   (`_quality_for`); the `stylize`/`texture` workers for a detail pass. Pick what measurably
   helps; show before/after renders.
4. **Prompt treatment.** The realism suffixes are good; extend them only where evaluation shows
   drift (e.g. metallic/glass materials, text on labels). Keep the ART_STYLE_WORDS skip rule:
   a user asking for "cartoon" must never get photoreal.
5. **Verification harness (definition of done).** Generate this fixed prompt set at standard
   and high, before and after your changes: leather armchair, chrome espresso machine, worn
   hiking boot, glass perfume bottle, wooden acoustic guitar. For each: GLB size, triangle
   count, texture resolution, quality score from the pipeline, and a 4-angle render
   (front/back/left/right; `scripts/` has GLB render helpers, else use three.js headless via
   the existing test tooling). Back/side views must depict the object, not a mirrored front.
6. **Ship.** Deploy touched workers (Cloud Build, clean worktree), set env on `three-ws-api`,
   run one live production generation per tier, commit code + docs (changelog entry: holders
   care about "3D generations now look real from every angle").

## Guardrails

- Do not break the free draft lane's latency; multi-view is standard/high only.
- NVCF hosted results are consume-once (poll handling in `api/_lib/forge-failover.js`); do not
  re-fetch a hosted result URL twice.
- The swarm may be mid-deploy on these exact workers. Before deploying, `gcloud run revisions
  list` and confirm you are not clobbering a newer revision than your base; rebase your change
  on the deployed source if the repo and the deployed image diverge.

## Acceptance criteria

- [ ] Standard + high tiers fuse >= 3 reference views (proven by worker logs + payload capture).
- [ ] The 5-prompt eval set shows better back/side fidelity than baseline (renders in the report).
- [ ] `FORGE_MULTIVIEW=0` cleanly reverts to today's behavior (tested).
- [ ] One live production generation per tier completes E2E; URLs in the report.
- [ ] Committed with changelog entry + docs; `npm test` green; report contains every command and measurement.
