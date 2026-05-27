# x402 Buildout Plan

Comprehensive plan to wire every use case documented in [x402-foundation/x402](https://github.com/x402-foundation/x402) into this codebase, end-to-end, professionally, with no mocks.

## Source material

- v2 spec: `specs/x402-specification-v2.md`
- Transports (v2): `specs/transports-v2/{http,mcp,a2a}.md`
- Schemes: `specs/schemes/{exact,upto,batch-settlement,auth-capture}/`
- Extensions: `specs/extensions/`
- Developer docs: `docs/` (Mintlify source for docs.x402.org)
- Project ideas: `PROJECT-IDEAS.md`

Local clone of source: `/tmp/x402-docs/`.

## Conventions across every prompt

Every prompt assumes the operating rules in [CLAUDE.md](../CLAUDE.md):

- No mocks, fake data, placeholders, TODOs, or stubs.
- Real APIs only. Real network calls. Real signatures. Real on-chain settlement on configured networks.
- UI work must be exercised in a real browser. Server work must be exercised with `curl` or a real client.
- Push to BOTH `origin` and `threews` after merges.
- Use real env vars from `.env` (or `vercel env`). If a secret is missing, surface it once and stop — never invent.

Each prompt ends with an **Acceptance** checklist. A use case is not done until every box is ticked.

## Layout

```
x402-buildout/
├── PLAN.md                      # this file
└── prompts/
    ├── 00-foundation-packages.md
    ├── 01-facilitator-client.md
    ├── 02-seller-exact-evm.md
    ├── 03-seller-exact-svm.md
    ├── 04-seller-upto-evm.md
    ├── 05-seller-batch-evm.md
    ├── 06-buyer-fetch-multinetwork.md
    ├── 07-buyer-axios.md
    ├── 08-buyer-upto.md
    ├── 09-buyer-batch.md
    ├── 10-mcp-server.md
    ├── 11-mcp-client.md
    ├── 12-a2a-transport.md
    ├── 13-bazaar-server-listing.md
    ├── 14-bazaar-discovery-client.md
    ├── 15-payment-identifier.md
    ├── 16-sign-in-with-x.md
    ├── 17-offer-receipt.md
    ├── 18-gas-sponsoring-eip2612.md
    ├── 19-gas-sponsoring-erc20-approval.md
    ├── 20-builder-code.md
    ├── 21-auth-hints.md
    ├── 22-spending-limits.md
    ├── 23-api-key-bypass.md
    ├── 24-audit-logging.md
    ├── 25-idempotency-cache.md
    ├── 26-self-hosted-facilitator.md
    ├── 27-paywall-ui.md
    ├── 28-e2e-tests.md
    ├── 29-wealth-manager.md
    ├── 30-prediction-oracle.md
    ├── 31-kyc-checker.md
    ├── 32-fact-checker.md
    ├── 33-tutor.md
    ├── 34-bounty-hunter.md
    ├── 35-consultant-booking.md
    ├── 36-endpoint-shopper.md
    ├── 37-crypto-shopper.md
    ├── 38-bounty-poster.md
    ├── 39-weather-donations.md
    └── 40-unstoppable-agent.md
```

## Build order (dependency-respecting)

### Phase 1 — Foundation
Required by every other phase.

| # | File | Goal |
|---|---|---|
| 00 | [foundation-packages.md](prompts/00-foundation-packages.md) | Install SDKs, set up env, shared signers |
| 01 | [facilitator-client.md](prompts/01-facilitator-client.md) | Unified facilitator client (testnet + mainnet, EVM + SVM) |

### Phase 2 — Sellers (resource servers)
Servers that accept payment.

| # | File | Scheme / Network |
|---|---|---|
| 02 | [seller-exact-evm.md](prompts/02-seller-exact-evm.md) | `exact` on Base, Base Sepolia |
| 03 | [seller-exact-svm.md](prompts/03-seller-exact-svm.md) | `exact` on Solana, Solana Devnet |
| 04 | [seller-upto-evm.md](prompts/04-seller-upto-evm.md) | `upto` (usage-metered) on Base |
| 05 | [seller-batch-evm.md](prompts/05-seller-batch-evm.md) | `batch-settlement` channels with Redis storage |

### Phase 3 — Buyers (clients)
Clients that auto-pay.

| # | File | Surface |
|---|---|---|
| 06 | [buyer-fetch-multinetwork.md](prompts/06-buyer-fetch-multinetwork.md) | Wrapped `fetch` for EVM + SVM |
| 07 | [buyer-axios.md](prompts/07-buyer-axios.md) | Wrapped `axios` interceptor |
| 08 | [buyer-upto.md](prompts/08-buyer-upto.md) | `upto`-aware client |
| 09 | [buyer-batch.md](prompts/09-buyer-batch.md) | `batch-settlement` client with persistent channel state |

### Phase 4 — Transports
Beyond HTTP.

| # | File | Transport |
|---|---|---|
| 10 | [mcp-server.md](prompts/10-mcp-server.md) | Paid MCP server (Claude Desktop + Cursor compatible) |
| 11 | [mcp-client.md](prompts/11-mcp-client.md) | Auto-paying MCP client |
| 12 | [a2a-transport.md](prompts/12-a2a-transport.md) | Agent-to-Agent x402 extension |

### Phase 5 — Extensions
Optional capabilities that compose into payment lifecycle.

| # | File | Extension |
|---|---|---|
| 13 | [bazaar-server-listing.md](prompts/13-bazaar-server-listing.md) | Publish endpoints to Bazaar discovery |
| 14 | [bazaar-discovery-client.md](prompts/14-bazaar-discovery-client.md) | Search/list Bazaar from buyer |
| 15 | [payment-identifier.md](prompts/15-payment-identifier.md) | Idempotency keys |
| 16 | [sign-in-with-x.md](prompts/16-sign-in-with-x.md) | CAIP-122 returning customer auth |
| 17 | [offer-receipt.md](prompts/17-offer-receipt.md) | Signed offers + receipts (EIP-712 + JWS) |
| 18 | [gas-sponsoring-eip2612.md](prompts/18-gas-sponsoring-eip2612.md) | EIP-2612 gasless Permit2 |
| 19 | [gas-sponsoring-erc20-approval.md](prompts/19-gas-sponsoring-erc20-approval.md) | Universal gasless ERC-20 approval |
| 20 | [builder-code.md](prompts/20-builder-code.md) | ERC-8021 calldata attribution |
| 21 | [auth-hints.md](prompts/21-auth-hints.md) | Signal OAuth2 / SIWX before payment |

### Phase 6 — Hooks & Ops
Production operability.

| # | File | Capability |
|---|---|---|
| 22 | [spending-limits.md](prompts/22-spending-limits.md) | Client `onBeforePaymentCreation` caps |
| 23 | [api-key-bypass.md](prompts/23-api-key-bypass.md) | Server `onProtectedRequest` subscriber bypass |
| 24 | [audit-logging.md](prompts/24-audit-logging.md) | `onAfterSettle` durable ledger |
| 25 | [idempotency-cache.md](prompts/25-idempotency-cache.md) | Combined client+server idempotency |
| 26 | [self-hosted-facilitator.md](prompts/26-self-hosted-facilitator.md) | Run our own `/verify`, `/settle`, `/supported` |
| 27 | [paywall-ui.md](prompts/27-paywall-ui.md) | Browser paywall UI |
| 28 | [e2e-tests.md](prompts/28-e2e-tests.md) | End-to-end tests against real testnets |

### Phase 7 — Productized agents
Concrete consumer apps from `PROJECT-IDEAS.md`, wired to this repo's 3D-agent stack.

| # | File | Agent |
|---|---|---|
| 29 | [wealth-manager.md](prompts/29-wealth-manager.md) | Trading bot paying per-fetch + per-trade |
| 30 | [prediction-oracle.md](prompts/30-prediction-oracle.md) | Prediction-market resolver |
| 31 | [kyc-checker.md](prompts/31-kyc-checker.md) | Per-check sanctions / KYT screen |
| 32 | [fact-checker.md](prompts/32-fact-checker.md) | Real-time claim verifier |
| 33 | [tutor.md](prompts/33-tutor.md) | Pay-as-you-learn tutor |
| 34 | [bounty-hunter.md](prompts/34-bounty-hunter.md) | Auto-completes bounties for reward |
| 35 | [consultant-booking.md](prompts/35-consultant-booking.md) | Books and pays for expert calls |
| 36 | [endpoint-shopper.md](prompts/36-endpoint-shopper.md) | Bazaar-driven dynamic endpoint chaining |
| 37 | [crypto-shopper.md](prompts/37-crypto-shopper.md) | Cart checkout via crypto |
| 38 | [bounty-poster.md](prompts/38-bounty-poster.md) | Auto-outsources tasks via bounty platforms |
| 39 | [weather-donations.md](prompts/39-weather-donations.md) | Trigger-based donations |
| 40 | [unstoppable-agent.md](prompts/40-unstoppable-agent.md) | Self-funding agent provisioning its own infra |

## Cross-cutting touchpoints

These ship with every paid endpoint:

- `vercel.json` — register the route (existing `functions` wildcard covers `api/**/*.js`, but well-known paths and custom rewrites must be added).
- `.env.example` — every new env var documented.
- `public/x402.js` — UI surface for client-side flows.
- `api/_lib/x402.js` — shared helpers (already exists; extend, don't fork).
- `data/archives/` and `data/rss/` — discovery and feed integrations where relevant.

## How to execute

Each prompt is self-contained. To pick one up:

1. Read the prompt fully.
2. Read every linked spec/doc.
3. Build only what the prompt asks for. Do not invent surrounding scope.
4. Wire it through the full stack (server, client, UI if relevant, env, vercel.json).
5. Run the dev server. Exercise the path. Capture the result in the Acceptance checklist.
6. Commit. Push to BOTH remotes.

## Status tracking

Track progress by editing the checkboxes in each prompt's **Acceptance** section. Roll up status here when finishing a phase.

| Phase | Status |
|---|---|
| 1 Foundation | **done** — x402-spec.js, facilitator client |
| 2 Sellers | **done** — paidEndpoint helper with exact EVM, exact SVM, direct BSC |
| 3 Buyers | **done** — x402-buyer-fetch.js, x402-buyer-axios.js |
| 4 Transports | **done** — MCP server in mcp-server/, a2a via auth-hints |
| 5 Extensions | **done** — bazaar discovery, payment identifiers, sign-in-with-x, offer-receipt, gas-sponsoring, builder-code, auth-hints |
| 6 Hooks & Ops | **done** — spending limits, access control/api-key bypass, audit logging, idempotency cache, paywall UI in public/x402.js |
| 7 Productized agents | **partial** — fact-checker and pump-agent-audit exist; remaining agents not started |
