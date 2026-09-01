# backlog/: the open work, one prompt per item

Every file here is a **self-contained work order**. Paste one into a fresh Claude
Code chat in this repo and run it to 100% without further input. Read this index
first; every work order assumes it.

The pack exists because the open items were scattered across [../../ISSUES.md](../../ISSUES.md),
retired campaign progress logs, and agent memory. A tracker line tells you a thing
is broken. A work order tells you how to finish it.

---

## Verification snapshot (2026-09-01, measured, not remembered)

Re-measure before you trust any number below. Commands are in each work order.

| Fact | Value | How it was read |
|---|---|---|
| Production commit | `ad7b54c16` (built 2026-08-28), revision `three-ws-api-00404-ph7` | `curl -s https://three.ws/api/version` |
| Deploy gap | **107 commits**; `main` was `73c8ccbb7` | compared to `git rev-parse --short main` |
| `x402_settle` | **down**, 5.9% (4/68 paid attempts, 3h), `cause: sponsor_floor` | `curl -s https://three.ws/api/healthz` |
| Settle reject class | `fee_runway_exhausted` 49,513 of 50,554 failures since boot | same, `x402.self_facilitator.settle.fail_reasons` |
| Solana RPC lanes | all 4 paid lanes cooling, `recoversIn` per lane exposed | same, `subsystems[].name == rpc_lanes` |
| Forge generation | 98% (48/49 finished, 6h) | same |
| Fact-check benchmark | `ran: true`, `source: "database"`, 40% (16/40), published 2026-08-10 | `curl -s https://three.ws/api/fact-check-benchmark` |
| Media CORS at the site edge | `access-control-allow-origin: *` | `curl -I -H 'Origin: https://example.org' https://three.ws/avatars/cesium-man.glb` |
| `gcloud` auth | dead (token refresh fails non-interactively) | `gcloud run services list` |

Two of these overturn text elsewhere in this pack: the benchmark is live from the database
(order 04's only remaining line closed with the 2026-08-28 deploy), and production is no
longer at `main`, so "ships with the next deploy" is a real dependency again for anything
committed after 2026-08-28 06:49 UTC.

---

## Run order

Nothing here is strictly sequential, but the money rail gates the platform's
observable health, so 01 to 03 come first.

| # | Work order | Blocked on | Owner action needed |
|---|---|---|---|
| 01 | [x402 settle: clear `fee_runway_exhausted`](01-x402-settle-runway.md) | nothing (config-only updates are pre-approved) | one `gcloud auth login` if auth is dead |
| 05 | [R2 bucket CORS: verify, then fix at the origin](05-r2-bucket-cors.md) | one credential | mint an R2 admin token |
| 07 | [BNB testnet: deploy the two finished contracts](07-bnb-testnet-deploys.md) | one funded EOA | fund a throwaway testnet key |
| 08 | [OKX chat bot: move off the codespace](08-okx-chat-bot-always-on.md) | nothing | one email OTP login |
| 09 | [Telegram bots: durable hosting for both feeds](09-telegram-bots-durability.md) | nothing | none |
| 10 | [x402scan listing: finish the last three steps](10-x402scan-listing.md) | one PAT or one comment | classic PAT, or the owner comments |

---

## Retired after verification (2026-09-01)

Four orders were deleted once every agent-doable line of their definition of done was
verified on disk and in production, not from this log: 02 (Solana RPC capacity: the lane
probe script, per-method capability routing, `recoversIn` on the ops surface, the runbook),
03 (sponsor runway: burn measurement, the alert and its formatter tests, the `sponsor_floor`
sensor that healthz reports today), 04 (the benchmark run: live from the database since the
2026-08-28 deploy), and 06 (LLM lanes: transport-failure tests for every free rung, the
metering audit, the opt-in paid mirror, corrected docs). Their files are readable in git
history; the evidence per line is in [PROGRESS.md](PROGRESS.md) under 2026-09-01.

State of what remains, measured the same day: 01 is code-complete but its outcome line is
false (settle 5.9%, sponsor wallet under its SOL floor; capital is the owner's), and the
dry-run reclaim plan still reports sealed wallets as reclaimable. 05 waits on one R2 admin
token. 07 needs a new funded deployer key: the throwaway key generated on 2026-08-02 no
longer exists on this machine, so funding the old address would strand the tokens. 08's
worker is built and committed but has never reported a heartbeat, so it is not running
anywhere. 09's deliverables live in a sibling repository that is not checked out in this
workspace, so nothing here can verify them. 10's remaining external step resolved on its own
(the upstream pull request merged 2026-08-11 and the live discovery endpoint matches it);
its file is retired as soon as the owner clears the commit gate that its content sits behind.

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
