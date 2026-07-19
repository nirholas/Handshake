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

## The four pillars, with the real math

Every score fuses four independent reads. The weights are public and shipped in every API response: pedigree 0.34, structure 0.30, narrative 0.18, momentum 0.18. Pedigree leads because buyer track record is the single most predictive signal we have. Structure is a near-equal guardrail. Narrative and momentum refine.

### WHO, the Pedigree pillar (weight 0.34)

Reputation earned on chain. Which smart wallets are in this coin, and what is the creator's launch history? Oracle keeps a ledger of wallets that have proven they win, and every early buyer is labeled by its archetype and track record. Creators it has never seen get a cold start prior, honest uncertainty instead of fake confidence. A confirmed serial rugger does not just lower the score, it imposes a hard ceiling on the final number that no other pillar can lift.

The exact adjustments, shipped in the code. Inputs come from the brain's smart-money slice (a pre-computed 0 to 100 composite, proven and total buy/sell lamports, a list of notable wallets with labels) and the creator's record (label, prior launches, graduated launches, dump rate). The base is the brain's composite, or the average of notable wallets' scores if the composite is absent. When there is no pedigree observation at all — no composite, no notable wallets, no creator record — the base anchors at a neutral prior of **38** rather than 0 (unknown buyers are the market norm, not a red flag; scoring them 0 used to pin every ordinary launch under a hard ~55 fused ceiling), and the final fused score is capped at **71**, one point below Strong. Unknown pedigree can read Lean at most; Strong and Prime must be earned with observed evidence.

- 5 or more proven wallets in: **+14** (+9 at 3 or more, +5 at 1 or more)
- Proven share of buy volume 40 percent or more: **+8** (+4 at 20 percent or more)
- Flagged wallet present (rugger/dumper): **minus 12 each**, capped at minus 36 (3 wallets)
- Smart money sold 50 percent or more of position: **minus 16** (minus 8 at 25 percent or more, trimming)
- Creator with 3 or more launches, 0 graduated: **minus 22, hard ceiling of 45** (rug pattern)
- Creator with 3 or more graduated launches: **+12** (+6 at 1 or more)
- Creator dumps 50 percent or more of launches: **minus 8** (consistent exit pattern)

Returns `{ score, reasons[], cap }`. The `cap` is a hard ceiling on the final fused score, the mechanism by which a serial rugger can never produce a prime coin no matter how good the other pillars look. A wallet counts as proven if it is labelled `smart_money`/`kol` or carries a reputation score of 70 or more.

### HOW, the Structure pillar (weight 0.30)

The engineering of the launch itself, and the pillar with teeth. Rugs are a structure problem before they are a price problem, so structure gets a veto. The base is anchored to the brain's organic-demand score: `base = 30 + organic·0.55` (so structure alone lives in roughly 30 to 85), or a neutral 62 when organic isn't available. Then a battery of red-flag checks subtract and, for the severe ones, set a hard ceiling. The lowest cap triggered wins.

Real deductions from the shipped code:

- Dev sold 50 percent or more of their bag: **minus 24, caps the score at 38** (minus 10 at 20 percent or more)
- Single-funder cluster 50 percent or more (half the "different" wallets share one funding source, a bundle in a wide-base costume): **minus 22, caps at 42** (minus 12 at 30 percent or more)
- Flagged bundle launch: **minus 18, caps at 48**
- Bundle likelihood 60 percent or more: **minus 20, caps at 46** (minus 11 at 35 percent or more)
- Top-10 wallets hold 80 percent or more: **minus 22, caps at 44** (minus 12 at 60 percent or more)
- Top holder 50 percent or more: **minus 26, caps at 45** (minus 14 at 30 percent or more)
- Fresh/farmed wallets 70 percent or more: **minus 18, caps at 48** (minus 9 at 45 percent or more)
- Snipe ratio 70 percent or more: **minus 16, caps at 50** (minus 8 at 45 percent or more)
- Buyer interconnectivity 60 percent or more: **minus 10, caps at 55**
- Creator still holds 25 percent or more: **minus 16**
- 60 or more unique buyers: **+16** (+9 at 25 or more, minus 8 below 8)

This is the formal statement of "structure is a veto": a launch with a serious structural defect is ceiling-limited before the weighted average is taken, so no amount of pedigree or narrative lifts it into a high tier.

### WHAT, the Narrative pillar (weight 0.18)

What the coin actually is. A classifier with the news on its desk assigns every launch a category (news, culture, ai, meme, animal, celebrity, political, community, tech, utility, or unknown) and a virality estimate from 0 to 100. Each category carries a tuned prior for how often that flavor sustains attention: news launches prior at 70, culture at 66, ai at 64, unknown at 40. The virality estimate blends with the prior, weighted by the classifier's own confidence, so a low-confidence call leans on the prior instead of pretending to know. A news coin gets flagged for what it is: fast but fragile.

Full category priors (base virality): news 70, culture 66, ai 64, meme 60, community 58, animal 56, celebrity 54, political 52, tech 50, utility 46, unknown 40.

The blend, when a virality estimate exists:

```
score = virality · (0.4 + 0.4·confidence) + prior · (0.6 − 0.4·confidence)
```

So high model confidence leans on the virality estimate; low confidence falls back toward the category prior. With no estimate, `score = prior`. A `news` coin adds the reason "fast but fragile"; an `unknown` coin adds "treat with caution."

The classifier chain, in preference order: (1) an LLM given live crypto headlines from a public news API (cached about 90 seconds), fuzzy-matched against the coin's name, symbol, and tags, contributing up to +30 virality when the coin clearly rides a current story; (2) an LLM without news context; (3) a deterministic keyword classifier with per-category lexicons and a social-presence virality heuristic. The chain degrades gracefully: if the model is unavailable, the heuristic always produces a usable classification, tagged `source: heuristic` versus `llm`. A separate social-ingestion path can additively boost virality from tweet engagement, but never downgrades an LLM classification.

### MOVE, the Momentum pillar (weight 0.18)

The early footprint. Momentum is deliberately the lightest pillar, because it is the easiest signal to fake and the last to matter. It starts at a neutral 50.

- Buy share 80 percent or more across at least 10 trades: **+22** (strong inflow)
- Buy share 65 percent or more: **+12** (buyers outnumber sellers)
- Buy share below 45 percent: **minus 16** (distribution)
- 40 or more early buyers: **+14** (+7 at 15 or more, pile-in)
- Dev buy 0.2 to 2.5 SOL: **+8** (skin in the game)
- Dev buy over 6 SOL: **minus 14** (dev is the top holder, honeypot risk)

With no signal yet it returns "too early," keeping the pillar neutral rather than inventing momentum that isn't there.

## Fusion, tiers, and badges

The weighted blend is then capped: the lowest triggered ceiling from structure or pedigree wins, so a great story can never paper over a bundle or a dumping dev.

```
# weighted average of the four pillar scores
score = WHO·0.34 + HOW·0.30 + WHAT·0.18 + MOVE·0.18

# structure (and pedigree) can veto, the lowest cap wins
score = min(score, structure.cap)

# round + clamp to the 0 to 100 integer line
score = clamp(round(score), 0, 100)
```

The final 0 to 100 score maps to a tier ladder whose names are chosen to be honest, because most launches are noise:

- **Prime, 86 and up.** Top conviction: proven money in a clean, on-narrative launch. Rare.
- **Strong, 72 to 85.** Favorable across pedigree and structure.
- **Lean, 56 to 71.** Leaning positive, not decisive. Watch for confirmation.
- **Watch, 34 to 55.** Inconclusive. No edge yet.
- **Avoid, below 34.** Structural or pedigree red flags. Full stop.

Only prime and strong are act signals. A conviction engine that likes everything is a hype engine.

Every verdict also carries compact badges the UI renders as pills: `smart-money` (three or more proven wallets in), `structure-flag` (a ceiling triggered), `news` (riding a live story), `momentum` (subscore 72 plus), and `prime`. And every verdict ships its reasons in plain language, ordered by pillar contribution, so the most decisive fact shows first. You never get a bare number.

## Anatomy of a score

The coin drawer the product shows when you click any launch is the score, fully unpacked, the same object the API returns, rendered for a human. Walking it top to bottom mirrors the model exactly:

- **The four pillar bars**, WHO / HOW / WHAT / MOVE, are the sub-scores. The big number is their capped, weighted fusion.
- **"Why this score"** is the `reasons[]` array, each line tagged to the pillar that generated it. Example on a clean-but-unproven young launch scoring 35 (watch): "no proven wallets identified yet" (WHO), "clean, distributed launch structure" (HOW), "meme narrative, virality 45/100" (WHAT), "no clear momentum yet, too early" (MOVE). Correctly a watch, not an avoid and not a buy.
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

**The backtest** at `/api/oracle/backtest` joins what the engine scored against what actually happened and returns hit-rate stats per tier. Only coins with a resolved outcome count; open positions are excluded. This is the honest answer to "does it actually work," updated continuously. It publishes four things: win rate by tier with a 95 percent Wilson confidence interval; a calibration ladder bucketing scores 0 to 10, up to 90 to 100 and comparing each bucket's realized win rate to what it predicts; a Brier score (mean squared error of score/100 against the binary outcome, lower is better, 0.25 is a coin flip); and the edge multiple, prime's win rate over the base rate, with a monotonicity check across tiers.

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

**The coin pages.** Every Oracle coin page (`/oracle/coin/<mint>`) renders in the markets-hub design, the same editorial system as `/coin/bitcoin`: breadcrumbs, a coin header with the live price and 24h/7d change chips, a conviction card with the score dial and four pillar bars, and stacked full-width sections. It fuses conviction with a live market intel aggregator that fans out to six real sources in parallel: DexScreener, the pump.fun API, GeckoTerminal, GoPlus, Birdeye, and CoinGecko. Price, liquidity, FDV, bonding curve progress, holder count, top ten concentration, mint and freeze authority, all in one view, every number traced to a live upstream. Each source is isolated, so one being down degrades that slice to null instead of failing the page. A Launch Intelligence section brings the Coin Radar engine's first-90-seconds read onto the same page: quality score, organic versus bundle, risk flags, the full signal breakdown, smart-money buyers, and the top-trader ledger. It also shows the who-is-in breakdown: every early wallet labeled by archetype and track record. That trader-classification surface is what the product is built around. The price chart keeps the TradingView-grade DexScreener candles embed alongside a native line view and an agent-trades view that plots every three.ws agent buy and sell on the series.

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

Returns the current highest-conviction plays, or one coin's verdict, each with the pillar breakdown, badges, and an explicit recommendation: action (buy, watch, skip), confidence, and a size factor (1.0 for prime, 0.75 for strong, 0 for everything else). Your agent multiplies the size factor by its own per-trade budget and it has a position size. The shape:

```json
{
  "mint": "…", "symbol": "…",
  "conviction": 88, "tier": "strong", "category": "ai",
  "pillars": { "pedigree": 82, "structure": 88, "narrative": 80, "momentum": 90 },
  "recommendation": {
    "action": "buy",            // buy | watch | skip
    "confidence": "medium",     // high | medium | low
    "size_factor": 0.75,        // 0 to 1 suggested sizing multiplier
    "note": "strong conviction, favorable across pedigree and structure"
  }
}
```

Recommendations map from tier: prime to `buy/high/1.0`, strong to `buy/medium/0.75`, lean to `watch`, watch/avoid to `skip`. Reads are cached 3 seconds with stale-while-revalidate, so polling is cheap.

### A minimal agent loop in JavaScript

```javascript
const API = 'https://three.ws/api/oracle/signal?network=mainnet&min_score=72&limit=5';

async function tick(budgetSol) {
  const { signals } = await fetch(API).then(r => r.json());
  for (const s of signals || []) {
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
- A dynamic 1200x630 OpenGraph conviction card (SVG) for sharing a coin at `/api/oracle/og`.

The write endpoints, all auth-scoped: `GET·POST /api/oracle/watch` reads or arms an agent's watch config with server-side validation clamping every limit; `POST·DELETE /api/oracle/follow` subscribes a Telegram chat to an agent's signals; `POST /api/oracle/test-alert` sends a test alert; `POST /api/oracle/social` ingests tweets to additively boost virality (never downgrades an LLM read).

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

A few more, stated plainly. A high score is the weight of on-chain evidence, not a prophecy; pump.fun is adversarial and heavy-tailed, and even a calibrated edge loses often, so read the tier as odds and size accordingly. The HOW pillar guards against known manipulation, but launderers iterate, and new evasion patterns are caught by the outcome loop (they rug, reputation updates) before any single rule catches them; the defense is the closed loop, not one check. And the 0.34 / 0.30 / 0.18 / 0.18 weights and every threshold are hand-set expert priors, not yet learned from outcomes; that is a deliberate, transparent starting point, and the single biggest opportunity.

None of this is financial advice. Oracle is an analytics and automation tool. Conviction scores, signals, and agent actions are informational. Live trading risks real funds; simulate first, cap hard, and treat every number as one input among many.

## Why it compounds

Every coin watched sharpens the priors. Every graded outcome tunes the calibration. Every proven wallet added to the ledger makes WHO harder to fool. Every x402 payment for intel funds the loop that produces the intel. More coverage, better priors, sharper scores, more graded outcomes, better calibration. A scoring engine that gets harder to beat every day it runs.

## PhD appendix: Oracle as a calibrated scoring classifier

Let a launch be a feature vector `x`. Oracle computes four pillar functions `f_k(x) ∈ [0,100]` for `k ∈ {ped, str, nar, mom}`, a weighted score, and a capped, clamped output:

```
s(x) = clamp( min( Σ_k w_k · f_k(x),  c(x) ),  0, 100 )

  w = (0.34, 0.30, 0.18, 0.18),   Σ w_k = 1
  c(x) = min over triggered structural/pedigree ceilings   // the veto
```

The intended semantics is that `s(x)/100 ≈ P(win | x)`, where `win = graduated ∨ (ATH ≥ 2× ∧ ¬rugged)`. Calibration measures the gap between intent and reality.

The calibration objects:

- **Reliability (calibration ladder)**: partition scores into bins `B_j`; plot empirical `ŷ_j = (1/|B_j|)Σ 1[win]` against the bin's predicted rate. Perfect calibration implies `ŷ_j ≈ s̄_j/100` for all j (the identity line).
- **Brier score**: `BS = (1/N) Σ (s_i/100 − y_i)²`, the mean squared error of the probabilistic claim; decomposable into reliability minus resolution plus uncertainty.
- **Wilson interval**: for `w` wins in `n` resolved coins, the 95 percent Wilson score interval (z = 1.96, z² = 3.8416) is `centre = (p + z²/2n) / (1 + z²/n)` and `margin = z·√((p(1−p) + z²/4n) / n) / (1 + z²/n)` with `p = w/n`. Unlike the normal approximation `p ± z·√(p(1−p)/n)`, it stays inside [0,1], doesn't collapse to zero width at p=0 or p=1, and behaves correctly for the small `n` that young backtests have. It is the difference between an honest "we don't know yet" and a dishonest "0 percent ± 0 percent."
- **Monotonicity and edge**: require `ŷ` non-decreasing in the score bin (within tolerance); define edge multiple `= P(win | prime) / P(win | any)` and lift as the difference, both reported with their CIs.

The improvement path, formally. The current `w` and thresholds are an expert prior, a fixed, interpretable linear model. The principled upgrade is to (1) fit `w` (and pillar internals) by maximizing log-likelihood or minimizing Brier on resolved outcomes, and (2) compose a monotonic calibration map `g: s ↦ P̂(win)` (Platt or isotonic) so the published number is a true probability. The cap `c(x)` can be retained as a hard monotone constraint, preserving interpretability, "structure can veto," while the rest is learned. The data, the outcome join, and the calibration metrics needed to measure that upgrade are already in production.

References and further reading. Wilson (1927), *Probable inference, the law of succession, and statistical inference*. Brier (1950), *Verification of forecasts expressed in terms of probability*. Platt (1999), probabilistic outputs for SVMs (Platt scaling). Zadrozny and Elkan (2002), isotonic calibration. Niculescu-Mizil and Caruana (2005), *Predicting good probabilities with supervised learning*.

## Glossary

- **Conviction**: the fused 0 to 100 score, the weight of on-chain evidence that a launch will win.
- **Pillar**: one of the four independent reads, WHO (pedigree), HOW (structure), WHAT (narrative), MOVE (momentum).
- **Tier**: the coarse band a score falls in: prime / strong / lean / watch / avoid.
- **Cap (veto)**: a hard ceiling on the final score, set by a severe structural or pedigree red flag, applied before clamping.
- **Proven wallet**: a wallet labelled smart-money/KOL or with a reputation score of 70 or more, the pedigree currency.
- **Win / loss / flat**: outcome grades. Win = graduated or 2 times or greater ATH; loss = rugged or below 1.2 times; flat = in between.
- **Graduated**: a pump.fun coin that completed its bonding curve, the canonical success event.
- **Armed**: an agent configured to act on conviction automatically, in simulate or live mode.
- **Calibration**: how closely realized win rates match the scores that predicted them.
- **Wilson interval**: the 95 percent confidence band on a win-rate estimate, correct for small samples.

## Where to start

The live board: three.ws/oracle. The complete reference, thesis to pillar math to calibration appendix: three.ws/oracle/docs. Arm your agent: three.ws/oracle/arm. Watch every agent act in real time: three.ws/activity. Watch the data loop itself: three.ws/pipeline.

The more data we watch, the sharper every score. Oracle is live now.
