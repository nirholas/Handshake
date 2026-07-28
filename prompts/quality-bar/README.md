# quality-bar: the $100k GCP-credit quality campaign

> Retirement note (2026-07-28): work orders verified fully shipped were deleted from this pack per owner directive; their files remain in git history. Links below to missing files refer to retired, completed work orders. Remaining files are open or partial.

Owner directive 2026-07-16: spend the Google Cloud credits liberally to make the platform's
UX/UI excellent and 3D generations as real-looking as IRL people and objects. No new non-GCP
paid APIs. Agents complete their prompt 100% and never stop to ask questions;
`_shared.md` carries everything needed to make that possible. Read it before any prompt.

## The thesis

IRL-real 3D is a chain, and every prompt owns one link:

photoreal reference images (01) -> strongest mesh+texture model (02) at fleet scale (03)
-> complete PBR materials (04) -> cinematic viewers (05), wrapped in a flagship UX (06, 07, 08),
measured so it cannot regress (09), with humans as the hardest special case (10).

## Prompts

| # | File | Owns | Depends on |
|---|------|------|------------|
| 01 | 01-photoreal-reference-pipeline.md | Vertex reference images at every entry point | none |
| 02 | 02-hunyuan3d-flagship-lane.md | Hunyuan3D live and quality-leading | quota grant (in flight) |
| 03 | 03-gpu-fleet-scaleout.md | TripoSG fix, text2motion, scale ceilings, cold-start UX | quota grant helps |
| 04 | 04-pbr-texture-material-realism.md | Full PBR sets, skin/eye/hair materials | none |
| 05 | 05-cinematic-viewers-everywhere.md | One rendering bar in every viewer | none |
| 06 | 06-forge-ux-flow.md | /forge flagship experience | best after 01, 05 |
| 07 | 07-design-system-sweep.md | Tokens, states, microinteractions sitewide | none |
| 08 | 08-mobile-performance.md | Mobile excellence, GLB compression | best after 05 |
| 09 | 09-realism-eval-harness.md | Benchmark + Gemini judge + regression gate | run EARLY for the baseline |
| 10 | 10-avatar-likeness-irl-people.md | IRL people: likeness, hands, rig, AR | best after 02, 04 |

Run 09 first (baseline), then 01/04/05/07 in parallel (no dependencies), 02/03 as quota lands,
then 06/08/10.

## Ground rules recap (full versions in _shared.md and CLAUDE.md)

- GCP spend approved; no new external paid APIs; never trade quality for cost.
- Pathspec commits only; concurrent agents share the worktree; no push/post without owner say-so
  (GCP deploys of surfaces your prompt owns ARE in scope for this campaign).
- Every user-visible change: changelog entry. Every claim: verified, with the receipts in the
  final report. Blockers get documented and routed around, never asked about.
