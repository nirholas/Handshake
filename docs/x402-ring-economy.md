# Closed-loop x402 ring economy

A self-contained agent-to-agent payment loop: **three.ws-controlled wallets pay
three.ws's own x402 endpoints in real USDC, settled by three.ws's own
facilitator.** No user funds, no external facilitator, no wallet outside the
platform. It exists to dogfood and load-test the agent economy end to end —
proving every paid endpoint settles real money, continuously — while costing only
Solana network fees, because the principal recirculates between wallets you
control.

> **This is internal/dogfooding volume, and it is labeled as such.** The report
> endpoint tags it `internal: true`, and the ring settlement endpoint is
> `discoverable: false` (never advertised on the public x402 bazaar /
> agentic.market catalog). Do **not** present self-cycled ring volume as organic
> third-party demand — that is the one thing this system is deliberately built
> *not* to do. The public organic-revenue feed is a separate surface
> ([/api/x402-revenue](../api/x402-revenue.js)).

## Burning the least SOL — two levers

On-chain settlement has a **hard floor**: every Solana transaction costs a base
fee, so there is no zero-SOL option. Two levers get you to the true minimum.

**Lever 1 — fewest transactions (the big one).** The fee is ~flat per tx,
independent of payment size, so cost scales with tx **count**. Make **fewer,
larger payments** via `X402_PRICE_RING_SETTLE`:

| $10,000 gross via | per-call | # txs | SOL burned* | fee cost |
|---|---|---|---|---|
| tiny micro-payments | $0.001 | 10,000,000 | ~50 SOL | **~$10,000** |
| moderate | $1.00 | 10,000 | ~0.05 SOL | **~$10** |
| large | $10.00 | 1,000 | ~0.005 SOL | **~$1** |
| very large | $100.00 | 100 | ~0.0005 SOL | **~$0.10** |

\* at the 1-signature self-pay floor of ~5,000 lamports/tx.

**Lever 2 — one signature, not two (self-pay, now the operative default).** A
sponsored settlement is signed by the buyer *and* a sponsor fee payer = 2
signatures = 10,000 lamports base. In **self-pay** the payer pays its own fee =
**1 signature = 5,000 lamports**, half the base fee, and the facilitator
broadcasts without co-signing (no sponsor key needed at all). The payer just
holds a little SOL for its own fees.

**Self-pay is the default now** — `ringSelfPayDefault()` (`pay.js`) returns true
unless `X402_RING_SELF_PAY=false` is set explicitly. Sponsor mode is the
fallback for gasless buyers that hold no SOL, and it still works (an explicit
`false` selects it). In self-pay the settlement-time SOL floor guard
(`settleRingPayment`, `self-facilitator.js`) watches the **payer** wallet
(`feeWallet = decoded.feePayer = payer`), so the payer's balance is the hard
stop that pauses the loop before it can drain.

Priority fee is already negligible (~5 µlamports) and ATA rent is one-time and
reclaimable. So the practical minimum is: **self-pay + the biggest per-call size
your float supports.** $100/call settles thousands of dollars of volume for a few
cents of SOL.

### Fee floor, enforced — ceiling + continuous audit

The floor is not just a default; it is guarded on both the write and the read
side so it cannot silently regress.

- **Per-tx fee ceiling.** `expectedFeeLamports({selfPay, priorityMicrolamports,
  cuLimit})` (`pay.js`) is the pure worst-case fee for a payment's config. The
  ring's builders keep every batch nonce under it (regression-tested), and
  `payX402` re-checks it at runtime: a payment whose config would exceed
  `X402_RING_MAX_FEE_PER_TX_LAMPORTS` (default 10,000) is a structured skip
  (`fee_ceiling_exceeded:…`), never sent. Self-pay runs at ~5,000; the ceiling
  admits sponsor mode's 10,000 and nothing above it. (The facilitator's own
  guards — `MAX_CU_*`, `MAX_PRIORITY_LAMPORTS` — remain the adversarial bound and
  are never raised.)
- **Nightly fee audit** (`pipelines/fee-audit.js`, registered as `fee-audit`,
  cooldown 86400). Sums the real chain-read fees for the day
  (`x402_self_facilitator_log.fee_lamports`, from
  `getParsedTransaction().meta.fee`) plus settlement/volume counts, derives
  **lamports-per-settlement** and **SOL-per-$100-volume**, upserts one row into
  `x402_fee_audit`, and `sendOpsAlert`s when per-settlement fee exceeds 1.5× the
  1-sig floor (7,500 lamports) or the daily burn exceeds
  `X402_RING_DAILY_FEE_BUDGET_LAMPORTS` (default 0.05 SOL).
- **ATA rent reclaim** rides the same run: it enumerates the USDC token accounts
  the ring's role wallets own and closes any **zero-balance, non-role** ATA
  (owner-signed `closeAccount`, rent → owner, idempotent, capped 5/run). The
  selection is a pure, unit-tested function that never returns a funded account
  or one of the three active role ATAs (payer/treasury/sponsor).
- **Exposed numbers.** `GET /api/x402-ring` reports
  `fees.lamports_per_settlement` and `fees.sol_per_100_usd` live from the same
  logs, for the dashboard and the acceptance run.

**Measured (self-pay, `expectedFeeLamports` over the production builder →
`validateRingTransaction`):** a self-paid settlement decodes to
`estFeeLamports` of **5,000 lamports base + ≤ 60 priority = ≤ 5,060 lamports**
across all 997 batch nonces — under the 5,100-lamport floor bar and well under
the 10,000 ceiling. Sponsor mode measures 10,000 + ≤ 60. (On-chain live
settlement figures land here after the task-11 activation run funds the wallets.)

## Architecture

```
  ring payer wallet ──(1) pay USDC──▶ /api/x402/ring-settle  (recipient = treasury)
        ▲                                     │
        │                          (2) self-hosted facilitator
        │                          /api/x402-facilitator co-signs
        │                          with the sponsor + broadcasts
        │                                     │
        │                                     ▼
        │                               treasury (X402_PAY_TO_SOLANA)
        └────────(4) rebalancer sweeps treasury→payer──────┘
                     (ring-rebalance pipeline)
   sponsor (X402_FEE_PAYER_SOLANA) pays all SOL fees — one wallet to watch (3)
```

The three roles are all platform-controlled:

| Role | Receives / does | Public env | Secret env | Fund with |
|---|---|---|---|---|
| **payer** | pays the ring | (derived) | `X402_SEED_SOLANA_SECRET_BASE58` | USDC float (recirculates) |
| **treasury** | receives payments | `X402_PAY_TO_SOLANA` | `X402_TREASURY_SECRET_BASE58` | nothing (fills, gets swept back) |
| **sponsor** | pays SOL fees | `X402_FEE_PAYER_SOLANA` | `X402_FEE_PAYER_SECRET_BASE58` | SOL for fees only |

> In **self-pay** mode (`X402_RING_SELF_PAY=true`, recommended for lowest fees) the
> **payer** pays its own 1-signature fee — fund the payer with the fee SOL and the
> **sponsor** role becomes optional. Sponsor mode exists for buyers that hold no
> SOL and want gas sponsored (2 signatures, ~2× the base fee).

### Provisioning, verification & monitoring

Every ring wallet is provisioned once, registered in `x402_ring_wallets`, and
then kept in a verified, watched, auto-fundable state:

- **Verify** — [scripts/x402-ring-verify.mjs](../scripts/x402-ring-verify.mjs)
  resolves each role from env, checks the secret decodes to its declared pubkey
  (treasury secret ↔ `X402_PAY_TO_SOLANA`, sponsor secret ↔
  `X402_FEE_PAYER_SOLANA`), confirms `x402_ring_wallets` holds exactly one enabled
  row per role, checks the treasury is inside the facilitator's `payToAllowlist()`,
  prints a 3-row table with live SOL/USDC, and exits non-zero on any mismatch. It
  never prints a secret. `--fix` reconciles the DB registry to env (upsert the env
  pubkey, disable stray rows); `--json` emits machine-readable output.
- **Balance monitor** — [api/_lib/x402/wallet-balance-monitor.js](../api/_lib/x402/wallet-balance-monitor.js)
  (`checkRingWallets`, run every 10 min by the autonomous loop) reads all three
  wallets on-chain and alerts via `sendOpsAlert` on a role-floor breach:

  | Role | SOL floor | USDC floor |
  |---|---|---|
  | **sponsor** | 0.03 SOL (1.5× the 0.02 hard floor) | — |
  | **payer** | 0.03 SOL *(self-pay mode only)* | `X402_RING_PAYER_USDC_FLOOR_ATOMIC`, default **$5** |
  | **treasury** | — (unbounded: fills + gets swept) | — |

  The 0.03 SOL floor sits a hair above the facilitator's `X402_SPONSOR_SOL_FLOOR_LAMPORTS`
  (0.02 SOL) hard stop, so operators are warned *before* settlement is refused.
  A breach snapshot is published to Redis `x402:ring-wallets:latest` for cheap
  dashboard reads. The pure floor math is in
  [ring-floors.js](../api/_lib/x402/ring-floors.js).
- **Auto-topup** — the sponsor (`x402-ring-sponsor`) and payer (`x402-ring-payer`)
  are entries in [api/_lib/solana-signers.js](../api/_lib/solana-signers.js) with
  `minSol: 0.03`, so the economy master's
  [treasury-topup](../api/cron/treasury-topup.js) cron refills their fee **SOL**
  automatically when they fall below floor — closing the "sponsor runs dry and the
  ring silently halts" failure. The **treasury is deliberately not a signer** (the
  master must never top up a wallet that only receives and gets swept), and the
  master only ever moves SOL, so the payer's **USDC** float is a manual top-up when
  the monitor alerts. Funding floors are enforced by the signer registry,
  [api/_lib/solana-signers.js](../api/_lib/solana-signers.js).

## Components

- **Self-hosted facilitator** — [api/x402-facilitator/[action].js](../api/x402-facilitator/[action].js),
  core in [api/_lib/x402/self-facilitator.js](../api/_lib/x402/self-facilitator.js).
  Drop-in `/verify` + `/settle` matching the x402 v2 facilitator contract.
  Validates the buyer-signed USDC transfer, co-signs with the sponsor key,
  broadcasts over our RPC, logs the exact SOL fee. Point
  `X402_FACILITATOR_URL_SOLANA` at `https://three.ws/api/x402-facilitator` and no
  third party ever touches settlement.
  - **Anti-drain gate.** The sponsor signs the whole transaction, so the
    facilitator refuses to co-sign anything that is not exactly `{compute-budget,
    optional ATA-create for OUR treasury, one USDC TransferChecked to an
    allowlisted payTo}`. No System instructions (no SOL transfer out), capped
    priority fee, recipient must be allowlisted. This blocks the "anyone drains
    the sponsor" attack **and** enforces "only our wallets settle here".
  - **SOL floor.** Below `X402_SPONSOR_SOL_FLOOR_LAMPORTS` (default 0.02 SOL) the
    facilitator refuses to settle, pausing the loop before it can drain your SOL.
- **Ring settlement endpoint** — [api/x402/ring-settle.js](../api/x402/ring-settle.js).
  Price-configurable (`X402_PRICE_RING_SETTLE`), internal (`discoverable:false`),
  returns a real economic-tick receipt.
- **Rebalancer** — [api/_lib/x402/pipelines/ring-rebalance.js](../api/_lib/x402/pipelines/ring-rebalance.js),
  registered in the autonomous loop. Sweeps treasury→payer so the float never
  drains. Recirculation, not spend — never consumes the daily spend cap.
- **Net-position report** — [api/x402-ring.js](../api/x402-ring.js). `GET
  /api/x402-ring?period=24h|7d|30d|all`. Gross volume, tx count, SOL burned (in
  SOL + USD), sweep totals, live balances, the two fee-efficiency numbers
  (`fees.lamports_per_settlement`, `fees.sol_per_100_usd`), and the honest bottom
  line: real cost = fees only.
- **Fee audit + ATA rent reclaim** —
  [api/_lib/x402/pipelines/fee-audit.js](../api/_lib/x402/pipelines/fee-audit.js),
  registered as `fee-audit` (nightly). Measures the real per-settlement and
  per-$100 fee burn into `x402_fee_audit`, alerts on drift, and closes empty
  non-role ATAs to reclaim their rent. Audit + reclaim only — never a spend.
- **Endpoint catalog** —
  [api/_lib/x402/ring-catalog.js](../api/_lib/x402/ring-catalog.js) is the single
  source of truth for **every** paid x402 endpoint on the platform (46 entries:
  tips, services, intel, health checks, settlement). Each entry declares the exact
  `method`, `query`/`body()` request contract, and default price the handler
  actually validates — derived by reading the handler, so a ring call never spends
  money on a request the endpoint would reject. **35 are `autobuy`** (safe to
  purchase on the loop); the **11 `autobuy:false`** entries (real coin mints, real
  LLM spend, dynamic third-party payouts) are covered by one-time verification, not
  the loop, each with a justification in the source. Adding a new paid endpoint
  without cataloging it fails `tests/x402-ring-catalog.test.js` (it greps every
  `paidEndpoint(` construction site and asserts each is cataloged).
- **Volume engine** — the existing autonomous loop
  ([api/cron/x402-autonomous-loop.js](../api/cron/x402-autonomous-loop.js) →
  [volume-bootstrap-loop.js](../api/_lib/x402/pipelines/volume-bootstrap-loop.js))
  and the per-minute ring tick both round-robin the catalog's weighted autobuy
  rotation (`rotationPlan()`), mapped into the shared driver in
  [volume-shared.js](../api/_lib/x402/pipelines/volume-shared.js). The rotation is
  weighted so **every autobuy endpoint is exercised at least once per hour** at the
  stock 5-minute cadence (12 ticks × 4 = 48 selections/hour ≥ the 38-entry
  rotation) — test-proven, not asserted.
- **Coverage proof** —
  [scripts/x402-ring-coverage-sweep.js](../scripts/x402-ring-coverage-sweep.js)
  pays every catalog entry once and records the facilitator settle signature +
  verified business effect (regenerates `tasks/x402-ring/COVERAGE.md` locally) —
  the standing guarantee that each endpoint actually settles when paid, not just
  that it 402s.
- **Setup script** — [scripts/x402-ring-setup.mjs](../scripts/x402-ring-setup.mjs).
  Generates the role wallets, writes secrets to a gitignored file, prints the env
  block. Never funds anything.

## Reconciliation — proving every ring dollar on-chain

The daily [revenue reconciler](../api/_lib/x402/revenue-reconciliation.js) proves
`x402_autonomous_log` and `agent_payment_intents` against the chain, but it never
reads the ring's own books. A settlement recorded only in
`x402_self_facilitator_log` is a *claim*; a sweep in `x402_ring_ledger` is a
*claim*. The [ring reconciler](../api/_lib/x402/ring-reconciliation.js)
(`ring-reconciliation` in the autonomous registry, **every 30 min**, 72h rolling
window, **read-only** on chain) turns each claim into a proven fact or a paged
discrepancy — the same standard the [economy master](./financial-controls.md#2-reconciliation-coverage)
already meets.

Five checks, plus a silence alarm:

| Check | What it proves | Verdict on failure | Severity |
|---|---|---|---|
| **Settle integrity** | every `x402_self_facilitator_log` settle (72h) exists + succeeded on-chain (batched `getSignatureStatuses`) | `x402_ring_settle_missing` / `x402_ring_settle_failed` | 🚨 CRITICAL |
| **Amount fidelity** | a sampled subset of confirmed settles pays *exactly* `amount_atomic` of `mint` to `pay_to` (parsed from `pre/postTokenBalances`) | `x402_ring_amount_mismatch` | 🚨 CRITICAL |
| **Sweep integrity** | every `x402_ring_ledger` `sweep` exists, succeeded, and moved the ledger amount **treasury→payer** (source must be the configured treasury) | `x402_ring_sweep_missing` / `x402_ring_sweep_failed` / `x402_ring_sweep_mismatch` | 🚨 CRITICAL |
| **Cross-log coherence** | a ring tick lands in BOTH books (buyer side in `x402_autonomous_log`, settle side in `x402_self_facilitator_log`); joined on signature, orphans on either side are flagged | `x402_ring_log_orphan` | ⚠️ WARN (daily-throttled) |
| **Fee coherence** | yesterday's summed `fee_lamports` vs the fee-audit rollup (`x402_fee_audit`); >20% apart means one book is wrong | `x402_ring_fee_divergence` | ⚠️ WARN (daily-throttled) |
| **Zero-volume tripwire** | ring enabled (facilitator on + treasury set) but **zero settles in 30 min** → "enabled but silent" | `x402_ring_enabled_but_silent` | ⚠️ WARN |

A **settlement with no buyer record** is the money-relevant case: value moved
through our own facilitator with no spend we booked — the "leak through our own
facilitator" signature. The **tripwire** is the alarm that was missing when the
ring stopped working quietly: it fires when the loop is switched on but has gone
silent, and its verdict flips back to reconciled the moment volume returns.

**Bounds.** Read-only against the chain; `getSignatureStatuses` batched at 256;
at most **50 `getParsedTransaction` calls per run**, with sweeps drawing from that
budget *first* (each sweep moves the entire float). The reconciler **never mutates
the logs it audits** — verdicts in `payment_reconciliation` and one summary row in
`x402_autonomous_log` are its only writes.

**Ops board.** Ring findings share the `payment_reconciliation` table with every
other reconciler but carry distinct `source` values so they separate on the
finance-integrity board:

```sql
-- the open ring findings, most recent first
SELECT source, source_ref, chain_status, discrepancy, checked_at
FROM payment_reconciliation
WHERE source LIKE 'ring_%' AND reconciled = false
ORDER BY checked_at DESC;
```

Sources: `ring_facilitator_settle`, `ring_ledger_sweep`, `ring_log_coherence`,
`ring_fee_coherence`, `ring_tripwire`. CRITICAL findings
(missing/failed/mismatch) page ops immediately; coherence and fee WARNs throttle
to one alert per class per day.

## Turning it on

```bash
# 1. Generate the wallets (no chain, no funding — just keys).
node scripts/x402-ring-setup.mjs

# 2. Apply the schema.
psql "$DATABASE_URL" -f api/_lib/migrations/2026-07-01-x402-ring-economy.sql

# 3. Set env on the Cloud Run service, from the printed block
#    (gcloud run services update three-ws-api --region us-central1 --update-env-vars …):
#    X402_SELF_FACILITATOR_ENABLED=true   # else /api/x402-facilitator → 503
#    X402_EXTERNAL_ENABLED=false          # only OUR endpoints get paid
#    X402_CHARITY_AUDIT_BPS=0             # no charity split leaves the ring
#    X402_RING_SELF_PAY=true              # 1-signature settles, lowest SOL
#    X402_PRICE_RING_SETTLE=1000000       # $1.00/call
#    X402_VOLUME_PER_RUN_CAP_ATOMIC=…     # must be ≥ X402_PRICE_RING_SETTLE
#    X402_AUTONOMOUS_DAILY_CAP_ATOMIC=…   # your daily volume target
#    X402_SPONSOR_SOL_FLOOR_LAMPORTS=20000000
#    + the payer / treasury / sponsor pub+secret pairs

# 4. Fund (manual, real money):
#    payer   → USDC float, e.g. $50 (recirculates)
#    sponsor → SOL for fees, e.g. 0.1 SOL (≈ thousands of settlements)
#    treasury→ nothing; it fills and gets swept back

# 5. Confirm the envelope is correct BEFORE funding — config_warnings must be [].
curl https://three.ws/api/x402-status  | jq '.ring'
curl https://three.ws/api/x402-ring    | jq '.config_warnings'
```

### How Solana settlement routes

Turning on `X402_SELF_FACILITATOR_ENABLED=true` is what makes the self-hosted
facilitator the *default* Solana settle path — it is **not** always-on. The
resolver ([api/_lib/x402/ring-config.js](../api/_lib/x402/ring-config.js), used
by `facilitatorFor()`) decides in this order:

1. **An explicit `X402_FACILITATOR_URL_SOLANA` always wins.** Existing non-ring
   deploys never silently re-route. Point it at
   `https://three.ws/api/x402-facilitator` to force in-house settlement
   regardless of the flag, or at an external facilitator to opt out.
2. **Else, with `X402_SELF_FACILITATOR_ENABLED=true`,** Solana settlement
   defaults to this deploy's own `$APP_ORIGIN/api/x402-facilitator` — no URL
   needed.
3. **Else** it falls back to the external PayAI facilitator.

So the correctly-enveloped ring deploy sets the flag and **leaves
`X402_FACILITATOR_URL_SOLANA` unset** (or points it at the self URL). Setting the
flag while an external URL still wins is the mis-envelope the surfaces below flag.

### Fail loud, not silent

A mis-enveloped deploy — flag on but settlement still routing externally, or a
missing secret, or `X402_PRICE_RING_SETTLE` above the per-run cap — never routes
volume elsewhere quietly:

- **`/api/x402-status`** returns a `ring` block: `self_facilitator_enabled`, the
  resolved `self_facilitator_url`, and `config_warnings[]`. The self-hosted
  facilitator's `/supported` is probed as a distinct `self: true` entry whenever
  the flag is on, even if an external URL wins routing.
- **`/api/x402-ring`** returns the same `config_warnings[]` alongside the
  net-position report, and logs one structured warning per boot when settlement
  would route to an external facilitator.

`validateRingConfig()` reports six findings — facilitator disabled, URL external,
missing treasury secret, missing fee-payer pubkey, price-above-cap, and self-pay
off. A green ring is `config_warnings: []`.

Everything is **off by default**: without `X402_SELF_FACILITATOR_ENABLED=true` and
the sponsor secret, the facilitator returns `503` and nothing settles.

## Cost model

For a monthly gross target `V` at per-call size `p`:

- transactions ≈ `V / p`
- SOL fee ≈ `V / p × ~0.000005 SOL` (self-pay 1-sig floor, the default; ~0.00001
  in sponsor mode) — measured per-tx: **≤ 5,060 lamports self-pay**, capped by
  `X402_RING_MAX_FEE_PER_TX_LAMPORTS` (default 10,000)
- one-time ATA rent ≈ 0.002 SOL per new wallet pair — **reclaimed automatically**
  by the nightly fee audit (closes empty non-role ATAs, rent → owner)
- charity/facilitator leak = **$0** when `X402_CHARITY_AUDIT_BPS=0` and the
  self-hosted facilitator is used
- principal = recirculates; net USDC position stays ~flat (see `/api/x402-ring`)

Example: $10k/mo at $1/call ≈ 10k txs ≈ 0.05 SOL ≈ ~$10 real cost. At $100/call it
is ~$0.10. The audit surfaces the *actual* numbers — `lamports_per_settlement`
and `sol_per_100_usd` — from real chain-read fees, and alerts if they drift above
the floor (>1.5× the 1-sig fee) or the daily budget
(`X402_RING_DAILY_FEE_BUDGET_LAMPORTS`, default 0.05 SOL).

## Cadence — many paid hits every minute

The 5-minute autonomous loop proves every endpoint is live, but it is too slow and
too tightly capped to be the *continuous* driver — at 300s cooldowns and a $0.05
per-run cap the flagship ring-settle ($1.00) was skipped every cycle. The
**per-minute ring tick** ([api/cron/x402-ring-tick.js](../api/cron/x402-ring-tick.js),
scheduled `* * * * *`) is the steady driver: every minute it pays
`X402_RING_TICK_CALLS` endpoints drawn from the internal catalog, weighted so cheap
tips/services dominate the count while one **ring-settle carries volume cheaply**
every `X402_RING_SETTLE_EVERY_N_TICKS` ticks.

It shares the *one* payment + recording path with the volume loop
([pipelines/volume-shared.js](../api/_lib/x402/pipelines/volume-shared.js)) — same
`payX402`, same `x402_autonomous_log`, same `x402_volume_metrics` ledger — but with
its **own, separate budget**: rows are tagged `pipeline='ring-tick'` and summed
independently, so the ring tick never consumes the autonomous loop's
`X402_AUTONOMOUS_DAILY_CAP_ATOMIC`.

### Throughput + fee math at the stock defaults

| Knob | Default | Meaning |
|---|---|---|
| `X402_RING_TICK_CALLS` | 3 | paid calls per minute |
| `X402_RING_SETTLE_EVERY_N_TICKS` | 5 | one ring-settle every 5th tick (~1 / 5 min) |
| `X402_PRICE_RING_SETTLE` | $1.00 | the volume carrier's per-call size |
| `X402_RING_TICK_CAP_ATOMIC` | $1.10 | per-tick spend ceiling (fits one settle + its cheap co-riders) |
| `X402_RING_DAILY_CAP_ATOMIC` | $50.00 | ring-tick daily ceiling (separate budget) |

At 3 calls/min the **traffic shape** is:

- **4,320 tx/day** (3 × 1,440 min) — of which **288/day are ring-settle** (1 per
  5 min) and **~4,032/day are cheap tips/services**.
- **~0.0216 SOL/day** in network fees at the 1-signature self-pay floor
  (4,320 tx × 5,000 lamports = 21,600,000 lamports). The priority fee (~5 µlamports
  over 60k CU ≈ 0.3 lamports/tx) is negligible; ATAs already exist, so no per-call
  rent. In sponsor mode (2 signatures) it is ~0.0432 SOL/day.

The **$50/day ring-tick cap bounds spend**, not tx count: with ~$1 settles plus
cheap tips it is reached after roughly **4 hours** of continuous per-minute traffic
(~48 settles + their tips), after which the tick **no-ops cleanly** — one structured
`ring_daily_cap_reached` log row per minute — until UTC midnight. That is the
intended "steady, capped" behavior. For **24-hour continuous** coverage, raise
`X402_RING_DAILY_CAP_ATOMIC` to cover the full day's settle volume (≈ 288 × the
settle price, e.g. ~$300 at $1/call), or lower `X402_PRICE_RING_SETTLE` /
raise `X402_RING_SETTLE_EVERY_N_TICKS` so a day's settles fit under $50. Because the
principal recirculates (the rebalancer sweeps treasury→payer, now on a **120s**
cooldown to keep up with the faster float), a higher daily cap raises *gross volume*
without raising real cost — cost is only the SOL fees above.

### Coherence: no silent skips

The old failure — ring-settle silently dropped because its price exceeded the
per-run cap — is now **impossible to hit quietly** three ways:

1. `X402_VOLUME_PER_RUN_CAP_ATOMIC` and `X402_RING_TICK_CAP_ATOMIC` **default high
   enough** ($1.10) to fit the $1.00 ring-settle out of the box.
2. `validateRingConfig()` returns a `ring_price_exceeds_run_cap` **error finding**
   when the price still exceeds the cap — surfaced on `/api/x402-ring` and
   `/api/x402-status`, and the ring tick **refuses to run** on any error finding.
3. If a call is ever skipped for `cap_would_exceed`, `payX402` logs a **loud,
   throttled warning** naming the endpoint, the price, the cap, and the exact env
   to change.

### Back-pressure, never a retry-storm

Before paying, the tick pre-flights the payer's SOL and USDC balances. Below the
facilitator SOL floor (`X402_SPONSOR_SOL_FLOOR_LAMPORTS`, default 0.02 SOL) or on
an RPC fault → the whole tick **skips** with a structured `x402_autonomous_log`
row and **one throttled ops alert** (max 1/hour per reason via `sendOpsAlert`).
It never fires settlements that would 502 in a loop.

An **unaffordable settle degrades instead of killing the tick**: when the payer
holds enough USDC for tips but not for the ring-settle price (e.g. the price was
raised ahead of funding), the tick drops the settle carrier and fires cheap-only
calls, logs `ring_tick_settle_unaffordable`, and raises one throttled
`ring-tick:settle_unaffordable` ops alert until the payer is funded. The ring
stays visibly alive on tips; the funding gap stays loud. Only a payer that can't
even cover tip headroom hard-skips (`insufficient_payer_usdc`). Decision logic:
`planBackpressure()` in
[api/_lib/x402/ring-tick-plan.js](../api/_lib/x402/ring-tick-plan.js).

**Never raise the settle price ahead of funding.** The defaults ($1.00 settle,
$1.10 tick cap, $50/day) are sized to the ring's real balances. Scaling to higher
daily volume is an env change (`X402_PRICE_RING_SETTLE`,
`X402_RING_TICK_CAP_ATOMIC`, `X402_RING_DAILY_CAP_ATOMIC`,
`X402_RING_SETTLE_EVERY_N_TICKS`) made **together with funding the payer wallet**
— in July 2026 a defaults-only lift to $35/settle put every tick into
back-pressure and flat-lined the visible ring economy for hours.

## Agents in the ring — buyers with names, not a cron

The cadence above keeps volume flowing, but volume alone still reads as "a cron
paying itself." What makes it an **agent-to-agent economy** is that the buyers are
real platform agents — `agent_identities` rows with custodial Solana wallets —
each shopping the ring in character, spend-limited, and attributed. That layer
lives in [api/_lib/x402/agents/](../api/_lib/x402/agents/) and runs as the
`agent-buyers` entry in the autonomous loop.

### The roster & personas

Three personas, one module each, each backing a real custodial agent wallet:

| Persona | Agent buys | Tier |
|---|---|---|
| **Endpoint Shopper** ([endpoint-shopper.js](../api/_lib/x402/agents/endpoint-shopper.js)) | market/$THREE intel + health probes | intel, health |
| **Agora Citizen** ([agora-citizen.js](../api/_lib/x402/agents/agora-citizen.js)) | club cover + dance tips (after "completing work") | commerce, tip |
| **Marketplace Curator** ([curator.js](../api/_lib/x402/agents/curator.js)) | skill-marketplace listings + $THREE billboards | commerce |

Each persona's `plan({ origin, seed, maxBuys })` is a **pure function of the tick
seed** — same seed ⇒ same purchases — so the rotation is reproducible and
testable. Every purchase routes through the one guarded path in
[persona-kit.js](../api/_lib/x402/agents/persona-kit.js) `executePurchase()`:

1. **`enforceSpendLimit`** ([agent-trade-guards.js](../api/_lib/agent-trade-guards.js)) —
   the agent's own per-tx / daily USD caps. A breach is a **refusal** (recorded +
   custody-logged), never a thrown error that crashes the tick.
2. **Allowlist gate** — the tick pre-resolves `ringAllowedAddresses()` and refuses,
   *before broadcasting*, any payment whose `payTo` is outside the controlled set
   (via the new `onAccept` hook on `payX402`). Defence-in-depth over the
   facilitator's own recipient allowlist.
3. **Pay** with the **agent's** custodial keypair (`recoverSolanaAgentKeypair`).
4. **Custody-log** the settled `spend` event with the settle signature.

Every settled purchase is written to `x402_autonomous_log` with the buying
**`agent_id`** (migration
[2026-07-03-x402-ring-agents.sql](../api/_lib/migrations/2026-07-03-x402-ring-agents.sql)),
so the dashboard can show *which agent bought what* — the surface that makes it an
agent economy, not anonymous cron traffic. Personas are labeled `internal:true` in
every row; they are never presented as organic users.

### Roster provisioning & membership

`ensureRosterAgents()` idempotently resolves each persona's backing agent (finds it
by `meta.ring_persona`, else creates it under the platform owner), provisions its
custodial wallet via `ensureAgentWallet`, stamps its spend limits, and registers the
wallet in `x402_ring_wallets` with `role='agent'`. Because both
`ringAllowedAddresses()` and the [ring verify script](../scripts/x402-ring-verify.mjs)
read `x402_ring_wallets`, roster wallets land inside the controlled set and the
audit table automatically — `node scripts/x402-ring-verify.mjs` lists them under
"roster agents", and the [leak scanner](#on-chain-leak-scanner) classifies their
traffic as `internal`.

### Closing the loop through the business layer

Every persona pays the ring **treasury** (`X402_PAY_TO_SOLANA`) — the seller side
is the platform itself, so no purchase leaves the controlled set:

- **intel / health** — the agent pays the treasury for a real signal/liveness
  response it consumes.
- **club cover / dance tip** — settle to the treasury (the club's takings); the
  dancer is a stage slot on the 3D club stage, not an external wallet, so the tip
  is recorded in `club_tips` (business) **and** `x402_ring_ledger` (settlement)
  without leaving the ring.
- **skill-marketplace / billboard** — the marketplace read and the $THREE billboard
  slot both pay the treasury.

The proceeds are recycled back to each agent's working balance by the **float
top-up** step — `floatTopUp()` in
[ring-rebalance.js](../api/_lib/x402/pipelines/ring-rebalance.js), the
`ring-float-topup` loop entry. It keeps every roster agent's USDC inside a band
(`X402_RING_AGENT_FLOAT_ATOMIC`, default **$2**; floor $1, ceiling $4): tops up a
hungry agent from the treasury, sweeps an overfull one back, asserts every
counterparty against `ringAllowedAddresses()` first (fail-closed), and records each
move to `x402_ring_ledger` as **`kind='fund'`**. Recirculation, not spend — it
returns `amountAtomic:0` and never consumes the daily cap.

### On-chain deployments in the loop

At low cadence (`X402_RING_ONCHAIN_EVERY_N_TICKS`, default **60** ≈ hourly) one
roster agent lands a **real on-chain program call**: an agent-to-agent invocation
receipt on the `agent_invocation` Anchor program
([onchain.js](../api/_lib/x402/agents/onchain.js) →
[agent-invocation-onchain.js](../api/_lib/agent-invocation-onchain.js)). The invoking
agent's **own custodial keypair signs and pays the network fee — so the fee payer is
a ring wallet**, as required. The program moves no funds; it emits a `SkillInvoked`
event, giving the ring a permanent, explorer-linkable proof that two platform agents
transacted. It runs on **devnet** (`AGENT_INVOCATION_NETWORK`, per the no-new-mainnet
constraint), verifies the program is deployed before attempting, and **skips cleanly**
(logging why) when the program/env is absent or the wallet is unfunded. Every attempt
— landed or skipped — is written to `x402_autonomous_log` (pipeline `ring-onchain`,
with `agent_id`), and a landed receipt also records an `onchain_event` custody row.

### Running it

`node scripts/x402-ring-agents-run.mjs [ticks]` drives the roster locally for N
ticks (default 10) using the exact `run(ctx)` the loop invokes — real end to end,
degrading to clean skips without env/funding — and prints the attribution summary
(distinct `agent_id`s + settle sigs) and fund-ledger moves for the acceptance
checklist.

**Env knobs:** `X402_RING_AGENT_FLOAT_ATOMIC` (float target, default $2),
`X402_RING_AGENT_FLOAT_FLOOR_ATOMIC` / `_CEIL_ATOMIC` (band edges),
`X402_RING_AGENT_MAX_BUYS_PER_TICK` (per-persona buys, default 1),
`X402_RING_AGENT_PERSONAS_PER_TICK` (active personas, default all),
`X402_RING_ONCHAIN_EVERY_N_TICKS` (on-chain cadence, default 60),
`X402_RING_AGENT_OWNER_USER_ID` (owner for auto-created roster agents).

## Leak-proofing — the invariant, made active

**The invariant:** no SOL or USDC ever leaves the set of wallets three.ws
controls — not to another user, not to a charity, not to an external facilitator,
not as a fee beyond the network's own. The anti-drain gate above already refuses
to *settle* a leaking transaction; leak-proofing closes the remaining gap — a
flipped guard env, a compromised key, or any path that moves money without going
through the facilitator — by asserting the invariant at runtime **and** watching
the chain for money actually leaving.

### The controlled-wallet set

[api/_lib/x402/ring-allowlist.js](../api/_lib/x402/ring-allowlist.js) resolves
`ringAllowedAddresses()` — every address the platform controls:

- the three ring role wallets (payer, treasury, sponsor — env + derived),
- the `x402_ring_wallets` registry,
- every platform signer in [api/_lib/solana-signers.js](../api/_lib/solana-signers.js),
- explicit extras from `X402_SELF_FACILITATOR_PAYTO_ALLOWLIST`,
- and the USDC ATAs of all of the above (SPL credits land on the token account).

> This is the **membership** set (is a counterparty ours?), and it is deliberately
> broader than the facilitator's `payToAllowlist()` **receiving** set (may we
> settle *to* this address?). Receiving is stricter than membership — a wallet can
> be controlled without being a valid settlement recipient.

### Assertion points — the ring fails CLOSED

Before any spend, the spend entry points call `assertRingSpendInvariants()`,
which checks three guards:

1. `X402_EXTERNAL_ENABLED === 'false'` — external spending disabled (unset = violation),
2. `X402_CHARITY_AUDIT_BPS` parses to exactly `0` — no split leaves the ring,
3. facilitator resolves to **self** — `X402_SELF_FACILITATOR_ENABLED=true` and
   settlement routes to our own `/api/x402-facilitator` (via `resolveSolanaFacilitator()`).

Any violation **no-ops the entire spend path** and fires one throttled CRITICAL
ops alert naming the flipped flag. A forgotten or tampered flag can no longer
silently re-open external spending — the loop stops spending instead.
Wired into [api/cron/x402-autonomous-loop.js](../api/cron/x402-autonomous-loop.js)
(the loop that runs ring settlement) and the ring tick.

### On-chain leak scanner

[api/cron/x402-ring-leak-scan.js](../api/cron/x402-ring-leak-scan.js) runs every
10 min (`CRON_SECRET`-authed, **strictly read-only** on chain). For each ring
wallet it pulls the new signatures since a persisted per-wallet cursor
(`x402_ring_scan_cursor`, ≤100/run), batches `getParsedTransactions`, and
classifies every debit:

| class | meaning |
|---|---|
| `internal` | counterparty ∈ `ringAllowedAddresses()` — money stayed in the set |
| `network_fee` | the Solana fee our wallet paid (the only permitted outflow) |
| **`LEAK`** | anything else: USDC to an unknown address, **any** non-USDC token out, an unexplained SOL debit, a System transfer to an unknown address |
| `delegation` | an SPL `Approve` on a ring ATA — a leak vector *before* funds move |

Every `LEAK`/`delegation` fires a CRITICAL `sendOpsAlert` (signature,
counterparty, amount, rotate-the-key recommendation) and upserts a verdict into
`payment_reconciliation` with source `x402_ring_onchain`, alongside the economy
master's breach verdicts on the same ops financial-integrity board. When
classification is ambiguous it errs to `LEAK` — a false positive is cheaper than
a missed drain.

**Fee-leak line item.** The scanner accumulates the per-day network fees ring
wallets actually paid on chain (`x402_ring_fee_observed`) and cross-checks the
last complete UTC day against task 05's `x402_fee_audit` rollup. A >20% mismatch
means something is paying fees from our wallets outside the ring's accounting →
WARN.

### Response runbook — a leak alert fired

1. **Confirm** — open the `solscan.io/tx/<sig>` link in the alert; read the
   counterparty and amount. Cross-check the verdict:
   `SELECT * FROM payment_reconciliation WHERE source = 'x402_ring_onchain' AND reconciled = false`.
2. **Rotate** — treat the affected wallet's key as compromised. Generate a new
   secret (`node scripts/x402-ring-setup.mjs` for a ring role; the signer's own
   runbook otherwise) and replace it in the Cloud Run service env
   (`gcloud run services update three-ws-api --region us-central1 --update-env-vars …`).
3. **Drain** — move remaining funds from the old wallet to the treasury
   (`X402_PAY_TO_SOLANA`) before the old key can move more.
4. **Revoke** (delegation alerts) — send an SPL `Revoke` on the approved ATA to
   kill the delegate's authority.
5. **Re-verify** — run `node scripts/x402-ring-verify.mjs` to confirm the wallet
   set is clean, then mark the verdict reconciled.

## Watching it — the operator dashboard

The ring has a JSON scoreboard ([/api/x402-ring](../api/x402-ring.js)) and now a
pair of eyes: **[/admin/ring](../pages/admin/ring.html)** — a live operator
dashboard that makes the closed-loop economy visible at a glance, so "it stopped
working" can never again go unnoticed for days. It is admin-authed and
`noindex`; every panel renders from real data, and a persistent header badge
labels all ring volume as **internal dogfooding, not organic revenue** (per the
labeling rule at the top of this doc).

One aggregate endpoint —
**[/api/admin/ring-dashboard](../api/admin/ring-dashboard.js)** — backs the whole
page (one authed fetch per 15s poll, not seven). It *composes* the public
`/api/x402-ring` report rather than forking it, then adds the read-only cuts the
public feed doesn't carry. Auth is identical to
[/api/admin/seeder](../api/admin/seeder.js): a real admin session **or**
`Authorization: Bearer $CRON_SECRET`.

What you see:

- **Pulse strip** — settlements per minute over the last 60 minutes as a live
  spark strip where a gap is instantly visible, plus `minutes_since_last_settle`
  as a big status number with heartbeat thresholds: **≤1 min green** (the
  per-minute tick is alive), **≤5 amber** (slowing), **>5 red** (stalled — go
  look). Kill the tick and the number climbs amber→red within those thresholds.
- **Loop diagram** — payer → endpoint → treasury → (sweep) → payer with live
  on-chain balances on each node and the sponsor's SOL floor indicator (sponsor
  node is optional in self-pay mode).
- **Activity feed** — the last 100 paid calls: time, agent persona, endpoint
  slug, kind (`tip` / `service` / `intel` / `commerce` / `settle`), price, and
  the settle signature as a Solscan link. Skips (e.g. `cap_would_exceed`) render
  amber and failures red, each with its structured reason — never a silent drop.
- **Fees panel** — lamports per settlement vs the 5,000-lamport 1-signature
  floor, SOL burned per $100 of gross volume, and today's burn against
  `X402_RING_DAILY_FEE_BUDGET_LAMPORTS` as a budget bar (amber ≥80%, red over).
- **Integrity panel** — all-green collapses to one calm row; any open leak-scan
  finding, reconciliation verdict, or config error expands to red detail with
  the `chain_status` breakdown.
- **Coverage panel** — per-endpoint last-paid age from `x402_volume_metrics`;
  older than 2h (the hourly-coverage guarantee) shows amber.

Keyboard: `r` refreshes, `p` pauses polling. The page polls only while visible
(it aborts on a hidden tab) and ships designed loading (skeletons), empty (`ring
idle — run the activation runbook`), and error (API unreachable, with the `curl`
to debug) states. Reach it from the admin sidebar
([/admin](../public/admin/index.html) → **Ring Economy**) or directly at
`/admin/ring`.

Debug the read model straight from a shell:

```bash
curl -s -H "Authorization: Bearer $CRON_SECRET" \
  "$APP_ORIGIN/api/admin/ring-dashboard?period=24h" | jq '.pulse, .fees'
```

## Related

- [STRUCTURE.md](../STRUCTURE.md) — surface map
- [/admin/ring](../pages/admin/ring.html) + [api/admin/ring-dashboard.js](../api/admin/ring-dashboard.js) — the operator dashboard (above)
- [/api/x402-revenue](../api/x402-revenue.js) — the **public** organic-revenue
  feed (self-cycled ring volume is excluded from the "organic" framing here)
- [docs/x402-revenue.md](./x402-revenue.md) — revenue surface docs
- [api/_lib/x402/ring-allowlist.js](../api/_lib/x402/ring-allowlist.js) — the
  controlled-wallet set + spend invariants
- [api/cron/x402-ring-leak-scan.js](../api/cron/x402-ring-leak-scan.js) — the
  on-chain leak scanner
