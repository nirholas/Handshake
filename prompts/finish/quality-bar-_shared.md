# Shared context for the quality-bar campaign (read this FIRST, before your prompt file)

Every prompt in `prompts/quality-bar/` assumes you have read this file. It exists so you
never have to stop and ask the owner anything. If something here contradicts the live tree
or live GCP state, trust the tree/GCP and note the drift in your final report.

## The non-negotiable operating clause

**Complete your task 100%. Never ask the owner a question. Never end with "should I..." or
a plan you did not execute.** If you hit a blocker, do all of the following instead of stopping:
1. Try the documented fallback for that blocker (most are listed below).
2. If no fallback works, route around it: ship every part of the task the blocker does not touch.
3. Document the blocker precisely in your final report (what failed, exact error, what you tried,
   the single command or console step that would clear it) and keep going.
A report that says "done except X, which needs owner action Y, everything else shipped and
verified" is success. A session that stopped to ask a question is failure.

## Budget position (why this campaign exists)

The owner has $100k+ in Google Cloud credits and has pre-approved spending them liberally on
quality. Do not economize on GCP. Concretely pre-approved: GPU worker instances (L4), warm
min-instances, Vertex AI calls (Gemini text + image models), Cloud Build minutes, GCS storage,
higher Cloud Run CPU/memory. NOT approved: onboarding any new non-Google paid API (no new
Replicate/OpenAI/etc. keys). Free external services already wired (NVIDIA NIM free lane,
HF Spaces) stay as fallbacks. Never downgrade model quality or reasoning effort to save money.

## GCP ground truth (verified 2026-07-16)

- Project: `aerial-vehicle-466722-p5`, region `us-central1`. Prod API service: `three-ws-api`
  (serves frontend + all `api/**` handlers via `server/index.mjs` and the `vercel.json` route
  table). Full runbook: `docs/ops/gcp-production.md`.
- Deploy main app: `npm run build` then `npm run deploy:gcp`, from a CLEAN worktree state for
  the files you touched (concurrent agents edit this tree; never deploy someone's half-finished
  work: `git stash --keep-index` patterns or deploy from a fresh `git worktree add` of a commit).
  Builds must pin service accounts `three-ws-build@` (build) and `three-ws@` (runtime); the
  default compute SA was deleted. Deploys take ~12 min. `gcloud builds submit` does NOT purge
  the CDN; purge or cache-bust when a static asset must change immediately.
- Secrets: `gcloud secrets versions access latest --secret=<name>`. Known: `telegram-bot-token`.
  Runtime env lives ON the Cloud Run service (`gcloud run services describe three-ws-api
  --region us-central1`), NOT in Vercel exports (those return empty for secret vars). Local
  `.env` has a QA login for authed sweeps.
- GPU workers (Cloud Run, L4, us-central1), state as of 2026-07-16 21:15 UTC:
  - `model-trellis` LIVE (min=max=1, 8 CPU/32Gi). Self-hosted TRELLIS, primary free/standard lane.
  - `model-triposr` LIVE (min=1). Fast, lower quality. Holds a GPU permanently.
  - `unirig` LIVE. Auto-rigging (skeleton/skinning/ARKit-52).
  - `model-hunyuan3d` LIVE (rev 00005+, min=1, wired as `GCP_HUNYUAN3D_URL`). Highest-quality lane.
  - `model-triposg` LIVE as of 21:50 UTC (rev 00006, wired as `GCP_TRIPOSG_URL` on three-ws-api
    rev 00142). It was failing for TWO stacked reasons, both fixed: (1) upstream leaves
    peft/huggingface_hub unpinned and a bad transitive resolve crashed the diffusers import
    chain (now pinned: peft==0.19.1, huggingface_hub==0.36.2); (2) its lifespan awaited the
    full model load before uvicorn bound the port, so Cloud Run's 240s startup probe killed
    it (now bind-first + background load + _ready gate, same pattern as model-trellis; use
    that pattern in ANY new GPU worker).
  - `model-text2motion`, `workers/texture`, `workers/rembg`, `workers/segment`, `workers/stylize`,
    `workers/remesh`: sources in `workers/`, some live as `*-service`.
- GPU quota: Cloud Run L4 = `NvidiaL4GpuAllocNoZonalRedundancyPerProjectRegion`, granted 3,
  increase to 16 filed 2026-07-16 (check: `gcloud alpha quotas preferences list
  --project=aerial-vehicle-466722-p5`). All 3 are currently held (trellis, triposr, unirig),
  which is what blocks hunyuan3d. Fallback while waiting: do NOT kill other workers' instances;
  if your task needs a GPU slot urgently and the grant has not landed, drop `model-triposr`
  minScale to 0 (it is the weakest model; scale-from-zero is acceptable for it) and say so in
  your report. Compute Engine L4 quota (separate) is 8.
- Model weights bucket: `three-ws-model-weights`. Intermediate outputs:
  `three-ws-avatar-reconstructions`. Durable public assets live on Cloudflare R2 (`api/_lib/r2.js`);
  never move public asset storage to GCS.
- Worker auth: bearer `GCP_RECONSTRUCTION_KEY` (on both three-ws-api env and each worker).

## The 3D generation stack (router side)

- `api/forge.js`: the lane router (text→3D and image→3D), poll-time lane failover, one-click
  engine switching. Lane/tier budgets: `api/_lib/forge-tiers.js`. Health-aware routing:
  `api/_lib/forge-lane-health.js`, `api/_lib/provider-health.js`. Scale limits:
  `api/_lib/forge-scale.js`. Art-director prompt pass: `api/_lib/forge-director-prompts.js`
  (Granite director default-on as of 07-16). Prompt enhancement: `api/forge-enhance.js`
  (photoreal-by-default reference images; Vertex quality lane leads as of 07-16).
- Env URLs the router reads (verify exact names in code before setting): `MODEL_TRELLIS_URL`,
  `GCP_HUNYUAN3D_URL`, `GCP_TRIPOSG_URL`, `GCP_RECONSTRUCTION_URL` (unirig), `GCP_TEXT2MOTION_URL`,
  `NIM_TRELLIS_URL`.
- Vertex AI is wired and proven: `gemini-2.5-flash-image` for image generation
  (`api/_providers/gcp.js`), `vertex-gemini` as the anchor rung of the LLM fallback chain
  (`api/_lib/` LLM chain). Vertex spend is pre-approved; prefer it over free flaky rungs for
  anything quality-critical.
- The realism thesis this campaign executes: raw text→3D tops out at "game asset" look.
  IRL-real comes from (a) routing text prompts through PHOTOREAL REFERENCE IMAGES generated on
  Vertex (multi-view, studio-lit, neutral background) and feeding image→3D, (b) the strongest
  mesh+texture model available (Hunyuan3D once live, TRELLIS otherwise) at max step/texture
  budgets, (c) PBR material completeness (normal/roughness/metallic maps, not just albedo), and
  (d) viewer-side cinematic rendering (ACES tonemapping, HDRI environment, contact shadows).
  Each prompt file owns a slice of that chain.

## Verification (no green claims without these)

- `npm test` runs vitest THEN Playwright e2e; a vitest failure masks the whole e2e stage, so
  after a long red streak expect an e2e wall behind the first green.
- `npm run audit:web` sweeps 300+ pages headless with console-error capture (QA account creds in
  `.env`). Crawler concurrency can produce FALSE WebGL/texture errors; re-check any 3D failure
  serially before reporting it.
- Forge E2E: POST the real API (`/api/forge`) and poll to a finished GLB; then open the returned
  viewer link in Playwright and screenshot. A lane is not "live" until a real prompt returned a
  real GLB through the router (not via direct worker curl only).
- For UI work: `npm run dev` (port 3000), exercise the flow in a real browser, zero console
  errors from your code, check 320px/768px/1440px.
- Piped exit codes lie: never `cmd | tail` a test run and trust $?; capture the real exit code.

## Git and repo rules for this swarm

- Work directly on `main`. Concurrent agents share this worktree: stage EXPLICIT paths only
  (never `git add -A` / `git add .`), re-check `git status` and `git diff --staged` immediately
  before committing, and prefer `git commit <paths> -m ...` (pathspec commit) so you can never
  sweep someone else's staged files.
- Do NOT `git push` and do NOT post to any external channel (X, Telegram) unless the owner said
  so for this run. GCP deploys of the surfaces your prompt owns ARE approved for this campaign.
- Never reference any crypto project other than $THREE in committed content without owner
  approval (full rule in CLAUDE.md). Never use em-dash or en-dash characters anywhere you write.
- Every user-visible change gets a `data/changelog.json` entry (holder-readable language).
  New pages go in `data/pages.json`. Docs per the Documentation section of CLAUDE.md.
- `npx vercel build` corrupts `api/*.js` in place; if you see `__defProp` bundles in a diff,
  `git restore -- api/ public/`.

## Known blockers and their standing answers (do not re-ask)

- "Hunyuan3D weights/spend?" Approved. Weights go in `three-ws-model-weights`; GPU time is credits.
- "L4 quota?" Increase filed; check preferences list. Interim fallback documented above.
- "Missing REPLICATE/other paid API key?" Do not add one. Route to self-hosted GCP lanes instead.
- "NVIDIA NIM / HF lane is down or rate-limited?" Expected sometimes; they are fallbacks, not
  primaries, once self-host is live. Poll-time failover in `api/forge.js` already handles it.
- "Which model for LLM calls?" Vertex Gemini (`gemini-2.5-pro` for reasoning-heavy, flash for
  bulk). It is the anchor rung; free rungs stay for resilience.
- "May I raise Cloud Run CPU/memory/min-instances?" Yes, within granted quota. Note it in report.
- "Design tokens?" Use the existing CSS variables in `src/styles/`; if a token is missing,
  add it to the root token sheet and use it everywhere; do not hardcode one-off values.
