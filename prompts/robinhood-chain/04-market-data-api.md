# 04 — Hosted Market Data API: `hood-api` (free tier + x402)

Read `prompts/robinhood-chain/_shared.md` first. Requires Wave 1 core SDK
(`file:../robinhood-chain-sdk`). Coordinates with prompt 05 (`hood402`) — if its middleware
exists when you run, consume it; otherwise implement x402 402-challenge handling inline against
the standard x402 spec and leave a clean seam to swap in `hood402` later.

## Mission
Build `robinhood/hood-api/` — a deployable REST API service that is the missing market-data
layer for Robinhood Chain, monetized with x402. Nobody offers this: RWA.xyz is enterprise-paid,
CoinGecko has no equity semantics. This is the flagship API product.

## Endpoints (all real data, JSON, versioned under `/v1`)

Free (rate-limited by IP, generous):
- `GET /v1/health`, `GET /v1/chain` — chain stats: block height, gas, TVL (DefiLlama), bridge flows.
- `GET /v1/stocks` — all Stock Tokens: Chainlink price, DEX price (Uniswap pool mid), premium/
  discount between the two, uiMultiplier, 24h DEX volume + liquidity (GeckoTerminal/on-chain).
- `GET /v1/stocks/:symbol` — detail: candles (from hoodkit-style swap-event OHLCV or
  GeckoTerminal), holders (Blockscout), feed metadata, contract links.
- `GET /v1/coins` — memecoins: launchpad state (bonding/graduated), price, volume, age, holders.
- `GET /v1/coins/:address` — detail incl. launch info and graduation status.
- `GET /v1/launches` — recent + live launchpad activity (NOXA, The Odyssey).

Paid via x402 (USDC on Base + USDG on Robinhood Chain when hood402 lands; price each $0.001–0.01):
- `GET /v1/portfolio/:address` — multiplier-correct full portfolio with USD valuation + PnL basis.
- `GET /v1/stocks/:symbol/history` — deep OHLCV history.
- `GET /v1/equities` — THE unique one: unified cross-issuer tokenized-equity view — same
  underlying ticker across Robinhood Chain, xStocks (Backed, public no-auth API per their docs)
  and Ondo GM (Chainlink tokenized-equity feeds): normalized price, venue premium/discount
  spread, where it's cheapest. Cache upstreams respectfully.
- `GET /v1/firehose` token + `wss /v1/ws` — real-time stream (launches, big swaps, stock ticks)
  with metered x402 session auth.

## Requirements
- Node 20 + Express (or Hono), no framework bloat; strict input validation (zod); per-endpoint
  cache TTLs; upstream failover (public RPC → Alchemy if `ALCHEMY_KEY` set; CoinGecko →
  GeckoTerminal → on-chain, in the failover style of three.ws market handlers).
- Every response includes `source` + `asOf` fields. Errors are structured
  (`{ error, hint, docs }`) — never a bare 500.
- OpenAPI 3.1 spec (`openapi.json`) generated and served at `/v1/openapi.json`; docs site renders it.
- Deploy: `Dockerfile` (distroless, PORT-aware) + Cloud Run instructions + `vercel.json`
  alternative. Deploy for real only if creds exist; otherwise document exact commands.
- Tests: vitest with real upstream integration tests (hit your own running server via
  `npm run dev` in the test, assert real data shapes; no recorded fixtures for the live suite).
- `docs/` static site per `_shared.md`: landing with LIVE example responses (fetched client-side
  from the deployed URL if deployed, else rendered from a real captured response with a clear
  "sample of live output" label — capture it during your run, from the real server), full
  endpoint reference from the OpenAPI spec, x402 payment walkthrough with a working client
  snippet, pricing table.

## Done checklist
- [ ] Local server run exercised: `curl` transcript for every endpoint in the report (real data).
- [ ] x402 402-challenge → pay → 200 flow proven with a scripted client (testnet/base-sepolia
      settlement acceptable for the E2E; document the mainnet config).
- [ ] `/v1/equities` returns a real cross-venue row for at least 3 tickers with venue spreads.
- [ ] OpenAPI validates; Dockerfile builds; report lists deploy status + owner actions.
