# Economy funding root (the master wallet)

The economy funding root is **one master wallet that funds every other Solana
engine on the platform** and does nothing else. It never launches, tips, snipes,
or settles a payment. Its on-chain actions are all funding moves: a native SOL
transfer that tops up an engine signer when that signer drops below its floor,
plus the two bounded self-refill legs described under "Fuel" below (swapping its
own idle USDC revenue into SOL, and direct USDC top-ups to the two USDC payers).
This is the "masters fund engines, engines do the work" model applied
platform-wide.

> Source: [`api/_lib/economy-master.js`](../api/_lib/economy-master.js) (the
> guard logic + sweep), cron entry
> [`api/cron/treasury-topup.js`](../api/cron/treasury-topup.js), registry
> [`api/_lib/solana-signers.js`](../api/_lib/solana-signers.js) — the registry is
> the source of truth for every engine signer and its funding floor.
>
> Rotating this wallet (or any other economy signer) goes through the wallet
> registry: [`docs/ops/economy-wallet-rotation.md`](ops/economy-wallet-rotation.md),
> which keeps a permanent log of every address each role has ever held.

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
| Reserve floor | `ECONOMY_MASTER_RESERVE_SOL` | `0.02` | Never spend the master below this: its own rent-exemption plus fee headroom. An on-chain read, so it holds even with no database. When the master is also the x402 sponsor fee wallet (`X402_FEE_PAYER_SOLANA` points at it), the sweep floor rises to the sponsor settle floor (0.02 SOL) plus `ECONOMY_MASTER_SPONSOR_HEADROOM_SOL` (default `0.03`), so topping up engines can never starve settlement (`sweepFloorSol()`). |
| Per-engine cap | `ECONOMY_MASTER_PER_TOPUP_MAX_SOL` | `0.5` | Most SOL moved to any single engine in one sweep. |
| Per-run cap | `ECONOMY_MASTER_RUN_CAP_SOL` | `2` | Most SOL moved across all engines in one sweep. Settle-critical engines are funded first, then the neediest, so a tight cap protects the payment rail and then the most-drained flow. |
| Dust skip | — | `0.005` | Skip a top-up smaller than this to avoid fee churn. |
| Settle-critical first | `settleCritical` on the signer spec | x402 ring sponsor + payer | A wallet the x402 facilitator pays fees from is funded before any float or feed wallet, regardless of whose deficit is larger. Under its floor the facilitator refuses **every** settle, so the rail's claim on a thin run outranks a bigger number elsewhere. Measured 2026-09-04: without this, a 0.1, 0.2 or 0.5 SOL top-up went entirely to the relayer/treasury bundle (deficit 0.98 SOL) and left the ring payer at 0.00125 SOL, under its 0.002 hard floor, so settlement stayed dead until roughly 1 SOL landed. |
| Pubkey match | `ECONOMY_MASTER_ADDRESS` | the address above | The installed secret must derive to the expected pubkey or `loadEconomyMaster()` throws `master_mismatch` — a mis-paste never silently drains a different wallet. |

`planTopUps()` is pure (no RPC), so all of the above are unit-tested in
[`tests/economy-master.test.js`](../tests/economy-master.test.js) without a key.

Each skipped engine says which bound stopped it, and the two that look alike
have opposite fixes:

| `skipped[].reason` | What it means | The fix |
|---|---|---|
| `below_dust_threshold` | The engine is under floor by less than 0.005 SOL. | Nothing. Fee churn avoided on purpose. |
| `run_cap_reached` | Earlier engines in this run consumed the per-run budget. | Nothing, or raise `ECONOMY_MASTER_RUN_CAP_SOL`. The next run funds the rest. |
| `master_insufficient_spendable` | The master itself has nothing above its sweep floor. No cap was involved. | Fund the master. No knob changes this. |

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
- **Dry run (either mode).** Append `?dry=1` to plan without moving anything:
  the same balance reads, alias merging, and floor math run, then every entry
  comes back flagged `dryRun` with a `null` signature. Nothing is signed or
  broadcast, no ledger row is written, and no alert fires. A dry drain does not
  need the `confirm=drain` token, because a preview cannot empty anything:

  ```bash
  # what would the scheduled 6-hourly sweep consolidate right now?
  curl -s -H "Authorization: Bearer $CRON_SECRET" \
    'https://three.ws/api/cron/treasury-sweepback?dry=1' | jq .would_sweep_sol

  # and what would a full drain pull back, tokens included?
  curl -s -H "Authorization: Bearer $CRON_SECRET" \
    'https://three.ws/api/cron/treasury-sweepback?mode=drain&dry=1' | jq
  ```

  This is the mirror of the topup's own `?dry=1`, and it is what makes the
  return leg inspectable (and testable, see
  [`tests/cron-sweepback-dryrun.test.js`](../tests/cron-sweepback-dryrun.test.js))
  without moving real mainnet SOL.

The destination lock is the mirror of the topup allowlist: the only recipient in
the module is the `ECONOMY_MASTER_ADDRESS` constant — not a parameter — so no
caller, however buggy or hostile, can consolidate funds anywhere but the master.
Every movement is booked onto the same hash-chained ledger as `inflow` /
`inflow_token` rows, and a `sweepback` heartbeat row proves the cycle ran even
when there was nothing to collect. Dust guard: a sweep below
`ECONOMY_SWEEPBACK_MIN_SOL` (default 0.01 SOL) is skipped so fees never exceed
the return.

## Agent-wallet reclaim: the other half of the fleet's SOL

Sweepback and `reclaimIdleSol` both walk the **`SOLANA_SIGNERS` registry** — the
fourteen engine wallets. That is not where most of the platform's SOL lives.
`fundAgentForLaunch` ([`api/_lib/launcher-funding.js`](../api/_lib/launcher-funding.js))
moves SOL master → **agent custody wallet** one way, and nothing ever moved it
back: snipes recycle ~97 % of their capital, but the proceeds settle into the
*agent's* wallet, so every cycle ratcheted SOL further from the engines.

A full fleet audit on 2026-07-28 measured the result: **7.2 of the fleet's
7.53 SOL sat in agent wallets while the eight engines held 0.31**, the master was
25,461 lamports under its 0.004 SOL settle floor, and every x402 settle returned
`fee_wallet_below_floor`. Nothing had leaked — fee burn over the whole week was
0.141 SOL and lifetime sniper P&L was −0.15 SOL. The capital was simply somewhere
the return path could not reach.

`reclaimIdleAgentSol()` closes that loop. It runs inside
[`/api/cron/treasury-topup`](../api/cron/treasury-topup.js) as self-healing step
1b, only when there is a real deficit that the engine reclaim did not already
cover, and reports under `agent_reclaim` in the cron's JSON.

**The ownership boundary is the load-bearing guard.** Only wallets belonging to
platform-owned agents are ever eligible:

| Owner account | Swept? |
| --- | --- |
| `three-ws@users.three.ws.local` (the house account) | yes |
| `*@agents.three.ws` (platform-created circulation bots) | yes |
| Any signup account, wallet-auth account, or other email | **never** |

That gate is enforced twice — once in SQL so a customer's agent never leaves the
database, and again in `planAgentReclaim()` via `isPlatformOwnedAgent()` so a
later edit to the query cannot widen the blast radius on its own. The destination
is the same `ECONOMY_MASTER_ADDRESS` module constant every other sweep uses, never
a parameter.

Three more guards bound what it takes:

- **Working capital is protected.** An agent with an *enabled* sniper strategy
  keeps `AGENT_RECLAIM_TRADE_MULTIPLE` (default 2) times its own configured
  per-trade size **plus `MIN_OPERATIONAL_WALLET_SOL`** — everything one entry
  costs besides the buy itself: the token ATA's rent, fee and tip headroom, and
  the round-trip the rug/honeypot firewall simulates from that same wallet. The
  multiple alone was not enough: an arm sized at 0.002 SOL/trade kept a 0.004 SOL
  floor, which cannot pay for a simulation, so every entry aborted at the safety
  check and the arm looked funded on every dashboard while being unable to trade.
  An agent with no enabled strategy keeps only `AGENT_RECLAIM_IDLE_FLOOR_SOL`
  (default 0.005) of transaction-fee headroom.
- **Committed capital is untouchable.** Any agent holding an `open` or `closing`
  sniper position is skipped outright (`capital_committed`).
- **Bounded and non-oscillating.** At most `AGENT_RECLAIM_MAX_WALLETS` (default
  40) wallets per run, biggest balances first, and each sweep is sized by the same
  `reclaimableSol()` invariant the engine reclaim uses.

### The anti-oscillation invariant (learned the expensive way)

The bullet above used to claim reclaim could not fight a topup. That was true of
the **engine** topup, which reads the same float this module sweeps to. It was
not true of the **sniper auto-funder**
([`workers/agent-sniper/auto-funder.js`](../workers/agent-sniper/auto-funder.js)),
a different cron in a different Cloud Run service that refills opted-in agent
wallets. Its target sat *above* the reclaim floor, and neither side read the
other's number.

The result was a pure oscillation, visible on-chain on 2026-07-28 between 19:08
and 19:27: the funder pushed 0.24 SOL into two arms across six top-ups, the
reclaim swept each one back to the economy master minutes later, and the arms
never held a balance long enough to place a trade. It stopped only when the
funding master ran dry at 0.0157 SOL.

Both sides now read one module,
[`api/_lib/agent-funding-policy.js`](../api/_lib/agent-funding-policy.js), which
states the rule:

> **A reclaim floor must never sit below the funding target of the same wallet.**

`antiOscillationFloorSol()` returns that target for any wallet the funder manages
(`auto_fund_enabled = true`), and `agentReclaimFloorSol()` takes it as a hard
minimum, including for a *disabled* strategy, because the funder's opt-in flag,
not `enabled`, is what decides whether a refill is coming.

Both funding levels are **per-arm**, not flat, and come from the same module:

| Level | Value | Why |
| --- | --- | --- |
| `fundTriggerSol(agent)` | `max(SNIPER_AUTO_FUND_MIN_SOL, MIN_OPERATIONAL_WALLET_SOL + per-trade size)` | The old flat 0.02 trigger called an arm sized at 0.13 SOL/trade "healthy" while it sat on 0.035 SOL and could not place a single trade. |
| `fundTargetSol(agent)` | trigger + the same hysteresis band the flat pair had (default 0.03 SOL) | A bigger arm is refilled to a level it can trade from, without being refilled any *more often*. |

To see the fleet's real position — per-arm balance, what each one needs to place
its next trade, the deficit, and why any arm is not trading:

```bash
node scripts/sniper-fleet-restore.mjs            # report only, nothing moves
node scripts/sniper-fleet-restore.mjs --apply --yes   # top up the fundable arms
```

Sweeps below `ECONOMY_SWEEPBACK_MIN_SOL` (0.01 SOL) are skipped as dust.

To see what a run would do without moving anything:

```bash
curl -s -H "Authorization: Bearer $CRON_SECRET" \
  'https://three.ws/api/cron/treasury-topup?dry=1' | jq .agent_reclaim
```

To audit where the fleet's SOL actually is at any time, including the split
between platform and customer wallets:

```bash
node scripts/audit-wallet-flows.mjs                     # balances + reconciliation
node scripts/audit-wallet-flows.mjs --trace <pubkey>    # per-wallet flow trace
```

## Fuel: refilling the root from revenue

Topup and sweepback only move SOL that already exists in the fleet. But the
circulation engine is a **closed SOL loop** — agents fund each other and trade
among themselves, and every tick leaks a little SOL to Solana network and DEX
fees. A loop that only leaks eventually drains to zero no matter how the two crons
shuffle the remaining SOL, and when it hits zero the Money Pulse
([`/pulse`](../pages/pulse.html)) goes quiet. Historically the only cure was a
human moving SOL in.

When the master can't cover the real deficit, the topup cron self-heals in two
automatic steps before it ever pages a human, in cheapest-first order. The
deficit counts the engines under floor **plus the master's own shortfall**: the
master doubles as the x402 sponsor fee wallet, and below the sponsor SOL floor
(0.02) every autonomous settle fail-closes, but the master can never be a topup
target (it is the funding root), so without this term the self-healing never
fired for it and the economy stalled with the master a hair under the settle
floor (the July 2026 recurrences). The master's operating floor is
`ECONOMY_MASTER_RESERVE_SOL` plus `ECONOMY_MASTER_OPERATING_SOL` (default 0.15,
sized to clear the fuel step's minimum-gap trigger).

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
lives in the `economy_fuel_swaps` table; read it there or via the ops surfaces
(`/api/ops/money-health`). The table is defined by migration
`20260717230000_economy_fuel_swaps.sql` (and created lazily as a safety net).

**Step 3: top the USDC engines up directly.** Steps 1 and 2 keep **SOL** flowing,
but the two payers that do the platform's paid work — `x402-ring-payer` and
`a2a-payer` — *spend USDC*, and their only refill path was the rebalancer
swapping their **own** SOL for USDC on Jupiter. That path has a hole: a payer
holding neither spare SOL nor USDC cannot refill itself at all, however much
revenue the master is sitting on. On 2026-07-28 the ring payer ran at ~3 USDC
against a $10 floor and the a2a payer at 0.00, failing every `$10` ring-settle
leg with an SPL insufficient-funds error, while the master idled on 48 USDC one
hop away.

[`topUpUsdcEngines`](../api/_lib/economy-usdc-topup.js) closes it with a direct
master → payer USDC transfer: no swap, no slippage, one signature. Same guard
shape as the rest of the funding root:

- **Allowlisted.** Recipients come from `USDC_WALLETS` in
  [`api/_lib/economy-rebalance.js`](../api/_lib/economy-rebalance.js) — the same
  list the rebalancer's swap legs use, so the two refill paths can never disagree
  on who qualifies or at what floor. A role whose secret aliases to the master is
  skipped (it *is* the master).
- **Hysteresis, so it can't trickle.** A transfer arms only while a wallet is
  **below its floor**, and lifts it to `floor × ECONOMY_USDC_TOPUP_REFILL_MULTIPLE`
  (default 1.5×). A wallet between floor and target is left alone.
- **Triple-bounded.** Per transfer (`ECONOMY_USDC_TOPUP_PER_TRANSFER_USD`,
  default $15), per UTC day (`ECONOMY_USDC_TOPUP_DAILY_USD`, default $40), and a
  master keep-floor (`ECONOMY_USDC_TOPUP_MASTER_KEEP`, default $10) that leaves
  step 2 its own fuel. A cooldown (`ECONOMY_USDC_TOPUP_COOLDOWN_S`) bounds
  overlapping ticks.
- **Booked.** Every transfer lands in `economy_usdc_topups` (which drives the
  daily cap), mirrors to `audit_log` as `economy_usdc_topup`, and fires an ops
  alert.
- **Non-oscillating with sweepback.** Both recipients carry `holdsTokens` in the
  signer registry, so the token sweep treats their USDC as working capital
  instead of clawing each refill straight back on the next excess-mode run.

Preview exactly what the next tick would move, without signing anything:

```sh
node scripts/dry-usdc-topup.mjs
```

Set `ECONOMY_USDC_TOPUP_ENABLED=0` to disable. The sizing math is a pure function
(`planUsdcTopups`) covered by
[`tests/economy-usdc-topup.test.js`](../tests/economy-usdc-topup.test.js).

### Previewing the rebalancer safely

`?dry=1` returns the plan and signs nothing, whether or not
`ECONOMY_REBALANCE_ENABLED` is set:

```bash
curl -s -X POST -H "Authorization: Bearer $CRON_SECRET" \
  'https://three.ws/api/cron/economy-rebalance?dry=1' | jq '{mode, plan, skipped}'
```

`mode` reads `dry_run` and `armed` reports whether the cron would have executed.
Before 2026-09-04 the only path that did not sign was being **disarmed**, so on
production (armed) a `?dry=1` preview built, signed and submitted real swaps.

### Why the rebalancer alone was not enough

The rebalancer keeps each payer stocked in the asset it spends by swapping its
*own* holdings. When a self-pay wallet's total balance cannot satisfy **both** its
USDC floor and its fee-SOL target, its two legs fight: one run buys fee SOL with
USDC, the next sells that SOL back for USDC, forever. That ran 134 reversing
swaps and churned ~$900 of notional in 2.5 hours on 2026-07-28, paying two swap
fees and double slippage per round trip to end where it started.

Four invariants close it permanently, three of them in `planRebalance`:

1. **No opposing legs in one run** — the neediest leg wins; the other defers to
   the next run against fresh balances.
2. **The fee-SOL target is untouchable reserve on the `sol->usdc` leg.** Feeding
   the USDC floor out of SOL the wallet needs for fees just re-arms the opposite
   leg, so the target is held back and the two legs' arming conditions become
   mutually exclusive *across* runs, not just within one. The asymmetry is
   deliberate: `usdc->sol` may still draw USDC down to its reserve, because fee
   SOL is what keeps settles alive at all.

3. **One equilibrium when the wallet cannot afford both floors.** Invariants 1
   and 2 stop the churn, but on their own they stop *everything*: a wallet under
   its fee target can never buy USDC (invariant 2 holds the target back), and a
   wallet under the USDC reserve has nothing to sell, so both legs skip with
   `insufficient_sol_surplus` + `insufficient_usdc_surplus` on every run,
   forever. Mainnet 2026-07-29 to 2026-08-06: the x402 ring payer sat at 0.140
   SOL and $0.23 USDC against a 0.18 SOL target and a $12 USDC floor, the
   rebalancer executed **zero** swaps for eight days, and `insufficient_payer_usdc`
   climbed from 4 to ~2,900 a day while the payer held fee SOL it had no way to
   spend. `resolveSelfPayFloors()`
   ([`api/_lib/economy-rebalance.js`](../api/_lib/economy-rebalance.js)) breaks it:
   when a wallet's total value cannot cover its fee target **and** its USDC floor,
   BOTH legs aim at the bare `ECONOMY_REBALANCE_SOL_RESERVE` instead, so they
   converge on one equilibrium ("keep the fee reserve, hold the rest as USDC")
   rather than reversing each other. Above that total nothing changes: the legs
   use the fee target exactly as before.

   The same function also arms the `usdc->sol` rescue leg off that reserve rather
   than off the registry's `minSol`. `minSol` is the *treasury-topup* floor (how
   much SOL the master tries to keep on the wallet), not "sell working capital to
   buy gas": arming on it makes any wallet the master is behind on sell its USDC
   float for SOL it does not need, and with `SIGNER_MIN_SOL_X402_RING_PAYER` raised
   to 0.15 that leg was armed permanently. It is how the ring's float turned into
   SOL in the first place (2026-07-28: 66 `usdc->sol` swaps, $438 churned).

4. **A rescue the wallet cannot pay for is never planned.** A `usdc->sol` swap
   lands its output in a wSOL account the transaction itself creates, and the
   wallet funds that account's rent-exemption (1,855,569 lamports on mainnet)
   out of its own balance for the life of the transaction. A wallet holding less
   than that cannot buy the SOL it needs: the swap dies inside the ATA
   `CreateIdempotent` with system error `0x1` and nothing ever lands. Mainnet
   2026-09-04: the x402 ring payer held 1,253,408 lamports and 4.18 USDC it
   could not convert, and the rebalancer re-planned the same doomed leg every 30
   minutes, reporting a truncated `failed` that named neither the shortfall nor
   the fix. `planRebalance` now skips with
   `below_swap_rent:<have><<need>` instead, so the number an operator reads is
   the SOL that unlocks the wallet's own USDC. The guard is waived when the
   wallet already holds a wSOL account, where the rent is paid and the create is
   a no-op.

Step 4 is what makes those invariants affordable: a payer that is genuinely short
of both assets is now refilled from the root instead of being asked to
manufacture one asset out of the other. **Check `ECONOMY_USDC_TOPUP_ENABLED` is
not `0` before relying on it** as the escape hatch: with the topup off and the
rebalancer deadlocked there is no path back into USDC at all.

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
| `ECONOMY_MASTER_SPONSOR_HEADROOM_SOL` | no | Working headroom the sweep keeps on top of the x402 sponsor settle floor when the master doubles as the sponsor fee wallet. Default 0.03. |
| `ECONOMY_FUEL_ENABLED` | no | `0` disables the USDC→SOL auto-refuel (default on). |
| `ECONOMY_MASTER_OPERATING_SOL` | no | Working headroom above the reserve the master keeps for sponsor co-sign fees; its shortfall below reserve + this counts toward the self-heal deficit. Default 0.15. |
| `ECONOMY_FUEL_PER_RUN_USDC` / `_DAILY_USDC` | no | Fuel caps: max USDC per swap (default 25) and per UTC day (default 100). |
| `ECONOMY_FUEL_USDC_KEEP` | no | USDC the refuel never spends below (revenue reserve). Default 0. |
| `ECONOMY_FUEL_MIN_GAP_SOL` / `_TARGET_SOL` | no | Only refuel when the SOL gap is at least this (default 0.1); buy toward this spendable-SOL buffer (default 1.0). |
| `ECONOMY_FUEL_MAX_IMPACT_PCT` / `_SLIPPAGE_BPS` | no | Reject a route above this price impact (default 3%); swap slippage (default 100 bps). |
| `ECONOMY_FUEL_COOLDOWN_S` | no | Minimum seconds between fuel swaps (default 90), a belt against a double-swap when two topup ticks overlap. |
| `ECONOMY_USDC_TOPUP_ENABLED` | no | `0` disables the direct master→payer USDC refill (default on). |
| `ECONOMY_USDC_TOPUP_PER_TRANSFER_USD` / `_DAILY_USD` | no | USDC topup caps: max per transfer (default 15) and per UTC day (default 40). |
| `ECONOMY_USDC_TOPUP_MASTER_KEEP` | no | USDC the topup never spends the master below, so the SOL refuel keeps its own fuel. Default 10. |
| `ECONOMY_USDC_TOPUP_REFILL_MULTIPLE` | no | Lift a below-floor payer to `floor ×` this (default 1.5), so a refill buys runway instead of landing on the floor. |
| `ECONOMY_USDC_TOPUP_COOLDOWN_S` | no | Minimum seconds between money-moving topup runs (default 90). |
| `ECONOMY_REBALANCE_SOL_RESERVE` | no | SOL the rebalancer never swaps away from any wallet (default 0.03). Doubles as the constrained equilibrium and the `usdc->sol` rescue arming threshold for a self-pay wallet (see invariant 3), so it is the one knob that decides how much fee runway a starved payer keeps. |
| `CRON_SECRET` | yes | Bearer auth for the `treasury-topup` cron (shared with every other cron; Cloud Scheduler sends it). |
| `SOLANA_RPC_URL` | no | Mainnet RPC (defaults to `api.mainnet-beta`). |

## Verify it's working

```bash
# Balances of every registry signer (derives pubkeys, never prints secrets):
node scripts/check-relayer-balances.mjs

# Exercise the sweep against prod (real cron; safe — only funds registry wallets
# below floor, bounded by the reserve/per-run caps). Returns the plan as JSON:
curl -s -H "Authorization: Bearer $CRON_SECRET" https://three.ws/api/cron/treasury-topup | jq

# Preview the USDC leg alone (reads live balances, signs nothing):
node scripts/dry-usdc-topup.mjs
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

## Registry coverage & runbook (updated 2026-08-05)

The 2026-07-02 wiring gaps this section used to track are closed. Current state
of the tree the master feeds:

- **The registry defines the master plus fourteen engine signers** (relayers,
  launcher master, treasuries, marketplace payer, a2a payer, ring sponsor/payer,
  circulation treasury, NFT collection authority). An engine whose secret env is
  unset simply never resolves and is skipped by the sweep; set each engine's
  secret to bring it online, and override floors per signer with
  `SIGNER_MIN_SOL_<NAME>` / `SIGNER_REFILL_TO_SOL_<NAME>`.
- **The a2a payer accepts a fallback env.** The `a2a-payer` signer reads
  `A2A_PAYER_SOLANA_SECRET` and falls back to `A2A_PAYER_SOLANA_PRIVATE_KEY`, so
  either name brings Solana mandate settlement online.
- **The x402 ring wallets are registry entries.** `x402-ring-sponsor`
  (`X402_FEE_PAYER_SECRET_BASE58`, floor 0.03 SOL, kept a hair above the 0.02
  sponsor settle floor) and `x402-ring-payer` (`X402_SEED_SOLANA_SECRET_BASE58`,
  fallback `X402_AGENT_SOLANA_SECRET_BASE58`, floor 0.03 SOL, `holdsTokens` so
  sweepback leaves its USDC float alone) are topped up by this master like every
  other engine (see [x402 ring economy](x402-ring-economy.md) /
  [autonomous x402](autonomous-x402.md)).

## Related

- [`api/_lib/solana-signers.js`](../api/_lib/solana-signers.js) — every
  engine signer, its encoding, and how to fund/consolidate the economy wallets.
- [Circulation engine](circulation-engine.md) — the autonomous agent-to-agent
  activity loop the funded engines drive.
- [x402 ring economy](x402-ring-economy.md) — closed-loop in-house x402 settlement.
