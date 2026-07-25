# Earned autonomy: freedom the fleet has to trade for

The sniper fleet runs several strategies ("arms") side by side against the same
market. Two loops improve them without a human in the seat: the
[optimizer](../api/cron/sniper-optimize.js) tunes each arm's own knobs, and the
[evolution loop](../scripts/sniper-evolve.mjs) moves budget between arms.

Both used to treat every arm identically. Same hard bounds, same per-run step,
same short list of writable fields, same context in front of the LLM judge. An
arm that had been profitable for weeks was allowed to search exactly as narrow a
space as one that had never had a winning day, and was told exactly as little
before deciding.

Earned autonomy fixes that. An arm's own realized record decides how much rope it
gets, and the decision is recomputed from scratch every run.

## The tiers

| Tier | Earned by | What it grants |
|---|---|---|
| `probation` | net negative with an average per-trade edge at or below -0.5%, over 15+ real trades | Narrowed bounds, half-size steps, per-trade size capped at 0.05 SOL, base knowledge |
| `standard` | the default: too few trades to judge, or no decisive edge | Historical bounds and steps, base knowledge |
| `trusted` | net positive with an average edge of at least +0.5%, over 12+ real trades | Wider bounds, 1.75x steps, unlocks the entry universe, the LLM confidence bar and the take-initials ladder, informed knowledge pack |
| `autonomous` | net positive with an average edge of at least +5%, over 40+ real trades | Widest bounds, 2.5x steps, every tunable field, complete knowledge pack |

The gates live in [`api/_lib/sniper-autonomy.js`](../api/_lib/sniper-autonomy.js)
as `GATES`, and the whole policy is pure: no I/O, no clock, no DB, so the same
function decides the tier everywhere it is read and the entire thing is
unit-testable ([tests](../tests/sniper-autonomy.test.js)).

### Why average edge and not win rate

An arm can win 36% of the time and still be the most profitable on the board,
because the winners are far larger than the losers. Win rate would demote that
arm. The tier is decided on realized net P&L plus average per-trade edge, so the
arm that actually makes money is the one that earns room, whatever its hit rate.

The reverse case is just as important: an arm that wins 60% of its trades and is
still net negative (small winners, large losers) is not succeeding, and gets
`probation` rather than a reward.

### It is symmetric, and it is continuous

A tier is not granted once. Every optimizer run recomputes it against a trailing
window, so an arm that stops making money loses its rope on the next pass without
anyone intervening, and a demoted arm earns it back the same way. Freedom is
rented, never owned.

## What a tier changes

### 1. How far and how fast the optimizer may move a knob

Each tier carries its own `TIER_BOUNDS` and a step multiplier. Higher tiers widen
the search space in both directions and let a single run move further; probation
narrows it and halves the step. `standard` is the historical behaviour exactly,
so anything that does not pass a tier is unchanged.

### 2. Which fields the optimizer may touch at all

Every tier can tune stops, take-profit, hold time, the quality and oracle floors,
and position size. Reaching `trusted` unlocks four more:

- `llm_min_confidence` — a profitable judge earns a lower bar, so it acts on more
  of what it sees instead of passing on launches it would have won.
- `min_market_cap_usd` / `max_market_cap_usd` — a wider hunting ground, widened
  outward only. An arm with no band set is already unrestricted and nothing here
  will restrict it.
- `initials_out_multiple` — the [take-initials ladder](./trading-experiment.md):
  recover the stake at 2x, keep a moon bag, let the rest ride the trailing stop.
  Turned on only for an arm whose winners demonstrably run past its average exit.

`autonomous` adds `max_creator_launches`, so a proven arm can test whether a
prolific creator is really a bad one.

### 3. How much of the fleet budget an arm concentrates

The evolution loop multiplies each arm's fitness by its tier weight (0.6 on
probation up to 2.2 at autonomous) before splitting the fixed fleet budget. The
fleet total never changes and the per-arm floor still keeps exploration alive:
this only decides how the same pot is divided.

### 4. How much the LLM judge is told

This is the "more knowledge" half, and it is built in
[`workers/agent-sniper/judge-knowledge.js`](../workers/agent-sniper/judge-knowledge.js).

- **base** (probation, standard) — the launch brief and the market-realness read.
  Exactly the prompt the judge has always received.
- **informed** (trusted) — plus the ground-truth base rate (what fraction of
  launches actually win, so the model knows how skeptical its prior should be),
  the learned signal weights retrained every 15 minutes from labeled outcomes,
  and the arm's own realized record.
- **full** (autonomous) — plus the conditional win-rate table (per signal bucket,
  the realized win rate versus baseline: what actually happened, not a
  correlation the model has to interpret) and the model's own calibration, so it
  can correct its own bias.

Every line of it is read from real rows. When a table is empty or the database is
unreachable the pack degrades to a shorter block or to nothing at all, and the
judge falls back to the prompt it used before. An arm is told what is true or it
is told nothing.

**Cost note.** Verdicts are cached per `(mint, model, knowledge depth)`. Arms at
base depth still share one call across a same-model fleet exactly as before. An
arm with earned context is asking a materially different question, so it pays for
its own call. Only a profitable arm has one.

## What no tier can ever touch

Earned autonomy widens the space an arm may search. It never removes the floor
under it. These are enforced at the `executeBuy` chokepoint and are out of reach
of both loops at every tier:

- the trade firewall's real buy → sell round-trip
- Mayhem exclusion
- `max_price_impact_pct` and slippage caps
- SOL headroom and the daily loss cap
- `max_concurrent_positions`
- the fleet daily budget ceiling
- the kill switch

A hard stop-loss also survives every tier. The range widens (up to 65% at
`autonomous`) but it can never be unset and never reach zero, so "no stop" is not
a state any amount of profit can unlock. The worst an autonomous arm can do is
take a firewall-vetted, stop-loss-protected, budget-bounded trade.

A test asserts this directly: no safety field appears in any tier's writable set,
and every tier keeps a bounded stop.

## Reading it

The tier is visible in three places:

- **[/sniper/experiments](https://three.ws/sniper/experiments)** — a badge on any
  arm that has moved off `standard`, with the evidence in its tooltip, plus an
  "Earned autonomy" summary tile. `GET /api/sniper/experiments` returns
  `autonomy_tier`, `autonomy_reason` and `autonomy_grants` per arm.
- **`agent_sniper_optimizer_runs`** — every run records the `autonomy_tier` and
  `autonomy_reason` it acted under, so you can see which tier an arm held when a
  given knob moved.
- **the Reasoning Ledger** — an applied tuning names the tier and its evidence in
  the rationale, next to the trades it learned from.

## Worked example

The fleet as of 2026-07-25, classified over its all-time record:

| Arm | Closed | Net SOL | Avg edge | Tier |
|---|---|---|---|---|
| llm-grok | 33 | +0.0027 | +0.81% | `trusted` |
| llm-auto | 20 | +0.0001 | +0.04% | `standard` (noise, not profit) |
| llm-claude | 13 | -0.0116 | -8.89% | `standard` (sample below the demotion gate) |
| boost-ride | 62 | -0.0201 | -3.24% | `probation` |
| oracle-open | 30 | -0.0234 | -15.4% | `probation` |

`llm-grok` is the only arm that has earned anything, which is the correct read:
it is the only one with a real sample and a real profit. Its budget share rises
by roughly half, its judge starts seeing the base rate and the learned weights,
and the optimizer may now walk its confidence floor down and turn its ladder on.
`boost-ride` wins 60% of its trades and is still net negative, so it is held
tighter rather than rewarded for the hit rate.

## Related

- [Agent Sniper](./agent-sniper.md) — the trading pipeline the arms run on
- [The 10 SOL trading experiment](./trading-experiment.md) — the exit thesis the
  ladder implements
- [`api/_lib/sniper-optimizer.js`](../api/_lib/sniper-optimizer.js) — the tuning
  rules, tier-scaled
- [`scripts/sniper-evolve.mjs`](../scripts/sniper-evolve.mjs) — the portfolio
  layer, tier-weighted
