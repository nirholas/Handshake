# 10 · Snipe

> Describe a snipe strategy in plain English, backtest it against real launch history, and arm your agent to trade it from its own wallet — in one tap.

*One of the 23 abilities of the [Agent Wallet](../chapters/10-the-agent-wallet.md) — the money layer of a three.ws agent.*

## What it does

The Snipe tab turns a sentence like "snipe creators who've graduated two coins, market cap under $30k, take profit at 3x, stop loss 40%" into a complete, validated trading strategy for your agent. Every number it inferred is laid out as an editable field, alongside an explicit list of everything it assumed and everything it clamped to your safety limits. Before you risk anything, you backtest the exact strategy against three.ws's own captured pump.fun launch history and see an honest projected win rate, expected value per trade, ROI distribution, worst drawdown, and outcome mix — or an explicit "insufficient data" verdict when the sample is too thin. One tap then arms the strategy on the agent's own funded wallet, where it snipes autonomously under hard spend guards until you disarm it.

## How it works

The compile endpoint runs your description through the platform's LLM chain (with a deterministic phrase parser as a guaranteed fallback), then hard-validates the result and clamps every money and risk knob to the agent's runtime trade guards — the same ceilings enforced on every live buy, so a compiled strategy can never exceed a spend cap. The backtest endpoint replays the strategy over real captured launches (per-launch intel signals joined to labeled outcomes: graduated, pumped, flat, rugged) using the exact same entry-gate and exit-priority functions the live sniper worker runs, models slippage and price impact from recorded early liquidity, and caches results by strategy hash. Nothing is synthesized: exits are evaluated only at the two real price points that were observed (peak and terminal). Arming upserts the strategy into the database where a long-lived worker picks it up, watches the live PumpPortal launch feed, signs buys with the agent's own keypair, and manages every position to a stop-loss, take-profit, trailing-stop, or timeout exit. Each backtest snapshot is linked to the agent, so projected performance can later be compared against realized results.

## Every feature

- Plain-English strategy composer — free-text box that compiles a full sniper config from one description
- Three tappable example strategies that pre-fill the composer
- LLM compile with a deterministic intent-parser fallback, so compilation always works even with no model configured
- Plain-language strategy summary plus attribution showing whether the model or the phrase parser compiled it
- Explicit 'clamped to your safety limits' notes listing every value reduced to fit the agent's spend guards
- Explicit 'assumptions' notes listing every value the compiler defaulted or could not parse
- 'Before you arm' warnings block for missing prerequisites
- Two entry triggers: New launch (blind snipe off the live launch feed) and Intel-confirmed (waits for the Coin Intelligence read)
- 17 fully editable strategy fields rendered as a chip grid — adjust anything and re-backtest
- Per-trade size (SOL) and daily budget (SOL) sizing controls
- Max concurrent positions control
- Entry slippage tolerance control
- Max price-impact circuit-breaker control
- Min and max market-cap entry filters (USD)
- Creator track-record filters: minimum graduated coins and maximum total launches (serial-rugger filter)
- Take-profit, mandatory stop-loss, and trailing-stop exit controls
- Max hold time (minutes) timeout exit
- Intel-only filters that appear when the trigger is Intel-confirmed: minimum quality score (0–100), maximum bundle score (0–1), maximum top-holder concentration (%)
- Toggles: Require socials, SOL-quote only, Avoid dev dump
- Auto-switch to Intel-confirmed when your wording implies intel signals (organic, bundles, concentration, quality, smart money) — with a note explaining why
- Category filtering compiled from wording (meme, tech, ai, culture, community, gaming, animal, political, finance)
- Conversions handled from natural phrasing: '3x' becomes +200% take profit, 'hold 30 min' becomes 1800 seconds, '$30k' becomes 30,000
- Backtest window picker: 7 / 30 / 90 days
- One-tap backtest against real captured launch history — no synthetic data
- KPI grid: win rate, expected value per trade, median ROI, max drawdown, net P&L in SOL, trade count with wins/losses
- ROI distribution band showing worst, p10, median, p90, and best outcomes with a zero marker
- Outcome-mix bar: how many matched launches graduated, pumped, went flat, or rugged
- Best and worst simulated entries with coin symbol, explorer link, ROI, exit reason, outcome label, and peak multiple
- Confidence badge (high / medium / low) driven by sample size
- Explicit 'insufficient data' verdict when history is too thin — never a flattering number
- Honest caveats list covering survivorship, labeling lag, and modeling limits
- Backtest result caching (30-minute cache keyed by a hash of only the trade-determining fields)
- Notional-stake note when no per-trade size is set, prompting you to model your real size
- Stale-backtest indicator: any edit flags 'edited — re-run the backtest' and clears the armed state
- Mandatory stop-loss snapback: clearing the field resets it to 35% rather than allowing no stop
- Arm button that stays disabled until per-trade size, daily budget, and stop-loss are all set
- Risk-acknowledgment dialog before arming with real funds on mainnet
- Armed confirmation banner with a Re-arm flow for updated configs
- Direct link to the full Sniper dashboard for managing and disarming live strategies
- Owner-only tab — hidden from read-only viewers of the agent wallet
- Backtest snapshots linked to the agent for projected-vs-realized comparison on the trader profile
- Live worker execution once armed: watches the real-time launch feed, buys from the agent's own wallet, and manages exits automatically

## Guardrails & safety

Owner-only surface end to end: the tab is hidden from non-owners, and every endpoint verifies session or bearer auth, CSRF, per-IP rate limits, and that the agent belongs to the caller. Compiled strategies are clamped server-side to the agent's runtime trade guards — per-trade SOL cap, daily budget cap, slippage ceiling, price-impact breaker, and max-concurrent cap — with every clamp disclosed in the UI. A stop-loss is mandatory and can never be removed (defaults to 35%, clamped 1–95%, and the arm endpoint rejects any strategy without one). Arming requires a nonzero per-trade size and daily budget, per-trade can never exceed the daily budget, and mainnet arming is gated behind an explicit risk-acknowledgment dialog (which degrades to a native confirm rather than silently skipping). Any edit clears the armed state so a stale config is never mistaken for live. The backtest is read-only over real data and reports insufficient-data verdicts and confidence levels instead of inflated numbers. Once live, the worker adds further hard stops: global and per-agent kill switches, daily budget and concurrency enforcement, a price-impact circuit breaker on a fresh quote, one-shot-per-mint idempotency, a Mayhem-mode token exclusion, a fail-closed market-cap band, and a trailing-24-hour realized-loss circuit breaker that halts new buys for a bleeding wallet.

## Screenshot-worthy (shot list)

- Type one sentence, get a full strategy: the compiled config appears as an editable grid with color-coded notes spelling out every safety clamp and every assumption — nothing silent, nothing hidden.
- The backtest card is the money shot: win rate, EV per trade, an ROI percentile band from worst to best, max drawdown, and a graduated/pumped/flat/rugged outcome bar — all computed by replaying the exact live entry and exit logic over real captured launches, stamped with a confidence badge.
- The 'Armed ✓' moment: one tap after a green backtest and the banner confirms the agent is now sniping autonomously from its own wallet, under its spend guards, disarmable any time from the dashboard.

## API surface

- `/api/sniper/compile`
- `/api/sniper/backtest`
- `/api/sniper/strategy`
