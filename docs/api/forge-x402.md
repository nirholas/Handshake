# Forge — paid 3D generation API (x402)

Pay-per-call text→3D and image→3D for AI agents. Settle in USDC autonomously —
no API key, no account, no signup. This is the monetized twin of the free,
browser-facing `/api/forge`.

- **Endpoint:** `POST /api/x402/forge`
- **Payment:** x402 over USDC on Base or Solana mainnet
- **Polling:** free, on the existing `GET /api/forge?job=<id>`
- **Discovery:** listed in `/.well-known/x402` and `/openapi.json`; the price is
  in the 402 challenge and at `GET /api/x402/forge`.

## Pricing

Per quality tier, in USDC. Source of truth: `api/_lib/forge-tiers.js`
(`priceUsdcAtomics`). The 402 challenge quotes the exact price for the requested
tier.

| Tier | Price | Polygon budget |
|---|---|---|
| `draft` | $0.05 | ~12k |
| `standard` (default) | $0.15 | ~30k |
| `high` | $0.50 | ~200k + PBR |

`GET /api/x402/forge` returns the live pricing table (free, no payment).

## Request

`POST /api/x402/forge` with a JSON body:

```jsonc
{
  "prompt": "a brass steampunk owl, full body",  // text→3D (3–1000 chars)
  // OR, for image→3D, omit prompt and supply public https reference views:
  // "image_urls": ["https://.../front.png", "https://.../side.png"],  // 1–4
  "tier": "standard",          // draft | standard | high
  "aspect_ratio": "1:1"        // 1:1 | 4:3 | 3:4 | 16:9 | 9:16 (text→3D only)
}
```

Caller-supplied `image_urls` are SSRF-guarded before the reconstructor fetches
them.

## Flow

1. **Unpaid request** → `402 Payment Required` with an `accepts[]` array quoting
   the tier price on each supported network.
2. **Pay** with any x402 client (e.g. `@x402/fetch`, CDP, PayAI) — the payment
   proof rides in the `X-PAYMENT` header.
3. **Paid request** → the server verifies payment, submits the generation job,
   then settles. Generation is submitted **after verify but before settle**, so a
   failed submit never charges you. Response:

   ```json
   {
     "job_id": "abcd1234efgh5678ij",
     "status": "queued",
     "poll_url": "/api/forge?job=abcd1234efgh5678ij",
     "mode": "text_to_3d",
     "tier": "standard",
     "backend": "trellis",
     "eta_seconds": 60,
     "price_usdc": "0.15"
   }
   ```

4. **Poll for free** until the GLB is ready:

   <!-- runnable: no the job id is illustrative; use the one the submit call returned -->
   ```bash
   curl 'https://three.ws/api/forge?job=abcd1234efgh5678ij'
   # → { "status": "done", "glb_url": "https://.../model.glb", ... }
   ```

   Fetch the `glb_url` promptly — provider delivery URLs are short-lived.

## Idempotency

A retried payment (same payment id + same body) returns the **same** job token
instead of submitting a second generation, so a network retry never
double-charges.

## Example (`@x402/fetch`)

```js
import { wrapFetchWithPayment } from '@x402/fetch';

const fetchWithPay = wrapFetchWithPayment(fetch, wallet);
const res = await fetchWithPay('https://three.ws/api/x402/forge', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ prompt: 'a brass steampunk owl', tier: 'standard' }),
});
const { poll_url } = await res.json();

let glb;
for (;;) {
  const s = await (await fetch(`https://three.ws${poll_url}`)).json();
  if (s.status === 'done') { glb = s.glb_url; break; }
  if (s.status === 'failed') throw new Error(s.error);
  await new Promise((r) => setTimeout(r, 2000));
}
```

## Notes

- The MCP-3D server (`/api/mcp-3d`) exposes the same generation as `text_to_3d` /
  `image_to_3d` tools for in-conversation use; this REST endpoint is the
  pay-per-call surface for autonomous agents.
- Only the platform image pipeline (FLUX→TRELLIS) is sold here. The BYOK geometry
  backends (Meshy/Tripo) bill through the caller's own provider key on the free
  `/api/forge` and are not monetized via x402.
