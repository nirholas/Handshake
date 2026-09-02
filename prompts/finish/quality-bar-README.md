# quality-bar: the GCP-credit quality campaign

Owner directive 2026-07-16: spend the Google Cloud credits liberally to make the platform's
UX and UI excellent and 3D generations as real-looking as IRL people and objects. No new
non-GCP paid APIs. Agents complete their work order 100% and never stop to ask questions.

**Read `quality-bar-_shared.md` before any work order.** Each work order is also self-contained: paste the
file into a fresh Claude Code chat and it runs.

## The thesis

IRL-real 3D is a chain and every work order owns one link: photoreal reference images, then the
strongest mesh and texture model at fleet scale, then complete PBR materials, then cinematic
viewers, wrapped in a flagship UX, measured so it cannot regress, with humans as the hardest
special case.

## Open work orders

| # | File | Owns | State |
|---|------|------|-------|
| 03 | [03-gpu-fleet-scaleout.md](quality-bar-03-gpu-fleet-scaleout.md) | Scale ceilings, cold-start honesty, keep-warm, load test | Partial. The TripoSG and text2motion deploys it opened with are shipped; scale, cold-start UX and the load test are open. |
| 04 | [04-pbr-texture-material-realism.md](quality-bar-04-pbr-texture-material-realism.md) | Full PBR sets, measured presets, skin/eye/hair | Open |
| 06 | [06-forge-ux-flow.md](quality-bar-06-forge-ux-flow.md) | The `/forge` flagship experience | Partial. History, compare mode and starters shipped; the result-moment click-through and the clean audit sweep are open. |
| 07 | [07-design-system-sweep.md](quality-bar-07-design-system-sweep.md) | Tokens, states, microinteractions sitewide | Open |
| 08 | [08-mobile-performance.md](quality-bar-08-mobile-performance.md) | Mobile excellence, GLB delivery | Partial. A measured baseline exists in `_generated/08/`; the fixes and the re-measure are open. |
| 10 | [10-avatar-likeness-irl-people.md](quality-bar-10-avatar-likeness-irl-people.md) | IRL people: likeness, hands, rig, AR | Partial. Animation dignity is proven across ten rig conventions; one runtime-lane defect plus the likeness audit are open. |

Retired after verification (readable in git history): 01 photoreal reference pipeline, 02 the
Hunyuan3D flagship lane, 05 cinematic viewers, 09 the realism eval harness (now
`scripts/quality-bench.mjs` plus the weekly cron).

Suggested order: 04, 07 and 08 have no dependencies and can run in parallel. 03 unblocks
throughput. 06 and 10 land best after 04.

## Ground rules recap (full versions in `quality-bar-_shared.md` and `CLAUDE.md`)

- GCP spend approved; no new external paid APIs; never trade quality for cost.
- Explicit-path commits only; concurrent agents share this worktree; no push or external post
  without the owner saying so. GCP deploys of the surface a work order owns are in scope.
- Every user-visible change gets a `data/changelog.json` entry. Every claim is verified with the
  receipts in the final report. Blockers are routed around and documented, never asked about.
