# fix-queue: defects reproduced by running the repo's own checks

Every file here is a self-contained work order. Paste one into a fresh Claude
Code chat in this repo and run it to 100% without further input. Read this index
first; every work order assumes it.

Opened 2026-08-01. Each work order below was found by **running a check and
reading its output**, not by reading a tracker. The reproducing command and its
verbatim output are in the file. Nothing here is speculative, and nothing here
is a status claim inherited from an older document.

## Scope, and where the other work lives

This pack is the **repo and product defect queue**: things that are broken in
the code, the pages, or the build, and that an agent can fix here and now with
no external dependency.

The **infrastructure and owner-gated backlog** (x402 settle runway, Solana RPC
capacity, LLM lanes, R2 CORS, the fact-check benchmark, BNB testnet deploys, the
OKX chat bot, x402scan) lives in [../backlog/](../backlog/) and is not
duplicated here. Do not open a second work order for anything that pack owns;
extend that pack instead.

## Shared facts (verified 2026-08-01)

- **Production is current.** `GET https://three.ws/api/version` returns
  `6cc0370dc`, which is `main` HEAD, on revision `three-ws-api-00353-tzp`. So
  "it just needs a deploy" is not available as an explanation right now.
  Re-check anyway, because `main` moves.
- **`gcloud` auth works from this workspace** (`gcloud scheduler jobs list`
  succeeded). If a gcloud call returns `invalid_rapt`, that is the known
  Workspace reauth failure and needs one `gcloud auth login` from the owner. Do
  not redesign around it.
- **The gate is RED.** `npm run gate` exits 1 on `audit:hidden-guard`. Work
  order 01 fixes it. If you are running any other work order, capture that
  known-red baseline first so it is clear you did not cause it, and do not let
  it stop you.
- **Concurrent agents share this worktree.** Stage explicit paths, never
  `git add -A`, and re-read a file before editing it if your task has been
  running a while. This pack was itself trimmed on the day it was written
  because another agent shipped an overlapping pack an hour later.

## Rules that apply to every work order here

1. CLAUDE.md wins. No mocks, no fake data, no TODOs, no stubs, no commented-out
   code, no em-dash characters.
2. Do not stop to ask. The self-unblock playbook in CLAUDE.md covers every
   blocker these work orders can hit. Finish, then report.
3. Deploys and pushes stay owner-gated. Prepare everything so shipping is one
   command, and say so in your report.
4. A fix is not done until the verification command in the work order passes and
   the `data/changelog.json` entry is written for anything user-visible.

## The queue

| # | Work order | Severity | Reproduce with |
|---|---|---|---|
| 01 | [The gate is red: one page has no `[hidden]` guard](01-gate-red-hidden-guard.md) | P0 repo | `npm run gate` |
| 02 | [Three eslint errors, one a real bug in a money test](02-lint-errors.md) | P1 | `npm run lint` |
| 03 | [A declared cron has never run in production](03-cron-drift-garment-sweep.md) | P1 | `npm run check:cron-drift` |
| 04 | [17 broken stops in the guided tour](04-tour-atlas-broken-stops.md) | P1 | `npm run audit:tour-atlas` |
| 05 | [108 dead `#` links across the site](05-stub-hrefs-dead-paths.md) | P2 | `npm run audit:links` |
| 06 | [A documented API call no longer answers as documented](06-runnable-docs-401.md) | P2 | `npm run check:runnable-docs` |
| 07 | [`npm run test:core` never finishes](07-test-core-timeout.md) | P1 | `npm run test:core` |
| 08 | [`optimize?draco=1` returns a BIGGER file, silently](08-avatar-optimize-inflates.md) | P1 | `curl` (in the file) |

Checks that were green on 2026-08-01 and are not represented here, so you do not
re-run them hoping for work: `audit:docs` (1236 files), `audit:handlers` (1888
handlers), `audit:pages` (161 routes), `check:tutorials` (69/69),
`check:browser-graph` (1168 modules), `check:claude`, `audit:routes`,
`audit:mcp`, `audit:mcp-golden`, `audit:x402-catalog`, `audit:tokens`, and
`audit:links` for broken internal links (0; only the stub hrefs in 05 remain).

## When you finish one

Append a line to [PROGRESS.md](PROGRESS.md) with the date, the work order, what
you changed, and the verification output. That file is the only memory between
chats. Delete a work order file only when its fix is verified shipped, per the
retirement policy in [../README.md](../README.md).
