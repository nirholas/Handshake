# hood-api

**The hosted market-data API for [Robinhood Chain](https://docs.robinhood.com/chain/) (chain ID 4663).**

Stock Tokens priced against Chainlink *and* the DEX — with the real premium or discount
between them. Memecoin launchpad tracking (NOXA, The Odyssey). Multiplier-correct portfolio
valuation. The only place that prices the same underlying ticker across Robinhood Chain,
xStocks, and Ondo Global Markets side by side. A real-time firehose. Free for the basics,
metered with [x402](#paying-with-x402) for the deep stuff — no API keys, no subscriptions.

Docs: **https://nirholas.github.io/hood-api/** · OpenAPI 3.1: [`openapi.json`](./openapi.json)

## Why this exists

RWA.xyz is enterprise-paid. CoinGecko has no equity semantics — it can't tell you a Stock
Token's premium over its underlying share, or that a `uiMultiplier()` corporate action just
changed what a balance is worth. Nobody prices Robinhood Chain Stock Tokens against xStocks
and Ondo Global Markets in one call. This API is that missing layer, built on
[`hoodchain`](https://github.com/nirholas/robinhood-chain-sdk).

## Endpoints

All responses are JSON, versioned under `/v1`, and carry `asOf` (read timestamp) +
`source` (which upstreams answered). Errors are always `{ error, hint, docs }` — never a
bare 500.

### Free (IP-rate-limited, generous, no key)

| Endpoint | Query params | What it returns |
| --- | --- | --- |
| `GET /v1/health` | — | Liveness + RPC reachability, chain ID, block height, whether payments are enabled |
| `GET /v1/chain` | — | Block height, gas (current/slow/average/fast gwei), TVL (DefiLlama), ETH price, market cap, tx counts |
| `GET /v1/stocks` | — | All 95 Stock Tokens: Chainlink price, DEX price, premium/discount, `uiMultiplier`, liquidity, pool |
| `GET /v1/stocks/{symbol}` | `interval`: `5m`\|`15m`\|`1h`\|`4h`\|`1d` | One token in depth: Chainlink round data, DEX stats + 24h volume, OHLCV candles, holders, links |
| `GET /v1/coins` | `limit`: 1–60 | Memecoins: launchpad state (bonding/graduated), price, liquidity, holders, age |
| `GET /v1/coins/{address}` | — | Coin detail: launch info, graduation status, DEX stats, holder/transfer counts |
| `GET /v1/launches` | `launchpad`: `noxa`\|`odyssey` · `lookback`: `15m`\|`1h`\|`6h`\|`24h` · `limit`: 1–200 | Recent + live launchpad activity (NOXA, The Odyssey) |

### Paid (metered via x402 — USDC on Base or Base Sepolia)

| Endpoint | Query params | Price | What it returns |
| --- | --- | --- | --- |
| `GET /v1/portfolio/{address}` | — | $0.002 | Multiplier-correct portfolio: per-position balance, share-equivalent, USD value, explicit valuation basis |
| `GET /v1/stocks/{symbol}/history` | `interval`, `lookback`: `1h`\|`6h`\|`24h`\|`7d`\|`30d` | $0.005 | Deep OHLCV reconstructed from swap logs, up to 30 days |
| `GET /v1/equities` | `limit`: 1–30 | $0.01 | Cross-venue spread table: Robinhood Chain vs xStocks vs Ondo, cheapest venue + spread in bps |
| `GET /v1/equities/{symbol}` | — | $0.01 | Cross-venue price for one ticker, same three legs |
| `GET /v1/firehose` → `wss /v1/ws` | — | $0.01/session | Mints a ~10-minute session token, then streams `firehose`/`launches`/`trades`/`ticks` for free over the token's lifetime |

Full reference with request/response schemas: [`openapi.json`](./openapi.json), rendered at
[the docs site](https://nirholas.github.io/hood-api/#endpoints).

## Quickstart

```bash
curl https://your-hood-api.example.com/v1/stocks
curl https://your-hood-api.example.com/v1/stocks/TSLA
```

### Paying with x402

Paid endpoints return HTTP 402 with a signed payment challenge when called without payment:

```bash
curl https://your-hood-api.example.com/v1/portfolio/0xYourAddress
# HTTP 402
# { "accepts": [ { "scheme": "exact", "network": "base-sepolia", "payTo": "0x...",
#     "asset": "0x036CbD53842c5426634e7929541eC2318f3dCF7e", "maxAmountRequired": "2000", ... } ] }
```

Pay it with [`x402-fetch`](https://www.npmjs.com/package/x402-fetch):

```ts
import { createSigner } from 'x402/types'
import { wrapFetchWithPayment } from 'x402-fetch'

const signer = await createSigner('base-sepolia', process.env.PRIVATE_KEY)
const fetchWithPay = wrapFetchWithPayment(fetch, signer)

const res = await fetchWithPay('https://your-hood-api.example.com/v1/portfolio/0xYourAddress')
console.log((await res.json()).totalUsd)
```

### Real-time firehose

`GET /v1/firehose` is the only paid step; it mints a short-lived signed session token. Open the
WebSocket with that token and stream free for the session's ~10-minute lifetime — this keeps the
paywall on the cheap HTTP call while the long-lived connection needs no per-message billing:

```bash
# 1. Pay once for a session token (x402, $0.01)
curl -H "X-PAYMENT: <payment-header>" https://your-hood-api.example.com/v1/firehose
# { "sessionToken": "…", "expiresAt": "…", "wsUrl": "wss://{host}/v1/ws?token=…",
#   "channels": ["firehose", "launches", "trades", "ticks"] }
```

```js
// 2. Connect and subscribe to any subset of channels via ?channels=
const ws = new WebSocket('wss://your-hood-api.example.com/v1/ws?token=SESSION_TOKEN&channels=launches,ticks')
ws.onmessage = (evt) => console.log(JSON.parse(evt.data))
// { "channel": "launches", "data": { "launchpad": "noxa", "token": "0x...", ... }, "at": "..." }
```

| Channel | Content |
| --- | --- |
| `firehose` | Raw sequencer transactions, ~100–300ms pre-confirmation |
| `launches` | New NOXA / Odyssey token launches (confirmed log watch) |
| `trades` | Odyssey bonding-curve buys/sells |
| `ticks` | Chainlink Stock Token price changes, polled every 15s and emitted only on change |

One shared upstream subscription per channel fans out to every connected socket — N paying
clients never cost N sequencer connections or N RPC watchers, and an idle deployment makes zero
background calls (upstreams start on the first subscriber, stop when the last disconnects).

## Architecture

- **Runtime:** Node 20+, [Hono](https://hono.dev) + [`@hono/zod-openapi`](https://github.com/honojs/middleware/tree/main/packages/zod-openapi)
  for typed routes and a generated OpenAPI 3.1 doc, [`@hono/node-ws`](https://github.com/honojs/node-ws)
  for the firehose WebSocket.
- **Chain reads:** [`hoodchain`](https://github.com/nirholas/robinhood-chain-sdk) (the
  Wave-1 SDK) — Chainlink quotes, Uniswap v3 DEX quotes/pools, the Stock Token registry,
  launchpad log scans, the sequencer firehose. RPC fails over public → Alchemy when
  `ALCHEMY_KEY` is set.
- **Off-chain data:** Blockscout (holders, gas, chain stats), DefiLlama (TVL), CoinGecko
  (xStocks + Ondo Global Markets prices for `/v1/equities` — GeckoTerminal has not indexed
  chain 4663 yet, so DEX stats are read directly on-chain instead).
- **Payments:** [`x402-hono`](https://www.npmjs.com/package/x402-hono) middleware gates paid
  routes against the real x402 facilitator (`x402.org/facilitator` for Base Sepolia testnet,
  or the CDP facilitator for Base mainnet USDC). Route handlers themselves return a clean
  503 `payments_not_configured` when no `X402_PAY_TO` is set, so the free tier always works
  even with payments disabled.
- **Cache:** in-process TTL cache with single-flight de-duplication (`src/lib/cache.ts`) —
  tuned per resource to each upstream's real update cadence (Chainlink feeds vs. DefiLlama's
  daily TVL series vs. Blockscout holder counts).
- **Firehose:** one shared upstream subscription per channel (`firehose`, `launches`,
  `trades`, `ticks`), fanned out to every connected socket — N paying clients never cost N
  sequencer connections. Upstreams start lazily on the first subscriber and stop when the
  last disconnects.

## Local development

```bash
npm install
cp .env.example .env   # every var has a sane default — the free tier needs none
npm run dev            # tsx watch, :8787
```

**`hoodchain` isn't on the npm registry yet.** `package.json` currently pins it to a checked-in
tarball (`hoodchain-0.1.0.tgz`), not a version range — `npm install` resolves it straight from
that file. If you're iterating on the SDK alongside this API, rebuild and repack it, then
reinstall here:

```bash
cd ../robinhood-chain-sdk   # or wherever the sibling SDK checkout lives
npm run build && npm pack   # produces hoodchain-0.1.0.tgz
cp hoodchain-0.1.0.tgz ../hood-api/
cd ../hood-api && npm install
```

```bash
npm test              # vitest — real upstream integration tests, no mocks/fixtures
npm run test:x402      # the 402 → pay → 200 flow against the real base-sepolia facilitator
npm run build          # tsc -> dist/
npm run openapi        # regenerate openapi.json from the live route definitions
npm run capture-samples  # regenerate docs/samples.js from a running instance
```

## Testing

`npm test` hits a real, in-process instance of this server — real RPC calls, real
Blockscout/DefiLlama/CoinGecko requests, zero mocks or recorded fixtures. Assertions check
shapes and invariants (types, known addresses, provenance fields) since live values change
between runs.

`npm run test:x402` proves the actual payment flow: it starts a real HTTP server, hits a
paid route unpaid (asserts the genuine 402 challenge shape from the live facilitator), and
— if `X402_TEST_PRIVATE_KEY` is set to a funded Base Sepolia key — completes a real
settlement end to end. Funding that key requires Circle's faucet
(`faucet.circle.com`), which gates behind a browser + reCAPTCHA with no scriptable path; the
test explains this and skips cleanly when the key is absent rather than failing or faking
success.

## Deploy

### Google Cloud Run (preferred)

```bash
gcloud run deploy hood-api \
  --source . \
  --region us-central1 \
  --allow-unauthenticated \
  --set-env-vars PUBLIC_BASE_URL=https://hood-api-xxxx.run.app,X402_NETWORK=base-sepolia \
  --set-env-vars X402_PAY_TO=0xYourReceivingAddress
```

Or build + push the image directly with the checked-in `Dockerfile` (distroless, PORT-aware
— reads `PORT` via `env.ts`, defaults to 8080 for Cloud Run):

```bash
docker build -t gcr.io/YOUR_PROJECT/hood-api .
docker push gcr.io/YOUR_PROJECT/hood-api
gcloud run deploy hood-api --image gcr.io/YOUR_PROJECT/hood-api --region us-central1 --allow-unauthenticated
```

**Pre-publish note:** `hoodchain-0.1.0.tgz` is checked into this repo and `package.json`
already points its `hoodchain` dependency at that file, so `docker build` / `gcloud run
deploy --source .` work as-is with no extra step. If you bump the SDK, repack it (`npm run
build && npm pack` in the sibling `robinhood-chain-sdk` checkout), overwrite
`hoodchain-0.1.0.tgz` here, and commit both the new tarball and the regenerated
`package-lock.json` before deploying.

### Vercel (alternative)

Not the preferred target for this service (long-lived WebSocket connections and background
firehose subscriptions don't fit Vercel's serverless function model as cleanly as Cloud
Run's always-on containers), but the free + paid HTTP routes work fine as serverless
functions if you need it:

```bash
npm i -g vercel
vercel --prod
```

Set the same environment variables as above via `vercel env add`. The `/v1/ws` WebSocket
route will not function under Vercel's serverless runtime — deploy to Cloud Run (or any
long-running Node host) if you need the firehose.

## Environment variables

Copy [`.env.example`](./.env.example) to `.env`. Every variable has a working default; the free
tier runs with none of them set.

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `8787` | HTTP/WS listen port (Cloud Run and most PaaS inject `PORT` automatically). |
| `PUBLIC_BASE_URL` | `http://localhost:{PORT}` | Base URL advertised in the OpenAPI `servers` block and the docs console. |
| `ALCHEMY_KEY` | — | RPC reads fail over from the public RPC to Alchemy when set. |
| `HOOD_RPC_URL` | — | Fully custom mainnet RPC URL; overrides both the public RPC and Alchemy. |
| `COINGECKO_API_KEY` | — | CoinGecko Pro/Demo key, raises rate limits for `/v1/equities`. |
| `X402_PAY_TO` | — | **Required to enable paid endpoints** — the `0x…` payout address. Unset → paid routes return `503 payments_not_configured`. |
| `X402_NETWORK` | `base-sepolia` | Settlement network: `base` (mainnet USDC) or `base-sepolia` (testnet USDC). |
| `X402_FACILITATOR_URL` | `https://x402.org/facilitator` | Facilitator used for `base-sepolia`; ignored for `base` once CDP credentials are set. |
| `CDP_API_KEY_ID` / `CDP_API_KEY_SECRET` | — | Coinbase Developer Platform facilitator credentials, used automatically when `X402_NETWORK=base` for real Base-mainnet USDC settlement. |
| `FIREHOSE_SESSION_SECRET` | random per process | HMAC secret signing metered firehose session tokens; set a stable value across a multi-instance fleet. |
| `X402_TEST_PRIVATE_KEY` | — | **Test only** (`test/x402.test.ts`) — a base-sepolia-funded key that proves the real 402 → pay → 200 flow. Never set in production. |

## Legal

Stock Tokens are tokenized debt securities (issuer: Robinhood Assets (Jersey) Ltd) and may
not be offered, sold, or delivered to US persons (additional limits: Canada, UK,
Switzerland). This API only **displays** Stock Token data — that's unrestricted. It never
executes a swap, transfer, or acquisition of any kind.

## License

Apache-2.0 © 2026 nirholas

---

Built by [nirholas](https://x.com/nichxbt) · [three.ws](https://three.ws)
