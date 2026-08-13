# Materialize: shared facts and binding decisions

Every work order in this pack starts by reading this file. It carries the
decisions so the work orders can carry the work. If reality on disk
disagrees with a claim here, reality wins; measure first (each order's
step 0), then update this file in the same commit as the fix.

## What Materialize is

The physical lane of the forge. A user (or a paying AI agent) takes any
finished 3D generation and orders a high-precision physical print of it.
The platform analyzes the mesh for printability, repairs it, previews it at
true scale in AR, quotes a real price, takes payment in USDC on Solana,
routes the job to a fulfillment provider, attests the print on-chain, and
tracks it to delivery.

Origin: an inbound partnership offer (2026-08-13) from a Chinese
high-precision print operator. The partner is unverified and uncontracted.
**Nothing in this campaign blocks on the partner.** The adapter layer plus a
manual-fulfillment lane (a real operator console driving any print bureau
by hand) launches the product; a contracted partner API slots in later as
one more adapter. Signing any partner is an owner action, never an agent
action.

## Naming and routes (decided, do not re-litigate)

- Surface name: **Materialize**. Route: `/materialize`. Page:
  `pages/materialize.html`, app `src/materialize.js`.
- API prefix: `/api/print/*` (handlers in `api/print/`). "print" is the
  honest verb for the API; "Materialize" is the product name for humans.
- Agent lane: `POST /api/x402/print-order` (file `api/x402/print-order.js`).
- Certificate page: `/p/:certId` (physical provenance permalink).
- Order tracking: `/materialize/orders/:id` for humans;
  `GET /api/print/orders/:id` for machines.

## Architecture

```
/m/:id "Materialize" button   /materialize page   forge result bar   x402 agent
            │                        │                   │               │
            └────────────┬──────────┴───────────────────┴───────────────┘
                         ▼
   POST /api/print/analyze      free, keyless: printability report + score
   POST /api/print/prepare      repair + scale + export STL/3MF/GLB to R2
   GET  /api/print/catalog      materials, size presets, price parameters
   POST /api/print/quote        itemized, HMAC-signed, expiring quote
   POST /api/print/orders       session checkout (Solana USDC)
   POST /api/x402/print-order   agent checkout (x402 settle, same pipeline)
                         │
                         ▼
   print_orders row + state machine ── operator console (api/print/ops/*)
                         │                     │
                         ▼                     ▼
   fulfillment adapter (manual | partner API) ── status webhooks back in
                         │
                         ▼
   on-chain certificate (Solana memo attest) + QR ──► /p/:certId
```

Same design properties as the forge: one orchestrator per concern, adapters
declared as data, failure is a routing event. Read
`docs/forge-pipeline.md` before touching anything; Materialize reuses the
forge's job-token (HMAC), R2 mirroring, and store patterns wholesale.

## OSS decisions (search order honored: existing deps, then npm)

| Need | Use | Status |
|---|---|---|
| Mesh booleans, manifold repair, hollow/offset, volume | `manifold-3d` (Apache-2.0, WASM, the Manifold kernel) | add dependency |
| Decimate, weld, dedup, texture read | `@gltf-transform/{core,extensions,functions}` | already a dep |
| STL export | `three/examples/jsm/exporters/STLExporter` | already a dep (`three`) |
| 3MF writer (zip of XML, OPC layout) | small in-repo writer over `fflate` | `fflate` ships inside three's examples deps; verify with `npm ls fflate`, pin directly if absent |
| Wall-thickness sampling (inward ray casts) | `three-mesh-bvh` | verify with `npm ls three-mesh-bvh`; add if absent |
| QR codes for certificates | `qrcode` | verify; add if absent |

Rules: pin semver ranges (`^x.y.0`). No native-binary deps in `api/`
handlers (Cloud Run image is node-only for the API container); manifold-3d
is WASM, which is why it was chosen over CGAL bindings. If a prepare job
exceeds the request budget on 200k-triangle meshes, promote the prepare
step to a `workers/print-prepare/` Cloud Run worker following any existing
worker's layout; do not silently cap quality instead.

## Database (Neon Postgres, migrations in api/_lib/migrations/)

Tables (one migration per work order that introduces them):

- `print_orders`: id, user_id (nullable only for x402 agent orders, which
  carry a payer wallet instead), creation_id (FK forge_creations, nullable
  for direct GLB uploads), source_glb_url, prepared_asset_urls JSONB
  (stl/3mf/glb on R2), analysis JSONB (the printability report at order
  time), material_id, target_height_mm, quantity, quote JSONB (itemized,
  with the signed token), price_usdc NUMERIC, status TEXT, provider TEXT,
  provider_order_id TEXT, shipping JSONB (name, address lines, country,
  phone; nothing else, minimize PII), tracking_number TEXT, timestamps.
- `print_order_events`: order_id, status, note, actor (system | operator |
  provider | buyer), created_at. The timeline is this table, never a
  mutated column.
- `print_certificates`: id, order_id, creation_id, glb_sha256, edition_no,
  edition_of, solana_signature TEXT (null until attested), created_at.

Status machine (enforced in one module, `api/_lib/print-store.js`):
`created → quoted → paid → screening → submitted → printing → quality_check
→ shipped → delivered`, with `rejected` (failed screening, auto-refund
path), `canceled`, and `refunded` as terminal branches. Transitions are
whitelisted pairs; an illegal transition throws. Every transition writes a
`print_order_events` row and publishes a `user_notifications` event via the
existing `publishUserEvent()` vocabulary (extend `USER_EVENT_TYPES` with
one `print` type, mirroring how `market` events landed).

## Money (Solana first, always)

- Human checkout: USDC on Solana through the platform's existing self-hosted
  rail (re-derive the exact flow from `api/x402/` and the marketplace
  purchase path in step 0 of order 02; reuse, never fork, the settle logic).
- Agent checkout: `POST /api/x402/print-order`, priced per quote (dynamic
  402 amount, same pattern as the market-data endpoints with per-call
  pricing). Params rejected pre-settle (422) so a bad request never charges.
- $THREE holders: percentage discount on the print price, applied in the
  quote engine from the existing holder-check used by the forge High tier
  (`api/_lib/forge-tiers.js` knows the pattern). The discount renders in the
  itemized quote, never silently.
- No card processor. Onboarding one is a new external paid API and is
  owner-gated; the quote UI says "USDC on Solana" plainly.
- Refunds are operator actions from the console (order 04), recorded as
  events; no automatic on-chain sends without the CLAUDE.md gate.

## Pricing model (quote engine, order 02)

`data/print-catalog.json` is the single source of truth: materials (resin
standard/tough, SLS nylon, full-color sandstone, PLA draft, metal-tier
entries marked quote-on-request), each with density, per-cm3 rate,
setup fee, min/max bounding box, finish options, and lead-time days.
Quote = setup + rate * material_volume_cm3 * quantity, plus finish fees,
plus zone-based shipping from volumetric weight; quantity breaks at 5/20.
Numbers come from current published market rates of real print services
(researched at execution time, cited in the catalog file header) with a
declared margin field, all owner-tunable in one file. The engine is pure
and unit-tested; the catalog is data.

## The printability report (order 01, the contract everything reads)

One JSON shape produced by `/api/print/analyze` and stored on the order:
manifold (bool), watertight shells count, self_intersections count,
open_edges count, min_wall_mm (sampled), bbox_mm, volume_cm3 (of the
manifold repair, the number money hangs off), triangles, has_textures,
recommended_min_height_mm per material class, and a 0-100 printability
score with named deductions. Spec lands in `specs/PRINT_PIPELINE.md`
(order 06) and the shape never changes without a version field bump.

## Safety (order 06, gate runs before payment, at `screening` again after)

Fabrication gate over prompt lineage + mesh + reference imagery, extending
`api/_mcp-studio/safety.js` patterns: refuse firearm components and
receivers, working weapon parts, keys to real locks, counterfeit branded
goods and logos, and anything the upstream generation gate already refused.
Deny with an actionable message before money moves; a paid order that
fails second screening auto-enters `rejected` with the refund path. The
gate is code plus tests, not a prompt suggestion.

## Provenance (order 05, the phygital moat)

Every shipped print gets a certificate: SHA-256 of the exact prepared
asset, edition number (DB-enforced), and a Solana attestation (memo
transaction from the platform wallet; devnet in tests, mainnet send is
owner-gated per CLAUDE.md gate 1). The package carries a QR to `/p/:certId`
showing the spinning original, the prompt lineage, the edition, and the
on-chain proof. Re-derive what `scripts/tokenize-3d-devnet-e2e.mjs` already
proves before writing any new chain code.

## Launch scope vs later (so nobody boils the ocean)

In scope now: single-object prints, five-ish materials, worldwide shipping
zones (CN/US/EU tiers), human + agent checkout, manual fulfillment lane,
certificates, full docs. Explicitly later (note in reports, do not build):
multi-part assemblies, paint/finishing marketplace, creator royalties on
physical sales, holder gift drops, physical goods marketplace. Later items
get designed-for (schema fields where free) but never half-built.

## Standards that bite in this pack

- CLAUDE.md rules apply in full: no mocks, no fake data, no unfinished
  markers, every state designed, em-dash banned, explicit-path commits.
- The manual fulfillment lane is real operations, not a mock: a human
  operator with a console driving a real bureau is how every print
  marketplace on earth launched. Build it as a first-class adapter.
- PII discipline: shipping addresses are the first real PII this platform
  stores. Minimum fields, never logged, never in analytics events, surfaced
  only to the operator console and the provider adapter.
- Every money number a user sees comes from the quote engine. No price is
  ever computed in a frontend file.
