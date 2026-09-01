# The Agent-Forged Gallery (/forged)

[three.ws/forged](https://three.ws/forged) is a public gallery of 3D props that
the platform's own autonomous agents bought with real USDC over the
[x402 payment protocol](./x402.md). Nothing on the page is curated or seeded by
hand: an agent wallet paid the Forge, the Forge generated the prop, the payment
settled on Solana mainnet, and the finished asset landed in the gallery carrying
its receipt. Every card shows the price paid, the paying agent wallet, and a
link to the settlement transaction on Solscan. Before the first paid generation
completes, the feed is honestly empty.

## What a visitor sees

The page ([pages/forged.html](../pages/forged.html), rendered by
[src/forged-gallery.js](../src/forged-gallery.js)) loads the feed from
`GET /api/forged?limit=100` and renders:

- **Hero stats**, live from the feed: how many props have been forged, the total
  USDC settled on-chain, and how many generations are still in flight.
- **A card per prop.** Each card is a live, auto-rotating `<model-viewer>` of
  the GLB, the prompt the agent paid for, when it was forged, and its novelty
  score. Clicking the model or the Preview button opens it in the interactive
  viewer (`/app`); Download fetches the GLB directly.
- **The receipt strip**, the part that makes this gallery different: the USDC
  price the agent settled, the paying agent wallet (shortened), and a
  `receipt` link to the Solana settlement transaction on Solscan.
- **Search, sort, and filters.** Prompt search (press `/` to focus), sort by
  newest, oldest, highest price, or most novel, and category chips built from
  whatever categories are actually present in the feed. Filtering and sorting
  happen client-side over the loaded feed.
- **Designed empty, no-match, and error states.** The empty state explains that
  the autonomous loop pays the Forge for a new prop every hour; the error state
  names the reason the load failed (the API's own message) and has a retry
  button.

## Where the assets come from

The buyer is the platform's [autonomous x402 loop](./autonomous-x402.md), the
scheduled engine that pays real USDC to call the platform's own paid endpoints.
Its `forge` pipeline
([api/_lib/x402/pipelines/forge-content.js](../api/_lib/x402/pipelines/forge-content.js))
runs as a registry entry inside that loop, and on each run it:

1. **Picks the next prop deterministically.** A combinatorial catalog (club
   decor, AR objects, diorama set-dressing, avatar items, vehicles, containers,
   furniture, terrain tiles) is crossed with style and finish axes into roughly
   5,000 distinct prompts, and a per-hour hash walk selects one. Two runs in the
   same hour pick the same prop, which the paid endpoint's idempotency guard
   collapses instead of double-charging.
2. **Pays `POST /api/x402/forge` for a standard-tier generation** ($0.15 USDC,
   the standard-tier price in
   [api/_lib/forge-tiers.js](../api/_lib/forge-tiers.js)). The payment
   is a real on-chain USDC transfer from the loop's seeder wallet, settled by
   the platform's self-hosted facilitator on Solana mainnet. The same seeder
   wallet is the `x402-ring-payer` signer in the
   [x402 ring economy](./x402-ring-economy.md), and the loop's daily spend cap
   applies to these calls like every other.
3. **Scores diversity.** The prompt is embedded (a configured provider when
   available, a deterministic local feature-hash space otherwise) and scored
   against the last 200 props in the same vector space: novelty is one minus
   the maximum cosine similarity, and a k-means pass assigns a cluster id. This
   is the metric behind the "most novel" sort.
4. **Records the prop with its receipt.** The row lands in the
   `forge_autonomous_props` table carrying the prompt, category, tier, GLB URL,
   embedding, novelty, cluster id, and the payment provenance: payer wallet,
   amount in USDC atomics, and the settlement signature. Async generations are
   stored as `queued` with a job token; each subsequent run polls pending jobs
   toward `done`, so the gallery converges on renderable assets without a
   dedicated cron.

## The API: GET /api/forged

[api/forged.js](../api/forged.js) serves the public feed over the
`forge_autonomous_props` table. It is a free, CORS-open, rate-limited GET with
a 20-second shared cache.

| Query param | Default | Behavior |
|---|---|---|
| `limit` | `30` | Page size, clamped to 1..100. |
| `status=all` | off | Include `queued` and `failed` rows (audit view). By default only `done` rows with a GLB are returned. |
| `category` | none | Filter by prop family. Valid values are the eight families in the shared prop catalog (`api/_lib/x402/pipelines/forge-catalog.js`): `club-decor`, `ar-object`, `diorama-set`, `avatar-item`, `vehicle`, `container`, `furniture`, `terrain`. Any other value returns `400 invalid_category`, and the error body lists the accepted set. |

The response carries the props plus aggregate stats:

```json
{
	"props": [
		{
			"id": 42,
			"ts": "2026-07-29T14:00:11.000Z",
			"prompt": "a barrel with riveted hoops, steampunk with brass fittings, rusted and patinated, 3D prop",
			"category": "container",
			"tier": "standard",
			"status": "done",
			"glb_url": "https://pub-2534e921bf9c4314addcd4d8a6e98b7b.r2.dev/forge/nvidia/5ab878cd-513d-4fb6-94b8-d389f7d7e433.glb",
			"novelty": 0.41,
			"cluster_id": 3,
			"price_usdc": 0.15,
			"payer": "7sk…full base58 wallet…",
			"payer_short": "7skQxs…9fWn",
			"tx_sig": "5Yw…settlement signature…",
			"explorer_url": "https://solscan.io/tx/5Yw…",
			"viewer_url": "/app?src=https%3A%2F%2Fpub-2534e921bf9c4314addcd4d8a6e98b7b.r2.dev%2Fforge%2Fnvidia%2F5ab878cd-513d-4fb6-94b8-d389f7d7e433.glb"
		}
	],
	"stats": {
		"total": 120,
		"done": 112,
		"queued": 5,
		"spent_usdc": 18,
		"categories": { "container": 18, "furniture": 15 },
		"latest_ts": "2026-07-29T14:00:11.000Z"
	}
}
```

`price_usdc` is derived from the stored atomic amount (6 decimals), and
`explorer_url` is the Solscan link for the settlement signature. On a transient
database outage the endpoint returns `503 db_unavailable` with a
`retry-after: 5` header instead of a hard failure.

Try it:

```bash
curl -s 'https://three.ws/api/forged?limit=5' | python3 -m json.tool
```

The endpoint is also listed in the [API reference](./api-reference.md).

## Related

- [Autonomous x402 loop](./autonomous-x402.md): the engine that buys these
  assets, its spend caps, and where every call is logged.
- [x402 ring economy](./x402-ring-economy.md): the wider self-paid endpoint
  economy the seeder wallet participates in.
- [How the Forge works](./how-forge-works.md): the generation pipeline the
  agents are paying for.
- [x402 on three.ws](./x402.md): the payment protocol itself.
