# backlog/: the open work, one prompt per item

Every file here is a **self-contained work order**. Paste one into a fresh Claude
Code chat in this repo and run it to 100% without further input. Read this index
first; every work order assumes it.

The pack exists because the open items were scattered across [../../ISSUES.md](../../ISSUES.md),
retired campaign progress logs, and agent memory. A tracker line tells you a thing
is broken. A work order tells you how to finish it.

---

## Verification snapshot (2026-08-01, measured, not remembered)

Re-measure before you trust any number below. Commands are in each work order.

| Fact | Value | How it was read |
|---|---|---|
| Production commit | `6cc0370dc`, revision `three-ws-api-00353-tzp` | `curl -s https://three.ws/api/version` |
| Deploy gap | **none**; prod is at `main` HEAD | compared to `git rev-parse --short HEAD` |
| `x402_settle` | **down**, 25.9% (504/1948 paid attempts, 3h) | `curl -s https://three.ws/api/healthz` |
| Settle reject class | `fee_runway_exhausted` 85,331 vs `broadcast_failed` 562 | same, `x402.self_facilitator.settle.fail_reasons` |
| Solana RPC lanes | `1/3 paid lanes serving` | same, `subsystems[].name == rpc_lanes` |
| Forge generation | 100% (43/43 finished, 6h) | same |
| Fact-check benchmark | `ran: false` (honest empty state, never run) | `curl -s https://three.ws/api/fact-check-benchmark` |
| `optimize?draco=1` | **fixed**, 200 with a 129,972-byte GLB | `curl "https://three.ws/api/avatar/optimize?src=https://three.ws/avatars/cesium-man.glb&draco=1"` |
| Media CORS at the site edge | `access-control-allow-origin: *` | `curl -I -H 'Origin: https://example.org' https://three.ws/avatars/cesium-man.glb` |

Two of these overturn stale tracker text: the Draco transcode failure closed with
the 2026-08-01 rebuild, and there is no deploy gap right now, so "ships with the
next deploy" is no longer an excuse for anything in this pack.

---

## Run order

Nothing here is strictly sequential, but the money rail gates the platform's
observable health, so 01 to 03 come first.

| # | Work order | Blocked on | Owner action needed |
|---|---|---|---|
| 01 | [x402 settle: clear `fee_runway_exhausted`](01-x402-settle-runway.md) | nothing (config-only updates are pre-approved) | one `gcloud auth login` if auth is dead |
| 02 | [Solana RPC capacity and call-shape routing](02-solana-rpc-capacity.md) | nothing | plan top-up (optional, work order routes around it) |
| 03 | [Sponsor runway: measure, alert, self-heal](03-sponsor-runway-automation.md) | 01 lands first | ~1 SOL top-up (optional) |
| 04 | [Publish a real fact-check benchmark run](04-fact-check-benchmark-run.md) | one env var | set `INTERNAL_API_KEY` on the service |
| 05 | [R2 bucket CORS: verify, then fix at the origin](05-r2-bucket-cors.md) | one credential | mint an R2 admin token |
| 06 | [LLM lanes: kill the dead backstops, close the Claude gap](06-llm-lane-resilience.md) | nothing | Vertex Model Garden entitlement |
| 07 | [BNB testnet: deploy the two finished contracts](07-bnb-testnet-deploys.md) | one funded EOA | fund a throwaway testnet key |
| 08 | [OKX chat bot: move off the codespace](08-okx-chat-bot-always-on.md) | nothing | one email OTP login |
| 09 | [Telegram bots: durable hosting for both feeds](09-telegram-bots-durability.md) | nothing | none |
| 10 | [x402scan listing: finish the last three steps](10-x402scan-listing.md) | one PAT or one comment | classic PAT, or the owner comments |

---

## Shared rules (every work order obeys these)

1. **CLAUDE.md wins.** Read it before you start. The stop-and-ask gates are real:
   irreversible spends, `git push` and production deploys, other-coin commits,
   unrecoverable data deletion. Everything else: proceed, then report.
2. **Config-only `gcloud run services update` is pre-approved.** Use
   `--update-env-vars` (merges). Never `--set-env-vars` (replaces the whole set).
3. **Moving funds is not config.** Any transfer, reclaim, swap, or top-up needs an
   explicit owner yes with recipient and amount rendered first, even when the
   endpoint that does it is a cron you can already call.
4. **Measure before and after.** Every work order names the exact command that
   proves its claim. A fix without a re-read is not a fix.
5. **The gate.** `npm run gate` at the start and again before you claim done.
   `gate-after` must be no worse than `gate-before`.
6. **`npm run check:rules -- --paths <files you touched>`** before committing.
   Concurrent agents share this worktree, so stage explicit paths, never `-A`.
7. **User-visible change means a `data/changelog.json` entry** plus the docs layer
   that applies (see the Documentation section of CLAUDE.md).
8. **Log your outcome in [PROGRESS.md](PROGRESS.md)** when you finish or hand off.
   It is the only memory between chats.

## Commit gate applies to four of these

Work orders 07, 08, 09, and 10 reference crypto projects other than `$THREE`
(a second chain, a marketplace, a launchpad, a registry). Building and running
them is fine. **Committing a diff that names any of them requires explicit owner
approval first**, per CLAUDE.md. Each of those files repeats the warning at the
top. The other six touch only platform infrastructure and `$THREE`.

## The diagnosis reflex that keeps being right

Before debugging any production symptom, check three things in this order:

```sh
curl -s https://three.ws/api/version    # is prod at main, or are you debugging old code?
curl -s https://three.ws/api/healthz    # which subsystem is actually down, with counts
npm run db:status                       # are migrations pending behind you
```

More than one session in this repo has been spent debugging a fix that had already
shipped, or one that never had.
