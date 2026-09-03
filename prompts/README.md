# prompts/

Internal work-order documents for Claude agents: self-contained prompts, each written to be pasted
into a fresh Claude Code chat and executed to 100% without further input. These are operator
documents, not a product surface. Nothing here ships to users.

**Everything still to finish lives in one folder: [finish/](finish/).** Open a work order there,
paste it, run it. That folder is the whole queue; nothing outstanding is filed anywhere else.

## Layout

| Path | What it holds |
|---|---|
| [finish/](finish/) | Every open work order, flat, one file each. The filename is `<campaign>-<order>.md`, so `okx-ai-05-relisting-resubmission.md` is the relisting order of the OKX.AI campaign. Sorting the directory groups each campaign together. A campaign's index (`<campaign>-00-INDEX.md`, `-00-CONTEXT.md`, `-README.md`) and its handoff log (`<campaign>-PROGRESS.md`) sit beside its orders under the same prefix. |
| [masters/](masters/) | The nine reusable master prompts. They take a supplied TARGET instead of fixed tasks and never retire, so they are not part of the finish queue. |
| `<campaign>/_generated/`, `okx-ai/assets/`, `okx-ai/e2e-evidence/` | Machine-written evidence (JSON captures, screenshots, transcripts) produced by scripts. These stayed at their original paths because scripts read and write them by hardcoded path; see **Runtime consumption** below. |
| [bnb-chain/](bnb-chain/), [robinhood-chain/](robinhood-chain/) | Two fully shipped campaigns kept as reference: their context and progress files carry adversarially-verified chain facts that other work still cites. No open orders. |

## Conventions

- A campaign's index or shared-facts file carries the facts every one of its orders needs. Each order names its index in its own opening lines; read it first.
- Orders keep their original numbering (`01-`, `02-`) after the campaign prefix when run order matters.
- `<campaign>-PROGRESS.md` is the cross-chat handoff log: the only memory between sessions. Agents append to it when they finish.
- **A finished order is deleted**, in its own closing commit, only after its deliverables are verified shipped in the codebase. `finish/` shrinking is the progress ledger.

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

## The queue

Every campaign with open work, and what its files under [finish/](finish/) cover. Counts are the
state measured on 2026-09-01; trust the directory, never this table.

| Prefix | What it is |
|---|---|
| `backlog-` | The open backlog, one work order per item: everything [../ISSUES.md](../ISSUES.md) and the retired campaign logs still carry, each with a measured starting state and a definition of done. Seven open (01, 05, 07 to 11). |
| `event-` | The $THREE Community Day pack (window 2026-08-09 17:00 to 19:30 UTC). What remains is the closeout (the standings board expired unexported, the log-derived counts are readable until about 2026-09-08), the `/play` polish sweep and photo mode. |
| `fable-audit-` | The 2026-07-11 deep audit. Every numbered finding shipped; [RESIDUALS.md](finish/fable-audit-RESIDUALS.md) is the one file left, carrying the three items deliberately left open plus the pack's history. |
| `fix-queue-` | Defects reproduced on 2026-08-01 by running the repo's own checks (`gate`, `lint`, `audit:links`, `audit:tour-atlas`, `check:cron-drift`, `check:runnable-docs`, `test:core`) plus a production probe, each carrying the verbatim output. Seven of eight shipped; the one left is the garment-sweep cron, blocked on an owner `gcloud auth login`. |
| `gcp-credits-` | The GCP credit program. Seven of eight shipped; [the catalog and animation seeding order](finish/gcp-credits-05-catalog-animation-seeding.md) is the open one, turning credits into a curated catalog and a generated motion library. |
| `home-` | three.ws Home: an agent that runs a real house by voice, with a 3D body standing in a live model of it. Home Assistant owns the device layer (we write no device code), and the campaign builds everything above it: the encrypted connection store, the multi-tenant bridge runtime, the `/api/home/*` surface, the agent tools and the confirmation gate that a model cannot satisfy, the live 3D home and its floorplan editor, the browser voice loop, three.ws as a Home Assistant voice satellite, the dial-out add-on for LAN-only houses, then security, households and roles, observability, scale, privacy, the test program, a11y and 87 locales, docs and SDK publish, entitlements, and a standing go/no-go. Twenty-one orders over a shared context file, plus one horizon order for Matter. The client library and the investigation ([../docs/smart-home.md](../docs/smart-home.md), [../packages/home-bridge/](../packages/home-bridge)) landed before the campaign; nothing is wired into the product yet. |
| `materialize-` | The physical lane: any forge creation to a high-precision 3D print delivered to a door. Printability engine (analyze/repair/STL/color-3MF), quote + order + Solana USDC checkout incl. the x402 agent lane, the /materialize surface with true-scale AR, fulfillment adapters + operator console, on-chain print certificates with editions and QR provenance, fabrication content gate. Six orders over a shared context file; launches on a manual-fulfillment adapter, no partner dependency. |
| `okx-ai-` | Taking the three.ws 3D Studio listing (agent #2632) to approved status on OKX.AI. Three open orders (real-payment gauntlet, relisting, final audit and launch) plus a runbook. Each batches its OTP and funding needs into one owner message. |
| `openai-pr-` | The OpenAI Apps SDK submission pack. Briefs 01 to 05 shipped; 06 (the tool count drifted to 11 across the kit) and 07 (the go/no-go, never run) remain, with the portal submit owner-only. |
| `production-100-` | The run-to-100% campaign: a master index sequencing every open work order toward a mechanically checkable "production ready, roadmap complete" end state, a standing ship-readiness order, closeout orders for residuals no other campaign owned (stranded custodial funds, master-key hygiene, verdict tuning), and the batched owner-action list. Its map was re-measured against code and production on 2026-09-01; start there. |
| `quality-bar-` | The GCP-credit quality campaign. Six open orders (fleet scale, PBR materials, forge UX, design system, mobile, avatar likeness); the reference pipeline, flagship lane, viewers and eval harness shipped. |
| `roadmap-` | Five runnable orders for existing surfaces (generation suite, creation consolidation, parametric avatar editor, developer resources, native home-screen widgets), plus the strategy layer ([the playbook](../docs/internal/fable-playbook.md)) that decides what to run next and [the reuse map](finish/roadmap-REUSE-MAP.md) for license-vetted OSS. |
| `simulation-ready-` | The physics-grade asset campaign: turning generated 3D into assets a rigid-body simulator can consume unedited (metric scale, watertightness, mass and inertia, a collision proxy), signed into the provenance credential and filterable by a buying agent. Its context file carries the frontier bet, the scored candidate table it beat, and the measured kernel evidence (20 live assets graded; 2 of 20 usable as-is, 0 of 10 from our own lanes). Awaiting its architect pass. |
| `store-submissions-` | Listing three.ws MCP tools across the Claude and OpenAI marketplaces and the MCP registries. All 21 numbered orders shipped; [the closeout](finish/store-submissions-01-submission-closeout.md) owns the remaining code gaps and the human submission steps. |
| `swarm-100-` | The "100% production ready, roadmap complete" goal decomposed into fully independent, single-task orders (per-route browser audits, per-batch api/cron/docs audits, per-worker and per-SDK audits, repo-wide sweeps, and one order per README-roadmap slice). Any file runs standalone in a fresh chat and depends on no index (157 left on 2026-09-01: 151 route audits, 4 sweeps, 1 roadmap slice). |

Fully completed campaigns leave the queue once every order is verified shipped (x402-catalog and
x402-overhaul were retired 2026-07-28; agent-briefs, whose world-online program shipped through
Phase 3, and user-value, all seven of whose orders shipped, were retired 2026-07-30); their orders,
progress logs, and evidence remain readable in git history. Open items they still carried were
re-homed into [../ISSUES.md](../ISSUES.md) and then into the `backlog-` orders.

Individual orders retire the same way. Retirement policy, unchanged: delete only after the
deliverables are verified shipped in the codebase, never merely because a progress log claims done.

On 2026-09-01 a repo-wide sweep re-verified every open order against code and production and
retired fourteen (event 01/03/04/05/07, backlog 02/03/04/06, the OpenAI pack's briefs 01 to 05)
plus the fable-audit index, and rewrote the production-100 map from the measurements; the
per-order evidence is in each campaign's log and in
[production-100/PROGRESS.md](finish/production-100-PROGRESS.md).

On 2026-09-02 every open order moved out of its per-campaign directory into [finish/](finish/) so
the queue is one folder instead of fourteen. Nothing was rewritten beyond link paths; the campaign
is now the filename prefix.

## Runtime consumption

The server does not read this directory. Two kinds of code references exist:

1. Comments across `api/` and `scripts/` may cite prompt files as the design source for a feature. Before retiring a prompt file, grep for inbound references and rewrite them to name the campaign + work order instead of the path (the robinhood-chain pack was once wiped by cleanup without this step and had to be restored). Retirement policy (owner directive 2026-07-28): a work order is deleted only after its deliverables are verified shipped in the codebase; partial or blocked work orders stay.
2. A few evidence scripts write output here, by hardcoded path. That is why the evidence directories did NOT move into `finish/` when the work orders did: `scripts/tokenize-3d-devnet-e2e.mjs`, `scripts/embodiment-evidence.mjs`, `scripts/persona-identity-evidence.mjs`, `scripts/agent-hire-settle.mjs` and `scripts/sync-studio-openapi.mjs` write into `store-submissions/_generated/` (the last one keeps `openai-actions.yaml` byte-identical to the served schema, and `tests/api/3d-studio-openapi.test.js` reads it), `scripts/mobile-perf.mjs`, `scripts/mobile-touch-audit.mjs`, `scripts/avatar-likeness-audit.mjs` and `scripts/irl-realism-check.mjs` write into `quality-bar/_generated/`, and `scripts/export-satellites.mjs` reads from `roadmap/_generated/`. Moving one of these means updating its script in the same change.

## Adding a file

- A new work order for an existing campaign goes in [finish/](finish/) as `<campaign>-<nn>-<slug>.md`, following that campaign's numbering and its index file's format.
- A new campaign starts with its own `<campaign>-00-CONTEXT.md` (or `-00-INDEX.md`) in the same folder, plus a `<campaign>-PROGRESS.md` if the work spans multiple chats. No new directory.
- Evidence a script writes goes in `<campaign>/_generated/`, not in `finish/`, and the script names that path.
- One-off machine reports do not belong here; script-written sweep reports go in [../tasks/](../tasks/).
