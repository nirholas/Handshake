<p align="center">
  <a href="https://three.ws"><img src="https://three.ws/three-ws-mcp-icon.svg" width="72" height="72" alt="three.ws" /></a>
</p>

<h1 align="center">@three-ws/intel</h1>

<p align="center"><strong>Token sentiment + market intelligence in one import — for agents and dashboards that need to read the market before they act.</strong></p>

<p align="center">
  <a href="https://www.npmjs.com/package/@three-ws/intel"><img alt="npm" src="https://img.shields.io/npm/v/@three-ws/intel?logo=npm&color=cb3837"></a>
  <a href="https://www.npmjs.com/package/@three-ws/intel"><img alt="downloads" src="https://img.shields.io/npm/dm/@three-ws/intel?color=cb3837"></a>
  <img alt="license" src="https://img.shields.io/npm/l/@three-ws/intel?color=3b82f6">
  <img alt="node" src="https://img.shields.io/node/v/@three-ws/intel?color=339933&logo=node.js">
</p>

<p align="center">
  <a href="#install">Install</a> ·
  <a href="#quick-start">Quick start</a> ·
  <a href="#api">API</a> ·
  <a href="#how-it-works">How it works</a> ·
  <a href="#pricing--payment">Pricing</a> ·
  <a href="https://three.ws">three.ws</a>
</p>

---

> `@three-ws/intel` is the official client for the three.ws **market intelligence**
> surface — four reads that tell you what a token is *worth*, what people are
> *saying* about it, and where attention is *flowing*. It wraps four live
> endpoints: a deterministic **sentiment pulse** over pump.fun commentary, the
> **aixbt narrative intel** feed, **momentum-ranked project scans**, and a
> real-time **Solana token snapshot** (price, volume, holders, metadata). The
> sentiment endpoint is public and key-free; the aixbt and snapshot lanes are
> exposed as paid MCP tools settled in USDC over [x402](https://x402.org). It
> pairs with [`@three-ws/forge`](https://www.npmjs.com/package/@three-ws/forge) —
> Forge *makes* assets, Intel *reads* the market they trade into.

## Why

Reading a token means stitching together five providers — pump.fun comments,
Jupiter price, Dexscreener volume, Solana RPC holder distribution, and a
narrative source — then normalizing five different payload shapes, handling each
one's rate limits, and scoring sentiment yourself. Intel does that once:

- **One import, four reads.** `sentiment(mint)`, `intel(query)`, `projects()`,
  `snapshot(mint)` — each a single call returning a stable, normalized shape.
- **Real data, no fakes.** Every field comes from a live source. If a provider
  is unreachable, the field is `null` so you see the gap — never a fabricated
  number.
- **Sentiment that's reproducible.** The pulse uses a deterministic lexicon
  scorer, not an opaque model, so the same comments always yield the same score.
- **Narrative + momentum in one place.** The aixbt bridge surfaces what's being
  said (`intel`) and what's spiking (`projects`) without you holding an aixbt
  key — it stays server-side.

This is the SDK twin of the [3D Studio MCP server](https://three.ws/mcp) — the
same `sentiment_pulse`, `aixbt_intel`, `aixbt_projects`, and `pump_snapshot`
tools, exposed as plain functions instead of MCP calls.

## Install

```bash
npm install @three-ws/intel
```

Zero runtime dependencies. Works in Node 18+ and the browser (uses `fetch`). To
auto-pay the paid lanes (aixbt + snapshot), add
[`@three-ws/x402-fetch`](https://www.npmjs.com/package/@three-ws/x402-fetch).

## Quick start

The sentiment lane is public — no key, no wallet:

```js
import { sentiment } from '@three-ws/intel';

const pulse = await sentiment('FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump'); // $THREE

console.log(pulse.overall.score);   // → 0.42  (range -1 … 1)
console.log(pulse.overall.posPct);  // → 58
console.log(pulse.breakdown.pumpfun.count); // comments scored
```

A fuller read — narrative, momentum, and an on-chain snapshot together:

```js
import { intel, projects, snapshot } from '@three-ws/intel';

const narrative = await intel({ chain: 'solana', limit: 10 });
const hot       = await projects({ chain: 'solana', limit: 10 });
const market    = await snapshot('THREEsynthetic1111111111111111111111111111');

console.log(narrative.intel[0].description);  // what's being said
console.log(hot.projects[0].scores.spiking);  // momentum rank
console.log(market.priceUsd, market.holders.topHolderCount);
```

Fold your own signals (e.g. X cashtag posts you collected) into the pulse:

```js
const pulse = await sentiment('FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump', {
  limit: 150,
  extraTexts: ['$THREE volume ripping today', 'best 3D agent stack on Solana'],
});
console.log(pulse.breakdown.extra.score); // score of just your snippets
```

## API

Public exports: `sentiment`, `intel`, `projects`, `snapshot`, `createIntel`,
`ThreeWsError`, `PaymentRequiredError`, and `DEFAULT_BASE_URL`. The four reads
use a shared zero-config client; `createIntel({ baseUrl, fetch, apiKey,
headers })` builds your own when you need a payment-aware fetch for the paid
lanes or a custom origin reused across calls.

### `sentiment(mint, options?) → Promise<SentimentPulse>`

Real-time sentiment pulse for a Solana token. Pulls recent pump.fun comments via
`frontend-api-v3`, optionally folds in caller-supplied snippets, and scores the
combined stream with the three.ws deterministic lexicon. Wraps
`POST /api/social/sentiment-pulse`. **Public — no key required.**

**Options**

| Option | Type | Default | Notes |
|---|---|---|---|
| `limit` | `number` | `100` | Max pump.fun comments to fetch + score (1–200). |
| `extraTexts` | `string[]` | `[]` | Up to 200 extra snippets (≤2000 chars each) to score alongside. |

**Returns** `SentimentPulse`

| Field | Type | Notes |
|---|---|---|
| `ok` | `true` | Present on success. |
| `token` | `string` | The mint you queried. |
| `overall` | `Score` | Combined score over comments + extras. |
| `breakdown.pumpfun` | `Score` | Just the pump.fun comments (or `{ error, count: 0 }` if the source failed). |
| `breakdown.extra` | `Score` | Just your `extraTexts`. |
| `sources` | `object` | `{ pumpfun, pumpfunCount, extraCount }`. |
| `fetchedAt` | `string` | ISO timestamp. |

A `Score` is `{ score, posPct, negPct, neuPct, count, examples }` — `score` runs
`-1 … 1`, the `*Pct` fields sum to 100, and `examples` carries `{ pos, neg }`
representative lines.

### `intel(query?) → Promise<IntelFeed>`

aixbt narrative intelligence feed — recent intel items detected across crypto.
Wraps `GET /api/aixbt/intel`. **Paid via the `aixbt_intel` MCP tool ($0.01).**

**Query**

| Field | Type | Default | Notes |
|---|---|---|---|
| `limit` | `number` | `20` | Items to return (1–100; the bridge caps the upstream call at 50). |
| `category` | `string` | — | Filter to one aixbt intel category. |
| `chain` | `string` | — | Filter to a chain, e.g. `solana`, `base`, `ethereum`. |

**Returns** `{ intel: IntelItem[], pagination }`, where each `IntelItem` is
`{ category, description, detected_at, reinforced_at, observations, official_source, project, ticker, source }`.

### `projects(query?) → Promise<ProjectScan>`

aixbt momentum scan — projects ranked by spiking / climbing / active scores, with
market metrics and recent intel per project. Wraps `GET /api/aixbt/projects`.
**Paid via the `aixbt_projects` MCP tool ($0.01).**

**Query**

| Field | Type | Default | Notes |
|---|---|---|---|
| `limit` | `number` | `20` | Projects to return (1–100; upstream capped at 50). |
| `page` | `number` | `1` | Page of the ranked list (1–100). |
| `names` | `string` | — | Comma-separated names/tickers to filter to. |
| `chain` | `string` | — | Filter to a chain. |

**Returns** `{ projects: Project[], pagination }`. Each `Project`:

| Field | Type | Notes |
|---|---|---|
| `id` / `name` / `ticker` | `string` | Identity. |
| `x_handle` | `string \| null` | Project X handle. |
| `address` / `chain` | `string \| null` | Primary token address + chain. |
| `scores` | `{ spiking, climbing, active }` | aixbt momentum scores. |
| `trajectory` | `string \| null` | Spiking/climbing trajectory note. |
| `market` | `{ price_usd, market_cap, volume_24h, change_24h }` | Live metrics (`null` where unavailable). |
| `intel` | `IntelItem[]` | Up to 10 recent intel items for the project. |
| `categories` | `string[]` | CoinGecko categories. |

### `snapshot(mint) → Promise<TokenSnapshot>`

Live market snapshot for any Solana SPL or pump.fun token. Generic plumbing — it
takes whatever mint you pass at runtime. Wraps the `pump_snapshot` MCP tool.
**Paid ($0.005).**

**Returns** `TokenSnapshot`

| Field | Type | Notes |
|---|---|---|
| `token` | `string` | The mint. |
| `priceUsd` | `number \| null` | USD price (Jupiter, falling back to Dexscreener). |
| `priceSource` | `'jupiter' \| 'dexscreener' \| null` | Which source priced it. |
| `price` | `object` | Jupiter detail: `{ usdPrice, priceChange24hPct, liquidityUsd, decimals, blockId }`. |
| `volume24h` | `object` | Dexscreener: `{ volume24hUsd, dex, pairAddress, url, marketCapUsd, … }`. |
| `meta` | `object` | pump.fun metadata: `{ name, symbol, imageUrl, creator, marketCapUsd, … }`. |
| `holders` | `object` | `{ topHolderCount, topHolders[] }` from Solana RPC `getTokenLargestAccounts`. |
| `helius` | `object \| null` | Supply/decimals/price from Helius DAS when `HELIUS_API_KEY` is set. |
| `image` | `string \| null` | Token image. |
| `sources` | `object` | The exact upstream URLs each field came from. |
| `fetchedAt` | `string` | ISO timestamp. |

## How it works

Four independent reads, each fronting a normalized aggregate. The aixbt key and
all provider keys live server-side — the SDK never holds them.

```
  sentiment(mint) ─▶ POST /api/social/sentiment-pulse
                       └─ pump.fun frontend-api-v3 replies → lexicon scorer

  intel(query)    ─▶ GET  /api/aixbt/intel ─┐
  projects(query) ─▶ GET  /api/aixbt/projects ┴─▶ aixbt REST v2 (key server-side)

  snapshot(mint)  ─▶ pump_snapshot (x402) ─┬─ Jupiter Lite      → price
                                           ├─ Dexscreener       → volume + pair
                                           ├─ pump.fun api-v3    → name/image/mcap
                                           ├─ Solana RPC         → top holders
                                           └─ Helius DAS (opt)   → exact supply
```

- **Sentiment** is deterministic: the same comments always produce the same
  score. The pulse fetches the most recent batch from pump.fun and scores
  positive/negative term matches — no model, no randomness.
- **Narrative + momentum** ride the three.ws ⇄ aixbt bridge. aixbt wraps its
  reads as `{ status, data, pagination }`; the bridge unwraps and normalizes them
  into the lean shapes above so an upstream change never ripples into your code.
- **Snapshot** fans out to five sources in parallel and stitches the results.
  Price has a built-in fallback (Jupiter → Dexscreener) so the single most
  important field has two independent backers.

## Pricing & payment

The sentiment lane is genuinely free — it relies only on public pump.fun data
and an in-repo scorer. The aixbt and snapshot lanes are flat per-call prices,
quoted in USDC and settled `exact` on Solana mainnet over [x402](https://x402.org):

| Call | Tool | Price | Lane |
|---|---|---|---|
| `sentiment()` | `sentiment_pulse` | **free** over the public endpoint¹ | pump.fun + lexicon |
| `intel()` | `aixbt_intel` | **$0.01** USDC | aixbt bridge |
| `projects()` | `aixbt_projects` | **$0.01** USDC | aixbt bridge |
| `snapshot()` | `pump_snapshot` | **$0.005** USDC | multi-provider |

¹ The `sentiment_pulse` MCP tool is priced at **$0.003 USDC** for agent callers;
the underlying `POST /api/social/sentiment-pulse` HTTP endpoint this SDK targets
is public and key-free. Pair with
[`@three-ws/x402-fetch`](https://www.npmjs.com/package/@three-ws/x402-fetch) to
automate the 402 settlement on the paid calls.

## Errors & edge cases

Every state is designed — a missing key or an unreachable provider returns a
typed state, never a crash or a fake number.

| State | HTTP | Where | Meaning & recovery |
|---|---|---|---|
| `validation_error` | 400 | sentiment | `token` isn't a base58 mint, or body is malformed. Fix the input. |
| `aixbt_not_configured` | 503 | intel / projects | Deployment has no `AIXBT_API_KEY`. Response carries a `setup` hint pointing at the aixbt key pass. |
| `aixbt_unauthorized` | 503 | intel / projects | aixbt rejected the deployment's key (expired, revoked, or below the required plan). Rotate it. Carries the same `setup` hint as `aixbt_not_configured`. |
| `aixbt_rate_limited` | 429 | intel / projects | aixbt throttled the bridge. Back off and retry. |
| `aixbt_upstream_error` | 502/504 | intel / projects | aixbt was unreachable or errored. Retry. |
| `invalid_mint` | — | snapshot | `token` isn't a valid Solana pubkey. Fix it. |
| `payment_required` | 402 or 401 | intel / projects / snapshot | Paid lane with no x402 payment; rejects with `PaymentRequiredError` carrying the challenge in `accepts`. The MCP transport behind `snapshot()` quotes its challenge over HTTP 401 (x402Version + accepts in the body); the SDK maps both to the same typed error. Attach a payer (see [Pricing](#pricing--payment)). |
| field `= null` | 200 | snapshot | A provider was unreachable. The field is `null` and `sources` shows which one — partial data, never fabricated. |

In the sentiment pulse, a pump.fun failure doesn't fail the whole call:
`breakdown.pumpfun` becomes `{ error, count: 0 }` and the overall score reflects
whatever did resolve (e.g. just your `extraTexts`). Branch on it in your UI.

## Examples

**Agent decision gate** — read sentiment + momentum before acting:

```js
import { sentiment, projects } from '@three-ws/intel';

const mint = 'FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump'; // $THREE
const [pulse, scan] = await Promise.all([
  sentiment(mint),
  projects({ chain: 'solana', limit: 5 }),
]);

const bullish = pulse.overall.score > 0.2 && pulse.overall.count >= 20;
const trending = scan.projects.some((p) => (p.scores.spiking ?? 0) > 0.8);
if (bullish && trending) console.log('signal: attention + positive chatter');
```

**Dashboard tile** — render a live token card in the browser:

```html
<script type="module">
  import { snapshot, sentiment } from '@three-ws/intel';

  const mint = 'THREEsynthetic1111111111111111111111111111';
  const [m, s] = await Promise.all([snapshot(mint), sentiment(mint)]);

  document.querySelector('#card').innerHTML = `
    <h3>${m.meta?.name ?? 'Token'} · ${m.meta?.symbol ?? '—'}</h3>
    <p>$${m.priceUsd ?? '—'} · vol $${m.volume24h?.volume24hUsd ?? '—'}</p>
    <p>sentiment ${Math.round(s.overall.posPct)}% positive
       (${s.overall.count} comments)</p>`;
</script>
```

**Narrative monitor** — poll the intel feed for a category:

```js
import { intel } from '@three-ws/intel';

const feed = await intel({ category: 'partnership', limit: 15 });
for (const item of feed.intel) {
  if (item.official_source) console.log(`[${item.ticker}] ${item.description}`);
}
```

## Related

- [`@three-ws/forge`](https://www.npmjs.com/package/@three-ws/forge) — generate the 3D assets that trade into these markets.
- [`@three-ws/x402-fetch`](https://www.npmjs.com/package/@three-ws/x402-fetch) — auto-pay the aixbt + snapshot lanes in USDC.
- [`@three-ws/avatar`](https://www.npmjs.com/package/@three-ws/avatar) — render an agent that acts on this intelligence.

---

<p align="center">Built by <a href="https://three.ws">three.ws</a> · The only coin is <a href="https://three.ws">$THREE</a></p>
