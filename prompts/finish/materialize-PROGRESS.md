# Materialize campaign: progress log

The only memory between sessions. Append an entry when you finish (or
meaningfully advance) a work order: date, order, what shipped (paths),
what was verified (commands/evidence), owner items surfaced. Never record
"done" for anything not verified on disk.

## Log

- 2026-08-13: Campaign authored. Product architecture decided in
  00-CONTEXT.md (naming, routes, schema, OSS choices, pricing model,
  launch scope), six work orders written to the pack standard. Origin:
  inbound partnership offer from a Chinese high-precision print operator;
  campaign deliberately does not block on any partner. No product code
  exists yet; order 01 is the first build session.

- 2026-09-02, order 02 (quote, orders, money): checkout is wired on both
  lanes. NOTE FOR THE NEXT SESSION: this order was run by two sessions at
  once. A concurrent session landed the catalog (`data/print-catalog.json`,
  4 cited sources), the quote engine (`api/_lib/print/quote.js`: pricing,
  constraint rejections with fixes, alternatives, hollowing, HMAC quote
  tokens) and the free `GET /api/print/catalog` + `POST /api/print/quote`
  handlers. This session built the money half on top of it rather than a
  second copy of the same thing.
  Shipped here: `api/print/orders.js` (session + CSRF, opens an order from a
  verified token and returns a Solana Pay intent, gasless when the buyer's
  wallet is connected), `api/print/orders/[id].js`,
  `api/print/orders/[id]/confirm.js` (findReference + validateTransfer, a
  chain READ, then paid -> screening), `api/x402/print-order.js` (the agent
  lane: every refusal pre-settle, the 402 quotes the token's own total, the
  post-settlement hook promotes the order), `createOrder` /
  `normalizeShipping` / `listOrdersForUser` in `api/_lib/print-store.js`,
  migration `20260902214500_print_order_payment.sql` (payment reference,
  signature, quote expiry, unique indexes so one transaction cannot settle
  two orders), `print_update` wired through notify-prefs and the bell,
  `printOrderIp` rate bucket, ring-catalog + service-catalog registration,
  tests `tests/print-checkout-store.test.js` and
  `tests/api/print-checkout-endpoints.test.js`.
  Two real defects found and fixed while proving it: the edition gate 500'd
  every direct-GLB order (no creation id means no series to be sold out of),
  and `paidEndpoint` advertised a FIXED $THREE amount beside a per-request
  USDC price, so a 39.13 USDC print and a 12 USDC one both offered the same
  flat token price. `acceptThree: false` now opts print-order and knock out.
  Also cataloged knock, which had been failing the ring parity test.
  Verified: local `server/index.mjs` against the production database, real
  QA session, real GLB. Catalog -> analyze (score 100) -> quote (39.13 USDC,
  itemized) -> order 201 with a Solana Pay intent -> GET shows the timeline
  and never the street address -> confirm with no payment answers 202
  pending -> the store leg reaches `screening` and refuses
  `screening -> delivered`. The 402 for that order quotes exactly 39130000
  atomics of USDC and nothing else.
  NOT verified, and deliberately: no USDC was ever sent. Taking real money
  is CLAUDE.md gate 1, so the `paid` transition in the transcript was driven
  through the store with a note saying so, and that QA order was closed out
  as `rejected` rather than left in the operator queue. The chain-read half
  is proven by the 202 and by the payment_mismatch unit test.
  Owner items: `data/print-catalog.json` rates and shipping zones are the
  one file to tune against a real bureau quote and a real carrier account.
  Next: order 03 (the /materialize surface) can consume
  `POST /api/print/orders` and its `payment` block as-is.
