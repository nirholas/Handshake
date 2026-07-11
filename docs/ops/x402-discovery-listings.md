# x402 discovery listings — getting three.ws indexed and ranked

Runbook for getting every paid three.ws endpoint listed — and ranked — on the
x402 discovery surfaces that agents actually search. Research snapshot:
**2026-07-11**. This directory (`docs/ops/`) is excluded from the public docs
build by the `PRIVATE_DOCS` filter in `vite.config.js`, so registration
mechanics and outreach notes can live here verbatim.

**The one-line conclusion:** quality metadata gets you *found*; settled
transaction count + distinct buyers in the trailing 30 days gets you *ranked*.
Every surface below ultimately keys off one of those two levers. No surface
sells ranking.

## Where our side of this lives

| Piece | Location |
|---|---|
| Single source of truth for paid services (descriptions, prices, tags, schemas) | `api/_lib/service-catalog/` — drift into the discovery doc is a red build via `tests/service-catalog.test.js` |
| Public discovery doc | `/.well-known/x402.json` → `/api/wk?name=x402-discovery` (route in `vercel.json`) |
| Canonical catalog of every paid endpoint (request contracts + prices) | `api/_lib/x402/ring-catalog.js` |
| Facilitator endpoints we query/settle through | `api/_lib/x402/bazaar-client.js` — PayAI (Base default), CDP (`api.cdp.coinbase.com/platform/v2/x402`), self-facilitator for Solana (`api/_lib/x402/self-facilitator.js`) |
| Per-agent A2A agent cards | `/a/sol/:id/.well-known/agent-card.json` |
| Env-overridable prices | `api/_lib/x402-prices.js` (`X402_PRICE_<SLUG>`) |

## 1. x402scan (x402scan.com) — Merit Systems

The de-facto x402 block explorer: transactions, sellers, origins, resources,
per-facilitator volume. Open source: <https://github.com/Merit-Systems/x402scan>.

Three ingestion paths:

1. **Facilitator/Bazaar crawl** — consumes the resource lists of known
   facilitators (including the CDP Bazaar `/discovery/resources` catalog).
   Facilitators are hand-maintained in `facilitators/config.ts` in their repo;
   a PR there is how a new facilitator gets tracked.
2. **On-chain settlement tracking** — seller/volume stats accrue from observed
   USDC settlements attributed to facilitator contracts on Base and Solana.
   Not submitted; earned by real paid traffic.
3. **Manual resource registration** —
   <https://www.x402scan.com/resources/register>: submit the endpoint URL;
   x402scan probes it and auto-adds it if it returns a valid x402 schema.
   The flow uses a one-time SIWX wallet signature (no funds move). Base +
   Solana only.

**Ranking:** activity-driven — tx count, volume, recency per origin/seller.
No pay-to-rank. It renders our `accepts[].description`, price, and origin
metadata (og-tags, favicon) on the resource page, so those must be clean.

**Steps for three.ws:**
- Every paid endpoint returns a spec-valid 402 `accepts` payload with a real
  description (the service catalog guarantees this — don't hand-edit).
- Submit each top-level resource at `/resources/register` (wallet signature,
  no account).
- Route settlements through the CDP facilitator so both the Bazaar crawl and
  on-chain volume attribute to us.

**Burden:** wallet signature only; crawlable otherwise.

## 2. x402 Bazaar / CDP facilitator discovery list

Docs: <https://docs.cdp.coinbase.com/x402/bazaar> · spec:
<https://docs.x402.org/extensions/bazaar> ·
<https://x402.gitbook.io/x402/core-concepts/bazaar-discovery-layer>

**Mechanism (exact, mid-2026):**

- **No registration form.** Indexing is settlement-triggered: the CDP
  facilitator catalogs a service the first time it *settles* a payment for
  that endpoint. Verify alone is NOT enough, and `paymentPayload.resource`
  must identify the endpoint.
- On the resource server: register `bazaarResourceServerExtension` and attach
  `declareDiscoveryExtension()` per route (successor of the older
  `discoverable: true` middleware flag) with:
  - `description` — < 500 chars, natural language; this is what semantic
    search embeds,
  - `input` + `inputSchema` (JSON Schema — the example input must validate
    against the schema or the extension is rejected),
  - `output.example` + output schema,
  - `bodyType: "json"` for POST routes; for MCP tools: `toolName`,
    `transport`, MCP-format `inputSchema`.
- Acceptance is signalled via the base64 `EXTENSION-RESPONSES` header on
  verify/settle responses (success/processing/rejected). **Caveat:** open bug
  <https://github.com/x402-foundation/x402/issues/2112> — the CDP facilitator
  sometimes never emits this header and services silently fail to index.
  Verify presence via the discovery endpoints, never the header alone.
- Query surface (both public, no API key):
  - `GET https://api.cdp.coinbase.com/platform/v2/x402/discovery/resources`
    (paginated catalog, limit ≤ 1000)
  - `GET .../v2/x402/discovery/search` (hybrid full-text + semantic,
    quality-ranked, limit ≤ 20)

**Ranking factors (documented):** relevance blended with quality = distinct
buyers in 30 days, successful tx volume in 30 days, recency, metadata
completeness. Recomputed every 6 hours. **30-day inactivity drops you from
search results** (new zero-call resources stay visible in the catalog).

**Route-consolidation gotcha:** high-cardinality path segments (UUIDs,
addresses) get collapsed into one entry — prefix them (`/user-<uuid>`) if
distinct listings matter.

**Burden:** purely technical — needs at least one CDP-facilitator settlement
on Base per endpoint; no human form.

## 3. agentic.market

Launch post:
<https://www.coinbase.com/developer-platform/discover/launches/agentic-market>
· <https://agentic.market/about>

Coinbase's consumer-facing directory over the Bazaar — ~1,700+ services across
Inference/Data/Media/Search/Social/Infrastructure/Trading, with live pricing,
call counts, unique payers, last-active timestamps. Machine-readable:
`GET https://agentic.market/v1/services`,
`GET https://agentic.market/v1/services/search?q=`, and
`https://agentic.market/llms.txt`.

**How to list: there is no submission form.** It self-learns from live x402
payments (fed by the CDP Bazaar/settlement data). Getting listed = getting
Bazaar-indexed (section 2). The ~70-service "curated" tier is editorially
selected — the lever there is volume, quality metadata, and outreach to the
CDP/x402 team. Not ERC-8004-based. Burden: none beyond section 2.

## 4. Other directories / aggregators (mid-2026)

| Surface | How listing works | Burden |
|---|---|---|
| **x402.org Ecosystem** (<https://www.x402.org/ecosystem>) | PR to the x402 repo — partner metadata in `typescript/site/app/ecosystem/` (logo + description JSON). <https://github.com/coinbase/x402> / <https://github.com/x402-foundation/x402> | GitHub PR, human review |
| **x402 List** (<https://x402-list.com>) | Form at `/submit`; endpoint auto-probed for a valid 402 handshake, then human-reviewed. Updates via one-time domain proof at `/services/{slug}/update`. Runs 5–15 min uptime monitoring + "verified" badges. JSON API `/api/v1/services`, `/llms-full.txt`, MCP server | Form, no account; first submit free, later submits x402-paid |
| **402 Index** (<https://402index.io>, docs `/api-docs`) | Pure API: `POST /api/v1/register` — no auth, no signature, no fee; URL probed for L402/x402/MPP compliance, reviewed before appearing; 10 registrations/hr/IP | Purely technical |
| **awesome-x402 lists** | PRs to <https://github.com/xpaysh/awesome-x402> and <https://github.com/Merit-Systems/awesome-x402> (also Merit's awesome-agentic-commerce) | GitHub PR |
| **B402 Bazaar (Binance)** | BNB-chain Bazaar clone: <https://developers.binance.com/docs/onchainpay-x402/b402-bazaar> — same extension-declaration + settle-through-their-facilitator model | Technical; requires their facilitator |
| **Nevermined** (<https://nevermined.ai/facilitator/>) | A facilitator, not a directory — integrating it buys metering/fiat-card (AP2) rails, not Bazaar ranking | Account/integration |
| **Fewsats** (<https://github.com/fewsats>) | Payments infra/SDKs (L402/x402 lineage); no public open directory as of now | n/a |
| **PayAI** (<https://docs.payai.network/x402/reference>) | Facilitator + agent marketplace on Solana; listing = using their facilitator/marketplace flow. Already our default Base facilitator in `bazaar-client.js` | Account/integration |
| **Google AP2 / a2a-x402** (<https://github.com/google-agentic-commerce/a2a-x402>, <https://ap2-protocol.org/>) | No central registry — discovery is your A2A agent card at `/.well-known/agent-card.json` declaring the AP2/x402 extension URI under `capabilities.extensions`. Google AI Agent Marketplace featuring is partnership/BD, not crawl | Technical (agent card) + BD |
| **x402 Daily** (<https://x402daily.xyz/resources/ecosystem/>), whatisx402.com, agentpaymentsstack.com | Editorial/aggregator sites; outreach or PR-based | Human |
| **ERC-8004** | Used by OKX-style identity registries, not by x402scan/Bazaar/agentic.market. Separate lever (we already ship `agent_reputation` tooling) | On-chain tx |

## 5. Spec-level discovery metadata (what crawlers read)

- **v2 spec**
  (<https://github.com/coinbase/x402/blob/main/specs/x402-specification-v2.md>):
  core `accepts[]` PaymentRequirements = `scheme`, `network` (CAIP-2),
  `amount`, `asset`, `payTo`, `maxTimeoutSeconds`, `extra`; discovery data
  rides in the `extensions` map, not core fields. v1-style fields crawlers
  still read off the 402 body: `resource`, `description`, `mimeType`,
  `outputSchema`.
- **Bazaar extension** (`"bazaar"` key in `extensions`): `description`,
  `input`, `inputSchema`, `output` (example + schema), `bodyType`, and for MCP
  `toolName`/`transport`. The description drives semantic-search ranking; the
  example input must pass JSON-Schema validation or indexing is rejected.
- **/.well-known conventions:** there is no ratified `.well-known/x402` in the
  core spec — the v2 Discovery extension (facilitator-crawled metadata) is the
  official direction (<https://www.x402.org/writing/x402-v2-launch>). In the
  wild, an informal `/.well-known/x402.json` manifest is served by several
  ecosystems and read by independent crawlers, and some toolkits (autonomagic,
  PipRail's `buildOpenApi()`) emit it alongside `/openapi.json` and an agent
  card. Cheap to serve — we publish all three: `/.well-known/x402.json`,
  `/openapi.json`, `/.well-known/agent-card.json`.

## Priority action list

1. **Bazaar first** (feeds agentic.market + partially x402scan): declare
   `declareDiscoveryExtension()` metadata on every paid route, settle ≥ 1
   payment per route via the CDP facilitator, then verify presence via
   `GET .../v2/x402/discovery/resources` — don't trust `EXTENSION-RESPONSES`
   (issue #2112). Keep each endpoint active inside every 30-day window;
   ranking recomputes 6-hourly on 30-day buyers + volume. The ring economy
   (`api/_lib/x402/ring-catalog.js` rotation) is the natural way to keep every
   endpoint inside the activity window.
2. **x402scan:** register every resource at
   `x402scan.com/resources/register` (SIWX signature). Solana endpoints
   qualify too.
3. **Fire-and-forget API registrations:**
   `POST 402index.io/api/v1/register` + `x402-list.com/submit`.
4. **PR-based:** x402.org/ecosystem partner-metadata PR, both awesome-x402
   lists.
5. **Serve discovery manifests:** `/.well-known/x402.json`, `/openapi.json`,
   A2A agent card with the x402 extension — all generated from the service
   catalog, never hand-maintained.

## Sources

CDP Bazaar docs · Bazaar extension spec · x402 v2 spec · x402 v2 launch post ·
x402scan + its GitHub + register page · agentic.market /about + launch post ·
PipRail discovery guide (<https://piprail.com/discovery/>) · 402 Index API
docs · x402-list.com · x402.org/ecosystem · awesome-x402 (xpaysh + Merit) ·
a2a-x402 · AP2 · B402 Bazaar · Nevermined facilitator · PayAI x402 reference ·
Bazaar indexing bug #2112.
