# API

Vercel serverless functions that power the three.ws backend. Every `.js` file under `api/` (outside the `_`-prefixed helper folders) is deployed as its own HTTP endpoint, and the file path maps directly to the route:

- `api/agents.js` -> `/api/agents`
- `api/avatars/index.js` -> `/api/avatars`
- `api/agents/[id].js` -> `/api/agents/:id`
- `api/erc8004/[action].js` -> `/api/erc8004/:action`
- `api/studio-assets/[...path].js` -> `/api/studio-assets/*`

Most handlers run on the Node.js runtime; `api/chat.js` runs on the Edge runtime to stream SSE. `vercel.json` sets `maxDuration` / `includeFiles` per function and declares the cron schedule (see below).

## Shared internals (not endpoints)

The `_`-prefixed folders are imported by the endpoints; they are not routes:

- `_lib/` — shared helpers. HTTP utilities in `_lib/http.js` (`json`, `text`, `redirect`, `error`, `readJson`, `readForm`, `cors`, `wrap`, `method`); Postgres in `_lib/db.js` (the `sql` tagged-template proxy + `query`); auth in `_lib/auth.js` (`getSessionUser`, `authenticateBearer`, `extractBearer`, `hasScope`, sessions, access/refresh tokens, CSRF). Also covers x402 (`x402*.js`), Solana/EVM transfers, pump.fun pricing, R2 storage, rate limiting, and validation.
- `_mcp/` — Model Context Protocol internals: tool `catalog`, `dispatch`, `auth`, `payments`, `render`, `embed-policy`.
- `_providers/` — third-party provider adapters (`gcp.js`, `huggingface.js`, `replicate.js`).

## Endpoint groups

### Agents and identity
- `agents.js`, `agents/` — agent identity registry: list/create, `agents/me`, `agents/[id]` (get/update), plus `by-wallet`, `check-name`, `pricing`, `talk`, `sns`, `solana-wallet`, `pumpfun`, `nfts`, `suggest`, and more.
- `agent-3d/`, `agent-actions.js`, `agent-delegate.js`, `agent-memory.js`, `agent-skills.js`, `agent-skill-price.js`, `agent-strategy.js` — agent versions, actions, ERC-7710 delegation, memory, and skills.
- `erc8004/` — ERC-8004 identity + reputation via an `[action].js` dispatcher, plus `register-confirm.js`.
- `sns.js`, `sns-subdomain.js`, `threews/` — Solana Name Service (`.sol` resolve + reverse-lookup, cached) and three.ws subdomains.

### Avatars and 3D
- `avatars/`, `avatar/` — avatar CRUD plus `avatar/optimize`, `avatar/render`, `avatar/video-generate`, `avatar/video-status`.
- `actions/` — avatar action renders; `animations/`, `mocap/`, `render/`, `scene/`, `nft/` — animation presigns, motion-capture clips, GLB/clip rendering, scene gating, and scene-NFT minting.

### AI, chat, and inference
- `chat.js` (Edge SSE, multi-provider routing across Groq / OpenRouter / OpenAI / Anthropic), `chat/`, `brain/chat.js`, `llm/anthropic.js`, `chat-skills.js`.
- `inference/livepeer.js` — side-by-side Claude vs Livepeer LLM comparison.
- `tts/` — text-to-speech (`speak`, `edge`, `eleven`, `eleven-clone`).
- `persona/`, `seed/` — persona extraction/preview and seed synthesis from X / GitHub / Farcaster.
- `mcp.js` — MCP server over Streamable HTTP (MCP 2025-06-18, JSON-RPC 2.0): `POST` tool calls, `GET` SSE, `DELETE` terminate. `pump-fun-mcp.js` — the pump.fun MCP surface.

### Payments and x402
- `x402/` — x402 paid endpoints (e.g. `agent-reputation`, `asset-download`, `fact-check`, `pay-by-name`, `mint-to-mesh`, `skill-marketplace`, `my-receipts`, `model-check`).
- `x402-pay.js` (server-side payer streaming the challenge -> build -> verify -> settle lifecycle as SSE), `x402-pay/`, `x402-checkout.js`, `x402-checkout-record.js`, `x402-skus.js`, `x402-status.js`.
- `payments/`, `billing/`, `monetization/`, `subscriptions.js`, `subscriptions/`, `purchase/`, `wallet/` — payment intents, billing/receipts, monetization revenue/withdrawals, subscriptions, wallet balances.

### Marketplace and discovery
- `marketplace.js` (301-redirects to `/api/marketplace/agents`), `marketplace/` — skill/asset marketplace: list, buy, reviews, trials, theme, skill pricing.
- `bazaar/` — x402 bazaar service discovery (`search`, `list`, `providers`, `arbitrage`, `context`).
- `skills/`, `skills-manifest.js`, `chat-skills.js`, `assets/`, `widgets/`, `creators/`, `explore.js`, `discover-detail.js`, `showcase.js`, `characters.js` — catalogs and discovery surfaces.

### Pump.fun / Solana
- `pump/` — pump.fun token data and actions: `dashboard`, `curve`, `balances`, `by-agent`, `channel-feed`, `helius-stats`, `helius-webhook`, `launch-prep`, `quote-sdk`, `trades-stream`, withdraw / accept-payment prep + confirm.
- `solana-rpc.js`, `three-token/`, `kol/` — Solana RPC proxy, the three.ws token, and KOL trade data.

### Auth and accounts
- `auth/`, `oauth/`, `csrf-token.js`, `zauth-status.js`, `onboarding/`, `permissions/`, `api-keys.js`, `api-keys/`, `keys/`, `user/`, `users/`, `dashboard/`, `notifications/`, `developer/` — sessions, OAuth, CSRF, onboarding, capability permissions, API keys, user profiles, developer usage/webhooks.

### Social and syndication
- `x/` — X (Twitter) posting, drafts, scheduling, analytics, triggers, reviews.
- `social/`, `rss/`, `sentiment.js`, `club/` — sentiment, RSS announcements, and the club leaderboard / presence / tips.

### Embedding and pages
- `embed/`, `widgets/` (oembed, og, page, view), `agent-oembed.js`, `agent-og.js`, `agent-page.js`, and the `*-og.js` files (`a-og`, `app-og`, `avatar-og`, `u-og`, `walk-og`) — embed resolution, oEmbed, Open Graph image/page generation.
- `artifact.js` — Claude-Artifact bundle endpoint (see `specs/CLAUDE_ARTIFACT.md`).
- `sitemap.js`, `sitemap/`, `openapi-json.js`, `config.js`, `features.js`, `home-stats.js`, `platform/`, `healthz.js` — sitemaps, OpenAPI doc, runtime config / feature flags, stats, health checks.

### Integrations and ops
- `aws-marketplace/`, `lobehub/`, `plugins/`, `pinning/`, `forever/`, `launchpad/`, `rider/`, `webhooks/`, `tx/`, `audit-log.js`, `usage/`, `insights/`, `admin/` — external marketplace/registry integrations, IPFS pinning, on-chain inscription, launchpad, paywall (rider), inbound webhooks, transaction explanation, audit logging, usage/insights, and admin tooling.

### Scheduled jobs (Vercel Cron)
- `cron/[name].js` — a single dynamic dispatcher for every cron job. Vercel hits `/api/cron/<name>`; `req.query.name` selects the job. Schedules are declared in `vercel.json` under `crons`, including: `audit-log-cleanup` (daily 04:00); `expire-pending-purchases`, `solana-attestations-crawl`, `index-delegations`, `run-coin-cycle`, `unstoppable-tick` (every 5 min); `cleanup-csrf-tokens` (hourly :17); `process-withdrawals`, `run-dca`, `run-subscriptions` (hourly); `erc8004-crawl`, `pumpfun-signals` (every 15 min); `run-x-scheduled-posts` (every min); `run-x-triggers` (every 5 min); `fetch-x-metrics`, `process-subscriptions` (every 6 h); `pump-agent-stats`, `solana-attest-event-cleanup` (every 10 min); `pumpfun-monitor` (every 3 min); `settle-royalties`, `siwx-gc` (daily 03:00); and the staggered `run-coin-payouts` / `club-payouts`.

## Local development

These run under `vercel dev`, or behind the Vite dev-server proxy. CORS is applied per-endpoint via the `cors` helper in `_lib/http.js`.
