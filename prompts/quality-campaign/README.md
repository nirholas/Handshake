# Quality Campaign: photoreal 3D + sitewide UX/UI (GCP-credit funded)

Owner directive 2026-07-16: improve the UX, UI, and quality of everything; make 3D generations
as real-looking as IRL people and objects; spend the ~$100k Google Cloud credits freely to get
there; onboard NO new third-party APIs. Run each prompt in a fresh Claude Code chat.

## The never-stop contract (applies to every prompt in this pack)

The owner's single biggest complaint is agents stopping mid-task to ask questions. Every prompt
here is written to be 100% self-contained: it names the files, the env vars, where credentials
live, the verification commands, and the standard resolution for every predictable blocker.
Read the "Self-unblock playbook" in CLAUDE.md before starting; it is binding. In short:

- Never end a turn with a question, an offer, or a plan. Finish, verify, then report.
- Missing credential: check `.env`, then `gcloud run services describe three-ws-api --region us-central1`, then `gcloud secrets list`. Only after all three may you report it missing (with the feature fully built behind the env var).
- Ambiguous choice: take the most reversible option that matches existing platform patterns, ship it, record the decision in your report.
- GCP quota wall: file the increase, then route around (lower an idle service's minScale, another region, queue on existing capacity).
- Someone else's failing test blocking your verification: root-cause and fix it; never mask, never stop.

## Standing approvals (so nothing needs asking)

- **GCP spend is pre-approved.** Project `aerial-vehicle-466722-p5`, region `us-central1`. GPU seconds, Vertex AI calls, minScale warm instances, storage: all fine. Prefer GCP over any paid third-party API.
- **No new external paid APIs.** Vertex AI, Cloud Run, GCS, Cloud Build, Secret Manager are all in-house surfaces and pre-approved. Replicate/Meshy/etc. must NOT be added or funded.
- **Commits to `main` are normal** (owner works on main, no feature branches). Stage explicit paths only (`git add <paths>`, never `-A`): concurrent agents share this worktree.
- **`git push` and social posts still require owner approval.** GCP service deploys needed to complete a prompt are approved as part of running it; use the clean-worktree recipe below.

## Shared operational context (verified 2026-07-16)

- Production: Cloud Run service `three-ws-api` (us-central1) serves frontend + `vercel.json` routes + `api/**`. Deploy: `npm run build && npm run deploy:gcp`, ideally from a clean worktree (`git worktree add /workspaces/.deploy-wt HEAD`, deploy there, `git worktree remove`), because the swarm's dirty files must not ship. `gcloud builds submit` alone skips the CDN purge; use the npm script.
- GPU fleet (all Cloud Run + NVIDIA L4, us-central1, verified live today):
  - `model-trellis` (TRELLIS image->3D, `MODEL_TRELLIS_URL`), quality knobs ss/slat 8..50 steps, simplify >= 0.5, texture <= 2048.
  - `model-hunyuan3d` (Hunyuan3D-2 image->3D, `GCP_HUNYUAN3D_URL`), high-tier lane.
  - `unirig` (auto-rigging, `GCP_UNIRIG_URL`), `avatar-reconstruction`, plus `rembg/remesh/segment/stylize` CPU helpers.
  - Worker auth: bearer key in Secret Manager secret `avatar-reconstruction-key`; wire shape `POST /infer -> {task_id}`, `GET /tasks/:id -> result_gcs_url`, health at `/health`.
- Reference images: Vertex `gemini-2.5-flash-image` via `api/_mcp3d/vertex-imagen.js` (`:generateContent`); prompt realism treatment in `api/_mcp3d/text-to-image.js` (`REALISM_SUFFIX`, `PERSON_REALISM_SUFFIX`, skipped when the user names an art style).
- Lane routing: `api/forge.js` + `api/_providers/gcp.js`; tier budgets in `api/_lib/forge-tiers.js` (`SELFHOST_TRELLIS_QUALITY`: draft 12 steps/1024tex, standard 25/2048, high 45/2048); `FORGE_SELFHOST_PRIMARY=true` is live, self-hosted L4 workers outrank hosted NVIDIA NIM (NIM is capped ~15 steps by its 30s sync window and is the old quality ceiling).
- Quality signal: `forge_creations` DB table has a quality score per generation; download rate is the only organic user signal (ratings are unused).
- Frontend: vanilla JS + Vite, `npm run dev` (port 3000). Tests: `npm test` (vitest failure gates the Playwright e2e stage; never pipe test output through `tail`, it eats exit codes). Authed console sweep across 300+ pages: `npm run audit:web` (QA account creds already in `.env`).
- Docs duties per feature: `data/pages.json` for new routes, `data/changelog.json` entry for user-visible changes, `STRUCTURE.md` row for new surfaces. `npm run build:pages` validates.

## Prompts

| # | File | Theme | Parallel-safe with |
|---|------|-------|--------------------|
| 1 | `01-photoreal-3d-pipeline.md` | Multi-view fusion + texture fidelity for objects | 3, 4, 5 |
| 2 | `02-photoreal-humans.md` | IRL-looking people: faces, skin, hair | 3, 4, 5 (after 1 is cleanest) |
| 3 | `03-presentation-lighting.md` | Every viewer renders at the IRL cinematic bar | 1, 2, 4, 5 |
| 4 | `04-ux-funnel-sweep.md` | Loading/empty/error/microinteraction sweep of the core funnels | 1, 2, 3, 5 |
| 5 | `05-performance-vitals.md` | Core Web Vitals + perceived speed | 1, 2, 3, 4 |
| 6 | `06-quality-eval-harness.md` | Nightly generation-quality regression harness | run last |

Each prompt ends with acceptance criteria. A prompt is done when every criterion passes and the
report shows the evidence (commands run, URLs, measured numbers). Not before.
