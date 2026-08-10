# prompts/

Internal work-order packs for Claude agents. Each subdirectory is a campaign: a set of self-contained prompt documents, each written to be pasted into a fresh Claude Code chat and executed to 100% without further input. These are operator documents, not a product surface. Nothing here ships to users.

## Conventions

- A pack opens with an index or shared-facts file (`README.md`, `00-INDEX.md`, `00-CONTEXT.md`, or `_shared.md`). Every work order tells the agent to read it first.
- Work orders are numbered (`01-...md`, `02-...md`) when run order matters.
- `PROGRESS.md`, where present, is the cross-chat handoff log: the only memory between sessions. Agents append to it when they finish.
- `_generated/` subdirectories hold machine-written evidence artifacts (JSON captures, screenshots, transcripts) produced by scripts, not by hand.

## The work-order standard (every open work order follows it)

A work order is a paste-and-run document. Pasting the whole file into a fresh Claude Code chat
in this repo must be enough for an agent to finish the job without asking the owner anything.
Each one carries, in this order:

1. **A how-to-run line**: paste this file, or name its path.
2. **A binding operating clause**: finish 100%, never end with a question or an unexecuted plan,
   plus the CLAUDE.md hard rules that bite most often (no mocks, no TODOs, no em-dash, explicit-path
   commits, deploys and pushes are owner-gated).
3. **Step 0, re-derive the current state**, with the exact commands. This is the load-bearing
   part: a work order's own status claims rot within weeks, so the agent measures first and
   skips whatever already shipped. Never trust a status line, including the ones in these files.
4. **Tasks** with real file paths, real endpoints and real commands.
5. **A definition of done** whose every line is mechanically checkable.
6. **A "never blocked" table** pre-answering the blockers that have historically stalled this
   work, so the answer is in the file instead of in the owner's inbox.
7. **A report format**, so the session ends with evidence rather than a recap.

The only interruptions a work order may contain are the CLAUDE.md stop-and-ask gates: spending
real funds, an irreversible on-chain write, a push or production deploy, a commit that
references a crypto project other than `$THREE`, and destroying unrecoverable data. Where one is
unavoidable, the work order batches every human touchpoint into a single message and does
everything else around it.

## Subdirectories

| Directory | What it is |
|---|---|
| [backlog/](backlog/) | The open backlog, one work order per item: everything [../ISSUES.md](../ISSUES.md) and the retired campaign logs still carry, each with a measured starting state and a definition of done. |
| [bnb-chain/](bnb-chain/) | BNB Chain campaign. Every work order shipped and was retired; `00-CONTEXT.md` keeps the adversarially-verified chain facts and `PROGRESS.md` the proof log. The whole track's one remaining gap is a funded BSC testnet deployer key plus a funded Greenfield account, both owner actions. |
| [event/](event/) | The $THREE Community Day (2026-08-08) pack: countdown surfaces, the `/play` polish sweep, the `/event` landing page, in-world event quests + leaderboard, the attendee cosmetic drop, photo mode, and the event-eve go/no-go preflight. |
| [fable-audit/](fable-audit/) | The 2026-07-11 deep audit. Every numbered finding shipped; [RESIDUALS.md](fable-audit/RESIDUALS.md) carries the three items deliberately left open. |
| [fix-queue/](fix-queue/) | Defects reproduced on 2026-08-01 by running the repo's own checks (`gate`, `lint`, `audit:links`, `audit:tour-atlas`, `check:cron-drift`, `check:runnable-docs`, `test:core`) plus a production probe, one work order per symptom, each carrying the verbatim output. Complements [backlog/](backlog/), which owns the infrastructure and owner-gated items. |
| [gcp-credits/](gcp-credits/) | The GCP credit program. Seven of eight work orders shipped and were retired; [05-catalog-animation-seeding.md](gcp-credits/05-catalog-animation-seeding.md) is the open one, turning credits into a curated catalog and a generated motion library. |
| [okx-ai/](okx-ai/) | Taking the three.ws 3D Studio listing (agent #2632) to approved status on OKX.AI. Three open orders (real-payment gauntlet, relisting, final audit and launch), plus `RUNBOOK.md` and the progress log. Each batches its OTP and funding needs into one owner message. |
| [production-100/](production-100/) | The run-to-100% campaign: a master index sequencing every open work order across all packs toward a mechanically checkable "production ready, roadmap complete" end state, a standing ship-readiness order, closeout orders for residuals no other pack owned (stranded custodial funds, master-key hygiene, verdict tuning), and the batched owner-action list. |
| [quality-bar/](quality-bar/) | The GCP-credit quality campaign. Six open work orders (fleet scale, PBR materials, forge UX, design system, mobile, avatar likeness); the reference pipeline, flagship lane, viewers and eval harness shipped and were retired. |
| [roadmap/](roadmap/) | Four runnable work orders for existing surfaces (generation suite, creation consolidation, parametric avatar editor, developer resources), plus the strategy layer ([fable-playbook.md](roadmap/fable-playbook.md)) that decides what to run next and [REUSE-MAP.md](roadmap/REUSE-MAP.md) for license-vetted OSS. |
| [robinhood-chain/](robinhood-chain/) | Robinhood Crypto chain pack. All 19 work orders shipped; the index maps what they produced and the owner-side residuals. |
| [store-submissions/](store-submissions/) | Listing three.ws MCP tools across the Claude and OpenAI marketplaces and the MCP registries. All 21 numbered orders shipped; [01-submission-closeout.md](store-submissions/01-submission-closeout.md) owns the remaining code gaps and the human submission steps. `_generated/` holds the evidence and the live tracker. |
| [swarm-100/](swarm-100/) | The "100% production ready, roadmap complete" goal decomposed into 696 fully independent, single-task work orders (per-route browser audits, per-batch api/cron/docs audits, per-worker and per-SDK audits, repo-wide sweeps, and one order per README-roadmap slice). Any file runs standalone in a fresh chat; a finished order is deleted in its own closing commit, so the shrinking directory is the only progress ledger. Deliberate convention deviation: no shared index dependency and no PROGRESS.md, by design. |

Fully completed campaigns are removed from this directory once every work order is verified shipped (x402-catalog and x402-overhaul were retired 2026-07-28; agent-briefs, whose world-online program shipped through Phase 3, and user-value, all seven of whose work orders shipped, were retired 2026-07-30); their packs, progress logs, and evidence remain readable in git history. Open items they still carried were re-homed into [../ISSUES.md](../ISSUES.md) and then into [backlog/](backlog/).

Individual work orders are retired the same way. Most recently (2026-08-01) the OKX Agent
Identity Studio order and the Robinhood wallet-connect kit were deleted after their deliverables
were verified on disk, and the two fable-audit batch records were replaced by the residuals file
once their items closed. Retirement policy, unchanged: delete only after the deliverables are
verified shipped in the codebase, never merely because a progress log claims done.

## Runtime consumption

The server does not read this directory. Two kinds of code references exist:

1. Comments across `api/` and `scripts/` may cite prompt files as the design source for a feature. Before retiring a prompt file, grep for inbound references and rewrite them to name the campaign + work order instead of the path (the robinhood-chain pack was once wiped by cleanup without this step and had to be restored). Retirement policy (owner directive 2026-07-28): a work order is deleted only after its deliverables are verified shipped in the codebase; partial or blocked work orders stay.
2. A few evidence scripts write output here: `scripts/tokenize-3d-devnet-e2e.mjs`, `scripts/embodiment-evidence.mjs`, and `scripts/persona-identity-evidence.mjs` write into `store-submissions/_generated/`, and `scripts/export-examples.mjs` reads from `roadmap/_generated/`.

## Adding a file

- A new work order for an existing campaign goes in that campaign's directory, following its numbering and its index file's format.
- A new campaign gets a new subdirectory with its own index or `00-CONTEXT.md`, numbered work orders, and a `PROGRESS.md` if work spans multiple chats.
- One-off machine reports do not belong here; script-written sweep reports go in [../tasks/](../tasks/).
