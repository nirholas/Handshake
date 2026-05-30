# three.ws — Paid API Provider

**Website:** https://three.ws  
**Discovery:** https://three.ws/.well-known/x402.json  
**OpenAPI:** https://three.ws/openapi.json  
**MCP:** https://three.ws/api/mcp  
**Networks:** Base mainnet (USDC), Arbitrum One (USDC, model-check + mint-to-mesh only), Solana mainnet (USDC)  
**Protocol:** x402 v2 (HTTP 402 Payment Required)

## Overview

three.ws is an agent-first 3D model platform. Paid REST endpoints cover glTF/GLB model
validation, Solana token visualization, Pump.fun agent analytics, on-chain identity
verification, and a Claude-backed growth-analysis power. All endpoints settle in USDC
on Base / Arbitrum / Solana mainnet. The MCP server exposes the same surface as
JSON-RPC tools.

## Paid Endpoints

This table mirrors the live `/.well-known/x402.json` resource catalog. Prices below
are the source of truth and match what the 402 challenges advertise; verify with
`npx x402-surface-check https://three.ws/.well-known/x402.json`.

| Endpoint | Method | Price | Description |
|---|---|---|---|
| `/api/mcp` | POST | $0.001 | MCP 2025-06-18 Streamable HTTP — 3D model tools + Solana agent data as JSON-RPC 2.0 |
| `/api/x402/model-check` | GET | $0.001 | Fetch a glTF/GLB from a URL, return vertex/triangle counts, materials, textures, animations, extensions, and optimization hints. CDP-Bazaar-cataloged. |
| `/api/x402/mint-to-mesh` | GET | $0.001 | Pass a Solana SPL mint, get a binary glTF (GLB) cube themed for that token (color + texture derived from on-chain metadata). CDP-Bazaar-cataloged. |
| `/api/insights/revenue-vision` | GET | $0.001 | Hand over a `mission_brief`, get back a Claude-generated `{ insight, recommended_move, confidence }` payload. CDP-Bazaar-cataloged. |
| `/api/x402/symbol-availability` | GET | $0.001 | Pre-launch ticker collision check against three.ws's pump.fun mint index; returns exact and trigram-similar matches |
| `/api/x402/skill-marketplace` | GET | $0.001 | List active skill listings and prices across all three.ws agents; filter by skill name to find the cheapest provider |
| `/api/x402/permit2-paid-demo` | GET | $0.001 | Permit2 + EIP-2612 gas-sponsoring demo (Base only). Forces the gasless Permit2 path for fresh wallets holding USDC but zero ETH. Listed only when CDP credentials are configured. |
| `/api/x402/onchain-identity-verify` | GET | $0.005 | Verify an agent's ownership of a Solana contract/mint from three.ws's on-chain identity index; returns tx_hash + wallet evidence |
| `/api/x402/agent-reputation` | GET | $0.01 | Reputation snapshot for a three.ws agent: USDC paid in, distinct payers, deployed mints, distribution success rate, attestation count |
| `/api/x402/pump-agent-audit` | GET | $0.02 | Full operational audit of a pump.fun agent-payments token: USDC in, distribute/buyback history, latest error reasons, risk flags |
| `/api/x402/mint-to-mesh-batch` | POST | $0.05 | Resolve 1–10 Solana SPL mints to themed GLB cubes in one call; per-mint failures report individually |
| `/api/x402/pump-launch` | POST | $5.00 | Deploy a brand-new pump.fun token in one paid call. Supply name + symbol + (metadataUri or imageUrl); the server fronts the SOL deploy cost and signs the create-coin tx. Creator rewards accrue to any Solana wallet you nominate; optional vanity mint address. Returns mint + tx signature + pump.fun URL |

All prices are in USDC with 6 decimals. `$0.001` = 1000 atomics.

## Quick Start

```js
import { withPaymentInterceptor } from "@x402/fetch";
import fetch from "node-fetch";

const fetchWithPayment = withPaymentInterceptor(fetch, wallet);

// Check a 3D model
const res = await fetchWithPayment(
  "https://three.ws/api/x402/model-check?url=https://example.com/model.glb"
);
const { model, suggestions } = await res.json();

// Get a token's 3D representation
const res2 = await fetchWithPayment(
  "https://three.ws/api/x402/mint-to-mesh?mint=DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263"
);
const { glb } = await res2.json(); // base64 GLB bytes
```

## MCP Usage

```json
{
  "mcpServers": {
    "three-ws": {
      "url": "https://three.ws/api/mcp",
      "headers": { "x-payment": "<usdc-payment-token>" }
    }
  }
}
```

## CORS

All paid endpoints (`/api/mcp`, `/api/x402/*`, `/api/insights/revenue-vision`) and the
public discovery docs (`/.well-known/x402`, `/.well-known/x402.json`, `/openapi.json`)
respond with `Access-Control-Allow-Origin: *` on both the OPTIONS preflight and the
actual request. The CORS layer also exposes `PAYMENT-REQUIRED`, `x-payment-response`,
`x-payment-network`, and `x-payment-tx` so browser-based agents can drive the 402-pay-retry
flow and surface settlement receipts. Both server-to-server and browser-agent paths
are supported.

## Notes

- All endpoints return structured JSON 402 challenges before access; probe with
  `npx x402-surface-check https://three.ws/.well-known/x402.json` to enumerate live prices.
- Every 402 challenge echoes the resource URL both at top-level `resource.url` AND in
  each `accepts[].resource`, so wallet/facilitator spend logs reconcile cleanly without
  relying on the buyer to remember which endpoint they hit.
- Solana routes require a `feePayer` field in the accept block (included automatically
  in the 402 challenge) for PayAI's `/verify` to accept the SPL transfer.
- No public key-generation endpoints. three.ws does not run any server-side vanity-key
  or keypair-generation paid endpoint — wallet keys never leave the buyer's environment.
