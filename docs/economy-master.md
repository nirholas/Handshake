# Economy funding root (the master wallet)

The economy funding root is **one master wallet that funds every other Solana
engine on the platform** and does nothing else. It never trades, launches, tips,
snipes, or settles a payment — its only on-chain action is a native SOL transfer
that tops up an engine signer when that signer drops below its floor. This is the
"masters fund engines, engines do the work" model applied platform-wide.

> Source: [`api/_lib/economy-master.js`](../api/_lib/economy-master.js) (the
> guard logic + sweep), cron entry
> [`api/cron/treasury-topup.js`](../api/cron/treasury-topup.js), registry
> [`api/_lib/solana-signers.js`](../api/_lib/solana-signers.js) — the registry is
> the source of truth for every engine signer and its funding floor.

**Address (mainnet vanity):** `WwwuGbqHrwF5RG89KhUbmRWEvjnRH9k5kVM5p7T3WwW`

The address is case-sensitive base58 — the leading character is a **capital `W`**.
A lowercase `wwwu…` is a *different, empty* keypair; the `loadEconomyMaster()`
pubkey guard exists precisely so a mis-cased or mis-pasted key can never load and
drain the wrong wallet.

---

## How it works

1. A single master wallet (funded by the operator) is the root of the tree.
2. Every 30 minutes the `treasury-topup` cron reads the on-chain SOL balance of
   every **configured, mainnet** engine signer in the `SOLANA_SIGNERS` registry.
3. For each signer below its `minSol` floor, it computes a top-up to bring it up
   to `refillTo` (default `minSol × 3`), subject to the guards below.
4. It transfers the planned SOL from the master to each engine, fee-minimized,
   and emits an ops alert per top-up (and one if the master itself is too drained
   to cover a real deficit — the one condition a human must act on).
5. With `ECONOMY_MASTER_SECRET_BASE58` unset the whole thing is **inert**:
   `loadEconomyMaster()` returns `null`, the sweep is a no-op, and the existing
   `relayer-balance-check` cron keeps alerting. Shipping it changes nothing until
   the operator funds the master and installs the key.

## Funder-only, by construction

The master is never a *target* of a top-up — it funds the others, not itself
(`isMaster: true` in the registry excludes it, and the sweep's allowlist rejects
its own pubkey as `is_master`). It holds no product logic: it cannot call a DEX,
a pump.fun program, or an x402 settlement. If you need SOL to *do* something, that
belongs in an engine signer the master funds — not in the master.

## The guards (every guard is enforced on every sweep)

| Guard | Env | Default | What it bounds |
|---|---|---|---|
| Reserve floor | `ECONOMY_MASTER_RESERVE_SOL` | `1` | Never spend the master below this — its own working reserve + rent + fees. An on-chain read, so it holds even with no database. |
| Per-engine cap | `ECONOMY_MASTER_PER_TOPUP_MAX_SOL` | `0.5` | Most SOL moved to any single engine in one sweep. |
| Per-run cap | `ECONOMY_MASTER_RUN_CAP_SOL` | `2` | Most SOL moved across all engines in one sweep. Neediest engine funded first, so a tight cap protects the most-drained flow. |
| Dust skip | — | `0.005` | Skip a top-up smaller than this to avoid fee churn. |
| Pubkey match | `ECONOMY_MASTER_ADDRESS` | the address above | The installed secret must derive to the expected pubkey or `loadEconomyMaster()` throws `master_mismatch` — a mis-paste never silently drains a different wallet. |

`planTopUps()` is pure (no RPC), so all of the above are unit-tested in
[`tests/economy-master.test.js`](../tests/economy-master.test.js) without a key.

## The leak invariant (no SOL leaves the owner-controlled set)

SOL can **only** move from the master to a wallet the platform holds the key for.
This is enforced twice:

1. **The cron** builds its target list solely from `SOLANA_SIGNERS` — it never
   passes an arbitrary address.
2. **The sweep** (`filterToRegistry`) independently resolves the registry and
   rejects any target whose pubkey is not a resolved registry signer, and rejects
   the master's own pubkey. An off-registry target is refused and ops-alerted;
   no SOL moves. So even a buggy or tampered caller cannot route funds out of the
   registry.

There is **no charity path and no user-payout path** on the master. (The
per-merchant "charity split" you may see in the x402 checkout code is a *buyer*-
funded donation on a merchant's own sale — it never touches this wallet.)

## Sweepback: the return leg (consolidating balances to the root)

Topup is the outbound leg; **sweepback**
([`api/_lib/economy-sweepback.js`](../api/_lib/economy-sweepback.js), cron
[`/api/cron/treasury-sweepback`](../api/cron/treasury-sweepback.js), every 6 h at
:41) is the return leg. It walks the same registry and brings surplus back, so
every lamport cycles master → engines → work → master:

- **Excess mode (the schedule).** Skims only SOL *above* each signer's operating
  float — the same `refillTo` the topup refills to, so the two crons never
  oscillate — and consolidates stray token balances from signers that don't
  operationally hold tokens. Signers flagged `holdsTokens` in the registry
  (buyback USDC revenue, payout floats, the NFT collection authority) keep their
  token balances untouched.
- **Drain mode (on demand).** `POST /api/cron/treasury-sweepback?mode=drain&confirm=drain`
  is the full-consolidation lever: every token balance transferred, every emptied
  token account closed (rent refunds land on the master too), then all SOL minus
  0.001 SOL headroom (the account's rent-exempt minimum plus fees — the runtime
  rejects a transfer that would leave a wallet below rent exemption). Engines are
  left unfunded until the next topup — use it to decommission the fleet or
  recover everything to the root in one call.

The destination lock is the mirror of the topup allowlist: the only recipient in
the module is the `ECONOMY_MASTER_ADDRESS` constant — not a parameter — so no
caller, however buggy or hostile, can consolidate funds anywhere but the master.
Every movement is booked onto the same hash-chained ledger as `inflow` /
`inflow_token` rows, and a `sweepback` heartbeat row proves the cycle ran even
when there was nothing to collect. Dust guard: a sweep below
`ECONOMY_SWEEPBACK_MIN_SOL` (default 0.01 SOL) is skipped so fees never exceed
the return.

## Fuel: refilling the root from revenue

Topup and sweepback only move SOL that already exists in the fleet. But the
circulation engine is a **closed SOL loop** — agents fund each other and trade
among themselves, and every tick leaks a little SOL to Solana network and DEX
fees. A loop that only leaks eventually drains to zero no matter how the two crons
shuffle the remaining SOL, and when it hits zero the Money Pulse
([`/pulse`](../pages/pulse.html)) goes quiet. Historically the only cure was a
human moving SOL in.

When the master can't cover the engines' real deficit, the topup cron self-heals
in two automatic steps before it ever pages a human, in cheapest-first order:

**Step 1: reclaim idle SOL (free).** `reclaimIdleSol`
([`api/_lib/economy-sweepback.js`](../api/_lib/economy-sweepback.js)) pulls SOL
sitting **above each engine's operating floor** (`minSol`, not the topup
`refillTo`) back to the master, SOL only. This is the automated form of the manual
"drain the fleet to refund the feed" recovery: SOL trapped in an over-provisioned
engine (a launcher floored for bursts that isn't launching, say) flows to where
the Money Pulse needs it. It is **non-oscillating by construction** (`reclaimableSol`,
unit-tested): it leaves every engine at `minSol` plus a buffer, and the topup only
funds engines strictly *below* `minSol`, so a reclaimed engine is never
re-funded and the two crons can't ping-pong. The feed sink (circulation-treasury)
is exempt, and the destination is the same hard-locked `ECONOMY_MASTER_ADDRESS`.

**Step 2: refuel from revenue.** If reclaim doesn't close the gap, **fuel**
([`api/_lib/economy-fuel.js`](../api/_lib/economy-fuel.js)) converts a small,
bounded slice of the master's **own idle USDC revenue** into native SOL through a
real Jupiter route, then lets the topup distribute the proceeds.

Safe by construction, in the same spirit as the topup allowlist and the sweepback
destination lock:

- **Self-directed.** The master swaps *its own* USDC for *its own* SOL. There is
  no recipient parameter — funds can't go anywhere but from one asset the root
  holds into another. It is the least-privileged possible money move.
- **Only on a genuine shortage.** No-op unless the master's spendable SOL falls
  short of the pending run's deficit by at least `ECONOMY_FUEL_MIN_GAP_SOL`.
- **Triple-bounded.** A per-swap cap (`ECONOMY_FUEL_PER_RUN_USDC`, default $25), a
  per-UTC-day cap (`ECONOMY_FUEL_DAILY_USDC`, default $100), and a USDC keep-floor
  (`ECONOMY_FUEL_USDC_KEEP`) the swap never spends below. A Jupiter route with
  price impact above `ECONOMY_FUEL_MAX_IMPACT_PCT` (default 3%) is rejected, not
  executed.
- **Booked.** Every swap lands in `economy_fuel_swaps` (which drives the daily
  cap) and fires an ops alert. When fuel *did* act, the "master could not refill"
  page is suppressed — the shortage is being handled autonomously; the next tick
  distributes the freshly-bought SOL.

The swap confirms through the platform's HTTP-polling confirmer
([`api/_lib/solana/confirm.js`](../api/_lib/solana/confirm.js)) bound to the
transaction's own blockhash, and a landed-but-reverted swap throws rather than
being booked. A per-swap cooldown (`ECONOMY_FUEL_COOLDOWN_S`) plus the on-chain
daily-cap read together stop two overlapping topup ticks from double-swapping.

Set `ECONOMY_FUEL_ENABLED=0` to turn it off entirely (the fleet then falls back to
the "fund the master" ops alert). The decision/sizing math is a pure function
(`planRefuel`) covered by [`tests/economy-fuel.test.js`](../tests/economy-fuel.test.js).
Live fuel state (today's spend against the cap, recent swaps, quarantined agents)
is exposed on [`/api/admin/circulation-health`](../api/admin/circulation-health.js)
alongside the circulation rails. The table is defined by migration
`20260717230000_economy_fuel_swaps.sql` (and created lazily as a safety net).

## Lowest fees

Every transfer routes through `submitProtected` with `tipMode: 'off'` — **no Jito
tip**, just a data-driven priority fee floored at 1000 µLamports/CU (see
[`api/_lib/execution-engine.js`](../api/_lib/execution-engine.js)). A single
top-up costs roughly 0.000005–0.00001 SOL. The fee escalates only on retry under
congestion, clamped to a hard ceiling.

## Configuration

| Env | Required | Meaning |
|---|---|---|
| `ECONOMY_MASTER_SECRET_BASE58` | yes | The master keypair (base58 of 64 raw bytes). Unset ⇒ the funding root is inert. Store it as a secret on the Cloud Run service (or your host's secret store), never plaintext; keep your own offline copy since secret values are unreadable after they are written. |
| `ECONOMY_MASTER_ADDRESS` | no | Override the expected pubkey if the master is ever rotated. Defaults to the address above. |
| `ECONOMY_MASTER_RESERVE_SOL` / `_PER_TOPUP_MAX_SOL` / `_RUN_CAP_SOL` | no | Guard caps (see table). |
| `ECONOMY_FUEL_ENABLED` | no | `0` disables the USDC→SOL auto-refuel (default on). |
| `ECONOMY_FUEL_PER_RUN_USDC` / `_DAILY_USDC` | no | Fuel caps: max USDC per swap (default 25) and per UTC day (default 100). |
| `ECONOMY_FUEL_USDC_KEEP` | no | USDC the refuel never spends below (revenue reserve). Default 0. |
| `ECONOMY_FUEL_MIN_GAP_SOL` / `_TARGET_SOL` | no | Only refuel when the SOL gap is at least this (default 0.1); buy toward this spendable-SOL buffer (default 1.0). |
| `ECONOMY_FUEL_MAX_IMPACT_PCT` / `_SLIPPAGE_BPS` | no | Reject a route above this price impact (default 3%); swap slippage (default 100 bps). |
| `ECONOMY_FUEL_COOLDOWN_S` | no | Minimum seconds between fuel swaps (default 90), a belt against a double-swap when two topup ticks overlap. |
| `CRON_SECRET` | yes | Bearer auth for the `treasury-topup` cron (shared with every other cron; Cloud Scheduler sends it). |
| `SOLANA_RPC_URL` | no | Mainnet RPC (defaults to `api.mainnet-beta`). |

## Verify it's working

```bash
# Balances of every registry signer (derives pubkeys, never prints secrets):
node scripts/check-relayer-balances.mjs

# Exercise the sweep against prod (real cron; safe — only funds registry wallets
# below floor, bounded by the reserve/per-run caps). Returns the plan as JSON:
curl -s -H "Authorization: Bearer $CRON_SECRET" https://three.ws/api/cron/treasury-topup | jq
```

The JSON response reports `configured`, `master_sol`, `funded`, `failed`,
`skipped`, `rejected`, and `spent_sol`. A non-empty `rejected` array means an
off-registry target reached the sweep and was blocked — investigate the caller.

If the Cloud Scheduler job never fires, the
[economy heartbeat](economy-heartbeat.md) dispatcher (and any external HTTP cron
pointed at `/api/cron/economy-tick`) keeps it — and every other cron — ticking.

## Audit, accounting & breach monitoring

This is real money, so every movement is recorded to a durable, tamper-evident
book and independently reconciled against the chain. Three moving parts:

### 1. The ledger — the financial book of record

Every sweep appends a hash-chained batch of rows to the `economy_master_ledger`
table via [`api/_lib/economy-ledger.js`](../api/_lib/economy-ledger.js):

- one **`transfer`** row per SOL movement — the engine it funded, the target
  pubkey, the amount, the confirmed **tx signature**, the **running balance**
  after the move, and the **USD value at the instant of the transfer** (SOL/USD is
  captured at write time via [`sol-price.js`](../api/_lib/sol-price.js), so an
  accountant reads the dollar value as of the transfer, not as of report time);
- a **`failed`** row per attempted transfer that errored, with the reason;
- a **`blocked`** row per target the allowlist refused (`not_in_registry` /
  `is_master`) — the on-chain evidence that the leak guard fired;
- a **`sweep`** heartbeat row every run, even a no-op, so there is a continuous
  "we checked this wallet every 30 minutes" trail.

**Tamper-evidence.** Each row carries `prev_hash` + `entry_hash`, a SHA-256 hash
chain: `entry_hash = sha256(seq | ts | master | event | target | lamports |
signature | resulting-balance | prev_hash)`. The head commits the entire history,
so editing or deleting *any* historical row (to hide a transfer, change an amount,
or swap a recipient) breaks the chain from that row forward. The break is
detectable and located to the exact `seq`. Schema:
[`migrations/20260702010000_economy_master_ledger.sql`](../api/_lib/migrations/20260702010000_economy_master_ledger.sql).

### 2. The reconcile / breach monitor

[`api/cron/economy-reconcile.js`](../api/cron/economy-reconcile.js) runs every 30
minutes and answers the three questions an auditor, an accountant, and an incident
responder each ask:

| Check | What it does | On failure |
|---|---|---|
| **Tamper** | `verifyChain()` recomputes the whole hash chain | 🚨 CRITICAL ops alert; row in `payment_reconciliation` (`source=economy_master_chain`) |
| **Breach** | Pulls the master's real on-chain history and flags any **outbound debit whose signature is not in the ledger** | 🚨 CRITICAL alert — *unrecorded SOL leaving the master is the key-compromise signal*; verdict `chain_status=unrecorded_outbound` |
| **Integrity** | Confirms every recorded `transfer` signature exists and succeeded on-chain | verdict `missing_onchain` / `failed_onchain` — a fabricated or lost record |
| **Reserve** | Master balance below `ECONOMY_MASTER_RESERVE_SOL` | ⛽ fund-safety alert |

Non-reconciled findings are upserted into the **shared** `payment_reconciliation`
table (the same finance-integrity surface x402 revenue reconciliation writes to),
so `WHERE reconciled = false` on the ops board shows master discrepancies next to
everything else. The monitor is **read-only on-chain** — it never moves funds.

### 3. Accounting export

[`scripts/economy-ledger-export.mjs`](../scripts/economy-ledger-export.mjs) emits
the ledger as CSV (default) or JSON with the running balance and USD valuation, and
can re-verify the chain first:

```bash
# CSV of July, into a file for the accountant:
node scripts/economy-ledger-export.mjs --from 2026-07-01 --to 2026-07-31 > july.csv

# JSON with window totals (SOL out + USD out):
node scripts/economy-ledger-export.mjs --event transfer --format json

# Verify tamper-evidence before exporting (non-zero exit if the chain is broken):
node scripts/economy-ledger-export.mjs --verify
```

Needs `DATABASE_URL`. Never prints secrets.

### Breach-response runbook

**On a `🚨 Unrecorded SOL leaving the economy master` alert:**
1. Open the linked Solscan tx. If it is *not* a `treasury-topup` transfer to a
   registry engine, treat the key as compromised.
2. **Rotate immediately** — generate a new master keypair, set
   `ECONOMY_MASTER_SECRET_BASE58` + `ECONOMY_MASTER_ADDRESS` to it, and redeploy so
   the compromised key is no longer loaded.
3. **Sweep remaining funds** from the old master to the new one (or cold storage)
   before the attacker drains more.
4. Reconcile: the ledger's last good `entry_hash` and the on-chain history bound
   exactly what was authorized vs. stolen.

**On a `🚨 Economy ledger tamper detected` alert:**
1. Do not trust the DB books until resolved — the chain says a row was altered.
2. Export with `--verify` to get the exact broken `seq`.
3. Compare the on-chain transaction history against the ledger around that `seq`
   to reconstruct the true record; restore from backup / re-derive from chain.

### Retention

`economy_master_ledger` is append-only and **must not** be pruned by the
`db-retention` cron — it is the accounting record. It is tiny (a few dozen rows per
day) so it does not contribute to storage pressure. The chain head may be anchored
on-chain (same mechanism as [`ledger-anchor.js`](../api/_lib/ledger-anchor.js)) for
a third-party-verifiable timestamp of the books.

## Known gaps & runbook (as of 2026-07-02)

The master is configured and funded, but the tree it feeds is only partly wired:

- **Only two registry signers resolve in prod** — the master itself and the NFT
  `collection-authority`. The other ten engines (launcher, buyback, treasuries,
  club tips, a2a-payer, x402 launcher) have no secret set, so the sweep has almost
  nothing to fund. Set each engine's secret to bring it online (see the runbook).
- **Solana agent-to-agent settlement is down.** The `a2a-payer` signer reads
  `A2A_PAYER_SOLANA_SECRET`; prod only has `A2A_PAYER_PRIVATE_KEY` (the EVM payer).
  [`api/agents/a2a-call.js`](../api/agents/a2a-call.js) throws *"autonomous Solana
  payer wallet is not configured"* on every Solana mandate. Fix: set
  `A2A_PAYER_SOLANA_SECRET` to a base58 Solana key.
- **The x402 spend/gas wallets are not in the registry.** `X402_FEE_PAYER_SOLANA`,
  `X402_AGENT_SOLANA_SECRET_BASE58`, and `X402_SEED_SOLANA_SECRET_BASE58` run the
  x402 agent-to-agent economy but are not `SOLANA_SIGNERS` entries, so the master
  does not top them up. Whether it *should* is an operator call — x402 gas is
  largely PayAI-sponsored (see [x402 ring economy](x402-ring-economy.md) /
  [autonomous x402](autonomous-x402.md)), so those wallets may intentionally not
  need funding from this master. To have the master keep them fueled, add them to
  the registry with a floor.

## Related

- [`api/_lib/solana-signers.js`](../api/_lib/solana-signers.js) — every
  engine signer, its encoding, and how to fund/consolidate the economy wallets.
- [Circulation engine](circulation-engine.md) — the autonomous agent-to-agent
  activity loop the funded engines drive.
- [x402 ring economy](x402-ring-economy.md) — closed-loop in-house x402 settlement.
