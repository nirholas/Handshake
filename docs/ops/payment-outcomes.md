# Payment-outcome board

`GET /api/ops/payment-outcomes` is the single read that answers "are payments
healthy right now, and if not, which stage is failing?". It exists because the
x402 griefing classes (verify-reject floods, settle failures, sponsor-fee
starvation) historically became visible only after they halted the economy;
the 2026-07-11 fable audit filed the gap and this board closes it. The
`/admin/ops` dashboard renders it as the "Payment outcomes" section.

## Auth

Same gate as `/api/ops/health`: an admin session, or `x-ops-secret` matching
`OPS_SECRET` (never `CRON_SECRET`; see `api/_lib/ops-auth.js`). Unset secret
means open in dev and denied in production. Read-only; it moves no funds and
never fires alerts (balance reads go through the ring monitor with alerting
disabled; the scheduled monitor owns paging).

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

### `sponsor` (live RPC + `x402_self_facilitator_log`)

The fee wallet that pays every settle's SOL fee:

- `sol` vs `sol_floor` (`X402_SPONSOR_SOL_FLOOR_LAMPORTS`, default 0.02): at
  or below the floor the self-facilitator refuses settlement, which surfaces
  downstream as `fee_wallet_below_floor`.
- `burn_sol_per_day_7d` is MEASURED from `fee_lamports` over the last 7 days
  of successful settles, never quoted from memory: the folklore burn rate has
  been wrong by roughly 10x before (ISSUES.md item 6).
- `runway_days` = balance / measured burn. Under ~3 days the dashboard card
  turns amber; below the floor it turns red. Top up the SPONSOR, never
  per-agent wallets (that strands SOL and kills the rail).

## Reading it in an incident

1. `inbound.settle_success_rate` low but `verify_reject_rate` flat: the rail
   or facilitator is failing after verify. Check `ring_settle.detail` for the
   fault mix; `http_502` clusters with empty simulation logs are RPC/preflight
   faults (see [solana-rpc-lanes.md](solana-rpc-lanes.md)).
2. `verify_reject_rate` spiking: someone is flooding junk proofs. Confirm the
   verify penalty limiter is holding (the reasons list will be dominated by
   `verify_rejected` with `rejected_proof`).
3. Both fine but settles refused with 503s: look at `sponsor`. Floor breach or
   sub-day runway is the answer; fund the sponsor address shown.
4. `replay_stages_24h` nonzero: captured X-PAYMENT headers are being re-sent;
   the guard is working if the settles panel is unaffected.

## Related

- `api/ops/payment-outcomes.js` (the endpoint), `pages/admin/ops.html` (the
  panel), `api/_lib/ops/x402-settle-health.js` (the sensor),
  `api/_lib/x402/wallet-balance-monitor.js` (balances and floors),
  `api/_lib/x402/audit-log.js` (the durable ledger the inbound panel reads).
- `/api/ops/money-health` is the complementary board: open reconciliation
  verdicts per money subsystem rather than live payment outcomes.
