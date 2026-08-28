# @three-ws/oracle-model

**The three.ws Oracle, running on your machine, with the real weights.**

The Oracle watches every pump.fun launch for its first ninety seconds and scores
it. This package is that scorer. Not a client for a scoring API: the actual
model, downloaded once and evaluated locally.

```bash
npm install @three-ws/oracle-model
```

```js
import { OracleModel } from '@three-ws/oracle-model';

const oracle = await OracleModel.fetch();      // one request, ~32KB

const verdict = oracle.score({
  organic_score: 0.82,
  unique_buyers: 41,
  buy_volume_sol: 26,
  snipe_ratio: 0.12,
  smart_money_count: 2,
  dev_sold: false,
  creator_launches: 3,
  creator_wins: 1,
});

verdict.score          // 90
verdict.tier           // 'prime'
verdict.upside         // 99  chance it runs
verdict.rugRisk        //  1  chance a first-sight holder ends down 50%+
verdict.giveBackRisk   // 41  chance it runs and hands it straight back
```

After `fetch()` there is no network. No API key, no rate limit, no per-call
billing, no telemetry. Score a million launches in a loop if you want.

## Why publish the weights

Most prediction products publish a number and ask to be believed. The model here
is a lookup table of bucket weights, so publishing it costs nothing and changes
what kind of claim we are making: every score three.ws has ever shown can be
reproduced offline, by anyone, forever.

That cuts both ways on purpose. `verify()` lets you re-measure the model against
outcomes **you** collected. If our published numbers do not survive contact with
an independent sample, you will find out from us.

## What the score means

The score line is **not a percentage**. A score of 86 claims a 45% chance, not
an 86% one.

| Tier | Score | Claims | Held out (n=74,211) |
|---|---|---|---|
| Prime | 86+ | P(win) >= 45% | 46.4% observed, n=304 |
| Strong | 72+ | P(win) >= 25% | 39.3% observed, n=858 |
| Lean | 56+ | P(win) >= 12% | 23.3% observed, n=1,415 |
| Watch | 34+ | P(win) >= 5% | 10.4% observed, n=2,790 |
| Avoid | 0+ | below that | 1.8% observed, n=68,844 |

Use `probabilityFromScore()` and `scoreFromProbability()` to convert. The
`performance()` method returns the live table, so the numbers above can never go
stale relative to the model you actually loaded.

### Three questions, not one

The model has three heads, fitted together on one design matrix:

| Head | Question | Base rate | Held-out AUC |
|---|---|---|---|
| `win` | Did it run **and** is a first-sight holder still up? | 2.94% | 0.840 |
| `rug` | Is a first-sight holder down more than half? | 11.36% | 0.918 |
| `moon` | Did it run at all (graduated, or peaked 3x+)? | 9.51% | 0.892 |

The published score anchors on `win`. That is deliberate, and it is the whole
reason this version exists: ranking on `moon` alone means a coin that spikes 3x
and goes to zero counts as a hit, which is how a prediction engine ends up
confidently recommending a chart that is a cliff.

**`giveBackRisk` is the number to watch.** It is `1 - P(win) / P(moon)`: given
this coin runs, how often does one like it hand the run straight back? A launch
with 80% upside and 90% give-back is not an opportunity, it is a trap, and no
single-headed score can tell you the difference.

## Every score shows its work

```js
const { math } = oracle.explain(signals);

math.formula          // 'p = 1 / (1 + exp(-(intercept + sum(term log_odds))))'
math.intercept        // -3.8771
math.terms            // one row per bucket, with its sample count
math.total_log_odds   // add the column up; you will land here
math.probability      // sigmoid of that
```

There is no hidden layer and nothing to trust. Every term is a bucket the model
was fitted on, published with the number of labeled launches behind it and what
actually happened to them:

```js
oracle.score(signals).why[0];
// {
//   feature: 'smart_money_count', label: 'proven wallets in the book',
//   bucket: '2-4', weight: 1.4698, samples: 351,
//   observed: { win: 0.5499, rug: 0, moon: 0.9886 }
// }
```

351 launches had 2 or 3 proven wallets buy inside the window. 55.0% of them ran
and held. Zero rugged. That is the claim, and the count is right beside it.

## Check our work

```js
const report = oracle.verify([
  { signals: {/* ... */}, outcome: true  },
  { signals: {/* ... */}, outcome: false },
]);

report.auc          // ranking quality on YOUR data
report.brier        // calibration error
report.reliability  // does a claim of 25% happen 25% of the time?
```

## Watch it learn

The model refits every six hours against fresh outcomes and only replaces the
live one if it beats it on held-out ranking. Every version, promoted or refused,
is public with the reason.

```js
const registry = await fetch('https://three.ws/api/oracle/model?view=registry')
  .then((r) => r.json());

const [latest, previous] = registry.versions;
const a = new OracleModel(await load(previous.id));
const b = new OracleModel(await load(latest.id));

a.diff(b).moves.slice(0, 5);
// [{ key: 'snipe_ratio/0.3-0.7', from: 0.41, to: 0.58, delta: 0.17, samples: 8102 }, ...]
```

That is a machine changing its mind, in public, with the evidence attached.

## API

| Method | What it does |
|---|---|
| `OracleModel.fetch(opts?)` | Download the live model. One request. |
| `new OracleModel(doc)` | Build from a document you already have (pin a version). |
| `.score(signals)` | Verdict: score, tier, three probabilities, `why`. |
| `.explain(signals)` | The same, with the arithmetic shown term by term. |
| `.performance(head?)` | Held-out AUC, Brier, precision, reliability curve. |
| `.verify(samples, head?)` | Re-measure the model on your own labeled data. |
| `.diff(other, threshold?)` | Every bucket weight that moved between two versions. |
| `.rank(launches, opts?)` | Sort a list of launches by score, best first. |
| `.probabilityFromScore(s)` | Convert a 0-100 score to the probability it claims. |
| `.scoreFromProbability(p)` | The inverse. |
| `.tierFor(score)` | Which rung a score sits on. |

Every signal is optional. A missing one lands in the model's fitted `null`
bucket, which carries real information (a coin nobody has sold yet is telling you
something) rather than being silently treated as zero. `verdict.confidence`
reports how much you actually supplied.

### Signals

| Signal | Meaning |
|---|---|
| `organic_score` | 0-1, demand that does not look manufactured |
| `bundle_score` | 0-1, how bundled the opening buys were |
| `snipe_ratio` | 0-1, share of supply taken at open |
| `timing_entropy` | 0-1, how spread out the buys were in time |
| `concentration_top1` / `top5` / `top10` | 0-1, holder concentration |
| `unique_buyers` / `unique_sellers` | wallet counts in the window |
| `buy_volume_sol` / `sell_volume_sol` / `net_volume_sol` | SOL flow |
| `trade_count`, `buy_sell_ratio` | tape shape |
| `largest_buy_sol`, `avg_buy_sol`, `median_buy_sol` | buy size distribution |
| `dev_buy_sol`, `dev_sell_sol`, `dev_sold` | what the creator did |
| `mc_sol_first_seen` | market cap in SOL when first observed |
| `smart_money_count` | proven wallets that bought in the window |
| `creator_launches`, `creator_wins` | creator track record (or `creator_record`) |
| `category` | narrative bucket (`animal`, `news`, `tech`, ...) |

Two more (`fresh_wallet_ratio`, `bubblemap_connectivity`) are accepted and
currently ignored: they are null in the training corpus, so the fitter drops them
rather than pretend to have learned something. `oracle.droppedFeatures` names
them. If they start arriving, the next refit picks them up with no code change,
here or upstream.

## A note on how the labels are made

The outcome a model is trained on matters more than the model. Ours used to ask
whether a coin's market cap had fallen under a hardcoded $3,000.

A pump.fun bonding curve with no real reserves is worth exactly
`30 * 1e9 / 1073000191 = 27.958993 SOL`. So that test was asking whether SOL was
above roughly $107.30. Of 206,428 coins labeled "rugged", 206,419 were under
$3,000; of 25,180 labeled survivors, the cheapest was exactly $3,000. Identical
dead curves, sorted by a price feed.

The labels now use two ratios taken from the same market-cap reading, so the SOL
price cancels out of both:

```
retained      = last_market_cap / ath_market_cap
hold_multiple = ath_multiple * retained
```

`rug` is `hold_multiple <= 0.5`. `win` is a run with `hold_multiple >= 1`. The
real rug rate is 11.4%, not the 91% the old rule reported, and it holds within
two points whether a coin is checked at 60 minutes or three days old, which is
what a property of the coin is supposed to do.

## Links

- **Oracle Lab** (weights, reliability curves, version diffs, live scorer): https://three.ws/oracle-lab
- **Model API**: https://three.ws/api/oracle/model
- **Docs**: https://three.ws/docs/oracle-model
- **Live feed**: https://three.ws/oracle

Apache-2.0
