# prompts/

Internal work-order packs for Claude agents. Each subdirectory is a campaign: a set of self-contained prompt documents, each written to be pasted into a fresh Claude Code chat and executed to 100% without further input. These are operator documents, not a product surface. Nothing here ships to users.

## Conventions

- A pack opens with an index or shared-facts file (`README.md`, `00-INDEX.md`, `00-CONTEXT.md`, or `_shared.md`). Every work order tells the agent to read it first.
- Work orders are numbered (`01-...md`, `02-...md`) when run order matters.
- `PROGRESS.md`, where present, is the cross-chat handoff log: the only memory between sessions. Agents append to it when they finish.
- `_generated/` subdirectories hold machine-written evidence artifacts (JSON captures, screenshots, transcripts) produced by scripts, not by hand.

## Subdirectories

| Directory | What it is |
|---|---|
| [agent-briefs/](agent-briefs/) | Multi-agent program briefs (design system, 3D world, world-online), each with a program overview and its own progress log. |
| [bnb-chain/](bnb-chain/) | BNB Chain campaign: payments and gasless-rail work orders with a verified-facts context file. |
| [fable-audit/](fable-audit/) | One work order per finding from the 2026-07-11 deep audit, with severity, exact defect location, fix, and verification. |
| [gcp-credits/](gcp-credits/) | Prompt pack for the GCP credit program: GPU worker deploys, catalog and animation seeding. |
| [okx-ai/](okx-ai/) | Sequenced work orders taking the three.ws 3D Studio listing (agent #2632) to approved status on OKX.AI, plus a runbook and progress log. |
| [quality-bar/](quality-bar/) | The GCP-credit quality campaign: a chain of prompts covering photoreal references, mesh and texture quality, PBR materials, viewers, UX, and an eval harness. |
| [roadmap/](roadmap/) | Self-contained improvement prompts for existing surfaces, plus the strategy layer ([fable-playbook.md](roadmap/fable-playbook.md)) that decides what to run next. |
| [robinhood-chain/](robinhood-chain/) | Robinhood Chain pack, organized in waves where later waves consume earlier output. |
| [store-submissions/](store-submissions/) | Prompts for listing three.ws MCP tools across Claude and OpenAI marketplaces and MCP registries. `_generated/` holds submission evidence. |
| [user-value/](user-value/) | User-facing platform features: creator profiles, activity feed, social graph, notifications, discovery search, leaderboard, onboarding. |

Fully completed campaigns are removed from this directory once every work order is verified shipped (x402-catalog and x402-overhaul were retired 2026-07-28); their packs, progress logs, and evidence remain readable in git history. Open items they still carried were re-homed into [../ISSUES.md](../ISSUES.md).

## Runtime consumption

The server does not read this directory. Two kinds of code references exist:

1. Comments across `api/` and `scripts/` may cite prompt files as the design source for a feature. Before retiring a prompt file, grep for inbound references and rewrite them to name the campaign + work order instead of the path (the robinhood-chain pack was once wiped by cleanup without this step and had to be restored). Retirement policy (owner directive 2026-07-28): a work order is deleted only after its deliverables are verified shipped in the codebase; partial or blocked work orders stay.
2. A few evidence scripts write output here: `scripts/tokenize-3d-devnet-e2e.mjs`, `scripts/embodiment-evidence.mjs`, and `scripts/persona-identity-evidence.mjs` write into `store-submissions/_generated/`, and `scripts/export-examples.mjs` reads from `roadmap/_generated/`.

## Adding a file

- A new work order for an existing campaign goes in that campaign's directory, following its numbering and its index file's format.
- A new campaign gets a new subdirectory with its own index or `00-CONTEXT.md`, numbered work orders, and a `PROGRESS.md` if work spans multiple chats.
- One-off machine reports do not belong here; script-written sweep reports go in [../tasks/](../tasks/).
