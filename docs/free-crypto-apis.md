# Free crypto APIs we have not integrated yet

Research catalog, 2026-08-05. Companion to [free-llm-providers.md](free-llm-providers.md).

Scope: every provider below offers a genuinely free tier (or fully keyless public endpoints) and is NOT currently wired anywhere in this codebase. The full inventory of what we already integrate lives in the code itself; the short version: CoinGecko, CoinPaprika, CoinLore, DIA, DefiLlama (main + coins + yields + stablecoins), Alternative.me, Pyth/Hermes, Birdeye, GeckoTerminal, DexScreener, Jupiter, GMGN, GoPlus (keyless), Hyperliquid, Kraken/Coinbase/Bitfinex public tickers, ten Solana RPC lanes (Helius, Alchemy, QuickNode, dRPC, Ankr, Tatum, MagicBlock, LeoRPC, PublicNode, Solana Labs), Jito, Bonfida SNS, Etherscan V2, Blockscout, mempool.space, pump.fun + PumpPortal, Neynar, and the ~150-feed RSS news registry. Those are excluded below.

Free-tier limits change constantly. Treat the notes as directional and verify the current limit on the provider's pricing page before wiring a lane.

## Quick wins: half-wired already, near-zero effort

These need no new vendor relationship. Either the credential slot already exists or an existing key unlocks the endpoint.

| Provider | Status in repo | What finishing it buys |
| --- | --- | --- |
| DeBank Open API | `DEBANK_ACCESS_KEY` / `DEBANK_API_KEY` declared in `.env.example`, zero code readers | Multi-chain wallet portfolio + DeFi positions for any EVM address. Either wire it or delete the dead vars. |
| Etherscan gas oracle | We already hold `ETHERSCAN_API_KEY`; only the contract-creation endpoint is called | Free EVM gas recommendations (safe/proposed/fast) via the V2 multichain API we already use. |
| Alchemy NFT + Token APIs | `ALCHEMY_API_KEY` already funds our RPC lanes | NFT metadata/ownership and token balances on the same free compute units. No new signup. |
| CryptoPanic | Named in the `api/news/archive.js` docstring, never called | Aggregated crypto news with votes/sentiment. Free developer tier, API key. Would slot into the news pipeline as a structured source next to RSS. |
| Helius DAS extras | Helius key already live | Webhooks are used; the free tier also covers priority-fee estimates and enhanced transaction parsing we do not call yet. |

## Solana first

| Provider | Free offering | Key? | Why we would use it |
| --- | --- | --- | --- |
| RugCheck (api.rugcheck.xyz) | Token risk reports for Solana mints, free | No (free tier) | Second opinion next to GoPlus in `api/_lib/oracle/market.js`; purpose-built for Solana launch scams, pairs naturally with the sniper/pump surfaces. |
| Solscan Pro API | Free developer tier | Yes | Account/token/tx indexing without burning Helius credits; we currently only link out to Solscan. |
| Shyft | Free developer tier (RPC + parsed tx + NFT APIs) | Yes | Another parsed-transaction and DAS lane; cheap redundancy for Helius. |
| SolanaTracker Data API | Free tier | Yes | Memecoin-focused token/pair data (pump.fun, Raydium, Meteora), wallet PnL, top traders. Overlaps GMGN, which depends on a scraped cookie today. |
| HelloMoon | Free tier | Yes | Solana DeFi/NFT analytics aggregates. |
| Jupiter Price + Token APIs (lite tier) | Keyless lite endpoints, rate-limited | No | We use quotes/price already via lite-api; the token-list and holders endpoints are unused free surface. |
| Tensor API | Free key | Yes | Solana NFT marketplace data (floor, listings, sales). The Solana-native answer to the NFT gap below. |
| Magic Eden API | Free, ~30 req/min | Yes | Solana (+ BTC ordinals) NFT collections, listings, activities. |

## Market data fallback rungs (multi-coin prices, listings, global stats)

Candidates for new rungs in `api/_lib/market-fallbacks.js`, `sol-price.js`, and `coin-fallbacks.js`.

| Provider | Free offering | Key? | Notes |
| --- | --- | --- | --- |
| CoinMarketCap | Basic tier (~10k credits/mo); newly added keyless trial endpoints | Yes (keyless for trial endpoints) | Referenced in our docs but never wired. Listings, quotes, global metrics, plus a free fear-and-greed endpoint. |
| CoinCap v3 (rest.coincap.io) | Free tier | Yes (v2 keyless API was shut down) | Lightweight prices + market caps. |
| Coinranking | Free tier | Yes | Coin listings and history. |
| CryptoCompare / CoinDesk Data | Free tier | Yes | Prices, OHLC, and a news API in one vendor. |
| Coin Metrics Community API | Free, no key | No | Institutional-grade daily asset metrics (realized cap, active addresses). Nothing in our stack covers on-chain fundamentals like this. |
| Messari | Limited free endpoints | Yes | Asset profiles + research metadata. Docs-only mention today. |
| Coinlayer | Free tier | Yes | Fiat-style exchange rates for crypto; low priority given existing rungs. |
| CoinStats API | Free tier (monthly credits) | Yes | Prices + portfolio; also a fear/greed source. |

## Exchange public endpoints (keyless, high rate limits)

We only use Kraken, Coinbase, and Bitfinex as price fallbacks. Every other major venue exposes free public market data with no key; each is a candidate rung for tickers, OHLC, and order-book depth.

| Venue | Free public data | Notes |
| --- | --- | --- |
| Binance Spot + Futures | Tickers, klines, depth, aggregate trades; ~6000 weight/min spot | The deepest liquidity reference for majors. WebSocket streams also free. |
| OKX | Tickers, candles, books, funding | We already integrate OKX for X Layer/x402; the public market-data API is separate and unused. |
| Bybit V5 | Tickers, klines, open interest, funding | Good derivatives context. |
| KuCoin, Gate.io, MEXC, Bitget | Tickers, klines, depth | Long-tail altcoin coverage; MEXC/Gate list microcaps earliest. |
| Deribit | Options + perps market data | The only free options-surface (IV, greeks) data source; nothing in our stack covers options. |

## Derivatives and open-interest aggregation

| Provider | Free offering | Key? | Notes |
| --- | --- | --- | --- |
| CoinGlass | Free developer tier | Yes | Cross-exchange open interest, funding, liquidations, long/short ratios. Complements our Hyperliquid-only derivatives view in `api/coin/derivatives.js`. |
| Binance/Bybit funding + OI endpoints | Keyless | No | Raw per-venue inputs if we aggregate ourselves. |

## On-chain analytics and indexing (EVM + multichain)

| Provider | Free offering | Key? | Notes |
| --- | --- | --- | --- |
| Dune API | Free tier (monthly credits) | Yes | Execute/read curated SQL queries; unlocks any dashboard metric as an API. We only consume their blog RSS today. |
| The Graph | Free monthly query allowance | Yes | Subgraph queries for Uniswap, Aave, ENS, etc. Mentioned in our skill docs, never queried. |
| Bitquery | Free developer tier | Yes | GraphQL across 40+ chains including Solana DEX trades; named in the pump.fun trading roadmap. |
| GoldRush (Covalent) | Free tier | Yes | Uniform multi-chain balances/tx API. |
| Moralis | Free tier (~40k CU/day) | Yes | Wallet history, token prices, NFT metadata across EVM + Solana. |
| Blockchair | Free with light limits | Optional | Universal explorer API across BTC/ETH/altchains. |
| Ethplorer | Free "freekey" | Yes | Quick ERC-20 token/address summaries. |
| BlockCypher | Free tier | Yes | BTC/ETH tx and address data, webhooks. |
| OKLink | Free plan | Yes | Multi-chain explorer API, includes X Layer, which our explorers do not cover via API. |
| Chainbase | Free developer tier | Yes | Indexed multi-chain datasets. |
| Codex | Free tier (~10k req/mo) | Yes | Enriched token/holder/chart data across EVM + Solana. |
| Flipside | Free developer access | Yes | SQL analytics similar to Dune. |
| Blockstream Esplora | Free, keyless | No | Bitcoin chain data; pairs with the existing mempool.space usage for BTC redundancy. |

## NFT data (beyond Solana)

SimpleHash sunset its API in March 2025 after the Phantom acquisition, and Reservoir wound down its NFT API after pivoting to Relay; do not adopt either. Live free options:

| Provider | Free offering | Key? | Notes |
| --- | --- | --- | --- |
| OpenSea API | Free self-serve key | Yes | Collections, listings, events across EVM chains. |
| NFTScan | Free developer tier | Yes | Multi-chain NFT assets and collections. |
| Rarible API | Free developer tier | Yes | Cross-chain items/orders/activity. |
| Alchemy NFT API | Covered by existing key | Already have | See quick wins. |

## DEX aggregation and routing (EVM side)

Jupiter owns the Solana lane. For the EVM x402/trade surfaces there is no aggregator integration at all.

| Provider | Free offering | Key? | Notes |
| --- | --- | --- | --- |
| 0x Swap API | Free tier | Yes | Quotes + swap calldata across EVM chains. |
| 1inch Developer Portal | Free tier | Yes | Aggregation, price, and balance APIs. |
| ParaSwap | Public endpoints | No | Keyless quotes; easiest first rung. |
| KyberSwap Aggregator | Public endpoints | No | Keyless routing API. |
| LI.FI | Free with rate limits | No | Already probed for chain listings in `api/x402/cross-chain.js`; the actual quote/route endpoints are unused free surface for cross-chain swaps. |

## Token security and scam detection

| Provider | Free offering | Key? | Notes |
| --- | --- | --- | --- |
| RugCheck | Free (Solana) | No | See Solana section; highest-fit item in this file. |
| Honeypot.is | Free | No | EVM honeypot simulation (can you sell after you buy). Complements GoPlus flags on BSC/Base tokens. |
| GoPlus authenticated tier | Free app key | Yes | We call GoPlus keyless today; `GOPLUS_APP_KEY`/`GOPLUS_APP_SECRET` sit unused in `.env.example`. Signing up raises rate limits at zero cost, or the vars should be deleted. |

## News, sentiment, and events

| Provider | Free offering | Key? | Notes |
| --- | --- | --- | --- |
| CryptoPanic | Free developer tier | Yes | See quick wins. |
| LunarCrush | Free developer tier | Yes | Social volume + sentiment per asset; docs-only mention today. |
| CoinMarketCal | Free developer tier | Yes | Structured upcoming-event calendar (listings, unlocks, upgrades). Nothing in our news pipeline is forward-looking. |
| Coindar | Free plan | Yes | Alternate events calendar. |
| Santiment | Limited free tier | Yes | On-chain + social metrics via GraphQL. |
| Glassnode | Limited free tier | Yes | Selected on-chain metrics for BTC/ETH. |
| CoinMarketCap fear-and-greed | Free with Basic key | Yes | Redundancy for the Alternative.me index we already serve. |
| Reddit JSON endpoints | Keyless (rate-limited) | No | `/.json` listings for crypto subreddits; cheap social signal already adjacent to our news code. |

## Gas and oracle redundancy

| Provider | Free offering | Key? | Notes |
| --- | --- | --- | --- |
| Blocknative Gas API | Free key recommended, works keyless at lower limits | Optional | Mempool-based EVM gas prediction. |
| Owlracle | Free tier | Optional | Multi-chain gas tracker covering most of our EVM footprint. |
| RedStone | Free price-feed API | No | Oracle price redundancy next to Pyth; also on-chain feeds. |
| Switchboard | Public Solana feeds | No | Solana-native oracle alternative to Pyth. |

## Suggested adoption order

1. Zero-cost cleanups: wire or delete the dead DeBank and GoPlus env vars; call the Etherscan gas oracle and Alchemy NFT endpoints our existing keys already pay for.
2. Solana product fit: RugCheck in the oracle/sniper risk path; Solscan Pro or Shyft as a Helius-relief lane; Tensor or Magic Eden if any NFT surface ships.
3. Resilience rungs: Binance + OKX public tickers in `market-fallbacks.js`; CoinMarketCap and CoinCap as listing fallbacks; Coin Metrics for fundamentals.
4. New capability: CoinGlass (derivatives breadth), Dune (any-metric API), CoinMarketCal (forward-looking events), CryptoPanic (structured news), a keyless EVM swap-quote rung (ParaSwap or KyberSwap).

Adoption rules that still apply: these are all free tiers, so no owner approval is needed under the paid-API rule, but each new lane must ship fully wired with a failover rung, env var documented in `.env.example`, and a test alongside the existing provider tests in `tests/api/`.
