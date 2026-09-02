# Work order 02: catalog, quotes, orders, and money (human + agent)

**How to run:** paste this whole file into a fresh Claude Code chat in this
repo, or name its path. Read `prompts/finish/materialize-00-CONTEXT.md` first; its
decisions bind this order.

**Binding operating clause:** finish 100%. Never end with a question or an
unexecuted plan. CLAUDE.md hard rules apply: no mocks, no fake data, no
unfinished markers, no em-dash, explicit-path commits. Two CLAUDE.md gates
can appear in this order and only these: an irreversible on-chain send
(none is required here; settle verification is read-only) and production
deploys (owner-gated). Everything else, do.

## Why this order exists

This is where Materialize becomes commerce: a real catalog, a quote a buyer
can trust, an order row with a state machine that cannot lie, and two
checkout lanes. The second lane is the historic one: `POST
/api/x402/print-order` is, to our knowledge, the first API where an AI
agent pays to manufacture a physical object. Build it with the same care
the market-data x402 endpoints got.

## Step 0: re-derive current state

```
ls api/print/ data/print-catalog.json 2>/dev/null
ls api/_lib/migrations/ | tail -15
grep -rn "print" api/_lib/feed.js | head
ls api/x402/ | grep -i print
npm test -- tests/api/print 2>/dev/null | tail -5
```

Order 01 must have landed `/api/print/analyze` and `/api/print/prepare`
(check, do not assume). Read before writing: one full x402 endpoint with
dynamic pricing (`api/x402/forge.js` and one `api/x402/market-*.js`), the
marketplace confirmed-purchase path (how `status='confirmed'` is written
and why trials poisoned analytics, per STRUCTURE.md's marketplace row), and
`api/_lib/forge-tiers.js` for the $THREE holder check.

## Tasks

### 1. Catalog (`data/print-catalog.json` + `GET /api/print/catalog`)

Build the catalog per 00-CONTEXT's pricing model. Research current
published market rates from real print services at execution time and cite
sources + retrieval date in the file's `_sources` field. Every material
carries: id, display name, class (resin, sls_nylon, full_color, fdm_draft,
metal_quote_only), density g/cm3, rate per cm3, setup fee, min wall mm,
min/max height mm, finish options with fees, lead-time days, margin
fraction. Shipping zones: CN-domestic, US, EU, ROW with per-kg volumetric
rates. The handler serves the catalog minus `_sources` and margin fields
(public output is buyer-facing).

### 2. Quote engine (`api/_lib/print/quote.js`, pure + tested)

Input: printability report + material id + target height + quantity +
destination country. Output: itemized lines (setup, material with the cm3
it was computed from, finish, quantity break, $THREE holder discount when
the session or payer wallet qualifies, shipping, total USDC), lead-time
estimate, and a rejection with a named reason when the mesh violates the
material's constraints (too thin walls for resin, too large for the bed).
`POST /api/print/quote` wraps it and returns the itemization plus an
HMAC-signed quote token (same signing helper the forge job tokens use)
with a 24h expiry embedding every priced parameter, so checkout can never
be replayed at a stale price or altered client-side.

### 3. Schema + store (`api/_lib/print-store.js` + one migration)

Create `print_orders`, `print_order_events`, `print_certificates` exactly
per 00-CONTEXT. The store module owns the transition whitelist; write the
state machine as data (a map of legal from/to pairs) with one `transition()`
function that inserts the event row and publishes the `print` user
notification in the same transaction. Extend `USER_EVENT_TYPES` in
`api/_lib/feed.js` with `print`, wiring the bell copy the way `market`
events did. Run `npm run db:status` before and after; `npm run db:migrate`
applies immediately, so read what is pending first.

### 4. Human checkout (`POST /api/print/orders`)

Session + CSRF, mirroring an existing session-gated POST (the follow
endpoint is the reference shape). Body: quote token + shipping fields
(minimum PII per 00-CONTEXT). Flow: verify token, create `created` row,
transition to `quoted`, take USDC on Solana through the platform's
existing self-hosted settle rail (reuse the exact verification path the
x402 lane uses; payment lands, transition to `paid`, then `screening`).
`GET /api/print/orders/:id` returns the order + full event timeline to its
owner. Payment verification is read-only chain work; no gate applies.

### 5. Agent checkout (`POST /api/x402/print-order`)

Dynamic-price 402 quoting the signed quote token's total, per-call
settlement like the market-data endpoints. Body: quote token + shipping +
payer wallet. Params rejected pre-settle (422) so a malformed order never
charges. On settle: same store path as the human lane (user_id null,
payer wallet recorded). Register it wherever x402 endpoints are cataloged
(re-derive: grep how `market-pulse` reaches the service catalog and the
discovery docs, and follow the same wiring).

### 6. Tests

Quote engine: itemization math from a fixture report, holder discount,
quantity breaks, every constraint rejection, token expiry and tamper
rejection. Store: every legal transition, every illegal transition throws,
event rows land, notification published once. Handlers: auth, CSRF,
pre-settle 422, and that a stale or altered quote token is refused. Follow
`tests/api/` conventions; the marketplace analytics test shows how to
fixture Postgres-backed stores here.

## Definition of done

- [ ] `npm test` green including new print quote/store/handler tests.
- [ ] `npm run db:status` shows the migration applied; the three tables exist.
- [ ] Dev-server flow proven end to end and pasted in the report: analyze a real creation, quote it, create an order with a real session, watch it reach `screening`, `GET` shows the timeline.
- [ ] `POST /api/x402/print-order` returns a correct 402 challenge with the quote's exact amount for an unpaid call.
- [ ] Quote totals rendered anywhere come only from the engine (grep proves no price math in `src/`).
- [ ] `npm run check:rules -- --paths <files you touched>` passes.
- [ ] Committed with explicit paths; this file deleted in the closing commit; PROGRESS.md appended.

## Never blocked

| Blocker | Resolution |
|---|---|
| How settle verification works | Read `api/x402/README.md` and one settled endpoint end to end. The rail is self-hosted Solana; everything needed is in-repo and in `.env`. |
| Holder-check mechanics | `api/_lib/forge-tiers.js` already gates the forge High tier on $THREE holdings. Reuse its helper. |
| A QA session for the dev-server flow | `AUDIT_EMAIL` / `AUDIT_PASSWORD` in `.env` are a real QA account. |
| Real market pricing research | Public price pages of major print bureaus are indexable; capture numbers + dates in `_sources`. If a datum is unverifiable, price conservatively high and mark the field `estimate: true`. Owner tunes one file later. |
| Migration ordering fear | `npm run db:status` first, always. It previews every pending migration; yours must be the only surprise. |
| USDC-only feels narrow | Decided in 00-CONTEXT: Solana first, no card processor without owner approval. State it in UI copy, never apologize for it. |

## Report format

Files + tests + the pasted end-to-end dev flow transcript, the catalog's
source citations, any 00-CONTEXT deviation (one line + why), and the single
next action for orders 03/04/05.
