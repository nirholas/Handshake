# `api/x402/` — paid HTTP endpoints

Every file in this directory is an HTTP endpoint that charges per call over
[x402](../../docs/x402.md): the caller hits it, gets a `402 Payment Required`
challenge, settles a small USDC payment, and retries with an `X-PAYMENT` header to
get the result. These are the platform's **own** sellable services — the catalog
other agents (and the [autonomous loop](../../docs/autonomous-x402.md)) pay to use.

- **Full catalog + prices:** [`docs/x402-endpoints.md`](../../docs/x402-endpoints.md)
- **How to pay one as a buyer:** [`docs/x402-buyer.md`](../../docs/x402-buyer.md)
- **Protocol mechanics:** [`docs/x402.md`](../../docs/x402.md)

## How an endpoint is built

Each handler exports the result of `paidEndpoint(spec)` from the shared handler
[`../_lib/x402-paid-endpoint.js`](../_lib/x402-paid-endpoint.js). That factory
builds the 402 challenge, verifies and settles the payment, runs your logic, then
issues a signed receipt — so a handler only declares its price, schema, and the
work to do. Minimal shape (see [`token-intel.js`](./token-intel.js) for a full
one):

```js
import { paidEndpoint } from '../_lib/x402-paid-endpoint.js';
import { priceFor } from '../_lib/x402-prices.js';

const ROUTE = '/api/x402/my-service';

export default paidEndpoint({
	route: ROUTE,
	// Default price in USDC atomics (6 decimals); env-overridable — see below.
	priceAtomics: priceFor('my-service', '10000'), // $0.01
	description: 'One line an agent reads to decide whether to buy.',
	networks: ['solana', 'base'], // accepted networks, in challenge order
	schema: {
		/* JSON Schema for input + output, drives Bazaar discovery */
	},
	// Throw BEFORE doing paid work if inputs are bad — the buyer keeps their money.
	async handler({ req }) {
		return {
			/* the JSON result the buyer paid for */
		};
	},
});
```

The handler runs **after** settlement, so it must deliver real value every time.
If the work can't be done (bad input, upstream down), throw before settling — the
shared handler turns that into the 402/4xx the buyer expects rather than charging
for nothing.

## Pricing & overrides

Each endpoint declares its own default inline via `priceFor('<slug>', '<atomics>')`.
Operators override any price at deploy time with:

```
X402_PRICE_<SLUG>=<atomics>
```

where `<SLUG>` is the upper-snake-case slug — `my-service` → `X402_PRICE_MY_SERVICE`.
The resolver ([`../_lib/x402-prices.js`](../_lib/x402-prices.js)) falls back to the
inline default on a missing or non-integer value.

## Free read surfaces in this directory

A few files live here but are **not** paid — they're free observability reads
(`mcp-perf.js`, `service-pricing-report.js`) or signature-gated buyer access
(`my-receipts.js`, which proves wallet ownership via SIWX instead of charging).
They use the `wrap()`/plain-handler pattern, not `paidEndpoint`.

## Adding an endpoint

1. Create `api/x402/<slug>.js` exporting `paidEndpoint({ ... })`.
2. Add a row to [`docs/x402-endpoints.md`](../../docs/x402-endpoints.md) with the
   slug, default price, and what it returns.
3. Add the route to `vercel.json` so `/api/x402/<slug>` resolves.
4. Add a `data/changelog.json` entry if it's a new user- or developer-facing
   service.
