# The 10 SOL trading experiment

Give one autonomous agent a real budget (≈10 SOL), let it trade newer pump.fun
launches under a disciplined risk policy, and **learn what works** from a decision
journal. This doc is the full spec: the rules, the math, how to fund it from the
UI, how to run it safely (simulate first), the kill switches, and how to read the
journal.

Everything here runs on the existing sniper worker (`workers/agent-sniper/`) and
the arm API (`api/sniper/strategy.js`). Nothing new moves money on its own.

## The thesis

Get in early on newer projects, but never make the classic mistake of dumping the
whole bag on the first pump. Instead: recover your initial stake once the trade
works (~2×), then hold the rest as a "moon bag" and let it run, protected by a
trailing stop. Cap the downside with a hard stop-loss. Record *why* every buy and
sell happened so the strategy can actually be improved.

## The rules (and the math)

| Rule | Setting | Why |
|---|---|---|
| **Entry universe** | market cap **$10k–$100k** | newer / newer-established projects, not dust and not already-run |
| **No Mayhem** | pump.fun Mayhem tokens are always skipped | owner rule — higher-fee, buyback-less mode; enforced in the worker (see below) |
| **Quality filters** | socials required, skip serial launchers (>10 launches) | cheap signal filters |
| **Position size** | ~2.5% of budget per trade (0.25 SOL at 10 SOL), 20%/day cap | survive a losing streak |
| **Take initials** | at **2× entry**, sell enough to recover the cost basis | de-risk to "house money" without selling the whole position |
| **Moon bag floor** | always keep **≥15%** of the position | a full exit on the way up is impossible by construction |
| **Let it run** | remainder rides on a **25% trailing stop** | capture the upside a too-early full sell would miss |
| **Hard stop-loss** | **35%** below entry, always | the non-negotiable downside cap; stop-loss wins every conflict |
| **Time stop** | 24h | don't hold a dead position forever |

### Take-initials math (`workers/agent-sniper/exit-logic.js` → `decideLadderedExit`)

When a position first reaches `initials_out_multiple`× entry, sell the fraction
that returns the cost basis:

```
sellFraction = min( entry / current_value , 1 − moonbag_floor )
```

- At **2×**: `entry / (2·entry) = 0.5` → sell half, keep half. You've recovered
  your whole stake and still hold 50% for free.
- At **5×**: `0.2` → sell 20%, keep 80%.
- The `1 − moonbag_floor` cap guarantees the sell is **never** the whole bag
  (default floor 15%, so the sell never exceeds 85%).

After the take-initials leg, the position stays **open** with the moon bag, its
trailing-stop high-water is reset to the remaining value (so the pre-sale peak
doesn't instantly trip the trailing stop), and the ladder is marked recovered so
it fires exactly once.

Priority order (stop-loss always wins): `stop_loss → signal_flip → trailing_stop
→ take_initials → take_profit(ceiling) → timeout`.

## We never sell 100% of a winner

This is fleet policy, not a per-strategy option, and it applies whether or not
the take-initials ladder above ever fired.

**Once a position's cost basis is back, the remainder is free.** A free bag is
worth zero at worst and uncapped at best. Selling that last slice to bank a few
thousandths of a SOL trades away every possible outcome above it for a rounding
error. So a terminal exit that is **in profit** sells down to the moon-bag floor
(`moonbag_min_pct`, default 15%) and the retained tokens ride indefinitely.

| Situation | What happens |
|---|---|
| Trailing stop / take-profit / timeout, **in profit** | Sell enough to return the stake (or bank down to the floor if the stake is already home). The rest rides. |
| Any terminal exit **after** initials were recovered | Sell down to the floor. Never to zero: none of it is our money any more. |
| Stop-loss with the stake **still at risk** | **Full exit.** Nothing is free yet, and the hard downside cap is the one rule nothing overrides. |
| Timeout or signal-flip **underwater**, initials never recovered | **Full exit**, same reason. |
| Kill switch | **Full exit**, always. An owner pulling the switch means out. |

Worked example, the case the rule exists for: an arm enters at 1 SOL, the price
runs to 1.4x but never reaches the 2x ladder band, then the trailing stop trips.
The old behavior sold 100% of the bag to realize about +0.0028 SOL. The rule now
sells `1/1.4 = 71%` (exactly the stake) and keeps 29% riding at zero cost basis.

**A held bag does not block the arm.** The position still books `status='closed'`
when this happens, so its realized P&L lands in every existing report unchanged
and its `max_concurrent_positions` slot is released immediately. Only the tokens
stay behind, recorded on the position row (`moonbag_base_amount`,
`moonbag_entry_lamports`) and surfaced on
[/sniper/experiments](https://three.ws/sniper/experiments).

Because loss exits still sell out completely, rugs close fully and only *winners*
leave a bag behind. That bounds the retained-rent cost to the number of winners
rather than the number of trades (each held SPL token account locks about
0.002 SOL of rent).

Set `moonbag_always = false` on a strategy to opt a single arm out. The column
defaults to true and a null is read as true, so every existing strategy has the
rule without a backfill.

The proactive 2x ladder is the **fleet default** (owner rule, 2026-07-25): every
strategy is born with `initials_out_multiple = 2`, so the first time a position
doubles, the initial stake comes off the table and the remainder rides. Setting
the field to an explicit null through the arm API opts a single arm back into
the classic single-shot exit; even then it never fully exits a winner, because
the fleet-wide moon-bag rule below covers that independently.

The multiple itself stays tunable. A human sets it directly (this script, or the
arm API), **or** an arm earns the right to have it tuned: once the autonomy
engine places an arm at `trusted` or above and its winners demonstrably run past
its average exit, the optimizer adjusts the multiple by itself within its bounds
and records why. See
[Earned autonomy](./sniper-autonomy.md). A losing arm cannot reach the field at
all, so the ladder is only ever switched on for a strategy whose record shows it
actually catches runners.

## The post-audit fixes (from the published fleet postmortem)

The [published audit](https://three.ws/blog/autonomous-trading-experiment) of the
fleet's first 90 real trades produced three findings that are now code:

**Overconfidence ceiling** (`llm_max_confidence`). The audit's calibration table
showed judge verdicts in the 0.7 confidence band performed best while 0.9+
verdicts went winless. Each LLM arm can now carry a confidence CEILING next to
its floor: a buy verdict at or above it is recorded for calibration but never
funded. The experiment arms run floor 0.65, ceiling 0.9. Gate:
`llmVerdictGate` in [workers/agent-sniper/llm-judge.js](../workers/agent-sniper/llm-judge.js).

**Named-model strictness** (`llm_strict_model`). During the audit window the LLM
failover chain answered most named-model calls, so "Grok vs Claude" was really
"fallback vs fallback". A strict arm now refuses to trade on any verdict whose
answering model was a fallback (`fallback:*` tag): the verdict still lands in the
judgment ledger, but the arm pauses rather than pollutes its own experiment. The
grok and claude arms are strict; the auto-router arm is not (a fallback IS its
router pick).

**Liquidity-decay exit** (`liquidity_decay`). A bonding-curve quote only moves
when someone trades, so a position whose re-quoted value is exactly frozen sweep
after sweep is a coin nobody is trading. The audit found those squatting on
concurrency slots until the 30-minute timeout. Now an underwater position whose
value has not moved at all for `SNIPER_LIQUIDITY_DECAY_S` (default 300s) exits
early with reason `liquidity_decay` and frees the slot. The clock never runs in
profit (quiet winners belong to the trailing stop and the moon-bag rule), resets
on any trade, and a house-money position keeps its moon-bag floor even here.

**Row-count watchdog** (`/api/cron/sniper-loops-health`). The audit's worst
operational finding: two learning loops ran dead for two days behind green
health checks. An hourly cron now asks each autonomous loop (weight training,
outcome labeling, LLM judging, optimizer, evolution, Oracle scoring) the one
question that cannot lie, "when did you last write a row?", and pages the ops
channel when any answer exceeds that loop's cadence-derived limit. A loop with
no rows at all is the worst finding, not an exemption. Policy is pure and
tested: [api/_lib/sniper-loops-health.js](../api/_lib/sniper-loops-health.js).

## The 2026-08-09 retune (what 254 closed trades actually said)

A full autopsy of every closed mainnet trade (254 closes, 31.9% win rate, net
-0.159 SOL) reduced the fleet's whole history to five findings, and the strategy
table was rewritten to match them:

1. **Exits were the leak, not entries.** 132 of 254 trades were green at some
   point; peak unrealized gains summed to +0.93 SOL against -0.16 realized. 51
   trades went green and still closed red. The entry pickers found the upside;
   the exit policy gave it back.
2. **Stop-losses do not cap downside on this venue.** The five worst trades all
   had a 15% stop set and still closed -84% to -99.9%: a rug gaps through the
   stop before it can fire, and the entry-time firewall sim passes because the
   pool is honest until it isn't. Size every entry as if it can go to zero.
3. **The one net-positive pattern was the take-initials ladder.** The 5 trades
   that recovered initials at 2x: +0.41 SOL realized plus a moon bag still held.
   The other 249: -0.57 SOL. `initials_out_multiple=2` + `moonbag_always` is now
   enforced on every enabled arm instead of being an accident.
4. **Hold-time has a sweet spot.** Sub-400s scalps lost 0.36 SOL across 153
   trades even at a 49% win rate; the 10-15 minute band made +0.37 SOL on 5;
   everything past an hour went 0-for-20. Scalp arms were stretched into the
   band, and the timeout is treated as a failure mode, not an exit.
5. **A capped-upside/uncapped-downside arm loses even when it wins.** The
   graduation-ride arm won 63% of 90 trades and still lost money with TP 20 /
   SL 15 against occasional -99% rugs. Reward must be a multiple of risk
   everywhere: no arm keeps a TP below 2x its SL, and no *ladderless* arm trades
   with a null TP (that arm went 0-for-24). A null TP is still correct on a
   ladder arm, where the ladder takes the stake back at 2x and the trailing stop
   governs the moon bag, which is why the setup script below leaves
   `take_profit_pct` null. The failure was an uncapped bag with nothing at all
   scheduled to take profit, not the absence of a ceiling as such.

The applied changes: six lifetime-negative `new_mint` spray arms disabled (that
trigger went 4-for-64, -0.17 SOL, worst in the fleet), TP set on all 14 arms
that had none, the graduation-ride arm retuned to TP 100 / hold 900s / size
matched to the auto-funder's top-up, the tightest LLM arm widened to TP 60, and
the ladder policy enforced fleet-wide. The oracle-crossing arm, the only
strategy with a real lifetime profit (+0.17 SOL on 8 selective trades, wide TP,
1-hour hold), was deliberately left untouched: the rebuilt fleet copies its
shape rather than diluting it.

## Why an arm shows zero trades (the silent-death class)

A sniper arm can be enabled, funded, and evaluating every launch that crosses the
feed while one of its own knobs makes an entry arithmetically impossible. That
failure is silent by construction: a skipped evaluation writes no position row,
so the board shows `0` with no reason and an arm can sit dead for a week without
anything looking broken. Four arms did exactly that before this was measured.

Every armed strategy on [`/sniper/experiments`](https://three.ws/sniper/experiments)
now carries a `stall` field naming the condition. The diagnosis is a fact about
the configuration, not a guess: each code is a rule the executor really enforces,
evaluated against the same numbers. Policy is pure and tested:
[api/_lib/sniper-stall.js](../api/_lib/sniper-stall.js).

| Code | What it means | Fix |
| --- | --- | --- |
| `wallet_dry` | Balance is under `MIN_OPERATIONAL_WALLET_SOL` (0.012), so the arm cannot even pay for the firewall's simulated round-trip, let alone the buy. | Fund the wallet. |
| `mcap_band_unreachable` | The arm uses a create-event trigger (`new_mint`) with a market-cap floor above what a launch is worth at creation. Sampled live: 40 of 40 fresh pump.fun mints priced $0.1k–$5.8k, median $2.1k, so a $10k floor can never clear. | Move to `intel_confirmed` / `oracle_crossing`, which score a coin *after* it has traded into the band, or lower the floor. |
| `mcap_band_tight` | Floor is above the typical launch price but under $5k: reachable, but only for the small minority of launches that open unusually high. Non-blocking. | Widen the band or accept the low fill rate. |
| `strict_model_offline` | A `llm_strict_model` arm whose named model answered none of its recent verdicts: the failover chain answered for it, and a strict arm refuses to trade on a fallback's judgment. | Restore that model's route (provider key/credits). The worker also pages the ops channel hourly per model. |
| `size_over_budget` | Configured per-trade size exceeds the arm's whole daily budget. Non-blocking since entries now clamp down to the day's remainder. | Let the optimizer converge, or set the two knobs consistently. |
| `kill_switch` / `disabled` | Switched off. | Re-arm. |
| `no_qualifying_launch` | Config is reachable; nothing has met the entry conditions in the window. Non-blocking. | Nothing to fix. |

Two arithmetic deadlocks that produced those codes are now impossible:

**Size can no longer exceed budget.** `checkDailyBudgetLamports` blocks when
`spent + size > budget`, so an arm whose configured size drifted above its own
daily budget failed that test on every evaluation, even at zero spend on a fresh
day. The optimizer owns `per_trade_lamports` and the evolution loop owns
`daily_budget_lamports`, and neither read the other. Two fixes: the optimizer
never proposes a size above the arm's own daily budget, and the executor clamps an
oversized entry down to the day's remainder instead of sitting out (the cap still
holds exactly, and a smaller trade only lowers risk).

**A thin wallet no longer reads as a honeypot.** The firewall proves sellability
by simulating a real buy→sell round-trip *from the agent's own wallet*. When the
wallet could not fund that simulation, the revert was read as "you cannot sell" —
a fatal honeypot verdict on an ordinary bonding-curve launch, where the sell path
*is* the curve program and a trap is structurally impossible. One underfunded arm
produced **336 consecutive false honeypot verdicts in 2.5 hours**. The probe now
shrinks to a size the payer can actually simulate (sellability is a property of
the coin, not of trade size), and a funding-shaped revert with no attributable
instruction is classified as an underfunded buy leg rather than a trapped exit. A
wallet that cannot fund even a minimum probe returns `probe_unaffordable`, which
is still fail-closed: unproven is never treated as safe.

### No-Mayhem enforcement (`workers/agent-sniper/mayhem-gate.js`)

`isMayhemMode` lives on the pump.fun bonding curve, not the new-mint firehose, so
it's read from the curve (one cached read per mint) and checked as **gate 0** in
`executeBuy` (before any throttle, wallet decrypt, or position row) so it covers
**every** trigger path (new_mint, intel, alpha, first_claim, radar, swarm). On by
default (`SNIPER_MAYHEM_FILTER=0` disables). A Mayhem mint is skipped with reason
`mayhem_excluded`. The gate also fails closed by default: a curve that still can't
be read after the RPC-chain retries is skipped with reason `mayhem_unknown`, and
`SNIPER_MAYHEM_STRICT=0` restores allow-on-unknown.

## Funding it from the UI

The agent trades from its **own** custodial Solana wallet — funded by you, never
auto-funded from a platform master (`auto_fund_enabled` stays **false**).

1. Open the agent's wallet hub: **`/agent/<agentId>/wallet#deposit`**.
2. Send ~10 SOL from your own wallet (Phantom/Solflare/Backpack) to the shown
   address, or scan the Solana-Pay QR. The tab shows the balance land live.
3. The arm screen (`/arm`) shows the funded balance + runway so you can confirm
   the 10 SOL arrived before enabling.

## Running it

### 1. Arm the strategy

```bash
node scripts/trading-experiment-setup.mjs --agent <agentId> --user <userId> --budget-sol 10
# add --dry-run to preview the exact config without writing
```

This stages the strategy **disabled** by default (fund + review first). It sets
the full policy above and leaves auto-funding off.

### 2. Simulate first — prove it before real money

Run the worker in **simulate** mode (`SNIPER_MODE=simulate`). It scores, applies
the mcap gate, applies no-Mayhem, and computes laddered exits **without
broadcasting**. Watch the journal:

```
GET /api/sniper/journal?network=mainnet&agent_id=<agentId>
```

Confirm: a $10k–$100k non-Mayhem mint passes; a Mayhem mint is skipped; a >$100k
or <$10k mint is skipped; a position at 2× takes initials and keeps a moon bag; a
position at −35% exits on the stop.

### 3. Go live — deliberately

Set `SNIPER_MODE=live`, enable the strategy (`--enable`, or toggle from the UI).
Real SOL now moves from the agent wallet only.

### Kill switches (in escalation order)

1. `kill_switch = true` on the strategy — stop this agent's new buys (open
   positions still exit on their rules).
2. `SNIPER_GLOBAL_KILL=1` — halt all new buys across every agent.
3. Disable the strategy (`enabled = false`).

## Learning from it — the journal

Every decision is recorded in `trading_journal` with its reasoning:

- **entry** — trigger, market cap, score, size, price impact, firewall verdict.
- **take_initials** — the fraction sold, the leg PnL, "moon bag riding".
- **exit** — the reason (trailing/stop/timeout) and the leg PnL.

Read it at `GET /api/sniper/journal`. Because it captures the *why*, not just the
PnL, you can compare what actually worked — which entry conditions led to winners,
whether 2× initials was too early or too late, whether the 25% trail gave back too
much — and tune the next run. That is the whole point of the experiment.

## Files

- Risk policy config: `scripts/trading-experiment-setup.mjs`
- Laddered exit math: `workers/agent-sniper/exit-logic.js` (`decideLadderedExit`)
- Partial-sell execution: `workers/agent-sniper/executor.js` (`executeSell`)
- No-Mayhem gate: `workers/agent-sniper/mayhem-gate.js`
- Journal: `workers/agent-sniper/journal.js`, read via `api/sniper/journal.js`
- Strategy fields: `api/sniper/strategy.js`, migrations
  `20260703150000_sniper_laddered_exit.sql`, `20260703160000_trading_journal.sql`,
  `20260816070000_trading_journal_uuid_keys.sql` (the retype that made the
  journal's writes land: `agent_id` and `position_id` are both uuid)
- Funding UI: `/agent/:id/wallet` deposit tab, `/arm`

## Related

- [STRUCTURE.md](../STRUCTURE.md) — surface map
- Auto-funding is off by default platform-wide — see the sniper auto-fund consent
  gate (`agent_sniper_strategies.auto_fund_enabled`).
