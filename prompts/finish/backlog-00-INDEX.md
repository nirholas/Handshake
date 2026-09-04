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
| `gcloud` auth | **live again** (re-read 2026-09-04; it was dead on 2026-09-01) | `gcloud run services describe three-ws-api --region us-central1` |

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
| 01 | [x402 settle: clear `fee_runway_exhausted`](backlog-01-x402-settle-runway.md) | capital, and nothing else (every code and config line shipped 2026-09-02) | SOL to the economy master; the config levers are already applied |
| 05 | [R2 bucket CORS: verify, then fix at the origin](backlog-05-r2-bucket-cors.md) | one credential | mint an R2 admin token |
| 07 | [BNB testnet: deploy the two finished contracts](backlog-07-bnb-testnet-deploys.md) | one funded EOA | send tBNB to `0x1C4918894dfA5eE11cfF9629B458b5169Cfa3871` (faucet is reCAPTCHA-gated) |
| 08 | [OKX chat bot: move off the codespace](backlog-08-okx-chat-bot-always-on.md) | nothing | one email OTP login |
| 09 | [Telegram bots: durable hosting for both feeds](backlog-09-telegram-bots-durability.md) | **done**, verified live 2026-09-02 | clear the commit gate on its file update |
| 10 | [x402scan listing: finish the last three steps](backlog-10-x402scan-listing.md) | the deploy (the facilitator listing itself is live) | approve the deploy, then one wallet signature to re-register the origin |

---

## Retired after verification (2026-09-01)

Four orders were deleted once every agent-doable line of their definition of done was
verified on disk and in production, not from this log: 02 (Solana RPC capacity: the lane
probe script, per-method capability routing, `recoversIn` on the ops surface, the runbook),
03 (sponsor runway: burn measurement, the alert and its formatter tests, the `sponsor_floor`
sensor that healthz reports today), 04 (the benchmark run: live from the database since the
2026-08-28 deploy), and 06 (LLM lanes: transport-failure tests for every free rung, the
metering audit, the opt-in paid mirror, corrected docs). Their files are readable in git
history; the evidence per line is in [PROGRESS.md](backlog-PROGRESS.md) under 2026-09-01.

State of what remains, measured the same day: 01 is code-complete but its outcome line is
false (settle 5.9%, sponsor wallet under its SOL floor; capital is the owner's). The dry-run
reclaim plan that reported sealed wallets as reclaimable was fixed on 2026-09-02 (`afd349790`):
it now opens each planned wallet's key and lists the ones that will not decrypt under
`agent_reclaim.failed`, so a dry total of 0 means the owner has to send SOL. 05 waits on one R2 admin
token. 07 needs one faucet claim and nothing else: a deployer key now exists in the gitignored
`contracts/.env` at `0x1C4918894dfA5eE11cfF9629B458b5169Cfa3871` (re-verified 2026-09-04,
still 0 tBNB on three chain-97 lanes), both dry runs simulate green against the live chain-97
RPC at unchanged gas, and the `--broadcast` path was re-proven end to end on a local chain-97
node with the real `scripts/bnb-testnet-deploy-prove.mjs --broadcast`. Fund that address, not
the retired 2026-08-02 one.
08's worker is built and committed; on 2026-09-02 it beat for the first time, from this
codespace, so `/api/healthz` now carries the `okx_chat_bot` subsystem and reports it as the
stopgap it is (`hostDurable=false`). The Cloud Run host is still undeployed.
09 is done: the sibling repository is checked out at `/workspaces/pump-fun-sdk` after all, and
both feeds were verified running on Cloud Run on 2026-09-02 (`Ready=True`, websocket transport,
25 h uptime each) while this codespace's own rebuild killed their local processes.
10's remaining external step resolved on its own
(the upstream pull request merged 2026-08-11, the registry attributes 18,636 settlements and
$1,055 of volume to our facilitator, and their own crawler replayed against production returns
4,519 stable items with no duplicates). What was left was on our side: their registration flow
reads `/openapi.json`, which hand-enumerated 24 of the 75 live paid services, so 52 endpoints
answered a valid 402 and could not be listed. That is fixed in the tree and ships with the next
deploy, after which one wallet signature re-registers the origin.

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
8. **Log your outcome in [PROGRESS.md](backlog-PROGRESS.md)** when you finish or hand off.
   It is the only memory between chats.

## Commit gate applies to four of these

Work orders 07, 08, 09, and 10 reference crypto projects other than `$THREE`
(a second chain, a marketplace, a launchpad, a registry). Building and running
them is fine. **Committing a diff that names any of them requires explicit owner
approval first**, per CLAUDE.md. Each of those files repeats the warning at the
top. The other two touch only platform infrastructure and `$THREE`.

## The diagnosis reflex that keeps being right

Before debugging any production symptom, check three things in this order:

```sh
curl -s https://three.ws/api/version    # is prod at main, or are you debugging old code?
curl -s https://three.ws/api/healthz    # which subsystem is actually down, with counts
npm run db:status                       # are migrations pending behind you
```

More than one session in this repo has been spent debugging a fix that had already
shipped, or one that never had.

## Retire this file when the campaign is done (required)

This file is shared context rather than a single order, so it outlives the
prompts that cite it. Delete it in the commit that closes the LAST prompt of
this campaign, once nothing else in `prompts/finish/` references it:

       grep -rl 'backlog-00-INDEX' prompts/finish/
       git rm prompts/finish/backlog-00-INDEX.md

While any sibling prompt of this campaign is still on disk, leave this file in
place and keep it accurate instead. The shrinking directory is the only signal
to the next agent that a campaign is closed.
