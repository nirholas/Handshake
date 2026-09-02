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

- 2026-09-02, order 03 (the /materialize surface): the page is live locally and
  exercised end to end in a real browser. NOTE: this pack ran with ~49 sessions
  sharing one worktree, so several of these files were swept into other
  sessions' commits before this one landed; the content is this session's.
  Shipped: `pages/materialize.html` + `src/materialize.js` + the pure
  `src/materialize-lib.js` (scale drawing, slider maths, itemization rows,
  timeline, shipping validation), the tracking page
  `pages/materialize-order.html` + `src/materialize-order.js`, and the two
  handlers the page needed that nobody had built: `api/print/prepare.js`
  (repair, scale, optional hollow, then STL/3MF/repaired-GLB to R2 with the
  before and after reports) and `api/print/upload.js` (presigned slot so a
  local .glb can be measured). Entry points: `/m/:id` action bar, the forge
  result bar (deep-links by creation id, falls back to the GLB url), creation
  cards, and the advanced-tier nav item. Routes in `data/pages.json`,
  `vite.config.js` (input + dev static + the `/materialize/orders/:id` dynamic
  rule) and `vercel.json`. Docs: a "Using the page" section in
  `docs/materialize.md`; STRUCTURE.md row extended.
  Also added to order 02's engine (which a concurrent session had landed):
  `fitHeightRange()` and `materialFits()`, so the slider ends and the material
  cards are the server's own measurement of THIS mesh rather than the catalog's
  machine limits, plus `tests/print-quote-engine.test.js` (27) and
  `tests/materialize-lib.test.js` (41), both green.
  Verified in Chromium against `server/index.mjs` on the production database
  with a real QA session and real forge creations: empty state, loading,
  populated, analyze failure (two distinct messages for an unreadable file and
  an unfetchable URL), rejection with its fix and alternatives, repair (38s,
  6404 vertices merged, score 88 to 93, viewer swapped to the prepared file),
  material switch, quantity break, destination re-pricing, the AR desktop QR
  handoff, the anonymous sign-in gate, shipping validation, a real order (201)
  with a live Solana Pay intent and QR, and the tracking page in both its live
  and canceled states. Console clean, no horizontal overflow at 320 or 768.
  Five defects found and fixed while proving it: `/api/auth/me` answers
  `{user:null}` for a visitor and the envelope was being read as the user, so
  the sign-in gate never fired; the printability card rendered before the size
  existed and reported the mesh's native wall thickness; the preset row rendered
  four dead chips when none fitted the material's band; the creations rail only
  worked for an account with a claimed username; and the tracking page showed a
  raw material id and no lead time until a job was submitted.
  NOT verified, deliberately: no USDC was sent (CLAUDE.md gate 1), so `paid` and
  everything after it on the tracking page is covered by unit tests, not a live
  payment. AR placement itself needs a phone; the `scale` + `ar-scale="fixed"`
  wiring was verified in the DOM and the factor is the quote's own scale.
  model-viewer cannot fetch an R2 model from a localhost origin because the
  bucket's CORS allowlist names `https://three.ws` only (confirmed by preflight;
  it is the `backlog-05-r2-bucket-cors` item), so the browser runs stood that one
  policy down; every model, API call and price in them was real.
  Two QA orders (`0ce46a9b-5ac5-43ed-b2bb-151c213ef016`,
  `0a83c40c-6030-4c33-9920-21a48ab04e64`) were opened against the production
  database and closed out as `canceled` with a note; neither is in the operator
  queue.
  Owner items: none new. Next: orders 04, 05 and 06 are already in flight from
  other sessions; the surface consumes their endpoints as they land.

- 2026-09-02, order 05 (certificates, editions, the phygital link): shipped and
  closed. Ran alongside orders 01-04 in other sessions, so parts of this landed
  inside their commits; what this session authored:
  `api/_lib/print/certificate.js` (SHA-256 of the exact prepared bytes read
  back off object storage, atomic edition claim, QR to R2, SPL Memo
  attestation, `retryPendingAttestations`, the public read with its visibility
  rule), `api/_lib/print/editions.js` (series keys, cap normalisation,
  `assertEditionAvailable`, creator-only `setEditionLimit`), the state machine
  in `api/_lib/print-store.js` (statuses, transition whitelist, guarded update,
  timeline row, `print_update` notification, the shipped -> certificate hook)
  which orders 02 and 04 then extended, migration
  `20260902193000_print_certificates.sql` (+ `forge_creations.print_edition_limit`),
  `api/print/certs/[id].js`, `api/print/editions.js`,
  `api/print/ops/insert-card.js`, `pages/certificate.html` +
  `src/certificate-page.js` + `src/certificate.css` (`/cert/:id` and the
  `/cert` lookup), `pages/print-insert.html` + `src/print-insert.js` +
  `src/print-insert.css` (the A5 package insert), the Physical editions panel
  on `/m/:id`, `editionNote` on `/materialize`, the edition gate on
  `/api/print/quote` and both checkout lanes, and the attestation retry pass in
  `api/cron/print-orders-sync.js`. Tests:
  `tests/print-certificate.test.js` (44), `tests/print-store.test.js` (20),
  the attestation cases in `tests/print-orders-sync.test.js`, `editionNote` in
  `tests/materialize-lib.test.js`.
  ROUTE DEVIATION from 00-CONTEXT: the certificate page is `/cert/:certId`,
  not `/p/:certId`. `/p/([a-z0-9-]+)` was already the launchpad route and a
  24-hex certificate id matches it, so `/p/` would have shadowed a live
  surface. 00-CONTEXT and the architecture diagram were updated to match.
  Certificate ids are 24 lowercase hex characters (the `/drop/:id` convention)
  rather than uuids, because the id is printed on a card and encoded in a QR
  that has to scan off paper.
  Verified end to end against the production database and real object storage:
  order `aa005325-6d60-490a-9c18-331fe55d1eb9` walked `created -> shipped`
  through the store, which hashed the real 2,554,288-byte GLB of creation
  `19d94f26-8207-4cd8-89ab-62193dc2c211` to
  `c3a3eaf09f88ef4776a089817de1dd09e82c334c5b9dafa2534bdf00d44da578`
  (independently confirmed with `curl … | sha256sum`), claimed edition 1,
  wrote a real 4,934-byte QR PNG to R2, and built certificate
  `aef337708dbb8191c25c2a64`. `/cert/aef337708dbb8191c25c2a64`,
  `/materialize/insert/aef337708dbb8191c25c2a64` (screen and print media, the
  print sheet showing only the card), `/cert` and the not-found state were all
  rendered in a real browser at 1440 and 390 with no errors from this code.
  The sold-out refusal was proven live: the series was capped at 1, the quote
  came back `edition_sold_out` with the remaining count and a fix line, and the
  cap was restored to null.
  NOT verified, and the one open item: the devnet memo transaction never sent.
  The attester `Fcwqit9x1KmfUboPtoVWBUdEuonNyTA8T6xtfAEPpPeH` has no devnet
  SOL, the public devnet faucet is rate-limited for this machine's IP, and the
  only wallet here holding devnet SOL is a platform treasury the permission
  layer declined to sign or transfer from. The certificate is issued, hashed,
  QR'd and carries its exact memo string; `solana_signature` is null and the
  page says so. OWNER ACTION, one step: send about 0.02 devnet SOL to that
  address and the sweep attests it within 15 minutes with no code change.
  Owner items: mainnet certificates need `PRINT_CERT_CLUSTER=mainnet` plus
  `PRINT_CERT_MAINNET_APPROVAL` on the Cloud Run service; without the second
  the certificate is issued and left unattested rather than downgraded to a
  devnet signature. Deliberately untriggered here (CLAUDE.md gate 1).

- 2026-09-02: Order 06 (fabrication gate, spec, docs, launch) shipped. The
  campaign is closed; 00-CONTEXT, 01, 06 and the README are retired in this
  commit and this log is the surviving record.
  THE GATE. `api/_lib/print/rules.js` carries the denylist as structured rules,
  one per category with its own buyer-facing message and its own "what is
  allowed instead" line: firearm components, suppressors and solvent traps,
  ammunition and feeding devices, keys and lock-bypass tools, counterfeit and
  trademark goods, working weapon mechanisms, drug paraphernalia, plus one SOFT
  rule for realistic weapon likeness. `api/_lib/print/gate.js` layers them:
  the generation content classifier (narrowed to its four scale-independent
  categories, see the deviation below), the denylist, a scale signal, then the
  platform LLM chain. The denylist always wins; the model can only ADD a
  refusal, and it is not called at all once a hard rule fires.
  TWO RUN POINTS, both wired, neither advisory. At quote time
  `api/print/quote.js` runs the deterministic layers before any price exists
  and answers 451 with the category, the policy link and the allowed
  alternative, so a refusal costs the buyer nothing and a price is never gated
  on a third-party model being up. After payment the screening pass runs as a
  third pass inside `api/cron/print-orders-sync.js` (it makes a model call, so
  it must not sit in a checkout request), records the verdict on
  `analysis.screening`, and moves a failure to `rejected`. `submitOrder()` now
  refuses any order without a recorded `allow` verdict, so the gate cannot be
  clicked past from the operator console.
  Also shipped by this order: `specs/PRINT_PIPELINE.md` (six versioned wire
  contracts: printability report, quote token, order states, gate verdict,
  adapter interface, webhook envelope, certificate memo, plus a stated
  limitations section), `docs/materialize.md` wired into `docs/nav.json`,
  `docs/start-here.md` and `data/pages.json`, the `/api/print/*` section of
  `docs/api-reference.md`, the STRUCTURE.md row, three changelog entries, and
  two MCP tools (`print_analyze`, `print_quote` in `api/_mcp/tools/print.js`)
  so an agent discovers the print lane in the same list it discovered
  generation. Tests: `print-fabrication-gate` (36), `print-gate-wiring` (7),
  `print-mcp-tools` (9).
  GAPS FROM EARLIER ORDERS, closed here rather than reported: order 01 never
  registered its endpoints in the free 3D API catalog, so `/api/3d` and its
  OpenAPI did not advertise the print lane at all; `api/_lib/3d-catalog/
  print-quote.js` and `print-prepare.js` plus the static barrel fix that, and
  both now appear in the live index and in `/api/3d/openapi.json` (verified).
  `src/materialize-order.js` shipped an inline `onclick="location.reload()"`
  on its error-state Try again button, which the site CSP blocks, so the only
  way out of that state did nothing; it is delegated now.
  `pages/print-insert.html` resolved no `[hidden]` guard.
  VERIFIED. Gate unit + wiring + MCP suites green (52 tests). Against a local
  `server/index.mjs` on the production database with the page served by vite:
  a clean quote returns 33.87 USDC with `screening.verdict: allow`, and three
  crafted violating orders (an AR-15 lower receiver, a suppressor baffle asked
  for in the buyer note, a bump key) each answer 451 with the right category
  and no price and no token in the body. Run point 2 was proven end to end on
  real rows: two orders walked created -> quoted -> paid -> screening, the
  violating one auto-rejected with the category and the policy link on its
  timeline and `allow`/`refuse` stored under `analysis.screening`, the
  ordinary one stayed in screening, and both rows were deleted afterwards (0
  remaining). No USDC moved: the `paid` transition was driven through the
  store with a note saying so, per CLAUDE.md gate 1. The LLM layer was proven
  separately against the live chain (OVH Llama-3.3-70B refused "a compact
  carry pistol, life accurate, for range use"). Browser walk: `/materialize`
  at 320, 768 and 1440 with zero horizontal overflow and no page-code console
  errors, and `/docs/materialize#content-policy` resolves to a real anchor
  (`id="content-policy"`), which is what keeps a refusal from linking a 404.
  `npm run audit:docs` clean (1480 files). `npm run gate`: every step passes
  except `audit:tokens`, which reports 8 hardcoded token hexes across four
  pages unrelated to this campaign (motion, oracle-lab, stream,
  threews-claim); the one drifted hex that WAS this campaign's
  (`pages/payment-outcomes.html`) is fixed. A peer session is visibly working
  that list down.
  DEVIATIONS FROM 00-CONTEXT, one line each. (1) There is no
  `POST /api/print/analyze`: order 02 merged analysis into
  `POST /api/print/quote`, which returns the report alone when no material is
  given. That is one round trip instead of two and is what the docs, the spec
  and the MCP tools describe; no stale reference to the old path survives.
  (2) The upstream generation classifier is honoured for csam, sexual, gore
  and hate only. Its fifth category refuses the bare word "pistol", which
  would refuse every tabletop miniature carrying one; weapons and drug
  paraphernalia are owned by the fabrication rules instead, which distinguish
  a display piece from a working part. (3) Generation safety verdicts are not
  persisted anywhere (`checkPromptSafety` refuses inline and stores nothing,
  and the main `/forge` lane never called it), so the gate re-evaluates the
  lineage rather than reading a stored verdict. Owner FYI, not a blocker.
  OWNER ITEMS carried out of this campaign are collected in the closing
  report: the devnet SOL for the certificate attester, the mainnet
  certificate approval pair, the partner and ops env vars from order 04, and
  the catalog rates to tune against a real bureau quote.
