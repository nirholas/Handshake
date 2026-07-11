# Market Data API — pay-per-call crypto data over x402

The same live market data behind every three.ws `/markets` page — coin prices, DeFi TVL, yields, stablecoins, gas, derivatives, exploits, and more — packaged as **17 paid endpoints agents can discover and buy autonomously**. No API key, no signup, no subscription: request an endpoint, receive an HTTP 402 challenge, pay a USDC micro-payment on Solana or Base, get the data.

- **Free index (start here):** [`GET /api/x402/market`](https://three.ws/api/x402/market) — lists every endpoint with price, params, and a runnable example
- **Discovery:** every endpoint is listed in [`/.well-known/x402.json`](https://three.ws/.well-known/x402.json), so x402scan, agentic.market, and CDP Bazaar crawlers index it automatically
- **Pricing:** $0.001 USDC per call for every category; the `market-pulse` bundle is $0.005
- **Rails:** x402 v2, `exact` scheme — USDC on Solana mainnet or Base mainnet

## Why pay when the pages are free?

The browser pages (`/coins`, `/yields`, `/gas`, …) stay free for humans, with per-IP rate limits sized for browsing. The paid endpoints exist for **agents**: machine discovery through the bazaar, no per-IP rate-limit negotiation, a stable machine contract (input schema + output example published in the discovery doc), and a payment path that works without a human creating an account. Both surfaces run the *same* battle-tested fetch/normalize/cache code (`api/_lib/market-data/` delegates to the exported builders in `api/coin/*` and `api/defi/*`), so the paid data can never drift from what the site shows.

## Endpoints

| Endpoint | Price | What you get |
| --- | --- | --- |
| `GET /api/x402/market-coins` | $0.001 | Ranked coin table (price, cap, volume, 24h/7d change, sparkline), up to 250/page; `?category=` sector scoping; `?q=` id search |
| `GET /api/x402/market-coin` | $0.001 | Full profile for one coin by `?id=` or `?contract=` (Solana mint) — market stats, ATH/ATL, supply, links, dev/community metrics |
| `GET /api/x402/market-chart` | $0.001 | USD price series for `?id=` over `?days=1\|7\|30\|90\|365` |
| `GET /api/x402/market-categories` | $0.001 | Every sector ranked by market cap with 24h change |
| `GET /api/x402/market-exchanges` | $0.001 | Top 100 spot exchanges by trust score, USD volume |
| `GET /api/x402/market-derivatives` | $0.001 | Perp tickers (funding, OI, volume); `?view=exchanges` for venues |
| `GET /api/x402/market-global` | $0.001 | Total cap, volume, dominance + Fear & Greed index |
| `GET /api/x402/market-gas` | $0.001 | ETH gas tiers from on-chain fee history + USD action costs |
| `GET /api/x402/market-trending` | $0.001 | Most-searched coins, categories, NFTs (24h attention) |
| `GET /api/x402/market-defi` | $0.001 | Top 100 DeFi protocols by TVL + market totals (CEX excluded) |
| `GET /api/x402/market-chains` | $0.001 | Chains ranked by TVL with share of total locked value |
| `GET /api/x402/market-yields` | $0.001 | ~15k yield pools, filterable/sortable; `?pool=<uuid>` for APY history |
| `GET /api/x402/market-stablecoins` | $0.001 | Top 100 stablecoins by supply with peg health |
| `GET /api/x402/market-fees` | $0.001 | Protocol fees (`?type=fees`) or revenue (`?type=revenue`) rankings |
| `GET /api/x402/market-dex-volumes` | $0.001 | Top 100 DEXs by 24h volume with market share |
| `GET /api/x402/market-hacks` | $0.001 | Full DeFi exploit database, searchable, with loss stats |
| `GET /api/x402/market-pulse` | $0.005 | **The bundle**: global + Fear & Greed + top-10 coins + trending + gas + DeFi TVL + stablecoins + DEX volume + fees in one call |

Full per-endpoint parameter docs are in the free index (`/api/x402/market`) and in each endpoint's discovery listing.

## The datapoint fabric — 480,000+ standalone endpoints

Beyond the 17 category endpoints, **every individual datapoint is its own paid endpoint**: one URL, one value, one micro-payment. The fabric at `/api/x402/d/<family>/<id>/<metric>` makes every (family, id, metric) triple individually addressable — ~17,500 coins × 20 metrics, ~15,500 yield pools × 7, ~6,000 protocols × 6, plus chains, stablecoins, exchanges, and the no-id global/gas/fear-greed families. **$0.0005 USDC per datapoint** (override per family with `X402_PRICE_DATAPOINT_<FAMILY>`).

```bash
# Free catalog: families, metrics, prices, live endpoint count
curl -s https://three.ws/api/x402/d

# Walk a family's entire live id space, 200 ids per page
curl -s "https://three.ws/api/x402/d?family=pool&ids=1&page=2"

# Each datapoint is one paid GET → one machine-readable value
curl -s https://three.ws/api/x402/d/coin/bitcoin/price          # → 402 challenge
curl -s https://three.ws/api/x402/d/protocol/lido/tvl
curl -s https://three.ws/api/x402/d/stablecoin/usdt/peg-deviation-bps
curl -s https://three.ws/api/x402/d/global/btc-dominance
```

A paid datapoint response is one value with provenance:

```json
{ "family": "coin", "id": "bitcoin", "metric": "price",
  "label": "Spot price", "unit": "usd", "value": 64149,
  "as_of": "2026-07-11T22:50:00.000Z", "source": "three.ws market-data" }
```

Families: `coin` (id = CoinGecko id or Solana mint), `protocol` (DeFiLlama slug), `chain` (chain name), `pool` (DeFiLlama pool uuid), `stablecoin` (DeFiLlama id or symbol), `exchange` (CoinGecko exchange id), and the id-less `global`, `fear-greed`, `gas`. A path that cannot exist (unknown family or metric, malformed id) answers 404/422 **without** issuing a payment challenge; unknown ids and upstream outages reject after verification but before settlement, so a buyer is never charged for anything but a delivered value. The public discovery doc lists a curated live slice (all global/gas/fear-greed metrics, top coins × headline metrics, top protocols × TVL); the free catalog at `/api/x402/d` enumerates everything else.

## Buying a call

Any x402 client works. The raw exchange:

```bash
# 1. Unpaid request → 402 challenge with price, networks, and pay-to address
curl -s https://three.ws/api/x402/market-pulse | jq .accepts

# 2. Pay (sign an exact-scheme USDC transfer per the challenge), then retry
#    with the payment envelope — any x402 SDK automates this:
curl -s -H "X-PAYMENT: <base64 payment payload>" https://three.ws/api/x402/market-pulse
```

With the [x402 fetch wrapper](https://www.npmjs.com/package/x402-fetch) it's one call:

```js
import { wrapFetchWithPayment } from 'x402-fetch';

const payFetch = wrapFetchWithPayment(fetch, walletClient); // your signer
const res = await payFetch('https://three.ws/api/x402/market-pulse');
const pulse = await res.json(); // { global, fear_greed, top_coins, gas, defi, ... }
```

A failed upstream never charges you: the endpoint verifies payment, runs the data fetch, and **only settles after the data is in hand**. Invalid params are rejected with a 422 before settlement, upstream outages with a 503 — in both cases no USDC moves.

## Errors

| Status | `error` | Meaning |
| --- | --- | --- |
| 402 | `payment_required` | No/invalid payment — body carries the challenge |
| 404 | `not_found` / `pool_not_found` | Unknown coin id, contract, or pool uuid |
| 422 | `invalid_*` | A parameter failed validation (message says which) |
| 503 | `data_unavailable` | Upstream outage — retry shortly; you were not charged |

## Related

- [x402 developer tools](./x402-dev-tools.md) — free test bench for debugging payment envelopes
- [Crypto Data API](https://three.ws/api/crypto) — the free, keyless Solana/pump.fun bundle (token snapshots, holders, whales)
- Sibling paid intel endpoints: `market-heatmap`, `market-mood`, `gas-oracle`, `yield-scan`, `stablecoin-health`, `hack-check`, `news-pulse`, `defi-radar` — value-added composites over the same data, also in the discovery doc
- Data sources: CoinGecko (with CoinPaprika/CoinLore failover), DeFiLlama, alternative.me, public Ethereum RPCs
