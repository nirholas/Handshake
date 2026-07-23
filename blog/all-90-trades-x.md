# X.com versions: the 90-trade fleet postmortem

Two formats for @trythreews, built for X's constraints (no custom charts or interactive tables, so the data lives in text and code blocks). Post the article version if X Articles are available on the account; otherwise use the thread. Both link to the full breakdown at https://three.ws/blog/all-90-trades where the charts, all 90 graded trades, and the downloadable dataset live.

---

## Version A: long-form post (X Article / single long post)

We gave 11 AI agents their own Solana wallets and real SOL, pointed them at the pump.fun firehose, and stopped touching the keyboard.

90 real trades later, here is everything, including the losses.

THE SETUP

Each agent is one strategy in an A/B fleet. Same execution stack, same safety rails, same exit ladder. The only variable is how entries get picked:

- rules arms: frozen human-tuned filters (market cap bands, socials, creator history)
- oracle arms: entries gated on a conviction model trained on past launch outcomes
- LLM arms: no rulebook at all. Every launch goes in front of a language model that returns {buy, confidence, thesis}. The thesis is stored on a hash-chained ledger next to the trade.

Position sizes are tiny (0.002 to 0.15 SOL) because this phase buys information, not profit. Every trade is real money on Solana mainnet with public receipts.

THE HEADLINE NUMBERS

- 90 closed trades, 8 strategies, 8 wallets
- fleet net: -0.103 SOL on 1.93 SOL deployed. We paid tuition.
- LLM-judged cohort: 33 trades, net +0.015 SOL
- rules cohort: 57 trades, net -0.118 SOL
- 6 of the 7 biggest wins belong to the LLM arms (best: +73.9%)

THE FINDING

Win rate is a vanity metric.

```
cohort   trades  winrate  avg win  avg loss  net SOL
LLM        33     24%     +52.3%   -10.8%    +0.015
rules      57     30%     +16.2%   -23.7%    -0.118
```

The rules arms are RIGHT MORE OFTEN and still lose 3x what the LLM arms make. The model's edge is not prediction, it is selection: it declines launches a threshold filter has no vocabulary to reject. Fewer entries, fatter right tail, shallower losses.

33 trades is a signal, not a proof. We are scaling the sample and will publish either way.

WHAT ELSE THE DATA SAYS

1. The take-profit is where the money is. It is the only net-positive exit category (+0.056 SOL across 13 exits). Everything else is damage control.

2. A stop-loss is a request, not a guarantee. Five positions had stops at -15% or -30% and realized -78% to -99.9%. The stop fired on time; the bonding curve's liquidity was already gone. Tail defense happens at entry (holder concentration screening) and sizing, not at exit.

3. Trailing stops armed below breakeven are a machine for realizing small losses. 12 trailing exits, net negative. They only earned their keep on positions that were already green.

4. Our conviction model was right and mostly ignored. Sub-30-conviction entries: 19% win rate, most of the fleet's losses. Not one trade in the window entered above 50 conviction. The arms that skipped the gate funded the lesson.

5. The system's self-rated confidence carries real signal: decisions logged at ~0.6 confidence were right 32% of the time, decisions at ~0.4 were right 9%. Humbling numbers, but the ordering means it can be calibrated.

THE 83,000 COINS WE DIDN'T BUY

The trades are half the record. While the fleet was live it observed 82,994 launches in three days, Oracle-scored 45,784, watched 42,995 to a labeled outcome, and bought 72. Under 1 in 1,000.

That labeled set finally answers whether our conviction scorer works at scale:

```
conviction   coins    pumped-or-graduated
unscored     18,510        10.5%
0-30         20,319        11.8%
30-50         4,041        17.4%
50+              71        77.5%   <- seven times the base rate
```

And the fleet bought ZERO of the 110 coins that crossed conviction 50. The reason is painfully mechanical: one arm gated at conviction 35 (too low, admitted the 17% band), the other at 65. The highest score any coin reached all window was 61. The two gates bracketed the profitable band and covered none of it. The strict arm could never mathematically fire.

We checked for hindsight bias: 104 of the 110 have an archived first score, and all 104 were already at 50+ the first time they were ever scored. The signal was on the board before the outcomes.

THE ONES THAT GOT AWAY

The biggest skipped winner ran to a $161M ATH cap. Should we feel bad? At the moment our systems observed it, it showed 3 visible buyers and quality 43/100, statistically identical to the 36,000 rugs in the same dataset. Its run started after our observation window closed.

That is the structural lesson: a minute-zero sniper is blind to every winner whose story starts at minute thirty. No threshold fixes that. A second look at 30 and 60 minutes does.

THE PAPERHANDS AUDIT

We checked every single sell for diamond-hands regret, against each token's FULL price history (candle data for all 85 tokens, minute-level where the coin's life fits in minute candles):

1. Where does each coin trade NOW vs where we sold? 0 of 90 above our exit. Best 0.90x, median 0.36x, 37 of 90 down >90% since we left.
2. What was the highest price each token EVER printed after our exit candle? 37 of 90 tokens never traded again at all (we were literally the last one out). Of the 53 that did, median post-exit high is 0.43x our exit and ZERO reached 1.5x. The single closest call: a trailing stop shook one arm out at +10.6% and the token poked 1.38x higher, worth ~0.004 SOL.

Total SOL lost to selling too early, across the entire experiment: zero. The fleet has no paperhands problem. Every sell was vindicated by the tape. The money was lost at entry, and the fix lives on the buy side.

THE EMBARRASSING PART

The fleet is supposed to be self-improving: an optimizer reads each arm's real record every 6 hours and tunes its knobs inside hard bounds. After two days of "running", we audited it and found it had never applied a single change.

The database driver accepts a dynamic column name in WHERE position but not in SET position:

```js
// looks fine, throws "syntax error at or near $1" at runtime
await sql`update strategies set ${sql(field)} = ${value} ...`;
```

The throw was swallowed by an error handler, the audit insert was skipped with it, and the cron returned 200 every 6 hours. Green dashboards, zero learning. A second loop (realized PnL feeding back into the conviction model) was deployed in code but its scheduler job was never created, so it ran exactly zero times.

Both fixed. The rule we wrote down: an autonomous system's health is measured by rows in its audit tables, not by its HTTP status codes.

WHY PUBLISH LOSSES

Because every decision each agent takes is already on a public, tamper-evident ledger, and the whole point of that architecture is that we do not get to tell you a story. This entire postmortem was generated from the ledger and the position table.

All 90 trades, individually graded, with on-chain receipts, charts, and the downloadable dataset:

https://three.ws/blog/all-90-trades

The experiment continues. Budgets now flow toward whatever performs, and the next edition of this dataset will include the fleet's own self-tunings.

---

## Version B: thread (16 posts)

**1/**
We gave 11 AI agents their own Solana wallets and real SOL, pointed them at the pump.fun firehose, and stopped touching the keyboard.

90 real trades later, we published every single one. Including the losses.

The finding surprised us. 🧵

**2/**
The setup: an A/B fleet. Same execution, same safety rails, same exits. Only the entry judgment differs.

Some arms use frozen human rules (market cap, socials, creator history). Some gate on a trained conviction model. Three arms have no rulebook: an LLM judges every launch and logs a thesis.

**3/**
The honest headline: the fleet is DOWN 0.103 SOL on 1.93 SOL deployed across 90 trades.

We paid tuition. Here is what it bought.

**4/**
The only profitable cohort is the LLM-judged one.

```
cohort  trades  winrate  avg win  avg loss   net
LLM       33     24%     +52.3%   -10.8%   +0.015
rules     57     30%     +16.2%   -23.7%   -0.118
```

The rules arms are right MORE OFTEN and still lose 3x what the LLM arms make.

**5/**
Win rate is a vanity metric.

The model's edge is not prediction, it is selection. A rules arm buys everything mediocre enough to pass its filters. The model declines launches a threshold cannot describe: tickers trying too hard, week-old narratives, charts stairstepping on four wallets.

**6/**
6 of the 7 biggest wins belong to the LLM arms, all clean take-profit exits between +45% and +74%.

The take-profit turned out to be the only net-positive exit category in the entire dataset. Everything else is damage control.

**7/**
The scary lesson: a stop-loss is a request, not a guarantee.

Five positions had stops at -15% or -30% and realized -78% to -99.9%. The stop fired on time. The bonding curve's liquidity was already gone.

Tail defense happens at entry and sizing, not at exit.

**8/**
The trades are only half the record. While the fleet ran, it OBSERVED 82,994 launches in 3 days, scored 45,784 with our conviction model, and bought 72.

Under 1 in 1,000. The other 82,922 coins are the more interesting dataset.

**9/**
Because 42,995 of those skipped coins got outcome labels, we can test the conviction model at scale:

```
conviction  coins   pumped or graduated
unscored   18,510       10.5%
0-30       20,319       11.8%
30-50       4,041       17.4%
50+            71       77.5%
```

7x the base rate. Sitting in production.

**10/**
How many of the 110 coins that crossed conviction 50 did the fleet buy?

Zero.

One arm's gate was set at 35 (too low: it bought the 17% band). The other at 65. The highest score all window was 61. The two gates bracketed the money band and covered none of it.

Nobody chose this. Threshold audits matter.

**11/**
The biggest coin we skipped ran to a $161M ATH.

At the moment our systems watched it: 3 visible buyers, quality 43/100. Statistically identical to the 36,000 rugs in the same dataset. Its run started AFTER our window closed.

Minute-zero snipers are structurally blind to minute-thirty winners.

**12/**
We audited every sell for paperhands against each token's FULL candle history:

37 of 90 tokens never printed another trade after our exit. We were the last one out.

Of the 53 that kept trading, the highest post-exit print reached 1.5x our exit exactly zero times. Median: 0.43x.

Every single sell was vindicated by the tape. The losses live on the buy side.

**13/**
The embarrassing part: the fleet is supposed to self-improve. An optimizer reads each arm's record every 6 hours and tunes its knobs.

After two days of "running", we audited it. It had never applied a single change.

**14/**
The DB driver accepts a dynamic column in WHERE but not in SET:

```js
await sql`update strategies
  set ${sql(field)} = ${value}`;
// throws at runtime, swallowed,
// cron returns 200
```

Green dashboards. Zero learning. Fixed, plus a second loop whose scheduler job never existed.

**15/**
The rule we wrote down for every autonomous system we build:

Health is measured by rows in your audit tables, not by your HTTP status codes.

"The cron returns 200" and "the loop is learning" are unrelated statements.

**16/**
All 90 trades published and individually graded, with on-chain receipts, every model thesis verbatim, the 83k-coin counterfactual, the paperhands audit, charts, and the raw dataset as JSON.

No cherry-picking. The ledger does not let us.

https://three.ws/blog/all-90-trades

Next up: an arm that trades the conviction-50 crossing.
