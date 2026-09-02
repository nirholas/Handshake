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

- 2026-09-02: Order 04 (fulfillment adapters + operator console) shipped.
  Adapter layer `api/_lib/print/adapters/` (contract, registry, `manual`,
  `partner-cn`) with capabilities declared as data and registration gated on
  `configured()`, so an uncredentialed lane is invisible rather than broken.
  Orchestration `api/_lib/print/fulfillment.js` (adapters speak, the store
  decides: every adapter result becomes at most one `transition()` call).
  Fulfillment reads and the webhook ledger in
  `api/_lib/print/fulfillment-queries.js`, kept out of `print-store.js` so the
  state machine stays the file a reviewer can read. Operator gate
  `api/_lib/print/ops-auth.js` (admin session, `PRINT_OPERATORS` allowlist, or
  `OPS_SECRET`; fails closed in dev too, because these responses carry PII).
  Operator channel `api/_lib/print/ops-notify.js` (private Telegram ops chat,
  admin bell, `ops_alerts` for stalls). API `api/print/ops/[action].js`
  (queue, order, adapters, transition, submit, tracking, cancel, refund) and
  `api/print/webhook/[provider].js`. Console `/materialize/ops`
  (`pages/materialize-ops.html`, `src/materialize-ops.{js,css}`). Sweep
  `api/cron/print-orders-sync.js`, registered in `vercel.json` at `17 * * * *`
  (cron count in CLAUDE.md moved to 113). Runbook
  `docs/ops/materialize-fulfillment.md`. Tests: `print-adapter-contract`
  (conformance run over both adapters), `print-ops-authorization`,
  `print-webhook-idempotency`, `print-fulfillment-routing`, `print-orders-sync`.
  Verified against the production database with `server/index.mjs` and a real
  Chromium session: a seeded order walked screening -> submitted -> printing ->
  quality_check -> shipped entirely through the console UI, every event
  attributed to the operator, `quality_check -> delivered` refused 409. Three
  identical signed webhook deliveries produced one timeline row and one ledger
  row; a forged signature and a delivery to the manual lane were both 401 before
  the body was parsed. The sweep polled 6 open orders, isolated one unreachable
  partner into `failures`, flagged one stalled order and stamped it so the next
  sweep stays quiet (proven by re-querying with the re-alert window at zero).
  Anonymous and signed-in-non-operator callers were refused on all eight
  endpoints, live and in tests. All walkthrough rows were deleted afterwards.
  Three real defects found and fixed while proving it: the drawer sat under the
  sticky site header so Close was unclickable; the drawer's click listener was
  re-registered per render, firing each action up to three times (two 409s
  behind every landed mutation); and the post-action reload wiped the result
  line and, worse, the refund payout instruction carrying the recipient and
  amount.
  Owner items: `TELEGRAM_PRINT_OPS_CHAT_ID` (a dedicated private ops chat;
  without it paging falls back to `TELEGRAM_ALERTS_CHAT_ID`, then to the admin
  bell), `PRINT_OPERATORS` (staff fulfillment without granting platform admin),
  and `PRINT_PARTNER_CN_URL` + `PRINT_PARTNER_CN_KEY`, which stay absent until
  a partner is contracted. Signing that partner is an owner action.
  Next: the adapter registry is the only file a contracted partner touches.
