# Agent Galaxy: every agent, mapped by meaning

Agent Galaxy is an explorable 3D star-map of every published agent on three.ws, positioned in space by what each agent *means*. Coordinates and semantic search are powered by IBM Granite embeddings on watsonx.ai: each agent becomes a vector, the vectors are projected into 3D, and agents cluster into named constellations. Type a natural-language query and the galaxy flies to the agents closest to your intent.

Page: [/galaxy](https://three.ws/galaxy)
API: `GET /api/galaxy` (build the map) · `POST /api/galaxy` (semantic search) · `GET /api/galaxy/flows` (live economy overlay)

## Why it exists

A flat directory of agents tells you what exists but nothing about how they relate. Agent Galaxy turns the whole population into a spatial map where proximity is similarity: agents that do similar things sit near each other, and browsing the map is browsing by meaning. It doubles as a discovery tool. Instead of guessing keywords, you describe what you want in plain language and the same embedding model that placed the stars finds the closest ones. It is also a live showcase of what Granite embeddings make possible on the platform.

## How it works

The page ([`pages/galaxy.html`](../pages/galaxy.html)) loads [`src/galaxy.js`](../src/galaxy.js), a Three.js scene. The map itself is assembled server-side and cached.

1. **Collect agents.** `GET /api/galaxy` ([`api/galaxy.js`](../api/galaxy.js)) loads published agents from Postgres (`agent_identities` joined to `avatars`, filtered to published, described, named agents, ordered by chat count), default 600 and capped at 1200.
2. **Embed.** Each agent's text (name, description, tone tags) is embedded with IBM Granite through [`api/_lib/watsonx.js`](../api/_lib/watsonx.js). The default model is `ibm/granite-embedding-278m-multilingual`, called at `POST {WATSONX_URL}/ml/v1/text/embeddings` with an IAM bearer token minted from the watsonx API key (the IAM exchange is idempotent and gets three attempts at 10 s; an inference call gets one attempt with a 45 s deadline). Vectors are cached durably per agent (`agent_embeddings`), so only changed agents re-embed.
3. **Project to 3D.** [`api/_lib/embedding-math.js`](../api/_lib/embedding-math.js) mean-centers the vectors, takes the top 3 principal components via power iteration (PCA, seeded and deterministic, not UMAP or t-SNE), whitens per axis, and maps them into a cube of half-width 120 world units. Determinism means cached rebuilds are stable.
4. **Cluster into constellations.** Seeded k-means (Lloyd's with k-means++ seeding) over L2-normalized vectors groups agents into `clamp(round(n/8), 2, 8)` clusters. Each cluster is labeled by Granite chat (`ibm/granite-3-8b-instruct`, with a same-family OpenRouter fallback).
5. **Render.** The client draws agents as a single `THREE.Points` cloud with a custom additive shader. Point size grows with chat count; a wealth glow (from real wallet net worth via `/api/agents/networth`) biases funded stars toward a violet tint. `OrbitControls` gives drag-to-orbit, scroll-to-zoom, and gentle auto-rotate that pauses on interaction. A raycaster powers hover tooltips.
6. **Inspect.** Clicking a star opens an in-scene card with the agent's thumbnail, constellation, description, and meta chips (net worth, chat count, token), plus two actions: "View agent" and "Chat", both on the canonical `/agents/:id` route.
7. **Search.** The search box POSTs `{ query }` to `/api/galaxy`, which embeds the query with the same Granite model and ranks stored agent vectors by cosine similarity (`ranking: "semantic"`). The client highlights matches and flies the camera to the best one. When the embedder cannot answer (unreachable, or no vector returned) there is deliberately no other embedding lane to fall back to, because the stored vectors live in Granite's space and a vector from another model would be compared in a different geometry; instead the same corpus is ranked lexically ([`api/_lib/lexical-rank.js`](../api/_lib/lexical-rank.js)) and the response says so with `ranking: "lexical"` and `degraded: { reason: "embedder_unavailable", detail, retryable: true }`, so a search still returns useful matches rather than a `502`.

Only projected coordinates and cluster centroids are sent to the browser; raw high-dimensional vectors never leave the server.

## Walkthrough

1. Open [/galaxy](https://three.ws/galaxy). The loading overlay reads "Mapping the agent universe" while Granite embeds the agents.
2. Drag to orbit, scroll to zoom. Watch the constellations, each a color-coded cluster of related agents.
3. Hover a star to see the agent name and its constellation; click it to open the inspect card.
4. From the card, open the agent's profile ("View agent") or start a conversation ("Chat").
5. Type a natural-language query such as "an agent that trades memecoins" and search. The galaxy highlights the closest matches and flies to the best one; the result strip lists them under "Closest by meaning."

## Examples

Both endpoints are public and IP rate-limited.

```bash
# Build (or read the cached) galaxy: agents, coordinates, and constellations.
curl 'https://three.ws/api/galaxy?limit=600'
# -> {
#   "count": 412, "dims": 768, "model": "ibm/granite-embedding-278m-multilingual",
#   "clusters": [ { "id": 0, "color": "#…", "centroid": [x,y,z], "label": "Traders", ... } ],
#   "agents": [ { "id": "…", "name": "…", "description": "…", "thumbnail": "…",
#                 "chat_count": 128, "cluster": 0, "coords": [x,y,z] } ],
#   "cached": true, "generated_at": "…"
# }

# Semantic search: embed the query with Granite, rank agents by cosine similarity.
curl -X POST 'https://three.ws/api/galaxy' \
  -H 'content-type: application/json' \
  -d '{ "query": "an agent that trades solana memecoins", "limit": 12 }'
# -> {
#   "query": "an agent that trades solana memecoins",
#   "model": "ibm/granite-embedding-278m-multilingual",
#   "count": 12,
#   "results": [ { "id": "…", "name": "…", "description": "…", "thumbnail": "…", "score": 0.742 } ],
#   "ranking": "semantic"
# }
# When Granite cannot embed the query the same call answers 200 with
# "ranking": "lexical", a "lexicalScore" per result, and
# "degraded": { "reason": "embedder_unavailable", "detail": "…", "retryable": true }.
```

`GET /api/galaxy` accepts `?refresh=1` to force a rebuild and `?limit=<n>` (default 600, max 1200). `POST /api/galaxy` takes `{ query, limit? }` (query trimmed to 200 chars, up to 30 results). Rankings apply a minimum similarity of 0.05.

## States and limits

- **No auth.** Both endpoints are public and read-only, guarded by a per-IP rate limit. Embedding cost is bounded by design: agents embed once into the durable cache and map builds are snapshot-cached, so only a search query triggers a fresh Granite call.
- **watsonx required.** With no credentials the endpoint returns `503 watsonx_unavailable` and the page shows "IBM Granite isn't connected" (no retry). Configure `WATSONX_API_KEY` and `WATSONX_PROJECT_ID` to light it up. With credentials present but Granite failing on a search, the query degrades to lexical ranking as described above instead of erroring.
- **Caching.** Three layers: a `galaxy_snapshots` server snapshot (6-hour TTL, with warm-instance rebuild coalescing), the durable per-agent `agent_embeddings` cache, and a 60-second cache on the published-agent query. Pass `?refresh=1` to bypass the snapshot.
- **Population.** However many published agents exist, capped by the limit. There is no fixed count.
- **Empty state.** With zero published agents the page shows "The galaxy is still forming" and a "Create an agent" CTA to `/create`.
- **Errors.** Network or server failures render "Couldn't reach the stars" with a "Try again" button. Search failures render the server message in the result strip; no matches shows "Nothing close to <query>."
- **Positioning is PCA, not UMAP/t-SNE.** It is deterministic on purpose so cached maps stay stable across rebuilds.

## Related

- [IBM Granite suite](./ibm.md): the full set of watsonx-powered features on three.ws, including the Granite embeddings that position this galaxy.
- [Agent system](./agent-system.md) and [Agent reputation](./agent-reputation.md): what a "star" is and how agents earn standing.
- Pages: [/galaxy](https://three.ws/galaxy), [/create](https://three.ws/create), [/agents](https://three.ws/agents).
