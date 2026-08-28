# The Oracle model, and how to run it yourself

The Oracle watches every pump.fun launch for its first ninety seconds and scores
it 0-100. This document is the whole machine: what it predicts, how it is fitted,
why its outcome labels had to be rebuilt, how a new version earns the right to
replace the live one, and how to download the weights and score launches on your
own hardware with no API key.

- **Live feed**: [/oracle](/oracle)
- **The model, rendered**: [/oracle-lab](/oracle-lab)
- **The model, raw**: [`/api/oracle/model`](/api/oracle/model)
- **npm**: `@three-ws/oracle-model`

---

## 1. What the score means

**The score line is not a percentage.** A score of 86 claims a 45% chance, not an
86% one. This trips up everyone, including us: every calibration table we
published before 2026-08-14 used `score / 100` as the prediction, which
overstated the engine's own claim by up to four times and made a working ranking
look wildly overconfident.

| Tier | Score | Claims | Observed on held-out data |
|---|---|---|---|
| Prime | 86+ | P(win) >= 45% | 46.4% (n=304) |
| Strong | 72+ | P(win) >= 25% | 39.3% (n=858) |
| Lean | 56+ | P(win) >= 12% | 23.3% (n=1,415) |
| Watch | 34+ | P(win) >= 5% | 10.4% (n=2,790) |
| Avoid | 0+ | below that | 1.8% (n=68,844) |

Those observed numbers come from 74,211 launches the model had never seen. They
are recomputed on every refit and published live at
[`/api/oracle/model?view=card`](/api/oracle/model?view=card), so the table above
can go stale but the endpoint cannot.

### Three questions, not one

Version 3 fits three heads over one shared design matrix:

| Head | Question | Base rate | Held-out AUC |
|---|---|---|---|
| `win` | Did it run, **and** is a first-sight holder still up? | 2.94% | 0.840 |
| `rug` | Is a first-sight holder down more than half? | 11.36% | 0.918 |
| `moon` | Did it run at all (graduated, or peaked 3x+)? | 9.51% | 0.892 |

The published score anchors on `win`.

That choice is the entire reason v3 exists. v2 ranked `moon`, so a coin that
spiked 3x and went to zero counted as a hit. Over the seven days to 2026-08-28,
Prime-tier coins under v2 hit that target 58.2% of the time and rugged 53.0% of
the time, with 27.8% doing both. The engine was accurate and useless: it answered
"will this move" when every reader heard "should I hold this".

### The number to watch: give-back risk

```
giveBackRisk = 1 - P(win) / P(moon)
```

Given this coin runs, how often does one like it hand the run straight back? A
launch with 80% upside and 90% give-back is not an opportunity, it is a trap, and
no single-headed score can tell the two apart. It is published on every verdict,
stored on every scored coin (`oracle_conviction.give_back_risk`), and indexed, so
the feed can be sorted by it.

---

## 2. The label problem, and why it mattered more than the model

For most of this engine's life, its outcome labels measured the price of SOL.

`deriveOutcome` decided a rug with two tests: did the coin fall to 25% or less of
its market cap at first sight, or is its market cap under $3,000.

A pump.fun bonding curve holding no real reserves is worth a fixed amount. The
launch parameters put 30 virtual SOL against 1,073,000,191 virtual tokens over a
1e9 supply:

```
30 * 1e9 / 1_073_000_191 = 27.958993 SOL
```

No coin on the curve can be worth less than that. We first see a coin inside its
opening ninety seconds, when its cap is 28-38 SOL, so **the floor is 73-99% of
the market cap at first sight** and the "fell to 25%" branch is unreachable for
almost every launch that has ever existed.

That left a hardcoded dollar threshold judging an asset with a fixed SOL price.
Measured over the ten days to 2026-08-28:

| Group | n | Under $3,000 | Minimum |
|---|---|---|---|
| labeled `rugged`, not graduated | 206,428 | 206,419 (99.996%) | $0 |
| labeled survivor, not graduated | 25,180 | 0 | exactly $3,000 |

Both groups are the same object: an empty bonding curve. 25,180 completely dead
coins were labeled survivors because SOL happened to be above roughly $107.30
when the labeler reached them. It is also why the daily rug rate sat at 90-94%
for weeks and then dropped to 55.3% on 2026-08-27, which is not a change in the
market, it is SOL crossing a line.

Everything downstream that subtracted rugs from a win rate was reading a price
feed.

### The fix

Two ratios, both taken from the **same** market-cap reading, so the SOL price
cancels out of each:

```
retained      = last_market_cap_usd / ath_market_cap_usd
hold_multiple = ath_multiple * retained
```

`hold_multiple` is what a holder who bought at first sight and held would have.

```
moon = graduated OR ath_multiple >= 3
rug  = NOT graduated AND hold_multiple <= 0.5
win  = moon AND hold_multiple >= 1
```

Neither ratio can be moved by the price of SOL, and both backfill exactly from
columns we already stored, so the historical corpus was corrected in a single
migration with no re-fetching.

**The real rug rate is 11.4%, not 91%.** And it holds within two points across
every observation-age bucket from 60 minutes to three days, which is what a
property of the coin is supposed to do:

| Checked at | n | graduated | rug | win | moon |
|---|---|---|---|---|---|
| 60-90 min | 238,138 | 2.89% | 11.02% | 3.02% | 10.06% |
| 90-180 min | 1,215 | 2.39% | 10.45% | 2.55% | 9.22% |
| 6-24 h | 481 | 1.04% | 7.48% | 2.29% | 10.60% |
| 1-3 d | 9,228 | 1.28% | 9.27% | 1.34% | 7.49% |
| 3 d+ | 13,746 | 0.77% | 9.06% | 1.21% | 6.29% |

`label_version` marks which rule judged a row: `1` for the USD-threshold rule,
`2` for the price-independent one. **The fitter trains on version 2 only.**
Mixing them poisons two heads out of three; trained on version 1 labels, the
survival head scored an AUC of 0.484, which is worse than guessing.

There is one thing the old rule got right that the new one deliberately drops: a
coin that never moved and now sits at the empty curve is a **dud**, not a rug.
Nobody was taken, because there was nothing to take. `at_floor` records that
state exactly (the curve is within 2% of `27.958993 SOL`) and is published
separately rather than folded into the rug flag.

---

## 3. How the model is fitted

One bucketed logistic regression per head, over a shared one-hot design matrix.
Not a black box: **every weight is a per-bucket log-odds contribution published
with its sample size and the observed outcome rate behind it.**

Buckets rather than slopes, because several signals are genuinely non-monotone.
Mid-range snipe ratios and mid-range top-10 concentration both beat their own
extremes, and a linear term would fight the data at both ends. "Low
concentration" ninety seconds in usually means nobody bought.

```
score = anchors(sigmoid(intercept + sum of one bucket weight per feature))
```

The code is [`api/_lib/oracle/fit.js`](https://github.com/nirholas/three.ws/blob/main/api/_lib/oracle/fit.js),
shared by the CLI and the production cron so the terminal and the server can
never disagree about what "the model" means.

### Features drop themselves

Any feature whose runner-up bucket holds fewer than 200 rows carries no fittable
information and is dropped, by name, into the report.

Deliberately **not** a share test. `smart_money_count` is non-zero on 0.3% of
launches, and those launches win 82% of the time against a 4.55% base. A rule
that dropped rare signals would throw away the strongest thing this dataset
knows.

Two features are dropped today, and the reason is an outage rather than a
property of the market:

| Dropped | Why |
|---|---|
| `fresh_wallet_ratio` | null in 300,000 of 300,000 recent rows: nothing populates `observation.walletMeta` |
| `bubblemap_connectivity` | needs `HELIUS_API_KEY`, which is not set; 42 of 713,908 recent wallets resolve a funder |

They are named on [/oracle-lab](/oracle-lab) and in the API response instead of
silently vanishing, because a signal that stopped arriving is an outage somewhere
upstream and the model is the first place it becomes visible. **If they start
arriving, the next refit picks them up with no code change.**

A third, `coordination_score`, is kept but is close to worthless: it computes as
`bundle_score * 0.6 + (bubblemap ?? 0) * 0.4`, and with bubblemap null it is a
scaled copy of `bundle_score`. The live intel weights list the two as identical
to four decimal places.

### Smart money is fitted now, not assumed

v2 added between +0.35 and +0.75 log-odds by hand when proven wallets showed up,
because "214 proven wallets platform-wide" was too thin to fit. It is not thin
any more:

| Proven wallets in the window | n | win | rug | run |
|---|---|---|---|---|
| 0 | 296,111 | 2.85% | 11.38% | 9.29% |
| 1 | 347 | 25.65% | 2.59% | 95.39% |
| 2-3 | 351 | **54.99%** | **0.00%** | 98.86% |
| 4+ | 34 | 11.76% | 0.00% | 97.06% |

Two or three proven wallets buying inside the observation window means a 55%
survivable-win rate and zero rugs in 351 samples.

When the active model carries a fitted `smart_money_count` feature, the expert
overlay's smart-money and creator-history terms **stand down automatically**.
Counting the same evidence twice is not conservatism, it is a bug. What survives
in the overlay is only evidence the training set has no column for: whether the
proven wallets are already selling, whether any of them are tagged ruggers, and
the serial-rugger score ceiling (a product guarantee, not a probability estimate:
a dev with a graveyard behind them can never present as Strong).

---

## 4. How a new model earns the right to ship

`/api/cron/oracle-refit` runs every six hours. It loads the labeled set, fits
three heads with a time-split holdout, and then has to get past a gate that can
say no.

This part matters. An automated retrain that always ships whatever it just fitted
is not a learning loop, it is a single point of failure on a timer: one bad data
day and production is serving a model nobody looked at.

| Check | Requirement |
|---|---|
| `fit_complete` | every epoch ran; a deadline-truncated fit is under-trained, not wrong, and must not quietly ship |
| `absolute_auc` | scoring head AUC >= 0.70, incumbent or not |
| `tier_honesty` | every populated band still earns at least 70% of the probability it claims |
| `feature_set` | did not lose more than 3 features (that is a broken signal source, not learning) |
| `auc_gain` | beats the incumbent by >= 0.004 AUC, which is more than SGD ordering noise |
| `no_regression_*` | no other head fell by more than 0.01 |

The gain bar is not zero on purpose. Two fits on nearly the same data differ by a
few thousandths of AUC from shuffle ordering alone, and promoting on that noise
would rewrite the live model every six hours, making every published score a
moving target and every track record unreproducible.

Every candidate is stored either way, **including the refused ones, with the
reason**, in `oracle_model_versions`. A registry that shows only the winners is a
highlight reel, not a record.

```
GET /api/oracle/model?view=registry
```

### Where the weights live

They used to be a JSON file baked into the container at build time, so the only
thing that could refit them was a human running a script by hand. Nobody did.
Between 2026-08-09 and 2026-08-28 the model answered every question with a
92,906-row opinion while eight times that much evidence piled up behind it, and
on a current holdout it had given up six points of top-decile precision (53.7%
against 59.8% for a fresh fit).

Now:

- **`oracle_model_versions`** holds the promoted weights. `ensureActiveModel()`
  loads them with a 2-minute TTL, so a promotion is live platform-wide inside one
  scoring cycle with no deploy.
- **`api/_lib/oracle/conviction-model.json`** is the bootstrap a cold container
  boots on, and what the tests run against.
- If the database read fails, whatever model is already installed keeps scoring.
  A scoring engine that returns nothing because it could not check for a newer
  opinion is strictly worse than one using a slightly older one.

Every stored verdict records `model_version_id`, so any score on the platform can
be traced to the exact weights that produced it and recomputed offline.

---

## 5. Run it yourself

```bash
npm install @three-ws/oracle-model
```

```js
import { OracleModel } from '@three-ws/oracle-model';

const oracle = await OracleModel.fetch();   // one request, ~32KB

const v = oracle.score({
  organic_score: 0.82,
  unique_buyers: 41,
  buy_volume_sol: 26,
  snipe_ratio: 0.12,
  smart_money_count: 2,
  dev_sold: false,
  creator_launches: 3,
  creator_wins: 1,
});

console.log(v.score, v.tierLabel);   // 90 Prime
console.log(v.upside, v.giveBackRisk, v.rugRisk);
```

After `fetch()` there is no network. No key, no rate limit, no telemetry. Every
signal is optional: a missing one lands in the model's fitted `null` bucket,
which carries real information (a coin nobody has sold yet is telling you
something) rather than being treated as zero.

### Show the arithmetic

```js
const { math } = oracle.explain(signals);

math.formula        // 'p = 1 / (1 + exp(-(intercept + sum(term log_odds))))'
math.intercept      // -3.8771
math.terms          // one row per bucket, with its sample count
math.total_log_odds // add the column up by hand; you will land here
```

### Check our work

```js
const report = oracle.verify([
  { signals: { /* ... */ }, outcome: true },
  { signals: { /* ... */ }, outcome: false },
]);

report.auc          // ranking quality on YOUR data
report.brier        // calibration error
report.reliability  // does a claim of 25% happen 25% of the time?
```

If our published numbers do not survive contact with an independent sample, this
is how you find out, and we would rather you could.

### Watch it change its mind

```js
const older = new OracleModel(docFromRegistry(42));
const newer = new OracleModel(docFromRegistry(43));

older.diff(newer).moves.slice(0, 5);
// [{ key: 'snipe_ratio/0.3-0.7', from: 0.41, to: 0.58, delta: 0.17, samples: 8102 }, ...]
```

The same diff is available server-side at
`/api/oracle/model?view=diff&from=42&to=43`.

---

## 6. API reference

### `GET /api/oracle/model`

The active model in full: card, weights, holdout, provenance.

| Query | Effect |
|---|---|
| `view=card` | just the summary: what it predicts, how well, how old, what it dropped |
| `view=registry` | every version, promoted or refused, with the decision |
| `view=diff&from=&to=` | every bucket weight that moved between two versions |
| `network=` | `mainnet` (default) or `devnet` |

Public, no auth, cached 60s at the client and 300s at the edge.

### The verdict object

| Field | Meaning |
|---|---|
| `score` | 0-100, anchored on P(win). Not a percentage. |
| `tier` / `tierLabel` | `avoid` \| `watch` \| `lean` \| `strong` \| `prime` |
| `probabilities` | raw `win`, `rug`, `moon` |
| `upside` | P(runs), 0-100 |
| `rugRisk` | P(holder down more than half), 0-100 |
| `giveBackRisk` | P(hands the run back \| it runs), 0-100 |
| `survival` | `100 - rugRisk` |
| `confidence` | share of the model's signals actually supplied |
| `reasons` | strongest evidence first, each with its bucket rate and sample count |
| `badges` | `smart-money`, `structure-flag`, `pedigree-flag`, `rug-risk`, `give-back`, `thin-data`, `momentum`, `news` |
| `predicts` | what the score claims, in words |
| `model` | version, fit time, training rows, scoring head |

---

## 7. Operations

| Task | Command |
|---|---|
| Fit and report, write nothing | `node scripts/oracle-fit.mjs` |
| Refresh the bootstrap in the image | `node scripts/oracle-fit.mjs --write` |
| Machine-readable report | `node scripts/oracle-fit.mjs --json` |
| Cap the training window | `node scripts/oracle-fit.mjs --rows 200000` |
| Trigger a refit by hand | `GET /api/cron/oracle-refit` (cron auth) |

`DATABASE_URL` lives in `.env.local`, not `.env`. The fitter reads both; it used
to read only `.env` and died with "DATABASE_URL not set", which is a large part
of why the model went nineteen days without a refit.

| Table | Holds |
|---|---|
| `oracle_training_set` | never-pruned (features, outcome) per labeled coin, with `label_version` |
| `pump_coin_outcomes` | rolling outcome labels, plus `retained` / `hold_multiple` / `at_floor` |
| `oracle_model_versions` | every fitted model, its holdout, its promotion decision |
| `oracle_conviction` | the live verdict per coin, with `rug_risk` / `upside` / `give_back_risk` / `model_version_id` |

## See also

- [Oracle: the conviction engine, end to end](/docs/oracle)
- [Coin Intelligence](/coin-intel), the observation pipeline that produces the signals
- [Oracle Lab](/oracle-lab), all of the above rendered
