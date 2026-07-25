# `api/v1/` — the unified three.ws API

Two things live here:

1. **The platform's own versioned API** (`api/v1/index.js`, `resolve.js`, `sentiment.js`,
   `agents/`, `ai/`, `market/`, `pump/`, `token/`) — first-party endpoints three.ws built.
2. **The aggregator** (`api/v1/x/[...slug].js` + `api/v1/_providers.js`) — a growing bundle
   of third-party crypto/DeFi/on-chain APIs (CoinGecko, DefiLlama, Jupiter, DexScreener,
   Solana RPC, …) re-offered as one bill under `/api/v1/x/<provider>/<endpoint>`. This
   README is about the aggregator.

- **Public storefront:** [`/crypto-api`](https://three.ws/crypto-api) — live provider/
  endpoint table, quickstart, and links, rendered from the same registry as everything below.
- **Machine-readable spec:** [`/openapi.json`](https://three.ws/openapi.json) — generated
  from `providerCatalog()` (see [`api/openapi-json.js`](../openapi-json.js) `aggregatorPaths()`).
- **Human docs:** [`docs/api-reference.md`](../../docs/api-reference.md) § "Unified API —
  `/api/v1/x` aggregator" — the full billing-lane writeup, free-quota table, and one curl per
  provider.
- **Discovery, live:** `GET /api/v1/x` — every provider + endpoint, in JSON, straight from
  production. `GET /api/v1` (`api/v1/index.js`) folds this in under an `aggregator` key
  alongside the platform's first-party endpoints.

## Why an aggregator

An agent that needs a token's price, a swap quote, a chain's TVL, and an ENS lookup
shouldn't juggle four API keys and four rate limits. `api/v1/x` fronts them all: one base
URL, one discovery call, four billing lanes, and per-endpoint response shaping so a caller
gets normalized JSON instead of each upstream's raw (and often huge) payload.

## How a request resolves

```
GET /api/v1/x                              # discovery — no provider, lists everything
GET /api/v1/x/<provider>/<endpoint>?…      # most endpoints
POST /api/v1/x/<provider>/<endpoint>       # a few (e.g. openai/chat)
```

One catch-all route, [`api/v1/x/[...slug].js`](x/%5B...slug%5D.js), handles every provider —
adding a provider or endpoint never means a new route file. Each request is dispatched
through [`api/_lib/aggregator.js`](../_lib/aggregator.js) (`executeUpstream`,
`resolveUpstreamKey`, `getPaidHandler`) after billing-lane selection, in this order:

| Lane     | Trigger                                                             | What happens                                                                 |
| -------- | -------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| **free** | no credentials, endpoint descriptor carries a `free` quota          | served against a real per-(provider, endpoint, IP) quota — see `serveFreeLane` in `x/[...slug].js` |
| **BYOK** | caller sends the provider's own key header (e.g. `x-provider-key`)  | pure pass-through to the upstream with the caller's key — no markup, no key custody |
| **plan** | caller authenticates (three.ws API key / OAuth token / session)     | uses the platform's own upstream key, billed against the caller's plan       |
| **x402** | none of the above, or the free quota is exhausted                    | standard HTTP 402 challenge — pay per call in USDC, then retry with `X-PAYMENT` |

The free lane exists specifically so "free API" is true, not marketing copy: a scripted
`curl` with zero setup gets real data back, and the *exact same URL* upgrades in place once
the caller adds a key, a payment, or a session — no dead end, no separate "upgrade" endpoint.

## The provider registry — descriptor contract

[`api/v1/_providers.js`](_providers.js) is the single source of truth. Every consumer of the
aggregator — the catch-all route, `providerCatalog()` (discovery JSON), the OpenAPI generator,
the `/crypto-api` storefront, and the docs — reads this file at runtime/build time. **Nothing
downstream hand-enumerates endpoints.** Add a descriptor here and it appears everywhere with
zero other edits.

```js
{
  id: 'coingecko',                 // url-safe slug — first path segment under /api/v1/x
  name: 'CoinGecko',               // human label
  category: 'crypto-market-data',  // grouping for discovery
  base: 'https://api.coingecko.com/api/v3', // upstream base URL, no trailing slash
  bases: async () => [...],        // OPTIONAL: interchangeable alternate hosts (see below)
  requiresKey: false,              // true when the upstream needs a key to function at all
  envVar: 'COINGECKO_API_KEY',     // env var holding three.ws's own platform key (or null)
  byokHeader: 'x-provider-key',    // header a caller uses to supply THEIR OWN key (or null)
  applyKey: (headers, url, key) => { /* place the key where the upstream wants it */ },
  endpoints: [
    {
      id: 'price',                 // url-safe slug — second path segment
      method: 'GET',               // caller-facing verb (what api/v1/x/[...slug].js requires)
      path: '/simple/price',       // string, or (query) => string for path params
      query: (q) => ({ ids: required(q.ids, 'ids'), vs_currencies: q.vs_currencies || 'usd' }),
      transform: (data) => data,   // (data) => normalized response — default passthrough
      free: { perMin: 30, perDay: 2000 }, // unauthenticated per-IP quota, or omit for none
      priceAtomics: '1000',        // x402 price in USDC atomics (6 decimals; "1000" = $0.001)
      scope: 'agents:read',        // three.ws OAuth scope required for the plan-billing path
      summary: 'Spot price for one or more coins in any fiat/crypto.', // one line for discovery
      params: { ids: 'comma-separated CoinGecko coin ids… (required)' }, // documented inputs
    },
  ],
}
```

Full field-by-field contract, including `upstreamMethod` (for a caller-facing GET that drives
an upstream POST, e.g. Solana's single JSON-RPC endpoint) and `body`, is documented inline at
the top of [`_providers.js`](_providers.js) — read it before adding a descriptor.

### `bases` — upstream failover

Set `bases` only when the provider fronts a **pool of interchangeable hosts** that answer the
same requests, the way `solana` fronts the platform's RPC pool. It is an async function
returning a priority-ordered list of base URLs.

When it is set, a retryable failure on `base` (HTTP 429, an upstream 5xx, or an unreachable
host) moves the call to the next host instead of surfacing to the caller; a 4xx other than 429
is the caller's own mistake and is never retried. At most three hosts are tried per call, and a
host that just failed is skipped for 30 seconds so only the first request of an outage pays the
discovery cost. A provider without `bases` makes exactly one attempt, as it always did.

Do **not** use it to point at a different upstream vendor: a fallback host must return the same
response shape, because the endpoint's `transform()` runs on whatever answers.

### Adding a provider or endpoint

1. Add a descriptor (or a new `endpoints` entry on an existing one) to `PROVIDERS` in
   [`_providers.js`](_providers.js). No new route file — the catch-all resolves it.
2. Keep `transform()` slim: several upstreams (DexScreener, DefiLlama's `/protocols`,
   CoinGecko's `/coins/{id}`) return multi-hundred-KB payloads; every existing descriptor
   trims to the fields an agent actually reasons over. Follow that pattern.
3. Set `free: { perMin, perDay }` if the upstream's own keyless tier can absorb it — this is
   what makes the endpoint discoverable and usable with zero setup. Omit it for endpoints
   with real per-call cost (e.g. `openai/chat`) or an upstream that requires a key to
   function at all.
4. `docs/api-reference.md` § "Unified API" lists providers and quotas by hand today — update
   it alongside `_providers.js` (the free-quota table there is not yet auto-generated).
5. `tests/openapi-aggregator.test.js` fails the build if a registered endpoint is missing
   from the generated OpenAPI doc — run it after adding a descriptor.
6. Add a `data/changelog.json` entry (tag `feature`) if the new provider is user-visible.

## Related files

- [`api/v1/index.js`](index.js) — `GET /api/v1`, folds `providerCatalog()` into the
  platform's own endpoint discovery document.
- [`api/v1/x/[...slug].js`](x/%5B...slug%5D.js) — the aggregator front door: billing-lane
  selection, rate limiting, usage recording.
- [`api/_lib/aggregator.js`](../_lib/aggregator.js) — `executeUpstream`, `resolveUpstreamKey`,
  `getPaidHandler`: the shared engine every provider runs through.
- [`api/_lib/x402-paid-endpoint.js`](../_lib/x402-paid-endpoint.js) — the x402 challenge/
  settlement machinery `getPaidHandler` wraps around a provider endpoint.
- [`api/openapi-json.js`](../openapi-json.js) — `GET /openapi.json`; `aggregatorPaths()`
  renders every `/api/v1/x/*` path from `providerCatalog()`.
- [`pages/crypto-api.html`](../../pages/crypto-api.html) — the public storefront (`/crypto-api`).
