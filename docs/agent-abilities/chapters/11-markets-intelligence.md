# Chapter 11 · Markets & intelligence

The data layer agents and their owners trade on: live markets, news, scoring oracles, liquidations, and sentiment.

three.ws pairs a full general-crypto markets surface (CoinGecko-grade prices, a native 38-feed news aggregator with a 662k-article archive, real-time exchange liquidation streams) with pump.fun-native intelligence: the Oracle conviction engine that scores every launch 0-100 within seconds, a coin-intelligence radar, the platform's own /launches directory, and live PumpPortal feeds that even drive 3D avatar reactions. Everything runs on real, mostly keyless data sources — CoinGecko, alternative.me, public Ethereum RPCs, Binance/Bybit/OKX futures WebSockets, publisher RSS feeds, the pump.fun firehose — with a hard no-fabricated-data policy (surfaces degrade to designed offline states rather than fake numbers).

## /markets hub

The front door for all market surfaces: live global stats (total market cap, dominance, Fear & Greed), the top-100 coins table, breaking crypto news, and hero cards linking to every market tool.

**How it works:** pages/markets.html + src/markets-page.js render CoinGecko data via api/_lib/coingecko.js plus the native news aggregator; every surface is one click away.

**Why it matters:** One page that answers 'what is the market doing right now' and routes to deeper tools without leaving three.ws.

## Crypto news wing (feed, reader, archive)

Live news aggregated natively from 38 real publisher RSS/Atom feeds (CoinDesk, The Block, Decrypt, Cointelegraph, Blockworks, Bitcoin Magazine, etc.) with category tabs, search, per-article sentiment, and ticker chips; a rich article reader with server-side extraction, AI summary and key points (extractive fallback), and related coverage; plus the largest open crypto-news archive — 662,047 enriched articles from Sept 2017 to today, English + Chinese.

**How it works:** /markets/news, /markets/news/article, /markets/archive backed by api/news/{feed,article,archive,rss}.js over api/_lib/news.js + api/_lib/news-sources.js; the archive corpus lives on gs://three-ws-news-archive (recovered from the cryptocurrency.cv aggregator, which three.ws now runs natively).

**Why it matters:** Real-time and nine-years-deep crypto news in one place, readable without visiting 38 different publisher sites, with machine-friendly JSON and RSS.

## Global markets index + coin detail pages

A CoinGecko-style /coins index (global stats bar, sortable top-coins table with 7d sparklines, debounced full-catalog search, load-more paging) and a shareable /coin/:id detail page per coin: interactive 24H-1Y chart with crosshair, market stats, related news, official links, and per-chain contract addresses. Also a live perpetual-futures view (price, funding rate, open interest per contract).

**How it works:** pages/coins.html + src/coins-index.js and pages/coin.html + src/coin-page.js over api/coin/* (detail, ohlc, markets, news, global, derivatives) proxying CoinGecko via api/_lib/coingecko.js. :id accepts a CoinGecko slug OR a Solana mint; mint-shaped ids cross-link into Alpha Copilot, the live trade feed, /launches, and Coin Intelligence.

**Why it matters:** Full-market price coverage that plugs directly into the platform's Solana/pump.fun surfaces — a coin page is never a dead end.

## Liquidations pulse

Real-time long/short liquidation pain across Binance, Bybit, and OKX: a dominant-side badge (LONG PAIN / SHORT SQUEEZE / BALANCED), 1h long-vs-short liquidated-USD bars, and the 3 largest recent liquidations, shown as a strip on /coins and polled every 30s.

**How it works:** A standalone always-on Node collector (services/liquidation-collector, Cloud Run min-instances 1) holds long-lived public futures WebSocket connections to all three exchanges; api/coin/liquidations.js proxies it. No fallback data — the proxy 503s collector_offline and the UI degrades to a quiet offline line rather than fabricating numbers.

**Why it matters:** See where leveraged traders are getting hurt in real time — a classic squeeze/capitulation signal — without an exchange account or key.

## Market tools: heatmap, Fear & Greed, gas, compare

Four tools sharing one design system: /heatmap (squarified treemap, tiles sized by market cap and colored by 24h/7d move, top 50/100 toggle), /fear-greed (live 0-100 sentiment gauge with week-over-week delta and 30D/90D/1Y history chart), /gas (live Ethereum gas tracker), and /compare (up to 4 coins with normalized performance overlay and stat line-up, selection saved in the URL).

**How it works:** Heatmap is computed client-side from the existing /api/coin/markets feed; Fear & Greed serves the alternative.me index through api/coin/fear-greed.js; gas reads eth_feeHistory over the last ~20 blocks from keyless public RPCs (publicnode, llamarpc, ankr, cloudflare-eth) via api/coin/gas.js; compare reuses the CoinGecko backend. All real, key-free data, cross-linked from the markets table.

**Why it matters:** At-a-glance answers to 'where is money flowing', 'what is the market mood', 'what will this transaction cost', and 'which of these coins is actually winning' — each shareable as a URL.

## Oracle — AI conviction engine for pump.fun launches

Scores every pump.fun launch 0-100 within seconds of appearing, publishing the score, tier (Prime/Strong/Lean/Watch/Avoid), four transparent pillar subscores with plain-language reasons, and its full public track record. Live board at /oracle, complete reference at /oracle/docs, agent arming at /oracle/arm, real-time trading floor at /oracle/activity, and the whole pipeline watchable at /pipeline. Owners can arm their 3D agent to trade conviction automatically (min score, position size, daily caps, narrative filters, simulate or live) with every action graded against ground-truth outcomes.

**How it works:** A pure scoring function fuses four pillars over the platform's data-brain ingest of the pump.fun firehose (every launch, trade, wallet): Pedigree 0.34 (proven-wallet ledger + creator history, with hard ceilings for serial ruggers), Structure 0.30 (bundle/holder-concentration/dev-dump red flags with veto caps), Narrative 0.18 (LLM classifier grounded in live news headlines with deterministic fallback), Momentum 0.18 (early buy-flow). Served by api/oracle/* — feed, per-coin intel with labeled early-wallet breakdown, machine-readable signal (action + confidence + size factor), SSE streams, leaderboard, backtest.

**Why it matters:** The context insiders have in a coin's first minutes — creator history, who is buying, whether supply is clean — as a single calibrated number an agent (or a human) can act on, with the math and the track record published, never hidden.

## Coin Intelligence Engine (/coin-intel)

A radar over every new pump.fun coin's first seconds of trading: bundle-launch likelihood, organic-demand score, holder concentration, sniper ratio, category classification, and an optional top-trader ledger per coin — the exact intelligence the autonomous sniper trades on, exposed publicly.

**How it works:** workers/agent-sniper/intel derives signals from observed on-chain trades and persists them; api/pump/coin-intel.js serves full per-mint intel and a filterable live radar feed (min quality, category, network, flag). Every number traces to an on-chain trade the platform observed.

**Why it matters:** Rug/bundle detection and launch quality signals for any pump.fun coin, free and key-free — the same edge the platform's own trading agent uses.

## /launches feed + pump.fun launch integration

A public directory of every coin launched through three.ws by its agents: registry rows render instantly, then live pump.fun market data (price, art, graduation status) streams in per card, with Oracle tier badges, an agent filter, generative per-mint identicons, and a 60s live refresh. Launching itself is built in: a 'Launch Pump.fun' modal on every agent profile (client-signed — user keys never leave the browser via launch-prep/launch-confirm), autonomous server-signed agent launches under spend caps, the Memetic Launcher (per-user autonomous launcher with trend sources and daily SOL caps), and Launch Studio's 50 declarative launch recipes.

**How it works:** src/launches.js reads the platform's own pump_agent_mints launch records via GET /api/pump/launches and enriches per-coin from pump.fun via /api/pump/coin; the launch path is documented in docs/coin-launches.md and docs/pump-launcher.md over api/pump/[action].js.

**Why it matters:** Launch a real on-chain pump.fun coin from an agent's profile in one flow, and every launch gets a live, shareable home in the platform's public feed with Oracle conviction attached.

## PumpPortal live feed + reactive avatars

Real-time pump.fun event streams: /pump-live presents new token launches the instant they are created (fronted by a 3D agent), agent screens and dashboards subscribe to live per-mint trade streams, and the reactive-avatar skill drives <agent-3d> gestures, emotes, and speech directly from live market events — no LLM in the loop.

**How it works:** The server fans the PumpPortal WebSocket (wss://pumpportal.fun/api/data) out to browsers as SSE via api/pump/trades-stream.js (per-mint subscribeTokenTrade) with api/pump/dex-trades.js covering post-graduation DEX trades in the same wire format; pump-fun-skills/reactive subscribes to new-launch and migration events and emits avatar actions every 2s with auto-reconnect.

**Why it matters:** Watch the pump.fun firehose live inside three.ws — and give any embedded 3D agent a visible pulse that reacts to real market activity in real time.

## Tokenized agents (pump.fun agent payments)

Agents launched as pump.fun coins can charge for their services on-chain: build Solana payment transactions in USDC or wrapped SOL, verify invoice payments on-chain, and wire wallet adapters into React/Next.js agent frontends. Coin creation supports tokenized-agent mode with buyback percentage, mayhem mode, cashback, and Jito front-runner protection.

**How it works:** The pump-fun-skills library (create-coin, swap, coin-fees, tokenized-agents) teaches any compatible AI agent the flows using @pump-fun/pump-sdk and the @three-ws/agent-payments SDK (fork of @pump-fun/agent-payments-sdk); the skill builds instructions and the user signs — private keys are never handled.

**Why it matters:** Turn an agent into an on-chain business: its coin is its equity, its invoices are verifiable on Solana, and creator fees can be split among up to 10 shareholders.

## Sentiment and narrative intel tools

Token sentiment on demand: POST /api/sentiment scores any text (Positive/Negative/Neutral) with a deterministic lexicon scorer; /api/social/sentiment-pulse pulls the real comment thread for any Solana/pump.fun mint and returns an overall score with per-source breakdown and examples (also sold as the paid sentiment_pulse MCP tool); aixbt narrative intel and momentum-ranked project scans are exposed at api/aixbt/* and as aixbt_intel / aixbt_projects MCP tools. All packaged for developers as the @three-ws/intel npm module.

**How it works:** Sentiment-pulse fetches recent commentary from pump.fun's frontend-api-v3 comments endpoint (the same source the pump.fun coin page renders) plus caller-supplied snippets, scored by the in-repo lexicon engine (src/social/sentiment.js); aixbt endpoints proxy the aixbt market-intelligence service.

**Why it matters:** Read the crowd on any token before acting — from a free one-call API, an agent skill, an MCP tool, or a single npm import.

## Free keyless Crypto Data API (/crypto)

A free, no-key, no-account crypto data API built for AI agents: token snapshots, security/rug signals, holder concentration, live pump.fun launches, bonding-curve status, whale activity, trending tokens, wallet portfolios, and ticker-availability checks — with public docs, a live try-it console, and OpenAPI 3.1 discovery.

**How it works:** pages/crypto.html documents /api/crypto/*; api/crypto/index.js and api/crypto/openapi.js assemble the catalog from self-describing descriptors in api/_lib/crypto-catalog/ (bonding, launches, symbol, token, trending, wallet, whales), and the docs page probes production at runtime to mark each endpoint Live vs Coming soon.

**Why it matters:** Agents and developers get real on-chain and market data with zero signup friction — the funnel-top for the platform's paid unique services.

## Mission Control — the real-time trading terminal (/terminal)

A keyboard-driven trading cockpit that puts everything three.ws knows on one screen: the live pump.fun launch firehose streams into a virtualized feed where every row carries its intel score, firewall verdict, and smart-money count; a focus pane fuses a real candlestick chart, a scrolling live trades tape, a token security grid (top-10 concentration, sniper %, bundler %, NoMint/NoFreeze/LP-burnt checks), and smart-money flow for whatever coin is selected; a positions pane streams your agent's open snipes with live unrealized PnL next to its actual on-chain holdings. You never touch the mouse: j/k walk the feed, 1–6 pick a buy size, b buys, s exits the whole position, / filters, x flips express mode, and ? shows the full shortcut map. Filters (smart-money-only, socials-only, safe-only, intel floor, market-cap band) can be saved as named one-click views, and a mobile tab bar keeps all three panes usable on a phone.

**How it works:** Three SSE streams (the global new-mint firehose, the intel engine's scored feed, and the sniper position stream) feed a shared store; visible rows are enriched on demand so a fast feed never janks. Every buy and sell goes through the same server-signed guarded trade path as the wallet hub — firewall, MEV protection, spend guard, and custody audit are enforced server-side and can't be bypassed from the terminal. Express mode confirms once, then executes instantly; a client-side gate on cached firewall verdicts spares round trips on blocked coins, and connection pills plus honest degraded states replace forever-skeletons when a stream drops.

**Why it matters:** Pump.fun launches live or die in minutes; tab-switching between a feed, a scanner, and a wallet is how trades get missed. Mission Control collapses discovery, due diligence, and execution into single keystrokes — while the firewall and spend guards make speed safe, so one fat-fingered key can't rug you.

## Smart Money Radar (/smart-money)

A first-party reputation graph of every pump.fun wallet. Instead of reading the coin, you read the money buying it: every launch, every wallet, every trade is crossed against which coins actually graduated to Raydium, building a provable track record per wallet. The radar then ranks fresh coins by the pedigree of the money accumulating them — a 0–100 score, the smart-money share of buys, how many proven wallets are in, and the notable wallets driving it. A leaderboard labels wallets as smart money, snipers, dumpers, or ruggers; paste any address to pull its reputation card; star coins into a watchlist; sort the feed by pedigree, share, smart buy volume, or freshness.

**How it works:** A rollup engine judges each coin about six hours after launch — graduated is a win, everything else a dud — and folds every buyer's footprint into that wallet's running reputation, exactly once per coin. Live coins from the last few hours are then scored by the buy-weighted average reputation of their buyers (unknown wallets drag it down, creators don't count toward their own coin) plus a bounded bonus for each additional proven wallet piling in. Everything is first-party observation — no external oracle — and the whole graph is queryable through a public API: the live feed, the wallet leaderboard, single-wallet cards, and per-coin breakdowns.

**Why it matters:** Anyone can fake a chart, a website, or a Telegram; nobody can fake a wallet's on-chain graduation history. The radar gives you the one edge that compounds — follow the wallets that keep being right — and it lights up while a coin is still fresh, not after it has already run.

## Alert rules engine

Server-side price and event alerts for pump.fun that fire even when every tab is closed. Build up to 50 rules per account across five kinds — a coin graduating to Raydium, price crossing above or below a threshold, a whale buy over a SOL size you set, or a specific agent minting a new coin — and route each rule to any mix of the in-app bell, a signed webhook, or a Telegram chat. Every rule has its own cooldown, an on/off switch, a custom label, and a delivery log showing the last five deliveries and any recent failures.

**How it works:** Rules live in the platform database, not in your browser — a cron evaluates them against the live pump.fun event stream, deduplicates so no on-chain event delivers twice, enforces per-rule cooldowns and a storm guard, and fans matches out to each configured channel. Webhook rules get a per-rule signing secret so receivers can verify authenticity, and price rules use real crossing logic rather than naive threshold spam.

**Why it matters:** Client-side alerts die with the tab. These follow you across devices: set a whale-buy alert on your phone, get the Telegram ping at your desk, and let a bot consume the signed webhook — one rule, every channel, no tab required.

## Email newsletter with double opt-in

A ship-notes newsletter covering new features, launches, and changelog highlights — signed up from the footer of any page. Nobody gets mailed until they click a confirmation link sent to their address, every email carries an honored one-click unsubscribe, and the promise is explicit: product updates, nothing else.

**How it works:** Signup records a pending subscriber with a single-purpose confirm token and emails the link; only clicking it flips the address to confirmed and adds it to the mailing audience, so a typo'd or hostile email can never subscribe a third party. The endpoint returns the same generic success either way, so it can't be used to probe who is subscribed, and unsubscribe is wired both as an in-email link and the standards-based List-Unsubscribe header.

**Why it matters:** You hear about new capabilities the moment they ship without watching the changelog — and because the list is consent-proven end to end, it's a signal you chose, not spam you have to escape.
