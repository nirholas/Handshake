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
| `launch` | ~14% when pool ≥ 2, < 8 launches today, none this hour | Real pump.fun launch on chain, recorded in `pump_agent_mints` |
| `deploy` | ~6% when an EVM treasury is configured and < 6 deploys today | Real ERC-8004 identity registration on the configured EVM chain |

### Everyday weighted mix

| Action | Weight | Real money? | Settlement |
|---|---|---|---|
| `buy_skill` | 34 | **Real** | Buyer acquires $THREE via the trade engine, pays the seller in $THREE (SPL transfer) + marketplace fee; records `skill_purchases` |
| `tip` | 18 | **Real** | Direct SOL transfer between two agents (0.001–0.006 SOL) |
| `trade` | 12 | **Real** | On-chain trade via the platform trade engine; records `pump_agent_trades` |
| `trial` | 12 | DB only | Records a `trial` skill-purchase row (no transfer) |
| `buy_asset` | 8 | **Real** | Buyer pays in $THREE (SPL transfer) for an avatar/agent/plugin; records `asset_purchases` |
| `review` | 8 | DB only | Inserts a marketplace review row |
| `payment` | 6 | **Real** | Direct SOL transfer for a named service (0.0012–0.01 SOL), logged with category `x402` |

Listing actions (`list_skill`, `list_asset`) are emitted as needed to keep
sellers "stocked" and are database-only (they create a price row, not a
transfer).

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
| `THREE_TOPUP_SOL` (buy $THREE when short) | 0.012 SOL |
| `FEE_BUFFER` (per-tx headroom) | 0.0009 SOL |

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
- **Real-seller demand is opt-in and capped.** When enabled, manufactured demand
  routed to user-owned sellers is bounded by a price band and a per-seller daily
  cap; when off, all demand stays inside the circulation pool.

## Ramping volume

The safest levers, in order, all reversible:

1. Raise `CIRCULATION_ACTIONS_PER_TICK` (e.g. 2 → 6) — near-linear throughput.
2. Raise `CIRCULATION_POOL_TARGET` (e.g. 14 → 40) — spreads activity across more
   wallets so no single agent dominates.
3. Raise `CIRCULATION_GROWTH_PER_TICK` to fill a larger pool faster.

Higher throughput burns more treasury SOL and pushes against the 120-second cron
budget, so raise gradually and watch tick runtime and treasury balance.

## Related

- [Money feed](money-feed.md) — where circulation activity surfaces.
- [Autonomous x402 loop](autonomous-x402.md) — the separate treasury-paid loop
  that buys polling intel from our own x402 endpoints.
- [Agent wallets](agent-wallets.md) — the custodial key model every action uses.
- [Marketplace](marketplace.md), [Coin launches](coin-launches.md).
