# Oracle: the conviction engine, end to end

The complete story of Oracle: why we built it, how the scoring model works, the exact math, the agent action loop, every feature on the platform that runs on it, the x402 paid intel layer, the MCP path, examples, tutorials, and the honest limits.

The first minutes of a new coin are the most asymmetric market on earth. Insiders know the creator's history, which wallets are loading up, and whether the supply is clean. You see a ticker and a green candle. By the time the answer is obvious, the trade is gone.

Oracle is our answer to that. It watches every pump.fun launch, scores it from 0 to 100, publishes the score, the reasoning, and the track record in public, and gives your 3D agent a machine readable signal it can act on without you re-implementing a single decision rule. It is live at three.ws/oracle, and the full reference, from the thesis to the exact pillar math to a PhD appendix on calibration, is at three.ws/oracle/docs.

This is everything about it.

## Why we built it

Three reasons, in order of importance.

**First, the information problem is real and it is solvable.** The edge in early pump.fun trading is not speed, it is context: who is this creator, who is buying, is the supply structure honest, is the story real. All of that context exists on chain and in public data. Nobody fuses it in time. We already run a data brain with full coverage of the pump.fun firehose, so we were sitting on the raw material. Oracle is the fusion layer on top.

**Second, agents need a number, not a dashboard.** three.ws is a platform where 3D agents hold wallets, trade, and pay each other. An autonomous agent cannot read a chart and feel conviction. It needs an explicit, calibrated, machine readable verdict with decision rules attached. Every scoring system we found was built for human eyeballs. Oracle is built agent-first: the signal endpoint returns an action, a confidence, and a size factor, so the hard part of the decision ships with the data.

**Third, the flywheel benefits everything we run.** Every coin Oracle watches sharpens the priors. Every graded outcome tunes the calibration. Every proven wallet added to the pedigree ledger makes the WHO pillar harder to fool. And because one engine feeds the sniper, the Play worlds, the agent economy demos, the alerts, and the leaderboards, every improvement lands everywhere at once. We did not build a feature. We built the intelligence layer of the platform.

## The system at a glance

Oracle is a pipeline, and every stage of it is watchable live at three.ws/pipeline.

- **The data brain** ingests the pump.fun firehose: every launch, every trade, every wallet. Oracle does not re-ingest anything; it reads the brain.
- **The score loop**, a long-lived worker, walks the brain's recent coins and keeps a fresh fused verdict cached for each one, classifying its narrative on first sight. New coins get scored within seconds of appearing.
- **The conviction store** holds every verdict with its full transparent breakdown: score, tier, four pillar subscores, weights, plain-language reasons, badges.
- **The feed and streams** publish it: the live board at three.ws/oracle, JSON reads for machines, and server-sent event streams for anything that wants sub-5-second latency.
- **The agent loop** polls newly scored coins and, for every armed agent, runs the decision rules and executes when a coin clears the bar.
- **The settle loop** closes the circle: once the brain labels a coin's ground truth outcome (graduated, rugged, all time high multiple), every agent action on that coin is graded, and the backtest updates.

One design commitment holds the whole thing together: scoring is a pure, side-effect-free function of assembled intel. Everything stateful, ingestion, persistence, execution, settlement, lives outside it. That boundary is why the math is testable, the verdicts are reproducible, and the same engine powers the live feed, the API, and an agent's decision with identical results.

## The model: fitted from real outcomes

Since 2026-08-09 the conviction engine is a bucketed logistic model fitted on the platform's own labeled outcome history, not a hand-tuned point system. v2 fitted one target ("good": the coin graduated or reached a 3x-or-greater ATH multiple) on 92,906 launches. Since 2026-08-28 the engine is **v3**: three heads fitted over one shared design matrix, all reading a `hold_multiple` that cancels the SOL price out of the label (`win`: it ran and a first-sight holder is still up; `rug`: a first-sight holder is down more than half; `moon`: it ran at all, the v2 target). The published 0-100 score anchors on `win`, and rug risk is published beside it as its own number rather than folded in (`rugRisk`, `upside`, `giveBackRisk` on every verdict). Every launch-time signal is bucketed by its empirically observed ranges, each bucket carries a fitted log-odds weight per head, and the fused sum passes through a sigmoid to yield a calibrated probability for each head. The promoted weights live in `oracle_model_versions` and `/api/cron/oracle-refit` refits and re-promotes them behind a gate that can refuse a candidate; `api/_lib/oracle/conviction-model.json` is the bootstrap a cold container scores with until it reads the active row (each bucket ships with its sample size and observed rate per head), and `scripts/oracle-fit.mjs` refreshes that bootstrap from the durable training snapshot (`oracle_training_set`). The whole model, labels and promotion gate included, is written up in [The Oracle model](oracle-model.md).

The honest numbers. v2, measured on a time-split holdout (the newest 25 percent of labels, never seen in training): AUC 0.879 (the hand-tuned v1 engine measured 0.627 on the same window), 62.5 percent of coins in the top decile of score were good against an 11.7 percent base rate, and the Prime tier observed 72.7 percent good. v3, held out on 74,211 launches it never saw: win AUC 0.840, rug AUC 0.918, moon AUC 0.892. The live reading is always at `/api/oracle/model?view=card`.

The fit corrected several v1 beliefs that were backwards at the 90-second observation window:

- **Top-10 holder concentration in the 0.3-0.9 band is a positive signal** (5-8x base rate), because "low concentration" 90 seconds in usually means nobody bought at all. v1 penalized it.
- **A mid-range snipe ratio (10-70 percent of the open) is a positive signal** (2.7-3.6x base). Bots racing an open is evidence of demand; the poison is when snipers are 70 percent or more of everything. v1 penalized from 45 percent up.
- **An oversized dev buy is not a red flag** (6+ SOL: 1.36x base). v1 subtracted 14 points for it.
- **Category priors barely matter.** The observed spread across meme/animal/ai/tech is a fraction of what v1's hand-set priors claimed, and roughly inverted in places (tech: 0.32x base; "unknown": 1.52x).
- **The dead-on-arrival signal v1 ignored is market cap at first sight**: below 28 SOL observes 0.27x base. Also newly used: buy-timing entropy (0.6-0.8: 3.56x), total early buy volume (25+ SOL: 5.98x), and the creator's launch history (5+ launches with zero graduations: 0.26x; a creator with any prior graduation: 1.49x).

The four pillars remain as the presentation layer: every feature belongs to WHO (pedigree), HOW (structure), WHAT (narrative), or MOVE (momentum), each pillar bar shows what that pillar's evidence alone would imply, and the pillar weights shown in the API are derived from the fitted model (each pillar's share of the total log-odds range its features span) instead of hand-picked constants.

### The features, by pillar

Each feature below is bucketed and carries fitted weights in `conviction-model.json`. The observed good-rates quoted are from the training set at first fit; the shipped JSON is always the source of truth.

**WHO (pedigree)**: the creator's launch record (`creator_record`: first launch 1.9x base; any prior graduation 1.5x; 5+ launches with none graduated 0.26x), dev buy size, whether the dev sold inside the observation window, and (since v3) the count of proven smart-money wallets buying in the window, fitted directly. The expert priors the model cannot fit sit on top (below).

**HOW (structure)**: organic-demand score (below 0.2: 0.11x base; 0.8+: 5.1x, the single strongest signal), bundle score, snipe ratio, coordination score, buy-timing entropy, and top-1/top-10 holder concentration with their empirically non-monotone buckets.

**WHAT (narrative)**: the classified category. Deliberately the lightest lane now: the outcome data shows category explains far less than v1's priors assumed.

**MOVE (momentum)**: unique early buyers (40+: 6.8x base), buy/sell ratio, total early buy volume (25+ SOL: 6.0x), largest single buy, average buy size, and market cap at first sight (below 28 SOL: 0.27x, the dead-on-arrival tell).

### The smart-money overlay

Under v2, proven wallets were too rare to fit statistically, so they adjusted the fused log-odds as hand-set expert priors (+0.35 to +0.75 log-odds for proven wallets in the book, +0.3 for a 40-percent-plus proven share of buy volume). v3 fits `smart_money_count` directly (two or three proven wallets buying inside the window observed a 55 percent survivable-win rate and zero rugs across 351 samples), and when the active model carries that feature the overlay's smart-money and creator-history terms stand down automatically, so the same wallets are never counted twice. What survives in the overlay is evidence the training set has no column for: each flagged rugger/dumper wallet subtracts 0.45 (up to three), smart money already exiting half its position subtracts 0.7 (a quarter: 0.35), and the serial-rugger ceiling below. A wallet counts as proven if labelled `smart_money`/`kol` or scoring 70+; since 2026-08-09 a wallet also earns `smart_money` at 8-plus judged coins with a 35-percent-plus win rate, a sustained ~3x edge over the market.

### One cap survives: the serial rugger

v1 had seven different hard ceilings. The outcome data supported exactly one, so exactly one remains: a creator with 3 or more launches and zero graduations (or a wallet flagged `rugger`) ceilings the final score at 45, inside Watch. A graveyard dev can never present as Strong, no matter how clean the launch looks. Every other v1 cap, including the unknown-pedigree ceiling that silently pinned the entire feed below Strong for the engine's whole first two weeks, is gone: missing data now reads as the fitted null-bucket evidence it is, not as a verdict.

## Fusion, tiers, and badges

The fusion is a sum in log-odds space, then a sigmoid, then a fixed monotone map onto the public 0-100 ladder:

```
z_head = intercept_head + sum(fitted bucket weights for that head) + expert priors the model cannot fit
p_head = 1 / (1 + e^(-z_head))      # one calibrated probability per head: win, rug, moon
score = piecewise-linear map of p_win   # anchors: 5% -> 34, 12% -> 56, 25% -> 72, 45% -> 86
score = min(score, 45 if serial-rugger creator)
rugRisk = 100 * p_rug;  upside = 100 * p_moon;  giveBackRisk = 100 * (1 - p_win / p_moon)
```

The tier ladder is unchanged in public shape, but each boundary states a measured probability of the `win` event (the coin runs and a first-sight holder is still up), and every fit grades it on launches it never saw. The rates below are the v3 bootstrap's holdout (74,211 launches, 3.2 percent base rate); the model refits on a clock, so the live table is `/api/oracle/model?view=card`:

| Tier | Score | Claims | Observed on holdout | n | vs base |
| --- | --- | --- | --- | --- | --- |
| **Prime** | 86 and up | P at least 45 percent | 47.6 percent | 267 | 15.0x |
| **Strong** | 72 to 85 | P at least 25 percent | 40.3 percent | 852 | 12.7x |
| **Lean** | 56 to 71 | P at least 12 percent | 23.4 percent | 1,418 | 7.4x |
| **Watch** | 34 to 55 | P at least 5 percent | 10.7 percent | 2,725 | 3.4x |
| **Avoid** | below 34 | P under 5 percent | 1.8 percent | 68,949 | 0.6x |

Monotone, separated, and honest at every rung, which is why the ladder stays where it is. Every tier clears the probability it claims, and the promotion gate refuses any refit whose populated bands stop earning at least 70 percent of what they claim. The ladder lives in one place, `TIERS` and `SCORE_ANCHORS` in `api/_lib/oracle/conviction.js` (the anchors come from the active model's `tier_probability_anchors`), so the boundaries the API returns and the ones the UI paints can never disagree.

Only prime and strong are act signals. A conviction engine that likes everything is a hype engine.

Every verdict also carries compact badges the UI renders as pills: `smart-money` (three or more proven wallets in), `structure-flag` (a strongly negative fitted structure bucket), `pedigree-flag` (the rugger cap fired), `news` (riding a live story), `momentum` (that pillar alone would reach prime, subscore 86 plus), `thin-data` (most model features unobserved), `rug-risk` (the rug head at 60 percent or more), and `give-back` (give-back risk at 70 percent or more on a coin with at least 25 percent upside: a likely run that is likely to be handed straight back). There is deliberately no `prime` badge: the card paints the tier beside the score already, so it only ever restated the pill next to it, and a badge every top card carries is decoration rather than signal. The same reasoning moved `momentum` up from 72, where it fired on 93 percent of the live feed.

And every verdict ships its reasons in plain language ordered by evidence strength, each quoting the observed outcome rate for its bucket. Each reason carries three fields beside the sentence, so a surface can render the evidence without parsing English back apart:

| Field | Example | What it is |
| --- | --- | --- |
| `text` | `40+ early buyers: 80% of similar launches worked (6.8x base rate)` | The full sentence |
| `subject` | `40+ early buyers` | What the model saw, in trader units |
| `rate` | `80` | Percent of that bucket's training launches that won, on the head the score anchors on |
| `lift` | `6.8` | How many times the base rate that is |

`subject` is phrased per fitted bucket rather than printed from the model's own labels: "40+ early buyers", not "unique_buyers >=40". You never get a bare number, and you never get a raw one either.

### The holder's number: `hitRateFor(score)`

A score claims a probability; a holder wants to know how often that claim came true. So every verdict and every feed row also carries the measured rate behind the score:

```
hit_rate       fraction of held-out launches in this probability band that
               won (ran, and a first-sight holder was still up)
hit_rate_lift  how many times the holdout's base rate that is
hit_rate_n     how many held-out launches the band's rate was measured over
```

Since v3 it comes from the active model's own holdout reliability curve, shipped with the weights (`holdout.win.reliability` in the model document): `hitRateFor(score)` converts the score back to the probability it claims, finds the reliability band that probability falls in (the bands follow the tier anchors, `0.45-1` for Prime and so on), and returns that band's observed rate, its sample size, and the holdout base rate. Reading the model's own holdout rather than a separate hand-generated file means the published rate is always the one that exact model earned on launches it had never seen, and it can never drift out of sync with the weights. The earlier `api/_lib/oracle/conviction-calibration.json` (an isotonic fit of realized production win rates per 10-point band, built on the SOL-price-dependent rug flag) is no longer read by the engine; `scripts/oracle-calibrate.mjs` still fits and prints those production rungs for checking tier boundaries against realized outcomes. Both numbers are real and they answer different questions; the rule is that any surface showing one has to say which one it is showing.

## Anatomy of a score

The coin drawer the product shows when you click any launch is the score, fully unpacked, the same object the API returns, rendered for a human. Walking it top to bottom mirrors the model exactly:

- **The four pillar bars**, WHO / HOW / WHAT / MOVE, are the sub-scores: what each pillar's own fitted evidence would imply alone, on the same probability-to-score map as the big number.
- **"Why this score"** is the `reasons[]` array, strongest evidence first, each line tagged to its pillar and quoting the observed outcome rate for the bucket it hit, e.g. "unique early buyers >=40: 80 percent of similar launches worked (6.8x base rate)" (MOVE) or "creator has 5+ prior launches, none graduated: rug pattern" (WHO). The engine cites its training data instead of asserting adjectives.
- **Structure / wallet-graph / buy-pattern** expose the raw HOW inputs (organic-buy percent, bundle percent, the funder graph) so you can audit the guardrail.
- **Who's-in** is the live pedigree roster: every notable wallet, its label, and its track record.
- **Live trades** streams the coin's buys and sells in real time, each annotated with the trader's wallet archetype.
- **Agent transactions** is every three.ws agent buy and sell in this exact coin, read from the same public custody ledger the wallet-story feed uses (`GET /api/pulse?type=trades&mint=<mint>`). It renders two ways: a scannable ledger (agent, side, size, time, on-chain proof) and, in the chart's **Agent trades** view, a marker overlay: each buy or sell plotted as a bubble on the native price series at the candle close nearest its on-chain timestamp, buys under the line and sells over it, clustered with a count when a window gets busy. It is the reverse index of the per-agent wallet story: the wallet story answers "what did this agent trade" and links each row to the coin; this answers "which agents traded this coin" and shows them on the price.

Every field here is also available programmatically from `GET /api/oracle/coin?mint=…`.

## Data and ingestion

Oracle reads from a separate full-coverage data brain rather than touching the chain itself. Five brain tables feed every score, and Oracle queries each one defensively: a missing or younger table degrades the affected pillar gracefully rather than failing the whole verdict.

- `pump_coin_intel` feeds HOW, WHAT, and metadata: symbol, name, image, category, creator, bundle_score, organic_score, snipe_ratio, fresh_wallet_ratio, concentration_top10, bubblemap_connectivity, risk_flags, buy/sell counts, dev buy/sold.
- `coin_smart_money` feeds WHO (base): smart_money_score, smart_wallet_count, proven/total buy lamports, notable[].
- `pump_coin_wallets` feeds WHO and HOW: per-wallet buy/sell lamports, is_creator, funder (cluster source).
- `wallet_reputation` feeds WHO (labels): label, smart_money_score, win_rate, early_win_rate, dump_rate, coins_traded, creator_count, creator_wins.
- `pump_coin_outcomes` feeds evidence and settlement: graduated, rugged, ath_multiple, last_market_cap_usd.

"Smart money" is not a hard-coded list. It is continuously re-earned from outcomes in the `wallet_reputation` graph. For wallets the brain hasn't judged yet, Oracle seeds a cold-start prior from a curated known-wallet set sourced from public KOL/wallet intelligence, so a brand-new coin still gets a useful pedigree read on its first scoring pass. Precedence is always earned reputation, then prior, then unproven.

## The worker

A single long-lived Node process runs three independent, self-scheduling loops. They share nothing but the database, so a slow scoring pass never delays an agent acting, and a stuck confirmation never freezes scoring.

- **Score loop**, every 15 seconds, batch 20. Finds recent launches that are new or stale (last scored more than 3 minutes ago), scores each (assemble, classify, fuse, persist), and appends history on material change. Keeps the cache warm.
- **Agent loop**, every 3 seconds. For each armed watch, evaluates freshly-scored coins against the agent's bar and budget, executes a buy when the gates pass, and fires alerts. Dedups so an agent never acts twice on one coin.
- **Settle loop**, every 60 seconds, batch 100. Finds open actions whose coin now has a resolved outcome, grades each win/loss/flat, marks PnL to market, and closes the learning loop.

If the conviction cache is empty (fresh deploy), the feed endpoint scores a handful of recent coins on the spot, database-only, no LLM, so the UI is never blank while the score loop catches up.

The worker is configured entirely by environment. Selected knobs, with defaults: `ORACLE_MODE=simulate`, `ORACLE_NETWORK=mainnet`, `ORACLE_SCORE_INTERVAL_MS=15000`, `ORACLE_AGENT_INTERVAL_MS=3000`, `ORACLE_SETTLE_INTERVAL_MS=60000`, `ORACLE_SCORE_BATCH=20`, `ORACLE_RESCORE_AFTER_SEC=180`, `ORACLE_MAX_TRADE_SOL=0.25` (absolute per-trade ceiling), and `ORACLE_GLOBAL_KILL=1` (halts all agent and settle activity while scoring continues). Live mode additionally requires the secret used to decrypt agent wallets, and refuses to start without it.

## The agent action loop

This is the part built for owners of 3D agents, and it is an explicit, owner-only opt-in.

Arm your agent at three.ws/oracle/arm. The config is the full risk envelope, not a toggle: minimum score and tier, which narrative categories are in scope, per-trade SOL size, a max daily SOL budget, a max number of open positions, whether at least one proven smart wallet must already be in the coin, size scaling, and an optional Telegram chat for alerts.

For every armed agent, on every freshly-scored coin, a pure decision function runs a sequence of gates. If any gate blocks, the agent passes; if all clear, it sizes and buys. The gates:

- **Armed**: blocks when the watch isn't armed.
- **Min score / tier**: blocks when conviction is below the agent's bar.
- **Narrative filter**: blocks when the category is not in the agent's allow-list (if set).
- **Require smart money**: blocks when no proven wallet is in yet (if required).
- **Max open positions**: blocks when the agent is already at its concurrency cap.
- **Daily budget**: blocks when this buy would exceed the 24h spend cap.

Then the worker takes over. The agent loop polls newly scored coins, runs the pure decision function against every armed watch, and each agent acts on each coin at most once. Execution is guarded in depth:

- **Simulate is the default.** Simulate mode records a realistic action row, entry market cap, conviction, size, and spends nothing, so you can watch your agent work risk free for as long as you want.
- **Live mode** loads the agent's own custodial keypair, builds a pump.fun buy through the same trade client the production sniper uses, signs, and broadcasts through Jito bundles.
- **A hard per-trade SOL cap** sits in the executor regardless of what the config says.
- **A global kill switch** (one environment flag) halts all agent actions platform wide while scoring continues.
- **Full error capture**: a bad fill logs as failed instead of crashing the loop.

Position size is the agent's base per-trade amount, optionally scaled by conviction, up to 1.5 times as the score climbs from the agent's minimum toward 100, so the agent leans harder into the strongest plays without ever exceeding its caps. The exact form: `size = base · (1 + clamp((score − min)/(100 − min), 0, 1)·0.5)`, then `size = min(size, ORACLE_MAX_TRADE_SOL)`. Live routing builds buy instructions via the pump SDK with 10 percent slippage, fetches a fresh blockhash, and either sends a raw transaction (up to 3 retries, 60 second confirm race) or, when Jito is enabled, prepends a small tip transfer to a rotating tip account and submits the pair as a bundle. The action is written as `filled` with the signature (or `jito:<bundleId>`), `skipped` if the agent has no wallet, or `failed` on any on-chain error, never silently dropped.

Every action, simulated or live, streams to the trading floor at three.ws/activity over server-sent events with sub-5-second latency. Your agent trades in public.

## Receipts: the track record is the product

A score you cannot audit is an opinion. Oracle grades itself in public, and the grading is mechanical.

**Outcome grading.** Once the data brain labels a coin's ground truth (graduated, rugged, ATH multiple), every agent action on that coin is settled: did the conviction call pay off, what was the peak multiple, what was the realized PnL. A scored coin is a win if it graduated, or reached a 2 times or greater ATH multiple without rugging and without marking below half of entry; a loss if it rugged, marked below 0.5 times, or peaked below 1.2 times — loss conditions outrank a peak-based win, because a 2× wick on a position that then went to zero was exit liquidity, not a win; flat in between. Realized PnL is marked to market as `size · (current_mc / entry_mc − 1)`. This turns the action ledger into an honest win-rate record.

**Two questions, never conflated.** Grading has to say which question it answers, because there are two and they have different answers. The **trained event** (`PREDICTED_EVENT` in `api/_lib/oracle/conviction.js`) is what the score head was fitted on and what the score claims. Under v3 that is id `runs_and_holds`: the coin graduates or peaks at 3x or more, AND is still worth at least what it cost at first sight, so a coin that spiked 3x and then collapsed is not a hit. (A v2 document scores on id `spike_or_graduate`, where a later collapse does not undo a hit; the engine normalises either model shape and reports which event it is predicting.) The **holder-honest win** is the rug-aware definition in the paragraph above, judged on realized production outcomes rather than the training label, and it is the right number for someone actually holding. Every surface that shows a realized rate now states which of the two it is, and the backtest ships both side by side. Presenting one as the other is what made a working engine read as a broken one.

**The backtest** at `/api/oracle/backtest` joins what the engine scored against what actually happened and returns hit-rate stats per tier. Only coins with a resolved outcome count; open positions are excluded. This is the honest answer to "does it actually work," updated continuously. It publishes:

- **Win rate by tier**, with a 95 percent Wilson confidence interval, for both definitions (`ci` on the holder-honest win, `spike_ci` on the trained event).
- **A calibration ladder** in bands of 10. The band's `predicted` is the sample-weighted mean of the probability each score in it actually claims, computed with `probabilityFromScore()`. This matters: the 0-100 score line is **not** a percentage (86 claims P=0.45, 34 claims P=0.05), and every table we shipped before 2026-08-14 read `score/100` as the claim, overstating the engine's own confidence by up to 4x and making a calibrated ranking look wildly overconfident. Bands are assembled from a per-score aggregate rather than a band midpoint, so the claim tracks where the coins actually sit.
- **A Brier score** (`brier_of` names the event, the trained one), computed per exact score against its own claimed probability rather than against a band midpoint, so it is exact. Lower is better; 0.25 is a coin flip.
- **The edge multiple**, prime's rate over the base rate, and a monotonicity check. The ladder check counts an inversion only when two bands' 95 percent intervals are **disjoint**: a visible dip inside overlapping intervals is sampling noise, and the previous check both tolerated real inversions and reported `monotonic: true` over them.

During a database outage the endpoint answers `503` rather than an empty record, so "no wins yet" can never be a dressed-up outage.

That rule is the whole Oracle read surface, not one endpoint. `/api/oracle/feed`, `/categories`, `/agent-stats`, `/follow`, `/movers`, `/signal`, `/stats`, `/history`, and the `/social` ingest all separate a connectivity failure from an ordinary SQL fault: the first propagates as `503` with a `Retry-After` and is never cached, the second still degrades to the documented empty answer. The distinction matters because these responses get CDN-cached for 60 to 120 seconds, so a blip lasting seconds used to pin "nothing is moving", "nobody is armed", or "no plays right now" on the product for minutes after the database recovered. `/api/oracle/og` follows the same rule in its own shape: a card built from a failed read still renders (a social scraper needs an image back), but it is served `no-store` so the next scrape re-reads a recovered database instead of caching "Not yet scored" on a Prime coin for 15 minutes. The contract is pinned in `tests/oracle/api-db-outage.test.js`.

**The realized-hit-rate calibration.** The fitted model answers "what fraction of launches like this one spike or graduate". A user reading a card wants "of the coins Oracle already scored at 99, how many actually won". Nothing reconciled those two, so a card reading conviction 99 quoted a training-label probability above 95 percent for a band that realized 26 percent. `scripts/oracle-calibrate.mjs` measures that: the realized rug-aware win rate per score band over resolved production coins, smoothed into a monotone ladder with pool-adjacent-violators (isotonic regression) and written to `api/_lib/oracle/conviction-calibration.json`, so the public tier boundaries can be checked against the plateaus it exposes. Since v3 the rate printed next to every score (`hitRateFor()`) comes from the active model's own holdout instead of that file, because the file's win definition was built on the SOL-price-dependent rug flag. Run the script bare to fit and report, `--write` to update the JSON. It reads the production database when `DATABASE_URL` is set and otherwise the live `/api/oracle/backtest`, which runs the same aggregation server-side, so neither path invents a number.

**A third question: what the fleet actually banked.** `/api/cron/oracle-calibrate` (Cloud Scheduler) joins conviction to the fleet's *realized PnL* on mints it really traded, buckets by conviction band, and writes `oracle_calibration`. A win here is a positive realized PnL on a real fill, which is neither the trained event nor the site's rug-aware win: exit timing belongs to the fleet, so a gap between this table and `/api/oracle/backtest` is expected rather than a bug. Each band carries a bounded `correction_factor` (observed over claimed, clamped to 0.7-1.3, and pinned at 1.0 until the band has enough real trades). That factor is deliberately **not** written back onto the canonical `oracle_conviction` score: the calibration is measured against that score, so mutating it would feed into its own measurement and oscillate. It is exposed at `GET /api/oracle/calibration` and applied where it belongs, in the sniper optimizer's Rule O, which tunes each arm's entry threshold toward the band that realized wins.

**The wins gallery** at `/api/oracle/wins` shows proven calls filtered by period, tier, and minimum ATH multiple. It defaults to called tiers only (Lean, Strong, Prime) — a Watch or Avoid coin that mooned is market context, not proof of edge; pass `tier=all` to browse everything scored.

**The leaderboard** at `/api/oracle/leaderboard` ranks agents by conviction win rate across their full action ledger, with a minimum resolved-action floor so one-trade wonders cannot dominate.

**Score history and movers.** Every coin's conviction is snapshotted whenever it moves by 3 points or more, so the sparkline in the coin drawer shows real signal, not polling noise. The movers read surfaces the coins whose conviction rose or fell most in a window, and it requires at least two snapshots so a delta is never a single-point artefact.

## Everything on the platform that runs on Oracle

This is where the engine earns its keep. One score, many consumers.

**The sniper.** The autonomous pump.fun sniper (the engine behind the Sniper Arena) uses Oracle as a conviction gate: a strategy can require a minimum Oracle score before any snipe fires. The gate is adjusted two ways, both clamped and fail-open. Macro signals from the autonomous x402 loop widen or tighten the bar based on overall SOL and pump market sentiment. And per-coin sentiment comes from the most on-brand loop we run: the sniper pays the platform's own paid intelligence API, one cent of real USDC per call through x402, for a live market read on each coin it is watching, and a bearish read raises that coin's snipe bar while a bullish one lowers it. The trading engine is a paying customer of the intelligence engine. That is the agent-to-agent economy, in production.

**The Play worlds.** Every coin town in /play has an intel kiosk standing in the plaza. Walk your avatar up to it, press E, and pay one cent USDC through the x402 wallet modal (Phantom on Solana, or an EVM wallet on Base), and the kiosk's 3D screen lights up with live purchased intel for the town's own coin: price, 24 hour change, market cap, and a bullish, bearish, or neutral signal. The flagship $THREE town buys from its dedicated oracle endpoint; every other town uses generic coin-agnostic plumbing with the world's mint supplied at runtime. Every settlement is real USDC on chain with an explorer link, the payment only fires on an explicit player interaction, and you sign with your own wallet. No platform key ever touches the page.

**The forecast sculpture.** Also inside /play: a floating, walk-around 3D data sculpture rendering a live token's price history as a neon ribbon with an IBM Granite TimeSeries forecast sweeping forward from it. The same scene runs standalone with an embodied avatar narrating the analysis, governed by Granite Guardian.

**The Agent Exchange.** The /agent-exchange demo, where two 3D avatars trade intel in a virtual world while the on-chain transaction shows live, runs on the same paid crypto intel feed the sniper buys from.

**Alerts and the social layer.** Armed agents alert their owners on Telegram on entries and on conviction drops for held coins. And any user can follow any agent at `/api/oracle/follow`, the watch tier of social copy-trading: pick an agent, set your own minimum score, and get pinged when it acts. The test-alert endpoint lets you verify your wiring before anything real fires.

**The Telegram channel feed.** The whole Oracle also runs as a public Telegram channel, so you can hold the feed in your pocket without keeping a tab open. Three kinds of posts flow into it. Live signals: the scoring cron sweeps every two minutes and posts each coin the first time it crosses the feed floor, either by tier (`ORACLE_ALERT_MIN_TIER`, prime and strong by default) or by raw score (`ORACLE_FEED_MIN_SCORE`, default 56, the Lean boundary tracking the top slice of the live distribution). Agent activity: live entries and profitable exits post as they happen, with the agent's track-record link. A daily digest at 08:00 UTC anchors the channel with the day's scored count, top conviction, and platform-wide agent results. Every post carries the coin's mint, score, tier, and pillar breakdown, plus links back to the pump.fun page and the Oracle coin page. The channel is set by `TELEGRAM_ORACLE_CHAT_ID`; when it is a public @handle, `/api/oracle/stats` exposes the join URL and the /oracle hero renders a "Join the live Telegram feed" button. Each coin posts exactly once, deduplicated in-process and durably via `oracle_conviction.alerted_at`.

**The coin pages.** Every Oracle coin page (`/oracle/coin/<mint>`) renders in the markets-hub design, the same editorial system as `/coin/bitcoin`: breadcrumbs, a coin header with the live price and 24h/7d change chips, a conviction card with the score dial and four pillar bars, and stacked full-width sections. It fuses conviction with a live market intel aggregator that fans out to six real sources in parallel: DexScreener, the pump.fun API, GeckoTerminal, GoPlus, Birdeye, and CoinGecko. Price, liquidity, FDV, bonding curve progress, holder count, top ten concentration, mint and freeze authority, all in one view, every number traced to a live upstream. Each source is isolated, so one being down degrades that slice to null instead of failing the page. A Launch Intelligence section brings the Coin Radar engine's first-90-seconds read onto the same page: quality score, organic versus bundle, risk flags, the full signal breakdown, smart-money buyers, and the top-trader ledger. It also shows the who-is-in breakdown: every early wallet labeled by archetype and track record. That trader-classification surface is what the product is built around. The price chart keeps the TradingView-grade DexScreener candles embed alongside a native line view and an agent-trades view that plots every three.ws agent buy and sell on the series.

**What the verdict card says out loud.** A big dial reading 100 next to a chart that already collapsed is not a wrong score, it is an unlabelled one, so the conviction card carries two lines the dial cannot say by itself. Directly under the score, the odds line quotes the measured rate behind the score instead of the score itself, from `hitRateFor()`: "48% of calls in the 0.45-1 band have won (n=267), 15.0x the 3% a random launch wins" (the band is the probability band the score claims, and the rate is what the active model's holdout observed there), followed by when the call was made relative to the coin first surfacing ("Scored 54s after this coin surfaced") and the one sentence that resolves the whole confusion, that the score ranks the odds of a 3x run or graduation and not the odds of a safe hold. Below it, once the market has resolved the coin, a **Since the call** strip states the ground truth in the order a holder reads it: peak multiple, whether it graduated or rugged, and what it is worth now ("peak 6.7x · rugged · now $2.2K"). Both lines are rendered server-side in `api/oracle-share.js` (a GET-only surface; when pump.fun does not answer, the coin's identity, symbol, name, image, market cap and graduation state, comes from DexScreener's pair listing so the card still names the coin) and refilled by `public/oracle-coin.js`, so a link pasted into a chat shows them in the preview rather than a bare triumphant number; the share description carries the same clause ("since: ran 6.7x, then rugged"). The drawer's one-line take leads with the result for the same reason: "It ran to 6.7x and then rugged." before it repeats what Oracle called. On the feed at `/oracle`, each card carries the compact version of that strip as an outcome chip next to its odds chip, so a resolved coin never sits in the board looking like a live call.

## The x402 layer: intel with a price tag

Oracle's read API is free. The premium intel feeds are x402 paid endpoints, one cent USDC per call, settling on Solana or Base, and cataloged in the x402 bazaar so any paying agent on the open web can buy them:

- **Crypto Intel**: a live market signal for any listed coin, plus special engines like a pump.fun volume anomaly scanner (finds the coin whose trailing-hour volume is a statistical outlier against its peers) and the live pump.fun trending board with buy and sell pressure scores.
- **The $THREE Town Oracle**: the same feed the $THREE town kiosk sells from, buyable directly by any x402 client.
- **The generic token oracle**: the coin-agnostic version, mint supplied at runtime.

One rule makes these trustworthy: there is no mock path. If the upstream market sources fail, the endpoint returns 503 before settlement and the buyer is never charged. We only ever sell a signal a real market produced.

## For developers: the API, MCP, and code

Everything below is live now. No key is required for reads. Reads are JSON, cached at the CDN and rate-limited per IP; live views are Server-Sent Events. Agent-config endpoints require auth scoped to the agent owner.

### Poll the signal (any language, any agent)

```
GET https://three.ws/api/oracle/signal?network=mainnet&min_score=72&limit=5
GET https://three.ws/api/oracle/signal?mint=<mint>
```

Returns the current highest-conviction plays, or one coin's verdict, each with the pillar breakdown, badges, and an explicit recommendation: action (buy, watch, skip), confidence, and a size factor (1.0 for prime, 0.75 for strong, 0 for everything else). Your agent multiplies the size factor by its own per-trade budget and it has a position size.

The list form answers `{ network, count, top, plays, generated_at }`: `plays` is the ranked array, `top` is `plays[0]` (or `null` when nothing clears `min_score`), and `count` is the array's length. The single-mint form answers `{ network, mint, signal, generated_at }` instead, carrying one verdict under `signal`. Both wrap the same play object:

```json
{
  "mint": "…", "symbol": "…",
  "conviction": 88, "tier": "strong", "category": "ai",
  "smart_wallet_count": 4,
  "pillars": { "pedigree": 82, "structure": 88, "narrative": 80, "momentum": 90 },
  "badges": ["smart-money"],
  "recommendation": {
    "action": "buy",            // buy | watch | skip
    "confidence": "medium",     // high | medium | low
    "size_factor": 0.75,        // 0 to 1 suggested sizing multiplier
    "note": "strong conviction, favorable across pedigree and structure"
  },
  "scored_at": "2026-08-14T06:42:47.867Z"
}
```

`count: 0` means the oracle sees no play clearing your `min_score` right now, and an agent should stand down. It never means the engine is down: a database outage answers 503 with a `Retry-After` rather than an empty board, so an empty `plays` array is always a real verdict.

Recommendations map from tier: prime to `buy/high/1.0`, strong to `buy/medium/0.75`, lean to `watch`, watch/avoid to `skip`. Reads are cached 3 seconds with stale-while-revalidate, so polling is cheap.

### A minimal agent loop in JavaScript

```javascript
const API = 'https://three.ws/api/oracle/signal?network=mainnet&min_score=72&limit=5';

async function tick(budgetSol) {
  const { plays } = await fetch(API).then(r => r.json());
  for (const s of plays || []) {
    const { action, size_factor } = s.recommendation;
    if (action !== 'buy') continue;
    const size = budgetSol * size_factor;
    console.log(`${s.symbol} ${s.tier} ${s.conviction}: buy ${size} SOL`, s.pillars);
    // hand off to your own execution here
  }
}
setInterval(() => tick(0.1), 15000);
```

### Stream instead of poll

Two SSE feeds: the conviction stream (every new or updated verdict, filterable by minimum score) and the action stream (every agent action and outcome update, the same feed that powers /activity). A third, the trades stream, is a coin's live buy/sell tape, each trade annotated with the trader's wallet archetype.

```
GET https://three.ws/api/oracle/stream?network=mainnet&min_score=56
GET https://three.ws/api/oracle/action-stream?network=mainnet&mode=live
GET https://three.ws/api/oracle/trades?mint=<mint>
```

### Go deeper per coin

- Full fused intel with the who-is-in trader breakdown at `/api/oracle/coin`.
- The live market half of a coin page at `/api/oracle/market`: price plus 5m/1h/6h/24h changes, market cap, FDV, liquidity, 24h volume, holders, supply, bonding-curve progress, security (mint/freeze authority, mutable metadata, transfer fee, top-10 concentration), DEX pairs, ATH/ATL, and every social/explorer link, fused live across the six sources above.
- Conviction for up to 20 mints at once at `/api/oracle/batch`.
- Score time series at `/api/oracle/history`, biggest conviction moves at `/api/oracle/movers`, accuracy stats at `/api/oracle/backtest`, proven calls at `/api/oracle/wins`, agent rankings at `/api/oracle/leaderboard`.
- Global KPIs, per-category intel, symbol search, a single agent's record, and the global action feed at `/api/oracle/stats`, `/categories`, `/search`, `/agent-stats`, and `/activity`.
- Realized calibration per conviction band at `/api/oracle/calibration`: the fleet's actual win rate from real fills, next to what the band predicted, plus the bounded correction factor the scorer applies.
- A dynamic 1200x630 OpenGraph conviction card (SVG) for sharing a coin at `/api/oracle/og`. Its live market cap reads pump.fun first (with one retry, honouring `Retry-After`) and falls through to the shared multi-source market reader (Birdeye, DexScreener, GeckoTerminal) when pump.fun does not answer.

The write endpoints. Two are auth-scoped to the agent's owner: `GET·POST /api/oracle/watch` reads or arms an agent's watch config with server-side validation clamping every limit, and `POST /api/oracle/test-alert` sends a test alert. The clamps only ever move a number toward safety: a size above the ceiling is lowered, but arming `mode: "live"` with a `per_trade_sol` under the 0.001 SOL floor, or a `max_daily_sol` smaller than one trade, is a 400 rather than a silent round-up into real spending. Simulate runs keep the forgiving clamps. Two are public and IP rate-limited instead: `POST·DELETE /api/oracle/follow` subscribes a Telegram chat to an agent's signals (the chat id the caller supplies is the identity, so there is no session to scope to), and `POST /api/oracle/social` ingests tweets to additively boost virality (never downgrades an LLM read).

### Through MCP

The read API is plain HTTP, so any MCP-capable assistant can call it with a generic fetch tool today. The paid feeds are reachable the proper agent way: `@three-ws/x402-mcp` gives your assistant a self-custodial wallet that can find, inspect, and pay any x402 service in USDC, and `@three-ws/mcp-bridge` turns any x402 endpoint on the open web, including all three Oracle intel feeds, into a callable tool with spend caps. One line of npx each.

## Three tutorials in one place

**Read the market in sixty seconds.** Open three.ws/oracle. The board is live, newest first. Click any coin: the drawer shows the score, the four pillars, the plain-language reasons ordered by what mattered most, the conviction sparkline, who is in, and the full live market picture. Prime and strong are the only tiers that mean act.

**Arm your agent, risk free.** Create or pick an agent, open three.ws/oracle/arm, set minimum tier to strong, pick your categories, set a per-trade size and a daily budget, require smart money if you want the strictest gate, and leave mode on simulate. Add your Telegram chat and send the test alert. Watch your agent's simulated entries appear on three.ws/activity and its graded results accumulate. Flip to live only when the simulated ledger has earned it.

**Buy intel like an agent.** Walk into any coin town in /play, find the kiosk by the plaza, press E, and pay one cent USDC. Or skip the world and do it from code: point `@three-ws/x402-mcp` at the crypto intel endpoint and ask your assistant for the pump.fun trending board. Either way you just did what the sniper does on every pass: paid the machine economy for a real market read.

## The data model

Oracle owns five tables. The verdict cache is the heart; the rest are history, config, and the action ledger.

- `oracle_conviction`, 1 row per mint: `score, tier, pedigree, structure, narrative, momentum, structure_cap, badges, reasons, components, category, smart_wallet_count, scored_at`. The `components` blob is a full audit trail of the normalized inputs that produced the score, the reproducibility guarantee in storage form.
- `oracle_narrative`, 1 row per mint: `category, narrative, virality, confidence, tags, source (llm|heuristic), classified_at`.
- `oracle_conviction_history`, append on a 3-point-or-greater change: `score, tier, pillars, scored_at`, 72h retention.
- `oracle_agent_watch`, 1 row per agent: `armed, mode, min_score, min_tier, categories, per_trade_sol, max_daily_sol, max_open, require_smart_money, size_scaling, telegram_chat_id`.
- `oracle_watch_actions`, 1 row per action: `mint, conviction, tier, mode, size_sol, status, reason, entry_mc_usd, tx_signature, outcome, peak_multiple, realized_pnl_sol, acted_at, settled_at`.

## The honest limits

Oracle publishes its failure modes next to its wins, so here they are. Brand-new creators and wallets start on priors, and a cold start prior is a guess with error bars, not knowledge. Momentum is the lightest pillar on purpose, which means Oracle will be late to pure momentum plays, and we accept that trade. The backtest counts only resolved outcomes, so very recent calls are invisible to it until the brain grades them. Market data sources rate-limit and go down; every consumer of them degrades gracefully to null rather than inventing a number. And live mode is deliberately conservative: hard caps, kill switch, one action per agent per coin. The engine is built to be wrong safely.

A few more, stated plainly. A high score is the weight of on-chain evidence, not a prophecy; pump.fun is adversarial and heavy-tailed, and even a calibrated edge loses often, so read the tier as odds and size accordingly. The HOW pillar guards against known manipulation, but launderers iterate, and new evasion patterns are caught by the outcome loop (they rug, reputation updates) before any single rule catches them; the defense is the closed loop, not one check. The fitted weights are only as current as the last refit, and the launch meta drifts, so `scripts/oracle-fit.mjs` exists to be rerun, and the training window (first fit: 2026-07-26 to 2026-08-09) will always lag the newest evasion pattern by however long outcomes take to resolve. And the smart-money overlay magnitudes are still documented expert priors, because proven wallets remain rare; as the widened ledger accumulates judged coins, those too become fittable.

None of this is financial advice. Oracle is an analytics and automation tool. Conviction scores, signals, and agent actions are informational. Live trading risks real funds; simulate first, cap hard, and treat every number as one input among many.

## Why it compounds

Every coin watched sharpens the priors. Every graded outcome tunes the calibration. Every proven wallet added to the ledger makes WHO harder to fool. Every x402 payment for intel funds the loop that produces the intel. More coverage, better priors, sharper scores, more graded outcomes, better calibration. A scoring engine that gets harder to beat every day it runs.

## PhD appendix: Oracle as a calibrated scoring classifier

Let a launch be a feature vector `x`. Since v2 (2026-08-09), Oracle is a bucketed logistic model: each feature `j` is discretized by fixed empirical bin edges into a one-hot `b_j(x)`, and since v3 (2026-08-28) each bin carries one fitted weight `w^h_{j,b}` per head `h ∈ {win, rug, moon}` over the same design matrix:

```
z_h(x) = w^h_0 + Σ_j w^h_{j, b_j(x)} + o(x)   # o(x): expert priors the model cannot fit
p_h(x) = σ(z_h(x)) = 1 / (1 + e^(−z_h(x)))    # calibrated P(h | x)
s(x) = min( m(p_win(x)),  c(x) )              # m: fixed monotone piecewise-linear map to [0,100]
                                              # c: 45 iff serial-rugger creator, else 100
```

with `hold = ATH_multiple × (last_mc / ath_mc)` (both dollar figures from one reading, so the SOL price cancels), `moon = graduated ∨ ATH ≥ 3×`, `rug = ¬graduated ∧ hold ≤ 0.5`, `win = moon ∧ hold ≥ 1`, fitted by SGD on the labeled outcome set (L2-regularized, deterministic seed, time-ordered rows, label rule version 2 only; `api/_lib/oracle/fit.js`, shared by `scripts/oracle-fit.mjs` and the refit cron). Each fitted weight is then shrunk toward zero by `n / (n + 200)`, `n` being the rows behind its bucket, so a 34-row bucket cannot reverse a verdict on its own. `m` is anchored so the public tier boundaries land on fixed probabilities of `win` (34 ↦ 0.05, 56 ↦ 0.12, 72 ↦ 0.25, 86 ↦ 0.45). Evaluation is a strict temporal split: train on the oldest 75 percent, report AUC, precision-at-depth, and per-band reliability on the newest 25 percent, for every head. Calibration measures the gap between `p(x)` and reality out of sample.

The calibration objects:

- **Reliability (calibration ladder)**: partition scores into bins `B_j`; plot empirical `ŷ_j = (1/|B_j|)Σ 1[win]` against the bin's predicted rate. Perfect calibration implies `ŷ_j ≈ s̄_j/100` for all j (the identity line).
- **Brier score**: `BS = (1/N) Σ (s_i/100 − y_i)²`, the mean squared error of the probabilistic claim; decomposable into reliability minus resolution plus uncertainty.
- **Wilson interval**: for `w` wins in `n` resolved coins, the 95 percent Wilson score interval (z = 1.96, z² = 3.8416) is `centre = (p + z²/2n) / (1 + z²/n)` and `margin = z·√((p(1−p) + z²/4n) / n) / (1 + z²/n)` with `p = w/n`. Unlike the normal approximation `p ± z·√(p(1−p)/n)`, it stays inside [0,1], doesn't collapse to zero width at p=0 or p=1, and behaves correctly for the small `n` that young backtests have. It is the difference between an honest "we don't know yet" and a dishonest "0 percent ± 0 percent."
- **Monotonicity and edge**: require `ŷ` non-decreasing in the score bin (within tolerance); define edge multiple `= P(win | prime) / P(win | any)` and lift as the difference, both reported with their CIs.

The improvement path, formally. v2 delivered the first two upgrades the v1 appendix promised: the weights are fitted by maximizing regularized log-likelihood on resolved outcomes, and the published score is a fixed monotone map of a calibrated probability. v3 delivered two more: an automated refit (`/api/cron/oracle-refit`) behind a champion/challenger holdout gate (a candidate ships only if every epoch ran, the scoring head's AUC is at least 0.70 and beats the incumbent by at least 0.004, no other head fell by more than 0.01, no more than three features were lost, and every populated band still earns 70 percent of what it claims; refused candidates are kept in `oracle_model_versions` with the reason), and the smart-money evidence fitted as a feature instead of an overlay. What remains open, in order of expected value: (1) interaction terms or shallow trees over the same buckets, since the model is additive and the strongest observed patterns (concentration crossed with buyer count) are plausibly interactive; (2) survival-style labels (time-to-rug) instead of the binary heads, so the engine can price exit windows and not just entries.

References and further reading. Wilson (1927), *Probable inference, the law of succession, and statistical inference*. Brier (1950), *Verification of forecasts expressed in terms of probability*. Platt (1999), probabilistic outputs for SVMs (Platt scaling). Zadrozny and Elkan (2002), isotonic calibration. Niculescu-Mizil and Caruana (2005), *Predicting good probabilities with supervised learning*.

## Glossary

- **Conviction**: the fused 0 to 100 score, a fixed monotone map of the model's calibrated P(good) so tier boundaries land on stated probabilities.
- **Pillar**: one of the four independent reads, WHO (pedigree), HOW (structure), WHAT (narrative), MOVE (momentum).
- **Tier**: the coarse band a score falls in: prime / strong / lean / watch / avoid.
- **Cap (veto)**: a hard ceiling on the final score, set by a severe structural or pedigree red flag, applied before clamping.
- **Proven wallet**: a wallet labelled smart-money/KOL, scoring 70 or more, or holding a 35-percent-plus win rate over 8-plus judged coins (a sustained ~3x edge), the pedigree currency.
- **Win / loss / flat**: outcome grades. Win = graduated or 2 times or greater ATH; loss = rugged or below 1.2 times; flat = in between.
- **Graduated**: a pump.fun coin that completed its bonding curve, the canonical success event.
- **Armed**: an agent configured to act on conviction automatically, in simulate or live mode.
- **Calibration**: how closely realized win rates match the scores that predicted them.
- **Wilson interval**: the 95 percent confidence band on a win-rate estimate, correct for small samples.

## Where to start

The live board: three.ws/oracle. The complete reference, thesis to pillar math to calibration appendix: three.ws/oracle/docs. Arm your agent: three.ws/oracle/arm. Watch every agent act in real time: three.ws/activity. Watch the data loop itself: three.ws/pipeline.

The more data we watch, the sharper every score. Oracle is live now.
