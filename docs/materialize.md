# Materialize: turn a generation into a real object

Materialize is the physical lane of the forge. You describe something, three.ws
generates the 3D model, and then Materialize prints it in resin, nylon, colour
sandstone or steel and ships it to your door. The whole loop lives on one page
at [/materialize](https://three.ws/materialize), and every step of it is also an
API, so an autonomous agent can order a physical object of a model it just
generated without a human touching anything.

That last part is the headline. Print bureaus have upload forms and AI 3D
vendors have download buttons; nobody else closes prompt to object in one
surface, and as far as we know this is the first API where an AI agent can pay
for manufacturing.

**New to three.ws 3D?** Generate something first at
[/forge](https://three.ws/forge) ([Forge](./forge.md)), then come back. You can
also print a `.glb` you already have.

---

## The flow

```
  a forge creation            a GLB you upload            an agent
  /m/:id "Materialize"        /materialize                POST /api/print/quote
        │                           │                           │
        └───────────────┬───────────┴───────────────────────────┘
                        ▼
        POST /api/print/quote     printability report + itemized price
                        │         + a signed quote token (24 hours)
                        ▼
        POST /api/print/orders    human checkout, USDC on Solana
        POST /api/x402/print-order  agent checkout, x402, same pipeline
                        ▼
        safety screening ──▶ production ──▶ quality check ──▶ shipped
                        ▼
        certificate of authenticity, attested on Solana, QR in the box
```

### 1. Analysis, free and keyless

Every model is measured before it is priced. `POST /api/print/quote` with just a
model returns the **printability report**: whether the mesh is a closed solid,
how many separate bodies it contains, where its holes are, the thinnest wall it
has, its exact volume, and a 0-100 score with named deductions written for a
human rather than a mesh engineer.

```bash
curl -s https://three.ws/api/print/quote \
  -H 'content-type: application/json' \
  -d '{"creationId":"<a three.ws creation id>"}'
```

No key, no account, no charge. AI-generated meshes are the worst case the
printing world sees (non-manifold shells, paper-thin decorations, detail that
lives in a texture rather than in geometry), so the report is blunt about what
it found and about what preparation will fix automatically.

### 2. Preparation

`POST /api/print/prepare` reconstructs the mesh as a solid, fills its holes,
scales it to your chosen height, optionally hollows it (with drain holes, which
is what makes a large resin print affordable), and exports the files a bureau
actually loads: binary STL, 3MF, and the repaired GLB. Full-colour materials get
per-vertex colour sampled from the source texture, which is what makes a colour
print possible from a model that only ever had a 2K albedo map.

### 3. Quote

Pick a material, a height and a quantity, and the same endpoint returns an
itemized price and a signed token:

```bash
curl -s https://three.ws/api/print/quote \
  -H 'content-type: application/json' \
  -d '{
    "creationId": "<creation id>",
    "materialId": "resin-standard",
    "targetHeightMm": 120,
    "quantity": 1,
    "country": "US"
  }'
```

Every line is shown: build setup, material with the exact cm3 it was computed
from, finish, quantity break, `$THREE` holder discount, shipping. The token
carries every priced parameter inside its signature and expires in 24 hours, so
a price cannot be replayed stale or edited on its way to checkout.

If the mesh cannot be printed in that material, you get guidance instead of an
error: the measured number, the required number, the fix, and every material
that would take the model as-is.

### 4. Checkout

Payment is **USDC on Solana**. There is no card processor, and the quote panel
says so plainly.

- **People:** `POST /api/print/orders` from the `/materialize` page with the
  token and a shipping address.
- **Agents:** `POST /api/x402/print-order`. See [the agent lane](#the-agent-lane).

### 5. Production and tracking

A paid order moves through `screening` (safety and printability), `submitted`,
`printing`, `quality_check`, `shipped`, `delivered`. Every change appends to a
timeline you can read at `GET /api/print/orders/:id`, and the page at
`/materialize/orders/:id` renders the same thing for humans.

---

## Using the page

Everything above is one screen at [/materialize](https://three.ws/materialize).
There is no wizard and no step counter: the model, the material, the size and
the price are all on screen at once, and changing any of them re-prices the
others in front of you.

**Getting a model onto it**, in the order most people arrive:

| Where you start | What to click |
|---|---|
| A model page, `/m/:id` | **Materialize**, next to Download GLB |
| A finished generation on [/forge](https://three.ws/forge) | **Materialize** in the result bar |
| A card in [/creations](https://three.ws/creations) | **Materialize** on the card |
| Nothing in particular | Open `/materialize` and pick from the rail, paste a `.glb` URL, or drop a file |

A deep link works too: `/materialize?creation=<id>` for a forge creation and
`/materialize?glb=<url>` for anything else. Both preselect the model, so a link
you send someone opens on the thing you meant.

**What the page does with it.** The mesh is measured on the server the moment it
is selected, and the printability card shows the result as facts a buyer can act
on: whether it is a closed solid, how many separate pieces it is, the thinnest
wall **at the size currently selected**, and whether it carries colour. Anything
the analyzer deducted points for is listed underneath, and the ones a repair pass
can actually fix are marked. **Repair** runs `POST /api/print/prepare`, swaps the
viewer to the rebuilt solid, and lists exactly what changed: holes closed,
vertices merged, slivers dropped, faces re-wound, and the score before and after.

**Material cards are measured against your model, not just listed.** A material
that cannot take this mesh at any printable height says why on its own face and
cannot be selected, so a full-colour card on an untextured model reads
"this model has no texture" rather than failing after you click it.

**The size slider ends where reality does.** Its bounds come from
`fitHeightRange()` on the server: the low end is the height at which the mesh's
thinnest wall reaches the material's minimum, the high end is where its widest
axis fills the print bed. Both ends are labelled with the constraint that set
them. Beside the model, a silhouette of an everyday object (a coin, a mug, a
hand, a person) is drawn at true proportion against the print, so "140 mm" is
also "about one and a half times a coffee mug". Height is what you choose, but
the footprint is shown beside it: a model whose long axis is not vertical is much
wider than it is tall, and the doorstep is the wrong place to discover that.

### True-scale AR

The **See it at true size** button places the object on your actual floor at the
exact height you are ordering. It is not an approximation: the viewer is given
`ar-scale="fixed"` and a `scale` factor taken from the same number the price was
computed from, so the thing on your desk is the thing in the cart.

Desktop browsers cannot place objects in a room, so on a desktop the same button
hands over a QR code to this page instead of disappearing. Scan it and the phone
opens with the same model, material and size.

### Checkout

Signed out, the order button opens a sign-in step that carries your quote back
with it, so nothing is lost. Signed in, it asks for the minimum a courier needs
(name, street, city, postal code, country, and optionally a second line, a region
and a phone) and nothing else. Changing the country re-prices shipping before
anything is charged, because shipping is zone-based. The payment step shows the
Solana Pay link and a QR for a phone wallet, and watches the chain for the
payment itself; you can close it and follow the order from its own page instead.

---

## Materials

`GET /api/print/catalog` is the live source of truth. As of catalog version 1:

| Material | Class | Min wall | Height range | Lead time | Colour |
|---|---|---|---|---|---|
| Standard resin | resin | 0.6 mm | 15 to 180 mm | 5 days | no |
| Tough resin | resin | 1.0 mm | 15 to 180 mm | 6 days | no |
| SLS nylon (PA12) | sls_nylon | 0.8 mm | 12 to 280 mm | 7 days | no |
| Full-colour sandstone | full_color | 2.0 mm | 20 to 200 mm | 8 days | yes |
| PLA draft | fdm_draft | 1.2 mm | 20 to 250 mm | 3 days | no |
| 316L stainless steel | metal | 1.0 mm | 10 to 120 mm | 15 days | no |

Standard resin is the default for figures and detailed props. SLS nylon is the
one to pick for something that has to survive being handled. Full-colour
sandstone is the only material that reproduces your model's texture. Steel is
quote-on-request: it is priced as an estimate and never issues a checkout token,
because nothing should be bought at a number an engineer has not confirmed.

**Min wall matters more than anything else.** A model whose thinnest wall is
0.3 mm at 80 mm tall is 0.6 mm at 160 mm tall. The report's
`recommended_min_height_mm` tells you, per material class, exactly how tall the
object has to be printed for its detail to survive, and the page's size slider
is bounded by it so you cannot drag into a rejection.

---

## How pricing works

Every number a buyer sees comes from the quote engine
(`api/_lib/print/quote.js`) reading one file, `data/print-catalog.json`. No
price is ever computed in the browser.

```
total = setup
      + rate_per_cm3 × volume_cm3 × quantity
      + finish fees
      + shipping (volumetric weight, by zone)
      − quantity break        (8% at 5 units, 15% at 20)
      − $THREE holder discount (up to 15%, never on shipping)
```

Volume is the number money hangs off, so it comes from the Manifold kernel's
exact volume of the repaired solid, never from an estimate over a broken mesh.
Hollowing changes that volume and therefore the price, visibly, in the same
itemization.

Shipping is zoned: `cn`, `us`, `eu`, `row`, priced on volumetric weight from the
printed bounding box plus packaging. It is passed through, and the holder
discount never touches it.

---

## The agent lane

`POST /api/x402/print-order` is the endpoint where an AI agent pays and a
physical object gets manufactured and shipped.

The order of operations is the product: the quote token and the shipping address
are validated **before** any 402 is issued, so a malformed order is refused for
free with a `422` and a caller never pays for something that was going to be
rejected. The 402 then quotes that token's own total, because every print is its
own object with its own price.

```bash
# 1. Quote (free, keyless). Keep `token` from the response.
curl -s https://three.ws/api/print/quote \
  -H 'content-type: application/json' \
  -d '{"creationId":"<creation id>","materialId":"resin-standard","targetHeightMm":120,"quantity":1,"country":"GB"}'

# 2. Order. The first call answers 402 with the exact amount from that token.
curl -s -X POST https://three.ws/api/x402/print-order \
  -H 'content-type: application/json' \
  -d '{
    "token": "pq1....",
    "shipping": {
      "name": "Ada Lovelace",
      "line1": "12 Analytical Way",
      "city": "London",
      "postal_code": "EC1A 1AA",
      "country": "GB"
    }
  }'

# 3. Settle the 402 the usual x402 way and repeat the call with the payment
#    header. The response carries the order id.

# 4. Track it, with no account.
curl -s https://three.ws/api/print/orders/<order id>
```

The shipping block is the minimum a courier needs and is the only personal data
the platform stores for a print. It is never logged and never enters an
analytics event.

See [x402 payments](./a2a-payments.md) for the settlement mechanics, and
[specs/PRINT_PIPELINE.md](../specs/PRINT_PIPELINE.md) for every wire contract.

---

## Certificates

Every shipped print gets a certificate of authenticity, and it is not a printed
card with a logo on it. It is three things:

1. The **SHA-256 of the exact file** that was manufactured, plus the hash of the
   viewable GLB.
2. An **edition number**, enforced in the database, so edition 3 of 25 is
   actually the third one that shipped.
3. A **Solana memo transaction** carrying both, signed by the platform.

The box carries a QR to `/cert/<id>`, which renders the original model spinning,
the prompt lineage that produced it, the edition, and the raw memo payload. That
last part is the point: you verify a print by hashing the file and comparing it
to the string in the transaction, with no dependency on this database, this
company, or any block explorer staying online.

A certificate whose signature is still in flight is a real certificate whose
proof has not landed yet, and the page says exactly that rather than pretending.
The reconciliation sweep (`/api/cron/print-orders-sync`) retries the send and
backfills the QR, so a bad RPC minute at shipping time costs nothing.

### Verifying one yourself

Nothing here needs an account, and none of it trusts us:

```bash
# 1. Read the certificate. It is public: the QR on the box resolves to it.
curl -s https://three.ws/api/print/certs/<certId> | jq '.certificate | {glb_sha256, memo, solana_signature, network}'

# 2. Download the model it names and hash the bytes.
curl -sL "<creation.glb_url from the response>" | shasum -a 256

# 3. The two hashes match, or this is not the model that was printed.
```

The `memo` field is the exact string that was signed on-chain, rendered on the
certificate page too, so the last step is reading the transaction's memo
instruction and confirming it is character-for-character the same. `/cert` with
no id is the lookup page: type the number printed on the card.

### Editions

`edition_of` is the creator's, not ours. On any model you forged, `/m/<id>` shows
a **Physical editions** panel where you set one number: how many physical copies
of that model may ever exist. Leave it empty and it is an open edition, which is
every model's default.

```bash
# Read the scarcity of a model (public).
curl -s "https://three.ws/api/print/editions?creation_id=<uuid>"
# → { "edition": { "limit": 25, "issued": 3, "remaining": 22, "soldOut": false } }

# Cap it (the creator's session only).
curl -s -X POST https://three.ws/api/print/editions \
  -H 'content-type: application/json' --cookie "$SESSION" \
  -d '{"creation_id":"<uuid>","edition_of":25}'
```

Three rules make the number mean something:

- **It is enforced where the price is set.** A sold-out model is refused by
  `/api/print/quote` and by both checkout lanes with a message naming how many
  are left, so nobody pays for a copy that cannot exist.
- **It counts shipped certificates, not open orders**, so an abandoned checkout
  never strands the last copy of an edition.
- **It cannot shrink below its own history.** Capping a series at 5 after 7 have
  shipped is refused, because a certificate reading "edition 7 of 5" would be a
  lie that is already in someone's hands.

A print of a model that was uploaded rather than forged still gets an edition
number: those series are keyed by the content hash, so identical bytes belong to
one series instead of each upload minting its own "edition 1 of 1".

### The cluster, and the mainnet gate

Certificates attest on **devnet** unless `PRINT_CERT_CLUSTER=mainnet` says
otherwise, and anything unrecognised in that variable stays devnet rather than
guessing its way onto real money. Mainnet needs a second key,
`PRINT_CERT_MAINNET_APPROVAL`, carrying the owner's recorded approval: an
irreversible on-chain send is an owner decision, not a deploy-time default.
Without it a mainnet certificate is issued, hashed, and left unattested with the
reason recorded, rather than quietly downgraded to a devnet signature that would
misrepresent what the certificate says it is.

---

## Content policy

Physical manufacturing raises the stakes of everything a platform moderates. A
refused image generation costs nothing; a printed firearm component is a crime
in most of the places we ship to, and a printed key to somebody's door is a
burglary tool. So the line is code, not a suggestion.

**three.ws does not manufacture:**

- **Firearm components.** Receivers and frames, trigger and fire-control parts,
  barrels, bolt carriers, slides, conversion devices, and anything sold as an
  unfinished or unserialized firearm.
- **Suppressors**, including the parts marketed as solvent traps that convert
  into them.
- **Ammunition**, ammunition components, magazines and feeding devices.
- **Keys and lock-bypass tools.** A working key, a pick, a shim or a jiggler is
  a burglary tool no matter who orders it.
- **Counterfeit goods**, other parties' brand marks, authentication tags,
  holograms, serial plates and currency.
- **Working weapon mechanisms.** Concealed or spring-loaded blades, automatic
  and butterfly knives, knuckles, garrotes, caltrops and tyre spikes.
- **Drug paraphernalia** and equipment for producing or pressing controlled
  substances.
- **Realistic firearm likenesses at or near life size.**
- Anything the generation content policy already refuses: sexual content,
  graphic gore, and hateful or extremist iconography.

**What is fine, and this is most of what people print:** characters, creatures,
figurines, props, jewellery, ornaments, enclosures, tools, replacement parts,
architectural models, and stylised or fantasy weapons. A tabletop miniature
carrying a weapon prints; the same design at 210 mm does not. A prop sword with
a blunt edge, printed as one piece, prints; a spring-loaded blade does not. Your
own logo prints; somebody else's does not.

### How it is enforced

The gate runs twice, and the second run is the one that matters.

1. **At quote time**, before any money moves, using only deterministic checks
   (the content classifier, a structured denylist with a test per category, and
   the printed size of the object). It never waits on a model, so a refusal is
   instant and a price is never blocked by a third-party outage. A refused
   request gets `HTTP 451` naming the category, linking this policy, and saying
   what is allowed instead.
2. **After payment**, on the way to the printer, a language model reviews the
   same prompt lineage, model title and buyer note. It can add a refusal;
   it can never lift one the denylist made. An order that fails moves to `rejected`,
   which is the refund path, and an operator is told so a human sees every edge
   case.

An order reaches a printer only with a recorded `allow` verdict on it. There is
no path through the operator console that skips this.

If you think a refusal is wrong, the order timeline names the exact category and
matched term, which is what a human needs to overturn it.
[specs/PRINT_PIPELINE.md](../specs/PRINT_PIPELINE.md#4-fabrication-gate-verdict)
documents the verdict shape and, just as importantly, what the gate cannot do.

---

## Limits and what is not built yet

- **Single objects only.** Multi-part assemblies, which need splitting and
  joinery, are not in scope yet. A part larger than the build envelope is
  refused with the reason rather than silently split.
- **No card payments.** USDC on Solana, by design.
- **No paint or finishing marketplace**, no creator royalties on physical sales,
  and no physical goods marketplace. All of those are designed for in the
  schema and none of them are half-built.

---

## Related

- [Forge](./forge.md), where the models come from
- [The Forge pipeline](./forge-pipeline.md), the generation engineering guide
- [specs/PRINT_PIPELINE.md](../specs/PRINT_PIPELINE.md), every wire contract
- [API reference](./api-reference.md), the `/api/print/*` endpoints
