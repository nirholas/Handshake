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
   a PR there is how a new facilitator gets tracked. **This path is paused
   upstream** and has been since before our facilitator merged:
   `FACILITATOR_SYNC_PAUSED = true` returns early in
   `apps/scan/src/app/api/resources/sync/route.ts`, re-checked 2026-09-02. Being
   a registered facilitator therefore buys settlement attribution (path 2), not
   catalog ingestion. Our endpoints get listed through path 3, which reads
   `/openapi.json`.
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
  no account). What their flow actually reads is `/openapi.json`, so an
  endpoint absent from that document cannot be registered no matter how valid
  its live 402 is. Since 2026-09-02 every paid service in
  `api/_lib/service-catalog/` is projected into it automatically
  (`catalogPaidPaths()` in `api/openapi-json.js`), guarded by
  `tests/openapi-aggregator.test.js`.
- Solana volume needs no third party: since PR #1032 merged, x402scan
  attributes our own facilitator's settlements to us directly (section 7).
  Routing through the CDP facilitator is the separate, additive Base leg that
  section 2 covers, and it must never replace the self-hosted Solana rail.

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
  example input must pass JSON-Schema validation or indexing is rejected. The
  example is also what a buyer replays after settling, so it has to resolve:
  the `/api/mcp` sample body (`bazaarExtension()` in `api/_lib/x402-spec.js`)
  points `validate_model` at `https://three.ws/avatars/cesium-man.glb`, the
  same GLB the agent card advertises, not an example.com placeholder.
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

## 6. The datapoint fabric: seeding settlements on ~4.4k granular URLs

Most of our payable surface is not the 84 named endpoints in `ring-catalog.js`. It
is the **datapoint fabric**: one route (`api/x402/d/[...path].js`) that fans out a
per-metric paid URL for every entity in every family defined in
`api/_lib/market-data/datapoints.js`, at $0.0005 a call. `/.well-known/x402.json`
advertises 4,419 of them.

URL shapes (note metric slugs are **hyphenated**; a wrong slug 404s instead of 402ing):

```
/api/x402/d/coin/bitcoin/market-cap     entity families: /d/<family>/<id>/<metric>
/api/x402/d/gas/standard                singleton families (gas, global, fear-greed):
/api/x402/d/global/btc-dominance                         /d/<family>/<metric>
```

Until 2026-07-13 not one of these had ever been paid: the coverage sweep only walks
`RING_CATALOG`, so to an indexer the fabric looked like a large static list with zero
settlement history. `scripts/x402-seed-datapoints.mjs` closes that gap.

```bash
node scripts/x402-seed-datapoints.mjs --dry-run            # plan, no spend
node scripts/x402-seed-datapoints.mjs --max-usd=0.15       # real settlements, capped
node scripts/x402-seed-datapoints.mjs --only=coin,protocol --per-family=25
```

It pulls its seed list **live from the discovery doc**, so there is no hand-maintained
URL list to drift, buckets by family, and settles core metrics (price, tvl, supply,
volume) first so a bounded budget proves the whole surface is live. The family reads
behind those URLs retry once and keep an hour-long last-known-good copy, so a
DeFiLlama or CoinGecko blip serves a slightly older row instead of a 503 on a paid
call; a datapoint served that way stamps `as_of` with the time the data was actually
fetched upstream and adds `stale: true` plus `age_seconds`, so a buyer is never sold
an hour-old number as a live one. Payments are
circular: the payer wallet pays our own treasury, so the USDC round-trips and only the
Solana network fee (~$0.000005/tx) is actually burned. An `onAccept` gate refuses any
payment whose `payTo` is not our configured treasury, so a compromised or mis-set
challenge cannot redirect funds. Report lands in
`tasks/x402-ring/datapoint-seed-report.json`.

**Seeding this surface is what exposed the per-IP throttle on paying clients** (fixed
2026-07-13): the verify budget metered every payment *attempt* at 20/min, so a buyer
pulling 50 metrics got 429s despite paying for each one. It is now failure-weighted, a
settled payment costs 1 token against 300/min and a failed verify costs 15. Tune with
`X402_VERIFY_IP_PER_MIN`, `X402_PROBE_IP_PER_MIN`, `X402_VERIFY_FAIL_PENALTY`.

**Caveat, and it is the important one:** this seeds **Solana** settlements through our
own self-facilitator. **Bazaar only counts payments settled through the CDP facilitator
on Base** (see section 2), so Solana seeding alone will *not* get the fabric into
Bazaar or agentic.market. The datapoints do advertise a Base accept (`eip155:8453`),
but prod has no `X402_BUYER_PRIVATE_KEY`, so there is currently no Base wallet to pay
*from*. Seeding the Bazaar leg needs a funded Base buyer (USDC + a little ETH for gas).

## 7. Getting our Solana volume counted on x402scan (facilitator indexing)

x402scan's per-server transaction and volume numbers are NOT crawled from chain
generically: its sync service only attributes transactions to the facilitator
fee-payer addresses hardcoded in the open-source registry
(`packages/external/facilitators/src/facilitators/*.ts` in
[Merit-Systems/x402scan](https://github.com/Merit-Systems/x402scan)). Our
self-hosted facilitator is not in that registry, so none of our Solana
settlements count, no matter how many settle. Resource registration (above)
only gets endpoints *listed*; it does not feed the counters.

The path to being counted, all Solana, no Base required:

1. **One attributable fee payer.** Run the ring in sponsor mode
   (`X402_RING_SELF_PAY=false` on the Cloud Run service) so one facilitator
   sponsor address co-signs and pays the fee on every settle (2 signatures,
   ~10k lamports each). In self-pay mode every buyer is its own fee payer and
   there is nothing stable to index. Flipped live 2026-07-16 (revision 00143);
   402 challenges advertise the sponsor in `accepts[].extra.feePayer`.
   Owner picked the economy master `WwwuGbqHrwF5RG89KhUbmRWEvjnRH9k5kVM5p7T3WwW`
   as the sponsor (rev 00149, secret version 2 of
   `x402-fee-payer-secret-base58`); the original sponsor
   `GGf9qBhJDCe1UUz4s4Vxq1uPPvcv7UW7sJTuj2Yo5XQj` carried ~4,100 settlements
   2026-07-09 to 2026-07-16 (last on-chain activity 2026-07-15) and is listed
   as a second address in the PR, WITHOUT the `deprecated` flag: x402scan's
   transfer sync maps `deprecated` to `enabled: false`
   (`sync/transfers/trigger/lib/facilitators.ts`) and skips the address
   entirely, so flagging it would drop that history instead of preserving it.
   Sponsor SOL floor 0.03 (treasury-topup cron).
2. **PR the facilitator into x402scan.** Add
   `packages/external/facilitators/src/facilitators/threews.ts` (config url
   `https://three.ws/api/x402-facilitator`, both sponsor addresses above,
   USDC), export it from `facilitators/index.ts`, register it in
   `lists/all.ts`, and add a 180x180 logo at `apps/scan/public/three-ws.png`.
   A facilitator that also sets `discoveryConfig` must re-export its
   `<name>Discovery` const from `src/discovery/index.ts`, or the package's
   `knip` check fails the PR on an unused export. Once merged, their sync
   backfills from `dateOfFirstTransaction`.
   Status: <https://github.com/Merit-Systems/x402scan/pull/1032>, **merged
   2026-08-11**, with no review requested and no verification comment needed.
   Live since: <https://www.x402scan.com/facilitator/three-ws> renders both
   addresses and, measured 2026-09-02, attributes 18,636 transactions and
   $1,055.01 of USDC volume to `three-ws`, current to the same day. Their
   transfer sync is doing exactly what step 1 set it up to do.
3. **Keep the ring settling.** The ring payer (`x402-ring-payer`,
   `X4o2UuVNMxnrgkzVy97kPF5gmS6CLRCVJGB48VastML`) spends USDC into the treasury,
   the treasury sweeps to the economy master, and the payer is refilled by the
   economy-rebalance cron swapping a slice of its own SOL to USDC ($3/swap,
   30-min cadence, $10 USDC floor, 0.03 SOL reserve). The cron must be armed
   with `ECONOMY_REBALANCE_ENABLED=1` (owner spend approval) or the payer
   drains and the whole ring halts with `insufficient_payer_usdc`, which is
   exactly what happened 2026-07-15.
4. **Accept what the standard client builds.** The reference x402 SVM client
   (`@x402/svm`, which our own payload builder delegates to) attaches an SPL
   Memo instruction to every `exact` payment, so the self-facilitator's
   anti-drain gate skips both live Memo program ids as carrying no fund
   movement instead of rejecting the transaction. Without that, no
   third-party buyer using the stock client could settle here, and none of
   their volume would exist to be counted.

## Registration log

**2026-09-02: re-verification after the facilitator merge (measured, no
credentials used).** PR #1032 merged 2026-08-11 with zero reviews, so the
reviewer-verification comment that blocked this for six weeks was never needed.
Everything the PR declares resolves live: `/api/x402-facilitator/supported`
200, the logo at `x402scan.com/three-ws.png` 200, and `docsUrl`
`three.ws/docs/x402-distribution` 200. Their facilitator page renders both fee
payers and attributes 18,636 transactions / $1,055.01 USDC to `three-ws`, and
our origin page carries 60 active resources, none deprecated, last re-crawled
by them on 2026-08-27 (so they do re-probe on their own, contrary to the
2026-07-12 note above).

Replayed their exact crawler against production
(`listAllFacilitatorResources`, limit 100, page until
`total <= offset + limit`): 46 pages, 4,519 items fetched for a `total` that
stayed 4,519 for the whole sweep, 4,519 unique identities, zero duplicates.
The 2026-08-02 paging fix holds under a real crawl.

The gap the re-verify found was on our side and is now closed: `/openapi.json`
hand-enumerated 24 of the 75 live paid services, and their registration flow
reads that document, which is why the origin has sat at 60 resources. 52 paid
endpoints answered a spec-valid 402 in production while being invisible to it.
`catalogPaidPaths()` now projects all of them from the service catalog.

Five endpoints answer 503 `settlement_unavailable` rather than a 402 while the
sponsor wallet is under its SOL settle floor (`dance-tip`, `feed-health`,
`ring-settle`, `spend-session`, `three-buy`). That is correct behavior, not a
bug: they are Solana-only, so the floor removes their only rail while every
Base-carrying endpoint keeps its 402. They cannot be probe-registered until the
sponsor is refunded.

Base leg, measured the same day: three.ws appears in 0 of the CDP Bazaar's
15,127 catalog resources (paged the whole catalog). Expected, per section 2:
indexing is triggered by a settle through the CDP facilitator on Base and
production has no `X402_BUYER_PRIVATE_KEY` to pay from. Solana settlement is
unchanged and still self-hosted.


**2026-07-11 — x402scan registration (owner, SIWX signature): 23/23 resources
registered** for origin three.ws; 2 stale resources auto-deprecated. The
probe surfaced two classes of issue, fixed in code on 2026-07-12:

- **Oversized `PAYMENT-REQUIRED` headers** (agent-reputation, pump-launch,
  vanity — >16 KB with signed offers + bazaar schemas mirrored into the
  header; the production LB dropped the header outright).
  `paymentRequiredHeaderValue()` in `api/_lib/x402-spec.js` now caps the
  mirror at 8 KB: full envelope when it fits, extensions-free slim envelope
  when it doesn't, no header when even that overflows. The JSON body always
  carries the complete envelope. This also clears the "no auth mode"
  warnings on the same three resources — that was a side-effect of
  x402scan's header-overflow fallback probe, which skips the OpenAPI merge.
- **`/api/mcp` WWW-Authenticate warning**: x402scan audits any
  WWW-Authenticate on a 402 as an MPP header and flags the missing
  `Payment` challenge. We speak x402, not MPP/Tempo, so the 402 branch of
  `api/_mcp/auth.js sendAuthChallenge()` no longer sends WWW-Authenticate
  (the 401 OAuth branch keeps it). A spec-compliant MCP client (one sending
  `Accept: application/json, text/event-stream`) still reads as an OAuth
  protocol client and gets that 401 by default; a surface whose buyers key
  strictly on 402 (the OKX 3D tools under `api/okx/3d/`) passes
  `paymentStatus: 402` to force the Payment Required answer for every caller.
  Prepended rails are deduped against the shared builder's accepts so a
  listing never advertises the same rail twice, and `DELETE /api/mcp` with an
  `Mcp-Session-Id` this stateless server never issued answers `404
  unknown_session` (the transport's "start a fresh session" signal) rather
  than a 204 for a session it never held.
- **Skipped "unprotected" endpoints**: the 29 free-tier `/api/v1/x/*`
  aggregator endpoints now declare `security: []` with no `x-payment-info`
  in `/openapi.json` (the auditor classifies x-payment-info as paid and then
  demands a 402 the free lane can't give) — they register as public
  endpoints on the next probe. `skill-call`, `asset-download` (bare probes
  hit input validation before the paywall) and `fact-check` (claim-less
  probe body) now answer credential-less probes with a valid 402 challenge;
  paying callers with bad input still get the strict 400/404. Wrong-method
  credential-less probes get the challenge too (`x402-paid-endpoint.js`
  method gate).
- **CDP credentials: RESOLVED 2026-07-12.** Owner created a CDP secret key
  (Ed25519, no retail scopes, no IP allowlist — Cloud Run egress is dynamic)
  and it now lives on the Cloud Run service (`CDP_API_KEY_ID` /
  `CDP_API_KEY_SECRET`, set via `--update-env-vars`; never `--set-env-vars`,
  which wipes the other ~89 vars). Verified live: `permit2-paid-demo`
  advertises a real Permit2 accept, and every paid endpoint now carries Base
  EIP-3009 + Base permit2 accepts alongside Solana. This unblocks Bazaar
  indexing (section 2) — the remaining step there is one CDP-facilitator
  settle per endpoint, which needs Base USDC in a payer wallet.

All of the above was verified live on production on 2026-07-12 (vanity's
header went 16 KB+ → 4.4 KB; the four probe-failing endpoints all answer
bare probes with a valid 402). After any future challenge-shape change,
re-run the x402scan probe (Add API on <https://www.x402scan.com> for the
three.ws origin) — it does not re-crawl on its own.

## Sources

CDP Bazaar docs · Bazaar extension spec · x402 v2 spec · x402 v2 launch post ·
x402scan + its GitHub + register page · agentic.market /about + launch post ·
PipRail discovery guide (<https://piprail.com/discovery/>) · 402 Index API
docs · x402-list.com · x402.org/ecosystem · awesome-x402 (xpaysh + Merit) ·
a2a-x402 · AP2 · B402 Bazaar · Nevermined facilitator · PayAI x402 reference ·
Bazaar indexing bug #2112.
