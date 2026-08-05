# Financial controls & audit register

three.ws moves **real money** (USDC, SOL, $THREE) on behalf of users and agents.
This document is the audit-grade control register: for every money flow it records
**where it is logged, whether that record is immutable and idempotent, whether the
on-chain transaction is captured, whether it is reconciled against the chain, and
how long it is retained** — plus the monitoring/breach controls around it and the
open gaps ranked by accounting/regulatory risk.

It is a companion to the [money map](money-map.md) (who receives what) and the
[Solana signers runbook](../api/_lib/solana-signers.js) (the
wallets). Keep it in sync with the code — every row cites its source.

> **Status of this register:** the platform's logging is strong for a few flows
> (credit deposits, marketplace sales, labor settlement, the hash-chained
> economy-master ledger) and has material gaps in others (fire-and-forget
> revenue writes, Redis-only payout ledgers). The [gap register](#gap-register)
> tracks each with a severity and a fix. Do not treat any flow as
> audit-complete until its gaps are closed.

---

## 1. The financial ledgers

Each row: the flow, its ledger table + key columns, whether the on-chain tx
signature is persisted, whether the record is append-only, its idempotency guard,
and whether it is reconciled against the chain.

| Flow | Ledger table (key columns) | tx sig? | Append-only | Idempotency | Chain-reconciled |
| ---- | -------------------------- | ------- | ----------- | ----------- | ---------------- |
| x402 settlements (main revenue) | `x402_audit_log` (`event_type, payer, network, amount_atomics, asset, tx_hash, settlement_status, …`) | ✅ | by convention* | Redis proof-hash slot + durable `x402_spent_payments` row ([`spent-payments.js`](../api/_lib/x402/spent-payments.js), replay guard beyond the cache TTL; fails open) | ❌ **no** |
| Signed receipts | `x402_receipts` (`payer, resource_url, receipt jsonb, transaction`) | ⚠️ often NULL (`includeTxHash` default false) | by convention | ❌ none | n/a (EIP-712 verifiable) |
| Club tips → dancer payouts | `club_tips` (`ticket_id UNIQUE, dancer, amount_atomics, paid_tx`) → `club_payouts` (`tx, swept_tip_count`) | ✅ | payouts ✅; tips mutable | `ticket_id UNIQUE` + claim-before-send | ❌ |
| Club cover charges | **none** (only `x402_audit_log`) | — | — | — | ❌ |
| Cosmetic sales + creator split | `cosmetic_sales` (`price_usdc_atomics, creator_cut_atomics, payout_tx, payout_status`, `UNIQUE(account,cosmetic_id)`) | ✅ | sale once; payout fields mutable | `UNIQUE(account,cosmetic_id)` | ❌ |
| Marketplace skill sale + fee | `skill_purchases` (`tx_signature UNIQUE`, `platform_fee_amount`) + `agent_revenue_events` (`gross/fee/net`) | ✅ | revenue events ✅ | `tx_signature UNIQUE` | ❌ |
| Labor escrow (fund/settle/payout/refund) | `agent_bounties`, `agent_jobs` (`settle_key UNIQUE, settlement_sig, royalty_sig, refund_sig`) + custody ledger | ✅ | mutable status; single-shot | `settle_key UNIQUE` + atomic claim | ❌ |
| $THREE buyback | `three_buyback_runs` (`usdc_spent_atomics, three_bought_atomics, buy_signature, sweep_signature`) | ✅ | ✅ (one row/run) | ❌ **no unique key** | ❌ |
| Coin buyback / distribute | `pump_buyback_runs`, `pump_distribute_runs` (`tx_signature, status`) | ✅ | mutable status | ❌ **no unique key** | ❌ |
| Withdrawals | `agent_withdrawals` (`amount, currency_mint, chain, to_address, tx_signature, status`) | ✅ | mutable status | ⚠️ claim-CAS only; **no on-chain-send idempotency** | ❌ |
| Treasury top-up / economy master | `economy_master_ledger` (`event, target_pubkey, lamports, signature, resulting balance, sol_usd, usd_value, prev_hash, entry_hash`): every transfer/failed/blocked plus a per-sweep heartbeat row | ✅ | ✅ SHA-256 hash-chained (tamper-evident) | ❌ no unique key on sig | ✅ **yes** (`economy-reconcile`) |
| Autonomous x402 loop | `x402_autonomous_log` (`tx_signature, amount_atomic, success`) | ✅ | ✅ | ❌ no unique on sig | ✅ **yes** |
| Inbound agent payments | `agent_payment_intents` (`amount, currency_mint, tx_signature, status`) | ✅ | mutable status | tx-unique index | ✅ **yes** |
| a2a mandate settlements | **no durable ledger** — mandate is an unstored JWS; cap in Redis (`INCRBY`) with per-replica memory fallback | ❌ | ❌ | Redis atomic (bypassable w/o Upstash) | ❌ |
| Credit deposits | `credit_ledger` (`amount_usd, balance_after, tx_signature, idempotency_key UNIQUE`) — balance+ledger in one CTE | ✅ | ✅ | `idempotency_key UNIQUE` + finalized-only | on finalized tx |
| Subscriptions | `subscription_checkouts` (`reference UNIQUE, amount, platform_fee_amount, tx_signature`) | ✅ | mutable status | `reference UNIQUE` + payment-idempotency | ❌ |
| Vanity bounty payouts | **Redis / in-memory** (`vanity-bounty-store.js`) — not Postgres | ⚠️ in Redis only | ❌ (memory fallback loses on restart) | Redis CAS | ❌ |

\* **"By convention"** means the code never issues UPDATE/DELETE on the table, but
there is **no DB-level enforcement** (no trigger, no revoked grant) — so
immutability is not guaranteed against a bug, a migration, or a compromised
credential. This applies to *every* table above, including those designed as
immutable (`credit_ledger`, `agent_revenue_events`, `three_buyback_runs`).

**Reference-grade flows** (idempotent + tx-sig + append-only): **credit deposits**,
**marketplace skill purchases**, **labor settlement**. New money flows should copy
their pattern — a `UNIQUE` idempotency key on the on-chain signature, an
append-only ledger row, and balance+ledger written atomically.

---

## 2. Reconciliation coverage

Books automatically verified against the chain:

- ✅ `x402_autonomous_log` (outbound autonomous spend) — by
  [`revenue-reconciliation.js`](../api/_lib/x402/revenue-reconciliation.js)
  (daily, 7-day / 250-row window, driven by the `x402-autonomous-loop` cron).
- ✅ `agent_payment_intents` (inbound user→agent revenue) — same reconciler.
- ✅ `economy_master_ledger` (funding-wallet SOL movements) — by
  [`economy-reconcile.js`](../api/cron/economy-reconcile.js) (every 30 min, 72h
  window): tamper (hash-chain), unrecorded outbound (breach), and
  ledger-vs-chain integrity.
- ✅ `x402_self_facilitator_log` + `x402_ring_ledger` (the closed-loop ring's own
  books) — by [`ring-reconciliation.js`](../api/_lib/x402/ring-reconciliation.js)
  (every 30 min, 72h window, driven by the `x402-autonomous-loop` cron). Five
  checks: settle integrity (signature exists + succeeded), amount fidelity
  (parsed tx pays exactly the logged amount to the logged receiver), sweep
  integrity (treasury→payer, exact amount), cross-log coherence (a settlement
  with no buyer record is value leaking through our own facilitator), and fee
  coherence (logged fees vs the fee-audit rollup). A **zero-volume tripwire**
  pages when the ring is enabled but silent for 30 min. Verdicts land in
  `payment_reconciliation` under `ring_*` sources; CRITICAL for
  missing/failed/mismatch, WARN (daily-throttled) for coherence/fee drift. See
  [ring reconciliation](./x402-ring-economy.md#reconciliation--proving-every-ring-dollar-on-chain).

**NOT reconciled against the chain:** `x402_audit_log` (the main revenue ledger),
`club_payouts`, `cosmetic_sales`, `agent_jobs`, `agent_withdrawals`,
`three_buyback_runs`, and vanity payouts.

Two blind spots default a record to `reconciled=true` without verifying it:
**EVM/Base** settlements (`skipped_non_solana`) and **RPC failures** (`unknown`).
A network-wide RPC outage, or all-EVM revenue, would show zero discrepancies while
nothing was actually checked.

**As of this register**, discrepancies now page ops: when the reconciler finds any
`missing_onchain` / `failed_onchain` / `missing_signature` record it fires
`sendOpsAlert` (previously the verdict was written to `payment_reconciliation` and
never surfaced). The full open set is always queryable:

```sql
SELECT * FROM payment_reconciliation WHERE reconciled = false ORDER BY checked_at DESC;
```

---

## 3. Monitoring & breach controls

**Alerting**: [`sendOpsAlert`](../api/_lib/alerts.js) has two sinks. The
**DB sink is always on**: every alert is upserted into `ops_alerts` keyed by a
stable signature (a recurring condition is one row with a growing count), read
via `GET /api/admin/ops-alerts` and the `/admin/ops` dashboard. **Telegram is an
optional push** (`TELEGRAM_BOT_TOKEN` + `TELEGRAM_ALERTS_CHAT_ID`; absent means
dashboard-only), swallows delivery failures, dedups one push per signature per
hour, and **self-throttles at 20 pushes/hour**. There is still no
email/Slack/PagerDuty fallback and no alert-on-alerting-down.

**Balance watchdogs** — `relayer-balance-check` (6h) alerts on any signer's SOL
below its `minSol` floor; `treasury-topup` (30 min) auto-refills from the economy
master and alerts when the master can't cover or an off-registry target is
rejected. Both read native SOL only. USDC coverage now exists for the x402
wallets: the autonomous loop's `wallet-balance-monitor`
([`api/_lib/x402/wallet-balance-monitor.js`](../api/_lib/x402/wallet-balance-monitor.js))
samples the seed/ring wallets' USDC + SOL, alerts below floor
(`X402_RING_PAYER_USDC_FLOOR_ATOMIC`, default $5), and the economy master's
direct USDC top-up ([`economy-usdc-topup.js`](../api/_lib/economy-usdc-topup.js))
auto-refills the ring/a2a payers below their floors. **Other treasuries still
have no USDC balance watchdog.**

**Spend controls** — x402 buyer caps (`X402_MAX_PER_CALL/HOUR/DAY_ATOMIC`, Redis
reserve-first), autonomous-loop daily cap (`X402_AUTONOMOUS_DAILY_CAP_ATOMIC`,
default $15), pumpfun spend-policy
(`daily_sol_cap` default 5), agent-wallet bridge caps, a2a mandate budget, labor
escrow. **Cross-path USD caps (`agent-trade-guards.js` `daily_usd`/`per_tx_usd`)
default to `null` = uncapped** — an agent whose owner never set limits has no USD
ceiling.

**Kill switches** — per-agent wallet freeze (`spend_limits.frozen`, instant,
auto-set by the anomaly engine), per-agent/strategy `kill_switch`, worker global
kills (`SNIPER_/ORACLE_/MM_/ORDERS_GLOBAL_KILL` — **env flags, need a redeploy**),
`CIRCULATION_ENABLED`, dead-man switch.

**Breach detection** — `wallet-anomaly.js` scores outbound transfers (size,
velocity, first-time destination) and **auto-freezes** the wallet, but notifies
only the **wallet owner, never platform ops** (`sendOpsAlert` is not called), and
**does not cover the treasury / economy-master / coin-creator custodial signers**
(those are covered by the on-chain leak scan, `wallets-leak-scan.js`, instead).
There is no detection of a signer key used from an unexpected host/IP.

**Tamper-evidence** — `custody-attest` (6h) Merkle-anchors custodial wallet
balances on-chain. The revenue/tips/hires ledgers have **no hash-chain, signature,
or anchor**.

---

## 4. Retention

| Table(s) | Deleted by | Window | Financial-record risk |
| -------- | ---------- | ------ | --------------------- |
| `x402_audit_log`, `x402_receipts`, `club_tips/payouts`, `cosmetic_sales`, `agent_*`, `credit_ledger`, payout/run tables | **nothing** | ∞ | none (safe) |
| `audit_log` (generic action log) | `audit-log-cleanup` (daily) | **365 days, hardcoded** (legal-acceptance rows `tos-accept` / `risk-ack-accept` exempt, kept forever) | ⚠️ likely below statutory (5 to 7 yr) retention; no archive before delete |
| `siwx_payments` (access grants) | `siwx-gc` (daily) | 7 days post-expiry | low (money record survives elsewhere; entitlement history lost) |
| pump-intel firehose | `db-retention` (15 min) | `PUMP_INTEL_RETENTION_DAYS` (14, floor 2) | none: valve never touches money tables |

**Storage fragility:** financial tables share one **512 MB Neon branch** with a
~60 MB/day intel firehose. The pressure valve protects money data *by omission
only*; at the cap **all financial/audit writes fail** (audit writes already
fail-fast at 3 s), silently losing *new* records. Money data is not isolated onto a
separate branch/DB, and there is no dead-letter for dropped writes.

---

## 5. Accounting export

There is **no consolidated, admin-authenticated, all-flows ledger export** and no
cost side, so **a full P&L / cash-flow cannot be produced today**. What exists:

- `api/x402-revenue.js?view=export` → CSV, **x402 settlements only**.
- `POST api/x402/analytics` body `{"report":"revenue"}` (a paid x402 endpoint) →
  JSON, x402 only; **net is derived** (gross − count × measured avg per-tx
  settlement cost over the window), not actual per-tx fees.
- `api/billing/invoices.js?format=csv` → per-user metered usage, owner-scoped only.
- `api/x402/my-receipts.js` → a buyer's own signed receipts.

Club tips, hires, skill purchases, metered `token_payments`, buybacks, payouts, and
withdrawals have **no unified export**.

---

## Gap register

Ranked by accounting/regulatory risk. Each is a tracked remediation item.

### P0 — must fix (unlogged or double-pay risk)
1. **x402 revenue writes are fire-and-forget and drop under DB load.** On-chain
   settled USDC can be absent from `x402_audit_log`, under-reporting revenue. *Fix:
   make the settle-path audit write awaited/durable with a dead-letter, and add a
   `UNIQUE(tx_hash)` idempotency constraint.*
2. **Withdrawals lack on-chain-send idempotency.** Broadcast-then-throw marks
   `failed` while funds may have left → double-pay on retry. *Fix: persist an
   idempotency key / pre-send intent and check chain before re-issuing.*

### P1
4. **Vanity bounty payout ledger is Redis/in-memory** (lost on restart w/o Upstash).
   *Fix: mirror payouts/refunds to an append-only Postgres table.*
5. **a2a mandate settlements have no durable per-tx ledger**; the spend cap's memory
   fallback allows cross-replica overspend without Upstash. *Fix: persist mandates +
   settlements; make the cap Postgres- or Redis-authoritative (no memory fallback in
   prod).*
6. **Signed receipts lack an idempotency key and usually omit the tx hash.** *Fix:
   `UNIQUE(payer, resource_url, transaction)` + default `includeTxHash=true`.*
7. **Main revenue ledger is not chain-reconciled and has no tamper-evidence.** *Fix:
   extend reconciliation to `x402_audit_log`; hash-chain or periodically
   Merkle-anchor it (reuse `custody-proof.js`).*
8. **No consolidated P&L / all-flows export.** *Fix: an admin-auth endpoint that
   unions every ledger into one dated cash-flow CSV, with the cost side.*
9. ✅ **Custodial-signer drains now page ops (on-chain leak scan).** The general
   scanner `api/cron/wallets-leak-scan.js` (every 15 min) watches EVERY resolvable
   mainnet `SOLANA_SIGNERS` wallet — economy/launcher masters, all treasuries, x402
   sponsor/payer — and reuses the ring scanner's audited `classifyWalletDebits`: any
   SOL/token debit to an address outside `ringAllowedAddresses()` (or an SPL Approve)
   raises a CRITICAL `sendOpsAlert` + a `payment_reconciliation` verdict
   (`source='wallets_onchain'`). *Remaining: a balance-delta (velocity) monitor on top
   of the leak scan, and per-agent custodial wallets (currently only preventively
   anomaly-scored, owner-alerted).*

### P2
10. **Buyback/distribute run tables and `x402_autonomous_log` lack idempotency keys.**
11. **No DB-level immutability** on any ledger — add append-only enforcement
    (revoke UPDATE/DELETE, or triggers) to the truly-append-only tables
    (`x402_audit_log`, `credit_ledger`, `agent_revenue_events`, `three_buyback_runs`).
12. **`audit_log` hard-deleted at 365 days** — make the window configurable and
    archive to cold storage before delete.
13. **Reconciliation blind spots** (EVM/RPC-miss default to reconciled); **no USDC
    balance watchdog on the non-x402 treasuries** (the ring/seed wallets are
    covered, see §3); **no external alert channel beyond Telegram, and the push
    lane self-throttles**; **global kill switches need a redeploy** (add a
    runtime halt flag).
14. **Financial data shares the storage-capped Neon branch** — isolate money/audit
    tables onto their own branch/DB so an intel-firehose cap can't drop financial
    writes.

### Done
- ✅ **Treasury top-up / economy-master transfers are logged and reconciled.**
  Every sweep appends hash-chained rows (transfer/failed/blocked plus a heartbeat)
  to `economy_master_ledger` via [`economy-ledger.js`](../api/_lib/economy-ledger.js),
  with the tx signature, running balance, and at-transfer USD value;
  [`economy-reconcile.js`](../api/cron/economy-reconcile.js) (every 30 min)
  verifies the chain, flags unrecorded outbound debits, and confirms every
  recorded signature on-chain. Closes the former P0 "unlogged treasury transfers"
  gap.
- ✅ **All controlled wallets are on-chain leak-scanned** (`wallets-leak-scan.js`,
  every 15 min) — not just the ring. Any SOL/token debit leaving a
  `SOLANA_SIGNERS` wallet to an address outside the controlled set pages ops and
  files a `wallets_onchain` verdict. Closes the "custodial-signer drains are
  silent" gap (P1-#9).
- ✅ **Implicit sniper auto-funding is gated behind explicit consent.** Arming a
  mainnet `agent_sniper_strategies` row no longer causes the launcher master to
  push SOL to the agent wallet: the auto-funder only tops up agents whose strategy
  set `auto_fund_enabled = true` (default false, fail-safe on a missing value).
  Removes an implicit fund-moving trigger.
- ✅ **Reconciliation discrepancies now page ops** (`revenue-reconciliation.js`) —
  was detected-but-silent (G1/R1).
- ✅ **The closed-loop ring's own books are now chain-reconciled**
  (`ring-reconciliation.js`) — `x402_self_facilitator_log` settlements and
  `x402_ring_ledger` sweeps were previously trusted but never verified. Five
  checks (settle/amount/sweep/cross-log/fee) plus a zero-volume tripwire, every
  30 min, verdicts under `ring_*` sources on the finance-integrity board.

---

## Operating procedures

- **Daily:** review `SELECT * FROM payment_reconciliation WHERE reconciled = false`
  and clear or escalate every row. An alert here means recorded revenue disagrees
  with the chain — treat as a financial incident until explained.
- **On a breach/anomaly alert:** freeze the affected wallet(s)
  (`spend_limits.frozen`), and for a signer-key concern rotate the key
  ([Solana signers runbook](../api/_lib/solana-signers.js)) and
  re-run `check-relayer-balances.mjs` to confirm balances.
- **Before adding a paid flow:** it is not done until it writes an append-only
  ledger row with the on-chain signature and a `UNIQUE` idempotency key, and is
  added to this register and the [money map](money-map.md).

---

## Related

- [Money map](money-map.md) — who receives each payment.
- [x402 revenue & receipts](x402-revenue.md) — the x402 recording detail.
- [x402 endpoints](x402-endpoints.md) — the paid endpoint catalog.
- [Solana signers runbook](../api/_lib/solana-signers.js) — the wallets + funding.
