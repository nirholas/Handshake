# Tokens API on three.ws

[api.tokens.xyz](https://api.tokens.xyz) is the Solana Foundation's asset layer. Every other market source this platform reads is **mint-scoped**: DexScreener, GeckoTerminal, Birdeye and Raydium each answer "what is this one mint worth?" and nothing more. Tokens API answers a question none of them can: **which mints are the same asset?**

That is the whole reason it is wired in. wSOL, bridged SOL and a liquid-staking derivative are three unrelated base58 strings to every other source. Tokens API groups them into one canonical asset (`solana`) and hands back each variant with its own market, liquidity tier, trust tier and, where covered, a cached fill-quality score. A wallet panel can then say "you hold $412 of USD across 3 mints" instead of printing three rows it cannot relate to each other.

- Client: [api/\_lib/tokens-xyz.js](../api/_lib/tokens-xyz.js)
- Market-data rung: [api/\_lib/market/token-market.js](../api/_lib/market/token-market.js)
- Tests: [tests/tokens-xyz.test.js](../tests/tokens-xyz.test.js), [tests/api/token-market-tokensxyz.test.js](../tests/api/token-market-tokensxyz.test.js)
- Upstream contract: <https://docs.tokens.xyz/v1/quickstart>

## Configuration

One environment variable, server-side only:

```
TOKENS_XYZ_API_KEY=<key from the Tokens API dashboard>
```

**Without it every entry point is inert.** `resolveAsset` returns `null`, the list readers return `[]`, the batch reader returns an empty `Map`, and the market rung is skipped before it makes a request. An unconfigured deployment behaves exactly as it did before this module existed, which is why the integration can ship ahead of the key.

The key is never sent in a URL and never reaches the browser. It travels as the `x-api-key` header from server-side handlers only.

## What the client exposes

```js
import {
  tokensXyzConfigured,
  resolveAsset,
  fetchAssetVariants,
  fetchVariantMarkets,
  fetchMintMarket,
  fetchTrending,
  fetchRiskSummary,
} from '../_lib/tokens-xyz.js';
```

### Resolve any reference to a canonical asset

`ref` accepts a canonical id (`usd`), an alias, a raw Solana mint, or the `solana-<mint>` singleton form. A mint belonging to no canonical group comes back as its own singleton asset, so a real mint the registry has seen never resolves to nothing.

```js
const asset = await resolveAsset({ mint: 'FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump' });
// {
//   asset_id: 'three', resolved_by: 'mint', mint: 'FeMb…pump',
//   name: 'Three', symbol: 'THREE', category: 'crypto', aliases: [],
//   variant: { mint: 'FeMb…pump', chain: 'solana', kind: 'native',
//              liquidity_tier: 'tier2', trust_tier: 'tier2', tags: [], … },
// }
```

Cached for 6 hours: a mint-to-asset mapping changes when the upstream registry does, which is rare, and the key carries a monthly quota worth protecting.

### List every variant of an asset

```js
const variants = await fetchAssetVariants('usd', { sortBy: 'liquidity' });
const aggregate = variants.reduce((sum, v) => sum + (v.market?.liquidity ?? 0), 0);
console.log(`USD spans ${variants.length} Solana mints, $${Math.round(aggregate).toLocaleString()} pooled`);
// USD spans 27 Solana mints, $955,077,128 pooled
//   USDC   EPjFWdd5Au…  liq $623,873,106  holders 7,917,665
//   USDT   Es9vMFrzaC…  liq $119,596,584  holders 2,894,605
//   PYUSD  2b1kV6DkPA…  liq  $54,750,632  holders    55,354
```

That aggregate is the number no mint-scoped source can produce.

`sortBy` accepts `liquidity` (default), `execution_quality`, or `stock_redeemability`. Optional filters: `kind`, `liquidityTier`, `stockVariantTier`.

Each row carries:

| Field | Meaning |
| --- | --- |
| `mint`, `chain`, `kind`, `label` | Variant identity (`native`, `wrapped`, `bridged`, `lst`, `tokenized_equity`, …) |
| `liquidity_tier`, `trust_tier` | Upstream's depth and trust banding, `tier1` strongest |
| `market` | Price, liquidity, volume, cap, FDV, change, decimals, logo, holders, supply, and which upstream produced them |
| `execution` | Cached 24h fill quality (score, bot-volume ratio, fee bps, flow sources), or `null` where uncovered |
| `stock_variant_tier` | Redeemability for tokenized equities. Provider metadata for routing and display, never advice |

`market.metrics_source` is worth reading before you trust a number. `clickhouse_trades` means the figures were materialized from direct USD-stable on-chain fills; `birdeye` and `rwa_xyz` mean they came from an aggregator.

### Batch market data for a whole portfolio

This is the read the per-mint sources cannot do. Forty tokens cost forty DexScreener calls but one Tokens API call:

```js
const markets = await fetchVariantMarkets(mintsHeldByWallet);
const total = mintsHeldByWallet.reduce(
  (sum, mint) => sum + (markets.get(mint)?.market?.price_usd ?? 0) * balanceOf(mint),
  0,
);
```

Requests are chunked to the upstream cap of 50 mints per call and the input is de-duplicated first. A mint with no cached snapshot comes back as `{ asset_id, market: null, execution: null }` rather than being dropped, so the caller can tell "no data" apart from "not requested". Pass `{ strict: true }` to get an upstream failure thrown instead of a partial map.

The sibling `POST /assets/market-snapshots` endpoint takes 250 mints, but its row shape is documented as unstable, so this client uses the typed `variant-markets` endpoint and chunks instead.

### Trending, risk

```js
const hot = await fetchTrending({ limit: 20, category: 'crypto' });
const risk = await fetchRiskSummary(mint);
```

Trending ranks individual mints by short-window momentum from direct USD-stable trades. Native/wrapped SOL and stablecoins are excluded upstream because they dominate Solana routing volume.

`fetchRiskSummary` passes an `insufficient_data: true` verdict straight through. Upstream needs a cached market snapshot to score at all, and a token it has never seen is reported as unscored, never as a pass.

## Where it sits in the market-data cascade

[api/\_lib/market/token-market.js](../api/_lib/market/token-market.js) reads a mint through an ordered chain, each rung normalized to one shape:

1. **Birdeye** (keyed) - our direct read, full field set
2. **Tokens API** (keyed) - the same full field set, holder count and circulating supply included
3. **DexScreener** (keyless) - no holder count
4. **GeckoTerminal** (keyless) - no holder count
5. **DefiLlama coins** (keyless, price only)
6. **Raydium** (keyless, price only)

Tokens API sits second, and the position matters more than it looks. Birdeye's monthly compute-unit quota is the one this platform actually exhausts, and the cascade benches a quota-dead source for six hours. Before this rung, that bench dropped every read to DexScreener, which has no holder count, so the token panel lost a field for the rest of the window. Tokens API carries holders and circulating supply, so the fallback is now like-for-like instead of degraded.

This is not hypothetical. Verified live on 2026-08-11 with the Birdeye key already quota-benched:

```
wSOL    source: tokensxyz    price: 76.10   holders: 7,709,344  liq: $4,531,185,262
USDC    source: tokensxyz    price: 0.9998  holders: 7,917,665  liq: $623,873,106
$THREE  source: dexscreener  price: 0.001547  holders: null     liq: $216,882
```

$THREE falls through on purpose: it resolves to a `solana-<mint>` singleton with no cached market, so the rung returns null and the cascade continues. Coverage is curated, and a token the registry has not indexed is reported as absent rather than guessed at.

Two mapping details are load-bearing:

- `holder`, `circulatingSupply`, `totalSupply` and `fdv` are **absent from the published v1 type but present on live birdeye-sourced rows**. They are mapped when present and left null otherwise, so a `clickhouse_trades` row that omits them degrades honestly instead of reporting zero holders.
- Values reaching the rung are already normalized to number-or-null by the client and are deliberately **not** re-wrapped in the cascade's local `num()`. `Number(null)` is `0`, which would render an unknown liquidity as `$0`.

Two behaviors are load-bearing and covered by tests:

- With no key the rung is skipped **before** any request, so the cascade is byte-for-byte the one that ran before it existed.
- A 429 (rate limit or exhausted monthly quota) is rethrown with the status leading the message, which is what the cascade's circuit breaker matches on to bench the source for its cooldown window. A throttled key costs one request, not one per read.

## Errors and retries

The client follows the upstream retry matrix exactly:

| Status | Behavior |
| --- | --- |
| 429, transient 5xx | Retried with exponential backoff plus jitter (2 attempts by default) |
| 400, 401, 403, 404 | Thrown immediately - retrying burns quota and cannot succeed |

The market rung overrides `retries` to 0: a failover chain would rather move to the next source than sit through a backoff.

Upstream's error envelope (`{ error: { _tag, message } }`) is unwrapped into the thrown message, prefixed with the numeric status: `429 RateLimitedError: slow down`.

## Caching and quota

Limits **and** monthly quotas are enforced per key and both answer 429, so every read whose answer is stable goes through the shared cache: resolve 6h, variants 10m, trending 60s, risk 5m. A transient failure returns `null` internally so `cacheWrap` never pins an outage as "this asset has no variants".

The batch market read is deliberately **not** cached here. Its caller in the market cascade already owns an L1 in-process cache, an L2 cross-instance cache and a fleet-wide single-flight lock; caching the same value twice would only make the second copy stale in a different way.

## Related

- [Market Data API](./market-data-api.md) - the pay-per-call x402 endpoints behind every `/markets` page
- [Free LLM providers](./free-llm-providers.md) - the same failover-chain pattern applied to text completion
