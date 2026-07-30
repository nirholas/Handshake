# Build a Paid x402 Endpoint Your Agent Calls

By the end of this tutorial you will have a real, revenue-generating HTTP endpoint on the public internet. Other agents — yours and anyone else's — can call it programmatically, pay in USDC on Base mainnet, and get back useful work. The payments are real micropayments, settled by a Coinbase CDP facilitator, with on-chain receipts.

This is one of the most consequential things you can build in 2026: an API that takes money from machines without an API key, a Stripe account, or a sign-up page. The protocol is **x402**.

**What you'll build:**

- A Node/Express paid endpoint at `https://<your-domain>/api/your-route` priced in USDC on Base
- The 402 handshake correctly implemented: discovery probe, payment-required challenge, signed payload, settlement
- A real piece of work returned — for this tutorial, a small "model checker" that fetches a glTF/GLB URL and reports its structural stats (the same shape as the production endpoint at `https://three.ws/api/x402/model-check`)
- Bazaar discoverability so an autonomous agent searching `agentic.market` finds your endpoint
- An agent-side caller (a custom skill) that buys the result mid-conversation when its user asks for it
- A path from local dev to production, including how to route through CDP for catalogability

**Prerequisites:**

- Node.js **24.x** (the same engine used by the three.ws monorepo; the SDK works on 20+ but match production).
- A public HTTPS endpoint to deploy to — Vercel, Fly, Railway, or a VPS with Caddy/Nginx. Localhost will not work for buyers because their `@x402/fetch` clients refuse to send signed payloads to non-HTTPS endpoints.
- An Ethereum wallet you control on **Base mainnet** to receive USDC. The wallet address is set as `X402_PAY_TO_BASE` in your environment. You do not need ETH in this wallet — settlement is gasless from the receiver's side.
- A Coinbase Developer Platform (CDP) account. Create an API key at `https://portal.cdp.coinbase.com`. You'll need `CDP_API_KEY_ID` and `CDP_API_KEY_SECRET`. This is what routes settlements through Coinbase's facilitator and gets your endpoint indexed in the Bazaar.
- USDC on Base in a separate buyer wallet for testing. ~$1 USDC covers thousands of $0.001 calls. Bridge from mainnet via `https://bridge.base.org` or buy directly via Coinbase.
- A working agent on three.ws (built via [first-agent](/tutorials/first-agent)). The custom-skill walkthrough in [custom-skill](/tutorials/custom-skill) is the warm-up for the caller side.

---

## Step 1 — Two minutes of x402 theory

x402 is HTTP 402 (the long-reserved "Payment Required" status) turned into a working protocol. The shape:

1. **Client requests a resource without payment.** `GET https://three.ws/api/x402/model-check`
2. **Server responds 402** with a JSON body listing what payment it will accept — scheme, network, asset, amount, recipient address, timeout. The body is also base64-encoded into a response header `payment-required` so machines that only read headers can find it.
3. **Client signs a payment payload** matching one of the accepted methods (typically a USDC EIP-3009 `transferWithAuthorization` signature for Base) and retries the request with `X-PAYMENT: <base64 of signed payload>`.
4. **Server verifies the payment** by calling a facilitator's `/verify` endpoint. The facilitator checks the signature and asserts (off-chain) that the buyer's wallet has the funds.
5. **Server does the actual work.**
6. **Server settles the payment** by calling the facilitator's `/settle` endpoint. The facilitator broadcasts the on-chain transfer. The buyer's USDC moves to the seller. The server attaches a `X-PAYMENT-RESPONSE` header containing the settlement record.
7. **Server returns 200** with the work product.

That's the whole protocol. Two HTTP round trips. No accounts. No API keys. No subscriptions. Just signatures and an on-chain settlement.

Two facilitators matter in practice:

- **PayAI** — community-run, free, supports Base mainnet and Solana mainnet. Easy to set up. Your endpoint **will not** appear in agentic.market's Bazaar discovery if you only use PayAI.
- **Coinbase CDP** — operated by Coinbase, supports Base mainnet + several EVM L2s. Endpoints settled by CDP are indexed by `agentic.market` and the bazaar/discovery surface used by autonomous agents searching for capabilities. Production endpoints on three.ws route through CDP.

You can run both — the spec lets a server advertise multiple acceptable networks per request. For this tutorial you'll wire CDP because the practical goal is *agents finding and paying your endpoint*, and CDP is what makes that discoverability work.

---

## Step 2 — Pick a piece of real work

Don't build a paid endpoint that has no point of existing. The endpoint needs to do something a calling agent genuinely wants, ideally something that:

- **Can't easily be done client-side** (so the agent must call out)
- **Has a marginal cost per call** (so charging per call is honest)
- **Returns structured data** (so the calling LLM can incorporate it)

Good candidates in 2026, with concrete examples already running in production:

- **Model inspection.** `/api/x402/model-check` — fetches a glTF URL, runs glTF-Transform's inspector, returns vertex counts, texture sizes, animation sets, and optimization recommendations.
- **Reputation lookup.** `/api/x402/agent-reputation` — pulls an ERC-8004 agent's review history from on-chain and returns aggregate scores.
- **Symbol availability.** `/api/x402/symbol-availability` — checks whether a Pump.fun ticker is already used by another agent in the registry.

This tutorial builds **a simplified model-check endpoint**. The full production version is at `/workspaces/three.ws/api/x402/model-check.js` in the three.ws repo — read it for reference. We'll build a leaner version end-to-end that's easier to follow.

The work: take a `?url=` query param pointing at a glTF or GLB file, fetch it, count primitives and materials, return JSON. Price: $0.001 USDC per call (1000 micro-USDC).

---

## Step 3 — Scaffold the project

```bash
mkdir paid-model-check && cd paid-model-check
npm init -y
npm pkg set type="module"
npm install express @gltf-transform/core
```

Create `index.js`:

```js
import express from 'express';

const app = express();
app.use(express.json({ limit: '1mb' }));

app.get('/healthz', (_req, res) => res.json({ ok: true }));

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`listening on ${port}`));
```

Verify it runs: `node index.js` and `curl http://localhost:3000/healthz`. You should see `{"ok":true}`.

---

## Step 4 — Add the x402 challenge

The simplest correct implementation of the 402 handshake — no library, just the protocol. Add to `index.js`:

```js
const X402_VERSION = 2;
const NETWORK_BASE_MAINNET = 'eip155:8453';

// Base mainnet USDC contract — verified on Basescan.
const USDC_BASE_MAINNET = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

const PAY_TO = process.env.X402_PAY_TO_BASE;          // your wallet address
const AMOUNT_USDC = process.env.X402_AMOUNT || '1000'; // micro-USDC (6 decimals) → $0.001

if (!PAY_TO) {
  console.error('X402_PAY_TO_BASE is required');
  process.exit(1);
}

function paymentRequirements(resourceUrl) {
  return [
    {
      scheme: 'exact',
      network: NETWORK_BASE_MAINNET,
      amount: AMOUNT_USDC,
      asset: USDC_BASE_MAINNET,
      payTo: PAY_TO,
      maxTimeoutSeconds: 60,
      // The EIP-712 domain on Base USDC is "USD Coin" (not "USDC").
      // Using the wrong name silently invalidates client signatures.
      extra: { name: 'USD Coin', version: '2', decimals: 6 },
    },
  ];
}

function send402(res, resourceUrl, extra = {}) {
  const accepts = paymentRequirements(resourceUrl);
  const body = {
    x402Version: X402_VERSION,
    error: extra.error || 'X-PAYMENT header is required',
    resource: {
      url: resourceUrl,
      description:
        'Model Check — fetch a glTF/GLB URL, return structural stats (vertices, ' +
        'primitives, materials, textures, animations). Pay-per-call in USDC on Base.',
      mimeType: 'application/json',
    },
    accepts,
  };
  const headerB64 = Buffer.from(JSON.stringify(body)).toString('base64');
  res.setHeader('payment-required', headerB64);
  res.status(402).json(body);
}
```

Now mount the paid route. For now, always send 402 — we'll add verification next:

```js
app.get('/api/model-check', (req, res) => {
  const resourceUrl = `${req.protocol}://${req.get('host')}${req.originalUrl.split('?')[0]}`;
  if (!req.headers['x-payment']) return send402(res, resourceUrl);
  res.status(500).json({ error: 'not yet implemented' });
});
```

Test:

```bash
X402_PAY_TO_BASE=0xYourBaseAddress node index.js
curl -i http://localhost:3000/api/model-check
```

You should see a `402 Payment Required` with a JSON body and a `payment-required` response header. That's a valid x402 challenge.

---

## Step 5 — Wire CDP for verify and settle

The facilitator does the cryptographic verification and the on-chain settlement. We'll talk to Coinbase CDP's facilitator. Install the official client headers helper:

```bash
npm install @coinbase/x402
```

Add to `index.js`:

```js
import { createCdpAuthHeaders } from '@coinbase/x402';

const CDP_FACILITATOR_URL = 'https://api.cdp.coinbase.com/platform/v2/x402';
const CDP_ID = process.env.CDP_API_KEY_ID;
const CDP_SECRET = process.env.CDP_API_KEY_SECRET;

let cdpFactory = null;
function getCdpHeaders() {
  if (!cdpFactory) cdpFactory = createCdpAuthHeaders(CDP_ID, CDP_SECRET);
  return cdpFactory();
}

async function callFacilitator(path, body) {
  const headers = {
    'content-type': 'application/json',
    accept: 'application/json',
  };
  if (CDP_ID && CDP_SECRET) {
    const all = await getCdpHeaders();
    const op = path === '/verify' ? all.verify : all.settle;
    Object.assign(headers, op || {});
  }
  const res = await fetch(`${CDP_FACILITATOR_URL}${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok && !(path === '/verify' && data.isValid === false)) {
    const msg = data.error || data.message || data.invalidReason || `status ${res.status}`;
    const err = new Error(`facilitator ${path}: ${msg}`);
    err.status = 502;
    throw err;
  }
  return data;
}

function decodePaymentHeader(header) {
  const json = Buffer.from(String(header), 'base64').toString('utf8');
  return JSON.parse(json);
}

async function verifyPayment(paymentHeader, requirements) {
  const paymentPayload = decodePaymentHeader(paymentHeader);
  // Match the buyer's chosen network against our requirements
  const requirement = requirements.find(
    (r) => r.network === paymentPayload.network && r.scheme === paymentPayload.scheme,
  );
  if (!requirement) {
    const err = new Error('no matching payment requirement');
    err.status = 402;
    throw err;
  }
  const data = await callFacilitator('/verify', {
    x402Version: X402_VERSION,
    paymentPayload,
    paymentRequirements: requirement,
  });
  if (!data.isValid) {
    const err = new Error(`invalid payment: ${data.invalidReason || 'unknown'}`);
    err.status = 402;
    throw err;
  }
  return { paymentPayload, requirement };
}

async function settlePayment({ paymentPayload, requirement }) {
  return callFacilitator('/settle', {
    x402Version: X402_VERSION,
    paymentPayload,
    paymentRequirements: requirement,
  });
}
```

The CDP facilitator URL above (`/platform/v2/x402`) is Coinbase's production endpoint at the time of writing. CDP publishes any URL changes in their changelog; if your `/verify` call returns 404, check the current path in their docs.

---

## Step 6 — Do the work

Now we plug in the actual model inspection. Update the route:

```js
import { NodeIO } from '@gltf-transform/core';

const MAX_FETCH_BYTES = 16 * 1024 * 1024;
const io = new NodeIO();

async function inspectModel(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    const err = new Error('url is not a valid URL');
    err.status = 400;
    throw err;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    const err = new Error('url must be http(s)');
    err.status = 400;
    throw err;
  }
  const upstream = await fetch(parsed.toString(), {
    redirect: 'follow',
    headers: { accept: 'model/gltf-binary,model/gltf+json,application/octet-stream' },
    signal: AbortSignal.timeout(20_000),
  });
  if (!upstream.ok) {
    const err = new Error(`upstream returned ${upstream.status}`);
    err.status = 502;
    throw err;
  }
  const buf = new Uint8Array(await upstream.arrayBuffer());
  if (buf.byteLength > MAX_FETCH_BYTES) {
    const err = new Error(`model is ${buf.byteLength} bytes; max ${MAX_FETCH_BYTES}`);
    err.status = 413;
    throw err;
  }
  const doc = await io.readBinary(buf);
  const root = doc.getRoot();
  let totalVertices = 0;
  let totalTriangles = 0;
  for (const mesh of root.listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      const pos = prim.getAttribute('POSITION');
      if (pos) totalVertices += pos.getCount();
      const idx = prim.getIndices();
      if (idx) totalTriangles += idx.getCount() / 3;
    }
  }
  return {
    url: parsed.toString(),
    fetchedBytes: buf.byteLength,
    counts: {
      scenes: root.listScenes().length,
      nodes: root.listNodes().length,
      meshes: root.listMeshes().length,
      materials: root.listMaterials().length,
      textures: root.listTextures().length,
      animations: root.listAnimations().length,
      totalVertices,
      totalTriangles: Math.floor(totalTriangles),
    },
  };
}

app.get('/api/model-check', async (req, res) => {
  const resourceUrl = `${req.protocol}://${req.get('host')}${req.originalUrl.split('?')[0]}`;
  const requirements = paymentRequirements(resourceUrl);

  const paymentHeader = req.headers['x-payment'];
  if (!paymentHeader) return send402(res, resourceUrl);

  let verified;
  try {
    verified = await verifyPayment(paymentHeader, requirements);
  } catch (err) {
    if (err.status === 402) return send402(res, resourceUrl, { error: err.message });
    return res.status(err.status || 502).json({ error: err.message });
  }

  const targetUrl = String(req.query.url || '').trim();
  if (!targetUrl) return res.status(400).json({ error: 'url query param required' });

  let result;
  try {
    result = await inspectModel(targetUrl);
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message });
  }

  let settled;
  try {
    settled = await settlePayment(verified);
  } catch (err) {
    return res.status(err.status || 502).json({ error: err.message });
  }

  res.setHeader(
    'x-payment-response',
    Buffer.from(JSON.stringify(settled)).toString('base64'),
  );
  res.setHeader('cache-control', 'no-store');
  res.json(result);
});
```

Notice the ordering: **verify → work → settle**. If the work fails after the buyer's payment is verified, we never call `/settle`, so the buyer's signature is never broadcast and they don't pay. This is the cleanest atomic model — the buyer either gets what they paid for or pays nothing.

There is an alternative ordering (settle before work) that's slightly simpler but loses that property; production endpoints in the three.ws repo all use the verify-then-work-then-settle pattern. Stick with it.

---

## Step 7 — Run the buyer side locally

You need a buyer to test. The Coinbase x402 SDK ships a `fetchWithPayment` wrapper that does the handshake automatically. In a new directory:

```bash
mkdir x402-buyer && cd x402-buyer
npm init -y && npm pkg set type="module"
npm install @x402/fetch viem
```

Create `buy.js`:

```js
import { wrapFetchWithPayment } from '@x402/fetch';
import { createWalletClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base } from 'viem/chains';

const account = privateKeyToAccount(process.env.BUYER_PRIVATE_KEY);
const wallet = createWalletClient({
  account,
  chain: base,
  transport: http(process.env.BASE_RPC_URL || 'https://mainnet.base.org'),
});

const fetchPaid = wrapFetchWithPayment(fetch, wallet);

const url = `http://localhost:3000/api/model-check?url=${encodeURIComponent(
  'https://three.ws/avatars/cesium-man.glb',
)}`;

const res = await fetchPaid(url);
console.log('status', res.status);
console.log('body', await res.json());
```

Fund the buyer wallet with USDC on Base — anything over $0.01 USDC plus enough ETH for the (zero-cost-to-buyer, gasless) signature. Run:

```bash
BUYER_PRIVATE_KEY=0x<private-key-of-funded-test-wallet> node buy.js
```

What happens: the buyer's `fetchPaid` hits `/api/model-check`, gets 402, signs a USDC `transferWithAuthorization`, retries with `X-PAYMENT`, and prints the structured response. On your server logs you should see two facilitator round trips (verify, settle) and the work completing in between.

**Local testing caveat.** The Coinbase facilitator will accept localhost as a resource URL during development. Some other facilitators will not. If you see `invalid resource url` from `/verify`, deploy first and test against the public URL.

---

## Step 8 — Tier the pricing

The default is $0.001 per call. For more expensive work (calls that fetch large files, run inference, hit other paid APIs) charge more. Adjust by network:

```js
function paymentRequirements(resourceUrl) {
  return [
    {
      scheme: 'exact',
      network: 'eip155:8453',
      amount: '1000',           // $0.001 — cheap reads
      asset: USDC_BASE_MAINNET,
      payTo: PAY_TO,
      maxTimeoutSeconds: 60,
      extra: { name: 'USD Coin', version: '2', decimals: 6 },
    },
    {
      scheme: 'exact',
      network: 'eip155:42161',  // Arbitrum, also supported by CDP
      amount: '1000',
      asset: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', // USDC on Arbitrum
      payTo: PAY_TO,
      maxTimeoutSeconds: 60,
      extra: { name: 'USD Coin', version: '2', decimals: 6 },
    },
  ];
}
```

The client picks whichever network it has funds on. Most pick the first one (Base) because most agent treasuries are on Base.

For dynamically priced calls — e.g., charging more for larger input files — read the input before sending 402, compute the price, and emit it in the challenge. Re-running the challenge with the same parameters must return the same price, or buyers will rage-quit when their auto-retry fails.

---

## Step 9 — Make it discoverable in the Bazaar

The Bazaar (agentic.market) probes endpoints by issuing a 402 challenge without a payment header and inspecting the body. If your `accepts` includes an entry whose first-listed network is settled by CDP (Base mainnet), and your description is descriptive, the endpoint shows up in their catalog. There's no submission form. The probe is automatic.

To improve discoverability, extend the 402 body with the **bazaar extension** that the three.ws endpoints already advertise — it tells the catalog the input/output JSON schemas so callers can autogenerate types:

```js
function send402(res, resourceUrl, extra = {}) {
  const accepts = paymentRequirements(resourceUrl);
  const body = {
    x402Version: X402_VERSION,
    error: extra.error || 'X-PAYMENT header is required',
    resource: {
      url: resourceUrl,
      description:
        'Model Check — fetch a glTF/GLB URL, return structural stats. ' +
        'Useful for any agent vetting a 3D asset before minting, embedding, or paying for it.',
      mimeType: 'application/json',
    },
    accepts,
    extensions: {
      bazaar: {
        info: {
          input: {
            type: 'http',
            method: 'GET',
            queryParams: { url: 'https://three.ws/avatars/cesium-man.glb' },
            queryParamsSchema: {
              $schema: 'https://json-schema.org/draft/2020-12/schema',
              type: 'object',
              required: ['url'],
              properties: {
                url: { type: 'string', format: 'uri' },
              },
            },
          },
          output: {
            type: 'json',
            example: {
              url: 'https://three.ws/avatars/cesium-man.glb',
              fetchedBytes: 438044,
              counts: {
                scenes: 1, nodes: 22, meshes: 1, materials: 1,
                textures: 1, animations: 1, totalVertices: 3273,
                totalTriangles: 4672,
              },
            },
          },
        },
      },
    },
  };
  const headerB64 = Buffer.from(JSON.stringify(body)).toString('base64');
  res.setHeader('payment-required', headerB64);
  res.status(402).json(body);
}
```

The Bazaar's discovery probe reads both the response body and the `payment-required` header. Including the bazaar extension in the body is enough — the header is just a base64 mirror.

---

## Step 10 — Deploy

Vercel is the fastest path. Create `vercel.json`:

```json
{
  "version": 2,
  "functions": {
    "api/**/*.js": { "memory": 512, "maxDuration": 30 }
  }
}
```

Move your `index.js` route handler into `api/model-check.js` (Vercel-native), or deploy the Express app as a single function. Set env vars in the Vercel project settings:

```
X402_PAY_TO_BASE=0xYourBaseReceiverAddress
X402_AMOUNT=1000
CDP_API_KEY_ID=your-cdp-key-id
CDP_API_KEY_SECRET=your-cdp-key-secret
```

Deploy:

```bash
npx vercel --prod
```

Now hit your live URL:

```bash
curl -i https://<your-deployment>.vercel.app/api/model-check
```

You should see the 402 challenge with your real wallet address as `payTo`. Re-run the buyer script from Step 7, pointing at the production URL. The settlement transaction will appear on Basescan within a few seconds. Look up your receiver address — there should be a USDC `Transfer` event of 1000 micro-USDC ($0.001) coming in.

---

## Step 11 — Call the endpoint from your agent

The other half of x402: your agent calling other agents' endpoints. The clean pattern is a custom skill (see [custom-skill](/tutorials/custom-skill) for the file layout).

Create `model-check-skill/` with the four-file skill bundle. The interesting file is `handlers.js`:

```js
export async function check_model({ glb_url }, ctx) {
  // The agent's runtime exposes ctx.x402.fetch — the same wrapped fetch the
  // buyer script used in Step 7, signed with the agent's operator wallet.
  // The runtime injects a per-agent wallet for paid calls; you don't pass keys.
  const res = await ctx.x402.fetch(
    `https://<your-deployment>.vercel.app/api/model-check?url=${encodeURIComponent(glb_url)}`,
  );
  if (!res.ok) {
    return { ok: false, error: `model-check returned ${res.status}` };
  }
  const data = await res.json();
  return {
    ok: true,
    bytes: data.fetchedBytes,
    vertices: data.counts.totalVertices,
    triangles: data.counts.totalTriangles,
    summary: `Model has ${data.counts.totalVertices.toLocaleString()} vertices and ${data.counts.totalTriangles.toLocaleString()} triangles across ${data.counts.meshes} meshes.`,
  };
}
```

`tools.json`:

```json
{
  "tools": [
    {
      "name": "check_model",
      "description": "Pay for and run a structural check on a glTF/GLB model URL. Returns vertex/triangle counts and other stats. Use when the user asks whether a model is too heavy for mobile, how many materials it has, or whether it has animations.",
      "input_schema": {
        "type": "object",
        "properties": {
          "glb_url": { "type": "string", "description": "Public HTTPS URL of the glb/gltf model" }
        },
        "required": ["glb_url"]
      }
    }
  ]
}
```

Load the skill into your agent, ask "is this model too heavy for mobile? https://three.ws/avatars/cesium-man.glb", and watch the agent pay $0.001 mid-conversation and reply with concrete numbers.

The settlement is real. The receiver wallet (your endpoint's `X402_PAY_TO_BASE`) is credited. The buyer (your agent's operator wallet) is debited. Both sides see the transfer on-chain.

---

## Step 12 — Observability and rate-limiting

Once buyers are paying, you'll want to see the activity and protect against abuse.

**Public ledger.** The three.ws platform exposes a public ledger of paid calls at `https://three.ws/pay/calls` — a server-side aggregator that listens for `Transfer` events to the platform's known x402 receiver wallets and decodes them. If your endpoint is hosted elsewhere, build your own — Helius, Alchemy, or Coinbase Cloud all expose Base webhook subscriptions on `USDC.Transfer(to=<your-address>)`. Each event tells you which buyer paid for which call.

**Rate-limit by buyer wallet.** The buyer's wallet address is in the verified payment payload. Build a simple sliding window in Redis keyed by the buyer's payer address:

```js
const KEY = `x402:rl:${verified.paymentPayload.payer}`;
const count = await redis.incr(KEY);
if (count === 1) await redis.expire(KEY, 60); // 60-second window
if (count > 600) {
  // Don't settle. Refund mechanics are out of scope of x402 — we simply
  // never broadcast their signed authorization.
  return res.status(429).json({ error: 'rate limited' });
}
```

Returning 429 *after verify but before settle* is fine — the buyer's signature is single-use and expires (`maxTimeoutSeconds`). They won't be charged.

**Per-endpoint budget cap.** A buyer with a botched loop can hit you 100k times in a minute. Cap aggregate calls per buyer per day. The same Redis pattern with a 24h window works.

**Refunds.** x402 has no refund primitive. If you need to refund, you send USDC back to the buyer's address using the same chain. Treat this as a manual process triggered by support tickets, not an automated flow.

---

## Step 13 — Hardening checklist

Before you trust this in production:

- **Validate every input.** The `url` parameter in Step 6 is a great example: parse it, restrict to http/https, cap body size, set fetch timeouts. The production version in `api/x402/model-check.js` does all of these and you should too. Buyers that pay $0.001 and feed you a 10GB URL on a slow link can DOS your instance.
- **CORS.** If your buyers run in the browser (some do), serve `Access-Control-Allow-Origin: *` and explicitly allow `X-PAYMENT` in `Access-Control-Allow-Headers`. The Coinbase fetch client sends preflights.
- **No CDN caching.** Always emit `Cache-Control: no-store`. A cached 200 served from CDN edge to a buyer who didn't pay is a free lunch.
- **Idempotency for non-replayable work.** If the work is destructive (creates a database row, sends an email) and the settle step fails, you've done the work and lost the payment. Two mitigations: (a) make the work idempotent by some buyer-supplied key, and (b) only mark the work effective after settle succeeds.
- **Wallet rotation.** Treat `X402_PAY_TO_BASE` as hot. Sweep accumulated USDC to a cold address on a schedule.
- **Monitoring.** Log every 402 (challenge), every verify (success/fail with reason), every settle (tx hash). When the facilitator changes pricing, network support, or signature format, you find out from your own metrics — not from a buyer complaint.

---

## Step 14 — Going production with the three.ws platform

If you'd rather not host the endpoint yourself, three.ws supports paid endpoints natively: drop a Vercel function under `api/x402/<your-route>.js` in your fork of the platform, following the patterns in `api/x402/model-check.js`. The platform handles facilitator routing, the `_lib/x402-spec.js` helpers, and the bazaar extension shape — you just supply the work function.

See [self-host-agent-backend](/tutorials/self-host-agent-backend) for the fork + deploy mechanics and [deploy-to-vercel-custom-domain](/tutorials/deploy-to-vercel-custom-domain) for moving it to your own domain.

The advantage of the platform path: your endpoint shows up automatically in three.ws's discovery (`https://three.ws/.well-known/x402`), in the agent's MCP catalog ([mcp-server-for-your-agent](/tutorials/mcp-server-for-your-agent)), and on the public ledger at `https://three.ws/pay/calls`.

The advantage of the standalone path: full control, no platform dependency, and your revenue routes directly to your own wallet.

Both work. Choose based on whether your endpoint is part of an agent platform you're already running, or a standalone service for which the platform is just a discovery surface.

---

## What you learned

- The x402 wire protocol from both sides: challenge, signed payload, verify, work, settle
- Why Coinbase CDP routing matters for catalogability in the Bazaar
- A real implementation pattern: verify → work → settle, with atomicity guarantees for the buyer
- How to make your endpoint discoverable via the bazaar extension
- How an agent buys your work from inside a skill using `ctx.x402.fetch`
- The operational concerns: rate limits, wallet hygiene, refunds, monitoring

## Next steps

- Wrap the same endpoint as an MCP tool so non-x402 agents (Claude Desktop, Cursor) can also call it — [mcp-server-for-your-agent](/tutorials/mcp-server-for-your-agent).
- Add a database-backed paid skill with per-user auth and an audit log — [skill-with-database-auth](/tutorials/skill-with-database-auth).
- Coordinate the calling agent with a second one to handle complex sales flows — [multi-agent-coordination](/tutorials/multi-agent-coordination).
- Mint a Pump.fun token to distribute upside in the endpoint's revenue — [mint-pumpfun-token](/tutorials/mint-pumpfun-token).
