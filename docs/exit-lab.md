# Exit Lab

**Live surface: [three.ws/exit-lab](https://three.ws/exit-lab)**

The fleet has already spent the SOL. Exit Lab answers the question that follows:
**were the exits right?**

It takes positions the agent fleet genuinely opened and closed on-chain, re-runs
each one through the exact exit code the live worker runs with the rules changed
to whatever you choose, and shows what those same trades would have returned. No
part of it is simulated. Every entry price, high-water mark and final quote is a
recorded number from a position that cost real money.

---

## Why this is not the backtester

three.ws already ships a backtester ([`api/_lib/strategy-backtest.js`](../api/_lib/strategy-backtest.js),
documented in [trading-experiment.md](trading-experiment.md)). The two answer
different questions and neither replaces the other.

| | Backtester (`/api/sniper/backtest`) | Exit Lab (`/exit-lab`) |
|---|---|---|
| Question | Would this strategy have **entered** profitably? | Were our **exits** right? |
| Corpus | Captured launch intel, including launches we never touched | Positions the fleet actually bought and sold |
| Money | Hypothetical | Real, already spent |
| Exit model | `decideExit`, the single-shot decider | `decideLadderedExit`, the live laddered decider |
| Models the moon bag | No | Yes, leg for leg |

The backtester tells you whether a filter is worth arming. Exit Lab tells you
whether the rule that sold was the rule that should have.

---

## What you can change

Every knob is declared once, in `PARAM_SPECS` in
[`api/_lib/exit-replay.js`](../api/_lib/exit-replay.js). The page builds its
sliders from that list and the search builds its grid from it, so a new
parameter appears in the console, the grid and this table without being written
down three times.

| Knob | What it does | Live default |
|---|---|---|
| Hard stop-loss | Sell everything once the position is this far below cost. Outranks every other rule. | 35% |
| Trailing stop | Sell after the price falls this far from its high-water mark. Only arms once the position has been green. | 25% |
| Take-profit ceiling | Close the remainder once the position is this far up. With the ladder armed, only applies after initials are out. | off |
| Take initials at | The multiple at which the stake comes back off the table. At 2x that is a half sell. Fires once. | 2x |
| Moon-bag floor | The share of the bag that always keeps riding on a profitable exit. | 15% |

A nullable knob set to `off` is **null, not zero**. That distinction is
load-bearing: `Number(null) === 0`, and a 0% stop-loss fires immediately on every
position. The `pct()` contract in
[`workers/agent-sniper/exit-logic.js`](../workers/agent-sniper/exit-logic.js) is
the single source of truth for it.

---

## How a replay works

A closed position records three honest price points and a duration:

```
entry_quote_lamports   the SOL spent (cost basis)
peak_value_lamports    the high-water mark of the bag's quoted SOL value
last_value_lamports    the bag's quoted value when the exit fired
opened_at → closed_at  how long it was held
```

The replay walks that path in two phases.

**Rising, from 1x to the peak.** Only two rules can fire while price climbs:
take-initials and the take-profit ceiling. Both are monotone in price, so the
next event is whichever triggers at the lower multiple. When a leg sells, the
replay mirrors the live partial-sell bookkeeping exactly (see the partial branch
in [`workers/agent-sniper/executor.js`](../workers/agent-sniper/executor.js)):
the cost basis is scaled down by the sold fraction, the high-water mark is reset
to the remaining bag, and `initials_recovered` flips.

**Falling, from the peak to the final quote.** Whichever protective trigger sits
highest is the one hit first on the way down. Whatever is still riding at the end
is valued at the last price the fleet actually observed, never at a guess about
what came after.

Every decision in both phases is made by calling `decideLadderedExit` with a
position-like object using the live column names. The replay does not
reimplement the exit rules; it feeds production code and reads the answer. The
two can therefore never drift.

---

## What it can and cannot tell you

This is the part that matters. A counterfactual tool that overstates itself is
worse than no tool, so the limits are on the page, not buried in a footnote.

**Every trade is real.** The corpus is closed positions with an on-chain buy
signature that is not the `SIMULATED` sentinel. Paper fills cannot enter it.

**Compare replays to replays, not to the ledger.** The replay prices an exit at
the quote the fleet recorded. It does not model slippage, priority fees or the
spread actually paid. Replaying the live policy will therefore **not** reproduce
the booked number, and it is not supposed to. The gap between two replays is the
signal; the gap between a replay and the ledger is execution cost.

**Exiting earlier is exact. Holding longer is a floor.** The recorded path stops
where the real policy sold. A counterfactual that would have kept holding runs
out of observations there, so its result is a lower bound and never an upper one.
The page reports how many trades are bounded this way under the current policy.

**Some positions are excluded, and it says which.** A position whose initials
were already taken has had its cost basis scaled down and its high-water mark
reset by the partial-sell path, so its recorded points describe the moon bag
rather than the original position. Replaying it would produce a confident number
computed from figures that no longer mean what they look like. Those rows are
dropped with a stated reason and counted, so you always know what fraction of
the fleet's history the answer covers.

**An in-sample optimum is not a forecast.** The search finds the policy that
would have paid best on trades that already happened. Under about 30 closed
positions a grid of this size will always find a flattering corner of noise, and
the page says so instead of letting a leader row read as a recommendation.

---

## The API

```
GET /api/sniper/exit-lab?network=mainnet&window=all&limit=500
```

Public and IP rate-limited, like the leaderboard. The tx signatures are the
proof, so anyone can check the fleet's homework.

`network` is `mainnet` (default) or `devnet`. `window` is `7`, `30`, `90`
(default) or `all` days. `limit` caps at 500.

```bash
curl -s 'https://three.ws/api/sniper/exit-lab?window=all&limit=500' | jq '{replayable, scanned, excluded, first: .trades[0]}'
```

```json
{
  "replayable": 295,
  "scanned": 301,
  "excluded": [
    {
      "key": "laddered",
      "count": 6,
      "reason": "Initials were already taken, so the recorded cost basis and high-water mark describe the moon bag, not the original position."
    }
  ],
  "first": {
    "mint": "FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump",
    "symbol": "THREE",
    "agentId": "0846c27e-6258-4859-bc1c-3148d59951c5",
    "agentName": "Moe Money AI",
    "entryLamports": 20000000,
    "peakLamports": 20000000,
    "terminalLamports": 18154034,
    "holdSeconds": 494,
    "actualPnlLamports": -498908,
    "actualReason": "timeout",
    "closedAt": "2026-08-13T00:39:01.448Z",
    "buyUrl": "https://solscan.io/tx/...",
    "sellUrl": "https://solscan.io/tx/..."
  }
}
```

`scanned` counts the rows the query returned, so it never exceeds `limit`:
`replayable` is that number minus whatever `excluded` accounts for.

The replay itself runs in the browser, against the same kernel the server
imports. That is why a slider move is instant: the server has no better claim to
the answer than the client does, so it ships the facts and the client does the
arithmetic.

---

## Using the kernel yourself

`api/_lib/exit-replay.js` is pure. No I/O, no clock, no Node built-ins. Import it
from a script, a worker or a browser bundle.

```js
import { replayFleet, sweepParams, DEFAULT_PARAMS, toSol } from './api/_lib/exit-replay.js';

const res = await fetch('https://three.ws/api/sniper/exit-lab?window=all&limit=500');
const { trades } = await res.json();

// What the live policy would have returned over this corpus.
const live = replayFleet(trades, DEFAULT_PARAMS);
console.log(`${live.trades} trades, ${toSol(live.pnlLamports).toFixed(4)} SOL, ${live.roiPct}% ROI`);
console.log(`actually booked: ${toSol(live.actual.pnlLamports).toFixed(4)} SOL`);

// Search a grid for something better.
const search = sweepParams(trades, {
	stopLossPct: [10, 15, 20, 25, 35, 50, null],
	trailingStopPct: [10, 15, 25, 40, null],
	initialsOutMultiple: [1.5, 2, 3, null],
}, { limit: 5 });

for (const leader of search.leaders) {
	console.log(toSol(leader.pnlLamports).toFixed(4), 'SOL', JSON.stringify(leader.params));
}
if (search.overfitRisk) console.log('corpus is too thin to lean on these');
```

`replayFleet` returns aggregate metrics plus a `rows` array with one entry per
replayed position, each carrying `bounded` (still holding at the end of the
recorded path) and `keptMoonbag` so a caller can filter on the same honesty
signals the page shows.

---

## Sharing a finding

The console writes the current policy into the query string, so any state of the
page is a link. `https://three.ws/exit-lab?stopLossPct=15&trailingStopPct=10&takeProfitPct=off&initialsOutMultiple=2&moonbagMinPct=15`
opens with that exact policy applied. A hand-edited value out of range is clamped
to the nearest legal one rather than throwing.

---

## Related

- [Agent Sniper](agent-sniper.md), the worker whose positions this replays
- [Autonomous Trading hub](trading-hub.md), the front door to every trading surface
- [Trading experiment](trading-experiment.md), the policy this fleet runs and why
- [Read the trading fleet](tutorials/read-the-trading-fleet.md), how to interpret fleet vitals
- Tutorial: [Find a better exit policy](tutorials/find-a-better-exit-policy.md)
