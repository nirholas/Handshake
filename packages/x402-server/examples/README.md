# Examples — @three-ws/x402-server

Runnable examples for the seller half of x402. Each is a standalone `.mjs` file.

| File | What it shows | Run |
|---|---|---|
| [`loopback-demo.mjs`](loopback-demo.mjs) | The **whole loop offline** — a paid server, a buyer, and a local stub facilitator. No accounts or network needed. Start here. | `node examples/loopback-demo.mjs` |
| [`express-metered-api.mjs`](express-metered-api.mjs) | Meter an existing Express route with `paid()` (deliver-then-settle). | `node examples/express-metered-api.mjs` |
| [`raw-primitives.mjs`](raw-primitives.mjs) | Drive `buildChallenge` / `verifyPayment` / `settlePayment` / `feeSplit` directly, no middleware. | `node examples/raw-primitives.mjs` |
| [`streaming-download.mjs`](streaming-download.mjs) | A paid binary/stream download with `streaming: true` (settle-then-stream). | `node examples/streaming-download.mjs` |

The two server examples listen on a fixed port (3000 and 3001). Set `PORT` to
move either one when that port is taken:

```bash
PORT=3100 node examples/express-metered-api.mjs
PORT=3111 node examples/streaming-download.mjs
```

## The two response modes

`paid()` guarantees the buyer never receives the good before settlement. It does
that two ways, and you pick per route:

- **Deliver-then-settle (default).** Your handler writes its response normally
  (`res.json(...)`) or just `return`s a value. The wrapper **buffers** that
  output, settles the payment, then flushes the `200` with the
  `X-PAYMENT-RESPONSE` receipt header attached. Best for JSON APIs — see
  `express-metered-api.mjs`.
- **Settle-then-stream (`streaming: true`).** For responses you can't buffer (a
  large file, SSE, `res.pipe`). Settlement runs first, the receipt header is set
  up-front, then your handler streams the body. See `streaming-download.mjs`.

Either way the order is **verify → work → settle**: a handler that throws never
charges (the failed-payment path returns `500` and skips settlement).

## Pairing with a buyer

A real buyer signs the on-chain payment. The offline demo fakes that with a stub
facilitator; against a live facilitator, use the buyer-side
[`@three-ws/x402-fetch`](https://www.npmjs.com/package/@three-ws/x402-fetch) —
it pays any `402` these servers emit automatically:

```js
import { withX402 } from '@three-ws/x402-fetch';
const pay = withX402(fetch, { wallet });   // wallet signs the on-chain payment
const res = await pay('http://localhost:3000/v1/embed', { method: 'POST', body });
// The 402 is paid and retried transparently; `res` is the paid 200.
```
