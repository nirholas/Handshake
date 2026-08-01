# fix-queue: open defects and errors, one work order per file

Every file in this directory is a self-contained prompt. Paste one into a fresh
Claude Code chat in this repo and run it to 100% without further input. Read
this index first; every work order assumes it.

Opened 2026-08-01 from a live sweep of this worktree and of production. Each
symptom below was reproduced on that date, with the exact command and output
recorded in the work order. Nothing here is speculative.

## Shared facts (verified 2026-08-01)

- **Production is current.** `GET https://three.ws/api/version` returns
  `6cc0370dc`, which is `main` HEAD, on revision `three-ws-api-00353-tzp`. So
  the usual first question ("is this just a deploy gap?") is already answered:
  it is not. Re-check it anyway before you debug a production symptom, because
  `main` moves.
- **`gcloud` auth works from this workspace** (`gcloud scheduler jobs list`
  succeeded). This has historically been flaky (Workspace reauth policy), so if
  a gcloud call returns `invalid_rapt`, that is the known failure and needs one
  `gcloud auth login` from the owner. Do not redesign around it.
- **Project `aerial-vehicle-466722-p5`, region `us-central1`, service
  `three-ws-api`.**
- **The repo gate is currently RED.** `npm run gate` exits 1 on
  `audit:hidden-guard`. Work order 04 fixes it. If you are running a different
  work order, capture that known-red baseline first so you do not get blamed
  for it, and do not let it stop you.
- **Concurrent agents share this worktree.** Stage explicit paths, never
  `git add -A`, and re-read a file before editing it if your task has been
  running a while.

## Rules that apply to every work order here

1. CLAUDE.md wins over anything written here. No mocks, no fake data, no TODOs,
   no stubs, no commented-out code.
2. Do not stop to ask. The self-unblock playbook in CLAUDE.md covers every
   blocker these work orders can hit. Finish, then report.
3. Deploys and pushes stay owner-gated. Prepare everything so shipping is one
   command, and say so in your report.
4. Never top up per-agent x402 wallets. That strands SOL and kills the rail.
5. A fix is not done until it is verified by the command named in the work
   order, and the changelog entry (if user-visible) is written.

## The queue

| # | Work order | Severity | Blocked on |
|---|---|---|---|
| 01 | [x402 settle is DOWN at 26%](01-x402-settle-down.md) | P0 | nothing (diagnose first) |
| 02 | [Two of three paid Solana RPC lanes are exhausted](02-solana-rpc-paid-lanes.md) | P0 | owner (money), work is routing |
| 03 | [Every paid LLM backstop is dead](03-llm-paid-backstops.md) | P1 | owner (billing), work is failover proof |
| 04 | [The gate is red: missing hidden guard](04-gate-red-hidden-guard.md) | P0 repo | nothing |
| 05 | [Three eslint errors and 7804 warnings](05-lint-errors.md) | P1 | nothing |
| 06 | [A declared cron never runs in production](06-cron-drift-garment-sweep.md) | P1 | nothing |
| 07 | [17 broken stops in the guided tour](07-tour-atlas-broken-stops.md) | P1 | nothing |
| 08 | [108 dead `#` links across the site](08-stub-hrefs-dead-paths.md) | P2 | nothing |
| 09 | [A documented API call no longer answers as documented](09-runnable-docs-401.md) | P2 | nothing |
| 10 | [`npm run test:core` never finishes](10-test-core-timeout.md) | P1 | nothing |
| 11 | [`/api/avatar/optimize?draco=1` is 500 in production](11-avatar-optimize-draco.md) | P1 | owner (deploy) |
| 12 | [Live R2 CORS does not match the script](12-r2-cors.md) | P2 | owner (one token) |
| 13 | [The fact-check benchmark cannot be run](13-fact-check-benchmark.md) | P2 | owner (one credential) |
| 14 | [Two external-venue blockers](14-external-venue-blockers.md) | P2 | owner. **Commit gate applies** |

Work order 14 references crypto projects other than `$THREE`. Per CLAUDE.md,
writing and working on it is fine, but **committing it needs explicit owner
approval first.** The other thirteen carry no such constraint.

## When you finish one

Append a line to [PROGRESS.md](PROGRESS.md) with the date, the work order, what
you changed, and the verification output. That file is the only memory between
chats. Delete a work order file only when its fix is verified shipped, per the
retirement policy in [../README.md](../README.md).
