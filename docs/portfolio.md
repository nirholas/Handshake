# Wallet Portfolio

**Live surface: [three.ws/portfolio](https://three.ws/portfolio)**

Paste any Solana or Ethereum address and get a live portfolio: total value, the
24h move, a stablecoin/major/token breakdown, top-asset allocation, and every
holding priced in real time. Free, keyless, no account, and every portfolio has
a shareable URL.

---

## What the page shows

Top to bottom:

- **Value card**: total USD value, a 24h change pill (absolute and percent), and
  the address with copy, explorer, and share-link actions.
- **Summary cards**: holdings split three ways. *Stablecoins* (USDC, USDT, DAI
  and the rest of the recognized set), *Majors* (SOL, ETH, BTC and their liquid
  wrappers and stakes: jitoSOL, mSOL, wstETH, WBTC, ...), and *Tokens*
  (everything else). Reserve next to open risk, at a glance.
- **Allocation donut**: the top 5 assets by value plus an "Other" fold, with a
  legend carrying exact percentages and values. Hover or focus a segment for
  detail.
- **Holdings table**: every position with its portfolio share, amount, live
  price, 24h change, and value. Balances under 1% are folded behind a
  "show all" banner so a dust-filled wallet stays readable.

Deep links work: `/portfolio?address=<wallet>&chain=solana` renders the same
live view for anyone who opens it.

## Where the numbers come from

The page calls one endpoint:

```
GET /api/crypto/portfolio?address=<wallet>&chain=solana|ethereum
```

which builds on the same balance layer as
[`/api/crypto/wallet`](crypto-api.md) ([`api/_lib/balances.js`](../api/_lib/balances.js)):

- **Solana** (fully keyless): Helius DAS when a key is configured, public RPC
  otherwise; prices from Jupiter Lite with a pump.fun bonding-curve fallback;
  per-token 24h changes from DexScreener's batch endpoint; SOL's own 24h move
  from a multi-provider failover.
- **Ethereum**: Alchemy balances with CoinGecko prices and 24h changes. Requires
  a provider key on the deployment; without one the endpoint returns an honest
  `503 not_configured`, never fabricated data.

Classification and aggregation are pure functions in
[`api/_lib/portfolio-overview.js`](../api/_lib/portfolio-overview.js), unit-tested
with hand-computed fixtures in
[`tests/portfolio-overview.test.js`](../tests/portfolio-overview.test.js).

## Honesty rules

The same contract as the rest of the platform's money surfaces:

- A token with no price route is listed with its amount and marked *unpriced*.
  It is never given an invented valuation and never silently dropped.
- The aggregate 24h move is computed only over holdings whose price history is
  known, and the response states the exact share of value that covers
  (`change24h.coveragePct`). The UI repeats it: "past 24h, based on N% of value".
- If every live source fails, the endpoint serves the wallet's last confirmed
  snapshot flagged `stale: true`, and the page shows a banner saying so.

## Response shape

```json
{
	"address": "…",
	"chain": "solana",
	"totalUsd": 1234.56,
	"unpricedCount": 2,
	"change24h": { "usd": 31.2, "pct": 2.59, "coveragePct": 97.4 },
	"summary": {
		"stable": { "usd": 200, "pct": 16.2, "count": 1 },
		"major": { "usd": 800, "pct": 64.8, "count": 2 },
		"other": { "usd": 234.56, "pct": 19, "count": 5 }
	},
	"topAssets": [
		{ "symbol": "SOL", "usd": 800, "pct": 64.8, "slot": 1, "logo": "…", "id": "native" }
	],
	"rows": [
		{ "id": "…", "symbol": "SOL", "kind": "native", "class": "major", "amount": 4.2, "price": 190.4, "usd": 800, "change24h": 2.1, "sharePct": 64.8 }
	],
	"tokenCount": 8,
	"truncated": false,
	"ts": "2026-08-06T20:00:00.000Z",
	"sources": ["helius-das", "jupiter-lite", "dexscreener"]
}
```

Rows are capped at the top 200 by value (`truncated: true` flags the rest), and
responses are cached for about a minute per wallet.

## Related surfaces

- [`/wallet`](user-wallet.md): your own custodial three.ws wallet.
- `/agent-wallet`: the agent wallet hub, whose Portfolio tab covers an agent's
  holdings with FIFO cost basis and PnL attribution.
- [`/api/crypto/wallet`](crypto-api.md): the raw balances endpoint this page
  builds on, for agents and scripts.
