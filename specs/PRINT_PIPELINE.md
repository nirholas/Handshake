# Materialize print pipeline v1

The wire contracts that turn a three.ws generation into a physical object. Every
shape below is produced or consumed by shipped code, and other code depends on
each one, so this file is a contract rather than a tutorial.

- **Surface:** [Materialize](../docs/materialize.md), routes `/materialize` and `/api/print/*`
- **Companion specs:** [PROVENANCE_3D.md](PROVENANCE_3D.md) (digital provenance), [SERVICE_CATALOG.md](SERVICE_CATALOG.md) (paid endpoint discovery)
- **Implementations:** `api/_lib/print/` (engine, quote, gate, adapters, certificates), `api/_lib/print-store.js` (state machine), `api/print/*` (HTTP)

Six contracts are versioned here. Each one carries its own integer `version` or
`v` field on the wire; a change that removes or repurposes a field is a version
bump, not a tweak.

| Contract | Version field | Owner module |
|---|---|---|
| Printability report | `version: 1` | `api/_lib/print/analyze.js` |
| Quote token | `v: 1` inside the payload | `api/_lib/print/quote.js` |
| Order state machine | statuses are the contract | `api/_lib/print-store.js` |
| Fabrication gate verdict | `version: 1` | `api/_lib/print/gate.js` |
| Adapter interface | method set is the contract | `api/_lib/print/adapters/contract.js` |
| Certificate memo | `v: 1`, `kind: threews.print.v1` | `api/_lib/print/certificate.js` |

---

## 1. Printability report v1

Produced by `POST /api/print/quote` (with no `materialId`, this is the free
analyze call) and frozen onto `print_orders.analysis` when an order is placed.
The frozen copy never changes: a later re-analysis must not alter what was sold.

**Units.** glTF geometry is in meters. Everything the report publishes is in
millimeters (`_mm`), cubic centimeters (`volume_cm3`) or square centimeters
(`surface_area_cm2`), because those are the units a print bureau quotes in.

**Determinism.** The same bytes produce the same report. Every sample is taken
on a fixed stride over the triangle list, never a random draw, and every float
is rounded at a declared precision before it reaches the wire.

### Fields

| Field | Type | Meaning |
|---|---|---|
| `version` | integer | Report schema version. `1`. |
| `manifold` | boolean | The Manifold kernel accepted the mesh as a closed solid. |
| `watertight` | boolean | `manifold` and zero boundary edges. |
| `shells` | integer | Connected components. Each one prints as a separate loose piece. |
| `open_edges` | integer | Edges used by exactly one triangle: hole rims. |
| `non_manifold_edges` | integer | Edges used by three or more triangles. |
| `flipped_edges` | integer | Edges traversed the same way by both faces: one of the pair is wound backwards. |
| `degenerate_triangles` | integer | Zero-area faces dropped before analysis. |
| `self_intersections` | integer | Triangle pairs whose interiors cross. Neighbours (any shared vertex) are excluded. |
| `self_intersections_scan` | `"full"` \| `"sampled"` | Whether every triangle was tested or a fixed stride was. |
| `genus` | integer \| null | Topological genus. Null when the mesh is not a solid. |
| `triangles` | integer | Triangle count after welding and degenerate removal. |
| `vertices` | integer | Vertex count after welding. |
| `source_triangles` | integer | Triangle count as loaded, before welding. |
| `source_vertices` | integer | Vertex count as loaded. |
| `bbox_mm` | object | `{ x, y, z, diagonal }` at the model's own scale. |
| `volume_cm3` | number | Enclosed volume. **This is the number money is computed from.** |
| `volume_source` | `"manifold"` \| `"signed_sum"` | Exact kernel volume, or the divergence-theorem estimate used when the mesh is not a solid. |
| `surface_area_cm2` | number | Total surface area. |
| `min_wall_mm` | number \| null | 5th percentile of the wall-thickness samples. Null when no probe found a back wall. |
| `median_wall_mm` | number \| null | 50th percentile of the same samples. |
| `recommended_min_height_mm` | object \| null | Per material class (`resin`, `sls_nylon`, `full_color`, `fdm_draft`, `metal`), the print height at which `min_wall_mm` clears that process. |
| `has_textures` | boolean | The source carried textures. |
| `color_source` | `"texture"` \| `"material"` \| `"none"` | Where per-vertex color came from, which is what a full-color print reproduces. |
| `materials` | integer \| null | Material count in the source document. |
| `skipped_primitives` | integer | Non-triangle primitives ignored (points, lines, strips). |
| `size_bytes` | integer \| null | Source GLB size. |
| `sampling` | object | What was measured versus estimated. See below. |
| `score` | integer 0-100 | Printability score. |
| `deductions` | array | Named, buyer-readable reasons the score is not 100. |
| `source_url` | string \| null | The mesh the report describes. |

`sampling` carries `weld_tolerance_mm`, `wall_rays_cast`, `wall_rays_hit`,
`wall_percentile`, `self_intersection_triangles_tested` and
`self_intersection_capped`. A consumer that needs to know whether a number was
measured or sampled reads this block rather than guessing.

### Score deductions

Each entry is `{ id, points, detail }`. `detail` is buyer-facing copy and is
rendered verbatim. The score is `100` minus the sum of `points`, floored at `0`.

| `id` | Max points | Fires when |
|---|---|---|
| `non_manifold` | 30 | The kernel refused the mesh as a solid. |
| `open_edges` | 20 | Any boundary edge exists; scaled by the share of the perimeter that is open. |
| `non_manifold_edges` | 12 | Any edge is shared by more than two faces. |
| `self_intersections` | 15 | Any non-neighbouring face pair crosses. |
| `multiple_shells` | 10 | More than one connected body. |
| `degenerate_triangles` | 5 | Zero-area faces were present. |
| `thin_walls` | 18 | `min_wall_mm` is under the 0.6 mm a resin process holds. |
| `triangle_budget` | 4 | Over one million triangles. |

---

## 2. Quote token

`POST /api/print/quote` returns `token` alongside the itemization when the
material is priced (a quote-on-request material returns `token: null`, because
nothing may be checked out at a number an engineer has not confirmed).

**Format:** three dot-separated parts, `pq1.<base64url payload>.<hmac>`. The
HMAC is over the payload string, keyed by the platform signing secret.

**Payload claims,** deliberately single-letter because the token travels in a
request body on every slider drag:

| Claim | Meaning |
|---|---|
| `v` | Token schema version, `1`. |
| `m` | Material id. |
| `f` | Finish id. |
| `h` | Target height, mm. |
| `q` | Quantity. |
| `w` | Hollowed, `1` or `0`. |
| `c` | Destination country. |
| `t` | Total, USDC. |
| `g` | Chargeable volume, cm3. |
| `l` | Lead time, days. |
| `r` | Report hash: sha256 over the report's version, volume, bbox, min wall and triangle count. |
| `u` | Source model URL. |
| `i` | Creation id, or null for a direct upload. |
| `exp` | Expiry, unix seconds. |

Every priced parameter is inside the signature, so checkout cannot be replayed
at a stale price or altered client-side. Checkout verifies the token, not the
request body; a mismatch between the two is a rejected order, not a re-price.

---

## 3. Order states

`print_orders.status`. The database constrains the vocabulary; the legal
transitions live in `api/_lib/print-store.js` as data, next to the events they
emit, and an illegal move throws `PrintStoreError('illegal_transition')`.

```
created ──▶ quoted ──▶ paid ──▶ screening ──▶ submitted ──▶ printing ──▶ quality_check ──▶ shipped ──▶ delivered
```

| From | Legal next |
|---|---|
| `created` | `quoted`, `canceled` |
| `quoted` | `paid`, `canceled` |
| `paid` | `screening`, `canceled`, `refunded` |
| `screening` | `submitted`, `rejected`, `refunded` |
| `submitted` | `printing`, `quality_check`, `canceled`, `refunded` |
| `printing` | `quality_check`, `refunded` |
| `quality_check` | `shipped`, `printing` |
| `shipped` | `delivered`, `refunded` |
| `delivered` | none |
| `rejected` | `refunded` |
| `canceled` | `refunded` |
| `refunded` | none |

Rules that hold for every transition:

- A same-status write is illegal. Absence from the table means illegal.
- Every transition appends a `print_order_events` row (`status`, `note`,
  `actor` in `system | operator | provider | buyer`, `actor_id`). The timeline
  is that table; no column is mutated to represent history.
- The status guard is the concurrency lock. Two writers racing to move the same
  order produce one winner and one `transition_raced` error naming where the
  order actually went.
- A fulfillment adapter may only drive `submitted`, `printing`, `quality_check`,
  `shipped`, `delivered`. Everything before `submitted` is quoting, payment and
  safety; `refunded` is a money decision and stays operator-only.

---

## 4. Fabrication gate verdict

Written to `print_orders.analysis.screening` and returned inline by the quote
endpoint. Produced by `api/_lib/print/gate.js`.

```json
{
  "version": 1,
  "stage": "quote",
  "verdict": "allow",
  "category": null,
  "label": null,
  "layer": null,
  "matched": null,
  "message": null,
  "allowed": null,
  "policy_url": "/docs/materialize#content-policy",
  "checked_at": "2026-09-02T19:04:11.204Z",
  "layers": {
    "upstream": { "verdict": "allow" },
    "denylist": { "verdict": "allow", "soft": [] },
    "geometry": { "longest_mm": 65, "miniature": true, "note": "..." },
    "llm": { "verdict": "skipped", "reason": "deterministic layers only at quote time" }
  }
}
```

| Field | Meaning |
|---|---|
| `verdict` | `allow`, `refuse`, or `review` (held for a human). |
| `stage` | `quote` (pre-payment, deterministic) or `screening` (post-payment, with the model layer). |
| `category` | A stable slug: a denylist rule id, `generation_<category>`, or `fabrication_policy`. Never free-text. |
| `label` | Human name of the category. |
| `layer` | Which layer decided: `upstream`, `denylist`, or `llm`. |
| `matched` | The exact term a denylist rule matched, for audit. |
| `message` | Buyer-facing refusal copy. |
| `allowed` | What the buyer may do instead. |
| `policy_url` | Always present, always a live page. |
| `layers` | Per-layer record, including the model provider and model name when the LLM layer ran. |

### Precedence

The denylist always wins. The model layer can only add a refusal or resolve a
soft rule; it can never lift a refusal the denylist made, and it is not even
called once a hard rule has fired. `submitOrder()` refuses any order whose
stored verdict is not `allow`, so the gate cannot be bypassed from the operator
console.

### Run points

1. **Quote time.** Deterministic layers only, so a price is never gated on a
   third-party model being reachable, and a refusal costs the buyer nothing.
   A refusal is `HTTP 451` with `category`, `allowed` and `policy_url` in the
   body, so an agent lane can branch on the status alone.
2. **Screening.** The paid order is re-screened by
   `api/cron/print-orders-sync.js`, which adds the LLM layer. `refuse` moves the
   order to `rejected` (the refund path) with the category on the timeline;
   `review` leaves it in place and pages the operators.

### Gate limitations

Stated plainly because the alternative is a false sense of coverage.

- **Geometry cannot identify a weapon.** Blade profiles, bore diameters and
  receiver rails are not reliably detectable from a triangle soup: aspect-ratio
  heuristics that claim to find a blade also find a fin, a bookmark and a
  spatula. The only geometric signal this gate uses is **scale**, which is real:
  a tabletop miniature and a life-size component are the same words and
  different objects. The threshold is 120 mm on the longest bounding-box axis.
- **The denylist is language-bound.** It matches whole words in the prompt
  lineage, model title and buyer note. A request phrased entirely in another
  language, or purely as an uploaded mesh with no text at all, reaches only the
  model layer and the scale signal.
- **A direct GLB upload has no lineage.** Orders that skip generation carry no
  prompt history, so the text the gate reads is whatever the buyer typed.
- **The model layer is advisory in one direction only.** When no provider
  answers, an order the deterministic layers had no question about proceeds
  (it cleared the same bar its quote cleared) and an order with an unresolved
  soft flag is held for a human. Nothing is auto-rejected on a provider outage.

---

## 5. Adapter interface

A fulfillment lane is an object satisfying `assertAdapterShape()`. Adapters
speak; the store decides. Every adapter result is normalized before it reaches
the state machine, so a partner changing their payload shape cannot break it.

```js
{
  key: 'manual',              // lower-kebab, 2 to 32 chars, unique
  label: 'Manual fulfillment',
  capabilities: {
    materials: '*' ,          // '*' or an array of catalog material ids
    maxBboxMm: { x, y, z },   // positive numbers
    shipsFrom: 'CN',          // ISO 3166-1 alpha-2
    leadTimeDays: 12,         // integer 1 to 120
  },
  configured(),               // boolean: are this lane's credentials present
  async submit(order, assets),
  async status(order),
  async cancel(order, reason),
  verifyWebhook(rawBody, headers),
  parseWebhook(rawBody, headers),
}
```

Return shapes, after normalization:

| Method | Returns |
|---|---|
| `submit` | `{ providerOrderId, status, note, leadTimeDays, state }` |
| `status` | `{ status \| null, trackingNumber, carrier, note, state }`; `null` means "no news", which is not an error |
| `cancel` | `{ ok, note, state }` |
| `verifyWebhook` | `{ ok, deliveryId, reason }` |
| `parseWebhook` | `{ providerOrderId, status \| null, trackingNumber, carrier, note, state }` |

`state` is the provider's own payload, kept verbatim for diagnostics in
`print_orders.provider_state`. Nothing reads it to make a decision.

---

## 6. Webhook envelope

`POST /api/print/webhook/:provider`. Three properties, enforced in this order.

1. **Authenticity.** The adapter verifies the delivery against the exact bytes
   received, before any parse. The reference partner adapter reads
   `x-print-signature: sha256=<hex>`, an HMAC-SHA256 over the raw body keyed by
   that lane's shared secret, compared in constant time. An unverified delivery
   is `401` and never reaches `JSON.parse`. A lane with no webhook (the manual
   one) refuses every delivery by construction, so it has no unauthenticated
   door.
2. **Idempotency.** The delivery id (`x-print-delivery`, or a stable hash of the
   payload when the provider sends none) is claimed in
   `print_webhook_deliveries` by unique-key insert. A replay is a no-op that
   answers `200`; a `4xx` would make the provider retry forever.
3. **Ordering.** The state machine decides what may follow what. A report that
   arrives out of order is recorded on the timeline as a provider event carrying
   the refusal in its note and answered `200` with `applied: false`.

The response never echoes the payload and never reveals whether an order id
exists to an unverified caller.

---

## 7. Certificate memo

Every shipped print gets a certificate row and a Solana memo transaction. The
memo is the whole point: a buyer verifies a print by hashing the file and
comparing it to the string in the transaction, with no dependency on this
database, this company, or any block explorer staying online.

```json
{
  "v": 1,
  "kind": "threews.print.v1",
  "cert": "9f86d081884c7d659a2feaa0",
  "sha256": "<64 hex, the viewable GLB>",
  "ed": 3,
  "of": 25,
  "ts": 1788370000,
  "creation": "<forge creation uuid, when the print came from a generation>",
  "print": "stl:<64 hex of the exact manufacturing file>"
}
```

| Field | Required | Meaning |
|---|---|---|
| `v` | yes | Memo schema version. |
| `kind` | yes | `threews.print.v1`. |
| `cert` | yes | Certificate id: 24 lowercase hex, the `/cert/:certId` path segment. |
| `sha256` | yes | Hash of the viewable GLB. |
| `ed` | yes | Edition number. |
| `of` | yes | Edition size, or `null` for an open edition. |
| `ts` | yes | Print timestamp, unix seconds. |
| `creation` | when known | The generation this object came from. |
| `print` | when known | `<kind>:<sha256>` of the file the bureau actually loaded (`stl` or `3mf`). |

**Cluster policy.** Devnet is the default and needs no approval. Mainnet is
gated twice: `PRINT_CERT_CLUSTER` must say mainnet **and**
`PRINT_CERT_MAINNET_APPROVAL` must carry the owner's recorded approval. A
missing approval never silently downgrades to devnet, because a devnet signature
printed on a mainnet certificate would be a lie. The certificate is issued
unattested, the reason is recorded, and the sweep retries once approval lands.

**Failure policy.** Issuance never blocks a shipment. The row is written first;
the QR and the memo are best-effort and retried by the reconciliation sweep. A
certificate with a null signature is a real certificate whose proof is still in
flight, and the page says exactly that.

---

## Conformance

An implementation conforms to Materialize print pipeline v1 if:

1. Every price a buyer sees comes from a quote token whose signature verifies
   and whose `exp` has not passed.
2. No order reaches a fulfillment adapter without a recorded gate verdict of
   `allow` on `analysis.screening`.
3. Every status change appends a `print_order_events` row, and no status change
   occurs outside the transition table above.
4. Every webhook delivery is verified against the raw bytes before it is parsed,
   and claimed for idempotency before it is applied.
5. A certificate's `sha256` matches the bytes at the asset it names.

A consumer MUST treat a certificate whose memo signature is null as unattested,
regardless of what the certificate page renders.
