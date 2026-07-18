# Meter Any API With x402 Using @three-ws/x402-server

By the end of this tutorial you will have taken an ordinary HTTP handler and made it **charge per call** — no API keys, no Stripe, no sign-up page. A caller hits your endpoint, gets a `402 Payment Required` with a machine-readable price, pays in USDC (or `$THREE`) on Solana or Base, and retries to get the work. You will run the whole loop on your own machine first, then wire it into a real server.

This is the **seller** half of [x402](/docs/x402). The package is [`@three-ws/x402-server`](https://www.npmjs.com/package/@three-ws/x402-server) — the same merchant primitives the three.ws rails run in production, extracted as a zero-dependency SDK.

**What you'll build:**

- A paid endpoint with one wrapper: `paid({ price, payTo }, handler)`
- The full 402 handshake: challenge → verify → run the work → settle → receipt
- Solana-first pricing (USDC, optionally `$THREE`), with Base as a second lane
- A local, offline run of the entire buyer↔seller loop — no accounts needed
- The two response modes: buffered JSON (default) and streamed downloads

**Prerequisites:**

- Node.js 18+ (uses global `fetch`).
- Nothing else to start — the first run is fully offline. To take *real* payments you'll later need a Solana pay-to address and a facilitator sponsor fee-payer; both are covered at the end.

---

## 1. Install

```bash
npm install @three-ws/x402-server
```

Framework-agnostic: it works as Express/Connect middleware, a Fastify hook, a Vercel function, or a bare Node `http` handler.

## 2. The mental model: verify → work → settle

Every paid call runs three steps, always in this order:

1. **Verify** the buyer's `X-PAYMENT` header against what you advertised. No work runs unless the payment checks out.
2. **Run the work** — your actual handler.
3. **Settle** on-chain, and return the result with an `X-PAYMENT-RESPONSE` receipt.

Settlement is *last*, so a handler that throws never charges. And the buyer never receives the good before settlement — the wrapper enforces that for you (details in step 6).

## 3. Run the whole loop offline

Before wiring a real facilitator, watch the handshake end-to-end on your machine. This uses a local stub facilitator that always approves — a learning harness, not production.

Save as `demo.mjs`:

```js
import http from 'node:http';
import { createX402Server } from '@three-ws/x402-server';

const NETWORK = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';

// A local stand-in for the settlement facilitator (always approves).
const facilitator = http.createServer((req, res) => {
  let raw = ''; req.on('data', c => raw += c); req.on('end', () => {
    const body = req.url === '/verify'
      ? { isValid: true, payer: 'BuyerWallet111' }
      : { success: true, transaction: 'LOCAL_TX', network: NETWORK, payer: 'BuyerWallet111' };
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(body));
  });
});
const facUrl = await new Promise(r => facilitator.listen(0, () => r(`http://127.0.0.1:${facilitator.address().port}`)));

// The paid resource, pointed at the local facilitator.
const server = createX402Server({ facilitator: facUrl });
const app = http.createServer(server.paid(
  {
    price: '50000',                                   // $0.05 USDC (6-decimal atomics)
    payTo: { solana: 'THREEsynthetic1111111111111111111111111PayTo' },
    feePayer: 'THREEsynthetic1111111111111111111111FeePayer',
    description: 'Premium data',
  },
  async (_req, _res, payment) => ({ good: 'the premium data', paidBy: payment.payer }),
));
const appUrl = await new Promise(r => app.listen(0, () => r(`http://127.0.0.1:${app.address().port}`)));

// Buyer, round 1: no payment → 402 challenge.
const challenge = await (await fetch(`${appUrl}/api/premium`)).json();
console.log('402 accepts:', challenge.accepts.map(a => `${a.extra.name} on ${a.network.split(':')[0]}`));

// Buyer, round 2: attach an X-PAYMENT header and retry.
const xPayment = Buffer.from(JSON.stringify({ x402Version: 2, network: NETWORK, payload: { transaction: 'signed' } })).toString('base64');
const paid = await fetch(`${appUrl}/api/premium`, { headers: { 'x-payment': xPayment } });
console.log('200 body:', await paid.json());
const receipt = JSON.parse(Buffer.from(paid.headers.get('x-payment-response'), 'base64').toString());
console.log('receipt tx:', receipt.transaction);

facilitator.close(); app.close();
```

```bash
node demo.mjs
```

```
402 accepts: [ 'USDC on solana' ]
200 body: { good: 'the premium data', paidBy: 'BuyerWallet111' }
receipt tx: LOCAL_TX
```

That is the entire protocol. The handler just **returned a value** — the wrapper serialized it as JSON, settled, and attached the receipt header.

> This exact demo ships runnable in the package: [`examples/loopback-demo.mjs`](https://github.com/nirholas/three.ws/blob/main/packages/x402-server/examples/loopback-demo.mjs).

## 4. Price it: atomic units, lanes, and $THREE

`price` is in **atomic units** of the asset. USDC is 6-decimal, so `'10000'` = `$0.01` and `'1000000'` = `$1.00`.

Advertise both lanes by giving both a `payTo`. Solana leads (first-accept clients settle there); pass `network: ['base']` to lead with EVM.

```js
paid(
  {
    price: '50000',
    payTo: {
      solana: '<your-SPL-pay-to>',
      base:   '0x<your-EVM-pay-to>',
    },
    feePayer: '<facilitator-sponsor-account>',  // required for the Solana accept
    acceptThree: true,        // also advertise $THREE next to USDC on Solana
    threeAmount: '10000000',  // optional distinct $THREE price; omit to reuse `price`
  },
  handler,
);
```

`acceptThree: true` adds a `$THREE` Solana accept right after USDC, so a wallet's token chooser surfaces both while a first-accept client still settles USDC. `$THREE` is Solana-only.

## 5. Take a platform fee (without marking up the buyer)

A fee is carved **out** of the listed price — the buyer's total is exactly `price`; the creator nets `price − fee`.

```js
paid(
  { price: '1000000', payTo, feePayer, feeBps: 250, feeTo: '<treasury>' },  // 2.5%
  handler,
);
```

On `$1.00`: buyer pays `$1.00`, creator nets `$0.975`, treasury gets `$0.025`. The fee is clamped to 10% (`feeBps ≤ 1000`), and ships **inert** — with `feeBps: 0` or no `feeTo`, nothing is charged. You can compute a split yourself with `feeSplit(price, bps, recipient)`.

## 6. Two response modes

The wrapper guarantees the buyer never gets the good before settlement. You choose how it does that:

**Deliver-then-settle (default).** Write your response normally or return a value. The wrapper *buffers* the output, settles, then flushes the `200` with the receipt header. Best for JSON APIs.

```js
app.post('/v1/embed', paid(
  { price: '2000', payTo, feePayer },
  async (req, res, payment) => {
    res.json({ vector: await embed(req.body.text), billedTo: payment.payer });
  },
));
```

**Settle-then-stream (`streaming: true`).** For responses you can't buffer — a large file, SSE, `res.pipe`. Settlement runs first, the receipt header is set up-front, then you stream:

```js
paid(
  { price: '100000', payTo, network: ['base'], streaming: true },
  async (_req, res) => {
    res.setHeader('content-type', 'text/csv');
    res.write('id,value\n');
    for (let i = 0; i < 5; i++) res.write(`${i},${i * 1.5}\n`);
    res.end();
  },
);
```

## 7. Handle the edge cases (the SDK already does)

`verifyPayment` returns a structured result instead of throwing on a bad payment, and `paid()` maps each state to the right status:

| Situation | HTTP | Safe to retry? |
|---|---|---|
| No/!invalid `X-PAYMENT` | 402 | Yes — pay and retry |
| Facilitator `/verify` down | 502 | Yes — **no funds moved** |
| Handler threw after payment | 500 | Yes — settlement was **skipped**, no charge |
| Settlement status unknown | 502 (`settle_uncertain`) | Check on-chain first |

The two invariants that make this safe: verification runs *before* your handler, settlement runs *after* it.

## 8. Go live

To take real payments, replace the local facilitator with a live one and use real accounts:

- **`payTo`** — your Solana SPL address and/or EVM address that receives funds.
- **`feePayer`** (Solana) — the facilitator's sponsor account that co-signs the SPL transfer so the buyer pays no SOL gas. The default facilitator is `https://facilitator.payai.network`; override with the `facilitator` option.
- Deploy the handler anywhere that serves HTTPS (buyers' clients refuse non-HTTPS). Any Node host works — Vercel, Fly, Railway, a VPS.

Test it with a real buyer using the seller's twin, [`@three-ws/x402-fetch`](https://www.npmjs.com/package/@three-ws/x402-fetch):

```js
import { withX402 } from '@three-ws/x402-fetch';
const pay = withX402(fetch, { wallet });         // wallet signs the on-chain payment
const res = await pay('https://your.api/v1/embed', { method: 'POST', body });
// The 402 is paid and retried transparently; `res` is the paid 200.
```

## Where to go next

- [x402 overview](/docs/x402) — the protocol, the lanes, the facilitators.
- [Build a paid x402 endpoint your agent calls](/tutorials/paid-x402-endpoint) — the CDP/Base-catalog path with Bazaar discovery.
- [x402 buyer client](/docs/x402-buyer) — the paying side in depth.
- Package examples: [`packages/x402-server/examples`](https://github.com/nirholas/three.ws/tree/main/packages/x402-server/examples).
