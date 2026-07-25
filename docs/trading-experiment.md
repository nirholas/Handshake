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

The proactive 2x ladder is **opt-in**: a strategy with no `initials_out_multiple`
does not take initials early. It still never fully exits a winner, though: the
fleet-wide moon-bag rule below covers that independently.

There are two ways in. A human sets it directly (this script, or the arm API),
**or** an arm earns it: once the autonomy engine places an arm at `trusted` or
above and its winners demonstrably run past its average exit, the optimizer turns
the ladder on by itself and records why. See
[Earned autonomy](./sniper-autonomy.md). A losing arm cannot reach the field at
all, so the ladder is only ever switched on for a strategy whose record shows it
actually catches runners.

### No-Mayhem enforcement (`workers/agent-sniper/mayhem-gate.js`)

`isMayhemMode` lives on the pump.fun bonding curve, not the new-mint firehose, so
it's read from the curve (one cached read per mint) and checked as **gate 0** in
`executeBuy` — before any throttle, wallet decrypt, or position row — so it covers
**every** trigger path (new_mint, intel, alpha, first_claim, radar, swarm). On by
default (`SNIPER_MAYHEM_FILTER=0` disables; `SNIPER_MAYHEM_STRICT=1` also skips
when the curve can't be read). A Mayhem mint is skipped with reason
`mayhem_excluded`.

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
  `20260703150000_sniper_laddered_exit.sql`, `20260703160000_trading_journal.sql`
- Funding UI: `/agent/:id/wallet` deposit tab, `/arm`

## Related

- [STRUCTURE.md](../STRUCTURE.md) — surface map
- Auto-funding is off by default platform-wide — see the sniper auto-fund consent
  gate (`agent_sniper_strategies.auto_fund_enabled`).
