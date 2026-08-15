# $THREE micro-buy loop

Many tiny, real on-chain buys of `$THREE` per minute, each triggered by (and paid
through) a settled x402 payment. It exists to put continuous, verifiable buy
pressure on `$THREE` — a steady drip of small market buys that show up on-chain and
on the chart, rather than one large buy a day.

It is the high-frequency, small-ticket sibling of the [daily buyback](../api/_lib/token/buyback.js):

| | Daily buyback | Micro-buy loop |
|---|---|---|
| Cadence | a few large buys/day | many tiny buys/minute (target ~60/min) |
| Ticket | $10–$250 | ~$0.01 |
| Trigger | scheduled cron | a settled x402 call |
| Funding | buyback wallet USDC | micro-buy wallet USDC |
| Direction | **buy-only** | **buy-only** |

Both lanes buy on Jupiter through the same client ([api/_lib/token/jupiter.js](../api/_lib/token/jupiter.js))
and sweep the bought tokens to the treasury. **Neither ever sells `$THREE`.**

## How one buy works

1. The driver [api/cron/three-buy-loop.js](../api/cron/three-buy-loop.js) fires a
   paid x402 call to `/api/x402/three-buy`. The small toll
   (`X402_PRICE_THREE_BUY`, default $0.001 USDC) routes to the ring treasury
   (`X402_PAY_TO_SOLANA`) — exactly like every other ring endpoint. This is the
   "pay through the x402 loop" leg.
2. The endpoint ([api/x402/three-buy.js](../api/x402/three-buy.js)) delivers the
   paid good: it executes **one** USDC→`$THREE` market buy on Jupiter
   (`THREE_MICROBUY_USD`, default $0.01), funded by the micro-buy wallet — a
   **separate** money stream from the toll.
3. The bought `$THREE` accrues in the micro-buy wallet and is swept to the
   treasury by the loop every `THREE_MICROBUY_SWEEP_EVERY_N_TICKS` ticks.

The toll and the buy are deliberately decoupled (same custody-vs-accounting split
the daily buyback uses): the toll is internal recirculation; the buy is the real
market spend.

## Safety

Execution is **off by default**. Until `THREE_MICROBUY_ENABLED` is truthy *and* a
funded signer exists, every call is a recorded no-op and the toll is refused (the
endpoint re-emits its 402, so the caller is never charged for a buy that didn't
happen).

- **Daily ceiling.** `THREE_MICROBUY_DAILY_CAP_USD` (default $50) is the hard bound
  on real market spend and SOL fee burn. It is enforced **atomically** — the engine
  reserves the day's budget in Redis *before* broadcasting a buy, so a flood of
  concurrent calls can never collectively overshoot the cap. A DB sum over
  `three_microbuy_runs` is the fallback when Redis is down.
- **Fail-closed.** If *neither* Redis nor the ledger DB can confirm today's spend,
  the buy is **refused** (`cap_unverifiable`), not allowed. Unbounded real-money
  spend is the one outcome the cap exists to prevent, so the engine never assumes
  "zero spent" on an infrastructure outage.
- **Fail-closed toll.** Because the endpoint refuses the toll whenever a buy can't
  happen (disabled, unfunded, cap reached), a direct payer can force buys only up
  to the same daily ceiling the loop obeys — there is no amplification past the cap.
- **Self-healing ledger.** The loop and endpoint create `three_microbuy_runs` on
  first use, so the DB cap fallback and the records always work even on a fresh or
  behind database — the migration owns it in a real deploy, this is the backstop.
- **Kill switches.** `X402_AUTONOMOUS_ENABLED=false` (global) or
  `THREE_MICROBUY_ENABLED` unset stops everything; `THREE_MICROBUY_LOOP_ENABLED=false`
  pauses only the driver while leaving the endpoint payable.
- **No wasted hammering.** A tick stops early on a fully-failed wave (cap exhausted,
  disabled, unfunded, or an RPC/DB outage) instead of firing every remaining call
  for nothing — reported as `stop_reason` in the tick response.
- **Not in the generic ring.** `three-buy` is `autobuy:false` in
  [ring-catalog.js](../api/_lib/x402/ring-catalog.js), so the generic ring rotation
  never fires real buys — only its dedicated driver does (pinned by a test).

Every call writes an immutable row to `three_microbuy_runs`
([migration](../api/_lib/migrations/20260717233000_three_microbuy.sql)) — submitted,
confirmed, pending, skipped, or failed — so there is never a silent no-op.

## Throughput — hitting ~60/min

The whole tick runs inside the economy-tick 60s call budget, so 60 buys/min only
works if each buy is fast. Two things make it fast:

- **Broadcast-and-go (default).** Waiting for each buy to confirm would pin it to
  the ~2–12s block time — at 60/min that can't fit. So the engine returns as soon as
  the buy is broadcast (`status: submitted`) and does **not** block on confirmation.
  This is safe because the daily cap is reserved *before* broadcast (spend is bounded
  regardless) and the treasury sweep reads real on-chain balances (accounting
  self-corrects). Flip `THREE_MICROBUY_AWAIT_CONFIRM=true` only if you need per-call
  confirmation and can accept a lower rate.
- **Distinct transactions.** At 60/min many buys of the same size fire within one
  blockhash window; identical amount + quote would let Jupiter build byte-identical
  transactions that collide on signature (the duplicate is silently dropped). A tiny
  per-buy amount jitter (0–255 atomics, ≤ $0.000255) makes every buy a distinct
  market order, so none are lost to collisions. Jupiter's keyless tier absorbs the
  per-buy quote load (measured: 20 concurrent quotes, zero throttling).

Recommended 60/min config: `THREE_MICROBUY_PER_TICK=60`, leave
`THREE_MICROBUY_CONCURRENCY` unset (auto-sizes to 15 wide), keep
`THREE_MICROBUY_AWAIT_CONFIRM` off. At ~1–2s/buy and 15-wide, a full 60-buy tick
lands in ~8–15s. Make sure the micro-buy wallet holds enough SOL for fees:
60 buys/min ≈ 0.5–1.7 SOL/day at typical priority fees.

## Observability

- **Tick response.** `/api/cron/three-buy-loop` returns `fired`, `paid`, `buys`,
  `pending`, `errors`, `toll_spent_usd`, `daily_spent_usd`, `daily_cap_usd`, and
  `stop_reason` for the tick.
- **Public stats.** `microbuyStats()` (lifetime + today's buys, $THREE bought, USDC
  deployed, cap-used %) is surfaced on the `$THREE` token stats API
  ([api/three-token/[action].js](../api/three-token/%5Baction%5D.js) → `/api/three-token/stats`)
  under `token.microbuy`, alongside the daily buyback summary.
- **Ring volume.** The x402 tolls show up in the ring dashboards tagged
  `pipeline='three-buy'` (per-endpoint volume ledger + `x402_autonomous_log`).

## Turning it on

```bash
# 1. Apply the schema. db:migrate already hardcodes --apply and has no dry run,
#    so read db:status first: db:migrate applies EVERY pending migration, not
#    just this lane's (api/_lib/migrations/20260717233000_three_microbuy.sql).
npm run db:status
npm run db:migrate

# 2. Fund a wallet with USDC (+ a little SOL for fees). Reuse the buyback wallet, or
#    set a dedicated key so the two lanes don't compete for the same USDC:
#      THREE_MICROBUY_SECRET_KEY_B64=<base64 of 64 secret-key bytes>

# 3. Set env on the Cloud Run service (gcloud run services update … --update-env-vars):
#      THREE_MICROBUY_ENABLED=true
#      THREE_MICROBUY_USD=0.01            # per-buy size
#      THREE_MICROBUY_PER_TICK=60         # ~60 buys/min
#      THREE_MICROBUY_DAILY_CAP_USD=50    # hard daily spend bound
#      THREE_MICROBUY_CONCURRENCY=8       # workers/tick

# 4. The economy-tick heartbeat drives it every minute (target 'three-buy-loop').
#    Verify a tick:
curl -s -H "Authorization: Bearer $CRON_SECRET" https://three.ws/api/cron/three-buy-loop | jq
```

The response reports `fired`, `paid`, `buys`, `pending`, `errors`, `toll_spent_usd`,
`daily_spent_usd`, `daily_cap_usd`, and `stop_reason` for the tick.

## Configuration

| Env | Default | Meaning |
|---|---|---|
| `THREE_MICROBUY_ENABLED` | off | Master execution gate. |
| `THREE_MICROBUY_LOOP_ENABLED` | on | Set `false` to pause only the driver. |
| `THREE_MICROBUY_SECRET_KEY_B64` | buyback wallet | Dedicated signer/funder (base64 64-byte key). |
| `THREE_MICROBUY_USD` | `0.01` | USD per single buy (hard-capped at 5). |
| `THREE_MICROBUY_DAILY_CAP_USD` | `50` | UTC-daily ceiling on real spend. |
| `THREE_MICROBUY_PER_TICK` | `10` | Buys per minute (hard-capped at 60). Set `60` for the target rate. |
| `THREE_MICROBUY_CONCURRENCY` | auto (≤15) | Concurrent buy workers per tick. Unset auto-sizes to the per-tick target; override clamps to 1–30. |
| `THREE_MICROBUY_AWAIT_CONFIRM` | `false` | Wait for each buy to confirm on-chain. Off = broadcast-and-go (required for 60/min). |
| `THREE_MICROBUY_SLIPPAGE_BPS` | `300` | Jupiter slippage tolerance. |
| `THREE_MICROBUY_SWEEP_EVERY_N_TICKS` | `30` | Sweep accrued `$THREE` to treasury cadence. |
| `X402_THREE_BUY_TOLL_CAP_ATOMIC` | `1000000` | Per-tick ceiling on internal tolls (USDC atomics). |
| `X402_PRICE_THREE_BUY` | `1000` | Per-call toll price (USDC atomics, $0.001). |

## Related

- [docs/x402-ring-economy.md](x402-ring-economy.md) — the closed-loop x402 ring the toll settles through.
- [api/_lib/token/buyback.js](../api/_lib/token/buyback.js) — the daily buyback lane.
- [api/_lib/token/config.js](../api/_lib/token/config.js) — `$THREE` mint, treasury, and split policy.
