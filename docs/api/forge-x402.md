# Forge: paid 3D generation API (x402)

Pay-per-call text→3D and image→3D for AI agents. One USDC payment buys one
generation, settled autonomously over [x402](https://x402.org): no API key, no
account, no signup. This is the monetized twin of the free, browser-facing
`/api/forge`.

|  |  |
|---|---|
| **Endpoint** | `POST https://three.ws/api/x402/forge` |
| **Price** | $0.05 / $0.15 / $0.50 USDC per generation, by quality tier |
| **Payment** | x402 `exact` scheme, USDC on **Solana mainnet** |
| **Polling** | free, on `GET /api/forge?job=<id>` |
| **Discovery** | `GET /api/x402/forge` (free), `/.well-known/x402`, `/openapi.json` |
| **Source** | [api/x402/forge.js](../../api/x402/forge.js), listing metadata in [api/_lib/forge-listing.js](../../api/_lib/forge-listing.js) |

New here? Prove the concept on the free, keyless draft lane at
`POST /api/3d/generate` ([3D API](../3d-api.md)) first, then pay for a tier when
you need standard/high quality or image→3D.

## Pricing

Flat per-call retail price by tier. The single source of truth is
[api/_lib/forge-tiers.js](../../api/_lib/forge-tiers.js) (`priceUsdcAtomics`);
the 402 challenge quotes the exact price for the tier you asked for, so an agent
never has to hardcode a number from this page.

| Tier | Price (USDC) | Geometry | Textures | Best for |
|---|---|---|---|---|
| `draft` | **$0.05** | ~12k tris | none | Blockout, iteration, previews |
| `standard` (default) | **$0.15** | ~30k tris | none | Most shippable assets |
| `high` | **$0.50** | ~200k tris | PBR + HD | Hero assets, product and NFT renders |

The price is per generation and does not vary with which engine lane serves it
(see [Engine lanes](#engine-lanes)).

### Discover the price before paying (free)

<!-- runnable: 200 the free pricing catalog, no payment involved -->
```bash
curl -s https://three.ws/api/x402/forge
```

```jsonc
{
  "route": "/api/x402/forge",
  "description": "three.ws Forge: pay-per-call text→3D and image→3D ...",
  "method": "POST",
  "input_schema": { "$schema": "https://json-schema.org/draft/2020-12/schema", "type": "object", "properties": { /* … */ } },
  "poll": "GET /api/forge?job=<id>",
  "pricing_usdc": [
    { "tier": "draft", "price_usdc": "0.05" },
    { "tier": "standard", "price_usdc": "0.15" },
    { "tier": "high", "price_usdc": "0.50" }
  ]
}
```

The same schemas are mirrored into `/.well-known/x402` and into the 402
challenge's `bazaar` block, so a facilitator listing (CDP Bazaar, x402scan,
agentic.market) and the live endpoint can never disagree.

## Request

`POST /api/x402/forge` with a JSON body. Provide **exactly one** of `prompt`
(text→3D) or `image_urls` (image→3D).

| Field | Type | Default | Notes |
|---|---|---|---|
| `prompt` | string | none | Text→3D. 3 to 1000 characters, describing one subject. |
| `image_urls` | string[] | none | Image→3D. 1 to 6 public `https` reference views of **one** object. |
| `image_url` | string | none | Convenience alias for a single reference view. |
| `tier` | `draft` / `standard` / `high` | `standard` | Quality and price. An unknown value falls back to `standard`. |
| `aspect_ratio` | `1:1` / `4:3` / `3:4` / `16:9` / `9:16` | `1:1` | Aspect ratio of the synthesized reference view. Text→3D only. |

```jsonc
{
  "prompt": "a brass steampunk owl, full body",
  "tier": "standard",
  "aspect_ratio": "1:1"
}
```

```jsonc
{
  "image_urls": [
    "https://example.com/owl-front.png",
    "https://example.com/owl-side.png"
  ],
  "tier": "high"
}
```

Input rules worth knowing before you pay:

- **Views past the sixth are dropped**, not rejected. Send your best six.
- **Non-`https` entries are dropped.** If you supplied `image_urls` and none
  survive that filter, the call fails with `400 invalid_image_urls` rather than
  silently degrading to a text prompt.
- **Caller-supplied urls are SSRF-guarded** before any reconstructor fetches
  them, on every lane. Private, link-local, and loopback targets are refused.
- **A body with neither field is a probe.** Unpaid, it still returns the 402
  challenge so an agent can discover the price with no input. Paid, it is
  rejected with `400 missing_input` before any settlement runs.

## The 402 challenge

An unpaid request is answered with `402 Payment Required` and an `accepts[]`
array quoting the price for the tier you requested.

<!-- runnable: 402 the challenge is the lesson: an unpaid call must quote a price -->
```bash
curl -s -X POST https://three.ws/api/x402/forge \
  -H 'content-type: application/json' \
  -d '{"prompt":"a brass steampunk owl, full body","tier":"standard"}'
```

```jsonc
{
  "x402Version": 2,
  "error": "X-PAYMENT header is required",
  "resource": {
    "url": "https://three.ws/api/x402/forge",
    "serviceName": "three.ws Forge: text/image to 3D",
    "tags": ["3d", "ai", "text-to-3d", "image-to-3d", "utility"]
  },
  "accepts": [
    {
      "scheme": "exact",
      "network": "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",  // Solana mainnet
      "amount": "150000",                                     // 0.15 USDC, 6 decimals
      "payTo": "<the platform's live receiving address>",
      "asset": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // USDC mint
      "maxTimeoutSeconds": 60,
      "resource": "https://three.ws/api/x402/forge",
      "extra": { "name": "USDC", "decimals": 6, "feePayer": "<sponsor>" }
    }
  ]
}
```

**Solana mainnet USDC only.** Every quote on the live route is a Solana 402, and
the fee payer is sponsored, so a buyer needs USDC but not SOL. A self-hosted or
preview deploy that has not configured `X402_PAY_TO_SOLANA` falls back to
quoting Base USDC (EIP-3009 plus a Permit2 variant) so the route never
dead-ends with an empty challenge; production sets it, so that branch never runs
on three.ws.

Pay the challenge with any x402 client (`@x402/fetch`, CDP, PayAI) and retry the
identical request with the proof in the `X-PAYMENT` header.

## Response

A paid call returns `200` in one of two shapes. `status` is the only guaranteed
field: branch on it.

**Queued** (the usual case) hands back a job token you poll for free:

```json
{
  "job_id": "f1.eyJwIjoibnZpZGlhIn0.sig",
  "status": "queued",
  "poll_url": "/api/forge?job=f1.eyJwIjoibnZpZGlhIn0.sig",
  "mode": "text_to_3d",
  "tier": "standard",
  "backend": "nvidia",
  "eta_seconds": 22,
  "price_usdc": "0.15"
}
```

**Done inline** happens when the lane finishes inside the submit window (common
on `draft`). There is nothing to poll, and `job_id` / `poll_url` are `null`:

```json
{
  "job_id": null,
  "status": "done",
  "poll_url": null,
  "glb_url": "https://three.ws/cdn/forge/nvidia/9f2c….glb",
  "mode": "text_to_3d",
  "tier": "draft",
  "backend": "nvidia",
  "eta_seconds": 13,
  "price_usdc": "0.05"
}
```

| Field | Type | Meaning |
|---|---|---|
| `status` | string | `queued` (poll it) or `done` (`glb_url` is ready). |
| `job_id` | string \| null | Poll token. `null` on inline completion. |
| `poll_url` | string \| null | Free status path. `null` on inline completion. |
| `glb_url` | string | The finished GLB. Present only when `status` is `done`. |
| `mode` | string | `text_to_3d` or `image_to_3d`. |
| `tier` | string | The resolved tier (after the default is applied). |
| `backend` | string | Which engine lane served the job. |
| `eta_seconds` | integer | Estimated time to completion for that lane and tier. |
| `price_usdc` | string | What you were charged, e.g. `"0.15"`. |

The settlement receipt rides back in the `x-payment-response` header.

Any client that only handles the queued shape will build a poll url out of
`null` and hang. Handle both, as the [example](#example-x402fetch) does.

## Engine lanes

One price, several engines. The endpoint is free-first internally: it spends
platform vendor credit only when no zero-cost lane can serve the job, and it
degrades rather than failing a paid call. `backend` in the response names the
lane that ran.

**Text→3D**, in order:

1. **NVIDIA NIM native text→mesh** (`nvidia`). Zero vendor cost, no intermediate
   image. Completes inline often enough that `draft` frequently skips polling.
2. **HuggingFace Spaces reconstruct** (`huggingface`). Free. Synthesizes a
   reference view, reconstructs it, and the result is copied into three.ws
   storage so the url outlives the Space's ephemeral files. Preference is
   controlled by `FORGE_PREFER_FREE`.
3. **FLUX→TRELLIS on Replicate** (`trellis`). The paid platform backstop.

**Image→3D** skips step 1 (NVIDIA's hosted preview is text-only) and runs the
reconstruct lanes on your supplied views.

Only the platform-keyed pipeline is sold here. The BYOK geometry backends
(Meshy, Tripo) bill through the caller's own provider key on the free
`/api/forge` and are not monetized via x402.

## Poll for free

Polling costs nothing and needs no payment header.

<!-- runnable: no the job id is illustrative; use the one the paid call returned -->
```bash
curl -s 'https://three.ws/api/forge?job=f1.eyJwIjoibnZpZGlhIn0.sig'
```

```json
{
  "job_id": "f1.eyJwIjoibnZpZGlhIn0.sig",
  "status": "done",
  "glb_url": "https://three.ws/cdn/forge/…/model.glb",
  "durable": true,
  "backend": "nvidia",
  "tier": "standard",
  "path": "x402"
}
```

| `status` | What to do |
|---|---|
| `queued` | Keep polling. The job is accepted and waiting on the engine. |
| `running` | Keep polling. A transient poll error also reports `running` rather than failing the job. |
| `done` | `glb_url` is ready. |
| `failed` | Stop. `error` carries a sanitized, buyer-safe reason. |

`durable: true` means the GLB was copied into three.ws storage and the url is
stable. `durable: false` means you are looking at the provider's own delivery
url, which expires: download it promptly.

A 2 second poll interval is polite and well inside every lane's ETA. Poll
`/api/forge?job=`, never `/api/x402/forge?job=`; the paid route answers that
mistake with `400 wrong_endpoint` and a pointer rather than a 404.

## Payment safety: verify, submit, settle

The handler runs in that order deliberately. The generation job is submitted
**after** your payment verifies but **before** it settles, so a submit that
fails (engine down, out of capacity, bad input) never takes your money. Every
error the endpoint returns from that window says so in plain language, and the
raw upstream text (which can carry the platform's own vendor billing state) is
logged, never relayed.

## Idempotency and replay protection

A retried payment returns the **same** job token instead of submitting a second
generation, so a network retry can never double-charge.

- The dedup key is the client's payment identifier when the client opts into the
  `payment-identifier` extension advertised in the challenge `extensions`. When
  it does not, the endpoint falls back to a hash of the payment proof itself,
  which only the original payer can reproduce. **Replay protection is therefore
  unconditional**, not opt-in.
- A replayed request that matches gets the original response body with
  `x-x402-idempotent: replay`.
- A second request carrying the same payment while the first is still running
  gets `409 payment_in_flight`, `x-x402-idempotent: in-flight`, and
  `retry-after: 1`. Retry to receive the cached response instead of paying again.
- Reusing one payment identifier for a **different** body gets
  `409 payment_identifier_conflict` with `attemptedPayloadHash` and
  `existingPayloadHash`. Retry the original payload or generate a fresh id.

## Errors

| Status | `error` | Meaning |
|---|---|---|
| `400` | `invalid_json` | Body was not valid JSON. |
| `400` | `invalid_prompt` | Prompt outside 3 to 1000 characters. |
| `400` | `invalid_image_urls` | You sent `image_urls` but none were public `https` urls. |
| `400` | `missing_input` | Paid call with neither `prompt` nor `image_urls`. |
| `400` | `body_read_failed` | Body unreadable or over the 1 MB cap. |
| `400` | `wrong_endpoint` | `GET /api/x402/forge?job=…`. Poll on `/api/forge?job=…`. |
| `402` | (challenge) | No `X-PAYMENT` header, or the proof failed verification. Re-read `accepts[]` and pay. |
| `405` | `method_not_allowed` | Use `POST` to generate, `GET` for pricing. |
| `409` | `payment_in_flight` | Same payment already being processed. Retry shortly. |
| `409` | `payment_identifier_conflict` | Payment identifier reused for a different body or a different proof. |
| `429` | `rate_limited` | Either the unpaid path's per-IP limit, or the engine is briefly busy. In the busy case **your payment was not taken**; honour `retry_after`. |
| `502` | `verify_failed` / `settle_failed` | Facilitator problem. On `verify_failed` nothing was charged. |
| `502` | `generation_failed` | Engine fault after verify, before settle. Not charged. |
| `503` | `generation_unavailable` | Every lane is down or out of capacity. Not charged; `retry_after: 30`. |
| `503` | `unconfigured` | Generation is not configured on this deployment. |

The unpaid path is IP rate limited so the challenge and validation cannot be
hammered; those responses carry `X-RateLimit-*` and `retry-after` headers.
Generation itself is paywalled, not rate limited.

Platform callers holding the `x402:bypass` scope (subscription or OAuth) skip
payment entirely and get the same response body plus an `x-payment-bypass`
header. Anonymous agents always pay.

## Provenance: paid generations join the public gallery

Every settled generation becomes a real row in the community gallery, stamped
with the paying wallet, the settle signature, and the price, and rendered with a
Solscan-linked "x402" provenance badge. Inline-done lanes publish immediately;
async lanes are completed server-side by `api/cron/forge-finalize`, so the
artifact lands even if you never poll. Recording happens after your response is
sent and never affects your result. See
[x402 endpoints](../x402-endpoints.md) and
[the autonomous economy](../autonomous-x402.md).

Treat prompts as public. If you need a private lane, use the account-scoped
surfaces instead of this one.

## Example (`@x402/fetch`)

Handles both response shapes, the free poll, and terminal failure.

```js
import { wrapFetchWithPayment } from '@x402/fetch';

const BASE = 'https://three.ws';
const fetchWithPay = wrapFetchWithPayment(fetch, wallet);

const res = await fetchWithPay(`${BASE}/api/x402/forge`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ prompt: 'a brass steampunk owl, full body', tier: 'standard' }),
});
if (!res.ok) throw new Error(`forge ${res.status}: ${(await res.json()).error}`);

const submitted = await res.json();

// The lane may have finished inside the submit window: there is nothing to poll.
let glbUrl = submitted.glb_url ?? null;

if (!glbUrl) {
  const deadline = Date.now() + 10 * 60 * 1000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 2000));
    const job = await (await fetch(`${BASE}${submitted.poll_url}`)).json();
    if (job.status === 'done') { glbUrl = job.glb_url; break; }
    if (job.status === 'failed') throw new Error(job.error);
  }
  if (!glbUrl) throw new Error('generation timed out');
}

const glb = Buffer.from(await (await fetch(glbUrl)).arrayBuffer());
```

## Related

- [3D API](../3d-api.md): the free draft lane, inspection, validation, and the
  full Forge Pro walkthrough.
- [Forge pipeline](../forge-pipeline.md): how the lanes, tiers, and failovers fit
  together internally.
- [3D Studio MCP server](../mcp-3d-studio.md): the same generation as
  `text_to_3d` / `image_to_3d` tools for in-conversation use, priced from the
  same tier table. This REST endpoint is the pay-per-call surface for autonomous
  agents.
- [x402 endpoints](../x402-endpoints.md): every paid endpoint on the platform.
