# Find a Better Exit Policy From Trades You Already Made

Most trading advice is about entries. Most losses are about exits.

Entries are the visible decision, so they get the attention. But a fleet that
buys the same coins and sells them differently produces wildly different results,
and the exit rules are the cheapest thing in the whole system to change. You do
not need a new signal or a faster feed. You need to move a number.

The problem is knowing which number, and by how much. Opinions about stop-losses
are free and mostly worthless. What you actually want is the boring version:
**take the trades you already made and re-run them under different rules.**

That is [/exit-lab](/exit-lab). By the end of this tutorial you will have found a
policy that beats the one the fleet is running, understood exactly how much of
that finding you are allowed to believe, and known which part of it is a real
result and which part is noise wearing a suit.

Nothing here requires an agent, a wallet or a login. The corpus is public and
every trade in it is a signed transaction anyone can verify.

**What you will learn:**

- Why "what would this have returned" is a different question from "would this have worked"
- How to read the one number that tells you a counterfactual is trustworthy
- Why a policy that looks 3x better on the grid may be worth nothing
- Which of the five exit knobs actually moves the result, and which are theater
- How to turn a finding into a change you can defend

---

## Step 1: See what the fleet actually did

Open [/exit-lab](/exit-lab). The page loads every closed position the fleet
opened with real SOL and settled on-chain, then replays them under the live
policy, which is the state the page opens in.

Read the verdict card first. It has three numbers:

- **Net result** over N real trades, in SOL
- **ROI**, that net against the SOL actually staked
- **Actually booked**, from the ledger

You can get the same corpus without the page:

```bash
curl -s 'https://three.ws/api/sniper/exit-lab?window=all&limit=500' \
  | jq '{scanned, replayable, excluded: [.excluded[].key]}'
```

```json
{
  "scanned": 313,
  "replayable": 306,
  "excluded": ["laddered"]
}
```

Those counts grow every time the fleet closes a position, so yours will be
larger. The shape is the part that matters: `scanned` is every closed position
the corpus reached, `replayable` is how many survived the exclusions, and
`excluded` names why the rest were dropped.

**The first thing to notice is that "net result" and "actually booked" are not
the same number, and they are not supposed to be.**

This trips people up, so it is worth being blunt about. The replay prices an exit
at the quote the fleet recorded. Real exits pay slippage, priority fees and the
spread. The difference between the replay of the live policy and the booked
figure is roughly what execution cost, and it is real money, but it is not the
thing this page is measuring.

So: **compare replays to replays.** Never compare a replay to the ledger and call
the difference a finding.

---

## Step 2: Change one thing

Drag the **Hard stop-loss** slider from 35% down to 15%.

Watch the delta on the right of the verdict card. It now reads a signed SOL
figure "versus the live policy over the same trades". That is a replay-to-replay
comparison, which is the honest one.

Now put it back and try the **Trailing stop** instead. Then the **Take initials
at** multiple.

You will notice quickly that the five knobs are not equally interesting. On a
corpus dominated by positions that never went green, the trailing stop and the
take-initials ladder barely register, because neither rule can fire on a coin
that never rose above cost. The hard stop-loss does almost all the work. That is
not a quirk of the tool, it is a fact about the fleet's trades, and it is the
first genuinely useful thing the page tells you.

The `?` next to each label opens a plain-language explanation of what that rule
does and when it can fire. Read the one for the trailing stop: the detail that it
only arms once a position has been green is the reason it does nothing on a
losing corpus, and it is also the reason it is safe.

---

## Step 3: Read the honesty numbers before you believe anything

Scroll to **What this can and cannot tell you**. Two lines there decide how much
of your finding survives contact with reality.

**"Exiting earlier is exact; holding longer is a floor."** The recorded price
path stops where the real policy sold. A counterfactual that would have kept
holding runs out of observations at that point, so its result is valued at the
last price the fleet saw. That is a lower bound, never an upper one.

This has a sharp practical consequence:

- A policy that is **tighter** than the live one (smaller stop, tighter trail)
  exits earlier on almost every trade. Its number is essentially exact.
- A policy that is **looser** (wider stop, no trail) holds longer. Its number is
  a floor, and the true answer could be better or, more often, much worse.

**So a tight policy that beats the live one is a real finding. A loose policy
that beats the live one is a hypothesis.** The page tells you which you are
looking at: the bounded-trade count in that same section is how many positions
were still holding when the observations ran out.

The second line to read is the excluded count. Positions whose initials were
already taken cannot be replayed, because the partial sell rewrote their cost
basis and high-water mark to describe the moon bag instead of the original
position. Those rows are dropped and counted. If that count is a large share of
the corpus, your answer covers a small share of the fleet's history.

---

## Step 4: Search the grid

Press **Run the search**.

The page replays the entire corpus against every combination on a grid of exit
policies. This is an exact enumeration, not a sample and not an optimizer: every
policy on the grid is genuinely replayed against every trade. The progress bar
counts real completed policies.

The result is a ranked table. Each row has the policy, the net SOL, the ROI, the
win rate and the max drawdown, plus an **Apply** button that loads it into the
sliders so you can inspect it.

Now the important part. Read the leaders in this order:

1. **Drawdown before profit.** The deepest fall from a high-water mark is what
   decides whether a policy is survivable. A policy that makes more money through
   a drawdown you would have turned off halfway is not a policy you can run.
2. **Is it tighter or looser than live?** Tighter means the number is close to
   exact (Step 3). Looser means it is a floor.
3. **How far apart are the top rows?** If the top eight policies are within a few
   thousandths of a SOL of each other, you have found a plateau, which is good
   news: the result is not balanced on one lucky setting. If the top row is far
   ahead of the second, be suspicious.

If the corpus has fewer than about 30 closed positions the page replaces the
explanatory note with a warning, because a grid this size will always find a
flattering corner of noise in a small sample. Believe the warning.

---

## Step 5: Check the finding trade by trade

A grid result is an aggregate, and aggregates hide their sources. Scroll to
**Trade by trade** with your candidate policy applied.

The default sort is **biggest divergence**: the positions where the counterfactual
disagrees most with what the fleet really did. Read the top five.

You are looking for one specific failure mode. If the entire improvement comes
from two or three positions, you have not found a better policy, you have found a
policy that happened to catch a couple of specific coins. Real findings are
spread across the corpus. A policy whose delta is concentrated in the tail will
not repeat.

Every row links the buy and the sell to Solscan. Click one. The transaction is
signed by the agent's own key and the amounts are on-chain. This is what
separates the exercise from a spreadsheet: you can verify that the trade being
replayed happened.

---

## Step 6: Share it, then argue with it

Press **Copy a link to this policy**. The URL carries every slider value, so
anyone opening it sees exactly the state you were looking at:

```
https://three.ws/exit-lab?stopLossPct=15&trailingStopPct=10&takeProfitPct=off&initialsOutMultiple=2&moonbagMinPct=15
```

That link is the unit of a useful argument about exits. Instead of "I think the
stop is too wide", you can send a page that shows what a tighter stop would have
returned over every replayable trade in the corpus, with the caveats attached and
the underlying transactions one click away.

If you run your own agent, the same parameters are what
[`/api/sniper/strategy`](../api-reference.md) accepts, so a finding here maps
directly onto a strategy you can arm. Read
[Arm an autonomous sniper](/tutorials/arm-an-agent-sniper) for that path, and
size it small first: an in-sample optimum is a description of the past, and the
past does not have to repeat.

---

## What to take away

The honest summary of this whole exercise is short.

**Tightening the exits is measurable.** The recorded path fully determines what
an earlier exit would have returned, so a tight-policy improvement is a fact
about trades that happened.

**Loosening the exits is not.** The moment a policy would have held past the
point the fleet sold, the data stops and the number becomes a floor.

**The knob that matters is the one that can fire.** On a corpus of coins that
mostly never went green, the stop-loss is the whole game and the trailing stop is
decoration. On a corpus with real winners in it, that reverses. Look at which
rules actually fired before deciding which one to tune.

And the general version, which outlives this particular page: a counterfactual
tool is only worth anything if it tells you where it stops being reliable. The
bounded-trade count, the excluded-position count and the overfit warning are not
disclaimers bolted onto the result. They are the result.

---

## Related

- [Exit Lab reference](/docs/exit-lab), the method and the API in full
- [Read the trading fleet](/tutorials/read-the-trading-fleet), how to tell a working strategy from a lucky one
- [Arm an autonomous sniper](/tutorials/arm-an-agent-sniper), from finding to armed strategy
- [Agent Sniper](/docs/agent-sniper), the worker whose positions this replays
