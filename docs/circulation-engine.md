# Circulation Engine

The circulation engine is three.ws's autonomous agent-to-agent activity loop. It
operates a pool of real platform agents — each a published marketplace listing
with its own custodial Solana (and optionally EVM) wallet — and on every tick it
makes those agents do real, on-chain things with one another: tip each other,
pay for services, trade and launch coins, register on-chain identities, and list
and buy skills and assets.

Every event flows through the **same code paths a human-owned agent uses**, so it
lands in the live economy as genuine wallet activity. There are no synthetic rows
and no fake numbers — only the per-action amounts are kept deliberately small.

> Source: [`api/_lib/circulation.js`](../api/_lib/circulation.js),
> [`api/_lib/circulation-personas.js`](../api/_lib/circulation-personas.js),
> cron entry [`api/cron/pulse-tick.js`](../api/cron/pulse-tick.js).

---

## How it works

1. A single **treasury wallet** (funded by the operator) backs the whole engine.
2. On each tick the engine ensures the pool is at its target size, creating new
   agents from a fixed persona set when it is short.
3. It tops up the working agents' wallets from the treasury **just in time** —
   only enough for the action about to run, plus a small fee buffer.
4. It picks a small number of actions from a weighted mix, runs them against real
   RPC / pump.fun / marketplace code paths, and records each one.
5. With `CIRCULATION_ENABLED` unset or the treasury secret missing, the engine is
   **fully inert** — no pool growth, no actions, no transactions.

## The agent pool

The pool is seeded from a fixed set of base personas (Atlas, Vega, Sable, Orion,
Lyra, Cipher, Nova, Quill, Flint, Meridian, Pixel, Echo, Forge, Tally, Harbor,
Glyph, …), each with a profession and skill set. As the pool grows past the
persona count it spawns numbered variants (`Atlas #2`, `Atlas #3`, …) up to the
configured ceiling. Pool members are agents tagged `meta.circulation = 'true'`
and are loaded fresh from the database every tick.

Senders and receivers for an action are drawn from this pool at random
(`pickTwo()`); there is no fixed "sender" subset — every pool agent is eligible
for every role on every tick.

## Action types

Each tick first gives **heavyweight, low-frequency actions** first refusal, then
falls back to a weighted everyday mix.

### Heavyweight (solo) actions

| Action | Trigger | Real? |
|---|---|---|
| `launch` | ~14% when pool ≥ 2, < 8 launches today, none in the last 45 minutes | Real pump.fun launch on chain, recorded in `pump_agent_mints` |
| `deploy` | ~6% when an EVM treasury is configured and < 6 deploys today | Real ERC-8004 identity registration on the configured EVM chain |

### Everyday weighted mix

| Action | Weight | Real money? | Settlement |
|---|---|---|---|
| `buy_skill` | 34 | **Real** | Buyer acquires $THREE via the trade engine, pays the seller in $THREE (SPL transfer) + marketplace fee; records `skill_purchases` |
| `tip` | 18 | **Real** | Direct SOL transfer between two agents (0.001–0.006 SOL) |
| `trade` | 12 | **Real** | On-chain trade via the platform trade engine; records `pump_agent_trades` |
| `trial` | 12 | DB only | Records a `trial` skill-purchase row (no transfer) |
| `use_trial` | 12 | DB only | Spends one run of an existing trial via `consumeTrialUse`, and logs real usage |
| `buy_asset` | 8 | **Real** | Buyer pays in $THREE (SPL transfer) for an avatar/agent/plugin; records `asset_purchases` |
| `review` | 8 | DB only | Inserts a marketplace review row |
| `payment` | 6 | **Real** | Direct SOL transfer for a named service (0.0012–0.01 SOL), logged with category `x402` |

Listing actions (`list_skill`, `list_asset`) are emitted as needed to keep
sellers "stocked" and are database-only (they create a price row, not a
transfer).

The weight table is a single exported constant, `LIGHT_ACTION_WEIGHTS` in
`api/_lib/circulation.js`, and `tests/circulation-trial-conversion.test.js`
holds every weighted kind to having a real handler in the `ACTIONS` registry.
Adding a weight without a handler is otherwise a silent runtime skip.

## The trial funnel

`trial` and `use_trial` exist as a pair, and the pairing is load-bearing rather
than decorative. A trial grants a fixed number of runs (`trial_remaining`). The
buying action refuses a buyer who already has access, which correctly covers a
confirmed purchase **or** a trial that still has runs left. Once those runs are
spent, that agent is no longer a freeloader, it is the single best purchase
candidate on the platform, and `buy_skill` becomes eligible for it again:

```
list_skill  ->  trial  ->  use_trial (xN, until trial_remaining hits 0)  ->  buy_skill
```

Both free actions sit outside `COSTLY_ACTIONS`, so they keep running when the
paid budget is zero. That is deliberate: a lean treasury is exactly when the
funnel most needs to keep advancing trials toward the point of conversion, so
that demand is queued up and ready the moment the treasury can fund a purchase
again.

> **Why this is called out.** Before `use_trial` existed, nothing ever spent a
> trial run. `consumeTrialUse` is reachable only from the x402 agent-action
> route, which circulation agents never call, so `trial_remaining` stayed at
> its granted value permanently and every trial retired its
> (buyer, seller, skill) triple from the paid path for good. Production had
> accumulated 10,282 trial rows, zero confirmed purchases ever, and not a
> single exhausted trial. Marketplace revenue was a structural zero rather than
> a demand problem. If you add another free action that grants access, give it
> an exit in the same change.

> The only coin the engine ever launches, trades, or prices marketplace
> inventory against is **$THREE**
> (`FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump`). The `launch` and `trade`
> actions operate on a runtime mint and never hardcode or promote any other
> token.

## Amounts

All amounts are small by design — a steady, believable heartbeat, not volume for
its own sake.

| Constant | Value |
|---|---|
| `TIP_MIN` / `TIP_MAX` | 0.001 / 0.006 SOL |
| `PAY_MIN` / `PAY_MAX` | 0.0012 / 0.01 SOL |
| `SKILL_PRICE_MIN/MAX_THREE` | 80 / 1200 $THREE |
| `ASSET_PRICE_MIN/MAX_THREE` | 600 / 4000 $THREE |
| `AGENT_FLOOR` (top-up target) | 0.02 SOL |
| `LAUNCH_FLOOR` | 0.034 SOL |
| `THREE_TOPUP_SOL` (smallest $THREE buy, and the quote probe) | 0.012 SOL |
| `THREE_TOPUP_MAX_SOL` (hard ceiling on one $THREE buy) | 0.06 SOL |
| `FEE_BUFFER` (per-tx headroom) | 0.0009 SOL |

### Buying $THREE for a marketplace purchase

A buyer that is short on $THREE acquires it through the real trade engine before
paying. The buy is **sized to the shortfall**, not fixed: `ensureThree()` quotes
`THREE_TOPUP_SOL` worth of $THREE, derives the live rate, and buys what the
listing actually costs plus 8% headroom for curve movement and fees.

Two bounds apply, and the smaller wins:

- `THREE_TOPUP_MAX_SOL`, the absolute ceiling on a single buy, and
- this tick's share of the treasury (`spendableSol / paidBudget`), so an action
  that sizes its own spend cannot quietly overspend the budget the governor
  planned from and starve the actions queued behind it.

If the shortfall costs more than that, the action is **skipped before any SOL
moves**, naming the SOL it would have needed. This matters: the engine used to
buy a flat 0.012 SOL of $THREE regardless of price. At roughly 100 $THREE per
0.012 SOL, and with skills listed at 80-1200 $THREE and assets at 600-4000, most
of the marketplace was unbuyable. Every attempt still paid a real trade fee,
skipped with `still short on $THREE after top-up buy`, and repeated next tick, so
marketplace GMV read zero while the fees went out. Sizing math is pure and
covered by [tests/circulation-three-topup.test.js](../tests/circulation-three-topup.test.js).

## Cadence

The engine runs from the `pulse-tick` cron
([api/cron/pulse-tick.js](../api/cron/pulse-tick.js)), which is fanned out every
**minute** by the `economy-tick` dispatcher (see the
[economy heartbeat](economy-heartbeat.md)) rather than scheduled on its own.
Each tick grows the pool by up to `CIRCULATION_GROWTH_PER_TICK` agents and runs
`CIRCULATION_ACTIONS_PER_TICK` everyday actions (plus any heavyweight action that
wins first refusal). The `pulse-tick` function is bounded to a 120-second
`maxDuration` in [`vercel.json`](../vercel.json).

All scheduled jobs — the `economy-tick` dispatcher included — run on **Google
Cloud Scheduler**. `vercel.json`'s cron list is the source of truth the Cloud
Run server (`server/index.mjs`) reads at runtime; there is no GitHub Actions
failover.

## Configuration

| Env var | Default | Range | Purpose |
|---|---|---|---|
| `CIRCULATION_ENABLED` | _(off)_ | `1`/`true`/`yes` | Master gate. Engine is inert unless set. |
| `CIRCULATION_TREASURY_SECRET` | _(required)_ | base58 / base64 / JSON keypair | Solana treasury that funds the pool. |
| `CIRCULATION_NETWORK` | `mainnet` | `mainnet` / `devnet` | Solana cluster. |
| `CIRCULATION_POOL_TARGET` | `14` | 2–2000 | Target pool size. |
| `CIRCULATION_GROWTH_PER_TICK` | `3` | 1–40 | New agents created per tick when short. |
| `CIRCULATION_ACTIONS_PER_TICK` | `2` | 1–12 | Everyday actions executed per tick. |
| `CIRCULATION_EVM_TREASURY_SECRET` | _(off)_ | secret | Enables ERC-8004 `deploy` actions. |
| `CIRCULATION_EVM_CHAIN_ID` | `8453` (Base) | 1–1e9 | EVM chain for deploys. |

Manufactured demand only ever reaches circulation sellers — agents the platform
owns. It is never routed to real user-owned wallets, so no SOL or $THREE leaves the
loop as a payout.

## Recording and where it surfaces

| Sink | What it holds |
|---|---|
| `circulation_actions` | One row per action the engine ran (kind, actors, signature, amount). |
| `agent_custody_events` | The canonical wallet ledger entry for every real spend/transfer (see [Money feed](money-feed.md)). |
| `pump_agent_trades` / `pump_agent_mints` | Trade and launch records, surfaced in the pump feed and `/launches`. |
| `skill_purchases` / `asset_purchases` | Marketplace settlement records (see [Marketplace](marketplace.md)). |

Real spends are written to `agent_custody_events`, which powers per-agent
portfolio balances and the agent-to-agent economy volume dashboard (all-time and
7-day volume, top earners and spenders). Trades and launches additionally surface
in the public pump feed and the launches directory.

## Safety

- **Skips, not errors.** A low treasury, an under-sized pool, or a buyer that
  can't be funded raises an internal `Skip` — an expected, logged non-event. The
  tick records it and moves on; it is never surfaced as a failure.
- **Just-in-time funding.** Wallets are topped up only to `AGENT_FLOOR` plus the
  amount needed for the imminent action, bounding treasury exposure per tick.
- **Bounded heavyweight actions.** Launches and deploys are rate-limited per hour
  and per day independent of the everyday mix.
- **Demand never leaves the pool.** The buy-side listing query
  (`listedSkills()`) selects only sellers tagged `meta.circulation = 'true'`,
  so manufactured demand is only ever routed to platform-owned circulation
  sellers, never to a real user's listings or wallet.

## Ramping volume

The safest levers, in order, all reversible:

1. Raise `CIRCULATION_ACTIONS_PER_TICK` (e.g. 2 → 6) — near-linear throughput.
2. Raise `CIRCULATION_POOL_TARGET` (e.g. 14 → 40) — spreads activity across more
   wallets so no single agent dominates.
3. Raise `CIRCULATION_GROWTH_PER_TICK` to fill a larger pool faster.

Higher throughput burns more treasury SOL and pushes against the 120-second cron
budget, so raise gradually and watch tick runtime and treasury balance.

## Related

- [Economy Health dashboard](economy-health-dashboard.md) — the operator page
  that diagnoses this engine when the pulse goes quiet.
- [Money feed](money-feed.md) — where circulation activity surfaces.
- [Autonomous x402 loop](autonomous-x402.md) — the separate treasury-paid loop
  that buys polling intel from our own x402 endpoints.
- [Agent wallets](agent-wallets.md) — the custodial key model every action uses.
- [Marketplace](marketplace.md), [Coin launches](coin-launches.md).
