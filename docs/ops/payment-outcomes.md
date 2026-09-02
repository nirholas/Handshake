# Payment-outcome board

`GET /api/ops/payment-outcomes` is the single read that answers "are payments
healthy right now, and if not, which stage is failing?". It exists because the
x402 griefing classes (verify-reject floods, settle failures, sponsor-fee
starvation) historically became visible only after they halted the economy;
the 2026-07-11 fable audit filed the gap and this board closes it. It is a
JSON read; consume it with `curl` + `jq` or wire it into ops tooling.

## Auth

Same gate as `/api/ops/health`: an admin session, or `x-ops-secret` matching
`OPS_SECRET` (never `CRON_SECRET`; see `api/_lib/ops-auth.js`). Unset secret
means open in dev and denied in production. Read-only; it moves no funds and
never fires alerts (balance reads go through the ring monitor with alerting
disabled; the scheduled monitor owns paging).

Per-IP ceiling: the `authedReadIp` bucket (300 requests / 5 min), shared with
`/api/ops/health` and `/api/ops/money-health`. It is deliberately not the strict
`authIp` credential bucket, so polling a board cannot 429 an operator's login
from the same address. Over the ceiling the response is `429 rate_limited` with
a `retry-after` header.

## The response envelope

```json
{ "ok": true, "degraded": [], "generated_at": "…", "inbound": {…}, "ring_settle": {…}, "sponsor": {…} }
```

The three panels are read independently, so one failing never blanks the others
(an RPC outage is exactly when the settle panels matter most). `ok` reports
whether the BOARD rendered, never whether payments are healthy: that verdict is
per panel. A panel that threw is replaced by `{ "error": "…" }`, named in
`degraded`, and the status code is `207 Multi-Status` instead of `200`, the same
convention `/api/ops/health` uses. Alert on `degraded` being non-empty: a board
that cannot see is not a board that is fine.

## The three panels

### `inbound` (from `x402_audit_log`)

Counts and rates over 1h / 3h / 24h windows for payments arriving at our paid
routes:

- `settled` / `settle_failed`: outcomes of `settlePayment` after a valid
  verify. `settle_success_rate` = settled / (settled + settle_failed).
- `verify_rejected`: `verifyPayment` refusals, written durably as
  `payment_verify_rejected` events (metadata carries `reason` and
  `rejected_proof` vs `upstream_fault`). A spike here with flat settles is the
  junk-X-PAYMENT griefing signature: the per-IP verify penalty bucket should
  be absorbing it, and this is the panel that proves whether it is.
- `replay_rejected`, split by stage in `replay_stages_24h`: `pre_handler`
  means the durable spent-payment guard refused a replayed proof before the
  handler ran; `post_settle` means a lost insert race was refused at claim
  time. Any sustained nonzero rate is someone re-sending captured headers.
- `top_failure_reasons_24h` names the dominant failure codes with the stage
  (verify vs settle) so a 502 cluster is distinguishable from a rejected-proof
  wave without a log dive.
- `settled_volume_usd_24h` from settled `amount_atomics` (USDC, 6 decimals).

Replays are excluded from both rate denominators: they are refused before
verify and would otherwise dilute the signal.

### `ring_settle` (from `gatherX402SettleHealth`)

The outbound settle-success sensor over `x402_autonomous_log` (3h window,
rail-fault allowlist), verbatim: status, human detail, triage hint, and the
top fault signatures. This is the same object `/api/healthz` consumes; it is
included here so the board is complete without a second request. Its triage
map lives in [production-log-triage.md](production-log-triage.md).

The ring log is reason-blind for refusals that arrive over HTTP (they all read
as `http_5xx`), so the sensor reconciles status-only 5xx faults against the
facilitator's own book (`x402_self_facilitator_log.reject_reason`) for the same
window and names the dominant cause in `ring_settle.metrics.cause`:
`sponsor_floor` (the Solana accept was withdrawn under the SOL floor),
`fee_governor` (deliberate spend pacing, a budget problem, not a rail fault),
or `rail` (genuine settle faults). `governorSkips` is carried even on a healthy
rate so a wallet sliding toward its budget shows up before the rate does.

A rent-exemption failure on the fee payer (`InsufficientFundsForRent` on
account index 0, in either spelling the RPCs use) wears a rail-shaped reason
token (`simulation_failed`, `sweep_broadcast_failed`) while being the opposite
of a rail fault: the transaction never reached the rail because the sponsor
could not pay for it. The sensor flags those rows from the full `error_msg`
and counts them as floor signals, not faults, so a dry sponsor reads as
`cause: sponsor_floor` rather than pointing the operator at duplicate
signatures and RPC preflight (which is what happened for three hours on
2026-08-28). Because a sponsor under its floor is a hard stop, those attempts
also override the "too few attempts to judge" `unknown` verdict: once the
floor signals alone reach the minimum sample the status is `down` with a
`settle halted` detail, since under the floor nothing settles at all.

### `sponsor` (live RPC + `x402_self_facilitator_log`)

The fee wallet that pays every settle's SOL fee:

- `sol` is the live balance. Two different floors are reported and they are not
  interchangeable: `settle_floor_sol` is the facilitator's hard floor
  (`X402_SPONSOR_SOL_FLOOR_LAMPORTS`, default 0.02) where settlement is actually
  refused, and `sol_floor` is the ring monitor's watch floor at 1.5x that, which
  exists to warn early. `below_floor` compares against the watch floor.
- `burn_sol_per_day` is MEASURED from `fee_lamports` over successful settles,
  never quoted from memory: the folklore burn rate has been wrong by roughly 10x
  before (ISSUES.md item 6). It always ships with `burn_window_days` (the window
  it was measured over) and `settles_in_window` (the sample size). A burn rate
  without its window is a rumour, so nothing here prints one without the other.
- `runway_days` = balance / measured burn (to empty, what a funding ask is sized
  against). `runway_days_to_floor` = (balance minus the settle floor) / burn,
  which is the operational figure: settling stops at the floor, not at zero.
- `runway_status` is the verdict the alert fires on (see below), and the
  dashboard card colours from it so the board and the page cannot disagree.

### The runway alert

The runway is no longer render-only. `checkRingWallets()` in
`api/_lib/x402/wallet-balance-monitor.js` runs on the autonomous loop's 10-minute
tick, measures the burn, and calls `sendOpsAlert` through the normal alerting path
(dashboard row always, Telegram push when `TELEGRAM_ALERTS_CHAT_ID` is wired).
The verdict logic and the alert copy are pure functions in
`api/_lib/x402/sponsor-runway.js`, unit-tested in
`tests/x402-sponsor-runway.test.js` (the arithmetic and the rendered string) and
`tests/x402-sponsor-runway-monitor.test.js` (that the monitor actually sends it).

| `runway_status` | Condition | Alerts |
|---|---|---|
| `critical` | balance at or under the settle floor | yes, `critical` |
| `warn` | `runway_days_to_floor` under the threshold | yes, `warn` |
| `ok` | runway at or above the threshold | no |
| `unknown` | balance unreadable, or no settles in the window | no |

`unknown` deliberately never pages. An idle rail has no measurable burn and
dividing by zero would page every quiet night, and an unreadable balance is an
RPC problem, not a funding one.

Two env knobs, both live without a redeploy:

| Var | Default | Meaning |
|---|---|---|
| `X402_SPONSOR_RUNWAY_ALERT_DAYS` | `3` | days of runway to the floor below which the alert fires |
| `X402_SPONSOR_BURN_WINDOW_DAYS` | `7` | window the burn rate is measured over |

The alert message carries the wallet, the balance, the floor, the measured burn
with its window and sample size, both runway figures, the threshold, and a
top-up size computed from the measured burn. It points at the free self-heal
(`POST /api/cron/treasury-topup?dry=1`) before any funding ask, and it repeats
the rule that has broken the rail before: top up the SPONSOR or the economy
master, NEVER per-agent wallets (that strands SOL in wallets that pay no fees).

It also names the symptom in advance, because the symptom is misleading: under
the floor, `sponsorKnownBelowFloor()` makes `buildRequirements()` withdraw the
Solana accept from every 402 challenge, so the Solana-only ring never attempts a
payment and there is nothing to reject. Settlements collapse while rail faults
stay flat. The settle sensor reports that as `cause: sponsor_floor` (distinct
from `fee_governor` and `rail`) in `ring_settle.metrics`; the accepts are
checkable directly:

```sh
curl -s https://three.ws/api/x402/three-intel | jq '.accepts[].network'
# only eip155:8453 means the Solana accept has been withdrawn
```

## Reading it in an incident

1. `inbound.settle_success_rate` low but `verify_reject_rate` flat: the rail
   or facilitator is failing after verify. Check `ring_settle.detail` for the
   fault mix; `http_502` clusters with empty simulation logs are RPC/preflight
   faults (see [solana-rpc-lanes.md](solana-rpc-lanes.md)).
2. `verify_reject_rate` spiking: someone is flooding junk proofs. Confirm the
   verify penalty limiter is holding (the reasons list will be dominated by
   `verify_rejected` with `rejected_proof`).
3. Both fine but settles refused with 503s: look at `sponsor`. Floor breach or
   sub-day runway is the answer. Read `runway_status` first, then run the free
   self-heal (`POST /api/cron/treasury-topup?dry=1`, then without `?dry=1`)
   before asking for funds: reclaimable SOL sitting in platform agent wallets is
   often the answer, and every reclaim run now leaves `agent_reclaim` rows in
   `economy_master_ledger` saying whether it was `blocked` (an RPC or key
   problem, free to fix) or found `nothing_reclaimable` (the only case that
   genuinely needs the owner to send SOL).

   **Read `agent_reclaim.failed` in the dry plan before you trust its total.**
   The plan-only run opens each wallet's key exactly as the real run does, so a
   wallet whose secret does not decrypt is listed there at stage `recover` with
   reason `secret_undecryptable` instead of being counted as reclaimable. That
   SOL is real, visible on chain, and unreachable: it is encrypted under a key
   this deploy does not hold, and no cron run, RPC tier, or deposit moves it
   (see [wallet-key-migration.md](wallet-key-migration.md) for the recovery
   path, and put the retired key in `WALLET_ENCRYPTION_KEY_PREVIOUS` if you have
   it). Until 2026-09-02 the dry run skipped that check and reported those
   wallets as available on every tick, which sent two separate investigations
   away with "the cron will self-heal from here" when it could not. A dry total
   of 0 with a populated `failed` list means the same thing as
   `nothing_reclaimable`: the owner has to send SOL.
4. `replay_stages_24h` nonzero: captured X-PAYMENT headers are being re-sent;
   the guard is working if the settles panel is unaffected.

## Related

- `api/ops/payment-outcomes.js` (the endpoint),
  `api/_lib/ops/x402-settle-health.js` (the sensor),
  `api/_lib/x402/wallet-balance-monitor.js` (balances, floors, and the runway
  alert), `api/_lib/x402/sponsor-runway.js` (the burn measurement, the verdict,
  and the alert copy), `api/_lib/x402/audit-log.js` (the durable ledger the
  inbound panel reads), `api/_lib/economy-ledger.js` (`recordAgentReclaim`, the
  durable trail for every self-heal attempt).
- `/api/ops/money-health` is the complementary board: open reconciliation
  verdicts per money subsystem rather than live payment outcomes. It takes the
  same gate as this endpoint (admin session or `x-ops-secret`). Until
  2026-08-14 it ran its own gate that accepted a `CRON_SECRET` bearer, so an ops
  script pointed at it with the cron credential now gets a 401: send
  `x-ops-secret: $OPS_SECRET` (Secret Manager: `ops-dashboard-secret`) instead.
