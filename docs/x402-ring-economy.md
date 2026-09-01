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
> *not* to do.

## The runway governor: funding IS the throttle

The per-minute ring tick no longer fires a fixed `X402_RING_TICK_CALLS` blindly.
`governedCalls()` (`api/_lib/x402/ring-tick-plan.js`) scales each tick's call
count so the payer's spendable SOL (balance minus the untouchable floor) lasts
`X402_RING_TARGET_RUNWAY_DAYS` (default 3) at the governed rate, assuming
`X402_RING_FEE_PER_CALL_LAMPORTS` (default 7,000, the conservative end of the
measured 6,300-7,800 self-pay cost) per call. Consequences:

- Fund the payer more, the ring speeds up automatically. Let it drain, the rate
  tapers smoothly instead of sprinting to the floor and flat-lining until the
  next manual top-up (the failure mode that killed the ring daily at the
  94-calls/min fixed rate).
- The governor only throttles DOWN from the configured rate, never above it,
  so `X402_RING_TICK_CALLS` remains the hard ceiling.
- **Heartbeat (`X402_RING_MIN_CALLS`, default 1).** Above the hard SOL floor the
  governor never returns 0. Runway-only governing left a dead band between the
  floor and "floor + `runwayDays` of 1 call/min" (0.03 SOL at stock knobs) where
  the ring did nothing — and doing nothing is self-reinforcing: no calls means no
  settles, no settles means no treasury USDC, so no sweep, no revshare, no fuel
  swap, and the economy cannot restart itself from its own balances. Observed
  2026-07-26: 58 consecutive `runway_exhausted` ticks while spendable SOL sat
  idle. The hard floor is the real protection (`assessBackpressure` stops the
  rail there), so spending the band at the heartbeat rate strictly dominates
  hoarding it. Set `X402_RING_MIN_CALLS=0` to restore strict runway-only mode.
- Only at or below the floor does the tick skip with `runway_exhausted` (one
  throttled ops alert), the loud "fund the payer" signal.

### The sponsor governor: watching the wallet that actually starves

`governedCalls()` watches the ring **payer's** SOL, but the outage of 2026-07-28
came from a different wallet: the facilitator's sponsor fee wallet
(`X402_FEE_PAYER_SOLANA`), which co-signs every sponsored settle at roughly
5,000 lamports each. The tick had no view of it, so the first symptom was every
settle dying with `fee_wallet_below_floor` and the ring stopping cold mid-tick.

`sponsorGovernor()` (same module) gives the tick that view, with three regimes:

- **Balance unreadable (RPC blip):** pass through untouched. The facilitator
  fail-closes at settle time, so guessing zero here would turn a transient read
  failure into a self-inflicted outage.
- **Below the hard floor (`X402_SPONSOR_SOL_FLOOR_LAMPORTS`):** skip the whole
  tick with reason `sponsor_fee_wallet_floor`. Every sponsored settle is
  guaranteed to be refused; firing them is pure error noise.
- **Above the floor:** taper the call rate so the sponsor's spendable SOL lasts
  `X402_RING_SPONSOR_RUNWAY_DAYS` (default 1) at
  `X402_RING_SPONSOR_FEE_PER_SETTLE_LAMPORTS` (default 6,000) per settle, with
  the same heartbeat semantics as the payer governor. While tapering, the tick
  logs `fee_wallet_runway_low` and raises one throttled ops alert — the
  pre-starvation signal, hours before `fee_wallet_below_floor` would appear.
  The treasury-topup reclaim (`reclaimIdleSol` / `reclaimIdleAgentSol`) usually
  refills the sponsor within a cycle; the alert persisting is the cue to fund
  the economy master.

### The wallet fee governor: metering the wallet, not the pipeline

`governedCalls()` throttles the **ring tick only**, but the fee-paying wallets
are shared with roughly a dozen other paid pipelines (`health`, `volume`,
`oracle`, `sniper`, `datapoint`, `3d`, `ring-agents`, …). Measured 2026-07-27:
in one 20-minute window the ring tick was throttled to 2 paid calls while
co-tenant pipelines completed ~200 through the same wallet. A governor that
throttles one tenant while others drain the same runway protects nothing under
real scarcity — it just decides *which* pipeline gets starved.

The **wallet fee governor** closes that gap by governing at the one choke point
every platform payment passes through: the facilitator's settle path. Pure
decision logic in
[wallet-fee-governor.js](../api/_lib/x402/wallet-fee-governor.js), I/O in
[wallet-fee-meter.js](../api/_lib/x402/wallet-fee-meter.js), enforced via the
`feeMeter` hook on `settleRingPayment()`:

- **Per-wallet daily budget.** Each fee-paying wallet may burn
  `spendable SOL / X402_WALLET_FEE_RUNWAY_DAYS` (default 3) of fees per UTC
  day, never below the heartbeat floor
  `X402_WALLET_FEE_MIN_BUDGET_LAMPORTS` (default 0.01 SOL/day ≈ ~2,000
  self-pay settles). Spent-today is summed from
  `x402_self_facilitator_log.fee_lamports` per `fee_payer` (the column records
  the wallet that actually paid — payer in self-pay, sponsor in sponsor mode —
  which also resolves the old "governed balance ≠ burned balance" mismatch).
- **Every tenant draws from the same budget.** A settle over budget is refused
  with `fee_runway_exhausted:<spent>+<next>><budget>` *before* co-sign or
  broadcast, whatever pipeline initiated it. Funding is the throttle for the
  whole wallet: top it up and every tenant speeds up together.
- **The refusal is a 503, not a 502.** `settlePayment()` maps it to
  `settlement_unavailable` (503), the same retryable answer the sponsor SOL
  floor gets, because both are the platform pausing on purpose rather than
  breaking. It was classified `502 settle_failed` until 2026-08-06, which made
  every buyer and trust monitor read a funded-runway cap as an outage: 15,619 of
  the autonomous loop's 20,030 `http_502` rows in the 48h to that date were this
  single reason.
- **Callers check admission before they pay.** `assessFeeAdmission()` answers the
  same question with the same math *before* the handshake starts, so an exhausted
  budget costs one skipped call instead of an ATA read, a signature, a facilitator
  verify (which simulates against an RPC node) and a POST that was always going to
  be refused at the end. Both `payX402()` (the ring) and
  `api/cron/x402-autonomous-loop.js` (the autonomous buyer) gate on it; the loop
  records each skip to `x402_autonomous_log` so a paced rail reads as paced rather
  than as a rail nobody used.
- **Platform wallets only.** The meter governs only wallets in
  `ringAllowedAddresses()`. An external organic buyer self-paying through this
  facilitator spends its own SOL and is always admitted.
- **Fails open, floor fails closed.** An unreadable ledger, allowlist, or a
  thrown hook admits the settle — the `fee_wallet_below_floor` hard stop
  remains the real protection; the meter is pacing. A refusal raises one
  deduped ops alert per wallet (`wallet-fee-governor:<pubkey>`) labeling it a
  **governed throttle, not an outage**.
- **Kill switch:** `X402_WALLET_FEE_GOVERNOR_ENABLED=false`. Cache freshness:
  `X402_WALLET_FEE_SPENT_CACHE_MS` (default 20s; bounds multi-instance
  undercount to one window per instance).
- **Intraday pacing (ON in production since 2026-08-06):**
  `X402_WALLET_FEE_PACE_DAY=true` releases the
  daily budget gradually across the UTC day instead of making all of it
  spendable at 00:00. Without it, a wallet whose budget is the heartbeat floor
  can burn the whole allowance in a morning burst and then refuse every settle
  until the next reset: production on 2026-08-01 paid 1,002 settles before
  midday, then rejected roughly 3,500 per hour for the rest of the day with
  `fee_runway_exhausted`. Pacing spreads the same total over 24 hours, so the
  rail keeps a pulse all day. It grants **no** extra spend, and
  `X402_WALLET_FEE_PACE_MIN_SLICE_LAMPORTS` (default 200,000) keeps a wallet
  alive in the first minutes after the reset.

  It ships **off by default on purpose**, and production turned it on after the
  unpaced shape reproduced exactly: on 2026-08-06 the sponsor wallet had burned
  its whole 10,000,000 lamport heartbeat budget by 03:30 UTC and refused every
  settle for the remaining twenty hours. Pacing changes which gate refuses a
  starved wallet first: the governor starts refusing early instead of the hard
  SOL floor refusing later. That floor-vs-governor distinction is exactly what
  `/economy-lab` exists to make visible, and it is how you tell "out of SOL"
  apart from "throttled", so read the limiter from the lab (or
  `GET /api/x402/runway-lab`) rather than from the reject reason while pacing is
  on. `simulateRunway({ paceDay: true })` models both shapes before you commit to
  either.

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
    The floor guard is written by two witnesses, not one: the balance read, and
    the chain's own verdict. `noteSponsorRentFailure()` trips it whenever a
    settle simulation (or the rebalancer's sweep broadcast) fails with
    `InsufficientFundsForRent` on account index 0 and that fee payer is our
    sponsor, so a dry wallet is caught even while every RPC lane is over quota
    and `getBalance` cannot answer (on 2026-08-28 that gap cost three hours and
    95 unsettleable payments). A buyer paying its own fee never trips it. The
    autonomous loop reads the same guard (`sponsorKnownBelowFloor()`) when its
    once-per-tick balance read fails, so an unreadable balance never reads as
    solvent.
  - **Runway alert.** The floor says the rail is already dead. The runway says
    how long until it is, and it pages first: the ring monitor measures the
    sponsor's burn from `fee_lamports` over `X402_SPONSOR_BURN_WINDOW_DAYS`
    (default 7) of successful settles and alerts when days-to-floor drops under
    `X402_SPONSOR_RUNWAY_ALERT_DAYS` (default 3). Thresholds, statuses, and the
    reason `unknown` never pages: [docs/ops/payment-outcomes.md](ops/payment-outcomes.md).
  - **Discovery catalog.** `GET /api/x402-facilitator/discovery/resources` serves
    the facilitator-standard resource list (`?limit=&offset=`, the
    `ListDiscoveryResourcesResponse` shape crawled by x402scan and every client
    built on the x402 npm package's `useFacilitator().list()`). It projects the
    same canonical catalog as `/.well-known/x402.json` into the legacy v1 wire
    format, so explorers indexing this facilitator list our paid endpoints
    automatically. Projection lives in
    [api/_lib/x402/discovery-resources.js](../api/_lib/x402/discovery-resources.js).
- **Ring settlement endpoint** — [api/x402/ring-settle.js](../api/x402/ring-settle.js).
  Price-configurable (`X402_PRICE_RING_SETTLE`), internal (`discoverable:false`),
  returns a real economic-tick receipt.
- **Rebalancer** — [api/_lib/x402/pipelines/ring-rebalance.js](../api/_lib/x402/pipelines/ring-rebalance.js),
  registered in the autonomous loop. Sweeps treasury→payer so the float never
  drains. Recirculation, not spend: never consumes the daily spend cap. A
  sweep broadcast rejected for the sponsor's rent exemption feeds the floor
  guard above (most of the 2026-08-28 faults arrived through this branch, not
  through settle simulation).
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
  This pipeline, the rebalancer and the pool funder all take their blockhash
  from the shared read guard (`api/_lib/solana/read-guards.js`), which answers
  from a hash still inside its validity window when the chain is briefly
  unreadable, so a short RPC blip no longer throws a cron tick straight into an
  ops alert; USDC's decimals resolve locally and cost no RPC call at all.
- **Endpoint catalog** —
  [api/_lib/x402/ring-catalog.js](../api/_lib/x402/ring-catalog.js) is the single
  source of truth for **every** paid x402 endpoint on the platform (84 entries as
  of July 2026: tips, services, intel, health checks, settlement). Each entry
  declares the exact `method`, `query`/`body()` request contract, and default
  price the handler actually validates (derived by reading the handler), so a
  ring call never spends money on a request the endpoint would reject. **45 are
  `autobuy`** (safe to purchase on the loop); the **39 `autobuy:false`** entries
  (real coin mints, real LLM spend, dynamic third-party payouts) are covered by
  one-time verification, not the loop, each with a justification in the source. Adding a new paid endpoint
  without cataloging it fails `tests/x402-ring-catalog.test.js` (it greps every
  `paidEndpoint(` construction site and asserts each is cataloged).
- **Volume engine** — the existing autonomous loop
  ([api/cron/x402-autonomous-loop.js](../api/cron/x402-autonomous-loop.js) →
  [volume-bootstrap-loop.js](../api/_lib/x402/pipelines/volume-bootstrap-loop.js))
  and the per-minute ring tick both round-robin the catalog's weighted autobuy
  rotation (`rotationPlan()`), mapped into the shared driver in
  [volume-shared.js](../api/_lib/x402/pipelines/volume-shared.js). The rotation is
  weighted so **every autobuy endpoint is exercised at least once per hour** at the
  stock 5-minute cadence (12 ticks × 6 selections = 72/hour ≥ the 48-entry
  weighted rotation over the 45 autobuy endpoints), test-proven in
  `tests/x402-ring-catalog.test.js`, not asserted.
- **Coverage proof** —
  [scripts/x402-ring-coverage-sweep.js](../scripts/x402-ring-coverage-sweep.js)
  pays every catalog entry once and records the facilitator settle signature +
  verified business effect (regenerates `tasks/x402-ring/COVERAGE.md` locally) —
  the standing guarantee that each endpoint actually settles when paid, not just
  that it 402s.
- **Setup script** — [scripts/x402-ring-setup.mjs](../scripts/x402-ring-setup.mjs).
  Generates the role wallets, writes secrets to a gitignored file, prints the env
  block. Never funds anything.

## One signature, one payment

A settlement is only real if it has its own on-chain transaction. Enforcing that
turns out to be less obvious than it sounds, and getting it wrong overstated our
own books for three weeks.

**What went wrong.** Ed25519 signatures are deterministic: sign identical
transaction bytes with the same key and you get the same signature. Two ring
payments with the same payer, recipient, mint and amount, built against one
shared tick blockhash with the same fee configuration, compile to *the same
transaction*. Only one can land; the rest are rejected by the network as already
processed. The facilitator treated that rejection as an idempotent retry of the
payment in hand and reported success — so several distinct payments were
credited against a single transfer.

Measured on mainnet 2026-07-28, before the fix:

| | |
| --- | --- |
| Credited settle rows | 59,271 |
| Distinct signatures | 46,597 |
| Rows sharing a signature | 12,674 (21.4%) |
| USDC the log implied | 1,103.444 |
| USDC actually moved | 1,027.424 |

Two sampled transactions each carried exactly **one** SPL transfer of 1,000
atomic units while **nine** settle rows, with nine distinct idempotency keys and
timestamps seconds apart, were credited against them.

**The fix, in three layers.**

1. **Atomic credit at settle.** A successful broadcast is no longer a settled
   payment. [`settle-credit.js`](../api/_lib/x402/settle-credit.js) claims the
   credit for a signature, and only the winner is credited. A retry carrying the
   *same* idempotency key is recognised as an idempotent replay and answered
   with success without double-counting the fee; anything else is refused with
   `signature_already_settled`, so the service is not delivered against a
   transfer that settled a different payment. With the database unreachable the
   claim fails **closed** (`settle_credit_unavailable`) — a refused settle is
   retryable, whereas a wrongly-granted one is not recoverable.

2. **A database constraint, not just code.** Migration
   `20260729000000_x402_settle_sig_unique.sql` adds a partial unique index over
   `tx_sig`. That index, not the pre-check, is what makes concurrent claims safe:
   the credit insert runs `ON CONFLICT DO NOTHING`, so of any set of simultaneous
   settles sharing a signature exactly one wins. The constraint is scoped by a
   `credit_gated` marker column rather than a timestamp, because a migration
   cannot know when its deploy will actually land — history is excluded by
   construction and the rule takes effect precisely when the new code starts
   serving.

3. **Stop building identical transactions.** [`pay.js`](../api/_lib/x402/pay.js)
   previously perturbed the priority fee from a 997-slot per-process counter that
   started at the same value on every instance, so two instances paying the same
   endpoint in one blockhash window produced identical bytes. It now draws from
   ~4.08M slots with a CSPRNG, varying the **compute-unit limit** as well as the
   price. The limit dimension is free: priority fee is `price × limit / 1e6`, so
   at the baseline 5 µlamports even the top of the range floors to zero lamports,
   and unused compute units are not billed. Sponsor mode, which sits exactly at
   the 10,000-lamport ceiling, is restricted to the price slots that still floor
   to zero.

**Proving it stays fixed.** The `settle-signature-audit` pipeline
([source](../api/_lib/x402/pipelines/settle-signature-audit.js)) runs hourly,
free and read-only, and alerts if a single gated signature is ever credited
twice. It also reports the gate's own refusals: a non-zero duplicate-refusal
count is the gate *working*, while a sharp rise means payer-side entropy has
regressed and buyers are eating avoidable retries.

Pre-fix history is deliberately left intact. Those duplicates are real and
published; `scripts/x402-milestone-stats.mjs` prints a warning with both figures
so nobody quotes the row count as an on-chain transaction count.

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

# 2. Apply the schema through the migration runner, never raw psql: it stamps
#    api/_lib/migrations/*.sql into `schema_migrations` by sha256, and the
#    deploy gate (npm run db:check) reads that ledger. A file applied by hand
#    stays "pending" forever and blocks the next deploy. Preview first, because
#    db:migrate applies EVERY pending migration with no dry run of its own.
npm run db:status     # lists what is pending; writes nothing
npm run db:migrate    # applies them (the ring lane needs 2026-07-01-x402-ring-economy.sql,
                      # 2026-07-03-x402-ring-agents.sql, 2026-07-03-x402-ring-leak-scan.sql
                      # and, for the payer pool below, 2026-07-17-x402-ring-pool.sql)

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

# 6. Prove the whole rail end to end without moving a cent (see below).
npm run smoke:x402-facilitator
```

### Proving the rail without spending

`npm run smoke:x402-facilitator`
([scripts/x402-facilitator-smoke-test.mjs](../scripts/x402-facilitator-smoke-test.mjs))
runs the checks above plus the part curl cannot reach: it pulls a real 402
challenge off `/api/x402/ring-settle`, signs a real USDC transfer for it with the
ring payer keypair, and POSTs that signed payment to the facilitator's `/verify`
action. `/verify` runs exactly the checks the money path runs
(`validateRingTransaction` then `assertSettleable`: payTo allowlist, settleable
mint, instruction shape, fee ceiling, on-chain balance) and it never broadcasts.
A green run therefore proves the rail while moving zero USDC and burning zero SOL,
which is why it is safe to run on every sweep and against production.

It targets `https://three.ws` by default; pass `--url=https://<deployment>` for a
preview. Config comes from the shell first and `.env` / `.env.local` second, so
the payer keypair (`X402_SEED_SOLANA_SECRET_BASE58`) and `SOLANA_RPC_URL` do not
have to be exported by hand.

```bash
npm run smoke:x402-facilitator                                  # verify-only vs production
npm run smoke:x402-facilitator -- --url=https://<preview>       # verify-only vs a preview
npm run smoke:x402-facilitator -- --url=https://<preview> --settle --cap=0.05
```

`--settle` is the one mode that spends: it drives a single, cents-capped real
settlement through `payX402`, the same call the autonomous loop makes. It refuses
to run without an explicit `--url`, so a real payment can never leave on an
implied target.

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
| `X402_RING_TICK_CONCURRENCY` | 12 | cheap calls in flight at once (1 = strictly sequential) |

### Scaling up: concurrency and reservations

The tick's paid calls run through a bounded-concurrency executor
([api/_lib/x402/ring-tick-exec.js](../api/_lib/x402/ring-tick-exec.js)): the
ring-settle carrier runs alone first, then the cheap calls fan out across
`X402_RING_TICK_CONCURRENCY` worker lanes, which is what lets a tick clear
~90+ calls inside its 60 s window. Budget safety holds under concurrency by
reservation: each launch reserves a worst-case slice ($0.02) of the remaining
tick budget and gets that slice as its own `remainingCap`, which `payX402`
enforces against the live 402 challenge, so concurrent calls can never
collectively overspend the tick cap. Unspent slices are refunded as calls
finish; a mid-tick SOL-floor signal stops further launches and drains what is
in flight. Fee math when scaling: fees track *transaction count*, not USDC
size — ~10,001 lamports per settle, so ~94 calls/min ≈ 135k tx/day ≈ 1.35
SOL/day. Raise `X402_RING_DAILY_FEE_BUDGET_LAMPORTS`, the daily cap, and payer
funding together (see the funding table in "Turning it on").

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

### The master revenue share: how the ring fuels the rest of the economy

Every treasury sweep routes a bounded cut (`X402_RING_MASTER_REVSHARE_BPS`,
default 20%) of its **surplus** to the **economy master wallet** instead of the
payer. That cut is
the funding root's only USDC inflow: `economy-fuel.js` converts it to SOL (a
self-swap, per-run and per-day capped) and `treasury-topup` distributes that SOL
to every engine below its floor: the circulation treasury that drives the
Money Pulse (tips, trades, agent-to-agent payments), the ring sponsor whose SOL
floor gates settlement, and the rest of `SOLANA_SIGNERS`. Without this leg the
master starves, the sponsor slips under its floor, settles 502, and the pulse
flat-lines (July 2026 incident). Both legs of a split sweep land in
`x402_ring_ledger` (`kind='sweep'` payer leg, `kind='revshare'` master leg,
same `tx_sig`) and the reconciler verifies the treasury's on-chain delta
against the *sum* of the legs, each recipient against its own row.

**The cut comes out of the surplus, never out of the float.** In a closed loop
the same principal laps payer to treasury to payer many times a day, so a share
taken on *every sweep* is not a share of revenue: it is a share of the working
capital, taken again on every lap, and it compounds the float to nothing.
Measured on mainnet with the cut raised to 35%: the payer's $54 float entering
2026-07-25 produced $268 of `revshare` rows over eight days and ended at $0.77,
at which point sweeps fell under the `MIN_REVSHARE_ATOMIC` dust floor and the leg
went quiet on its own. `splitSweep()` now nets the payer's shortfall against its
USDC floor (`X402_RING_PAYER_USDC_FLOOR_ATOMIC`, the same knob the wallet monitor
alerts on) out of the sweep first and shares only what is left, so the master is
paid out of genuine surplus and only once the loop it funds can actually run. A
payer already at its floor splits exactly as before. An unreadable payer balance
is treated as fully starved: skipping one revshare leg costs the master cents,
while skimming a payer that turns out to be empty stalls the whole ring.

Two scheduling guarantees keep the recirculation alive regardless of what else
the autonomous loop is doing:

1. **Reserved maintenance slots**: registry entries tagged `maintenance: true`
   (ring-rebalance, ring-float-topup, ring-pool-fund) are selected *outside*
   `X402_AUTONOMOUS_MAX_PER_TICK`, so a wave of failing high-priority paid
   entries can never starve them out of the rotation.
2. **Cooldown on failure**: a paid entry that errors now backs off for its full
   cooldown exactly like a success. Before this, a failing entry retried every
   tick forever, pinning all tick slots and generating thousands of junk
   settle-502 rows per day.

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

A **repeated, unchanged** skip reason is coalesced into one log row per
`X402_RING_TICK_SKIP_LOG_COALESCE_S` window (default 900s) instead of one per
minute. A reason that DIFFERS from the last one always writes immediately, and
the row that reopens a window carries `suppressed_ticks`, so the trail stays
complete and exact. Before this, an underfunded payer wrote 1,440 identical
`success=false, amount=0` rows a day: by 2026-08-06 the `Ring Tick` service held
22,865 of them, which read in the loop's own stats as "22,865 calls, zero
successes" when the tick had in fact never placed a call. Set the window to `0`
to restore a row per skipped tick.

**Never raise the settle price ahead of funding.** The defaults ($1.00 settle,
$1.10 tick cap, $50/day) are sized to the ring's real balances. Scaling to higher
daily volume is an env change (`X402_PRICE_RING_SETTLE`,
`X402_RING_TICK_CAP_ATOMIC`, `X402_RING_DAILY_CAP_ATOMIC`,
`X402_RING_SETTLE_EVERY_N_TICKS`) made **together with funding the payer wallet**
— in July 2026 a defaults-only lift to $35/settle put every tick into
back-pressure and flat-lined the visible ring economy for hours.

## Payer pool — many distinct payers, one reused set of wallets

By default the ring pays from a single seed wallet. The **payer pool** lets it pay
from hundreds-to-thousands of distinct, attributed wallets **at no extra per-settle
cost**, so the economy reads as many participants instead of one cron. It is
[api/_lib/x402/pool.js](../api/_lib/x402/pool.js) + the
[ring-pool-fund](../api/_lib/x402/pipelines/ring-pool-fund.js) pipeline, off by
default (`X402_RING_POOL_ENABLED`).

**Reused, not throwaway — the efficiency call.** A fresh wallet per call would add
a funding hop **and** a one-time USDC-ATA rent (~0.00204 SOL ≈ $0.15) on *every*
settle, roughly tripling the per-settle cost, and the wallets would still cluster
on-chain in one hop (they are all funded from the same float, the textbook cluster
signature). A **reused pool** pays that rent once per wallet, keeps each settle on
the 1-signature self-pay hot path (**1 tx/settle**, same as the single payer), and
rotates least-recently-used-first so a few hundred wallets produce effectively
unlimited distinct-payer sequences. 1,000 reused wallets rotating at the stock
cadence means each pays only a few times a day — genuinely distinct — for ~$150 of
one-time, reclaimable ATA rent.

**How it wires in.**

- **Storage.** Each wallet's key is secret-box-encrypted at rest (same scheme as
  custodial agent wallets, `WALLET_ENCRYPTION_KEY`) in `x402_ring_pool`. A
  500–1,000-wallet pool can't live in env vars, so the three role wallets stay in
  env and the pool lives in the DB.
- **Membership is automatic.** The generator mirrors every pool pubkey into
  `x402_ring_wallets(role='pool')`, so `ringAllowedAddresses()` (the controlled
  set), the on-chain leak scanner (classifies them **internal**), and the
  facilitator allowlist all pick them up with no extra wiring. Pool wallets stay
  labeled internal — they are dogfooding payers, never presented as organic demand.
- **Sweepback-safe by construction.** Pool wallets are deliberately **not** in
  [api/_lib/solana-signers.js](../api/_lib/solana-signers.js), so the excess-mode
  `treasury-sweepback` never enumerates them. This is the same class of bug that
  used to close the treasury's USDC ATA every run (see the box below) — it cannot
  recur across 1,000 pool wallets because they are never in the sweepback set.
- **Rotation.** `claimNextPayer()` atomically claims the least-recently-used enabled
  wallet (`FOR UPDATE SKIP LOCKED`, so concurrent ticks never collide), and the ring
  tick passes it per-settle via the shared driver's `buyerFor` hook. An empty or
  unavailable pool falls back to the seed payer, so the ring never stalls.
- **Funding.** `ring-pool-fund` (120s cooldown) reads all pool balances in
  **batches** (`getMultipleAccountsInfo`, ≤100/call) and tops up in **batched**
  transactions: SOL from the sponsor/master, USDC from the treasury, each below a
  floor up to a target, sweeping overfull wallets back. Funding 500–1,000 wallets is
  a handful of transactions per run, not one per wallet. Recirculation, not spend —
  it never consumes the daily cap. The pure decision is `planPoolFunding()`
  (unit-tested); the effectful execution batches and records each move to
  `x402_ring_ledger` as `kind='fund'`.

**Turning it on.**

```bash
# 1. Mint the pool (encrypts + stores keys, registers membership — no funding).
node scripts/x402-ring-pool-setup.mjs --grow --size=750

# 2. See exactly what to fund.
node scripts/x402-ring-pool-setup.mjs --funding-plan --size=750

# 3. Enable rotation + set the size on the service (config-only, pre-approved).
gcloud run services update three-ws-api --region us-central1 \
  --update-env-vars X402_RING_POOL_ENABLED=true,X402_RING_POOL_SIZE=750
```

**Env knobs:** `X402_RING_POOL_ENABLED` (off by default), `X402_RING_POOL_SIZE`
(target), `X402_RING_POOL_SOL_FLOOR_LAMPORTS` / `_TARGET_LAMPORTS` (default
0.008 / 0.012 SOL), `X402_RING_POOL_USDC_FLOOR_ATOMIC` / `_TARGET_ATOMIC` /
`_CEIL_ATOMIC` (default $0.50 / $2 / $4), `X402_RING_POOL_FUND_MAX_PER_RUN`
(default 60).

> ### Fixed 2026-07-17 — the treasury-sweepback rent churn
>
> The ring treasury (`wwwww…ccrU`, `X402_PAY_TO_SOLANA`) is the **same physical
> wallet** as the `pump-x402-launcher` signer (`PUMP_X402_LAUNCHER_SECRET_KEY_B64`
> → secret `wallet-x402-treasury-b64`). That registry entry lacked `holdsTokens`,
> so the excess-mode `treasury-sweepback` consolidated the treasury's USDC up to
> the economy master **and closed its USDC ATA every run**. Every following ring
> settle then had to recreate the ATA at **2,039,280 lamports** of rent — which
> dragged the measured per-settle fee to ~570,000 lamports (114× the 5,000-lamport
> self-pay floor) and quietly drained the closed loop's float into the master (why
> `sweeps=0` on the rebalancer: the treasury was emptied before it could
> recirculate). The fix is one line — `holdsTokens: true` on that registry entry —
> so excess-mode sweepback never touches the ring float again; only an explicit
> drain still consolidates it. Pair it with `X402_RING_SELF_PAY=true` (1 signature,
> not 2) and the per-settle fee returns to the ~5,000-lamport floor.

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

## Watching it

The ring's scoreboard is the JSON read model at
[/api/x402-ring](../api/x402-ring.js): settlement counts and gross
volume, live wallet balances with the sponsor's SOL floor, fee burn vs
volume, and the most recent settles with their signatures, all composed
from real chain and DB reads. The former in-app operator dashboard was
removed with the admin panel; watch the ring from a shell instead:

```bash
curl -s "$APP_ORIGIN/api/x402-ring?period=24h" | jq '.settlements, .fees, .wallets'
```

A recent settle in `.recent` is the heartbeat: if the newest entry is
more than a few minutes old the per-minute tick has stalled and the
activation runbook above is the fix.

## Related

- [STRUCTURE.md](../STRUCTURE.md) — surface map
- [api/_lib/x402/ring-allowlist.js](../api/_lib/x402/ring-allowlist.js) — the
  controlled-wallet set + spend invariants
- [api/cron/x402-ring-leak-scan.js](../api/cron/x402-ring-leak-scan.js) — the
  on-chain leak scanner
