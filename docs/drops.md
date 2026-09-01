# 3D Drops: generative collections of rigged characters

[three.ws/drops](https://three.ws/drops) is the collection launcher. You give it
a base style and a set of weighted trait layers; it rolls a supply-capped
collection where every item is a real, rigged, animation-ready 3D character, its
rarity is recomputable by anyone holding the spec, and its art is forged on
reveal instead of bulk-rendered up front.

The reference points are the 3D PFP collections: a studio hand-models a base
mesh plus dozens of trait meshes, a compositor assembles ten thousand
combinations, and the whole thing takes a year and a half. This is that product
without the studio. The part that was expensive (making the art) is a generation
job; the part that was hand-waved (proving the roll was fair) is a published
commitment anyone can check.

Related surfaces: [Minted 3D Assets](minted.md) for one-off Metaplex Core mints,
[the Forge](forge.md) for the text-to-3D pipeline every reveal runs on, and
[the avatar gallery](../public/gallery/index.html) at `/gallery` for individual
avatars.

## The idea in one paragraph

A drop stores its **spec**, not its art. Every item's traits come from three
inputs and nothing else: the drop's `seed`, the item's `index`, and the trait
layers. That makes the whole supply a pure function, which buys two things. A
holder can recompute the entire collection from the published spec and check it
against what the site served them, so "we did not re-roll the rares into our own
wallet" becomes a checkable claim rather than a promise. And the platform can
re-forge a lost model years later without ever having stored a per-item random
state.

## Launching a collection

Open [/drops](https://three.ws/drops), sign in, and press **Launch a
collection**. You supply:

- **Name and symbol.** The symbol is 2 to 10 letters or digits, shown on cards.
- **Supply.** Up to 10,000. The roll is instant and free at any size, because no
  art is generated at this step.
- **Base style.** The look every item shares, for example
  `stylized matte-clay guardian creature, soft rim light, chunky proportions`.
- **Trait layers.** Each layer (Species, Outfit, Aura) has options with relative
  weights. The builder shows each option's resulting share as you type. An
  option can carry its own prompt fragment when the trait's display name is not
  what you want fed to the generator: the value `Bomber jacket` can generate
  from `wearing a worn leather bomber jacket`.

Submitting rolls the supply and lands you on the collection page. The drop
starts as a **draft**: its seed is withheld, so the provenance hash it publishes
is a commitment rather than a description. Pressing **Publish** freezes the spec
and reveals the seed. That is one-way, on purpose: after the seed is out,
editing the spec would invalidate every rarity claim the collection has already
made.

### From an agent or a script

```bash
curl -X POST https://three.ws/api/drops/create \
  -H 'content-type: application/json' \
  -H 'authorization: Bearer <token with avatars:write>' \
  -d '{
    "name": "Clay Wardens",
    "symbol": "WARDEN",
    "style": "stylized matte-clay guardian creature, soft rim light",
    "supply": 250,
    "layers": [
      {"name": "Species", "options": [
        {"value": "Fox", "weight": 60},
        {"value": "Wolf", "weight": 30},
        {"value": "Dragon", "weight": 10}
      ]},
      {"name": "Outfit", "options": [
        {"value": "Bomber jacket", "weight": 50, "prompt": "wearing a worn leather bomber jacket"},
        {"value": "Lab coat", "weight": 50}
      ]},
      {"name": "Aura", "options": ["None", "Ember", "Frost"]}
    ]
  }'
```

A layer's options may be bare strings, in which case each weighs 1 and its value
doubles as its prompt fragment. The response carries the `slug`, the
`provenance_hash`, and (for the creator) the `seed`.

## How rarity is computed

Rarity is scored from the **actual rolled distribution**, not from the declared
weights. Those two always diverge on a finite supply, and the honest number is
the one a holder can recount from the published items.

Each item's score is the sum over its traits of `supply / (how many items share
that trait value)`. A value held by 1 item in 1000 contributes 1000; one held by
half the supply contributes 2. Summing rather than multiplying keeps a single
ultra-rare trait from swamping every other signal in the collection.

Items are then ranked (ties broken by index, so the ordering is total and
reproducible) and bucketed into the same four tiers the rest of the platform
uses for cosmetics:

| Tier | Top percentile of the ranking |
|---|---|
| `legendary` | 1% |
| `epic` | 10% |
| `rare` | 35% |
| `common` | the rest |

## Reveal: art is forged per item

A freshly rolled item is **sealed**. Its traits are already public and its rank
is already fixed; only the art is unforged. Pressing **Reveal** on the collection
page composes the item's prompt (the base style, then each rolled trait's prompt
fragment in layer order, then the hints that keep the output riggable) and
submits it to [the Forge](forge.md). The page then polls until the GLB lands.

Ordering the fragments by layer is what holds a collection together visually: a
given trait always occupies the same position in the prompt, so the generator's
output stays coherent across the supply instead of drifting item to item.

Reveal states are `sealed`, `revealing`, `revealed`, and `failed`. A failed
reveal keeps its error and is retryable from the same button. Claiming an item
for reveal is a conditional database update, so a double-clicked button cannot
start two paid generation jobs for the same token, and a claim that never comes
back is released automatically after fifteen minutes rather than needing a
sweeper cron.

Because every item is generated as a full-body character in a neutral A-pose, it
inherits the platform's universal animation retarget: any revealed item drives
the pre-baked clip library through
[`src/glb-canonicalize.js`](../src/glb-canonicalize.js), and can be exported as
GLB, VRM 1.0, or USDZ through [`src/avatar-export.js`](../src/avatar-export.js).

## Verifying a roll

The **Verify this roll** button on every collection page calls:

```bash
curl "https://three.ws/api/drops/verify?slug=clay-wardens&index=7"
```

The response re-derives the provenance hash from the stored spec and, when an
`index` is given, re-rolls that item through the same pure function a third
party would:

```json
{
  "slug": "clay-wardens",
  "seed": "ff65b26d-d3c5-4a1b-90ed-82c132b7bd7d",
  "supply": 120,
  "published_hash": "94c97a50...",
  "recomputed_hash": "94c97a50...",
  "hash_matches": true,
  "item": {
    "index": 7,
    "served_traits": [{"layer": "species", "value": "Dragon"}],
    "recomputed_traits": [{"layer": "species", "value": "Dragon"}],
    "traits_match": true
  }
}
```

You do not have to trust the endpoint. The hash is a sha256 over the canonical
JSON of `{version, seed, supply, style, layers}` with keys sorted recursively,
and each trait is a weighted pick against `draw(seed + "#" + index, layerKey)`
from [`api/_lib/genome.js`](../api/_lib/genome.js). Both are reimplementable in
any language from [`api/_lib/drops.js`](../api/_lib/drops.js).

One consequence worth knowing: because each layer draws from its own stream
keyed by the layer's slug, adding a layer to a draft does not perturb the values
already rolled on the layers beside it, and reordering the layer array changes
nothing at all.

## API reference

All routes live under `/api/drops/`. Reads are public and rate-limited by IP;
writes need a session cookie or a bearer token with `avatars:write`.

| Method | Route | What it does |
|---|---|---|
| `GET` | `/api/drops/list?limit=&before=&mine=1` | Public collections, newest first. `mine=1` lists your own, drafts included. |
| `GET` | `/api/drops/get?slug=` | One collection with its stats, trait distribution, and first page of items. |
| `GET` | `/api/drops/items?slug=&limit=&offset=&tier=&status=&sort=` | Paginated items. `sort` is `rank` (default) or `index`. |
| `GET` | `/api/drops/verify?slug=&index=` | Recompute the provenance hash, and optionally one item's traits. |
| `POST` | `/api/drops/create` | Roll a new collection. Body as shown above. |
| `POST` | `/api/drops/publish` | Freeze a draft and publish its seed. Body `{slug}`. |
| `POST` | `/api/drops/reveal` | Start one item's generation. Body `{slug, index}`. |
| `GET` | `/api/drops/reveal?slug=&index=` | Poll an in-flight reveal. One upstream check per call. |

A deployment with no database answers `503 not_configured` on every route; the
rest of the platform is unaffected.

## Where the code lives

| Piece | File |
|---|---|
| Trait, rarity, and provenance engine (pure) | [api/_lib/drops.js](../api/_lib/drops.js) |
| Persistence and the reveal state machine | [api/_lib/drop-store.js](../api/_lib/drop-store.js) |
| HTTP routes | [api/drops/[action].js](../api/drops/%5Baction%5D.js) |
| Schema | [api/_lib/migrations/20260901120000_generative_drops.sql](../api/_lib/migrations/20260901120000_generative_drops.sql) |
| Index page and launcher | [pages/drops.html](../pages/drops.html), [src/drops.js](../src/drops.js) |
| Collection page | [pages/drop-collection.html](../pages/drop-collection.html), [src/drop-collection.js](../src/drop-collection.js) |
| Shared styles | [src/drops.css](../src/drops.css) |
| Engine tests | [tests/drops-engine.test.js](../tests/drops-engine.test.js) |

Note that `/drops/:slug` (a collection) and `/drop/:id` (the unrelated sealed
wallet gift claim page) are different surfaces. The routes are declared so they
can never shadow each other.
