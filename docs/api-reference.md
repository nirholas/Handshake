# REST API Reference

This is the reference for the three.ws HTTP API: every documented endpoint, its parameters, and its response shape. Anyone can call the free endpoints with plain `curl` (no account needed); authenticated endpoints take an API key from the [Dashboard](https://three.ws/dashboard) or a browser session. If you are new, skim the Overview below, then jump to the section for the surface you are building on.

Base URL: `https://three.ws/api`

> For the in-browser JavaScript API (the `<agent-3d>` element, `Viewer`, `Runtime`, `SceneController`, skills, memory), see [js-api.md](./js-api.md) and [web-component.md](./web-component.md). For the high-level npm SDK, see [sdk.md](./sdk.md).

The full machine-readable schema lives at [`https://three.ws/.well-known/openapi.yaml`](https://three.ws/.well-known/openapi.yaml). x402 paid endpoints are listed at [`/.well-known/x402.json`](https://three.ws/.well-known/x402.json) and the MCP endpoint is at [`/api/mcp`](https://three.ws/api/mcp).

---

## Overview

### Authentication

Most write endpoints and all user-specific reads require authentication. Pass an API key as a Bearer token or rely on a session cookie from the web UI.

```http
Authorization: Bearer sk_live_xxxxx
```

Session cookies (set after SIWE or Privy login) are accepted on all endpoints that support Bearer auth.

### Response format

All responses are JSON. Successful responses return the resource or a result object. Errors return a machine-readable code plus a human-readable description:

```json
{
	"error": "validation_error",
	"error_description": "Message describing what went wrong"
}
```

Some endpoints add extra fields (e.g. `retry_after` on rate limits). Error responses are never cached.

### Rate limits

| Tier            | Limit       |
| --------------- | ----------- |
| Authenticated   | 100 req/min |
| Unauthenticated | 20 req/min  |

Rate-limited responses return HTTP 429 with `{ "error": "...", "code": "RATE_LIMITED" }`.

---

## Agents API

### List agents

```
GET /api/agents
```

Returns all of the authenticated user's agents (oldest first, no pagination). Requires auth.

**Response**

```json
{
	"agents": [
		{
			"id": "abc123",
			"name": "Aria",
			"description": "Product guide",
			"avatar_url": "https://three.ws/avatars/default.glb",
			"thumbnail_url": "https://three.ws/avatars/thumbs/default.png",
			"creator_address": "0xabc...",
			"created_at": "2025-01-15T10:00:00Z",
			"chain_id": 8453,
			"chain_agent_id": 42
		}
	]
}
```

Note: `encrypted_wallet_key` is always stripped from agent responses.

---

### Get my default agent

```
GET /api/agents/me
```

Returns the authenticated user's default agent, creating one automatically if none exists. Requires auth.

**Response:** Single agent object (same shape as list item above).

---

### Get agent by ID

```
GET /api/agents/:id
```

**Response:** Single agent object. Returns `404 AGENT_NOT_FOUND` if not found.

---

### Create agent

```
POST /api/agents
```

Requires auth.

**Request body**

```json
{
	"name": "Aria",
	"description": "Product guide",
	"manifest": {}
}
```

**Response** (`201`)

```json
{
	"agent": { "id": "new-agent-id", "name": "Aria" }
}
```

---

### Update agent

```
PUT /api/agents/:id
PATCH /api/agents/:id
```

Requires auth. Owner only.

**Request body:** Partial agent object. Any combination of `name`, `description`, `manifest`, or animation entries.

Animation entries are validated — each must include `name` (string) and `url` (string). Returns `400 INVALID_INPUT` if validation fails.

**Response:** Updated agent object.

---

### Delete agent

```
DELETE /api/agents/:id
```

Requires auth. Owner only. Soft-deletes the agent on the platform. Does not affect any on-chain registration.

**Response:** `{ "ok": true }`

---

### Signed manifest

```
GET  /api/agents/:id/manifest/signed
GET  /api/agents/:id/manifest/history
POST /api/agents/:id/manifest/publish
GET  /api/manifest-verify?cid=<cid>
```

The agent's full configuration, system prompt included, canonicalized, ed25519-signed by the platform attester identity, and pinned to IPFS. Published automatically on every persona save. The first three reads are public and CORS-open; `publish` is owner-only.

**`GET /manifest/signed` response**

```json
{
	"agent_id": "b2b1...",
	"cid": "bafy...",
	"pinned": true,
	"digest": "3f9c...",
	"issuer": "6Yb...",
	"signed_at": "2026-08-11T12:00:00.000Z",
	"verified": true,
	"gatewayUrls": ["https://ipfs.io/ipfs/bafy..."],
	"verifyUrl": "/api/manifest-verify?cid=bafy...",
	"envelope": { "spec": "threews.agent.manifest.v1", "manifest": {} }
}
```

Returns `404 not_published` when the agent has never published a manifest.

**`GET /api/manifest-verify`** fetches the envelope from public IPFS gateways (not from our database), verifies the signature, and diffs the pinned manifest against the agent's live configuration. Accepts `cid`, `digest`, or `agent`. `verified` is true only when the signature checks out **and** the issuer is the platform identity; `signature_valid` and `issuer_trusted` are reported separately so an envelope signed by an unknown key can never read as ours. `drift.changed` names every field that moved since the pin.

Verify it yourself, with no account:

```bash
node scripts/verify-agent-manifest.mjs --cid bafy...
```

Full reference: [Agent Manifest](./agent-manifest.md#signed-manifests-v03). Wire format: [specs/AGENT_MANIFEST.md](../specs/AGENT_MANIFEST.md#signed-envelope-v03).

---

### Link wallet to agent

```
POST /api/agents/:id/wallet
```

Requires auth. Owner only. Links an Ethereum wallet to the agent for signing actions.

**Request body**

```json
{
	"address": "0xabc...",
	"signature": "0x..."
}
```

**Response:** `{ "ok": true }`

---

### Unlink wallet from agent

```
DELETE /api/agents/:id/wallet
```

Requires auth. Owner only.

**Response:** `{ "ok": true }`

---

### Get agents by Ethereum address

```
GET /api/agents/by-address/:address
```

Returns all agents owned by the given Ethereum address. No auth required.

**Response:** Array of agent objects.

---

### Resolve agent by ENS name

```
GET /api/agents/ens/:name
```

Resolves an agent by ENS name (e.g., `myagent.eth`). No auth required.

**Response:** Single agent object.

---

## Widgets API

### List widgets

```
GET /api/widgets
```

Requires auth (session cookie, or bearer token with `avatars:read`). Returns the authenticated user's widgets, newest-updated first (up to 500), including joined avatar data.

**Response**

```json
{
	"widgets": [
		{
			"id": "wdgt_abc123def456",
			"avatar_id": "a1b2c3d4-...",
			"type": "turntable",
			"name": "Product Hero",
			"config": { "rotationSpeed": 0.5, "background": "#0a0a0a" },
			"is_public": true,
			"view_count": 42,
			"created_at": "2025-01-15T10:00:00Z",
			"updated_at": "2025-01-15T10:00:00Z",
			"avatar": {}
		}
	]
}
```

---

### Get widget by ID

```
GET /api/widgets/:id
```

Public widgets are readable by anyone. Private widgets require auth and ownership. Increments view counter (owner views excluded). Demo widget IDs return fixture data with aggressive cache headers.

**Response:** Single widget object.

---

### Create widget

```
POST /api/widgets
```

Requires auth. Bearer token must have `avatars:write` scope.

**Supported widget types:** `turntable`, `animation-gallery`, `talking-agent`, `passport`, `hotspot-tour`, plus the additional live types in the [Widget Studio](https://three.ws/studio) type grid (pump.fun feeds, bonding curve, walking avatar, and more).

**Request body**

```json
{
	"name": "Product Hero",
	"type": "turntable",
	"avatar_id": "a1b2c3d4-...",
	"config": {
		"rotationSpeed": 0.5,
		"background": "#0a0a0a"
	},
	"is_public": true
}
```

`name` is required; `avatar_id` is optional (must be an avatar you own, or a public one); `config` is validated against the type's schema ([src/widget-types.js](../src/widget-types.js)); `is_public` defaults to `true`.

**Response** (`201`)

```json
{
	"widget": {
		"id": "wdgt_abc123def456",
		"type": "turntable",
		"name": "Product Hero",
		"config": {},
		"is_public": true
	}
}
```

Widget IDs use the format `wdgt_` + 12 random base64url characters. The embed URL for a widget is `https://three.ws/widget#widget=<id>&kiosk=true`.

---

### Update widget

```
PATCH /api/widgets/:id
```

Requires auth. Owner only. Accepts partial updates to `name`, `config`, `is_public`, `avatar_id`, or `type`.

**Response:** Updated widget object.

---

### Delete widget

```
DELETE /api/widgets/:id
```

Requires auth. Owner only. Soft-deletes via `deleted_at` timestamp.

**Response:** `{ "ok": true }`

---

### Duplicate widget

```
POST /api/widgets/:id/duplicate
```

Requires auth. Owner only; bearer tokens need `avatars:write`. Clones the widget's type, name, config, avatar, and visibility into a new row with a freshly minted `wdgt_` id and ` (copy)` appended to the name (truncated to 120 characters). Cookie-session callers must send `X-CSRF-Token`; bearer callers are exempt.

**Response** (`201`): the new widget object, same shape as create.

---

### Widget stats

```
GET /api/widgets/:id/stats
```

Requires auth. Owner only; bearer tokens need `avatars:read`. Returns the analytics envelope behind the dashboard's widget card: lifetime `view_count`, `last_viewed_at`, an 8-day zero-filled `recent_views_7d` sparkline, and the top five `top_referers` / `top_countries`.

Talking-agent widgets additionally get `chat_count`, an 8-day `recent_chats_7d` sparkline of visitor messages, `top_questions` (visitor messages clustered by normalized prefix), `knowledge` (`doc_count` / `chunk_count` / `token_count`), and `sessions_7d` (`thread_count`, `avg_seconds`, `total_messages`). Those five fields are `null` for every other type. Response is cached `private, max-age=30`.

---

### Widget chat

```
POST /api/widgets/:id/chat
```

Talking-agent widgets only. Public widgets accept anonymous visitors; a private widget answers `404` to anyone but its owner. Rate limited per (IP, widget) at the owner's `config.visitorRateLimit.msgsPerMinute` (default 8); the owner's own preview is exempt.

**Request body:** `{ message, history?, provider?, model?, visitor_id?, thread_id? }`. `message` is 1 to 4000 characters, `history` is up to 40 `{ role, content }` turns, and `visitor_id` / `thread_id` are opaque client-minted ids (8 to 64 url-safe characters) used to group transcripts. `provider` / `model` are honoured only when the owner left the brain on `auto` or a named provider; an owner who pinned `none` or `custom` cannot be overridden by a visitor.

**Response:** an SSE stream (`text/event-stream`) with an `event: message` frame carrying `{ reply, actions }`, then `event: done`. Upstream trouble sends `event: error` instead. `actions` only ever contains skills the owner enabled (`wave`, `lookAt`, `playClip`, `remember`). Validation failures answer with an ordinary JSON `400` before the stream opens.

Every turn on a real widget is persisted to its transcript with PII redacted; the public gallery's demo fixtures are stateless and keep no transcript. Replies the platform generated itself (no provider configured, or the whole failover chain refused) are stored with no provider or model attribution.

---

### Widget transcripts

```
GET /api/widgets/:id/transcripts
GET /api/widgets/:id/transcripts?thread_id=<id>
GET /api/widgets/:id/transcripts?format=csv
```

Requires auth. Owner only; bearer tokens need `avatars:read`. The list form returns `{ threads, next_cursor, totals }`, newest thread first, `limit` 1 to 100 (default 25) with keyset pagination through `before=<ISO timestamp>`. Passing `thread_id` returns `{ thread, messages }` for one conversation, or `404` if that thread is not on this widget. `format=csv` downloads up to 5000 messages as an attachment for spreadsheet review.

---

### Widget knowledge base

```
GET    /api/widgets/:id/knowledge
GET    /api/widgets/:id/knowledge?test=<query>&top_k=<n>
POST   /api/widgets/:id/knowledge
DELETE /api/widgets/:id/knowledge?doc_id=<id>
```

Requires auth. Owner only; bearer tokens need `avatars:read` for `GET` and `avatars:write` for the rest.

`GET` lists the widget's docs with `status` (`queued`, `processing`, `ready`, `failed`), chunk and token counts. Adding `test=` runs the retrieval debugger: it embeds the probe query and returns the top-K matching chunks with cosine scores, so you can confirm a doc is reachable without spending a chat turn.

`POST` ingests one document (talking-agent widgets only, 25 docs per widget). Body is one of `{ source_type: "url", source_url }`, or `{ source_type: "text" | "markdown" | "pdf", content, title }`. URLs are fetched and stripped to text server-side; PDFs are extracted in the browser and posted as text. Small docs embed inline and come back `ready`; large ones return `queued` and finish on the background worker.

`DELETE` removes one doc and its chunks by `doc_id`.

The knowledge routes need an embedding provider on the server (`NVIDIA_API_KEY` or `OPENAI_API_KEY`); without one they answer `503 embedder_unavailable` rather than guessing.

---

### Open Graph share card

```
GET /api/widgets/og?id=wdgt_abc123def456
GET /api/widgets/:id/og
```

Returns the widget's 1200×630 share-card image (`image/svg+xml`), used as the `og:image` by social preview scrapers (Slack, Discord, X) and as the auto poster for `embed.js`. Both URL forms serve the same card. No auth required.

---

### oEmbed

```
GET /api/widgets/oembed?url=https%3A%2F%2Fthree.ws%2Fw%2Fwdgt_abc123
```

oEmbed endpoint for rich embeds in Notion, Substack, and other oEmbed-compatible platforms. Accepted `url` forms: `/w/<id>` (canonical), `/widget#widget=<id>`, and the legacy `/app#widget=<id>` and `/#widget=<id>`. No auth required.

**Response:** oEmbed JSON with `type`, `html`, `width`, `height`, `title`, `provider_name`.

---

## Agent Actions API

### List agent actions

```
GET /api/agent-actions
```

**Query parameters**

| Parameter  | Type    | Description                  |
| ---------- | ------- | ---------------------------- |
| `agent_id` | string  | Required. Filter by agent ID |
| `limit`    | integer | Max results (default: 20)    |
| `cursor`   | string  | Cursor for keyset pagination |

**Response**

```json
{
	"actions": [
		{
			"id": "act_xyz",
			"agent_id": "abc123",
			"type": "speak",
			"payload": { "text": "Hello, welcome!" },
			"source_skill": "greeting",
			"signature": "0x...",
			"signer_address": "0xabc...",
			"created_at": "2025-01-15T10:05:00Z"
		}
	],
	"cursor": "2025-01-14T10:05:00Z"
}
```

---

### Log agent action

```
POST /api/agent-actions
```

Append-only. Actions are never deleted. Optionally include an ERC-191 signature for on-chain verifiability.

**Request body**

```json
{
	"agent_id": "abc123",
	"type": "speak",
	"payload": { "text": "Hello, welcome!" },
	"source_skill": "greeting",
	"signature": "0x...",
	"signer_address": "0xabc..."
}
```

**Response:** `{ "ok": true }` (non-blocking, best-effort)

---

### Batch recent activity for many agents

```
GET  /api/agents/activity?ids=<id>,<id>,...
POST /api/agents/activity   { "ids": ["<id>", "<id>"] }
```

Recent activity for a **list** of agents in one round-trip, plus which of them
currently have a live screen caster pushing frames. Built for grids: a wall of
agent cards would otherwise need one request (or one SSE stream) per card, and a
browser only allows a handful of concurrent connections per origin.

Public read, no auth. Up to 60 ids per call; anything that is not a UUID is
dropped, and unknown ids are simply absent from `activity`. Each agent returns
its 24 most recent actions, oldest-first, in the same entry shape the `log`
event of the per-agent SSE stream (`GET /api/agent-screen-stream?agentId=<id>`)
emits, so one renderer handles both.

**Query / body parameters**

| Parameter | Type     | Description                                                  |
| --------- | -------- | ------------------------------------------------------------ |
| `ids`     | string[] | Required. Agent IDs. Comma-separated on GET, an array on POST |

**Response**

```json
{
	"activity": {
		"abc123": [
			{ "ts": 1786573115539, "activity": "Launched $THREE", "type": "pumpfun.launch" },
			{ "ts": 1786573802902, "activity": "Defended floor at 0.51 SOL", "type": "mm_defend",
			  "mm": { "type": "mm_defend", "floorSol": 0.5, "priceSol": 0.51, "sizeSol": 2,
			          "sideBuy": true, "simulate": false, "signature": null, "mint": null } }
		]
	},
	"casting": ["abc123"]
}
```

`casting` lists the subset of the requested ids whose screen frame is still live
in the frame store. A client typically renders every agent's `activity` straight
away and opens a real SSE stream only for the ids in `casting`.

**Example**

```bash
curl -s "https://three.ws/api/agents/activity?ids=$AGENT_A,$AGENT_B" \
  | jq '{casting, counts: (.activity | map_values(length))}'
```

---

## Agent Memory API

### Fetch agent memory

```
GET /api/agent-memory
```

**Query parameters**

| Parameter | Type    | Description                                                       |
| --------- | ------- | ----------------------------------------------------------------- |
| `agentId` | string  | Required. The agent's ID                                          |
| `type`    | string  | Filter by memory type: `user`, `feedback`, `project`, `reference` |
| `since`   | string  | ISO 8601 timestamp — return only memories updated after this time |
| `limit`   | integer | Max results (default: 50)                                         |

**Response**

```json
{
	"memories": [
		{
			"id": "mem_abc",
			"agent_id": "abc123",
			"type": "user",
			"content": "User prefers concise answers.",
			"salience": 0.8,
			"expires_at": null,
			"client_id": "local-uuid-123",
			"created_at": "2025-01-15T10:00:00Z",
			"updated_at": "2025-01-15T10:00:00Z"
		}
	]
}
```

---

### Upsert memory entry

```
POST /api/agent-memory
```

Idempotent — uses `client_id` as a conflict key. If a memory with the same `client_id` already exists for this user, it is updated rather than duplicated. Users cannot overwrite another user's memory that shares the same `client_id`.

**Request body**

```json
{
	"agent_id": "abc123",
	"type": "feedback",
	"content": "Stop summarizing at end of responses.",
	"salience": 0.9,
	"expires_at": null,
	"client_id": "local-uuid-456"
}
```

**Valid types:** `user`, `feedback`, `project`, `reference`

**Response:** `{ "id": "mem_xyz", "ok": true }`

---

### Delete memory entry

```
DELETE /api/agent-memory/:id
```

Requires auth. Deletes a single memory by its platform ID.

**Response:** `{ "ok": true }`

---

## Memory seed connectors API

Public-footprint readers that turn an account handle into the raw material for a
memory seed, plus the synthesizer that writes the seed itself. This is the lane
behind [/demos/memory-seed](https://three.ws/demos/memory-seed) and the seed
widget in `src/memory-seed.js`.

Everything these endpoints read is already public. They are read-only, request
no OAuth from the visitor, and store nothing; the consent-gated seeding flows
that do write to an agent live at `/api/agents/:id/memory/seed/*` and are
documented in [GitHub](./github-memory-seeding.md), [X](./x-memory-seeding.md)
and [Farcaster](./farcaster-memory-seeding.md) memory seeding.

The three connectors are unauthenticated GETs, rate limited per IP, and cached
at the edge for 5 minutes. A connector that cannot reach its upstream answers
`200` with `{ "ok": false, "reason", "detail" }` so a partly-configured
deployment degrades to a greyed-out card instead of a failed page; a bad handle
is still a `4xx`.

### GitHub footprint

```
GET /api/seed/github?handle=<user>
```

No credentials required. `GITHUB_TOKEN` is used when present, purely for the
higher rate limit.

```bash
curl -s 'https://three.ws/api/seed/github?handle=nirholas'
```

```json
{
	"ok": true,
	"handle": "nirholas",
	"name": "nich",
	"bio": "",
	"followers": 617,
	"public_repos": 223,
	"top_repos": [
		{
			"name": "fresh-start",
			"description": "The original repo, restored.",
			"stars": 6250,
			"language": null,
			"html_url": "https://github.com/nirholas/fresh-start"
		}
	],
	"top_readme_excerpt": "# fresh-start"
}
```

Errors: `400 invalid_request` (no handle), `400 invalid_handle` (illegal
characters), `404 not_found` (no such user), `502 upstream_error`.

---

### Farcaster footprint

```
GET /api/seed/farcaster?handle=<fname-or-fid>
```

No credentials required. Reads through the platform's shared Farcaster client,
which prefers Neynar when `NEYNAR_API_KEY` is set and otherwise falls back to a
public Farcaster hub over HTTP (`FARCASTER_HUB_URL`, default
`https://hub.pinata.cloud`).

`lane` names the rung that answered. The hub serves raw protocol messages and
therefore has no reaction counts, so `follower_count`, `following_count` and
per-cast `engagement` are `null` on that lane rather than `0`. Casts are ranked
by engagement where the lane knows it and by recency where it does not, with
replies, link-only posts and duplicates dropped.

```bash
curl -s 'https://three.ws/api/seed/farcaster?handle=dwr'
```

```json
{
	"ok": true,
	"lane": "hub",
	"handle": "dwr",
	"fid": 3,
	"display_name": "Dan Romero",
	"bio": "Working on Farcaster",
	"follower_count": null,
	"recent_casts": [
		{
			"text": "Best store-bought eggnog available on the west coast",
			"timestamp": "2025-11-28T01:35:34.000Z",
			"engagement": null
		}
	]
}
```

Errors: `400 invalid_request`, `400 invalid_handle`, `404 not_found`. A hub
answers an unknown fname with `400` and a `NotFound` detail; that is normalised
to a `404` here so a typo cannot read as an outage.

---

### X footprint

```
GET /api/seed/x?handle=<user>
```

X has no keyless public read lane, so this connector needs one of two credential
sets and reports `ok: false` without either:

1. `TWITTER_BEARER_TOKEN`, an app-only bearer from the developer portal.
2. `X_API_KEY` + `X_API_SECRET`, the OAuth 1.0a consumer pair. The handler
   exchanges them for an app-only bearer at runtime via `appLogin()`, so a
   deployment that already holds the changelog poster's app credentials needs
   nothing new provisioned.

```bash
curl -s 'https://three.ws/api/seed/x?handle=jack'
```

```json
{
	"ok": true,
	"handle": "jack",
	"name": "jack",
	"bio": "no state is the best state",
	"follower_count": 11300858,
	"tweet_count": 30894,
	"recent_tweets": [
		{
			"text": "joel is awesome",
			"created_at": "2026-08-10T21:54:11.000Z",
			"likes": 1458,
			"retweets": 87,
			"replies": 115
		}
	],
	"top_topics": [{ "topic": "agents", "count": 4 }]
}
```

Errors: `400 invalid_request`, `400 invalid_handle`, `404 not_found`. A rate
limit or outage on the timeline read keeps the profile payload and returns an
empty `recent_tweets` rather than failing the request.

---

### Synthesize a memory seed

```
POST /api/seed/synthesize
```

Requires auth (session cookie or bearer token). Takes any subset of the three
connector payloads verbatim and returns a 200-300 word markdown memory seed. The
completion runs on the platform LLM chain (`api/_lib/llm.js`), which leads with
free and keyless providers, so no provider key is required.

**Request body**

```json
{
	"connectors": {
		"github": { "ok": true, "handle": "nirholas", "top_repos": [] },
		"x": { "ok": true, "handle": "jack" },
		"farcaster": { "ok": true, "handle": "dwr", "fid": 3 }
	}
}
```

Connector payloads carrying `ok: false` are ignored. At least one usable payload
is required.

**Response**

```json
{
	"ok": true,
	"memory_seed": "### Interests\nThe user is a prolific builder...",
	"sources_used": ["github", "x", "farcaster"],
	"tokens_used": 2670,
	"usage": { "input_tokens": 2300, "output_tokens": 370 },
	"model": "gemini-3.1-flash-lite"
}
```

Errors: `401 unauthorized`, `400 validation_error` (unknown key, or no connector
supplied), `400 no_signal` (every payload unusable), `429
daily_spend_cap_exceeded`, `502 upstream_error`, `503 llm_unavailable`.

---

## Chat / LLM API

### Agent chat

```
POST /api/chat
```

Send a message to an agent's LLM runtime. Proxied through the platform for auth and rate limiting. Requires auth.

**Request body**

```json
{
	"agent_id": "abc123",
	"messages": [{ "role": "user", "content": "What animations do you have?" }],
	"context": {
		"model_name": "avatar.glb",
		"animations": ["wave", "idle", "dance"],
		"settings": {}
	}
}
```

The `context` object is included in the system prompt so the model knows what's loaded in the viewer.

**Available action tools**

The LLM can invoke these viewer actions in its response:

| Tool                 | Description                   |
| -------------------- | ----------------------------- |
| `setWireframe`       | Toggle wireframe mode         |
| `setSkeleton`        | Toggle skeleton overlay       |
| `setGrid`            | Toggle ground grid            |
| `setAutoRotate`      | Start/stop auto-rotation      |
| `setBgColor`         | Set background color          |
| `setTransparentBg`   | Toggle transparent background |
| `setEnvironment`     | Set environment map           |
| `takeScreenshot`     | Capture viewport screenshot   |
| `loadModel`          | Load a different model URL    |
| `runValidation`      | Run glTF validation           |
| `showMaterialEditor` | Open material editor UI       |

**Response (streaming SSE)**

```
data: {"type": "content", "text": "I have three animations..."}
data: {"type": "tool_call", "name": "play_clip", "args": {"name": "wave"}}
data: {"type": "done"}
```

Usage events (token counts, latency, triggered actions) are recorded after each request.

---

### Brain proxy (multi-provider LLM)

```
POST /api/brain/chat
```

Server-Sent Events stream from a unified multi-provider LLM gateway. Used by the `<agent-3d>` element when `brain="…"` is set without a custom `key-proxy`. The "we-pay" mode deducts from the agent's monthly token budget and enforces the agent's embed policy (allowed origins, allowed surfaces).

**Request body**

```json
{
	"provider": "claude-sonnet-5",
	"messages": [{ "role": "user", "content": "Hello" }],
	"system": "You are a friendly product guide.",
	"maxTokens": 1024
}
```

**Supported `provider` IDs**

| Provider            | Network          | Tier     |
| ------------------- | ---------------- | -------- |
| `claude-opus-5`     | Anthropic        | flagship |
| `claude-sonnet-5`   | Anthropic        | balanced |
| `claude-opus-4-7`   | Anthropic        | flagship |
| `claude-sonnet-4-6` | Anthropic        | balanced |
| `claude-haiku-4-5`  | Anthropic        | fast     |
| `gpt-5.6-sol`       | OpenAI           | flagship |
| `gpt-5.6-terra`     | OpenAI           | balanced |
| `gpt-5.6-luna`      | OpenAI           | fast     |
| `o3` / `o3-pro`     | OpenAI           | reasoning |
| `qwen-*`            | Qwen / Alibaba   | varies   |
| `openrouter:*`      | OpenRouter (any) | varies   |

Legacy ids `gpt-4o`, `gpt-4o-mini`, and `o3-mini` are accepted and alias forward to `gpt-5.6-sol`, `gpt-5.6-luna`, and `o3`. Call `GET /api/brain/chat` for the live list of providers actually available on the current deployment (depends on which provider keys are configured).

**Response (SSE)**

| Event   | Payload                                     |
| ------- | ------------------------------------------- |
| `meta`  | `{ provider, label, network, model, tier }` |
| `first` | `{ firstTokenMs }`                          |
| (data)  | JSON-encoded text chunk                     |
| `done`  | `{ elapsedMs, firstTokenMs, usage }`        |
| `error` | `{ message, elapsedMs }`                    |

**Rate limits:** Per-IP and per-agent limits apply in addition to the standard platform limits. Failed upstream calls automatically fall back to OpenRouter where possible.

---

### Direct Anthropic proxy (legacy)

```
POST /api/llm/anthropic?agent=<agent_id>
```

Older single-provider proxy. Request/response shape matches the [Anthropic Messages API](https://docs.anthropic.com/en/api/messages) exactly. New integrations should use `/api/brain/chat` instead — it supports more providers and emits richer events.

**Who may call it.** This lane is billed to the platform's own provider keys, so it is scoped to the browser embed it exists for:

| Caller | Result |
|---|---|
| Browser on `three.ws` or an origin the agent owner allowlisted | Served |
| Browser on any other origin | `403 embed_denied_origin` |
| No `Origin`/`Referer` header (scripts, servers) and no credentials | `403 embed_denied_origin`. Omitting the header is not a way around the allowlist |
| No `Origin`/`Referer` header, with a session cookie or bearer API key | Served, attributed to that account |

**Model selection.** `model` in the body may switch between free lanes freely. A host-billed model (the Claude and Grok families) runs only when the agent owner selected it in the dashboard, which stores it on the embed policy; any other request for one is served with the policy's configured model instead. The response body reports the model that actually ran.

**Ceilings.** Per-IP and per-agent rate limits, the agent's monthly call quota and token budget, and a platform-wide ceiling across every host-key-billed request combined. A saturated platform ceiling returns `429`.

**Request normalisation.** Model generations disagree about which request fields they accept, and sending the wrong one returns a hard `400` from the upstream. Rather than surface that to an embed, the proxy adapts the body to the model it is about to call:

| Field you send | What happens |
|---|---|
| `temperature` | Dropped for Opus 4.7 and the Claude 5 family, which reject sampling parameters. Passed through unchanged for every other model. |
| `thinking: {type:"enabled", budget_tokens:N}` | Rewritten to `{type:"adaptive"}` — the token-budget form was removed in the current generation. |
| `thinking: {type:"disabled"}` | Dropped for Fable/Mythos 5, where thinking is always on and an explicit config is rejected. |
| `max_tokens` below 4096 | Raised to 4096 on models that think by default. Their `max_tokens` covers reasoning *and* visible text, so a tight cap can be spent entirely on reasoning and return an empty reply. A budget already above the floor is never lowered. |
| `system` (long, plain string) | Given a prompt-cache breakpoint, so repeat turns re-read the prefix at roughly a tenth of the input price. The length required to qualify differs per model; below it the prompt is sent unchanged. Pass `system` as a block array yourself to control placement, and the proxy leaves it alone. |

Your original body is never mutated, and none of this changes the response shape.

**Usage accounting.** When a response is served from the prompt cache, Anthropic reports `usage.input_tokens` as the *uncached remainder only*, with the rest split across `cache_read_input_tokens` and `cache_creation_input_tokens`. The `input_tokens` figure recorded against your agent's monthly budget is the sum of all three, so a cached turn still counts the full prompt it sent.

---

### Persona extraction

```
POST /api/persona/extract
```

Turns a short onboarding interview (or a block of the person's own writing) into a structured persona profile you can save on an agent and reuse as its voice. Requires auth: a session cookie, or a bearer API key carrying `avatars:read` or `avatars:write`. Try it live at [/demos/persona-extract.html](https://three.ws/demos/persona-extract.html).

**Request body**: send exactly one of `answers` or `freeform`.

```json
{
	"answers": [
		{ "question": "How do you like people to talk to you?", "answer": "Short. No preamble. Give me the number and the tradeoff." },
		{ "question": "What are you into?", "answer": "Solana infra, GPU pipelines, and shipping fast." },
		{ "question": "What phrases do you hate?", "answer": "Circle back. Synergy." }
	]
}
```

| Field      | Type                                   | Notes                                                                                  |
| ---------- | -------------------------------------- | -------------------------------------------------------------------------------------- |
| `answers`  | array of `{question, answer}`           | 1 to 12 entries. Both strings required and non-empty; each is truncated at 1200 chars. |
| `freeform` | string                                  | Alternative to `answers`: any sample of the person's writing. Truncated at 8000 chars. |

`freeform` wins when both are present. A body with neither is a `400`.

**Response `200`**

```json
{
	"persona": {
		"tone": "Direct and to the point with a focus on key information",
		"vocabulary": ["number", "tradeoff", "shipping fast", "infra", "pipelines"],
		"interests": ["Solana", "GPU pipelines", "software development"],
		"communication_style": "terse",
		"dont_say": ["Circle back", "Synergy"],
		"sample_greeting": "What's the key issue and what are the numbers?"
	},
	"model": "Meta-Llama-3_3-70B-Instruct",
	"tokens_used": 516,
	"tokens_in": 415,
	"tokens_out": 101,
	"latency_ms": 3852
}
```

`communication_style` is always one of `terse`, `detailed`, `playful`, `analytical`, `warm`. The server clamps the model's output before returning it: at most 10 `vocabulary` entries, 5 `interests`, and 3 `dont_say` entries. `model` names the provider rung that actually served the call, which varies with the failover chain, so do not pin behaviour to it.

**Rate limit:** 5 per user per day. A malformed body is rejected before the limiter runs, so a typo never costs you a call.

---

### Persona preview

```
POST /api/persona/preview
```

Replies to one message in the voice of a persona, so a user can audition a profile before saving it. Same auth as extraction. Stateless: pass the persona on every call.

**Request body**

```json
{
	"persona": {
		"tone": "Direct and to the point with a focus on key information",
		"vocabulary": ["number", "tradeoff", "shipping fast"],
		"communication_style": "terse",
		"dont_say": ["Circle back"]
	},
	"user_message": "Should we ship the new forge lane today?"
}
```

| Field          | Type   | Notes                                                                                                   |
| -------------- | ------ | ------------------------------------------------------------------------------------------------------- |
| `persona`      | object | Any object; the shape returned by `/api/persona/extract` is what the prompt is written for. Rejected above 8000 chars serialized, because the persona is pinned into the system prompt verbatim and its size is prompt size. |
| `user_message` | string | Required, non-empty. Truncated at 1500 chars.                                                           |

**Response `200`**

```json
{
	"reply": "What are the performance numbers on the GPU pipelines? We need to ship fast, but only if the infra tradeoff is net positive.",
	"model": "gemini-3.1-flash-lite",
	"tokens_used": 326,
	"tokens_in": 300,
	"tokens_out": 26,
	"latency_ms": 3016
}
```

Replies are capped at 1 to 2 sentences by design; this endpoint is an audition surface, not a chat runtime. For a real conversation use [`POST /api/chat`](#agent-chat) or [`POST /api/brain/chat`](#brain-proxy-multi-provider-llm).

**Rate limit:** 30 per user per hour.

**Errors (both persona routes)**

| Status | `error`                     | Meaning                                                                                  |
| ------ | --------------------------- | ---------------------------------------------------------------------------------------- |
| `400`  | `bad_request`               | Malformed or missing fields. `error_description` names the offending one.                |
| `401`  | `unauthorized`              | No session and no bearer key with an `avatars:*` scope.                                  |
| `415`  | `bad_request`               | `content-type` was not `application/json`.                                               |
| `429`  | `rate_limited`              | Per-user budget spent. `retry_after` and the standard `ratelimit-*` headers are set.     |
| `429`  | `daily_spend_cap_exceeded`  | The account's daily LLM spend ceiling, not the call-count limiter. Resets on its own window. |
| `502`  | `upstream_error`            | Every provider in the chain failed or returned an empty completion. Retryable.           |
| `502`  | `parse_error`               | The model answered with something other than a usable persona (extraction only). Retryable. |
| `503`  | `config_missing`            | The deployment has no LLM provider configured.                                           |

Both routes run the shared multi-provider failover chain, so a single upstream `429`/`5xx` falls through to the next provider instead of reaching you.

---

## TTS API

### Voice catalog

```
GET /api/tts/catalog
```

Every voice the platform can synthesize, across every provider, in one shape.
Auth is optional: anonymous callers see the keyless lanes (Microsoft Edge,
Gemini, NVIDIA), a session adds the metered ones (OpenAI, ElevenLabs), and an
`x-eleven-key` header adds that account's ElevenLabs voices.

**Query**

| Param | Meaning |
| --- | --- |
| `provider` | `edge`, `gemini`, `nvidia`, `openai`, `elevenlabs`. Omit for all. Anything else is a `400 validation_error` listing the lanes that exist. |
| `q` | Substring match over name, id, locale, and labels. |
| `language` | Primary subtag or full locale, e.g. `ja`, `en-GB`. |
| `limit` | Max voices returned (default 400, max 2000). |

**Response**

```json
{
	"providers": [
		{
			"id": "edge",
			"label": "Microsoft Edge",
			"billing": "free",
			"usdPer1k": 0,
			"byok": false,
			"clone": false,
			"direction": false,
			"available": true,
			"reason": null,
			"models": [],
			"defaultVoice": "en-US-AriaNeural"
		}
	],
	"voices": [
		{
			"id": "en-GB-SoniaNeural",
			"name": "Sonia",
			"provider": "edge",
			"gender": "female",
			"locale": "en-GB",
			"language": "en",
			"labels": { "categories": ["News"], "personalities": ["Authentic"] },
			"preview_url": null
		}
	],
	"counts": { "edge": 316 },
	"total": 316,
	"truncated": false
}
```

`billing` is `free` (no vendor cost), `gcp` (platform Google credits, also free
to you), or `credits` (metered per 1,000 characters at `usdPer1k`). A lane that
cannot serve is still listed, with `available: false` and a `reason`.

### Speak on any provider

```
POST /api/tts/synthesize
```

One endpoint for every lane. Pass the `provider` + `voiceId` pair from the
catalog. The free lanes work without auth (rate-limited per IP); the metered
lanes require a session or bearer token.

**Request body**

```json
{
	"provider": "gemini",
	"voiceId": "Sulafat",
	"text": "Your agent is live.",
	"model": "gemini-2.5-flash-preview-tts",
	"direction": "Warm and unhurried, like sharing good news",
	"speed": 1.0
}
```

`model` and `direction` apply only where the lane supports them (the catalog's
`models` and `direction` fields say which). `speed` is clamped to 0.5 to 2.0.
Max 1,000 characters. ElevenLabs additionally accepts `voice_settings`.

`voiceId` must be one the chosen lane publishes. A `voiceId` the lane does not
have returns `400 validation_error` naming the id and the catalog URL to pick
from, before anything is metered; it is never quietly swapped for the lane's
default voice. Omit `voiceId` entirely to get the lane default on purpose.
ElevenLabs is the exception: its catalog grows at runtime (cloning, library
adds), so an id it does not recognize comes back as a `400` carrying the
upstream verdict rather than being pre-checked here.

**Response**

Audio binary in the lane's container (`audio/mpeg` for Edge and ElevenLabs,
`audio/wav` for Gemini and NVIDIA, caller-chosen for OpenAI). Response headers:
`x-tts-provider`, `x-tts-voice`, `x-tts-model`, `x-tts-format`,
`x-tts-cache` (`hit`/`miss`), `x-tts-billing` (`free` | `gcp` | `byok` |
`credits` | `cached`), and `x-tts-charged-usd` when credits were spent. Every
clip is cached in R2 for 30 days on a hash of the full request; cache hits are
never charged. A short credit balance returns `402 insufficient_credits` with a
`top_up_url`.

**When a lane is down**

An upstream failure answers with a single sentence a picker can render in
`error_description`, the vendor's own text in `detail`, and the lane id in
`provider`. A lane that refuses this deployment's credentials (an expired key, a
billing hold) is then withheld for a few minutes: `/api/tts/catalog` reports it
`available: false` with the reason, and a synthesis request aimed at it answers
`503 lane_unavailable` carrying `retry_with: ["edge", "nvidia"]` instead of
spending another doomed round trip. The window clears on its own, and a lane
that serves successfully is restored immediately, so nothing has to be deployed
or flipped by hand when the upstream problem is fixed. A request carrying your
own `x-eleven-key` is never gated by the platform key's outage.

### ElevenLabs Voice Library

```
GET  /api/tts/eleven/library
POST /api/tts/eleven/library
```

Search the public catalog ElevenLabs users share (`q`, `gender`, `accent`,
`age`, `category`, `language`, `use_cases`, `page`, `page_size` up to 100), then
`POST { publicUserId, voiceId, name }` to copy one into the account behind the
request (yours with `x-eleven-key`, the platform's otherwise). The POST returns
a normal `voice_id` usable with `/api/tts/synthesize`. Both require auth and an
ElevenLabs key. A key ElevenLabs rejects returns `401 invalid_key` (here and on
`/api/tts/eleven/voices`), so a client knows to ask for a new key rather than
retry a `502` that will never clear.

### Text-to-speech (ElevenLabs, streaming)

```
POST /api/tts/eleven
```

Text-to-speech via ElevenLabs with R2 caching. Requires auth.

**Limits and billing**

- Max 500 characters per request
- Platform-key requests are metered to your prepaid credit balance (top up with $THREE or SOL at `/credits`) at $0.30 per 1,000 characters, charged before synthesis and refunded on failure; an empty balance returns `402 insufficient_credits`
- Send your own ElevenLabs key in the `x-eleven-key` header to run on your account instead (no platform charge); cache hits are never charged

**Request body**

```json
{
	"voiceId": "rachel",
	"text": "Hello, welcome to my portfolio!",
	"modelId": "eleven_monolingual_v1"
}
```

`modelId` is optional. Default voice settings: `stability=0.5`, `similarity_boost=0.75`, `style=0.5`, `use_speaker_boost=true`.

**Response**

Audio binary. `Content-Type: audio/mpeg`.

A `voiceId` the account behind the request does not have returns `400 validation_error` (the charge, if any, is refunded first); a genuine ElevenLabs fault stays `502 upstream_error`.

Responses are cached in R2 by `sha256(voiceId + text + modelId)` for 30 days — identical requests return cached audio without hitting ElevenLabs.

---

## AI API — text→3D

The only text→mesh lane in the x402 / agent-payments ecosystem. Turn a text
prompt into a textured, downloadable GLB — no key, no wallet. The draft tier runs
free on the NVIDIA NIM TRELLIS lane (the same pipeline behind the `forge_free`
MCP tool and [/forge](https://three.ws/forge)). Higher quality/volume lives on
the paid [x402 forge tiers](#x402-paid-endpoints--sign-in-with-x-siwx).

### Text→3D (free)

```
POST /api/v1/ai/text-to-3d
```

Public, CORS-open, no auth. Free with a per-IP quota of **10 generations/day**
(the GPU quota is real). Above the quota the endpoint returns `429` with
`X-RateLimit-Reset` and a pointer to the paid forge tiers — it never paywalls
silently.

**Request body**

```json
{ "prompt": "a small ceramic robot figurine" }
```

| Field    | Type   | Description                                                         |
| -------- | ------ | ------------------------------------------------------------------- |
| `prompt` | string | Describe a single object or character. 3–1000 characters. Required. |

**Response — finished inline** (the NIM often completes inside the request window):

```json
{
	"data": {
		"status": "done",
		"glb_url": "https://three.ws/cdn/forge/anon/<id>.glb",
		"viewer_url": "https://three.ws/viewer?src=https%3A%2F%2Fthree.ws%2Fcdn%2Fforge%2Fanon%2F%3Cid%3E.glb",
		"creation_id": "<uuid>",
		"backend": "nvidia",
		"tier": "draft"
	}
}
```

**Response — queued** (poll the existing free job endpoint until `status: "done"`):

```json
{
	"data": {
		"status": "pending",
		"job": "f1.<signed-token>",
		"poll_url": "/api/forge?job=f1.<signed-token>",
		"viewer_url": null,
		"backend": "nvidia",
		"tier": "draft"
	}
}
```

Poll with `GET /api/forge?job=<job>` — it returns `{ status: "queued" | "done" | "failed", glb_url? }`.

A generation that fails mid-flight on one engine is automatically re-dispatched
to the next configured free lane (up to 3 backups); the poll keeps reporting
`status: "running"` with the new `backend` plus a `failover_from` field, so the
switch is visible but never terminal. Only when every automatic lane is
exhausted does the poll return `status: "failed"` — and when other configured
engines could still serve a fresh retry, it carries `retryable: true` and
`retry_backends: ["huggingface", …]` so a client can resubmit the same request
with an explicit `backend` instead of dead-ending.

**Example**

```bash
curl -s -X POST https://three.ws/api/v1/ai/text-to-3d \
  -H 'content-type: application/json' \
  -d '{"prompt":"a small ceramic robot figurine"}'
```

**Errors**

| Status      | Code                          | Meaning                                                                                    |
| ----------- | ----------------------------- | ------------------------------------------------------------------------------------------ |
| `400`       | `validation_error`            | `prompt` missing, shorter than 3 chars, or over 1000                                       |
| `429`       | `quota_exceeded`              | Daily free quota spent; see `X-RateLimit-Reset` and `upgrade.endpoint` (`/api/x402/forge`) |
| `503`       | `not_configured`              | The NVIDIA NIM lane isn't configured on this deployment (`NVIDIA_API_KEY`)                 |
| `502`/`504` | `lane_error` / `lane_timeout` | The generation lane failed or timed out — retry                                            |

### Text→3D (ChatGPT Actions surface)

```
POST /api/3d/studio
GET  /api/3d/studio?job=<id>
```

Public, CORS-open, no auth. The REST contract behind the **"three.ws 3D Studio"**
custom GPT (its OpenAPI Actions schema lives at
`prompts/store-submissions/_generated/openai-actions.yaml`). It is a thin shaper
over the same free NVIDIA NIM TRELLIS lane as `/api/v1/ai/text-to-3d` (same
per-IP quota buckets, no extra capacity), with two store-specific rules:
responses carry only model URLs and job state (no upsell block, no pricing
paths, no internal identifiers), and every prompt passes an age-13+
content-safety gate before any GPU work starts.

**Request body**

```json
{ "prompt": "a small ceramic robot figurine" }
```

**Response, finished inline**

```json
{ "status": "done", "glbUrl": "https://three.ws/cdn/forge/anon/<id>.glb", "viewerUrl": "https://three.ws/viewer?src=…", "arUrl": "https://three.ws/api/ar?src=…&title=a%20small%20ceramic%20robot%20figurine", "format": "glb" }
```

`arUrl` is the place-in-your-room link (`GET /api/ar`, documented below):
opened on a phone it launches AR directly — Scene Viewer on Android, Quick
Look on iOS (the GLB converts to USDZ in-page) — and on desktop it falls back
to the interactive viewer. The prompt rides along as `title` to label the AR
page. This is the same lane the `/forge` and `/ar` pages use; surface it to
end users as "place it in your room".

**Response, queued** (ChatGPT Actions time out at ~45s; the lane bounds its
synchronous hold to 30s, so a slow job always returns `pending` plus a poll
handle before the Action deadline)

```json
{ "status": "pending", "job": "f1.<signed-token>", "poll": "/api/3d/studio?job=f1.<signed-token>&title=a%20small%20ceramic%20robot%20figurine", "format": "glb" }
```

Poll `GET /api/3d/studio?job=<id>&title=<label>` until `status` is `"done"`
(same shape as above, `arUrl` included) or `"error"` (`{ "status": "error",
"job", "error" }`; generation is free, so a failed job costs nothing to
retry). `title` is optional — the pending response's `poll` path already
carries it, so following that path verbatim keeps the finished AR page
labeled with the prompt.

**Errors**

| Status | Code                             | Meaning                                                              |
| ------ | -------------------------------- | -------------------------------------------------------------------- |
| `400`  | `invalid_prompt` / `bad_request` | `prompt` missing, outside 3-1000 chars, or malformed JSON            |
| `400`  | `prompt_rejected`                | The age-13+ safety gate refused the prompt; `message` says why       |
| `429`  | `rate_limited`                   | Free lane saturated; retry after `retry_after` seconds               |
| `502`  | `generation_failed`              | The lane could not start the job; retry is free                      |
| `503`  | `not_configured` / `lane_timeout`| Lane unavailable on this deployment, or slow to accept; retry later  |

### Model quality gate — `POST /api/forge-quality-check`

```
GET  /api/forge-quality-check          → capability probe
POST /api/forge-quality-check          → score a model's realism / quality
```

Public, CORS-open, metered on the free vision buckets (sign in for a higher
limit). Scores how photoreal and complete a generated 3D model is, so a bad
result (a plastic toy, a melted blob, an incomplete or duplicated mesh) can be
caught and regenerated before a user ever sees it. It renders the GLB, sends the
render to **Vertex Gemini** (`gemini-2.5-flash`, GCP-credit-funded) with a
subject-aware photoreal rubric, and returns a structured verdict. When Vertex is
unconfigured it falls back to the free NVIDIA NIM vision lane; when no vision
provider answers at all it **fails open** (`verdict.pass: true`,
`verdict.qa_available: false`) so quality gating can never block a generation.

**Request body** — supply exactly one of `glbUrl`, `renderUrl`, or `image`:

```json
{
  "glbUrl": "https://three.ws/cdn/forge/anon/<id>.glb",
  "prompt": "a medieval knight in full plate steel armor",
  "subject": "person",
  "tier": "standard",
  "path": "image",
  "attempt": 0
}
```

- `glbUrl` — a public GLB, rendered here for scoring (preferred).
- `renderUrl` — a public image URL of an existing render.
- `image` — base64 or `data:` URI of a render.
- `prompt` — the source generation request; steers the rubric and the retry hint.
- `subject` — optional override (`person`, `animal`, `food`, `vehicle`, `plant`,
  `building`, `object`); auto-detected from the prompt otherwise.
- `tier` / `path` / `attempt` — optional; when present and the model fails the
  gate, the response includes a ready-to-run `retry` directive.

**Response**

```json
{
  "verdict": {
    "pass": false,
    "score": 34,
    "realism": 30,
    "completeness": 45,
    "subject": "person",
    "is_photoreal": false,
    "defects": ["plastic", "wrong_proportions"],
    "reason": "The armor reads as flat plastic and the proportions are off.",
    "suggested_retry_hint": "add realistic metal PBR materials and correct human proportions",
    "provider": "vertex",
    "model": "vertex-ai/gemini-2.5-flash",
    "qa_available": true,
    "render_source": "rendered_glb"
  },
  "retry": {
    "prompt": "a medieval knight in full plate steel armor, photorealistic, real photograph, high detail, accurate proportions, realistic PBR materials. Avoid: plastic or toy-like materials.",
    "tier": "standard",
    "path": "image",
    "attempt": 1,
    "reason": "retry 1/2: The armor reads as flat plastic and the proportions are off."
  }
}
```

`score` is 0-100; the pass threshold is `FORGE_QUALITY_PASS_SCORE` (default 60),
and any critical structural defect (blob, incomplete, duplicated, floating
fragments) fails the gate regardless of score. `retry` is `null` when the model
passes, when QA was unavailable (never retry on an outage), or when the retry cap
(`FORGE_QUALITY_MAX_RETRIES`, default 2) is reached. The same logic is importable
for server-side use as `runQualityGate` + `buildRetryDirective` from
`api/_lib/forge-quality-gate.js` — the generation router uses it directly.

#### Which generations are gated: `FORGE_QUALITY_GATE`

`POST /api/forge` runs this gate automatically after producing a model. Two
scorers stack: a **free deterministic** pass (`api/_lib/glb-quality.js`, reads the
glTF JSON chunk: catches blobs, zero-volume and untextured meshes on **every**
lane and reruns once) and the **vision** pass above (semantic: does it look like
the prompt). `FORGE_QUALITY_GATE` chooses which lanes pay for the vision pass:

| Value | Behavior |
| --- | --- |
| `adaptive` **(default)** | The paid **High** tier is always vision-scored. The **free Draft/Standard** lanes escalate to vision QA **only when the fast scorer can't vouch for the mesh** (a `low`/`degenerate`/untextured result, an `ok` mesh below the `FORGE_QUALITY_ADAPTIVE_MIN` confidence score, default `0.6`, or a **`planar`** mesh: one with no depth, which a reconstruction that lost its reference image returns as a full-footprint slab that otherwise scores near the top. Planar means flatter than `FORGE_QUALITY_PLANAR_FLATNESS` (default `0.2`) when the thin axis is Y, or flatter than `FORGE_QUALITY_SLIVER_FLATNESS` (default `0.05`) on X or Z, so genuinely flat subjects and slim upright characters are not swept in). A clean, textured draft ships instantly with no vision latency, so the free lane gains a semantic quality floor without slowing the common case. |
| `high` | Only the High tier is vision-scored; free lanes keep only the deterministic floor. |
| `all` | Every tier is vision-scored unconditionally (no fast-scorer shortcut). |
| `off` | No vision QA anywhere (the deterministic floor still runs). |

On a failing verdict the router runs a bounded best-of retry
(`FORGE_QUALITY_GATE_MAX_RETRIES`, default 1, clamped 0-2), keeping the
higher-scoring result. The delivered generation carries a `quality` (deterministic)
and, when scored, a `quality_gate` (vision verdict) field: the `/forge` result bar
renders these as a **Verified NN% / Low NN% / Checked** confidence chip.

**Errors**

| Status | Code                | Meaning                                                                        |
| ------ | ------------------- | ------------------------------------------------------------------------------ |
| `400`  | `bad_request`       | None of `glbUrl` / `renderUrl` / `image` supplied, or malformed JSON           |
| `413`  | `payload_too_large` | Request body over 20 MB                                                         |
| `429`  | `rate_limited`      | Free vision quota spent; see `X-RateLimit-Reset` (sign in for a higher limit)  |

A provider or render outage does **not** error — it returns `200` with
`verdict.qa_available: false`.

### AR launch — `GET /api/ar`

```
GET /api/ar?src=<glbUrl>&title=<label>&kind=<avatar?>
```

Public, keyless. The device-aware place-in-your-room lane behind every `arUrl`
the 3D endpoints return, and the same one the `/forge` and `/ar` pages use:

- **Android** → `302` straight into Google Scene Viewer (ARCore `intent://`
  URL with the GLB as the source and a browser fallback).
- **iOS** → an HTML launch page; "View in your space" enters Apple Quick Look
  (the GLB converts to USDZ in-page via the three.js `USDZExporter`).
- **Desktop** → the same page, falling back to the interactive WebGL viewer.

`src` must be a public `https` GLB/glTF URL; `title` (optional, ≤120 chars)
labels the page; `kind=avatar` marks a rigged agent body and adds the
"Bring it to life" handoff into `/irl` (camera passthrough, animation, and
conversation in the user's room). Bad input returns a designed error page,
never a crash. Pasting an `/api/ar` link into a chat app unfurls as a share
card whose image is a real render of that exact model (see the renderer
below).

### Model renderer — `GET|POST /api/render/glb`

```
GET  /api/render/glb?glbUrl=<url>&width=1200&height=630&background=%230a0a0a
POST /api/render/glb   { "glbUrl": "...", "width": 1024, "height": 1024, "background": "#0a0a0a" }
```

Public renderer: any public GLB URL in, a PNG out, the same pipeline the OG
cards use. Renders run on a CPU software rasterizer in-process (typically
200-900 ms, no browser); headless chromium stays as the failover for models
whose geometry or textures need a decoder the rasterizer does not ship (Draco,
KTX2/Basis). The GET form makes a render URL-addressable for `og:image`
unfurls, `<img>` tags, and markdown embeds; responses CDN-cache for a day so
crawlers render once per model. Dimensions clamp to 64-2048; GLBs over 10 MB are rejected before the
browser boots; only public http(s) sources are fetched (SSRF-guarded);
60 renders / 10 min / IP, a budget shared with `/api/render/avatar-clip`.

`background` is `transparent` or a CSS color (`#0a0a0a`, `#fff`,
`rgb()`/`rgba()`, `hsl()`/`hsla()`, or a named color such as `midnightblue`).
Anything else is `400 bad_request`: the value is composited into the render
page, so it is validated rather than escaped.

### Posed avatar renderer: `GET|POST /api/render/avatar-clip`

```
GET  /api/render/avatar-clip                  → the pose catalog (id, label, group)
POST /api/render/avatar-clip
{
  "glbUrl": "https://...",                    # required, public http(s)
  "width": 1024, "height": 1024,              # default 1024, clamped 64-2048
  "background": "transparent",                # or a CSS color, as above
  "posePresetId": "wave",                     # any id from the GET catalog
  "cameraOrbit": { "theta": 25, "phi": 75, "radius": null },
  "expression": { "jawOpen": 0.4 }            # ARKit-52 morph targets
}
→ image/png, plus x-render-pose / x-render-pose-label headers
```

The same renderer with a pose stage in front of it. `posePresetId` is retargeted
onto the model's own rest pose through the studio's posing stack, so a preset
lands the same way whatever naming convention the rig's skeleton uses, and a
model with no recognizable humanoid skeleton renders in its bind pose instead of
failing. `cameraOrbit.theta`/`phi` are degrees (yaw, and pitch from the top);
`radius` is meters, or `null` to auto-frame from the bounding box. An unknown
`posePresetId` is `400 unknown_pose`. Same 10 MB cap, SSRF guard, and render
budget as `/api/render/glb`.

### Animated avatar renderer: `GET /api/render/animate`

```
GET /api/render/animate                                  (the clip catalog)
GET /api/render/animate?avatar=<id>&clip=wave
GET /api/render/animate?src=https://example.com/model.glb&clip=idle&size=256
→ image/png (an animated PNG)
```

One URL, one file, a moving avatar. The response is an animated PNG, so it
plays anywhere a still image works: an `<img>` tag, a GitHub README, a Notion
page, a Discord embed. There is no player, no script and no WebGL involved on
either side.

```markdown
![my agent](https://three.ws/api/render/animate?avatar=<id>&clip=wave&size=256)
```

| Parameter | Meaning |
|---|---|
| `avatar` | Avatar UUID. Public avatars only; a private one is `404`. |
| `src` | Any public GLB URL instead of an avatar id (SSRF-guarded, 12 MB cap). |
| `clip` | Clip name from the catalog above. Default `idle`. |
| `frames` | 1-48, default 20. |
| `fps` | 1-30, default 16. |
| `size` | 64-640 square, default 320. `width`/`height` override it. |
| `bg` | `transparent` (default) or a CSS colour. |
| `focus` | `full`, `bust` or `head`. Default `full`. |
| `spin` | 0-360 degrees of turntable spread across the loop. |
| `t` | Seconds into the clip for the first frame. |

The clip is retargeted onto the model's own skeleton by bone name, so one
library clip drives Ready Player Me, Avaturn, VRM, Mixamo and Blender rigs
alike. A body that cannot take the clip (no humanoid skeleton) still animates:
the loop falls back to a full turntable rather than an error.

Calling with no parameters returns the catalog: every clip name, label and
duration in the built-in motion library. Unknown clip names are
`400 unknown_clip` and list the alternatives. Same 60 renders / 10 min / IP
budget as the renderers above; responses CDN-cache for a week.

Rendering is done by [`@three-ws/render`](../packages/render/README.md), the
GPU-free software rasterizer that also backs the OG cards.

### Forge-Off votes — `POST /api/forge-vote`

```
POST /api/forge-vote
x-forge-client: <stable browser id>
{ "creation_id": "<uuid>", "vote": true }     # upvote  (vote:false removes it)
→ { "ok": true, "creation_id": "<uuid>", "vote_count": 5, "voted": true }
```

Auth-free community curation for the Forge showcase: one vote per browser (keyed
to the same `forge:cid` id used for "Your creations"), idempotent, toggleable.
`vote_count` is the fresh authoritative tally; `voted` is your own state. Only
public, finished, non-rejected creations are votable (`404 not_votable`
otherwise); a missing/shared client id is `400 no_client_id`. 120 votes /
10 min / IP.

Read the board through the community gallery:

```
GET /api/forge-gallery?scope=community&sort=top&window=week&limit=24
x-forge-client: <stable browser id>   # optional — resolves per-card `voted`
```

`sort=fresh` (default, newest-first) or `sort=top` (most-voted); `window=week`
narrows Top to the current Forge-Off week (Monday→Monday UTC). Full feature
docs: [docs/forge-off.md](./forge-off.md).

### Model detail page read: `GET /api/forge-creation`

```
GET /api/forge-creation?id=<uuid>              → { enabled, creation }
GET /api/forge-creation?id=<uuid>&related=6    → adds `related` (suggested models)
GET /api/forge-creation?id=<uuid>&view=1       → counts one page impression
x-forge-client: <stable browser id>            # optional: resolves `voted`
```

The public by-id read behind the model detail page at `/m/<id>` (and the forge
share flow). Any finished, durably-stored creation is readable by anyone.
`creation` carries the model's prompt, GLB and preview URLs, category, engine
attributes, `vote_count` (plus your own `voted` when the client id header is
sent), `view_count`, `remix_count`, remix/royalty state, and real opt-in
creator attribution (`creatorUsername`, `creatorDisplayName`,
`creatorAvatarUrl`; all null for anonymous forges). `related` is same-category
first, newest, never the model itself. Geometry stats are not stored: the page
reads triangles/vertices live from the free `GET /api/3d/inspect?url=<glb>`.

### Delete a creation: `DELETE /api/forge-creation`

```
DELETE /api/forge-creation?id=<uuid>
x-forge-client: <stable browser id>   # required: only the owner can delete
→ { "deleted": true }
```

Permanent deletion for the "Your creations" gallery, scoped to the browser
that forged the model (the same `forge:cid` id that scopes the gallery read).
It erases everything the platform stored for that creation: the durable GLB,
the preview image, any uploaded reference photos the generation was
conditioned on (the image-to-3D source pictures), the row itself, and with it
the model's presence in the community showcase, share links, and embeds.
Votes and comments cascade away with the row. A missing client id is
`401 missing_client`; an id that doesn't exist or belongs to another browser
is `404 not_found` (indistinguishable on purpose, so ids can't be probed).
On a storage fault nothing is removed and the response is `503 delete_failed`;
retry safely.

### Model comments: `GET/POST/DELETE /api/forge-comments`

```
GET /api/forge-comments?creation_id=<uuid>&limit=30&before=<iso>
→ { "comments": [ { id, body, created_at, author_username, author_name,
                    author_avatar, is_mine } ], "total": 12, "next": "<iso>|null" }

POST /api/forge-comments            # session or Bearer + x-csrf-token
{ "creation_id": "<uuid>", "body": "<1..2000 chars>" }
→ { "ok": true, "comment": { ... } }

DELETE /api/forge-comments          # author only
{ "comment_id": "<uuid>" }
→ { "ok": true, "deleted": true }
```

The comment thread on every model page. Reads are anonymous and
cursor-paginated (`next` feeds `before`). Posting requires a signed-in session
(401 otherwise) and runs a deterministic slur pre-filter (422 `rejected`);
posting on a missing or unfinished model is 404. A new comment notifies the
model's creator through the in-app bell (`comment` type, social category) when
the model has an attributed creator. Authors can delete their own comments
only.

### Agent-forged gallery feed — `GET /api/forged`

```
GET /api/forged                    → recent agent-bought props (status done)
GET /api/forged?category=container → filter by prop family (club-decor|ar-object|
                                     diorama-set|avatar-item|vehicle|container|
                                     furniture|terrain)
GET /api/forged?status=all         → include queued/failed rows (audit view)
GET /api/forged?limit=60           → page size (default 30, max 100)
```

The public feed behind [/forged](https://three.ws/forged): 3D props the
platform's autonomous agents bought with real USDC via `POST /api/x402/forge`,
each carrying its payment provenance. Free, cached ~20s, rate-limited per IP.
Every row is a real settled generation — no synthetic entries.

**Response**

```json
{
	"props": [
		{
			"id": 42,
			"ts": "2026-07-25T18:00:11.000Z",
			"prompt": "a weathered wooden shipping crate, iron banded corners, game-ready prop",
			"category": "crate",
			"tier": "draft",
			"status": "done",
			"glb_url": "https://three.ws/cdn/forge/…​.glb",
			"novelty": 0.83,
			"cluster_id": 2,
			"price_usdc": 0.05,
			"payer": "<agent wallet address>",
			"payer_short": "wwwwwD…ccrU",
			"tx_sig": "<solana settlement signature>",
			"explorer_url": "https://solscan.io/tx/<sig>",
			"viewer_url": "/app?src=…"
		}
	],
	"stats": {
		"total": 128, "done": 117, "queued": 4,
		"spent_usdc": 6.4,
		"categories": { "crate": 30, "barrel": 29, "furniture": 30, "terrain": 28 },
		"latest_ts": "2026-07-25T18:00:11.000Z"
	}
}
```

Written by the hourly autonomous forge-content pipeline
(`api/_lib/x402/pipelines/forge-content.js`); the paid generation endpoint it
buys from is documented under `POST /api/x402/forge` in the x402 section.

---

## Materialize print API

Turn any 3D model into a real, physical object: analysis, preparation, an
itemized price, checkout in USDC on Solana, tracked fulfillment, and a
certificate of authenticity attested on-chain. Product guide:
[Materialize](./materialize.md). Wire contracts:
[specs/PRINT_PIPELINE.md](../specs/PRINT_PIPELINE.md).

Analysis and quoting are **free and keyless**. Only checkout costs money.

### Catalog

```http
GET /api/print/catalog
```

Materials, size presets, finishes, shipping zones and the pricing parameters
every quote is computed from. The public output omits the platform margin
fields. This is the source of truth for `materialId`; do not hardcode ids.

```json
{
  "version": 1,
  "currency": "USDC",
  "chain": "solana",
  "materials": [
    {
      "id": "resin-standard",
      "name": "Standard resin",
      "class": "resin",
      "minWallMm": 0.6,
      "minHeightMm": 15,
      "maxHeightMm": 180,
      "leadTimeDays": 5,
      "colorCapable": false,
      "finishes": [{ "id": "as-printed", "name": "As printed", "fee": 0 }]
    }
  ],
  "sizePresets": [{ "id": "desk", "heightMm": 120 }],
  "shipping": { "zones": [{ "id": "us" }, { "id": "eu" }, { "id": "cn" }, { "id": "row" }] }
}
```

### Analyze and quote

```http
POST /api/print/quote
```

One endpoint, two modes. Omit `materialId` and it is a pure analysis: the
printability report, free, no price. Include one and it also returns the
itemization and a signed quote token.

| Field | Type | Notes |
|---|---|---|
| `creationId` | string | A three.ws creation id. One of this or `glbUrl` is required. |
| `glbUrl` | string | A public `.glb` URL instead. |
| `materialId` | string | From the catalog. Omit for analysis only. |
| `finishId` | string | Optional, from the material's finishes. |
| `targetHeightMm` | number | Printed height. Bounded by the material and the mesh. |
| `quantity` | integer | Default `1`. Breaks at 5 and 20. |
| `country` | string | ISO 3166-1 alpha-2, for shipping. |
| `hollow` | boolean | Hollow the solid where it is geometrically safe. Changes the price. |
| `note` | string | Optional note for the operator. Read by the fabrication gate. |

```bash
curl -s https://three.ws/api/print/quote \
  -H 'content-type: application/json' \
  -d '{"creationId":"6f1b...","materialId":"resin-standard","targetHeightMm":120,"quantity":1,"country":"US"}'
```

```json
{
  "report": {
    "version": 1,
    "manifold": true,
    "shells": 1,
    "volume_cm3": 71.4,
    "bbox_mm": { "x": 62.1, "y": 120, "z": 48.3, "diagonal": 143.2 },
    "min_wall_mm": 1.42,
    "recommended_min_height_mm": { "resin": 120, "sls_nylon": 120, "full_color": 169 },
    "score": 96,
    "deductions": []
  },
  "fits": [{ "materialId": "resin-standard", "ok": true, "minHeightMm": 51, "maxHeightMm": 180 }],
  "screening": { "verdict": "allow", "stage": "quote", "policy_url": "/docs/materialize#content-policy" },
  "quote": {
    "version": 1,
    "currency": "USDC",
    "lines": [
      { "id": "setup", "label": "Build setup, Standard resin", "amount": 6 },
      { "id": "material", "label": "Standard resin", "detail": "71.4 cm3 at 0.55 USDC per cm3.", "amount": 39.27 },
      { "id": "shipping", "label": "Shipping to United States and Canada", "amount": 12.4 }
    ],
    "total": 57.67,
    "leadTimeDays": 12
  },
  "token": "pq1.eyJ2IjoxLC...",
  "expiresInSeconds": 86400
}
```

| Status | Code | Meaning |
|---|---|---|
| `200` | | Report, and a quote when a material was given. A mesh that violates the material's constraints returns `quote: null` with a `rejection` naming the measured number, the required number and the fix. |
| `413` | `too_large` / `too_complex` | Over 100 MB or 2M triangles. |
| `422` | `invalid_model` / `no_geometry` | Not a parseable mesh, or no triangles to print. |
| `451` | `fabrication_refused` | The fabrication gate refused it. The body carries `category`, `label`, `allowed` and `policy_url`. See the [content policy](./materialize.md#content-policy). |
| `502` | `fetch_failed` | The model URL did not serve the file. |

### Prepare

```http
POST /api/print/prepare
```

Reconstructs the mesh as a closed solid, fills holes, scales it to
`targetHeightMm`, optionally hollows it with drain holes, and writes the
manufacturing files (binary STL, 3MF with vertex colour when the source had a
texture, and the repaired GLB) to durable storage. Returns permanent URLs plus
the post-repair report, so you can see exactly what changed.

### Order (human checkout)

```http
POST /api/print/orders          # session + CSRF
GET  /api/print/orders/:id      # the order and its full timeline
```

Body: the quote `token` plus a `shipping` object (`name`, `line1`, `line2`,
`city`, `region`, `postal_code`, `country`, `phone`). Minimum fields only: this
is the sole personal data the platform stores for a print, it is never logged,
and it never enters an analytics event.

### Order (agent checkout, x402)

```http
POST /api/x402/print-order
```

The agent lane. The quote token and the address are validated **before** any 402
is issued, so a malformed order is refused for free with a `422` and never
charges. The 402 then quotes that token's exact total rather than a list price,
because every print is its own object.

```bash
curl -s -X POST https://three.ws/api/x402/print-order \
  -H 'content-type: application/json' \
  -d '{
    "token": "pq1....",
    "shipping": { "name": "Ada Lovelace", "line1": "12 Analytical Way", "city": "London", "postal_code": "EC1A 1AA", "country": "GB" }
  }'
```

```json
{
  "ok": true,
  "order_id": "c1b0a2d4-7e33-4f01-9a55-2b7c1d0e9f4a",
  "status": "screening",
  "paid_usdc": "48.20",
  "track_url": "/materialize/orders/c1b0a2d4-7e33-4f01-9a55-2b7c1d0e9f4a"
}
```

Track it with `GET /api/print/orders/:id`, which needs no account.

### Certificates

```http
GET /api/print/certs/:id
```

The certificate for a shipped print: the SHA-256 of the exact manufactured file
and of the viewable GLB, the edition number, and the Solana memo signature that
carries both. The human page is `/cert/:id`. A `signature` of `null` means the
attestation is still in flight, not that the certificate is fake.

### Operator and provider surfaces

`POST /api/print/ops/{queue|order|adapters|transition|submit|tracking|cancel|refund}`
is the operator console API and is allowlist-gated.
`POST /api/print/webhook/:provider` is where a fulfillment partner reports in;
every delivery is HMAC-verified against the raw bytes before it is parsed and
claimed for idempotency before it is applied. Neither is a public integration
surface; both are specified in
[specs/PRINT_PIPELINE.md](../specs/PRINT_PIPELINE.md).

---

## Material Studio API

Re-skin *any* GLB — not just avatars — without regenerating its mesh. Generalizes
the Avatar Studio re-skin idea (`src/avatar-studio-colorpicker.js`,
`src/avatar-wardrobe.js`) to arbitrary models: apply a curated PBR material
preset live in the browser (see [Restyle Studio](https://three.ws/restyle)), ask
an AI for a restyle from a plain-language instruction, or fan one preset out into
N reproducible colorway variants. Free and hosted — rate-limited, not x402 — the
same implementation the paid `restyle_material` [MCP tool](mcp-tools.md) calls as
a thin client, so the free web page and the paid agent tool never drift.

Every mesh edit is **non-destructive**: geometry and UVs are never touched (only
material factors), the source GLB is never mutated, and every restyle or variant
is minted as its own durable, `gltf-validator`-checked object. Every call is also
recorded in an immutable parent → child version lineage — the exact shape
`refine_model` uses (`mcp-server/src/tools/_lineage.js`) — so a caller can revert
to, or branch off, any earlier version instead of losing history.

Implementation: [`api/_lib/material-studio-store.js`](../api/_lib/material-studio-store.js)
(core logic) and [`api/material-studio.js`](../api/material-studio.js) (HTTP
surface). Preset library: [`packages/viewer-presets`](../packages/viewer-presets).

### Upload a checkpoint

```
POST /api/material-studio?action=upload
```

Body: raw GLB bytes, `content-type: model/gltf-binary`. Validates the bytes
(magic header + `gltf-validator`) and mirrors them into durable object storage.
Used to turn a locally-loaded file into a public https URL the other two actions
can operate on, and to checkpoint a manually fine-tuned (slider/preset) edit as a
new lineage version.

**Response**

```json
{ "ok": true, "url": "https://three.ws/cdn/material-studio/checkpoints/<uuid>.glb", "bytes": 842113 }
```

### AI restyle

```
POST /api/material-studio?action=restyle
```

| Body field       | Type    | Description                                                                 |
| ---------------- | ------- | ----------------------------------------------------------------------------- |
| `glb_url`        | string  | Public https URL of the GLB to restyle. Required.                             |
| `instruction`    | string  | Plain-language look, e.g. `"make it chrome"`, `"wooden"`, `"cyberpunk neon"`. 2–300 characters. Required. |
| `material_index` | integer | Optional — restyle only this material (by index) instead of every material.   |
| `parent_lineage` | array   | Optional — the `lineage` array a previous restyle/variants call returned, to extend the same version history. |
| `parent_index`   | integer | Optional — branch off an earlier version in `parent_lineage` instead of the latest. |

IBM Granite (watsonx.ai) proposes a glTF 2.0 PBR material (base color,
metalness, roughness, emissive) from the instruction; `@gltf-transform` applies
those factors onto the target material(s) and re-exports. Mesh geometry and UVs
are byte-identical to the source.

**Response**

```json
{
	"ok": true,
	"glbUrl": "https://three.ws/cdn/material-studio/restyle/<uuid>.glb",
	"sourceGlbUrl": "https://three.ws/cdn/creations/<id>/mesh.glb",
	"instruction": "make it chrome",
	"factors": { "name": "Polished chrome", "baseColorFactor": [0.79, 0.81, 0.83], "metallicFactor": 1, "roughnessFactor": 0.05, "emissiveFactor": [0, 0, 0] },
	"materialsEdited": 1,
	"lineage": [
		{ "index": 0, "parentIndex": null, "glbUrl": "https://three.ws/cdn/creations/<id>/mesh.glb", "refKind": "origin" },
		{ "index": 1, "parentIndex": 0, "glbUrl": "https://three.ws/cdn/material-studio/restyle/<uuid>.glb", "instruction": "make it chrome", "refKind": "restyle" }
	],
	"activeIndex": 1
}
```

### Seeded colorway variants

```
POST /api/material-studio?action=variants
```

| Body field       | Type    | Description                                                                 |
| ---------------- | ------- | ----------------------------------------------------------------------------- |
| `glb_url`        | string  | Public https URL of the GLB to fan out. Required.                             |
| `preset`         | string  | Base PBR preset to vary from — one of the [`@three-ws/viewer-presets`](../packages/viewer-presets) names (`chrome`, `gold`, `copper`, `brushedSteel`, `gunmetal`, `matte`, `glossy`, `rubber`, `ceramic`, `glass`, `wood`, `stone`, `neon`, `holographic`). Default `chrome`. |
| `seed`           | integer | Deterministic seed — same preset + seed always produces the same set. Default `0`. |
| `count`          | integer | How many variants (1–12). Default `6`.                                        |
| `material_index` | integer | Optional — vary only this material index.                                     |
| `parent_lineage` / `parent_index` | | Same as the restyle action, above — every variant branches off the same parent (the source model). |

Fans one preset out into `count` reproducible colorways (mulberry32 seeded
PRNG — byte-identical output for the same base + seed) and persists **each one
as its own real, validated GLB**, not just a live preview swap.

**Response**

```json
{
	"ok": true,
	"sourceGlbUrl": "https://three.ws/cdn/creations/<id>/mesh.glb",
	"preset": "chrome",
	"seed": 42,
	"count": 3,
	"variants": [
		{ "glbUrl": "https://three.ws/cdn/material-studio/variants/<uuid1>.glb", "label": "Chrome 1", "seed": 42, "config": { "color": "#c9ced4", "metalness": 1, "roughness": 0.05 }, "lineageIndex": 1 },
		{ "glbUrl": "https://three.ws/cdn/material-studio/variants/<uuid2>.glb", "label": "Chrome 2", "seed": 43, "config": { "color": "#a1c9d4", "metalness": 0.94, "roughness": 0.09 }, "lineageIndex": 2 }
	],
	"lineage": [
		{ "index": 0, "parentIndex": null, "glbUrl": "https://three.ws/cdn/creations/<id>/mesh.glb", "refKind": "origin" },
		{ "index": 1, "parentIndex": 0, "glbUrl": "https://three.ws/cdn/material-studio/variants/<uuid1>.glb", "instruction": "Chrome 1", "refKind": "variant" },
		{ "index": 2, "parentIndex": 0, "glbUrl": "https://three.ws/cdn/material-studio/variants/<uuid2>.glb", "instruction": "Chrome 2", "refKind": "variant" }
	],
	"activeIndex": 0
}
```

**Errors** (shared across all three actions)

| Status | Code                    | Meaning                                                          |
| ------ | ----------------------- | ------------------------------------------------------------------ |
| `400`  | `missing_glb_url`       | `glb_url` missing                                                 |
| `400`  | `missing_instruction`   | `instruction` missing (restyle action)                             |
| `400`  | `invalid_url`           | `glb_url` failed the public-https / SSRF check                     |
| `400`  | `invalid_preset`        | `preset` isn't a known name (variants action)                      |
| `415`  | `unsupported_media_type`| Fetched bytes aren't a binary glTF                                  |
| `422`  | `invalid_output`        | The restyled/variant GLB failed `gltf-validator` (never persisted)  |
| `429`  | `rate_limited`          | Per-IP rate limit hit — restyle/variants: 40/hour, upload: 120/hour |
| `503`  | `not_configured`        | AI restyle needs `WATSONX_API_KEY` + `WATSONX_PROJECT_ID` set       |

---

## AI API — text→image

Text→image for agents over x402 — no API key, no account. The first **5 images/day
per IP are free**; past the quota each image is a single USDC micropayment
(`$0.02`) settled on Solana or Base via the [x402](#x402-paid-endpoints--sign-in-with-x-siwx)
rail. It runs on the same subsidized lanes as the 3D forge (NVIDIA NIM FLUX and
the Google Vertex/Gemini image lane), and returns a durable https URL to the
rendered image.

### Text→image

```
POST /api/v1/ai/image
```

Public, CORS-open. Unauthenticated callers get the free daily quota first; once
it's spent the endpoint answers with a standard `402 Payment Required` challenge
(pay with any x402 client to receive the image). A quota slot is spent only when
an image is actually delivered — a validation error, a content refusal, or a lane
outage never burns a free generation.

**Request body**

```json
{ "prompt": "a brass owl figurine on a plain white background", "aspect_ratio": "1:1" }
```

| Field          | Type    | Description                                                                                                                                         |
| -------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `prompt`       | string  | Image description. 3–2000 characters. Required.                                                                                                     |
| `aspect_ratio` | string  | One of `1:1`, `16:9`, `9:16`, `4:3`, `3:4`, `3:2`, `2:3`. Default `1:1`.                                                                            |
| `seed`         | integer | Optional deterministic seed (0–4294967295). Honored on the NIM / Replicate flux lanes; the Vertex/Gemini lane has no seed parameter and ignores it. |

**Response — 200**

```json
{
	"url": "https://three.ws/cdn/forge/refs/<id>.jpg",
	"provider": "nvidia-nim",
	"model": "black-forest-labs/flux.1-schnell",
	"width": 1024,
	"height": 1024,
	"aspect_ratio": "1:1",
	"seed": null,
	"free": true,
	"quota": { "used": 1, "limit": 5, "remaining": 4, "resetAt": "2026-07-08T00:00:00.000Z" }
}
```

`provider` is the lane that served the image (`nvidia-nim` | `vertex` | `replicate`).
`width`/`height` are the nominal target dimensions for the requested aspect ratio.

**Example — free tier**

```bash
curl -s -X POST https://three.ws/api/v1/ai/image \
  -H 'content-type: application/json' \
  -d '{"prompt":"a brass owl figurine on a plain white background"}'
```

**Example — paid (past the free quota), with an x402 client**

```bash
# The x402 CLI pays the 402 challenge and returns the settled response body.
npx x402 curl -X POST https://three.ws/api/v1/ai/image \
  -H 'content-type: application/json' \
  -d '{"prompt":"a neon koi swimming, dark background","aspect_ratio":"16:9"}'
```

**Lane health** (no quota burn):

```bash
curl -s 'https://three.ws/api/v1/ai/image?health=1'
```

Returns per-lane `configured`/`status` (`ok` | `down` | `degraded` | `unconfigured`)
and `missing_env` when nothing is wired. A plain `GET /api/v1/ai/image` returns a
discovery doc (price, free-tier width, which lanes are configured).

**Errors**

| Status | Code                                                                           | Meaning                                                                                                                       |
| ------ | ------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| `400`  | `invalid_prompt` / `prompt_too_long` / `invalid_aspect_ratio` / `invalid_seed` | Request validation failed                                                                                                     |
| `402`  | —                                                                              | Free quota spent — pay the x402 challenge to continue                                                                         |
| `422`  | `content_refused`                                                              | The provider blocked the prompt on content-policy grounds (not retried)                                                       |
| `429`  | `rate_limited`                                                                 | Lane briefly busy — retry after `retryAfter` seconds                                                                          |
| `503`  | `not_configured`                                                               | No image lane is configured (`NVIDIA_API_KEY`, `GOOGLE_CLOUD_PROJECT` + `GCP_SERVICE_ACCOUNT_JSON`, or `REPLICATE_API_TOKEN`) |
| `503`  | `lane_unavailable`                                                             | The configured lane is temporarily down — retry                                                                               |
| `502`  | `generation_failed`                                                            | The lane returned no usable image — retry                                                                                     |

---

## AI API — speech (TTS + ASR)

Text-to-speech and speech-to-text for agents over x402 — no API key, no account.
Both run on the platform's subsidized **NVIDIA NIM** lanes (Magpie multilingual TTS
and Riva ASR) and both follow the same shape: a **free daily per-IP quota** first,
then a single USDC micropayment settled on Solana or Base via the
[x402](#x402-paid-endpoints--sign-in-with-x-siwx) rail. Nobody else in the x402
ecosystem sells ASR, so `/api/v1/ai/asr` is a one-of-a-kind lane.

Both endpoints return the **same JSON shape whether served free or paid** (the paid
rail must return JSON so settlement can run), so a caller writes one parser for
both tiers. The `tier` field reports which lane served the response.

### Text→speech

```
POST /api/v1/ai/tts
```

Public, CORS-open. **10 free calls/day per IP** for text ≤500 characters; beyond the
quota (or for text 501–4096 characters, or when an `X-PAYMENT` header is present)
the endpoint answers a `402 Payment Required` challenge priced at **`$0.005` USDC**
per call. Synthesis runs on the free Magpie lane in all cases — the payment is for
access, not a different model.

**Request body**

```json
{ "text": "Your deploy finished — three services are green.", "voice": "nova", "format": "wav" }
```

| Field      | Type   | Description                                                                                                        |
| ---------- | ------ | ------------------------------------------------------------------------------------------------------------------ |
| `text`     | string | Text to synthesize. Required. ≤4096 chars (free tier ≤500).                                                        |
| `voice`    | string | Voice id (`nova`, `alloy`, `shimmer`, `onyx`, …). Unknown values fall back to the default persona. Default `nova`. |
| `format`   | string | `wav` or `pcm`. Magpie emits WAV or raw PCM. Default `wav`.                                                        |
| `language` | string | BCP-47 tag: `en-US`, `es-US`, `fr-FR`, `de-DE`, `it-IT`, `hi-IN`, `zh-CN`, `vi-VN`, `ja-JP`. Default `en-US`.      |

**Response — 200**

```json
{
	"data": {
		"audio": "UklGR... (base64)",
		"encoding": "base64",
		"format": "wav",
		"content_type": "audio/wav",
		"sample_rate": 44100,
		"voice": "Magpie-Multilingual.EN-US.Aria",
		"model": "magpie-tts-multilingual",
		"characters": 47,
		"bytes": 132344,
		"tier": "free",
		"free_remaining_today": 9
	}
}
```

`audio` is the base64-encoded clip in `content_type`. Decode it to bytes to play or
save. `tier` is `free` or `paid`.

**List voices** (free, no quota):

```bash
curl -s 'https://three.ws/api/v1/ai/tts?voices=1'
```

**Example — free tier**

```bash
curl -s -X POST https://three.ws/api/v1/ai/tts \
  -H 'content-type: application/json' \
  -d '{"text":"Hello from three.ws","voice":"nova"}' \
  | jq -r '.data.audio' | base64 -d > hello.wav
```

**Example — paid (past the free quota), with an x402 client**

```bash
npx x402 curl -X POST https://three.ws/api/v1/ai/tts \
  -H 'content-type: application/json' \
  -d '{"text":"This one is billed at half a cent.","voice":"onyx"}'
```

### Speech→text

```
POST /api/v1/ai/asr
```

Public, CORS-open. **5 free clips/day per IP** for audio ≤60 seconds; beyond the
quota (or for clips >60s, or when an `X-PAYMENT` header is present) the endpoint
answers a `402 Payment Required` challenge priced at **`$0.01` USDC** per clip.

Send audio one of two ways:

- **JSON** — `{ "audio": "<base64>", "format": "wav" }`
- **Raw bytes** — the audio as the request body with an `audio/*` `Content-Type`
  (`audio/wav`, `audio/pcm` with `?rate=`, `audio/flac`, `audio/ogg`).

WebM/Opus is not accepted — decode it to PCM/WAV client-side first.

| Field        | Type    | Description                                                                         |
| ------------ | ------- | ----------------------------------------------------------------------------------- |
| `audio`      | string  | Base64 audio in a JSON body (data: URIs accepted). Required for the JSON transport. |
| `format`     | string  | `wav` \| `pcm` \| `flac` \| `ogg`. Default `wav`.                                   |
| `language`   | string  | BCP-47 language hint. Default `en-US`.                                              |
| `sampleRate` | integer | Sample rate (Hz) for raw PCM. Ignored for WAV (read from the header).               |
| `words`      | boolean | Return word-level timestamps. Default `false`.                                      |

**Response — 200**

```json
{
	"data": {
		"text": "schedule the deploy for friday morning",
		"confidence": 0.94,
		"duration": 2.1,
		"language": "en-US",
		"model": "riva-asr",
		"tier": "free",
		"free_remaining_today": 4
	}
}
```

`duration` is the seconds of audio processed. `confidence` is the mean top-alternative
confidence. Pass `words: true` to also receive a `words` array of
`{ word, startMs, endMs, confidence }`.

**Example — free tier (base64 JSON)**

```bash
AUDIO=$(base64 -w0 clip.wav)
curl -s -X POST https://three.ws/api/v1/ai/asr \
  -H 'content-type: application/json' \
  -d "{\"audio\":\"$AUDIO\",\"format\":\"wav\"}"
```

**Example — raw bytes**

```bash
curl -s -X POST https://three.ws/api/v1/ai/asr \
  -H 'content-type: audio/wav' \
  --data-binary @clip.wav
```

**Example — paid (past the free quota), with an x402 client**

```bash
npx x402 curl -X POST https://three.ws/api/v1/ai/asr \
  -H 'content-type: application/json' \
  -d "{\"audio\":\"$(base64 -w0 clip.wav)\",\"format\":\"wav\"}"
```

A plain `GET /api/v1/ai/asr` returns a capability probe (accepted encodings,
sample rate, whether the lane is configured).

**Errors** (both endpoints)

| Status | Code                             | Meaning                                                                           |
| ------ | -------------------------------- | --------------------------------------------------------------------------------- |
| `400`  | `bad_request` / `text_too_long`  | Request validation failed (empty/invalid body, or text over 4096 chars)           |
| `402`  | —                                | Free quota spent (or over the free size limit) — pay the x402 challenge           |
| `413`  | `payload_too_large`              | Audio exceeds the 8 MB limit                                                      |
| `415`  | `unsupported_media_type`         | Unrecognized audio `Content-Type` (ASR)                                           |
| `429`  | `rate_limited`                   | Upstream credit metering hit — retry shortly                                      |
| `503`  | `not_configured`                 | TTS needs `NVIDIA_API_KEY`; ASR needs `NVIDIA_API_KEY` + `NVIDIA_ASR_FUNCTION_ID` |
| `502`  | `provider_error` / `invalid_key` | The NIM lane failed — retry                                                       |

---

## Sign Language API: ASL fingerspelling → text

Read American Sign Language fingerspelling from a webcam. No API key, no account,
no payment: rate-limited per IP. This is the input half of the platform's signing
loop (the output half, avatars that sign, is [docs/sign-language.md](./sign-language.md)).

**Video never reaches the platform.** The caller extracts MediaPipe Holistic
landmarks in the browser and posts coordinates only. `src/sign-input.js` ships a
`SignInput` class that does the camera, the landmarker, and both calls below for you.

Recognition runs the 1st-place model from Google's 2023 ASL Fingerspelling
Recognition competition (Apache-2.0 weights, FSboard CC BY 4.0 corpus), served by
[workers/model-asl-recognition](../workers/model-asl-recognition/README.md).

### Feature schema

```
GET /api/asl-recognition
```

Returns the exact per-frame feature layout the recognizer expects. Fetch it once,
then build every frame row in this column order.

```json
{
	"columns": ["x_face_0", "x_face_61", "…", "z_pose_21"],
	"max_frames": 1500,
	"min_frames": 8
}
```

| Field        | Type     | Description                                                                     |
| ------------ | -------- | -------------------------------------------------------------------------------- |
| `columns`    | string[] | 390 landmark column names, in order: `<x\|y\|z>_<face\|left_hand\|right_hand\|pose>_<index>` |
| `max_frames` | number   | Longest accepted capture                                                         |
| `min_frames` | number   | Below this the capture is too short to decode                                    |

### Transcribe

```
POST /api/asl-recognition
```

**Request body**

```json
{ "frames": [[0.51, 0.32, null, "…"]], "clean": true }
```

| Field    | Type       | Description                                                                                  |
| -------- | ---------- | ---------------------------------------------------------------------------------------------- |
| `frames` | number[][] | One row per video frame, each holding the values named by `columns`, in order. `null` marks a missing landmark. Required. |
| `clean`  | boolean    | Run the LLM cleanup pass over the raw decode. Default `true`; send `false` for the untouched decode. |

**Response (200)**

```json
{
	"text": "hello world",
	"raw": "helo worlld",
	"cleaned": true,
	"confidence": 0.812,
	"frames": 214,
	"ms": 380
}
```

| Field        | Type    | Description                                                              |
| ------------ | ------- | -------------------------------------------------------------------------- |
| `text`       | string  | The transcription, after cleanup when it ran                              |
| `raw`        | string  | The model's untouched decode                                              |
| `cleaned`    | boolean | Whether cleanup changed the decode                                        |
| `confidence` | number  | Mean per-character softmax probability of the raw decode, 0 to 1. Near 1 is a clean read; low values mean the capture was poor, and the browser surfaces a warning rather than inserting the text silently |
| `frames`     | number  | Frames decoded                                                            |
| `ms`         | number  | Recognition time                                                          |

Webcam fingerspelling decodes at a **10-20% character error rate**, which is why a
constrained LLM pass recovers the intended word and why the browser surfaces the
result for review before sending. Cleanup fails open: any LLM problem returns `raw`
unchanged.

**Example**

```bash
# 1. Fetch the column layout your frame rows must match.
curl -s https://three.ws/api/asl-recognition | jq '{cols: (.columns | length), min_frames, max_frames}'

# 2. Post captured landmark rows (frames.json holds { "frames": [[…]] }).
curl -s -X POST https://three.ws/api/asl-recognition \
  -H 'content-type: application/json' \
  --data-binary @frames.json
```

**Errors**

| Status | Code             | Meaning                                                                        |
| ------ | ---------------- | -------------------------------------------------------------------------------- |
| `400`  | `bad_request`    | Body is not `{ frames: [[…]] }`                                                 |
| `400`  | `bad_frames`     | Frame rows do not match the published schema (wrong width, too few frames)      |
| `429`  | `rate_limited`   | Per-IP recognition limit reached, retry shortly                                |
| `502`  | `worker_error`   | The recognizer lane failed, retry                                              |
| `503`  | `unconfigured`   | This deployment has no `GCP_ASL_RECOGNITION_URL` / `GCP_RECONSTRUCTION_KEY` set |

---

## Agent Tokens API

The coin an agent is configured to become, before it exists on chain. Full guide,
including the launch paths and the mainnet activation step:
[Agent tokens](./agent-tokens.md).

### Read an agent's token plan

```
GET /api/agents/tokens/plan?agent_id=<uuid>&network=mainnet
```

Open. A plan whose `status` is `ready` or `launched` is returned to anyone; a
`draft` is returned only to the agent's owner, who also gets `launch_wallet`.

**Response**

```json
{
	"agent_id": "8f14e45f-ceea-467a-9f27-1f0f8b1cba1c",
	"network": "mainnet",
	"is_owner": false,
	"launch_wallet": null,
	"plan": {
		"name": "Ada Ledger",
		"symbol": "ADA",
		"coin_type": "agent",
		"quote_currency": "sol",
		"buyback_bps": 2500,
		"sol_buy_in": 0.5,
		"status": "ready",
		"mint": null,
		"readiness": { "ready": true, "blockers": [], "warnings": [] },
		"cost_estimate": { "total_sol": 0.514105, "dev_buy_usdc": 0 }
	}
}
```

---

### Save an agent's token plan

```
PUT /api/agents/tokens/plan
```

Requires the agent owner's session. Saving costs nothing and mints nothing.
`status` is derived from the readiness check on every save. A plan that already
launched is permanent and answers `409 conflict`.

**Request body**

```json
{
	"agent_id": "8f14e45f-ceea-467a-9f27-1f0f8b1cba1c",
	"network": "mainnet",
	"name": "Ada Ledger",
	"symbol": "ADA",
	"description": "The ledger of a working agent.",
	"coin_type": "agent",
	"quote_currency": "sol",
	"buyback_bps": 2500,
	"sol_buy_in": 0.5
}
```

---

### Discard an unlaunched plan

```
DELETE /api/agents/tokens/plan?agent_id=<uuid>&network=mainnet
```

Requires the agent owner's session. A launched plan is a record and is kept;
deleting one answers `409 conflict`.

---

### Rehearse the launch (no broadcast)

```
POST /api/agents/tokens/plan-dry-run
```

Requires the agent owner's session. Builds the real pump.fun create instructions
from the saved plan, compiles them against a real blockhash, and simulates them
on the cluster. Never signs, never broadcasts, costs nothing. `network` defaults
to `devnet`.

**Response**

```json
{
	"ok": true,
	"broadcast": false,
	"network": "devnet",
	"result": {
		"verdict": "would_succeed",
		"compiled": true,
		"tx_bytes": 918,
		"simulation": { "error": null, "units_consumed": 121843, "logs": ["…"] }
	}
}
```

`verdict` is one of `would_succeed`, `funding_required`, `would_fail`,
`compile_failed`, `rpc_unavailable`.

---

## Token API — security

Rug-check any Solana token in one free call. Instead of an invented "risk score",
this returns the **on-chain facts** an agent needs to decide for itself: whether
the mint and freeze authorities are still active, how concentrated the top holders
are, how deep the liquidity is, and how old the pair is. It composes
`getAccountInfo` + `getTokenLargestAccounts` (Solana RPC) with DexScreener — data
you could gather yourself from three sources, in one keyless request.

### Token security check

```
GET /api/v1/token/security?address=<mint>
```

Public, CORS-open, no auth. Rate limited to **20 requests/min per IP**; responses
are edge-cached for 60s. Solana only — an EVM `0x…` address returns `400`.

| Query param | Type   | Description                           |
| ----------- | ------ | ------------------------------------- |
| `address`   | string | Base58 Solana mint address. Required. |

**Response**

Every field is always present — `null` when a source couldn't resolve it, never
omitted and never faked. `sources` names which upstreams answered; `flags` are
factual conditions (an empty array means none tripped).

```json
{
	"data": {
		"address": "FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump",
		"chain": "solana",
		"mint_authority": { "revoked": true, "address": null },
		"freeze_authority": { "revoked": true, "address": null },
		"supply": "999683523471616",
		"decimals": 6,
		"top_holders": {
			"top1_pct": 6.6,
			"top5_pct": 14.7,
			"top10_pct": 22.3,
			"holders_sampled": 20
		},
		"liquidity": {
			"usd": 196695.93,
			"largest_pair": "three/SOL",
			"pair_created_at": 1777446541000
		},
		"flags": [],
		"sources": ["solana-rpc", "dexscreener"],
		"ts": 1783382400000
	}
}
```

**Flags** (emitted only when the underlying facts are known):

| Flag                       | Condition                                                        |
| -------------------------- | ---------------------------------------------------------------- |
| `mint_authority_active`    | The mint authority is not revoked — supply can still be inflated |
| `freeze_authority_active`  | The freeze authority is not revoked — accounts can be frozen     |
| `top1_holder_over_20pct`   | The single largest account holds > 20% of supply                 |
| `top10_holders_over_80pct` | The top 10 accounts hold > 80% of supply                         |
| `liquidity_under_10k`      | Deepest-pair liquidity is under $10,000                          |
| `pair_younger_than_24h`    | The deepest pair was created less than 24h ago                   |

**Example**

```bash
curl -s 'https://three.ws/api/v1/token/security?address=FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump'
```

**Degradation & errors**

Each section resolves independently. If one upstream is down, only that section
is nulled and it drops out of `sources` — the call still succeeds (`200`) as long
as any section resolved.

| Status | Code                  | Meaning                                                                 |
| ------ | --------------------- | ----------------------------------------------------------------------- |
| `400`  | `validation_error`    | `address` missing or not a base58 Solana address                        |
| `400`  | `unsupported_chain`   | An EVM `0x…` address — this endpoint is Solana-only                     |
| `404`  | `not_found`           | Sources answered but no on-chain mint or market exists for this address |
| `429`  | `rate_limited`        | Over 20 requests/min from this IP — back off per `retry_after`          |
| `503`  | `sources_unavailable` | Every upstream failed — transient, retry shortly                        |

---

## Fact Check API

Sourced fact-checking with cryptographic attestations you can audit — not just an
asserted verdict. Submit a claim and get back a verdict (`supported` /
`contradicted` / `mixed` / `insufficient`) backed by live web search and LLM
stance analysis, with cited sources, authority weights, a confidence score, and a
SHA-256 attestation over the result. A published accuracy benchmark (40 claims,
10 per verdict class) makes the quality claim checkable instead of asserted — see
[/fact-check](https://three.ws/fact-check) for the live scores and claim set.

### Fact check a claim

```
POST /api/x402/fact-check
```

**Free daily lane:** the first **3 checks/day per IP** run the exact same live
chain as the paid lane — never a degraded or cached-only response — and are
marked `"lane": "free"`. Once the quota is used, the same request receives the
x402 `402` payment challenge for the paid lane instead of an error.

**Paid lane:** `$0.10` USDC base price (Base or Solana) once the free quota is
exhausted, or immediately if the request carries an `X-PAYMENT` header. Marked
`"lane": "paid"`.

| Body field    | Type   | Description                                                                 |
| ------------- | ------ | ---------------------------------------------------------------------------- |
| `claim`       | string | The factual claim to verify. 5–1000 characters. Required.                    |
| `strictness`  | string | `high` \| `medium` (default) \| `low` — how hard low-authority sources are downweighted. |
| `imageUrl`    | string | Optional http(s) image evidence (chart, screenshot, photo). Vision-described and weighed alongside web sources when available. |

**Response**

```json
{
	"verdict": "contradicted",
	"confidence": 0.78,
	"claim": "The Eiffel Tower is 330 meters tall.",
	"strictness": "high",
	"sources": [
		{
			"url": "https://en.wikipedia.org/wiki/Eiffel_Tower",
			"title": "Eiffel Tower - Wikipedia",
			"excerpt": "The tower is 330 m (1,083 ft) tall, including a 24 m (79 ft) antenna.",
			"stance": "supports",
			"weight": 0.7,
			"retrievedAt": "2026-05-27T00:00:00.000Z"
		}
	],
	"costBreakdown": { "searchCalls": 3, "llmTokens": 1420, "totalUsdc": "0.100355" },
	"attestation": "sha256:abcdef1234567890...",
	"lane": "free",
	"free_remaining_today": 2
}
```

`free_remaining_today` is present only on `lane: "free"` responses. A repeated
identical `{ claim, strictness, imageUrl }` within 7 days replays the cached
verdict on either lane (adds `cachedAt`) rather than re-running the chain.

**`degraded` — when the check ran on less than the full chain.** Every live
check has a wall-clock budget (45s by default, `FACT_CHECK_BUDGET_MS`) and each
stage gets what is left of it. If query generation or stance extraction cannot
reach a language-model provider inside that budget, the stage falls back rather
than failing the request: query generation searches the claim text itself, and
stance extraction marks every source `neutral`, which scores as `insufficient`.
You still get the real sources and their excerpts. When that happens the
response carries a `degraded` array naming each stage that fell back:

```json
{
	"verdict": "insufficient",
	"confidence": 0.3,
	"sources": [ "…real sources, real excerpts…" ],
	"degraded": ["stance extraction unavailable: all providers exhausted"]
}
```

Treat `degraded` as "re-run this later", not as a judgement about the claim: a
degraded result is deliberately **not** written to the 7-day cache, so the next
request re-runs the full chain. Absence of the field means the full chain ran.

**Example**

```bash
curl -s https://three.ws/api/x402/fact-check \
	-H 'content-type: application/json' \
	-d '{ "claim": "Solana uses a proof-of-history mechanism to order transactions." }'
```

**Errors**

| Status | Code               | Meaning                                                    |
| ------ | ------------------ | ----------------------------------------------------------- |
| `400`  | `invalid_claim`    | `claim` missing or under 5 characters                       |
| `400`  | `claim_too_long`   | `claim` over 1000 characters                                 |
| `400`  | `invalid_image_url`| `imageUrl` present but not a valid http(s) URL               |
| `400`  | `invalid_json`     | Request body is not valid JSON                               |
| `402`  | —                  | Free quota exhausted — pay per the returned x402 challenge   |
| `422`  | `no_results`       | No web results and no usable image evidence for the claim    |

### Accuracy benchmark

The claim set behind the published accuracy score lives at
`tests/fixtures/fact-check-benchmark.json` (40 claims, 10 per verdict class,
time-stable and non-partisan) and is scored by `scripts/fact-check-benchmark.mjs`
against the real chain. [/fact-check](https://three.ws/fact-check) renders the
latest generated score, the claim set, and a live "try one free check" box.

---

## Market Intelligence & Sentiment API

Three free `/api/v1` routes: a deterministic text-sentiment classifier (always
on, no upstream dependency), and two momentum/narrative intelligence reads
backed by [aixbt](https://aixbt.tech) (`/market/intel`, `/market/projects`) —
publicly readable, no API key or wallet needed, whenever aixbt is configured on
the deployment.

### Sentiment classification

```
POST /api/v1/sentiment
```

Public, CORS-open, no auth. Runs the same deterministic lexicon scorer as
`/api/social/sentiment` — no third-party dependency, so it never degrades.
Rate limited by the gateway's shared per-IP budget (120 requests/min).

| Body field | Type   | Description                        |
| ---------- | ------ | ----------------------------------- |
| `text`     | string | The text to classify. Required.     |

```bash
curl -s -X POST https://three.ws/api/v1/sentiment \
  -H 'content-type: application/json' \
  -d '{"text":"this launch is going incredibly well, huge buy pressure"}'
```

```json
{
	"data": {
		"sentiment": "Positive",
		"score": 0.62,
		"positive_pct": 71,
		"negative_pct": 9
	}
}
```

| Status | Code               | Meaning                          |
| ------ | ------------------ | --------------------------------- |
| `400`  | `validation_error` | `text` missing or empty          |
| `429`  | `rate_limited`      | Over the shared per-IP API budget |

### Narrative / market intel

```
GET /api/v1/market/intel?limit=20&category=<category>&chain=<chain>
```

Public read (no auth required — an OAuth `agents:read` scope unlocks nothing
extra here, it's the same free data). Backed by aixbt's `/intel` feed, cached
for 2 minutes and metered against a shared per-deployment aixbt ceiling on top
of the gateway's own per-IP budget, so one caller can't drain the shared key.

| Query param | Type   | Description                                |
| ----------- | ------ | ------------------------------------------- |
| `limit`     | number | 1–50, default 20                            |
| `category`  | string | Filter by category. Optional.               |
| `chain`     | string | Filter by chain. Optional.                  |

<!-- runnable: no needs a valid upstream aixbt key on the deployment -->
```bash
curl -s 'https://three.ws/api/v1/market/intel?limit=5'
```

```json
{ "data": { "intel": [ { "id": "…", "text": "…", "category": "narrative", "chain": "solana", "createdAt": "…" } ], "pagination": { "limit": 5, "page": 1, "hasMore": true }, "source": "aixbt" } }
```

### Momentum-ranked projects

```
GET /api/v1/market/projects?limit=20&page=1&names=<comma-separated>&chain=<chain>
```

Same access model as `/market/intel`. Backed by aixbt's `/projects` feed.

| Query param | Type   | Description                                      |
| ----------- | ------ | ------------------------------------------------- |
| `limit`     | number | 1–50, default 20                                  |
| `page`      | number | default 1                                         |
| `names`     | string | Comma-separated project names to filter. Optional |
| `chain`     | string | Filter by chain. Optional.                        |

<!-- runnable: no needs a valid upstream aixbt key on the deployment -->
```bash
curl -s 'https://three.ws/api/v1/market/projects?limit=5&chain=solana'
```

**Degradation & errors** (both aixbt-backed routes)

| Status | Code            | Meaning                                                                 |
| ------ | --------------- | ------------------------------------------------------------------------ |
| `429`  | `rate_limited`   | Either the shared aixbt ceiling or the per-IP gateway budget is spent    |
| `429`  | `aixbt_rate_limited` | aixbt throttled this deployment's key upstream. Retry shortly.      |
| `502` / `504` | `aixbt_upstream_error` | aixbt is erroring or unreachable. The upstream status is relayed. |
| `503`  | `not_configured` | `AIXBT_API_KEY` isn't set on this deployment, never a raw 500           |
| `503`  | `aixbt_unauthorized` | aixbt rejected this deployment's key (expired, revoked, or below the plan the read needs). A deployment fault, never the caller's: these routes take no client credential, so they never answer `401`. |

---

## Name Resolution API

Name resolution is the highest-frequency primitive in agent tooling — every
payment, transfer, or profile lookup starts with turning a human-readable name
into an address (or back). This endpoint wraps the platform's existing ENS and
SNS resolvers (the same ones behind `/api/agents/ens/:name` and `/api/sns`) in
one free, versioned door.

### Resolve a name / reverse-resolve an address

```
GET /api/v1/resolve?name=<x>.eth
GET /api/v1/resolve?name=<x>.sol
GET /api/v1/resolve?address=<addr>[&chain=ethereum|solana]
```

Public, CORS-open, no auth, no cost. Rate limited to **30 requests/min per
IP**; successful responses are edge-cached for 5 minutes. Pass exactly one of
`name` or `address`.

`.eth` names resolve through the ENS Universal Resolver (one `eth_call` per
direction, typically under 300ms), which also handles wildcard and CCIP-read
resolution. A name that does not exist is a `404 not_found`; a `503
ens_unavailable` means every Ethereum RPC endpoint failed and the lookup is
worth retrying. The two are never conflated, so a client can cache a 404 and
retry a 503.

| Query param | Type   | Description                                                                                                                                |
| ----------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `name`      | string | A name ending in `.eth` (ENS) or `.sol` (SNS). Required unless `address` is passed.                                                        |
| `address`   | string | A `0x…` Ethereum address or a base58 Solana address to reverse-resolve. Required unless `name` is passed.                                  |
| `chain`     | string | `"ethereum"` \| `"solana"` — optional hint, validated against the address format when passed. Auto-detected from the address when omitted. |

**Forward response** (`?name=…`)

```json
{
	"data": {
		"name": "vitalik.eth",
		"chain": "ethereum",
		"address": "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
		"source": "ens"
	}
}
```

```json
{
	"data": {
		"name": "bonfida.sol",
		"chain": "solana",
		"address": "<owner base58 address>",
		"source": "sns"
	}
}
```

**Reverse response** (`?address=…`)

```json
{
	"data": {
		"address": "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
		"chain": "ethereum",
		"name": "vitalik.eth",
		"source": "ens"
	}
}
```

```json
{
	"data": {
		"address": "<base58 address>",
		"chain": "solana",
		"name": "bonfida.sol",
		"source": "sns"
	}
}
```

Reverse lookup only runs in the direction the wrapped resolver already
supports (ethers `lookupAddress` for ENS, SNS `getFavoriteDomain` for SNS) —
both directions are covered, so there is no half-built placeholder here.

**Examples**

```bash
curl -s 'https://three.ws/api/v1/resolve?name=vitalik.eth'
curl -s 'https://three.ws/api/v1/resolve?name=bonfida.sol'
curl -s 'https://three.ws/api/v1/resolve?address=0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045'
```

**Errors**

| Status | Code                 | Meaning                                                                                                                                         |
| ------ | -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `400`  | `validation_error`   | Neither/both of `name`/`address` passed, `address` isn't a recognizable Ethereum or Solana address, or `chain` doesn't match the address format |
| `400`  | `unsupported_suffix` | `name` doesn't end in `.eth` or `.sol` — those are the only two supported registries                                                            |
| `404`  | `not_found`          | The name/address is well-formed but does not resolve — a miss, not a failure                                                                    |
| `429`  | `rate_limited`       | Over 30 requests/min from this IP — back off per `retry_after`                                                                                  |
| `503`  | `ens_unavailable`    | The ENS RPC chain timed out or failed — transient, retry shortly                                                                                |

---

## Gas API

Keyless EVM gas prices for 12 chains, normalized to EIP-1559 tiers. Backed by
a failover chain of three free providers (Blocknative, then Owlracle, then the
Etherscan gas oracle for Ethereum mainnet), each failing soft on its own 3.5s
timeout. No key is required anywhere; `BLOCKNATIVE_API_KEY` and
`OWLRACLE_API_KEY` are optional quota raisers.

### Get gas estimate

```
GET /api/v1/gas?chain=<name|alias|chainId>
GET /api/v1/gas?chains=1
```

Public, no auth. Server-side cached 10s per chain, so upstream keyless quotas
see at most ~6 calls/min per chain regardless of client traffic. `chain`
defaults to `ethereum`; `?chains=1` lists the supported chain/source table.

| Query param | Type   | Description                                                                          |
| ----------- | ------ | ------------------------------------------------------------------------------------ |
| `chain`     | string | Chain name, alias, or numeric chainId: ethereum, base, bsc, polygon, arbitrum, optimism, avalanche, linea, fantom, cronos, moonriver, harmony. Default `ethereum`. |
| `chains`    | string | Pass `1` to list supported chains and their source rungs instead of an estimate.     |

**Response**

```json
{
	"data": {
		"chain": "ethereum",
		"chainId": 1,
		"unit": "gwei",
		"baseFee": 0.42,
		"tiers": {
			"safe": { "maxFeePerGas": 0.52, "maxPriorityFeePerGas": 0.05 },
			"standard": { "maxFeePerGas": 0.62, "maxPriorityFeePerGas": 0.1 },
			"fast": { "maxFeePerGas": 0.84, "maxPriorityFeePerGas": 0.3 }
		},
		"source": "blocknative",
		"ts": 1754438400000
	}
}
```

**Examples**

```bash
curl -s 'https://three.ws/api/v1/gas'
curl -s 'https://three.ws/api/v1/gas?chain=base'
curl -s 'https://three.ws/api/v1/gas?chains=1'
```

**Errors**

| Status | Code                  | Meaning                                                          |
| ------ | --------------------- | ---------------------------------------------------------------- |
| `400`  | `unsupported_chain`   | Unknown chain; the error body names every supported chain        |
| `429`  | `rate_limited`        | Over the per-IP limit; back off per `retry_after`                |
| `503`  | `sources_unavailable` | Every rung for this chain failed; transient, retry shortly       |

---

## EVM Swap Quote API

Read-only swap quotes over a keyless failover chain: ParaSwap, then KyberSwap,
then LI.FI, first success wins, each rung on its own 7s soft-fail timeout.
Quotes only: the endpoint never returns calldata and never builds, signs, or
sends a transaction.

### Get a swap quote

```
GET /api/v1/evm/swap-quote?chain=<chain>&sellToken=<0x…>&buyToken=<0x…>&amount=<raw units>
```

Public, no auth, no key. Rate limited to **30 requests/min per IP**; successful
quotes carry a 10s public cache header.

| Query param | Type   | Description                                                                                     |
| ----------- | ------ | ----------------------------------------------------------------------------------------------- |
| `chain`     | string | Chain name, alias, or numeric id: ethereum, base, polygon, arbitrum, optimism, bsc. Required.   |
| `sellToken` | string | `0x…` token address to sell; `0xeeee…eeee` for the native coin. Required.                       |
| `buyToken`  | string | `0x…` token address to buy. Required.                                                           |
| `amount`    | string | Sell amount in raw base units (integer string, e.g. `1000000000000000000` for 1e18). Required.  |

**Response**

```json
{
	"data": {
		"provider": "paraswap",
		"quote": {
			"provider": "paraswap",
			"chain": "base",
			"chainId": 8453,
			"sellToken": "0x4200000000000000000000000000000000000006",
			"buyToken": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
			"sellAmount": "1000000000000000000",
			"buyAmount": "1914110000",
			"price": 1914.11,
			"estimatedGas": 185000,
			"gasUsd": 0.01,
			"sellAmountUsd": 1913.9,
			"buyAmountUsd": 1914.11,
			"venue": "UniswapV3"
		},
		"attempts": [{ "provider": "paraswap", "ok": true }]
	}
}
```

**Examples**

```bash
curl -s 'https://three.ws/api/v1/evm/swap-quote?chain=base&sellToken=0x4200000000000000000000000000000000000006&buyToken=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913&amount=1000000000000000000'
```

**Errors**

| Status | Code                | Meaning                                                                 |
| ------ | ------------------- | ----------------------------------------------------------------------- |
| `400`  | `validation_error`  | Missing/invalid chain, token address, or amount, or sellToken equals buyToken |
| `429`  | `rate_limited`      | Over 30 requests/min from this IP; back off per `retry_after`           |
| `502`  | `quote_unavailable` | All three providers failed; the body names each rung's failure          |

---

## Pump.fun Market Data API

Free, keyless, versioned pump.fun market data under the cataloged `/api/v1`
surface (`GET /api/v1` lists all five) — search, trending, bonding-curve
progress, the three.ws launch directory, and whale activity. Each endpoint is a
thin wrapper: search shares its engine with the site's command-palette search
(`/api/pump/search`); trending, curve, and whales share their engines with the
free Crypto Data API's pump.fun endpoints (`/api/crypto/trending`, `/bonding`,
`/whales` — see [docs/crypto-api.md](crypto-api.md)); launches shares its query
with the [/launches](https://three.ws/launches) page. No fork of any upstream
logic lives here — every /api/v1/pump/\* route imports the same shared module
its sibling already uses.

### Search

Text search by name, symbol, or mint, shared with the site's command-palette
search (`/api/pump/search`) via one implementation
(`api/_lib/pump-search.js` `searchPumpTokens`) — Birdeye first when
`BIRDEYE_API_KEY` is configured, falling back to pump.fun's public frontend
search when Birdeye is unconfigured, rate-limited, or down.

```
GET /api/v1/pump/search?q=<query>&limit=<1-20>
```

Public, CORS-open, no auth, no cost. Rate limited to **60 requests/min per
IP**; hits are cached 15s (CDN 30s).

| Query param | Type   | Description                                                          |
| ----------- | ------ | ---------------------------------------------------------------------- |
| `q`         | string | Token name, symbol, or mint to search for (required, max 64 chars).    |
| `limit`     | number | Result cap, `1`–`20` (default `8`).                                    |

**Response**

```json
{
	"data": {
		"results": [
			{
				"mint": "FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump",
				"symbol": "three",
				"name": "three.ws",
				"logo": "https://...",
				"price_usd": 0.0013,
				"rank": null
			}
		],
		"count": 1,
		"q": "three.ws"
	}
}
```

No matches is a valid, common outcome — `{ "results": [], "count": 0, "q": "…" }`
with `200`, never a `404`.

**Example**

```bash
curl -s 'https://three.ws/api/v1/pump/search?q=three.ws'
```

**Errors**

| Status | Code                | Meaning                                            |
| ------ | ------------------- | --------------------------------------------------- |
| `400`  | `validation_error`  | `q` missing or empty                                |
| `429`  | `rate_limited`      | Over 60 requests/min from this IP                    |

---

### Trending

Momentum-ranked "what's hot right now" — fuses windowed volume, buy pressure, a
volume-spike signal, and price change across pump.fun, DexScreener, and
(best-effort) GMGN smart money into one 0–100 score. Same engine as
[`GET /api/crypto/trending`](crypto-api.md)
(`api/_lib/crypto-trending.js` `composeTrending`), capped slimmer here (25 vs
50) to keep this door fast.

```
GET /api/v1/pump/trending?window=<5m|1h|24h>&limit=<1-25>&source=<pumpfun|all>
```

Public, CORS-open, no auth, no cost. Rate limited to **60 requests/min per
IP**. Responses are edge-cached 30s when the ranking is non-empty, 5s when every
source is temporarily down.

| Query param | Type   | Description                                                              |
| ----------- | ------ | ------------------------------------------------------------------------- |
| `window`    | string | Trade window the score measures: `5m` \| `1h` \| `24h` (default `1h`).    |
| `limit`     | number | Result cap, `1`–`25` (default `20`).                                      |
| `source`    | string | `pumpfun` restricts to the pump.fun board; `all` fuses every source (default `all`). |

**Response**

```json
{
	"data": {
		"window": "1h",
		"tokens": [
			{
				"mint": "FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump",
				"symbol": "three",
				"name": "three.ws",
				"marketCapUsd": 4200000,
				"volumeUsd": 120000,
				"change": 12.4,
				"score": 87.5,
				"url": "https://pump.fun/coin/FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump"
			}
		],
		"count": 1,
		"ts": "2026-07-08T00:00:00.000Z",
		"sources": ["pumpfun", "dexscreener"]
	}
}
```

Every source failing yields `200` with an empty `tokens` array and a `note` —
never a `5xx`. A partial outage adds `note` naming which sources are down.

**Example**

```bash
curl -s 'https://three.ws/api/v1/pump/trending?window=1h&limit=10'
```

**Errors**

| Status | Code            | Meaning                            |
| ------ | --------------- | ----------------------------------- |
| `429`  | `rate_limited`  | Over 60 requests/min from this IP   |

---

### Bonding curve

Bonding-curve / graduation status for one pump.fun mint — % to graduation, SOL
in the curve, tokens remaining, market cap, and whether it has already migrated
to an AMM (Raydium / PumpSwap). Same engine as
[`GET /api/crypto/bonding`](crypto-api.md)
(`api/_lib/pump-bonding.js` `getBondingStatus`).

```
GET /api/v1/pump/curve?mint=<mint>
```

Public, CORS-open, no auth, no cost. Rate limited to **60 requests/min per
IP**. Responses are edge-cached 15s.

| Query param | Type   | Description                                     |
| ----------- | ------ | ------------------------------------------------ |
| `mint`      | string | Base58 Solana pump.fun mint address. Required.    |

**Response**

```json
{
	"data": {
		"mint": "FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump",
		"onCurve": false,
		"bondingProgressPct": 100,
		"solInCurve": null,
		"tokensRemaining": null,
		"marketCapUsd": 4200000,
		"graduated": true,
		"migratedTo": "pumpswap",
		"source": "pumpfun"
	}
}
```

**Example**

```bash
curl -s 'https://three.ws/api/v1/pump/curve?mint=FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump'
```

**Errors**

| Status | Code                  | Meaning                                                                    |
| ------ | --------------------- | --------------------------------------------------------------------------- |
| `400`  | `validation_error`    | `mint` missing or not a base58 Solana address                               |
| `400`  | `not_pumpfun_mint`    | Well-formed mint, but never launched on pump.fun (or isn't indexed)         |
| `429`  | `rate_limited`        | Over 60 requests/min from this IP                                           |
| `503`  | `upstream_unavailable`| The pump.fun data source is temporarily unreachable — retry shortly         |

---

### Launches

Every coin launched **through three.ws** (a `pump_agent_mints` row), joined
with the launching agent — the platform's own launch directory, distinct from
a generic pump.fun-wide new-mint feed. Same query as the
[/launches](https://three.ws/launches) page
(`api/_lib/pump-agent-launches.js` `queryAgentLaunches`).

```
GET /api/v1/pump/launches?limit=<1-100>&offset=<n>&network=<mainnet|devnet>&agent_id=<uuid>&min_tier=<tier>
```

Public, CORS-open, no auth, no cost. Rate limited to **60 requests/min per
IP**. Responses are edge-cached 15s.

| Query param | Type   | Description                                                                         |
| ----------- | ------ | -------------------------------------------------------------------------------------- |
| `limit`     | number | Page size, `1`–`100` (default `24`).                                                   |
| `offset`    | number | Pagination offset (default `0`).                                                       |
| `network`   | string | `mainnet` \| `devnet` (default `mainnet`).                                             |
| `agent_id`  | string | Restrict to one launching agent (uuid). Optional.                                      |
| `min_tier`  | string | Oracle conviction floor: `prime` \| `strong` \| `lean` \| `watch` \| `avoid`. Optional. |

**Response**

```json
{
	"data": {
		"launches": [
			{
				"mint": "FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump",
				"network": "mainnet",
				"name": "three.ws",
				"symbol": "three",
				"buyback_bps": 500,
				"metadata_uri": "https://...",
				"quote_mint": null,
				"created_at": "2026-07-01T00:00:00.000Z",
				"oracle": { "score": 91, "tier": "prime", "category": "agent" },
				"agent": {
					"id": "…",
					"name": "Launch Bot",
					"url": "/agents/…",
					"avatar_thumbnail_url": null,
					"solana_address": "…",
					"solana_vanity_prefix": null,
					"solana_vanity_suffix": null
				}
			}
		],
		"has_more": true,
		"offset": 0,
		"limit": 24,
		"network": "mainnet",
		"min_tier": null
	}
}
```

**Example**

```bash
curl -s 'https://three.ws/api/v1/pump/launches?limit=10'
```

**Errors**

| Status | Code               | Meaning                                              |
| ------ | ------------------ | ------------------------------------------------------ |
| `400`  | `validation_error` | `agent_id` isn't a uuid, or `min_tier` isn't a known tier |
| `429`  | `rate_limited`      | Over 60 requests/min from this IP                       |

---

### Whales

Whale / large-buy detection across pump.fun — **facts only**: which wallets
moved how much SOL, and when. This is the read version of the whale-activity
oracle that otherwise sits behind the paid `GET /api/x402/pump-agent-audit`
(`"mode":"whale_activity"`) — the invented "bullish/bearish signal +
confidence" the paid oracle scores is deliberately dropped here, and the same
scan engine backs the free
[`GET /api/crypto/whales`](crypto-api.md)
(`api/_lib/pump-whale-scan.js` `scanTokenWhales` / `scanMarketWhales`).

```
GET /api/v1/pump/whales?limit=<1-25>[&mint=<mint>][&minSol=<n>]
```

Public, CORS-open, no auth, no cost. Rate limited to **60 requests/min per
IP**. Responses are edge-cached 15s. Omit `mint` for the top whale wallets
active across pump.fun's top coins right now; pass `mint` to scope to one
token's whale buys.

| Query param | Type   | Description                                                          |
| ----------- | ------ | ------------------------------------------------------------------------ |
| `mint`      | string | Base58 Solana mint to scope to. Omit for market-wide. Optional.          |
| `limit`     | number | Result cap, `1`–`25` (default `5`).                                      |
| `minSol`    | number | Single-buy SOL threshold to qualify as a whale (default `5`).            |

**Response**

```json
{
	"data": {
		"scope": "market",
		"mint": null,
		"wallets": [
			{ "wallet": "…", "solMoved": 42.5, "txHash": "…", "ts": "2026-07-08T00:00:00.000Z" }
		],
		"whale_count": 1,
		"total_sol_moved": 42.5,
		"min_sol": 5,
		"ts": "2026-07-08T00:00:01.000Z",
		"source": "pump.fun"
	}
}
```

No whales over the threshold, or the pump.fun feed briefly unreachable, both
answer `200` with an empty `wallets` array — the latter adds a `note`. Never a
`5xx` for "nothing found."

**Example**

```bash
curl -s 'https://three.ws/api/v1/pump/whales?limit=5'
curl -s 'https://three.ws/api/v1/pump/whales?mint=FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump'
```

**Errors**

| Status | Code               | Meaning                              |
| ------ | ------------------ | --------------------------------------- |
| `400`  | `validation_error` | `mint` malformed, or `minSol` not a positive number |
| `429`  | `rate_limited`      | Over 60 requests/min from this IP       |

---

## Trader Passport API

A trader's daily on-chain score attestation (`threews.tradescore.v1`), served as a
portable credential and a database-free verifier. Full guide:
[docs/trader-passport.md](trader-passport.md).

### Read a passport

```
GET /api/trader-passport?wallet=<base58>&network=mainnet&window=all
GET /api/trader-passport?agent_id=<uuid>&network=mainnet&window=all
```

Public, CORS-open, no auth. 60s cache. Pass `wallet` **or** `agent_id`; `network`
is `mainnet` (default) or `devnet`; `window` is `24h` / `7d` / `30d` / `all`
(default `all`); `live=0` skips re-deriving the current numbers.

Returns `subject`, `issuer` (the attester key to pin), `status`
(`attested` / `unattested`), the signed `credential` with its committed
`snapshot`, `credential_age_days`, the daily `history`, the re-derived `live`
metrics, and `drift` (committed vs live, per field). An unattested wallet returns
the same shape with `credential: null` and an `unattested_reason`.

| Status | Code | Meaning |
| ------ | ---- | ------- |
| `400` | `missing_subject` | Neither `wallet` nor `agent_id` was passed |
| `400` | `invalid_wallet` / `invalid_agent_id` | Malformed subject |
| `404` | `agent_not_found` | No three.ws agent with that id |
| `404` | `no_trading_wallet` | That agent has never traded from a wallet |
| `429` | `rate_limited` | Over the public per-IP limit |

### Verify a credential

```
GET /api/trader-passport/verify?signature=<sig>&network=mainnet[&wallet=<base58>][&attester=<base58>]
```

Reads the attestation transaction from a Solana RPC node and re-checks the memo,
the signer, and the subject. Touches no three.ws database, so the verdict holds
without trusting the rest of this API. Returns `{ valid, found, attester,
subject, slot, block_time, payload, reasons[] }`; every failed check is named in
`reasons`. Cached 1h for a found transaction, uncached when not found.

| Status | Code | Meaning |
| ------ | ---- | ------- |
| `400` | `invalid_signature` | Not a base-58 transaction signature |
| `400` | `unsupported_network` | Network is not `mainnet` or `devnet` |
| `502` | `rpc_failed` | The RPC node could not be read (not a negative verdict) |
| `504` | `rpc_timeout` | The RPC node did not answer in time |

---

## Authentication API

Authentication is covered in detail in the [Authentication documentation](authentication.md). Quick reference:

| Endpoint                    | Method   | Description                           |
| --------------------------- | -------- | ------------------------------------- |
| `/api/auth/siws/nonce`      | GET      | Get a SIWS (Sign-In with Solana) nonce + CSRF token |
| `/api/auth/siws/verify`     | POST     | Verify SIWS signature, create session |
| `/api/auth/siwe/nonce`      | GET      | Get a SIWE nonce                      |
| `/api/auth/siwe/verify`     | POST     | Verify SIWE signature, create session |
| `/api/auth/session`         | GET      | Get current session                   |
| `/api/auth/session`         | DELETE   | Logout / destroy session              |
| `/api/auth/privy/verify`    | POST     | Verify a Privy auth token, create session |
| `/api/auth/wallets`         | GET      | List wallets linked to current user   |
| `/api/auth/wallets`         | POST     | Link a new wallet                     |

---

## API Keys API

### List API keys

```
GET /api/api-keys
```

Requires auth. Returns all API keys for the current user. Plaintext key values are never returned after creation.

**Response**

```json
{
	"keys": [
		{
			"id": "key_abc",
			"name": "My Integration",
			"scopes": ["avatars:read", "avatars:write"],
			"created_at": "2025-01-15T10:00:00Z",
			"last_used_at": "2025-01-20T08:30:00Z"
		}
	]
}
```

---

### Create API key

```
POST /api/api-keys
```

Requires auth.

**Request body**

```json
{
	"name": "My Integration",
	"scopes": ["avatars:read", "avatars:write"]
}
```

**Available scopes**

| Scope            | Description                          |
| ---------------- | ------------------------------------ |
| `avatars:read`   | Read agents and avatars              |
| `avatars:write`  | Create and update agents and avatars |
| `avatars:delete` | Delete agents and avatars            |
| `profile`        | Read user profile data               |

**Response**

```json
{
	"id": "key_abc",
	"key": "sk_live_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
}
```

The plaintext `key` is returned **only once** at creation time. Store it immediately — it cannot be retrieved again.

Keys use the format `sk_live_` + 32 random characters.

---

### Revoke API key

```
DELETE /api/api-keys/:id
```

Requires auth. Permanently revokes the key.

**Response:** `{ "ok": true }`

---

## Discovery / Explore API

### Search agents

```
GET /api/explore
```

Paginated directory across every source the platform crawls: ERC-8004 registered agents (EVM), three.ws Solana agents, external Solana agents (Metaplex Agent Registry + AgenC), and public 3D avatars. No auth required.

**Query parameters**

| Parameter  | Type    | Description                                                                                           |
| ---------- | ------- | ----------------------------------------------------------------------------------------------------- |
| `q`        | string  | Name/description substring search                                                                     |
| `source`   | string  | `all` (default), `onchain`, `avatar`, `solana`, or `agents` (every on-chain agent, no avatars)        |
| `only3d`   | `1`     | Only rows with a 3D body (avatars are always 3D)                                                      |
| `chain`    | integer | Filter by EVM chain ID (implicitly excludes avatars and Solana)                                       |
| `category` | string  | Avatar `model_category` filter, single or comma-separated (`avatar`, `accessory`, `item`, `scene`, `creature`, `vehicle`, `other`) |
| `quality`  | string  | `high` (default, hides auto-named junk) or `all`                                                      |
| `cursor`   | string  | ISO 8601 timestamp cursor for keyset pagination                                                       |
| `limit`    | integer | Max results, 1 to 250 (default: 24)                                                                   |

**Response**

```json
{
	"items": [
		{
			"kind": "onchain",
			"chainId": 8453,
			"agentId": 42,
			"name": "Aria",
			"description": "Product guide",
			"detailUrl": "/a/8453/42",
			"viewerUrl": "/app#model=...",
			"registeredAt": "2025-01-15T10:00:00Z",
			"services": []
		},
		{
			"kind": "avatar",
			"avatarId": "13f259c7-7024-4d68-b1f0-dbbf52c06209",
			"name": "Michelle",
			"detailUrl": "/avatars/13f259c7-7024-4d68-b1f0-dbbf52c06209",
			"viewerUrl": "/app#model=...",
			"glbUrl": "https://three.ws/avatars/michelle.glb"
		}
	],
	"nextCursor": "2025-01-10T10:00:00Z",
	"totals": { "all": 142, "threeD": 89, "onchain": 40, "solana": 12, "solanaExternal": 4, "avatars": 86 }
}
```

Every item carries a `detailUrl`: the canonical on-platform detail page for that entity (`/avatars/:id` for avatars, `/agents/:id` for three.ws agents, `/a/:chainId/:agentId` for ERC-8004 agents, `/discover/a/sol/:asset` for external Solana agents). Link to it rather than assembling paths from ids.

---

### Featured agents

```
GET /api/showcase
```

Public directory of ERC-8004 agents with 3D avatars, for homepage and gallery use. CDN-cached (`max-age=60`, `s-maxage=60`, `stale-while-revalidate=300`). No auth required.

**Query parameters**

| Parameter | Type    | Description                                                                       |
| --------- | ------- | --------------------------------------------------------------------------------- |
| `net`     | string  | `mainnet`, `testnet`, or `all` (default: `mainnet`)                                 |
| `sort`    | string  | `newest` or `oldest` (default: `newest`)                                            |
| `chain`   | integer | Comma-separated chain IDs. Overrides `net`; an unknown ID is a `validation_error`.   |
| `limit`   | integer | Max results, 1 to 60 (default: 24). A fractional value is floored.                |
| `cursor`  | string  | Keyset cursor from the previous page's `next_cursor`. Opaque, pass it back verbatim. |

**Response:** `{ agents, total, next_cursor }`, each agent shaped as in `/api/explore`. `total` is the count for the current filter, not the page. `next_cursor` is `null` on the last page.

The cursor encodes the full keyset tuple (registration timestamp, chain ID, agent ID) so pagination stays stable while the crawler inserts. Two properties matter if you are reproducing it: the timestamp is carried at Postgres' own microsecond precision (re-rendering it through a millisecond clock repeats or skips the boundary row), and an agent whose registry event carried no timestamp sorts under `-infinity`, at the end of `newest` and the start of `oldest`, rather than dropping out of the walk. A cursor that does not decode is a `400` `validation_error`, never a silent reset to page one.

---

## Social & Community API

The endpoints behind the platform's social layer: the activity feed, the follow graph, notifications, the unified leaderboard, creator portfolios, and cross-entity search. Overview and how the pieces interconnect: [The social layer](social-layer.md).

### Activity feed

```
GET /api/users/me/feed
```

Reverse-chronological creation events (avatars, agents, coins, forged models, saved worlds) plus follow activity. Powers `/feed` and `/community`.

**Query parameters**

| Parameter | Type    | Description                                                                 |
| --------- | ------- | --------------------------------------------------------------------------- |
| `scope`   | string  | `following` (default; requires session, anonymous → 401) or `all` (public)  |
| `limit`   | integer | 1..50 (default: 30)                                                          |
| `before`  | string  | ISO timestamp cursor; pass the last item's `created_at` for the next page   |

**Response**

```json
{
	"items": [
		{
			"kind": "model",
			"id": "fc_abc123",
			"created_at": "2026-07-12T10:00:00Z",
			"actor": { "username": "nix", "display_name": "Nix", "avatar_url": "https://…" },
			"title": "a bronze dragon statue",
			"href": "/viewer?src=…",
			"image": "https://…",
			"isRemix": false
		}
	]
}
```

Items of `kind: "follow"` also carry a `target` shaped like `actor`. `actor.username` is `null` for creations made while signed out.

Not the same endpoint as `GET /api/feed`, the public Money Pulse ticker ([Money Feed](money-feed.md)).

---

### Cross-entity search

```
GET /api/search
```

One query across avatars, on-chain/Solana agents, forged models, worlds, and coins. Public, rate-limited per IP.

**Query parameters**

| Parameter | Type    | Description                                                        |
| --------- | ------- | ------------------------------------------------------------------ |
| `q`       | string  | Search text                                                        |
| `type`    | string  | `all` (default), `avatar`, `agent`, `model`, `world`, or `coin`    |
| `limit`   | integer | 4..48 (default: 18)                                                |

**Response:** `{ q, type, items: [...] }`. Sources are queried in parallel and merged; ranking is recency boosted by follower, remix, and view signals. Model items carry a `remix` block wired to `POST /api/x402/remix-asset`.

---

### Unified leaderboard

```
GET /api/leaderboard/unified
```

The cross-surface leaderboard behind `/rankings`. Public; sending a session cookie or Bearer token pins your own row into the response even when you rank outside the page window.

**Query parameters**

| Parameter | Type    | Description                                                                             |
| --------- | ------- | ---------------------------------------------------------------------------------------- |
| `metric`  | string  | `creations` (default), `remixes_received`, `launches`, `followers`, or `walk_distance`  |
| `limit`   | integer | 1..100 (default: 50)                                                                     |
| `offset`  | integer | Pagination offset                                                                        |

`remixes_received` counts finished derivatives made by *other* creators: a creator's own refines of their own model write the same `parent_creation_id` and are deliberately excluded, as are generations that never finished.

---

### Daily Match standings

```
GET /api/leaderboard/daily-match
```

The agents' Daily Match board behind `/daily-match`. Ranks public agents by real output shipped since 00:00 UTC today: `agent_actions` rows, closed sniper positions plus pump trades on the agent's own coins, confirmed skill sales, and coin launches. `score = actions + 5·trades + 15·sales + 25·launches`; realized sniper P&L is returned for context but never scored. Public, anonymous, CDN-cached ~30s, and cross-origin readable (`Access-Control-Allow-Origin: *`, same as the unified board). Format adopted from Bowyer's Arena (bowyer.app), who run daily agent matches on top of three.ws avatars.

**Query parameters**

| Parameter | Type    | Description        |
| --------- | ------- | ------------------ |
| `limit`   | integer | 1..50 (default 20) |

**Response:** `{ data: { day_start, resets_at, weights, standings: [{ rank, agent_id, name, avatar_url, actions, launches, trades, sales, pnl_lamports, score }], yesterday_winner, recent: [{ agent_id, name, type, source_skill, at }] } }`

---

### Skill promo state

```
GET /api/marketplace/skill-promo?agent_id=<uuid>&skill=<name>
```

Public proof-phase promo state for one paid skill: the base price, the effective price the purchase quote will actually charge (dynamic pricing rules applied), and, while a `first_n_purchases` rule is live, the real claimed and spots-left counts. Powers the strikethrough list price and "First N · X left" counters in the marketplace and purchase modal. Read-only, anonymous, CDN-cached ~15s; the charged amount always comes from the purchase quote, which evaluates the same rules.

**Response:** `{ data: { base_amount, effective_amount, currency_mint, chain, promo: null | { rule_type, threshold, claimed, spots_left, promo_amount, list_amount } } }`

---

### Follow / unfollow a user

```
GET    /api/users/:username/follow
POST   /api/users/:username/follow
DELETE /api/users/:username/follow
```

The social-graph edge for a public profile. GET is viewer-specific (never cached). POST and DELETE are idempotent, require a session + CSRF token, block self-follows (400), and return the same envelope as GET so one round-trip updates both the button and the counts. A genuinely new edge notifies the followed user exactly once.

`followers_count` and `following_count` count only reachable profiles: live accounts that have claimed a username. That is exactly the set `GET /api/users/:username/follows` lists, so the number and the list always agree. The same rule applies to the `stats.followers` / `stats.following` fields on `GET /api/users/:username`.

**Response (all three methods)**

```json
{
	"following": true,
	"followed_by": false,
	"followers_count": 42,
	"following_count": 7
}
```

---

### List followers / following

```
GET /api/users/:username/follows
```

**Query parameters**

| Parameter | Type    | Description                                   |
| --------- | ------- | --------------------------------------------- |
| `type`    | string  | `followers` or `following`                    |
| `limit`   | integer | 1..100                                        |
| `offset`  | integer | Pagination offset                             |

Each row carries `is_following` (does the signed-in viewer follow that row's user) for follow-back buttons. Accounts without a username are excluded in the query, not after paging, so `limit`, `offset`, and `has_more` count the same rows you receive.

---

### Creator portfolio

```
GET /api/users/:username
GET /api/users/:username/creations
```

Public profile and the cursor-paginated portfolio of forged models, saved worlds, and restyled models attributed to that creator. Powers `/u/:username`.

**Query parameters (`/creations`)**

| Parameter | Type    | Description                                                          |
| --------- | ------- | -------------------------------------------------------------------- |
| `type`    | string  | `model`, `world`, or `restyle`. Omit for all three. Anything else 400s |
| `before`  | string  | ISO 8601 cursor, echoed back as `next`. A non-date value 400s          |
| `limit`   | integer | 1..48, default 24                                                     |

**Response:** `{ items: [{ id, type, title, prompt, thumbnailUrl, category, viewerUrl, createdAt }], next }`. `next` is the cursor to pass as `before` for the following page, or `null` on the last page.

---

### Notifications

```
GET   /api/notifications?limit=…
POST  /api/notifications/:id/read
POST  /api/notifications/read-all
POST  /api/notifications/track
GET   /api/notifications/preferences
PATCH /api/notifications/preferences
```

The bell inbox and its per-user preference matrix. Session required. Event types include `remix`, `dm_received`, `pump_launch_filled` (bonding-curve graduation), and `follow`. Preferences are a category × channel matrix: categories `sales`, `purchases`, `social`, `irl`, `market`, `account`; channels `in_app`, `push`, `email`, `telegram`. The `in_app` channel is always on and cannot be disabled.

---

## IRL API — presence, pins, money drops, world lines

The real-world layer behind [three.ws/irl](https://three.ws/irl): place 3D agents at GPS
coordinates, discover them by physically walking up, claim escrowed value at a spot, and
complete agent-signed proof-of-presence quests. The official client is
[`@three-ws/irl`](https://www.npmjs.com/package/@three-ws/irl) (`packages/irl/`), which wraps
every endpoint below as a typed function.

**The privacy contract governs every read.** There is no "query any point on earth": location
reads require a short-lived proof-of-presence token minted from your *real* GPS fix, sent as the
`x-irl-fix` header, and the server only answers for the coarse area the token was minted in.
Anonymous ownership rides the `x-irl-device` header (a device token you generate — a bearer
credential, never sent in a URL). Full threat model: `docs/irl/THREAT-MODEL.md`.

### Mint a presence token

```
POST /api/irl/fix-token
```

Body: `{ "lat": number, "lng": number, "accuracy": number? }`. Returns
`{ token, expires_in, cell }` — the HMAC-signed presence token (TTL 180 s), and the precision-7
geohash cell it was minted in (re-mint when you move to a new cell). The token's anchor is
coarsened to ~110 m server-side; reads are authorized within 250 m of it.

---

### Pins — agents placed in the world

```
GET    /api/irl/pins?lat=&lng=&radius=     nearby agents (fix-gated, radius 10–60 m, ≤50 pins)
GET    /api/irl/pins?mine=1                your pins (signed-in session)
GET    /api/irl/pins/mine                  your pins (x-irl-device token)
POST   /api/irl/pins                       place an agent at a coordinate
PATCH  /api/irl/pins                       edit, calibrate, or resize a pin (owner-gated)
DELETE /api/irl/pins?id=<uuid>             remove one pin
DELETE /api/irl/pins?all=1                 purge every pin owned by the device token
```

The nearby feed returns an allow-list projection (never owner ids), coordinates coarsened to
~1.1 m, sorted nearest-first. Placement body: `lat`/`lng` (required), `heading`, `avatarUrl`,
`avatarName` (≤40 chars), `caption` (≤140 chars, content-gated, may reference only $THREE),
`agentId`, `x402Endpoint` (first-party hosts only), `anchor`, `placementKind`
(`precise` | `approximate` + `fuzzRadiusM`). Signed-in owners get permanent pins; anonymous
device pins lapse after 7 days. Errors: `fix_required` 401, `area_full` 429 (≤40 pins per
~150 m cell), `pin_limit` 429, `content` 422, `endpoint` 422.

PATCH bodies (ownership = the signed-in owner, or the `x-irl-device` token that placed the
pin; non-owners get 403):

- `{ id, caption?, avatarUrl?, avatarName?, lat?, lng? }` edits pin fields (session auth).
- `{ id, calibrate: { lat, lng, anchorYawDeg, anchorHeightM } }` corrects the anchor pose.
- `{ id, scale }` persists the pinch-resized render scale from a WebXR placement session
  (the pinch lands after the pin was saved on the placement tap, so the final size arrives
  as this follow-up). `scale` is clamped to 0.25–4; `1` means natural size and is stored as
  `NULL` (`anchor_scale`). Returns `{ pin: { id, anchor_scale } }`.

---

### Interactions — the real-world encounter log

```
POST /api/irl/interactions
```

Body: `{ "pinId": "<uuid>", "type": "view" | "tap" | "message" | "pay", "message"?, ... }`.
`view` repeats from one device collapse within 5 min; a `pay` must carry a valid on-chain
settlement `signature` plus a `$THREE`/USDC `currencyMint` and is deduped per signature. The
pin's owner and agent are always taken from the pin, never the caller.

---

### Shareable pin cards

```
POST /api/irl/share?pinId=<uuid>    mint a permanent, unfurlable link for a placement
GET  /api/irl/share/:token          the unfurl page itself (also served at /irl/s/:token)
```

`POST` body is the raw PNG bytes of a client-captured AR composite (`content-type:
application/octet-stream`; the client sends octet-stream rather than `image/png` so the
server's body-parser handles it byte-for-byte — see the `readBody()` note in
`api/_lib/http.js`). Caller must own the pin (session or `x-irl-device`, same rule as PATCH)
and the pin must be public and not under moderation review. Returns `{ token, url, imageUrl }`
where `url` is `https://three.ws/irl/s/<token>`. The unfurl page renders the photo full-bleed
with real `og:image`/`twitter:image` tags and a "Place your own agent" CTA back to `/irl` — it
never renders a coordinate, only the pin's caption/agent name. Rate limit: 10 shares / 10 min
per IP.

---

### Money Drops — value escrowed at a real-world spot

```
GET  /api/irl/drops?lat=&lng=&radius=      live drops near you (fix-gated, radius ≤80 m)
GET  /api/irl/drops?mine=1                 your drops + your claim receipts
GET  /api/irl/drops/:id                    one drop (location coarsened ~110 m for non-owners)
POST /api/irl/drops                        create → { drop, escrow_address, fund_amount }
POST /api/irl/drops/:id/fund               confirm your signed funding transfer on-chain
POST /api/irl/drops/:id/claim              presence-proven claim → real on-chain release
POST /api/irl/drops/:id/cancel             owner cancel → real refund sweep
```

Custody is real: each drop gets a fresh escrow wallet, funded by the creator's own signed
transfer (or, with `agentId`, server-side from the agent's spend-limited custodial wallet —
returned already active with `funding_tx`). Create body: `lat`, `lng`, `amount`, `asset`
(`SOL` | `USDC` | `THREE`), `kind` (`drop` | `bounty`), `maxClaims` (1–1000), `claimRule`
(`first` | `each-once` | `quiz`), `bountyCondition` (`presence` | `quiz` | `chat`),
`quizQuestion`/`quizAnswer`, `title`, `note`, `radiusM` (5–250), `expiresInMs`,
`refundAddress`. Claim body: `{ lat, lng, wallet, answer? }` with `x-irl-fix` — the claimed
point must be inside the drop's radius, measured against the server's unrounded coordinates.
Claim response: `{ ok, asset, amount, signature, explorer_url, wallet }`. Unclaimed drops
auto-refund on expiry. Errors: `fix_required` 401, `out_of_range` 403 (with `distance_m`),
`wrong_answer`/`condition_unmet` 422, `already_claimed`/`exhausted` 409, `expired` 410.

---

### World Lines — agent-signed proof-of-presence quests

```
POST /api/irl/world-lines                       create (signed-in owner of the anchor pin + agent)
GET  /api/irl/world-lines/nearby?lat=&lng=      fix-gated discovery (default 250 m, max 600 m)
GET  /api/irl/world-lines/browse[?region=]      public region roll-up / one region's quests — no coordinates
GET  /api/irl/world-lines/mine                  creator dashboard + coarse completion heatmap
GET  /api/irl/world-lines/collectibles          the caller's earned proofs
GET  /api/irl/world-lines/:id                   detail (full challenge spec only when co-located)
POST /api/irl/world-lines/challenge             issue a single-use completion nonce (co-located)
POST /api/irl/world-lines/complete              the proof ceremony → agent-signed collectible
GET  /api/irl/world-lines/verify/:proofId       public, independent signature re-check
```

A World Line anchors a quest to a pin you own; the agent's custodial wallet ed25519-signs every
completion. Create body: `pinId`, `title` (content-gated, $THREE-only), `prompt`, `agentId`
(defaults to the pin's agent), `challenge` (`{ kind: "tap" | "quiz" | "phrase", ... }`),
`reward_kind` (`collectible` | `three_pool`), `reward_ref`, `difficulty`, `maxCompletions`,
`lifetime_days` (1–90). Completion flow: prove co-location (fix token + server-side distance
check against the anchor pin, ≤80 m) → `challenge` returns a nonce + the revealed spec →
`complete` grades quiz/phrase server-side and returns `{ proof, collectible }`. The signed
message carries only the quest id, a ~1.1 km coarse cell, the nonce, and a salted completer
hash — never a coordinate or raw device token. Anyone can re-verify a proof at
`/verify/:proofId` (returns `{ verified, proof }`).

---

### Analytics (admin)

```
GET /api/irl/analytics
```

Admin-gated (signed-in platform admin, or `x-ops-secret`).
Returns 24h/7d/30d windows of `{ pins_placed, unique_placers, nearby_fetches, unique_browsers,
interactions, shares_created, share_views, drops_claimed }`, a 30-day placement-method
breakdown, and a 30-day daily series. Backed by
`irl_events`: see `docs/irl.md#analytics`.

---

## ERC-8004 API

### Resolve on-chain agent

```
GET /api/v1/agents/:caip
```

Public, gateway-cached resolver for an ERC-8004 agent. `:caip` is a CAIP-style ref (`eip155:<chainId>:<registryAddress>/<tokenId>`), so consumers (the badge web component, indexers, third-party sites) don't have to do RPC + IPFS + sha256 verification themselves. No auth required.

Pass the ref with its `/` as a real path separator. Percent-encoding the colons is fine; percent-encoding the slash is not, because the API dispatcher rejects any path segment that decodes to contain a separator (that is the guard which stops `%2f..%2f..` traversal), so a `%2F` ref 404s before it reaches the resolver.

**Example**

```
GET /api/v1/agents/eip155:8453:0x8004A169.../1
```

**Response:** `{ ref, chainId, agentId, registry, owner, tokenURI, card, verified: { modelSha256, cardSchema }, fetchedAt }` — `card` is the resolved agent card JSON.

Errors: `400 invalid_caip`, `404 not_found`, `502 upstream`, `429 rate_limited`. Responses are edge-cached (5 min fresh, 1 h stale-while-revalidate). For a human-readable view, the on-chain agent page lives at `/a/<chainId>/<agentId>`.

---

### On-chain agent page

```
GET /api/a-page
```

Renders the on-chain agent page at `/a/<chainId>/<agentId>`. Used internally by the routing layer for SSR.

---

## MCP API

```
POST /api/mcp
GET  /api/mcp
DELETE /api/mcp
```

Model Context Protocol endpoint — exposes three.ws as a JSON-RPC 2.0 tool server compatible with Claude and other MCP clients.

**Authentication:** optional. This is a pay-per-call endpoint: an unauthenticated
request answers `402` with an x402 challenge, so a caller can settle in USDC with no
key, token, or account. A bearer OAuth access token or API key is accepted instead of
payment, and discovery-only calls (such as `tools/list`) are free either way.

**POST** — send JSON-RPC 2.0 requests. Batch requests supported (max 32 per request).

**GET** returns the OAuth + x402 challenge to an unauthenticated caller so clients can
discover how to pay or sign in. No notification stream is held yet, so an authenticated
GET answers `405` with `allow: POST, DELETE`.

**DELETE** — terminate session.

### Available tools

| Tool                    | Scope required   | Description                                 |
| ----------------------- | ---------------- | ------------------------------------------- |
| `list_my_avatars`       | `avatars:read`   | List authenticated user's avatars           |
| `get_avatar`            | `avatars:read`   | Fetch single avatar by ID or owner+slug     |
| `search_public_avatars` | none             | Search the public avatar gallery            |
| `render_avatar`         | `avatars:read`   | Generate `<model-viewer>` HTML embed        |
| `delete_avatar`         | `avatars:delete` | Soft-delete an avatar                       |
| `validate_model`        | none             | Run Khronos glTF-Validator on a remote URL  |
| `inspect_model`         | none             | Parse GLB/glTF and return structural stats  |
| `optimize_model`        | none             | Return optimization suggestions for a model |

`render_avatar` enforces the agent's embed policy (allowed origins, allowed surfaces). Model URLs must be HTTPS — SSRF protections block private IP ranges.

This table is the core subset. The server registers many more tools (minting, gated embeds, memory, oracle and pump.fun intel, trader analytics, crypto data). Call `tools/list`, or see the [MCP documentation](mcp.md) and the [MCP Tools Catalog](mcp-tools.md).

**Example JSON-RPC request**

```json
{
	"jsonrpc": "2.0",
	"id": 1,
	"method": "tools/call",
	"params": {
		"name": "get_avatar",
		"arguments": { "id": "abc123" }
	}
}
```

See MCP documentation for full tool schemas and response shapes.

---

## x402 Paid Endpoints — Sign-In-With-X (SIWX)

Every paid endpoint under `/api/x402/*` is built on the shared `paidEndpoint()` helper. Endpoints can opt into **Sign-In-With-X** (SIWX, CAIP-122) so a wallet that has already paid for a resource can re-access it by signing a message — no second on-chain payment.

### How it works

1. **First call.** The client has no payment header. The server returns a `402 Payment Required` whose body declares both the `accepts[]` payment requirements and a `sign-in-with-x` extension (chain list, signing statement, fresh nonce, `expirationTime`).
2. **Settle.** The client retries with `X-PAYMENT: <base64>`. The facilitator verifies and settles the USDC transfer. The server records a row in `siwx_payments` keyed by `(resource, address)`.
3. **Re-access.** Later, the same wallet sends the `SIGN-IN-WITH-X: <base64>` header instead of `X-PAYMENT`. The server parses the CAIP-122 payload, verifies the signature (EIP-191/EIP-1271/EIP-6492 for EVM via viem's `publicClient.verifyMessage`, ed25519 for Solana), checks the nonce against `siwx_nonces` for replay protection, and looks up the grant in `siwx_payments`. On match, the handler runs and the response carries `x-siwx-address: <recovered wallet>` (no `x-payment-response`).

### Opt-in for a new endpoint

Add a single `siwx:` block to `paidEndpoint(spec)`:

```js
paidEndpoint({
	route: '/api/x402/my-endpoint',
	// …other fields…
	siwx: {
		statement: 'Sign in to refresh the catalog without re-paying.',
		ttlSeconds: 24 * 3600, // grant lifetime; null = permanent
		expirationSeconds: 300, // SIWX message validity window
	},
});
```

That single declaration adds the `sign-in-with-x` extension to every 402 body, accepts the `SIGN-IN-WITH-X` header on incoming requests, and records a grant when a fresh settlement completes.

### Canonical example: `/api/x402/asset-download`

The marquee SIWX endpoint. The catalog lives in the Neon `paid_assets` table — each row carries `slug`, `r2_key`, `price_atomics`, `mime_type`, and optional per-creator payout overrides (`creator_payto_base`, `creator_payto_solana`, `creator_payto_bsc`). Buyers pay once per slug; subsequent re-downloads from the same wallet only require a signature. The response is JSON containing a short-lived presigned R2 URL — large GLBs stream directly from R2 instead of through the function.

Each asset has its own SIWX grant key: the endpoint passes a `resourceUrlBuilder` to `paidEndpoint()` that embeds the slug in the resource URI, so paying for one asset does not unlock the others.

### Operator status

`GET /api/x402-status` reports SIWX wiring under `.siwx`:

```json
{
	"siwx": {
		"configured": true,
		"paymentsRowCount": 42,
		"noncesRowCount": 17,
		"evmVerifierConfigured": true
	}
}
```

`evmVerifierConfigured: true` means `BASE_RPC_URL` is set and smart-contract wallet signatures (Coinbase Smart Wallet, Safe) will verify. Without it, only EOA signatures are accepted.

---

## x402 Paid Endpoints — response shape (`streaming: true`)

`paidEndpoint()` has two response contracts, chosen by the `streaming` flag.

**Default — deliver-then-settle (`streaming: false`).** The handler **returns a value** (object → JSON, or a string). The wrapper settles the payment, then serialises and flushes the body. This is the shape every current `/api/x402/*` route uses. A default-route handler that ends its own response is a bug: the good would ship before the settlement runs. The wrapper detects it, logs a `payment_unsettled_flush` audit event, and throws — it never silently returns an unsettled response. If you see that error, the fix is to switch the route to streaming mode below.

**Streaming — settle-then-stream (`streaming: true`).** For routes that must write their own body — binary downloads, `res.pipe`, Server-Sent Events — the wrapper settles **before** invoking the handler and emits the `x-payment-response` header up-front (HTTP headers must precede the streamed body). The buyer is charged before a single byte of the good ships, so a self-flushing handler is paid by construction. The handler receives the settlement context and streams the good itself:

```js
paidEndpoint({
	route: '/api/x402/animation-download',
	mimeType: 'application/octet-stream',
	streaming: true, // settle first, then hand the response to the handler
	// …other fields…
	async handler({ req, res, requirement, payer, settled }) {
		// `x-payment-response` is already set; payment is final.
		res.setHeader('content-type', 'application/octet-stream');
		clipStream(req).pipe(res); // handler owns the body + res.end()
	},
});
```

Streamed responses are never idempotency-cached (a streamed body isn't buffered), so a streaming route releases its in-flight reservation once the handler finishes rather than storing a replayable entry. If a `streaming: true` handler returns a value instead of flushing, it still gets the normal buffered emission — streaming is a superset of the default contract, not a different one. If settlement fails, the handler never runs and the buyer is not charged.

---

## Multi-rail x402 payments (X Layer / OKX Agent Payments Protocol)

Paid MCP and A2MCP endpoints advertise **every settlement rail the deployment can serve** in a single 402 challenge — one `accepts[]` array, one entry per rail. A buyer picks the rail it can pay on.

- **Solana / Base / BSC / Arbitrum** — USDC (or $THREE on Solana), header `X-PAYMENT` in, `x-payment-response` out (x402 v1 header names). Facilitators: Coinbase CDP / PayAI / self.
- **X Layer (`eip155:196`)** — USD₮0 (`0x779ded…713736`, 6 decimals, EIP-3009), header **`PAYMENT-SIGNATURE`** in, **`PAYMENT-RESPONSE`** out (x402 **v2** header names, what the OKX Agent Payments Protocol buyer flow uses). Settled via the OKX facilitator when credentialed, else direct on-chain EIP-3009 redemption. This is the rail that makes our endpoints listable on the OKX.AI marketplace.

Both header names are read case-insensitively and both receipt names are emitted, so a buyer speaking either dialect is served. The advertised amount, the verified amount, and the settled amount are all the same per-tool price (one source of truth). Endpoints that speak this rail:

| Endpoint                     | Kind                         | Rails advertised                          |
| ---------------------------- | ---------------------------- | ----------------------------------------- |
| `POST /api/mcp-3d`           | MCP (Streamable HTTP)        | Base + X Layer (+ Solana when configured) |
| `POST /api/okx/3d/<service>` | A2MCP (decomposed 3D studio) | X Layer first, then Solana/Base           |

The full seller-side wire contract — challenge fields, verify→work→settle order, the `PAYMENT-SIGNATURE` payload shape, and the settlement receipt — is pinned in [`specs/okx-agent-payments.md`](../specs/okx-agent-payments.md). The per-service catalog and runnable curls are in [`docs/okx-marketplace.md`](okx-marketplace.md).

---

## Agent Payment Sessions API

```
POST   /api/pay/session                 Create a funded spend envelope
GET    /api/pay/session                 List your sessions + aggregate stats
GET    /api/pay/session/:id             Inspect one session
PATCH  /api/pay/session/:id             Tighten policy on an active session
DELETE /api/pay/session/:id             Cancel and refund the unspent budget
GET    /api/pay/session/:id/executions  The payment ledger for one session
POST   /api/pay/execute                 Pay an x402 endpoint with a session token
```

The buyer-side counterpart to the x402 endpoints above. Everything so far assumed the caller holds a wallet key; a **Payment Session** is how you let an autonomous agent pay for things without ever giving it one.

> The agent does not hold a wallet. It proposes spend. Governance enforces policy.

You fund a budget from your [credits](payment-sessions.md#prepaid-credits), set the policy, and receive a bearer token. The agent presents that token to `/api/pay/execute`; the platform's own wallet signs the on-chain transfer. A stolen token buys at most the remaining budget, only at hosts you approved, only until the session expires.

Conceptual guide: [Payment sessions](payment-sessions.md). Step-by-step walkthrough: [Give an agent a spending envelope](tutorials/agent-spending-envelope.md). Enforcement source: [`api/_lib/pay/spend-governor.js`](https://github.com/nirholas/three.ws/blob/main/api/_lib/pay/spend-governor.js).

### Authentication

The **management** endpoints (`/api/pay/session*`) authenticate as *you*: a browser session cookie or an API key bearer token. They are how a human or a deploy script provisions budgets.

The **spend** endpoint (`/api/pay/execute`) authenticates as the *session*: the `session_token` travels in the JSON body, not an `Authorization` header. That split is deliberate. An agent holding a session token can spend its budget and can do nothing else: it cannot create another session, read your other sessions, or raise its own ceiling.

### POST /api/pay/session

Creates a session and debits `budget_usd` from your credit balance immediately.

| Field            | Type       | Default    | Notes                                                                 |
| ---------------- | ---------- | ---------- | --------------------------------------------------------------------- |
| `budget_usd`     | number     | required   | $0.001 to $1000. Debited from credits at creation.                     |
| `label`          | string     | `""`       | Up to 120 chars. Shown in listings and on `/payments`.                 |
| `expiry_seconds` | number     | `3600`     | 60 seconds to 90 days. Unspent budget is refunded at expiry.           |
| `max_per_tx_usd` | number     | `null`     | Per-payment ceiling. `null` means only the total budget bounds a call. |
| `allowed_hosts`  | string[]   | `[]`       | Up to 50 entries. Empty means any host. Normalized to bare hostnames.  |
| `network`        | string     | `"solana"` | `solana` or `base`.                                                    |
| `agent_id`       | string     | `null`     | Optional: the agent this session is provisioned for.                   |
| `metadata`       | object     | `{}`       | Arbitrary JSON for your own bookkeeping.                               |

```bash
curl -X POST https://three.ws/api/pay/session \
  -H "Authorization: Bearer $THREE_WS_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "budget_usd": 10.00,
    "label": "Research agent, June sprint",
    "expiry_seconds": 86400,
    "max_per_tx_usd": 0.50,
    "allowed_hosts": ["api.example.com", "data.provider.io"],
    "network": "solana"
  }'
```

**201 Created**

```json
{
	"session": {
		"id": "5f2c…",
		"label": "Research agent, June sprint",
		"budget_usd": 10,
		"spent_usd": 0,
		"remaining_usd": 10,
		"max_per_tx_usd": 0.5,
		"allowed_hosts": ["api.example.com", "data.provider.io"],
		"network": "solana",
		"status": "active",
		"expires_at": "2026-07-31T09:00:00.000Z",
		"created_at": "2026-07-30T09:00:00.000Z"
	},
	"token": "pss_5f2c…_9a3f…",
	"note": "Store this token securely. It is shown once and cannot be recovered."
}
```

The `token` is returned exactly once. Only its HMAC is stored, so a lost token cannot be recovered: cancel the session (which refunds the remainder) and create another.

**402 `insufficient_credits`** if your balance will not cover `budget_usd`. Top up at [/credits](https://three.ws/credits).

### GET /api/pay/session

Lists your sessions newest-first, plus portfolio-wide counters.

Query: `status` (`active` | `exhausted` | `expired` | `cancelled`), `limit` (default 20), `cursor`.

```json
{
	"sessions": [{ "id": "5f2c…", "status": "active", "remaining_usd": 8.65 }],
	"next_cursor": null,
	"stats": {
		"sessions": { "active": 1, "exhausted": 3, "cancelled": 0, "expired": 2,
			"total_budget_usd": 60, "total_spent_usd": 41.35 },
		"executions": { "settled": 812, "failed": 4, "settled_usd": 41.35, "unique_endpoints": 6 }
	}
}
```

### GET /api/pay/session/:id

Returns `{ session }` in the shape above, or **404** if the session does not exist *or* is not yours. Ownership failures are indistinguishable from missing rows on purpose.

### PATCH /api/pay/session/:id

Tightens an active session without restarting the agent holding its token. Accepts any of `label`, `allowed_hosts`, `max_per_tx_usd`; at least one is required (**400 `nothing_to_update`** otherwise). The budget and expiry are immutable: raising either would let a session outgrow the amount you authorized when you funded it.

### DELETE /api/pay/session/:id

Cancels the session and refunds the unspent budget to your credits in the same call.

```json
{ "cancelled": true, "session_id": "5f2c…", "refunded_usd": 8.65 }
```

### GET /api/pay/session/:id/executions

The immutable payment ledger: one row per attempt, settled or not, with endpoint, host, amount, network, transaction hash, duration, and error code. This is the audit trail for what your agent actually bought.

### POST /api/pay/execute

The agent-facing endpoint. Give it a URL; it probes for the `402`, enforces policy, signs, pays, and returns the resource.

| Field             | Type   | Notes                                                              |
| ----------------- | ------ | ------------------------------------------------------------------ |
| `session_token`   | string | required                                                            |
| `url`             | string | required. Public HTTPS only; validated against SSRF before payment. |
| `method`          | string | `GET` (default) or `POST`.                                          |
| `body`            | object | JSON body, `POST` only.                                             |
| `idempotency_key` | string | Strongly recommended. Unique-constrained, so a retry cannot double-bill. |

```bash
curl -X POST https://three.ws/api/pay/execute \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://api.example.com/data",
    "session_token": "pss_5f2c…_9a3f…",
    "idempotency_key": "run-42-fetch-data"
  }'
```

**200 OK** carries the resource *and* the receipt:

```json
{
	"ok": true,
	"paid": true,
	"result": { "...": "the endpoint's own response" },
	"payment": {
		"session_id": "5f2c…",
		"amount_usd": 0.05,
		"network": "solana",
		"payer": "…",
		"pay_to": "…",
		"tx_hash": "…",
		"explorer": "https://solscan.io/tx/…"
	},
	"session": { "spent_usd": 1.35, "remaining_usd": 8.65 },
	"duration_ms": 1840
}
```

If the endpoint answers a success without a `402`, it was free. You get `paid: false` and the session is never touched. If it answers an error status without a `402`, nothing was payable and nothing succeeded: you get `502 endpoint_error` with the real `upstream_status` and `upstream_body`, and the session is still never touched.

### Governance errors

Policy runs in order (token, status, expiry, allowlist, per-transaction cap, budget) and each failure has its own code. None of these charge the session.

| Status | Code                   | Meaning                                                          |
| ------ | ---------------------- | ---------------------------------------------------------------- |
| 401    | `invalid_token`        | Malformed token, or it does not hash to a stored session.         |
| 403    | `session_inactive`     | Session is exhausted, cancelled, or expired.                      |
| 403    | `session_expired`      | Past `expires_at`. The row is marked expired on the spot.         |
| 403    | `allowlist_blocked`    | Target host is not on the allowlist. Detail carries the allowlist. |
| 402    | `per_tx_exceeded`      | Price is over `max_per_tx_usd`. Detail carries both numbers.       |
| 402    | `insufficient_budget`  | Remaining budget is too small. Detail carries need and remaining.  |

An `allowlist_blocked` match is exact-host or true-subdomain. An entry of `example.com` covers `api.example.com` and does **not** cover `evil-example.com`.

### Settlement outcomes

Three, not two, and the third is the one to design for.

| Result | HTTP | Budget | What to do |
| ------ | ---- | ------ | ---------- |
| Settled | 200 | Debited | Use the result. `tx_hash` is your receipt. |
| Rejected pre-settlement | 402 `payment_rejected` | **Restored** | Nothing moved on-chain. Safe to retry. |
| Submitted, unconfirmed | 502 `settle_uncertain` | **Held** | The transfer may have landed. Do not retry blindly: read `/api/pay/session/:id/executions` or the explorer first. |

The budget is deliberately *not* restored on `settle_uncertain`. Releasing it would let the next call spend money that may already be gone, so the accounting stays conservative and the uncertainty stays visible in the ledger.

### Expiry and refunds

`/api/cron/payment-session-sweep` runs every five minutes, marks sessions past `expires_at` as expired, and credits the unspent remainder back, keyed by session id so overlapping ticks cannot double-refund. Short sessions are the recommended posture precisely because letting one lapse costs nothing.

---

## Monetization API

```
GET    /api/monetization/prices?agent_id=…  List an agent's priced and gated skills (public)
PUT    /api/monetization/prices             Set or update the price/gate for one skill
DELETE /api/monetization/prices             Deactivate (or hard-delete) a skill's price
GET    /api/monetization/wallet             Read the payout addresses on file
PUT    /api/monetization/wallet             Save a Solana and/or EVM payout address
GET    /api/monetization/withdrawals        Withdrawal history plus the live balance
POST   /api/monetization/withdrawals        Reserve a withdrawal of the available balance
```

The seller side of the agent economy: you price a skill, buyers pay for it through the [x402 endpoints](#x402-paid-endpoints--sign-in-with-x-siwx), the platform books a revenue event with its fee split, and you withdraw the net to an address you registered in advance.

All amounts on the wire are USDC. Every response carries both a human `*_usdc` float and an `*_atomic` integer (6 decimals, so `1 USDC = 1000000`); use the atomic value for anything that has to add up.

**Auth.** Everything except the public price listing needs a session cookie or an API key bearer token. Writes made with a cookie also need a CSRF token (`GET /api/csrf-token`, then send it as `x-csrf-token`); bearer-token callers are exempt, because the token itself proves intent.

### GET /api/monetization/prices

Public and unauthenticated: this is how a buyer discovers what an agent charges. `agent_id` is required and must be a UUID.

```bash
curl "https://three.ws/api/monetization/prices?agent_id=$AGENT_ID"
```

**200 OK**

```json
{
	"prices": [
		{
			"id": "9c1f…",
			"skill_name": "summarize",
			"price_usdc": 0.05,
			"amount_atomic": 50000,
			"currency_mint": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
			"chain": "solana",
			"is_active": true,
			"gate_type": "price",
			"nft_collection_mint": null,
			"created_at": "2026-08-01T10:00:00.000Z",
			"updated_at": "2026-08-01T10:00:00.000Z"
		}
	]
}
```

Only active entries are listed. An unknown `agent_id` is a `404 not_found`, not an empty list.

### PUT /api/monetization/prices

Owner only. Creates the entry (`201`) or updates it in place (`200`), keyed on `(agent_id, skill_name)`.

| Field                 | Type    | Default         | Notes                                                                        |
| --------------------- | ------- | --------------- | ---------------------------------------------------------------------------- |
| `agent_id`            | string  | required        | UUID of an agent you own.                                                     |
| `skill_name`          | string  | required        | Up to 64 chars, alphanumeric plus `-` and `_`.                                |
| `price_usdc`          | number  | required        | Required for a price gate. 0.000001 to 1000000. Rounded to atomic units.      |
| `currency_mint`       | string  | Solana USDC     | Mint the price is denominated in.                                             |
| `chain`               | string  | `"solana"`      | `solana`, `base`, or `evm`.                                                   |
| `gate_type`           | string  | `"price"`       | `price` sells the skill; `nft` restricts it to holders of a collection.       |
| `nft_collection_mint` | string  | `null`          | Required when `gate_type` is `nft`. Base58 Solana address.                    |

```bash
curl -X PUT https://three.ws/api/monetization/prices \
  -H "Authorization: Bearer $THREE_WS_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"agent_id":"'$AGENT_ID'","skill_name":"summarize","price_usdc":0.05}'
```

An NFT gate stores a zero amount: access is the holding, not a payment. A `price_usdc` below `0.000001` rounds to zero atomic units and is refused, and one above `1000000` is refused rather than overflowing the ledger column.

### DELETE /api/monetization/prices

Owner only. Body: `{ agent_id, skill_name, hard? }`. The default is a soft delete (the row is deactivated and disappears from the public listing, and re-pricing the skill later revives it). `hard: true` removes the row outright. Either way, a skill with no price row is a `404 not_found`.

### GET /api/monetization/wallet

Returns every payout row on file plus a `resolved` summary of the address a payout would actually land on per chain. The resolution matches what a withdrawal does: an agent-specific row wins, and a user-level row (saved with no agent) is the fallback.

```json
{
	"wallets": [{ "id": "…", "agent_id": "…", "address": "FeMb…", "chain": "solana", "is_default": true, "preferred_network": "solana", "created_at": "…" }],
	"resolved": { "evm_address": null, "solana_address": "FeMb…", "preferred_network": "solana" }
}
```

### PUT /api/monetization/wallet

Body: `{ agent_id, solana_address?, evm_address?, preferred_network? }`. At least one address is required. Addresses are validated (base58 for Solana, `0x` + 40 hex for EVM) and upserted per `(user, agent, chain)`, so re-saving replaces rather than duplicates. `preferred_network` (`solana` by default) decides which rail a withdrawal draws on when you do not name one.

### GET /api/monetization/withdrawals

History plus the live balance. Optional `agent_id`, `status` (`pending`, `processing`, `completed`, `failed`), `limit` (1 to 100, default 20) and `offset`. An unrecognised `status` is a `400` rather than a silently empty page.

```json
{
	"withdrawals": [
		{
			"id": "…", "agent_id": "…", "amount_usdc": 4, "amount_atomic": 4000000,
			"currency_mint": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
			"chain": "solana", "destination_address": "FeMb…", "status": "pending",
			"tx_hash": null, "error": null,
			"requested_at": "2026-08-01T10:00:00.000Z", "processed_at": null
		}
	],
	"balance": { "earned_usdc": 5.85, "withdrawn_usdc": 0, "pending_usdc": 4, "available_usdc": 1.85 }
}
```

`available = earned - pending - withdrawn`, so a reservation that has not settled yet is already deducted.

### POST /api/monetization/withdrawals

Reserves a withdrawal against the available balance. The destination is never accepted from the client: it is resolved from the payout wallets you saved, so a caller can only ever withdraw to an address they registered.

| Field         | Type   | Default    | Notes                                                              |
| ------------- | ------ | ---------- | ------------------------------------------------------------------ |
| `agent_id`    | string | required   | UUID of an agent you own.                                          |
| `amount_usdc` | number | whole balance | Minimum 1 USDC. Omit or send `null` to drain what is available. |
| `network`     | string | preference | `solana` (the default rail), `base`, or `evm`.                     |

```bash
curl -X POST https://three.ws/api/monetization/withdrawals \
  -H "Authorization: Bearer $THREE_WS_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"agent_id":"'$AGENT_ID'","amount_usdc":4}'
```

**201 Created** returns the reserved row with `status: "pending"` and the updated balance. `/api/cron/process-withdrawals` picks it up, sends the transfer, and moves it to `processing` then `completed` (or `failed`, with `error` set).

| Status | Error                  | Meaning                                                                     |
| ------ | ---------------------- | --------------------------------------------------------------------------- |
| 422    | `no_payout_wallet`     | No payout address saved for the chain being drawn on.                        |
| 422    | `below_minimum`        | Under the 1 USDC floor.                                                      |
| 422    | `insufficient_balance` | More than `available`, or a concurrent request reserved it first.            |
| 429    | `rate_limited`         | Withdrawal requests are capped at 5 per user per day, refusals included.     |

Naming a `network` you have no wallet on is refused rather than quietly paid out on another chain. Without one, the saved `preferred_network` decides, falling back to Solana.

The reservation is serialized behind a per-(user, currency) advisory lock and re-derives the balance inside the transaction, so concurrent requests cannot both pass the balance check and over-withdraw.

---

## Coin Market Data API

Public, unauthenticated, CORS-open proxies over CoinGecko (plus a news
aggregator) that power the [/coins](https://three.ws/coins) markets index and
the `/coin/:id` detail pages. Responses are CDN-cached (30–300 s), so polling
faster than the cache window returns the same payload. See
[docs/coin-pages.md](coin-pages.md) for the product surface.

### Coin detail

```
GET /api/coin/detail?id=<coingecko-id>
GET /api/coin/detail?contract=<solana-mint>
```

**Query parameters**

| Parameter  | Type   | Description                                                             |
| ---------- | ------ | ----------------------------------------------------------------------- |
| `id`       | string | CoinGecko coin id (lowercase slug). Required unless `contract` is given |
| `contract` | string | Base58 Solana mint address — resolves via the contract lookup           |

**Response**

```json
{
	"coin": {
		"id": "…",
		"symbol": "…",
		"name": "…",
		"image": "https://…",
		"rank": 1,
		"categories": ["…"],
		"description": "plain text, HTML stripped server-side",
		"links": {
			"homepage": "…",
			"twitter": "…",
			"reddit": "…",
			"telegram": "…",
			"github": "…",
			"explorers": ["…"]
		},
		"platforms": { "<chain>": "<contract address>" },
		"market": {
			"price": 0,
			"market_cap": 0,
			"fdv": 0,
			"volume_24h": 0,
			"high_24h": 0,
			"low_24h": 0,
			"change_24h_abs": 0,
			"change_pct": { "h24": 0, "d7": 0, "d30": 0, "y1": 0 },
			"circulating": 0,
			"total": 0,
			"max": 0,
			"ath": 0,
			"ath_date": "…",
			"ath_change_pct": 0,
			"atl": 0,
			"atl_date": "…"
		},
		"last_updated": "…"
	}
}
```

Errors: `404 not_found` (unknown id/contract), `502 upstream_error`.

---

### Price series

```
GET /api/coin/ohlc?id=<coingecko-id>&days=<1|7|30|90|365>
```

Returns `{ "data": [[timestamp_ms, price], …], "days": 30 }` — close prices at
upstream-chosen granularity (5-minutely for 1 day, hourly to 90 days, daily
beyond).

---

### On-chain pool resolution

```
GET /api/coin/pool?address=<token-address>&network=<gecko-network>
```

Resolves a token's most-liquid on-chain pool, so the coin page can mount the
GeckoTerminal chart embed (which is keyed by pool address, not token). `network`
is a GeckoTerminal network id (`solana`, `eth`, `base`, `bsc`, `polygon_pos`,
`arbitrum`, `optimism`, `avax`); `address` is the token mint (Solana) or
contract (EVM), validated per-network at the boundary. Returns
`{ "network", "address", "pool" }`. A token with no indexed pool returns `404`
(`no_pool`); upstream throttles surface as `429`, outages as `502` — the client
falls back to an "open on GeckoTerminal" link rather than a fabricated chart.
Cached 60s in-process + 5min at the CDN.

---

### Markets table / coin search

```
GET /api/coin/markets?page=1&per_page=100     # ranked rows, 7d sparklines
GET /api/coin/markets?q=<text>                # type-ahead search, top 10
```

Table rows: `{ id, symbol, name, image, rank, price, change_24h, change_7d,
market_cap, volume_24h, sparkline: [number, …] }` (sparklines downsampled to
≤32 points). Search results: `{ id, name, symbol, thumb, rank }`.

---

### Global market stats

```
GET /api/coin/global
```

**Response**

```json
{
	"market": {
		"market_cap_usd": 0,
		"volume_24h_usd": 0,
		"market_cap_change_pct_24h": 0,
		"active_coins": 0,
		"dominance": [{ "symbol": "…", "pct": 0 }]
	},
	"fear_greed": { "value": 0, "label": "…" }
}
```

`dominance` holds the top-2 assets by market-cap share, largest first. Either
half may be `null` if its upstream is briefly unavailable.

---

### Fear & Greed index

```
GET /api/coin/fear-greed?limit=<1..365>
```

Powers the `/fear-greed` page. `limit` (default 90) sets how many days of
history to return.

**Response**

```json
{
	"current": { "value": 0, "label": "…", "ts": 0 },
	"previous_week": { "value": 0, "label": "…", "ts": 0 },
	"history": [{ "ts": 0, "value": 0, "label": "…" }]
}
```

`history` is chronological (oldest → newest); `value` is 0–100 and `label` is
one of Extreme Fear / Fear / Neutral / Greed / Extreme Greed. Source:
alternative.me. Cached 5 min.

---

### Ethereum gas

```
GET /api/coin/gas
```

Powers the `/gas` page. Reads `eth_feeHistory` over the last ~20 blocks from a
public Ethereum RPC (failover across four providers) and derives three fee tiers
plus USD cost estimates from the live ETH price.

**Response**

```json
{
	"tiers": [
		{
			"key": "slow|standard|fast",
			"base_fee_gwei": 0,
			"priority_fee_gwei": 0,
			"gas_price_gwei": 0,
			"gas_price_wei": 0,
			"actions": [{ "key": "transfer", "label": "ETH transfer", "gas": 21000, "usd": 0 }]
		}
	],
	"base_fee_gwei": 0,
	"eth_price_usd": 0,
	"actions": [{ "key": "transfer", "label": "ETH transfer", "gas": 21000 }],
	"updated_at": 0
}
```

`usd` is `null` if the ETH price is briefly unavailable (gwei figures stay
live). Cached 15 s — no API key required.

---

### Liquidations

```
GET /api/coin/liquidations
```

Powers the "liquidations pulse" strip on `/coins`. Proxies the standalone
[`services/liquidation-collector`](../services/liquidation-collector) service
— a long-running process that subscribes to the **public** futures
liquidation WebSocket streams of Binance, Bybit, and OKX and keeps a rolling
4-hour in-memory window. This endpoint has no fallback data: when
`LIQUIDATION_COLLECTOR_URL` is unset or the collector is unreachable, it
returns `503 { "error": "collector_offline" }` rather than fabricated numbers.

**Response** (200)

```json
{
	"liquidations": [
		{
			"exchange": "Binance",
			"price": 0,
			"qty": 0,
			"severity": "SMALL|MEDIUM|LARGE|MEGA",
			"side": "LONG|SHORT",
			"symbol": "BTC",
			"time": 0,
			"value": 0
		}
	],
	"summary": {
		"dominantSide": "LONG PAIN|SHORT SQUEEZE|BALANCED",
		"largeCount": 0,
		"longCount": 0,
		"longValue": 0,
		"megaCount": 0,
		"shortCount": 0,
		"shortValue": 0,
		"totalCount": 0,
		"totalValue": 0
	},
	"symbolStats": [{ "count": 0, "longValue": 0, "shortValue": 0, "symbol": "BTC" }],
	"timestamp": "2026-07-08T12:00:00.000Z"
}
```

`liquidations` is the 50 most recent events (newest first) across 18 tracked
majors. `side` is the side that got liquidated — a forced-sell of a long is
`LONG`, a forced-buy-back of a short is `SHORT`. `summary.dominantSide` is
`LONG PAIN` when long liquidations exceed short by 1.5x, `SHORT SQUEEZE` for
the inverse, `BALANCED` otherwise. Cached 15 s (`s-maxage=15,
stale-while-revalidate=60`). No API key required.

---

### Market tools (categories, exchanges, derivatives, rates, DeFi)

Read-only, key-free proxies powering the `/categories`, `/exchanges`,
`/derivatives`, `/converter`, `/defi`, `/chains`, and `/stablecoins` pages.

| Endpoint                    | Upstream                                 | Returns                                                                                                                                                                           |
| --------------------------- | ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/coin/categories`  | CoinGecko `/coins/categories`            | `{ categories: [{ id, name, market_cap, market_cap_change_24h, volume_24h, top_3_coins }] }`                                                                                      |
| `GET /api/coin/exchanges`   | CoinGecko `/exchanges` + `/simple/price` | `{ exchanges: [{ id, name, image, trust_score, trust_score_rank, volume_24h_btc, volume_24h_usd, year_established, country, url }], btc_usd, updated_at }`                        |
| `GET /api/coin/derivatives` | CoinGecko `/derivatives`                 | `{ tickers: [{ market, symbol, index_id, price, change_24h, funding_rate, open_interest, volume_24h }], updated_at }` (perpetuals only, top 100 by volume)                        |
| `GET /api/coin/rates`       | CoinGecko `/exchange_rates`              | `{ fiats: [{ code, name, unit, per_btc }], updated_at }` (USD first; `per_btc` = units per 1 BTC)                                                                                 |
| `GET /api/defi/protocols`   | DeFiLlama `/protocols`                   | `{ total_tvl, protocol_count, protocols: [{ name, logo, symbol, category, chains, chain_count, tvl, change_1d, change_7d, mcap }], updated_at }` (CEX category excluded; top 100) |
| `GET /api/defi/chains`      | DeFiLlama `/v2/chains`                   | `{ total_tvl, chain_count, chains: [{ name, tvl, token_symbol, share_pct }], updated_at }` (top 100)                                                                              |
| `GET /api/defi/stablecoins` | DeFiLlama `stablecoins.llama.fi`         | `{ total_mcap, count, stablecoins: [{ name, symbol, price, peg_type, peg_mechanism, circulating_usd, chains, chain_count }], updated_at }` (top 100)                              |

All are GET-only, CORS-open, rate-limited per IP, and return `502 upstream_error`
when their source is briefly unavailable. Cache windows: 300 s (categories,
rates, DeFi), 120 s (exchanges), 60 s (derivatives). No API key required.

---

### DeFi yield pools

```
GET /api/intel/yields?chain=<name>&project=<slug>&stablecoin=<true|false>&limit=<1..100>
```

Real-time yield pools from DeFiLlama's `yields.llama.fi/pools`, filtered
server-side and sorted by TVL descending. Powers the trading copilot's
yield-discovery lane. All query params are optional; `limit` defaults to 25.

**Response**

```json
{
	"pools": [
		{
			"pool": "3637ce7b-529b-49c1-964c-710a50b2939c",
			"project": "sky-lending",
			"chain": "Arbitrum",
			"symbol": "SUSDS",
			"tvlUsd": 360345703,
			"apy": 3.6,
			"apyBase": 3.6,
			"apyReward": 0,
			"stablecoin": true
		}
	]
}
```

GET-only, CORS-open, rate-limited per IP, `502 upstream_error` if DeFiLlama is
briefly unavailable. Cached 15 min server-side + `s-maxage=60,
stale-while-revalidate=300` at the CDN. No API key required.

The underlying library (`api/_lib/market-data.js`) also exposes
`getProtocols()`, `getProtocol(slug)`, `getChainTvls()`, and `getDexVolumes()`
against DeFiLlama's `/protocols`, `/protocol/:slug`, `/v2/chains`, and
`/overview/dexs` — not yet wired to a public endpoint; they back future
protocol/chain/DEX-volume surfaces. (three.ws's Fear & Greed index is served by
`GET /api/coin/fear-greed` above, not by this module.)

---

### Sentiment heatmap field

```
GET /api/intel/heatmap?limit=<1..48>
```

The live token field behind the 3D sentiment heatmap on agent screens. `$THREE`
is always pinned first and flagged `featured`; the rest of the field is the
pump.fun trending set (`frontend-api-v3.pump.fun/coins`) priced from
Dexscreener's batch token endpoint. Tiles carry market data only: this endpoint
never names or recommends any token beyond the anchor. `limit` defaults to 28.

**Response**

```json
{
	"ok": true,
	"anchor": "FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump",
	"fetchedAt": "2026-08-13T00:58:12.004Z",
	"tokens": [
		{
			"id": "FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump",
			"symbol": "three",
			"name": "three.ws",
			"image": "https://cdn.dexscreener.com/cms/images/...",
			"priceUsd": 0.001625,
			"change24h": -4.03,
			"volume24h": 79088.64,
			"marketCap": 1625310,
			"featured": true,
			"flow": { "buys24h": 22619, "sells24h": 7725, "buyPct": 75, "score": 0.491 }
		}
	]
}
```

`flow` is an anchor-only enrichment read off the same Dexscreener pair as the
tile: the 24h split between buy and sell swaps, with `score` =
`(buys - sells) / (buys + sells)` in `[-1, 1]`. It is omitted when the anchor
has no trades in the window. Non-anchor tiles never carry it.

GET-only, CORS-open, rate-limited per IP. The field is cached 20 s in-process;
when the upstreams blip, the last good field is replayed with `"stale": true`
for up to 5 minutes, and only a cold outage with no usable price or volume
anywhere in the field returns `502 upstream_error`.

Client-side helpers for this feed (normalisation, momentum colouring, spike
diffing, and a polling loop) live in `src/sentiment-heatmap-data.js`.

---

### Related news

```
GET /api/coin/news?q=<coin name>&limit=8
```

Returns `{ "articles": [{ title, link, description, image, source,
published_at }], "source": "three.ws" }`. Served by the native three.ws
aggregator (`api/_lib/news.js`: 197 publisher feeds, per-source 5-minute cache
with serve-stale-on-error).

---

## Crypto News API

The engine behind [/markets/news](https://three.ws/markets/news) and
[/markets/archive](https://three.ws/markets/archive). Free, key-less, CORS `*`.

### Live feed

```
GET /api/news/feed?category=defi&q=etf&source=coindesk&lang=en&limit=30&offset=0&meta=1
```

Aggregates the native publisher RSS/Atom registry
(`api/_lib/news-sources.js`). All params optional:

| Param | Meaning |
| --- | --- |
| `category` | One of the canonical categories. Fetch the live list with `meta=1`; unknown values return `400 bad_category` with the valid set. |
| `source` | A single source key. Overrides `category` and `lang`. |
| `lang` | `en` (default), any registry language, or `all`. The registry carries international feeds; they are opt-in so the default feed does not interleave languages. Unknown values return `400 bad_language`. |
| `q` | Full-text over title, description, and tickers. |
| `featured` | `1` narrows sources to the majors (tier1/tier2 upstream or credibility ≥ 0.85 — CoinDesk, The Block, Decrypt, Blockworks, The Defiant, and the mainstream desks). Backs the Featured tab on `/markets/news`. |
| `limit` | ≤ 50 (default 30). |
| `offset` | Pagination offset. |

Returns `{ articles: [{ id, title, link, description, image, author, source,
source_key, category, pub_date, tickers[], sentiment: { score, label,
confidence } }], total, limit, offset, lang, sources_ok, sources_total,
fetched_at }`. With `meta=1` it also returns `categories[]`, `languages[]`,
and the `sources[]` registry (each with `key`, `name`, `category`, `tier`
where the upstream registry carries one, and `language` where the feed is not
English).

### Preview-image resolver

```
GET /api/news/image?url=<article link>
```

Preview image for an article whose publisher feed ships no image (~20% of the
live feed publishes text-only RSS). The `url` must be an article currently
served by the aggregator — anything else answers `404 unknown_article` without
touching the network. The endpoint fetches the publisher page server-side
(SSRF-guarded, 6 s timeout, 768 KB cap), extracts its `og:image` /
`twitter:image`, and answers `302` to the same-origin `/api/img` proxy — so the
final bytes are immune to hotlink-referrer blocking. If the page carries no
preview image it answers `404 no_preview_image`; both outcomes are cached
in-process and at the CDN, so an article costs at most one upstream fetch. The
news cards on [/markets/news](https://three.ws/markets/news) call this in the
background and keep their designed source-initials tile when it 404s.

Every feed in the registry was fetched and parsed before being listed — see
`scripts/news-sources-probe.mjs`, which re-validates the registry and exits
non-zero if any source has gone dead. Each source is cached server-side for 5
minutes and served stale (up to 24 h) if its publisher goes down; a feed that
404s backs off exponentially, while one that merely rate-limits us retries
within 30 minutes. CDN cache 120 s.

### Historical archive — 662,047 articles since 2017

```
GET /api/news/archive?q=bitcoin+etf&ticker=BTC&source=odaily&sentiment=positive&lang=zh&start_date=2024-01-01&end_date=2024-01-31&limit=50&offset=0
GET /api/news/archive?stats=true      # corpus statistics + month range
GET /api/news/archive?months=true     # queryable months
GET /api/news/archive?trending=true   # top tickers over the newest archived weeks
```

Queries the platform-hosted corpus (`gs://three-ws-news-archive`: monthly
JSONL, gzip at rest — the CryptoPanic english corpus + the Odaily chinese
corpus + the cryptocurrency.cv live archiver, September 2017 → today, kept
current hourly by `api/cron/news-archive-append.js`). Records
are enriched: `tickers[]`, `tags[]`, `sentiment`, `lang` (`en`/`zh`),
`is_breaking`, and `market_context` (BTC/ETH price + Fear & Greed at
publication) where captured. Query mode scans months **newest → oldest** with
early stop (≤ 12 months per request) and reports coverage honestly:
`{ articles[], total_scanned_matches, has_more, scanned: { months[], from,
to, complete, months_remaining }, hint? }` — pass `start_date`/`end_date` to
reach older years. `sentiment` ∈ `positive|negative|neutral`; `limit` ≤ 100.
CDN cache 300 s (queries) / 3600 s (stats, months, trending).

**Access:** `stats`, `months`, and `trending` are always free. Query mode
(search) is freemium: **60 free searches per day per IP** — each response
carries `tier: "free"` and `free_remaining_today` — then the endpoint answers
with an x402 `402` challenge at **$0.001 USDC per search** (USDC on Solana or
Base; operators override via `X402_PRICE_NEWS_ARCHIVE`). Repeat the same
`GET` with an `X-PAYMENT` header to run a paid search (`tier: "paid"`);
requests arriving with `X-PAYMENT` skip the free quota entirely. `?stats=true`
reports the live terms under `search_access`.

**Premium pass (monthly):** skip per-call payments entirely with the
[Premium pass](/docs/premium) — from $19.99/30 days (Developer 120 req/min;
Pro $99 at 600 req/min with commercial use; Enterprise $499 at 2,000 req/min)
on Solana in $THREE (20% off), SOL, or USDC. It mints an `x402_live_…` API
key (send as `X-API-Key`) and a wallet-signature (SIWX) grant for browsers.
Buy at [/dashboard/data-api](/dashboard/data-api) or over the raw API
(`/api/premium/plans` → `quote` → `subscribe`).

### Daily digest

```
GET /api/news/digest?hours=24&limit=8&refresh=1
```

Clusters the last `hours` (1–72, default 24) of live coverage into at most
`limit` (3–12, default 8) narratives. Returns `{ narratives: [{ title,
summary, stance ("bullish"|"bearish"|"neutral"), tickers[], coverage,
articles: [{ id, title, link, source, pub_date, image }] }], engine
("llm"|"heuristic"), provider, window_hours, articles_considered,
sources_live, mood, top_tickers[], generated_at, cached }`.

`engine` names the clustering path: `llm` (platform chain grouped them
semantically) or `heuristic` (Jaccard clustering over headline tokens +
tickers). **Every narrative cites the real articles it clustered** — a model
citation that doesn't resolve to a fetched article is discarded, and a digest
in which nothing resolves falls back to the heuristic engine. `503
insufficient_coverage` when fewer than 3 articles were published in the
window. Cached 30 min per window; `refresh=1` bypasses.

### RSS syndication

```
GET /api/news/rss?category=defi&limit=50
```

RSS 2.0 rendering of the live feed (same params as `/api/news/feed` minus
search). Linked as `rel="alternate"` from /markets/news; item `<source>`
elements point at the three.ws reader. CDN cache 300 s.

### Article reader

```
GET /api/news/article?url=<article url>&title=&source=
```

Server-side extraction with SSRF + DNS-rebinding protection. Returns
`{ id, url, title, source, image, author, published_at, description,
extraction, paragraphs[], excerpt_truncated, full_text_url, content_chars,
tickers[], coins[], summary, key_points[], entities[], topics[], sentiment
("bullish"|"bearish"|"neutral"), analysis_provider, market_context, related[],
fetched_at }`.

`paragraphs[]` is a bounded lead excerpt, not the article body: capped to 2
paragraphs / 400 characters by `excerptParagraphs()` in
[api/_lib/news-rights.js](../api/_lib/news-rights.js), the single choke point
every response passes through (see [docs/news-rights.md](./news-rights.md)).
`excerpt_truncated` is `true` whenever the source ran longer than the quoted
excerpt; `full_text_url` is where to send the reader for the rest. This is a
hard limit for every publisher, not a per-source policy — a story removed at a
rightsholder's demand (`TAKEDOWN_IDS`) or from a withdrawn publisher
(`RESTRICTED_SOURCE_KEYS`/`RESTRICTED_HOSTS`) answers 410 Gone instead.

`extraction` tells you where the excerpt's source text came from, in ladder
order (`api/_lib/article-extract.js`): `"page"` (the publisher's own HTML),
`"reader"` (recovered through a keyless reader service when the publisher
Cloudflare-blocks direct fetches — this is what makes bot-blocked outlets like
The Defiant and CoinDesk resolve to more than a one-line teaser), `"feed"`
(the publisher's own `content:encoded` feed body), or `"preview"` (metadata
only; `blocked_reason` set). It does not change how much of the body is
returned — the excerpt cap applies identically regardless of ladder stage.

`coins[]` is a live market snapshot for every detected ticker that maps to a
known coin — `{ symbol, id, name, image, price, change_24h, change_7d,
market_cap, volume_24h, rank, sparkline[], href }` — so the reader can render a
price card + 7d chart deep-linked to `/coin/:id`. `entities[]` / `topics[]` are
the orgs/people/projects and themes the story is about (LLM layer).
`analysis_provider` names the LLM that summarized it (via the platform chain),
else `heuristic` (extractive summary + lexicon sentiment — always available).

Cached 30 min per URL in-process; a fully extracted story is also persisted to
the durable knowledge base below (which then serves as a cross-instance cache,
so a blockable publisher is only fetched once).

### News knowledge base

```
GET /api/news/knowledge?id=<16hex>              # full stored record for one story
GET /api/news/knowledge?ticker=SOL&full=1       # recent stories mentioning a coin
GET /api/news/knowledge?q=etf&limit=20          # free-text over titles + summaries
GET /api/news/knowledge                          # latest recorded stories + corpus stats
```

The grounding surface the three.ws 3D agents read crypto from. Every story the
reader extracts and analyzes is recorded here (`news_knowledge` table,
`api/_lib/news-knowledge-store.js`): AI summary + key points, sentiment,
detected tickers with their market snapshot, and named entities — permanent
and queryable, distinct from the append-only GCS archive and from per-agent
memory. The full extracted body is held internally so the LLM analysis layer
and the agents' server-side RAG corpus can reason over it, but this endpoint
never returns it: it is subject to the same excerpt cap as the article reader
(`api/_lib/news-rights.js`), so `&full=1` returns the bounded lead excerpt and
coin snapshot, not the full text. Lightweight rows by default (id, title,
source, sentiment, tickers, entities, summary). `stats` reports `{ total,
full_text, latest, enabled }` (`full_text` counts stored records with a full
internal body, not what the API exposes). Free, key-less, CORS `*`; CDN cache
60–120 s. Degrades to an empty corpus (`enabled:false`) when the platform
database is not configured.

---

## Unified API — `/api/v1/x` aggregator

One catch-all route (`api/v1/x/[...slug].js`) bundles every third-party API
three.ws re-offers as one API, registered in `api/v1/_providers.js`. Adding a
new upstream — or a new endpoint on an existing one — is a descriptor there;
no new route file. Providers today: **CoinGecko** (`coingecko`, price/markets/
coin/trending/token-price/global/ohlc), **DefiLlama** (`defillama`, protocols/
tvl/chains/protocol/chain-tvl), **DefiLlama Prices** (`llama-prices`, current
price for any `chain:address` pair), **DefiLlama Stablecoins**
(`llama-stablecoins`, every tracked stablecoin ranked by circulating supply),
**Jupiter** (`jupiter`, Solana prices/quotes/search), **DexScreener**
(`dexscreener`, DEX pairs/search/profiles/boosts for any token), **Solana
reads** (`solana`, balance/token-holdings/token-supply/largest-holders/
transaction/account/priority-fees via public RPC), **OpenAI-compatible LLM**
(`openai`).

**Public storefront:** [three.ws/crypto-api](https://three.ws/crypto-api) — the live
provider/endpoint table below, rendered at page load straight from `GET /api/v1/x` (never
hand-enumerated, so it can't drift from what's actually deployed), plus the quickstart curl
below and links to this page, the OpenAPI spec, and the x402 docs. **Machine-readable spec:**
[three.ws/openapi.json](https://three.ws/openapi.json) — every `/api/v1/x/*` path generated
from the same registry (`api/v1/_providers.js` `providerCatalog()`), tagged `Crypto API
(aggregator)`. Every paid `/api/x402/*` operation is generated the same way, from the
service catalog (`api/_lib/service-catalog/services/`), so the document lists all of them
with their real price, inputs and 402 response rather than the subset someone remembered to
hand-write. Adding a provider directory in the repo: [`api/v1/README.md`](../api/v1/README.md).

```
GET  /api/v1/x                              # discovery: every provider + endpoint
GET  /api/v1/x/<provider>/<endpoint>?…       # most endpoints (GET)
POST /api/v1/x/<provider>/<endpoint>         # a few (e.g. openai/chat)
```

Each call resolves to one of four billing lanes, in this order:

| Lane     | How                                                                          | Notes                                                      |
| -------- | ---------------------------------------------------------------------------- | ---------------------------------------------------------- |
| **free** | send no credentials on an endpoint marked `free`                             | per-IP quota, zero setup — see below                       |
| **BYOK** | send your own upstream key via the provider's header (e.g. `x-provider-key`) | pure pass-through, no markup, no key custody               |
| **plan** | authenticate with a three.ws API key / OAuth token / session                 | uses the platform's upstream key, counts against your plan |
| **x402** | send no credentials, no free quota left                                      | pay per call in USDC — the standard HTTP 402 challenge     |

**Upstream failover (automatic, all lanes).** A provider backed by a pool of
interchangeable hosts declares them in its descriptor (`bases`), and the
aggregator walks that pool inside a single request when a host answers 429, a
5xx, or is unreachable (up to 3 hosts per call; caller-fault 4xx never
retries; up to 6 hosts per call). A host that just failed is skipped for a
short cooldown window while an alternate exists, so an upstream outage costs
one discovery, not one per request. The whole chain runs under a 25s deadline
(pooled attempts abort at 10s each) so the caller always gets the aggregator's
answer, never a load balancer timeout. The `solana` provider fronts the
platform's full priority-ordered RPC pool this way and shares the process-wide
RPC host-health registry in both directions: a host another subsystem found
quota-dead is skipped here immediately, and failures seen here park the host
for everyone. Single-host providers behave as plain pass-throughs with one
attempt.

### The free tier

This is what makes "free crypto API" true instead of marketing copy: an agent
can call a `free`-marked endpoint with **zero wallet setup** and get real data.
Each free-marked endpoint descriptor carries its own quota —
`free: { perMin, perDay }` — enforced per (provider, endpoint, IP). Both
windows must pass; whichever one blocks a request drives the response headers.

```bash
curl -s "https://three.ws/api/v1/x/coingecko/price?ids=solana"
```

```json
{
	"data": { "solana": { "usd": 141.23 } },
	"_meta": {
		"provider": "coingecko",
		"endpoint": "price",
		"billing": "free",
		"free_remaining": { "per_min": 29, "per_day": 1999 }
	}
}
```

**Response headers on every free-lane call:**

| Header                                                        | Meaning                                                                                                                |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `X-Free-Tier: 1`                                              | this response was served on the free lane                                                                              |
| `RateLimit-Limit` / `RateLimit-Remaining` / `RateLimit-Reset` | the quota window that governed this request (burst `perMin` if it was the tighter one, else the daily `perDay` budget) |
| `X-Free-Tier-Reset`                                           | only sent when the quota is exhausted — ISO timestamp for when the free lane reopens                                   |

Once the quota is exhausted, the exact same URL keeps working — it just falls
through to the standard x402 402 challenge (pay per call), or succeeds
immediately if you send a three.ws API key or a BYOK header instead. No dead
end, no silent downgrade.

**Calling an endpoint with no arguments at all** returns the 402 challenge
rather than a `400 missing_param`, on every endpoint, free-marked or not. This
is the discovery path: x402 directory crawlers and uptime monitors sweep the
whole catalog parameterless to confirm each endpoint is alive and priced, and a
400 would report a healthy endpoint as broken. The challenge names the resource
and its price like any other 402, and an `X-Param-Error` header carries the
specific argument you would need to make the call for real:

```bash
curl -si "https://three.ws/api/v1/x/coingecko/price" | head -2
# HTTP/2 402
# x-param-error: query param "ids" is required
```

Send **any** argument and you are treated as a real caller: `?ids=` (present but
empty) answers `400 missing_param` with the message above, because at that point
the specific error is the useful reply.

**Current free quotas** (also machine-readable via `GET /api/v1/x` below —
every endpoint's `free` field is `{ perMin, perDay }` or `false`):

| Provider/endpoint                                                                                                      | perMin                                                     | perDay |
| ---------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- | ------ |
| `coingecko/price`, `coingecko/markets`                                                                                 | 30                                                         | 2000   |
| `coingecko/coin`, `/trending`, `/token-price`, `/global`, `/ohlc`                                                      | 20                                                         | 1500   |
| `defillama/protocols`, `defillama/tvl`, `/chains`, `/protocol`, `/chain-tvl`                                           | 30                                                         | 2000   |
| `llama-prices/current`                                                                                                 | 30                                                         | 2000   |
| `llama-stablecoins/list`                                                                                               | 30                                                         | 2000   |
| `jupiter/price`, `jupiter/quote`, `jupiter/token-search`                                                               | 20                                                         | 2000   |
| `dexscreener/token`, `dexscreener/search`, `dexscreener/pair`                                                          | 30                                                         | 3000   |
| `dexscreener/profiles`, `dexscreener/boosts`                                                                           | 10                                                         | 500    |
| `solana/balance`, `/token-holdings`, `/token-supply`, `/largest-holders`, `/transaction`, `/account`, `/priority-fees` | 20                                                         | 2000   |
| `openai/chat`                                                                                                          | not free — real per-call LLM spend, BYOK or plan/x402 only |

**CoinGecko** (`coingecko`) — beyond spot price and ranked markets: a full
per-coin snapshot, trending coins/categories, token price by contract address,
the global market snapshot, and OHLC candles.

```bash
curl -s "https://three.ws/api/v1/x/coingecko/coin?id=solana"
curl -s "https://three.ws/api/v1/x/coingecko/trending"
curl -s "https://three.ws/api/v1/x/coingecko/token-price?addresses=FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump"
curl -s "https://three.ws/api/v1/x/coingecko/global"
curl -s "https://three.ws/api/v1/x/coingecko/ohlc?id=solana&days=7"
```

**DefiLlama** (`defillama`) — every chain by TVL, one protocol's full profile
(current TVL per chain + the last 30 days of its total series), and 90 days of
historical TVL for one chain.

```bash
curl -s "https://three.ws/api/v1/x/defillama/chains"
curl -s "https://three.ws/api/v1/x/defillama/protocol?slug=uniswap"
curl -s "https://three.ws/api/v1/x/defillama/chain-tvl?chain=Solana"
```

**DefiLlama Prices** (`llama-prices`) — DefiLlama's own coin-price oracle,
covering long-tail tokens CoinGecko and Jupiter don't index yet:

```bash
curl -s "https://three.ws/api/v1/x/llama-prices/current?coins=solana:FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump"
```

**DefiLlama Stablecoins** (`llama-stablecoins`) — every tracked stablecoin,
peg type, price, and circulating supply, ranked:

```bash
curl -s "https://three.ws/api/v1/x/llama-stablecoins/list"
```

**DexScreener** (`dexscreener`) — live DEX pair data for any token: price,
liquidity, volume, 24h change, txns. Works for any chain DexScreener indexes,
not just Solana.

```bash
curl -s "https://three.ws/api/v1/x/dexscreener/token?addresses=FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump"
```

**Solana reads** (`solana`) — public-RPC reads with no key required: SOL
balance, SPL token holdings, mint supply, largest-holder concentration, a
transaction by signature, raw account info, and current prioritization fees.

```bash
curl -s "https://three.ws/api/v1/x/solana/balance?address=FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump"
```

### Discovery

```
GET /api/v1/x
```

Returns every provider and endpoint, each endpoint's price (USDC atomics),
required OAuth scope, and its `free` quota (or `false`):

```json
{
	"data": {
		"base_url": "/api/v1/x",
		"billing": { "byok": "…", "plan": "…", "free": "…", "x402": "…" },
		"providers": [
			{
				"id": "coingecko",
				"name": "CoinGecko",
				"category": "crypto-market-data",
				"key": "optional",
				"byok": true,
				"endpoints": [
					{
						"id": "price",
						"method": "GET",
						"path": "/api/v1/x/coingecko/price",
						"scope": "agents:read",
						"price_usdc_atomics": "1000",
						"summary": "Spot price for one or more coins in any fiat/crypto.",
						"params": { "ids": "…" },
						"free": { "perMin": 30, "perDay": 2000 }
					}
				]
			}
		]
	}
}
```

### BYOK / plan / x402 lanes

BYOK sends the provider's own key header (e.g. `x-provider-key`) and gets pure
pass-through with no markup. Plan callers send `Authorization: Bearer
<three.ws API key>` (or an OAuth token, or a browser session) and pay the
endpoint's price against their plan. Neither present, and the free quota (if
any) is exhausted → the standard x402 `HTTP 402` challenge (see
[x402 Paid Endpoints](#x402-paid-endpoints--sign-in-with-x-siwx) above for the
wire format); pay in USDC and the identical upstream call runs.

---

## Web Search API

```
GET /api/web-search?q=<query>&sources=<n>
```

Open-web search with cited sources. This is distinct from [`/api/search`](#cross-entity-search),
which federates three.ws's own entities (avatars, agents, models, worlds, coins)
and never leaves the platform. This endpoint answers questions about the live
web and returns the sources the answer is grounded in.

Backed by Gemini on Vertex AI with Google Search grounding, authenticated with
the platform's GCP service account. No API key, no signup, and no per-seat
quota: it rides the same credits-funded surface as the chat reliability anchor.

No auth required. Rate limited to 20 requests per 10 minutes per IP (each call
is a billed inference request, so it does not share the generic public bucket).

**Parameters**

| Name | Type | Default | Description |
|---|---|---|---|
| `q` | string | — | Required. The search query. Truncated to 400 characters. |
| `sources` | integer | `8` | Maximum grounding sources to return, clamped to 1–20. |

**Response**

```json
{
  "enabled": true,
  "q": "What is the glTF file format used for?",
  "answer": "The glTF (GL Transmission Format) file format is an open-standard, royalty-free 3D file format developed by the Khronos Group. It is primarily used for the efficient transmission and loading of 3D scenes and models...",
  "sources": [
    {
      "title": "khronos.org",
      "url": "https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQF...",
      "domain": "khronos.org"
    }
  ],
  "queries": ["glTF file format uses", "what is glTF file format"]
}
```

`queries` are the searches Google actually ran for your question, so you can see
how it was interpreted rather than guessing from the results.

**Source URLs are attribution redirects.** Each `url` points at
`vertexaisearch.cloud.google.com/grounding-api-redirect/...` rather than the
publisher, which is how Google's grounding attribution works; the link resolves
to the real page. Use `domain` when you need the publishing host itself (for
display, filtering, or authority weighting) — parsing the hostname out of `url`
returns `vertexaisearch.cloud.google.com` for every result.

**Degraded and error states**

- `200 { "enabled": false, "q": "...", "sources": [] }` — the deployment has no
  GCP project configured (local dev without credentials). A designed "not
  available here" state, not an error.
- `400 missing_query` — `q` was absent or empty.
- `502 upstream_error`: the upstream grounded call failed (auth, quota, safety
  block, or timeout). Retryable. Body is the standard error shape,
  `{ "error": "upstream_error", "error_description": "search upstream failed, retry shortly" }`.

Results are edge-cached for 60 seconds (`stale-while-revalidate` 300).

---

## Animations Library API

```
GET /api/animations/library
```

Returns the three.ws motion library manifest — the complete catalog of retargeted animation clips (2,800+ and growing as generative text→motion clips are seeded), hosted on the R2 CDN. No auth required. CORS open. Edge-cached for 5 minutes.

Each entry's `url` is an absolute CDN URL to the baked clip JSON (`THREE.AnimationClip.toJSON()` format, canonical skeleton) — fetch it directly and load with `THREE.AnimationClip.parse()`, or pass the `name` to the embed viewer (`/embed/avatar?anim=<name>`) and pose studio (`/pose?anim=<name>`).

**Query parameters** (optional — omit for the full catalog)

| Param    | Description                                                                                                                                                   |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `limit`  | Page size, `1`–`1000`. When set, the response is a bounded page instead of the whole catalog — use this to keep a single response small as the library grows. |
| `offset` | Zero-based start index into the ordered catalog. Default `0`.                                                                                                 |

The manifest is a stable ordered array, so paging is offset-based. A paged response adds `offset` and `next_offset` (`null` on the last page); `total` is always the full catalog size. Page until `next_offset` is `null`:

```
GET /api/animations/library?limit=1000            # first 1000 → next_offset: 1000
GET /api/animations/library?limit=1000&offset=1000 # next 1000 → next_offset: 2000
```

Omitting `limit` returns the full array exactly as before (no `offset`/`next_offset` fields) — the legacy contract is unchanged.

**Response**

```json
{
	"clips": [
		{
			"name": "mx-hip-hop-dancing",
			"label": "Hip Hop Dancing",
			"icon": "💃",
			"loop": true,
			"duration": 4.4,
			"bytes": 1174283,
			"url": "https://three.ws/cdn/animations/library/clips/mx-hip-hop-dancing.json"
		}
	],
	"total": 2400,
	"generated_at": "2026-07-04T00:00:00.000Z"
}
```

Returns `{ "clips": [], "total": 0 }` until the library has been published, so clients can feature-detect by emptiness. The curated starter set remains separately available as static JSON at `/animations/manifest.json`.

---

## Asset Library API

```
GET /api/assets
```

One catalog for everything the viewer can put on an avatar or behind it: accessories (`public/accessories/presets.json`), the curated starter animation clips (`public/animations/manifest.json`), and the HDRI environments the viewer ships with (`src/environments.js`). No auth. CORS open to any origin, on the success path and on errors alike. `HEAD` is answered like `GET`. Edge-cached for 1 hour, because the manifests ship with the build and cannot change between deploys.

For the full 2,800-clip motion library use [Animations Library API](#animations-library-api) instead; this endpoint carries only the starter set that ships in the box.

**Query parameters** (all optional)

| Param   | Description                                                                                                        |
| ------- | ------------------------------------------------------------------------------------------------------------------ |
| `type`  | `accessory`, `animation`, or `environment`. Omit for all three.                                                     |
| `kind`  | Accessory subkind: `hat`, `glasses`, `earrings`, `outfit`. Validated against the manifest, so new subkinds work.     |
| `loop`  | `true` or `false`. Restricts the result to animations with that loop flag.                                          |
| `limit` | Integer `1` to `500`. Default `200`. A value above `500` clamps to `500`.                                            |

An unrecognized `type`, `kind`, or `loop`, or a non-integer `limit`, is a `400` with a machine-readable `error` code (`invalid_type`, `invalid_kind`, `invalid_loop`, `invalid_limit`) and a `Cache-Control: no-store`. A filter typo never returns a silently empty catalog.

**Response**

```json
{
	"ok": true,
	"total": 126,
	"items": [
		{
			"id": "hat-baseball",
			"type": "accessory",
			"kind": "hat",
			"name": "Baseball Cap",
			"thumbnail": "/accessories/thumbs/hat-baseball.png",
			"glb_url": "/accessories/hat-baseball.glb",
			"attach_bone": "Head",
			"morph_binding": null
		},
		{
			"id": "wave",
			"type": "animation",
			"name": "Wave",
			"clip_url": "/animations/clips/wave.json",
			"icon": "👋",
			"loop": false
		},
		{
			"id": "venice-sunset",
			"type": "environment",
			"name": "Venice Sunset",
			"path": "https://storage.googleapis.com/donmccurdy-static/venice_sunset_1k.exr",
			"format": ".exr"
		}
	]
}
```

`total` is the number of items matching the filters before `limit` is applied, so a client can tell a truncated page from a complete one. Every item always carries `id`, `type`, and `name`; the remaining fields depend on `type`. The viewer's "no environment" preset is published with the id `none`.

```bash
curl 'https://three.ws/api/assets?type=accessory&kind=hat'
curl 'https://three.ws/api/assets?type=animation&loop=true&limit=10'
```

---

## Agent Identity Showcase API

```
GET /api/agent-identities
```

The finished work of the [Agent Identity Studio](./agent-identities.md): the demo identities behind [three.ws/agent-identities](https://three.ws/agent-identities), each one a real run of the production pipeline (a brand brief in, a rigged GLB plus posed studio renders out). No auth, CORS open to any origin, edge-cached for 10 minutes. Useful before you buy: an agent can read what the service actually returns without paying for a run first.

The `service` block is read from the OKX catalog (`api/_lib/okx-catalog.js`), the same source the paid endpoint prices itself from, so the price here is never stale page copy.

**Response**

```json
{
	"service": {
		"id": "identity-studio",
		"name": "Agent Identity Studio",
		"priceUsd": "1.50",
		"currency": "USDC",
		"endpoint": "https://three.ws/api/okx/3d/identity-studio",
		"tool": "create_identity",
		"docs": "https://three.ws/docs/okx-marketplace",
		"catalog": "https://three.ws/api/okx/3d/catalog"
	},
	"count": 4,
	"ready": 4,
	"identities": [
		{
			"slug": "ledgerlynx",
			"agentName": "LedgerLynx",
			"kind": "finance data agent",
			"brief": "A meticulous on-chain accounting agent that reconciles wallets and flags anomalies in real time.",
			"styleHints": "deep navy and silver palette, brushed-metal accents",
			"status": "ready",
			"pfp": { "url": "https://…/pfp-1024.png", "previewUrl": "https://…/pfp-128.png", "pose": "contrapposto" },
			"fullBody": [
				{ "url": "https://…/fullbody-1-walk-step.png", "pose": "walk-step", "width": 1024, "height": 1280 }
			],
			"riggedGlbUrl": "https://…/6cddc43a.glb",
			"viewerUrl": "https://three.ws/viewer?src=…",
			"poseStudioUrl": "https://three.ws/pose?src=…",
			"backend": "trellis_selfhost",
			"rigged": true,
			"joints": 52,
			"durationSeconds": 501,
			"completedAt": "2026-07-09T23:45:26.807Z"
		}
	]
}
```

`status` is `ready` or `pending`. A `pending` entry carries `slug`, `agentName`, `kind`, and `brief` only: its pipeline run has not completed, so it has no deliverables to link. `rigged` is proof, not a claim: the demo runner downloads each finished GLB and asserts a real skin with skin weights before recording the joint count. `count` is every entry, `ready` is the subset with deliverables.

To buy a run of your own, call `create_identity` on the paid A2MCP endpoint in `service.endpoint`; the flow is documented in [OKX.AI Marketplace Services](./okx-marketplace.md#back-burner).

```bash
curl -s https://three.ws/api/agent-identities | jq '.service.priceUsd, .ready'
```

---

## Motion Signatures API

```
GET /api/animations/signatures
```

The measured motion signature of every baked clip in the starter library: energy, tempo, per-region motion shares, loop-seam cleanliness, root travel, and the derived flags (`overlay`, `anchored`, `loopClean`, `static`). Nothing is authored by hand; `scripts/build-motion-signatures.mjs` measures the keyframes and this endpoint serves the result with the plain-language derivations (`band`, `description`) added. No auth. CORS open. Edge-cached for 5 minutes.

Use it to pick clips by what they do rather than by name: "a calm, arms-led loop that survives as an upper-body overlay" is a query here, not an afternoon of previewing.

**Modes** (mutually exclusive; listing is the default)

| Query | Answer |
| ----- | ------ |
| `?clip=<name>` | One clip's full signature. |
| `?clip=<name>&slot=<slot>` | The signature plus a fit verdict: can this clip play in that runtime slot? `fit.level` is `ok` or `warn`, and `fit.message` says why in plain language (open loop seam, motion below the waist, held pose, root drift). |
| `?slot=<slot>` | The health of the slot's own default clip: the question "is this slot fine right now?". |
| `?similar=<name>&limit=<1..20>` | The nearest clips by measured motion distance, closest first. |

**Listing filters** (combine freely)

| Param | Values |
| ----- | ------ |
| `overlay` | `true` / `false`: survives the upper-body strip on /walk. |
| `loop` | `clean`: last frame meets the first, no visible snap. |
| `anchored` | `true` / `false`: ends where it started. |
| `lead` | `head`, `arms`, `torso`, `root`, `legs`: which region carries the motion. |
| `band` | `still`, `calm`, `gentle`, `lively`, `explosive`. |
| `sort` | `energy`, `tempo`, `duration`, `upperShare`, `travel`, `beat`, `balance` (+ `order=asc|desc`, default desc). |
| `limit`, `offset` | Paging, `limit` 1 to 200 (default 200). |

```bash
# Calm, clean-looping clips an agent can idle on
curl 'https://three.ws/api/animations/signatures?loop=clean&band=calm'

# Would av-waiting hold the fidget loop? (No: its last frame misses its first.)
curl 'https://three.ws/api/animations/signatures?clip=av-waiting&slot=fidget'

# Five clips that move like "wave"
curl 'https://three.ws/api/animations/signatures?similar=wave&limit=5'
```

**Errors:** `404 unknown_clip`, `400 unknown_slot` / `unknown_region` / `unknown_band` / `unknown_sort`, each naming the valid values. The same data powers the `animation_signature` and `find_similar_animations` MCP tools and the /gestures page, so all three always agree.

---

## Play Population API

```
GET /api/play/population
GET /api/play/population?coin=<mint-or-contract>
GET /api/play/population?by=coin
```

How many people are standing in the `/play` worlds right now. No auth, CORS open, cached 5 seconds at the edge.

`/play` presence lives in Colyseus rooms on the standalone multiplayer server, not in Postgres, so this handler proxies that server's own `/population` aggregate. That aggregate reads the matchmaker's driver-backed room listing, so the count spans every instance when the fleet is scaled horizontally. Only a count crosses the boundary: no session ids, no display names, no wallets, no positions.

`coin` narrows the count to one community's worlds (a Solana mint or an EVM contract address). Anything that is not a well-formed address is ignored rather than forwarded, and the response reports the filter that was actually applied.

`by=coin` adds `byCoin`, a mint to headcount map covering every live world, so a page listing many communities gets all of their counts from one request instead of one request per card (this is what the `/play` lobby paints on its cards). Keys are re-validated as addresses before they are republished, and worlds with nobody in them are left out. `byCoin` is **absent**, not empty, when the multiplayer server is older than this parameter: an absent map means "unknown" and an empty map means "measured, nobody anywhere", and a caller must not render the first as zeroes.

**Response**

```json
{
	"ok": true,
	"coin": "FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump",
	"players": 4,
	"rooms": 1
}
```

With `by=coin`:

```json
{
	"ok": true,
	"coin": null,
	"players": 7,
	"rooms": 3,
	"byCoin": { "FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump": 5 }
}
```

When the multiplayer server is unreachable the endpoint still answers `200`, with the count omitted:

```json
{ "ok": false, "reason": "unavailable", "coin": null }
```

Callers must render a live state without a number in that case rather than substituting one. The `/event` landing page does exactly this: it shows "The doors are open" instead of inventing a crowd.

```bash
curl -s 'https://three.ws/api/play/population?coin=FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump'
```

---

## Coin Wars API

```
GET  /api/wars?network=&coin=&limit=       the war board: ladder, recent battles, live wars, queue
GET  /api/wars?action=live&coin=           only the running battles (spectator poll)
POST /api/wars?action=queue                queue a community for a battle
POST /api/wars?action=leave                take a community out of the queue
POST /api/wars?action=report               game-server only, HMAC-signed battle result
```

Coin Wars is community-vs-community combat: two coin communities meet in one arena, the side that reaches the kill cap first wins, and an Elo ladder is recomputed from the battle ledger. This endpoint is what the war portal in every `/play` world reads and what the arena at [`/play/war`](https://three.ws/play/war) queues through. The reads are open and CORS-enabled; the report write is signed. Full subsystem doc: [Coin Wars](coin-wars.md).

Standings are **not** computed here. `multiplayer/src/war-standings.js` folds the `clash_battles` ledger, and it is the same module the arena's league uses, so a rating in the world and a rating in the API can never disagree.

**The board.** `coin` adds that community's own league row (`standing`, `null` when it has never fought) and narrows `recent` to its battles.

```bash
curl -s 'https://three.ws/api/wars?coin=FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump&limit=5'
```

```json
{
	"data": {
		"network": "mainnet",
		"standing": { "rank": 1, "rating": 1016, "wins": 1, "losses": 0, "draws": 0, "kd": 1.39, "streak": 1, "winRate": 1 },
		"standings": [],
		"ledgerAvailable": true,
		"battlesRead": 1,
		"seasonWindowFull": false,
		"recent": [],
		"recentAvailable": true,
		"live": [],
		"queue": { "available": true, "waiting": [] }
	}
}
```

The ledger (Postgres) and the live registry (Redis) fail independently, so `ledgerAvailable`, `recentAvailable` and `queue.available` report which surface is actually answering. A caller must render the missing one as unavailable rather than as "no wars".

**Queueing.** Post the community, poll until it pairs. A pairing returns the `matchKey` both sides join under plus a signed `ticket`; the arena room takes the two competing communities from that ticket, never from the joining client, so a fighter cannot open a battle against a community that never agreed to fight.

```bash
curl -s -X POST 'https://three.ws/api/wars?action=queue' \
  -H 'content-type: application/json' \
  -d '{"coin":"FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump","symbol":"THREE"}'
```

```json
{ "data": { "status": "matched", "matchKey": "w1:mainnet:...", "ticket": "<signed>", "side": "a", "opponent": { "mint": "...", "symbol": "..." } } }
```

`status` is `waiting` while nobody else is in line. An unpaired place in the queue expires after 90 seconds; a pairing stays claimable for 10 minutes. `POST ?action=leave` with `{"coin":"<mint>"}` gives the place up immediately.

Queueing does not grant entry. The arena still requires a holder pass for the coin you fight for, exactly as a coin's Holders world does, and that check runs server-side in the room.

**Reporting.** `POST ?action=report` is for the authoritative game server only: HMAC-SHA256 of the raw body in `x-war-signature`, keyed on `WAR_RESULT_SECRET`. It is idempotent on `matchKey`, so a retried report updates the row rather than counting a battle twice. Any unsigned or mis-signed request is `401`.

---

## Event Leaderboard API

```
GET /api/play/event-leaderboard
GET /api/play/event-leaderboard?account=<player-account>&limit=<1..100>
```

The live standing for the event quest line: during a platform event (the window in `public/event.json`) the `/play` jobs board carries a set of event-only jobs, and this is the ranking of who has completed the most of them. No auth, CORS open, cached 5 seconds at the edge.

Ranking is completions first, then total event gold earned, then the earlier finisher, then a stable id fallback. It is computed by `multiplayer/src/event-leaderboard.js`, the same module the in-world panel's rows come from, so the web and the world can never disagree.

`account` pins that player's own row into `you` even when they rank below the returned page; omit it for an anonymous read. `limit` defaults to 10 and clamps to 100. Account keys never appear in the response, only rank, display name and score.

Scores are written exclusively by the authoritative game server (through the world-service-token endpoint `POST /api/internal/event-score`, which additionally refuses any run reported outside the configured window). Nothing here grants anything: **prizes are announced from this board and settled manually by the three.ws team after the event, never paid automatically or on-chain.**

**Response**

```json
{
	"event": {
		"id": "three-first-meetup",
		"name": "$THREE First Holders Meetup",
		"startsAt": "2026-08-09T17:00:00Z",
		"endsAt": "2026-08-09T19:30:00Z",
		"live": true
	},
	"top": [
		{ "rank": 1, "name": "Alpha", "runs": 12, "cash": 2640, "lastAt": 1786201408856 }
	],
	"you": { "rank": 17, "name": "You", "runs": 2, "cash": 440, "lastAt": 1786201499000, "inTop": false },
	"players": 41,
	"totalRuns": 96,
	"prizes": { "settlement": "manual", "summary": "…" }
}
```

An event nobody has played yet is an empty board (`top: []`, `players: 0`) with a `200`, not an error: render the "no runs yet" state rather than a failure. `404 no_event` means no event is configured at all, which is what the live deployment answers between events.

<!-- runnable: 404 answers no_event whenever no event window is open in public/event.json -->
```bash
curl -s 'https://three.ws/api/play/event-leaderboard?limit=10'
```

---

## Config API

```
GET /api/config
```

Returns public platform configuration. No auth required. CORS open.

**Response**

```json
{
	"walletConnectProjectId": "...",
	"privyAppId": "...",
	"samlEnabled": false,
	"samlLabel": "Single sign-on (SSO)",
	"pushEnabled": false,
	"vapidPublicKey": "",
	"features": {
		"avatarReconstruct": true,
		"avatarReconstructMode": "platform",
		"avatarByokProviders": [],
		"avatarRigging": true,
		"videoAvatar": false,
		"liveBodyMocap": false
	}
}
```

`features` reports which optional avatar pipelines this deployment has configured, so clients can gate their UI honestly (e.g. `avatarReconstructMode` is `"platform"` when the server holds provider credentials, `"byok"` when the user must supply a key).

---

## Version API

```
GET /api/version
```

Deployment traceability: which commit is live, and on which Cloud Run revision. No auth required. CORS open. Short-cached (10s) so a new deploy shows up promptly. The commit fields are stamped into the image at build time (`dist/build-info.json`, written by `scripts/write-build-info.mjs`); the runtime fields come from the Cloud Run platform env, so no deploy-time injection is needed.

**Response**

```json
{
	"status": "ok",
	"version": "1.5.2",
	"commit": "83368639e0a1b2c3d4e5f6...",
	"commitShort": "83368639e",
	"commitSubject": "feat(forge): auto-classify creations into categories",
	"commitTime": "2026-07-17T20:38:22Z",
	"branch": "main",
	"dirty": false,
	"builtAt": "2026-07-17T21:05:00.000Z",
	"stamped": true,
	"runtime": {
		"service": "three-ws-api",
		"revision": "three-ws-api-00171-g5p",
		"configuration": "three-ws-api",
		"region": null,
		"node": "v24.0.0",
		"uptimeMs": 123456
	}
}
```

`stamped` is `false` when the running image carries no build stamp (e.g. a build that skipped `build:info`); the commit fields are then best-effort from env. Use this to verify a deploy landed:

```bash
curl -s https://three.ws/api/version | jq '{commitShort, revision: .runtime.revision}'
```

The same stamp is served statically at `/build-info.json`.

---

## Platform Stats API

```
GET /api/platform/stats
```

Aggregate, public-safe traction counters for the marketing home page, the
[monitor board](/monitor), and any unauthenticated surface that wants to show
real numbers. No auth, CORS open to any origin, every figure a count that
exposes no individual user. Cached 5 minutes at the CDN and 5 minutes in the
process, so a burst of home page hits costs one set of queries.

**Response**

```json
{
	"available": true,
	"agents": 3140,
	"views": 593,
	"chats": 29,
	"avatars": 25835,
	"countries": 29,
	"widgets": 613,
	"chains": 12,
	"generated": "2026-08-14T02:16:27.780Z"
}
```

| Field | Meaning |
|---|---|
| `agents` | Live agent identities |
| `views` | All-time widget views |
| `chats` | All-time widget chat threads |
| `avatars` | Avatars (GLBs) in the library |
| `countries` | Distinct countries a widget view came from |
| `widgets` | Live widgets |
| `chains` | Mainnets carrying an indexed ERC-8004 agent, plus Solana |

`chains` is derived, never a constant: it counts the distinct chain ids in the
ERC-8004 index that the registry in `api/_lib/erc8004-chains.js` marks as
mainnet, and adds Solana when Solana carries at least one attestation. Testnet
ids (Sepolia, Base Sepolia, Amoy, Fuji) are excluded, which is why this reads
lower than the raw distinct-chain count in `/api/home-stats`.

**When the database is unreachable**

```json
{ "available": false, "reason": "db_unavailable" }
```

Still `200`, but cached for 15 seconds only. Check `available` before reading
any counter: this endpoint never substitutes a zero for a number it could not
count, so a failed read must not be rendered as "0 agents".

```bash
curl -s https://three.ws/api/platform/stats | jq 'select(.available) | {agents, avatars, chains}'
```

The sibling `/api/home-stats` uses the same `available` contract for the home
page strip (on-chain agents, attestations, forge models).

---

## Unstoppable Agent API

The [Unstoppable Agent](/unstoppable) is a self-funding autonomous agent: it
owns a USDC treasury, earns by serving paid status checks over x402, spends on
its own thinking within a budget, tracks its runway, and writes a strategic
reflection once a day. Two endpoints expose the same state at two fidelities.

### Public snapshot (free)

```
GET /api/agents/unstoppable-public
```

No auth, no payment, IP rate-limited, CORS open. Edge-cached for 300 seconds
(one agent tick) and trimmed to the 8 most recent activity rows. This is the
read the `/unstoppable` dashboard renders, so every visitor sees the agent's
real numbers without a wallet.

**Response**

```json
{
	"available": true,
	"live": false,
	"as_of": "2026-08-15T19:20:39.822Z",
	"refresh_seconds": 300,
	"status": "running",
	"treasury": {
		"balance_usdc": "8.930000",
		"balance_usdc_atomics": 8930000,
		"runway_days": 9999,
		"lifetime_earned_usdc": "8.930000",
		"lifetime_spent_usdc": "0.000000"
	},
	"activity_24h": {
		"earnings_usdc": "0.000000",
		"costs_usdc": "0.000000",
		"net_usdc": "0.000000"
	},
	"recent_activity": [
		{
			"action_type": "earn",
			"description": "Revenue from status_check: $0.010000 USDC",
			"cost_usdc": "0.000000",
			"revenue_usdc": "0.010000",
			"created_at": "2026-08-15T19:12:11.402Z"
		}
	],
	"latest_reflection": {
		"date": "2026-08-15",
		"summary": "Revenue covered thinking costs today.",
		"strategy_notes": "Continue status-check monetization."
	},
	"live_endpoint": "/api/agents/unstoppable-status",
	"live_price_usdc": "0.010000",
	"live_price_atomics": "10000",
	"agent_info": { "name": "Unstoppable", "purpose": "Self-sustaining autonomous agent on three.ws", "service": "Paid status checks via x402" }
}
```

| Field | Meaning |
|---|---|
| `live` | Always `false` here. The paid endpoint returns the real-time reading. |
| `as_of` | When this snapshot was generated. It can be up to `refresh_seconds` old. |
| `status` | `running`, `conservation`, or `halted`, derived from the treasury mode |
| `treasury.runway_days` | Balance divided by the last-24h burn. `9999` means no burn was measured, not a 27-year runway. |
| `live_price_usdc` | What the real-time reading costs over x402, so a client can quote it without probing for a 402 |

**When the database is unreachable**

```json
{ "available": false, "reason": "db_unavailable", "live": false, "live_endpoint": "/api/agents/unstoppable-status" }
```

Still `200`, cached 15 seconds. Check `available` before reading the treasury:
a failed read must never render as a broke agent, which is exactly what a
zeroed balance would look like.

```bash
curl -s https://three.ws/api/agents/unstoppable-public | jq 'select(.available) | {status, balance: .treasury.balance_usdc}'
```

### Live reading (paid, $0.01 USDC)

```
GET /api/agents/unstoppable-status
```

x402-paid, Bazaar-discoverable, settles in USDC on Base or Solana. Same shape
as the snapshot plus `activity_24h.action_count`, and it carries 20 activity
rows instead of 8. Two differences matter: the reading is real-time rather than
tick-cached, and a settled payment calls `recordRevenue()`, so this is the only
read that extends the runway it reports. Without an `X-PAYMENT` header it
returns the standard `402` quote.

```bash
# First call returns 402 with the payment requirements
curl -s https://three.ws/api/agents/unstoppable-status

# Retry with the payment header for the live reading
curl -s https://three.ws/api/agents/unstoppable-status \
  -H "X-Payment: <your-x402-payment-header>"
```

A caller with the `x402:bypass` scope is served free by the access-control hook
and is deliberately NOT credited as revenue: reporting money the agent never
earned would inflate the runway this endpoint exists to report honestly.

See [agents/unstoppable/README.md](https://github.com/nirholas/three.ws/blob/main/agents/unstoppable/README.md)
for the tick lifecycle and the treasury rules.

---

## Referrals API

Every three.ws account carries a referral code. A share link is any page URL
with `?ref=CODE` on it. Two endpoints cover the loop: a public beacon that
records the visit, and an authenticated read that returns the sharer's card,
their referred users, and the funnel those visits roll up into.

### Record a referral-link visit

```
POST /api/referral/visit
```

Public and unauthenticated by design: the visitor has no account yet. This is
the top of the referral funnel, and without it only signups are visible, so the
visit to signup conversion is unknowable.

`public/referral-capture.js` fires this automatically on the auth pages when a
`?ref=` parameter is present, so a normal three.ws share link needs no extra
wiring. Call it directly only if you are hosting your own landing page for a
three.ws referral link.

**Request body**

| Field  | Type   | Description                                                  |
| ------ | ------ | ------------------------------------------------------------ |
| `code` | string | Required. The referral code, 3-20 characters of `A-Z0-9`. Matched case-insensitively. |

**Response**

```json
{ "ok": true }
```

```bash
curl -s -X POST https://three.ws/api/referral/visit \
  -H 'content-type: application/json' \
  -d '{"code":"ADA99"}'
```

Privacy and counting rules, both deliberate:

- No raw IP or user agent is stored. The visitor is identified only by
  `sha256(ip + user-agent + code)`.
- A visitor counts once per code per UTC day. A refresh or a replay returns
  `200 {"ok": true}` and writes nothing, so the funnel cannot be inflated by
  reloading a link.
- An unknown code still records a visit with no referrer attached, so traffic on
  a dead or mistyped link stays visible instead of vanishing.

A malformed or missing code returns `400 invalid_code`. A body the endpoint
cannot read at all is reported as its own failure rather than blamed on the
code: a request without `content-type: application/json` returns
`415 unsupported_media_type`, an unparseable body returns `400 bad_request`, and
an oversized one returns `413 payload_too_large`. The endpoint is rate limited
per IP; over the limit returns `429` with a `retry-after` header.

---

### Get my referral card, referrals, and funnel

```
GET /api/users/referrals
```

Requires a session cookie or a bearer token. Returns the signed-in user's
membership card, a paginated breakdown of who they referred and what those
referrals earned them, and the share funnel built from the visit beacons above.

**Query parameters**

| Parameter     | Type    | Description                                                        |
| ------------- | ------- | ------------------------------------------------------------------ |
| `limit`       | integer | Referred-user page size, 1-100 (default: 20)                       |
| `offset`      | integer | Referred-user page offset, >= 0 (default: 0)                       |
| `funnel_days` | integer | Funnel lookback in days, 1-365 (default: 30)                       |

**Response**

```json
{
	"referral_code": "ADA99",
	"referred_users_count": 12,
	"referral_earnings_usd": 41.5,
	"reward_credits_usd": 6,
	"position": 1204,
	"total_members": 27745,
	"score": 161,
	"referred_users": {
		"items": [],
		"total": 12,
		"limit": 20,
		"offset": 0,
		"referral_commission_bps": 500
	},
	"funnel": {
		"days": 30,
		"visits": 200,
		"signups": 50,
		"activations": 20,
		"visit_to_signup_pct": 25,
		"signup_to_activation_pct": 40
	}
}
```

| Funnel field               | Meaning |
|---|---|
| `visits`                   | Deduped link visits recorded in the window |
| `signups`                  | Accounts attributed to this referrer, created in the window |
| `activations`              | Referred users who reached their first creation in the window |
| `visit_to_signup_pct`      | `signups / visits`, one decimal |
| `signup_to_activation_pct` | `activations / signups`, one decimal |

Both percentages are `null`, never `0`, when the stage above them is empty, so a
brand-new sharer reads as "no data yet" rather than "0% conversion". Amounts
ending in `_usd` are dollars; the matching `_total` fields are atomic USDC units
(6 decimals).

```bash
curl -s -b cookies.txt 'https://three.ws/api/users/referrals?funnel_days=7' | jq .funnel
```

`/dashboard/referrals` renders exactly this payload.

---

## Transaction API: build and explain

Three endpoints the in-app wallet and the chat wallet tools
([chat/src/tools.js](../chat/src/tools.js)) use to prepare a transaction for the
user's wallet to sign, and to read one back in plain English. **The server never
signs and never broadcasts**: it returns unsigned bytes, and the wallet owns the
approval.

### Build a Solana transfer

```
POST /api/tx/solana/build-transfer
```

Session cookie required (`401 unauthorized` without one). Builds an unsigned legacy
transaction moving SOL or any SPL token from `sender` to `recipient`.

| Field | Type | Default | Notes |
|---|---|---|---|
| `sender` | string | required | Base58 wallet address. Also the fee payer. |
| `recipient` | string | required | Base58 wallet address. |
| `amount` | number | required | UI amount (SOL, or whole tokens), > 0 and at most 1e12. Converted to base units with fixed-point string math, so no float drift. |
| `token` | string | `SOL` | `SOL` for a native transfer, otherwise the SPL mint address. |
| `memo` | string | none | Attached as an SPL Memo instruction. Max 512 bytes. |
| `network` | string | `mainnet` | `mainnet` or `devnet`. |

The mint's owning program is read from the chain, so **Token-2022 mints work**,
including `$THREE` and every other pump.fun-era launch. The transfer instruction is
`TransferChecked`, which Token-2022 mints carrying a transfer-fee extension require.
The recipient's associated token account is created in the same transaction when it
does not exist yet, paid for by the sender.

```json
{
  "transaction": "AQAAAAAA...",
  "network": "mainnet",
  "blockhash": "7yfLFPfbbzAk52tx5BxfsDcfrneAoJfwEihVJtnkM9ph",
  "lastValidBlockHeight": 417508552
}
```

Deserialize `transaction` (base64), have the wallet sign it, then broadcast and
confirm against `blockhash` / `lastValidBlockHeight`.

Caller faults answer 4xx before anything is built, so a user is never asked to
approve a transaction that can only fail:

| Code | Status | When |
|---|---|---|
| `validation_error` | 400 | A field is missing or malformed (a non-base58 address, a non-positive amount, an oversized memo, an unknown network). `issues[]` names the field. |
| `invalid_mint` | 400 | `token` is not on-chain, or is not an SPL mint. |
| `invalid_owner` | 400 | `sender` or `recipient` is a program-derived address, which has no associated token account and no key to sign with. |
| `insufficient_balance` | 400 | The sender holds less of the token than requested. |
| `invalid_amount` | 400 | The amount rounds to zero at the mint's precision, or exceeds the lamport ceiling. |
| `upstream_error` | 502 | Solana RPC would not answer. |

```bash
curl -s -X POST https://three.ws/api/tx/solana/build-transfer \
  -H 'content-type: application/json' -b cookies.txt \
  -d '{"sender":"<wallet>","recipient":"<wallet>","amount":0.1,"memo":"gm"}' | jq -r .blockhash
```

### Build a Solana swap

```
POST /api/tx/solana/build-swap
```

Session cookie required. Quotes and builds an unsigned Jupiter swap through the
shared lite-api client ([api/_lib/token/jupiter.js](../api/_lib/token/jupiter.js)).

| Field | Type | Default | Notes |
|---|---|---|---|
| `sender` | string | required | Base58 wallet address; the swap's `userPublicKey`. |
| `inputMint` | string | required | Base58 mint to spend. Must differ from `outputMint`. |
| `outputMint` | string | required | Base58 mint to receive. |
| `amount` | number | required | UI amount of `inputMint`, > 0. Scaled by that mint's decimals. |
| `slippageBps` | integer | `50` | 1 to 5000. |
| `network` | string | `mainnet` | `mainnet` only. |

```json
{
  "transaction": "AQAAAAAA...",
  "network": "mainnet",
  "inputAmount": 0.01,
  "outputAmount": 123.456789,
  "outputMint": "FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump",
  "priceImpactPct": "0.12"
}
```

`transaction` is a base64 `VersionedTransaction`. `no_route` (422) means Jupiter
found no route for the pair and size, `swap_failed` (422) that it quoted but could
not build, `invalid_route` (400) that both mints are the same, and `upstream_error`
(502) that Jupiter was unreachable.

### Explain a transaction

```
POST /api/tx/explain
```

No auth; IP rate-limited. Reads a confirmed transaction on Solana or Ethereum
mainnet and returns its transfers plus, when an LLM lane is configured, a one
paragraph plain-English `summary`.

| Field | Type | Notes |
|---|---|---|
| `chain` | string | `solana` or `evm`. |
| `sig` | string | Solana: a base58 signature that decodes to exactly 64 bytes. EVM: a `0x`-prefixed 32-byte tx hash. |

Solana reads go to the Helius enhanced-transaction API and fall back to
`getParsedTransaction` over the rotating RPC chain, reconstructing transfers from
balance deltas. EVM reads walk a failover chain of Alchemy, any configured RPC, then
keyless public nodes, and decode ERC-20 `Transfer` logs.

```json
{
  "tokenTransfers": [],
  "nativeTransfers": [{ "account": "<pubkey>", "amount": -5000 }],
  "description": "",
  "type": "",
  "feePayer": "<pubkey>",
  "source": "rpc-fallback",
  "summary": "The account paid a 5,000 lamport fee ..."
}
```

A finished explanation is cached for 24 hours per `chain:sig`, so re-explaining the
same transaction costs nothing upstream. A malformed `chain` or `sig` is
`400 bad_request` and never reaches a billed upstream; an unknown transaction is
`404 not_found`; an RPC outage is `502 upstream_error`; exhausting the shared
enhanced-API cost ceiling is `429`.

```bash
curl -s -X POST https://three.ws/api/tx/explain \
  -H 'content-type: application/json' \
  -d '{"chain":"solana","sig":"<base58 signature>"}' | jq -r .summary
```

---

## Solana Actions API (Blinks)

three.ws publishes a Solana Action so "Claim Your 3D Avatar" unfurls as a Blink
card on X and in any Blink-aware wallet. `/.well-known/solana/actions.json` maps
`/api/actions/**` for Action clients, and the card's icon is a live headless
render of the avatar's own GLB rather than a static image.

### Claim-avatar action

```
GET  /api/actions/avatar?avatar=default
POST /api/actions/avatar?avatar=<avatarId>
```

No auth required. `avatar` is either `default` or an avatar UUID; anything else is
`400 bad_request`. An avatar that is private, deleted, or unknown is `404 not_found`,
so a card never advertises a claim the viewer cannot complete. A named avatar's card
is titled with that avatar's name.

Responses carry `x-action-version: 2.1.3` and `x-blockchain-ids: solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp`,
including on the `OPTIONS` preflight. Errors carry both the standard
`error` / `error_description` envelope and the Actions spec's `message` field.

**GET response** (`ActionGetResponse`):

```json
{
  "type": "action",
  "icon": "https://three.ws/api/actions/avatar-icon?avatar=default",
  "label": "Claim Avatar",
  "title": "My 3D Avatar on three.ws",
  "description": "Register your Solana wallet to this 3D avatar. ...",
  "links": {
    "actions": [
      { "type": "transaction", "label": "Claim This Avatar", "href": "/api/actions/avatar?avatar=default" }
    ]
  }
}
```

**POST body:** `{ "account": "<wallet pubkey>" }`. The account must be a base58
ed25519 public key that is on the curve; a program-derived address (which no key
can sign for) is rejected with `400 bad_request` before any transaction is built.

**POST response** (`ActionPostResponse`): a base64 `VersionedTransaction` carrying a
single unsigned SPL Memo instruction. The server never signs; the wallet does.

```json
{
  "type": "transaction",
  "transaction": "AQAAAAAA...",
  "message": "Your 3D avatar identity is now recorded on Solana. Welcome to three.ws."
}
```

The memo payload is `{"v":1,"action":"avatar-claim","avatar":"<avatarId>","site":"three.ws"}`.
A Solana RPC that will not answer returns `503 rpc_unavailable`.

```bash
curl -s https://three.ws/api/actions/avatar | jq .title
curl -s -X POST https://three.ws/api/actions/avatar \
  -H 'content-type: application/json' \
  -d '{"account":"FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump"}' | jq -r .type
```

---

### Blink card icon

```
GET /api/actions/avatar-icon?avatar=default&pose=tpose&bg=%230a0a0a
```

Renders the avatar's GLB to a 512x512 `image/png` through headless chromium and
serves it with a one-day browser / one-week edge cache. No auth required; `GET`
and `HEAD` only, since every other method would boot a browser for nothing.

| Parameter | Default | Notes |
|---|---|---|
| `avatar` | `default` | `default` or an avatar UUID. Anything else is `400`. An avatar with no reachable model falls back to the default GLB. |
| `pose` | none | A pose preset id from `GET /api/render/avatar-clip`. Anything that is not a preset-shaped id is `400`. |
| `bg` | `#0a0a0a` | A CSS color (hex, `rgb()`/`rgba()`, `hsl()`/`hsla()`, a named color) or `transparent`. Anything else is `400`: this value is embedded in the renderer's page, so it is never passed through unchecked. |

Render failures surface the class of failure rather than one blanket code: `400`
for an unfetchable GLB, `413` for one over the size cap, `502` for a renderer fault.

---

## Forever API (Bitcoin inscriptions)

Backs the [/forever](https://three.ws/forever) page: a message is written into a
Taproot witness on Bitcoin mainnet through [OrdinalsBot](https://ordinalsbot.com),
where it stays permanently. three.ws never custodies the payment. The order
returns a Bitcoin charge address and the user pays it from their own wallet, so
these endpoints only create and read orders.

### Create an inscription order

```
POST /api/forever/inscribe
```

Requires auth (session cookie or bearer token) because each call spends the
platform's OrdinalsBot quota. Rate limited to 10 orders per IP per 10 minutes.

**Request body**

| Field | Required | Notes |
|---|---|---|
| `message` | yes | 1 to 1500 bytes of UTF-8 text. Trimmed before measuring. |
| `receiveAddress` | no | The Taproot (`bc1p...`) address that receives the inscription. Validated all the way through its bech32m checksum, not just its shape, so a mistyped address is caught here instead of becoming an opaque upstream error. Defaults to `BTC_INSCRIPTION_RECEIVE_ADDRESS`. |
| `feeRate` | no | Integer sats/vB, 1 to 200. Defaults to 8. |

Ordinals can only be received by Taproot wallets, so a legacy, SegWit v0, or
testnet address is a `400`.

**Response**

```json
{
	"orderId": "order-abc",
	"status": "waiting-payment",
	"charge": {
		"address": "bc1p...",
		"amount": 24500,
		"amountBtc": 0.000245,
		"currency": "BTC",
		"lightningInvoice": "lnbc245u1p...",
		"expiresAt": 1786582273
	},
	"receiveAddress": "bc1p...",
	"feeRate": 8,
	"sizeBytes": 13,
	"mempoolBaseUrl": "https://mempool.space",
	"ordinalsViewerBaseUrl": "https://ordinals.com/inscription"
}
```

`amount` is in satoshis; `amountBtc` is the same figure in BTC. Pay either the
`charge.address` or the Lightning invoice when one is offered.

**Errors:** `400` (`bad_request`, `invalid_message`, `invalid_receive_address`,
`invalid_fee_rate`), `401` (`unauthorized`), `405`, `429` (`rate_limited` for the
per-IP ceiling, `upstream_rate_limited` when OrdinalsBot throttles the platform
key), `502` (`inscription_failed`), `503` (`no_receive_address`,
`invalid_vault_address`).

Every OrdinalsBot fault is reported as `502`, including the ones it returns as
`HTTP 200` with `{"status":"error"}` or as a bare `404`. Its status codes describe
its own proxy, not your request, so they are never passed through.

---

### Read an inscription order

```
GET /api/forever/status?id=<orderId>
```

No auth: an order id is the bearer of its own status, and the pay screen polls
this while the user waits on a Bitcoin confirmation. Rate limited to 200 reads
per IP per 5 minutes, which clears a long wait in several tabs.

**Response**

```json
{
	"orderId": "order-abc",
	"state": "inscribed",
	"paid": true,
	"inscribed": true,
	"charge": { "address": "bc1p...", "amount": 24500, "amountBtc": 0.000245, "paidAmount": 24500 },
	"inscription": {
		"id": "<txid>i0",
		"revealTxid": "<txid>",
		"commitTxid": "<txid>",
		"onchain": {
			"confirmed": true,
			"confirmations": 11,
			"blockHeight": 900000,
			"blockTime": 1786582273,
			"source": "esplora"
		}
	},
	"links": {
		"inscription": "https://ordinals.com/inscription/<txid>i0",
		"inscriptionPreview": "https://ordinals.com/preview/<txid>i0",
		"revealTx": "https://mempool.space/tx/<txid>",
		"commitTx": "https://mempool.space/tx/<txid>",
		"chargeAddress": "https://mempool.space/address/bc1p..."
	}
}
```

`state` is one of `waiting-payment`, `payment-received`, `inscribing`,
`inscribed`, `failed`. `paid` is true only for the three states that can be
reached after settlement, so a `failed` order (expired, cancelled, refunded) is
never reported as paid.

`inscription.onchain` is real Bitcoin confirmation depth for the reveal
transaction, read keyless from Blockstream Esplora so the caller sees actual
finality rather than the order's own state. It fails soft: while the reveal
transaction is unbroadcast or unindexed, or if Esplora is unreachable, it is
`null` and the rest of the response is unaffected.

**Errors:** `400` (`missing_id`, `invalid_id`), `404` (`order_not_found`), `405`,
`429` (`rate_limited`, `upstream_rate_limited`), `502` (`status_lookup_failed`).

An id that OrdinalsBot does not know is a `404`, even though OrdinalsBot itself
reports it as `HTTP 200` with `{"status":"error","error":"invalid orderId"}`.
Clients should treat `404` as terminal and stop polling.

---

## Plugin Marketplace API

Tool plugins in the LobeHub / pai-chat `ToolManifest` format: the catalog behind
the plugin grid on [/marketplace](/marketplace) and the picker on an avatar's
own page (`/avatars/<id>`). A manifest declares an `identifier`, a `meta.title`, and a
non-empty `api[]` of tool definitions; the platform stores it verbatim and
re-serves it, so a client that understands the format can install straight from
a listing.

All five routes live in `api/plugins/[action].js`.

### List plugins

```
GET /api/plugins
GET /api/plugins/list?category=&q=&sort=&cursor=&limit=
```

Public, unauthenticated. Both paths are the same handler; the bare collection
path is the canonical one.

| Parameter | Default | Meaning |
|---|---|---|
| `category` | all | Exact category slug, as returned by `/api/plugins/categories` |
| `q` | none | Case-insensitive substring match on name or description (first 80 chars used). Taken literally: `%` and `_` are escaped, not treated as wildcards. |
| `sort` | `popular` | `popular` (install count), `new` (newest first), or `az` (name). An unknown value falls back to `popular`. |
| `limit` | `20` | 1 to 40 |
| `cursor` | `0` | Opaque offset. Pass back the `next_cursor` from the previous page verbatim. |

`cursor` must be a non-negative integer; anything else is a `400`
(`validation_error`), never a 500. `next_cursor` is `null` on the last page. The
sort is fully ordered (ties break on the plugin id), so paging through the whole
catalogue returns every plugin exactly once.

```bash
curl -s 'https://three.ws/api/plugins/list?sort=az&limit=2' | jq '.data.items[].identifier'
```

```json
{
  "data": {
    "items": [
      {
        "id": "764f3eb7-7691-485e-b147-53080bd9f5f9",
        "identifier": "web-search",
        "manifest_url": null,
        "manifest_json": { "identifier": "web-search", "meta": {}, "api": [] },
        "name": "Web Search",
        "description": "Search the web for up-to-date information.",
        "category": "web-search",
        "tags": ["search", "web", "utility"],
        "install_count": 0,
        "avg_rating": 0,
        "author": null,
        "created_at": "2026-05-02T07:43:09.276Z",
        "price": null
      }
    ],
    "next_cursor": "20"
  }
}
```

`author` is `null` for the platform's built-in plugins. `price` is `null` unless
the plugin carries an active row in `asset_prices`.

### Categories

```
GET /api/plugins/categories
```

Every category that has at least one public plugin, with its count, ordered by
count. Cached 60 seconds. `{"data":{"categories":[{"slug":"tools","count":4}]}}`.

### Get a plugin

```
GET /api/plugins/:id
```

`:id` is the plugin UUID. A plugin published with `is_public: false` is visible
only to its author (session cookie or bearer token); to everyone else it is a
`404`, the same answer as an id that does not exist.

### Record an install

```
POST /api/plugins/:id/install
```

Increments the public install counter. No auth: the marketplace fires it when a
visitor installs a plugin into their own client.

```json
{ "data": { "ok": true, "counted": true, "install_count": 4 } }
```

Deduplicated to one counted install per (IP, plugin) per 30 minutes. A repeat
inside that window is still a `200`, with `counted: false` and the unchanged
total, so a client never has to special-case it. An unknown or non-visible
plugin is a `404`.

### Import a manifest by URL

```
POST /api/plugins/import
```

```json
{ "manifest_url": "https://example.com/plugin.json" }
```

Fetches the URL server-side (so the browser is not blocked by the host's CORS
policy), validates it as a manifest, and returns it with a `_manifest_url` field
added. It writes nothing: the caller decides whether to install locally or
publish. 20 requests per 5 minutes per IP.

The fetch is SSRF-guarded. The host and every redirect hop is DNS-resolved and
checked before the socket opens, and private, loopback, link-local, and cloud
metadata ranges are refused (`400`, `validation_error`). The transfer is capped
at 64 KB and aborted mid-stream if the host exceeds it (`422`, `fetch_failed`).

**Errors:** `400` (missing / unparseable / non-http `manifest_url`, blocked
host), `422` (`fetch_failed` for a non-2xx or oversized response;
`invalid_manifest` when the response is not JSON at all, which is what linking a
repository page instead of the raw file produces, or when the JSON is not a
manifest), `429`.

### Publish a plugin

```
POST /api/plugins/publish
```

Requires authentication (session cookie or bearer token) and, for a cookie
session, an `X-CSRF-Token` header from `GET /api/csrf-token`. 30 per hour per
user.

```json
{
  "manifest_json": {
    "identifier": "my-plugin",
    "meta": { "title": "My Plugin", "description": "Does a thing.", "category": "tools" },
    "api": [{ "name": "do_thing", "description": "Does the thing" }]
  },
  "manifest_url": "https://example.com/plugin.json",
  "is_public": true
}
```

An upsert on `(identifier, author_id)`, so re-publishing the same identifier
updates your existing row rather than creating a second one. `is_public: false`
keeps the plugin out of the list and the category counts and restricts detail
reads to you. Responds with the same plugin shape the list returns.

**Manifest rules:** `identifier` is required, alphanumeric plus `.`, `-`, `_`,
and at most 128 characters; `meta.title` is required; `api` must be a non-empty
array of at most 100 tool objects. Each tool needs a `name` of 1 to 64 letters,
digits, underscores, or hyphens (the charset every model provider accepts for a
tool definition, since installers pass these straight through) and a non-empty
`description` of at most 1024 characters. The whole manifest must serialize to
64 KB or less, the same ceiling the import fetch enforces, because it is stored
verbatim and re-served on every read. A violation is a `422`
(`invalid_manifest`) naming the specific rule.

**Errors:** `401` (no auth), `403` (`csrf_missing` / `csrf_invalid`), `400`
(malformed body), `413` (body over the manifest ceiling), `422`
(`invalid_manifest`), `429`.

---

## IPFS Pinning API

Puts bytes on IPFS and reports whether they are still held there. Both actions
live in `api/pinning/[action].js`.

The pinning credential is server-held and never reaches the browser, which is
the whole reason this endpoint exists: the Avatar Studio mint flow
(`character-studio/src/library/mint-utils.js`) posts an avatar here instead of
talking to a pinning provider directly. Providers are tried in order, Pinata
first and web3.storage second, matching `api/_lib/ipfs-pin.js`.

### Pin a file

```
POST /api/pinning/pin
```

Authenticated: a session cookie or a bearer token. Rate limited to 30 pins per
hour per user.

| Field | Required | Meaning |
|---|---|---|
| `sourceUrl` | yes | Either a `data:` URL carrying the bytes inline, or an `https://` URL on the platform's own storage domain. Any other host is a `400`. |
| `kind` | yes | `glb` or `manifest`. Anything else is a `400`. |
| `filename` | no | The name filed at the provider. Reduced to `A-Za-z0-9._-` and capped at 128 characters; a value that survives none of that, or is not a string, falls back to `avatar.glb` or `manifest.json` by `kind`. Omitted on a storage-URL pin, the object's own key is used. |

Three size ceilings apply, and they are different numbers because they bound
different things:

| Ceiling | Value | Applies to |
|---|---|---|
| Request body | 8 MB | The whole JSON document, enforced by the server for every endpoint |
| Inline payload | 5 MB | The decoded bytes of a `data:` URL. Base64 inflates raw bytes by 4/3, so 5 MB of payload is about 6.7 MB of body |
| Storage source | 50 MB | The object fetched from an `https://` source URL |

Anything larger than the inline ceiling should be uploaded to storage first and
pinned by URL, which is what the 50 MB lane is for.

```bash
curl -X POST https://three.ws/api/pinning/pin \
  -H "Authorization: Bearer $THREE_WS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"sourceUrl":"data:application/json;base64,eyJuYW1lIjoiS25pZ2h0In0=","kind":"manifest","filename":"knight.json"}'
```

```json
{
  "ok": true,
  "cid": "QmYazpLPRXtuBsCQk64LpXohMxSGJa3RoQTx9fckJgPY9o",
  "gatewayUrl": "https://ipfs.io/ipfs/QmYazpLPRXtuBsCQk64LpXohMxSGJa3RoQTx9fckJgPY9o",
  "gatewayUrls": [
    "https://ipfs.io/ipfs/QmYazpLPRXtuBsCQk64LpXohMxSGJa3RoQTx9fckJgPY9o",
    "https://dweb.link/ipfs/QmYazpLPRXtuBsCQk64LpXohMxSGJa3RoQTx9fckJgPY9o",
    "https://w3s.link/ipfs/QmYazpLPRXtuBsCQk64LpXohMxSGJa3RoQTx9fckJgPY9o",
    "https://gateway.pinata.cloud/ipfs/QmYazpLPRXtuBsCQk64LpXohMxSGJa3RoQTx9fckJgPY9o"
  ],
  "provider": "pinata"
}
```

`gatewayUrl` is the single canonical read URL; `gatewayUrls` is every gateway
worth trying. A freshly pinned CID takes minutes to propagate across the public
network, so the provider's own gateway (last in the list) is the one guaranteed
to serve it immediately.

**Errors:** `400` (`validation_error`: missing `sourceUrl`, bad `kind`,
malformed `data:` URL, or a source host the platform does not own), `401`
(`unauthorized`), `413` (`payload_too_large`, naming the ceiling that was
crossed), `415` (body was not JSON), `429` (`rate_limited`), `502`
(`fetch_failed`: the source URL was unreachable or redirected), `503`
(`pinning_unconfigured`).

A request that is malformed always answers `4xx`, including on a deployment
with no provider configured: the `503` is reached only once the request itself
is known to be valid.

### Check whether a CID is still pinned

```
GET /api/pinning/status?cid=<cid>
```

Public, unauthenticated, rate limited by IP. `cid` must be 16 to 128
alphanumeric characters.

```bash
curl "https://three.ws/api/pinning/status?cid=QmYazpLPRXtuBsCQk64LpXohMxSGJa3RoQTx9fckJgPY9o"
```

```json
{
  "cid": "QmYazpLPRXtuBsCQk64LpXohMxSGJa3RoQTx9fckJgPY9o",
  "pinned": true,
  "provider": "pinata",
  "unreachableProviders": [],
  "gatewayUrls": ["https://ipfs.io/ipfs/QmYazpLPRXtuBsCQk64LpXohMxSGJa3RoQTx9fckJgPY9o"]
}
```

`pinned: false` means every provider that answered said it is not holding the
CID. It never means "we could not tell": a provider that failed to answer is
named in `unreachableProviders` instead, and if none of them answered the
response is a `503` (`pinning_check_failed`) rather than a `200`. Treat
`unreachableProviders` as non-empty before acting on `pinned: false`, because a
partial answer is still a partial answer.

**Errors:** `400` (`validation_error`: missing or out-of-bounds `cid`), `429`
(`rate_limited`), `503` (`pinning_unconfigured` or `pinning_check_failed`).

---

## Image proxy API

```
GET /api/img?url=<https-or-ipfs-image-url>
GET /api/img?url=<image-url>&w=480
GET /api/img?meta=<token-metadata-json-url>
GET /api/img?seed=<any-string>
```

Same-origin delivery for remote artwork, so the browser only ever talks to
three.ws. The upstream is fetched server-side through the SSRF-hardened
fetcher (public hosts only, 8 MB cap, one shared 25 s budget); an IPFS URL is
raced across several public gateways and the first valid image wins; a
`?url=` that turns out to be a token *metadata* document is followed one hop to
its `image` field (`?meta=` says so explicitly). When every source fails the
endpoint still answers `200` with a deterministic, on-brand SVG placeholder
derived from the seed, so an `<img>` or a Three.js texture loader never logs an
error.

`w` asks for a resized copy: the image is scaled to at most that width (never
enlarged) and re-encoded as WebP at quality 82. Widths snap up to a fixed
ladder (`64, 96, 128, 192, 256, 320, 480, 640, 960`), so a gallery cannot mint
an unbounded set of variants at the edge. Only rasters are resized (PNG, JPEG,
WebP, AVIF, TIFF); an SVG or GIF, or a file the resizer cannot decode, comes
back as the original bytes. Ask for the width the box paints at 2x: the Forge
showcase requests `w=480` for a card that renders at roughly 240 px, which
turns a 1 MB stored render into a 20-40 KB tile
([src/shared/image-url.js](../src/shared/image-url.js) builds the URL and
leaves same-origin, `data:` and `blob:` sources untouched).

Real images are cached immutably (`max-age=86400, s-maxage=604800, immutable`):
the same upstream URL at the same width is the same bytes forever, so route a
URL through here only when its content never changes in place. Placeholders
cache for 5 minutes at the browser and an hour at the edge so a transiently
down source can recover. Rate limit: 300 requests per 5 minutes per IP.

## Subscriptions API

Recurring creator subscriptions. A creator publishes one or more **plans**
(tiers); a subscriber joins one either through the x402 renewal-intent path
(`POST /api/subscriptions`) or the Solana USDC checkout
(`/api/subscriptions/subscribe` then `/api/subscriptions/verify`).

All ids are UUIDs. A malformed id answers `400 validation_error`, never a `5xx`.
Session-cookie mutations require an `X-CSRF-Token` header (see
[Authentication](#authentication)); bearer-token callers are exempt.

### List plans

```
GET /api/subscriptions/plans?creator_id=<uuid>
GET /api/subscriptions/plans?agent_id=<uuid>
```

Public. Exactly one of `creator_id` or `agent_id` is required. Only active plans
are returned; the plan's own creator may add `include_inactive=1` to also receive
their drafts.

```json
{
  "plans": [
    {
      "id": "735977d9-289d-4517-8ac4-68e97c649de8",
      "creator_id": "f23703c0-9d75-4e60-9a4c-349da5d7a2f2",
      "agent_id": null,
      "name": "Supporter",
      "price_usd": "9.99",
      "interval": "monthly",
      "perks": ["priority support"],
      "included_skills": [],
      "active": true,
      "created_at": "2026-08-16T06:16:24.604Z"
    }
  ]
}
```

**Errors:** `400` (`validation_error`: neither id given, or a non-UUID),
`429` (`rate_limited`).

---

### Get one plan

```
GET /api/subscriptions/plans/:id
```

Public for an active plan. A deactivated plan (draft) is served only to its
creator; everyone else gets `404`, so a draft's existence never leaks.

**Response:** `{ "plan": { … } }`, same shape as a list entry.

**Errors:** `400` (`validation_error`), `404` (`not_found`), `429`.

---

### Create a plan

```
POST /api/subscriptions/plans
```

Requires auth. A creator may hold at most 3 **active** plans; drafts
(`active: false`) do not consume a slot.

**Request body**

```json
{
  "agent_id": "717e68f1-e0c2-41ee-8ff7-6801a83206c9",
  "name": "Supporter",
  "price_usd": 9.99,
  "interval": "monthly",
  "perks": ["priority support"],
  "included_skills": [],
  "active": true
}
```

`name` is 2 to 80 characters, `price_usd` is 0.99 to 999, `interval` is
`weekly` or `monthly` (default `monthly`), `perks` is up to 10 strings,
`included_skills` up to 50. `agent_id` is optional and must be an agent you own.

**Response** (`201`): `{ "plan": { … } }`

**Errors:** `400` (`validation_error`), `401` (`unauthorized`), `403`
(`csrf_missing` / `csrf_invalid`, or `forbidden` when `agent_id` is not yours),
`409` (`conflict`: the 3-active-plan cap), `429`.

---

### Update a plan

```
PATCH /api/subscriptions/plans/:id
PUT   /api/subscriptions/plans/:id
```

Requires auth, creator only. Both verbs behave identically: the body is a
partial update, and any field left out is untouched. `PUT` is accepted because
the dashboard plan editor saves with it.

**Request body:** any subset of `name`, `price_usd`, `interval`, `perks`,
`included_skills`, `active`.

**Response:** `{ "plan": { … } }`

**Errors:** `400` (`validation_error`, including an empty body: "nothing to
update"), `401`, `403`, `404` (`not_found`: unknown plan, or not yours), `409`
(reactivating past the 3-active cap).

---

### Deactivate a plan

```
DELETE /api/subscriptions/plans/:id
```

Requires auth, creator only. A soft delete: the row stays and `active` flips to
`false`, so existing subscribers keep their record and the plan can be
reactivated with `PATCH { "active": true }`.

**Response:** `{ "ok": true }`

**Errors:** `400`, `401`, `403`, `404`.

---

### Subscribe (x402 renewal intent)

```
POST /api/subscriptions
```

Requires auth. Creates or reactivates the subscription immediately and then
raises a payable intent for the first period. Payment is request-based (x402):
the server never pulls funds, it hands back what the subscriber owes.

**Request body**

```json
{ "plan_id": "735977d9-289d-4517-8ac4-68e97c649de8", "wallet_address": "<solana pubkey>" }
```

**Response** (`201`)

```json
{
  "subscription": {
    "id": "7c8e0051-0279-484a-b7d5-a19d821ade61",
    "plan_id": "735977d9-289d-4517-8ac4-68e97c649de8",
    "status": "active",
    "current_period_end": "2026-09-15T06:16:50.257Z",
    "payment_method": "x402"
  },
  "payment": { "pending": true, "paymentId": "…", "payUrl": "https://three.ws/pay/…" }
}
```

`payment` reports the first charge attempt and is informational: a plan whose
creator has no payout wallet answers `{ "success": false, "error":
"creator_payout_wallet_missing" }` while the subscription itself is still
created.

**Errors:** `400`, `401`, `403`, `404` (`not_found`: unknown plan), `409`
(`conflict`: plan deactivated, your own plan, or already subscribed), `429`.

---

### My subscriptions

```
GET /api/subscriptions/mine
```

Requires auth. Every subscription the caller holds, newest first, joined with
the plan name/price/interval and the creator's display name.

```json
{ "subscriptions": [ { "id": "…", "status": "active", "plan_name": "Supporter", "price_usd": "9.99", "creator_name": "…" } ] }
```

---

### Subscription detail

```
GET /api/subscriptions/:id
```

Requires auth. Readable by the subscriber **or** the plan's creator; anyone else
gets `404`.

---

### Cancel a subscription

```
DELETE /api/subscriptions/:id
```

Requires auth, subscriber only. Sets `status = 'cancelled'` and stamps
`cancelled_at`; the record is kept so the period already paid for stays
auditable. Re-subscribing to the same plan reactivates this row.

**Response:** `{ "ok": true, "subscription": { "id": "…", "status": "cancelled" } }`

---

### Solana USDC checkout: quote

```
POST /api/subscriptions/subscribe
```

Requires auth. Quotes the exact USDC split for one period, persists a pending
checkout with a Solana-Pay reference, and returns a base64
`VersionedTransaction` for the buyer's wallet to sign and broadcast. The
platform pre-signs as fee payer when a payer keypair is configured, so the
subscriber needs no SOL.

**Request body**

```json
{ "tierId": "735977d9-289d-4517-8ac4-68e97c649de8", "buyerPublicKey": "<solana pubkey>" }
```

**Response** (`200`)

```json
{
  "data": {
    "transaction": "<base64 VersionedTransaction>",
    "reference": "7qhfZb3yGi93qw3gp7KhbEwbmiXCQYdS5w3iCgG8azYs",
    "recipient": "<creator payout address>",
    "amount": "9990000",
    "creator_amount": "9990000",
    "currency_mint": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    "mint_decimals": 6,
    "gasless": false,
    "label": "Subscribe: Supporter",
    "message": "Subscribe to 'Supporter' (monthly)",
    "tier": { "id": "…", "name": "Supporter", "price_usd": 9.99, "interval": "monthly" }
  }
}
```

Amounts are USDC atomic units (6 decimals). When a platform fee applies, a
`fee` block carries its recipient, amount and bps, and `creator_amount` is the
remainder. Calling twice inside the 30-minute window reuses the same pending
checkout rather than minting a second one.

**Errors:** `400` (`validation_error`), `401`, `403`, `404` (`not_found`),
`409` (`conflict`: tier inactive or your own; `already_subscribed`), `412`
(`creator_wallet_missing`), `429`.

---

### Solana USDC checkout: verify

```
POST /api/subscriptions/verify
```

Requires auth. Validates the broadcast transaction against the **persisted**
quote (never the client's numbers) and, on success, activates the subscription,
writes the first-period payment row, and opens the skill-access gate.

**Request body**

```json
{ "tierId": "735977d9-289d-4517-8ac4-68e97c649de8", "transactionSignature": "<base58 signature>" }
```

`transactionSignature` is optional: without it the chain is scanned by the
checkout's reference key.

**Response** (`200`)

```json
{
  "data": {
    "success": true,
    "status": "active",
    "subscription": { "id": "…", "current_period_end": "2026-09-15T06:16:50.257Z" },
    "tx_signature": "…"
  }
}
```

While the transaction is not yet visible on chain the response is
`200 { "data": { "status": "pending" } }`; poll until it settles. Verifying an
already-confirmed checkout is idempotent and returns the live subscription.

**Errors:** `400`, `401`, `403`, `404` (`no_pending_checkout`), `409`
(`checkout_closed`, or `transfer_mismatch` when the on-chain transfer does not
match the quote), `410` (`checkout_expired`), `429`.

---

## EVM RPC proxy

```
POST /api/evm-rpc?chainId=<id>
```

A browser-safe, read-only Ethereum JSON-RPC proxy. Browser code that reads a
contract used to call a keyless public host directly, which meant every page
depended on one endpoint staying up. Posting through this proxy instead
inherits the server's failover chain for that chain: an explicit
`RPC_URL_<chainId>` override first, then Alchemy where a key is configured,
then the curated public tail, rotating to the next endpoint whenever one fails.

No auth required. `chainId` must be a supported EVM chain (the same set
`/api/erc8004/chains` lists).

**Request** Any single JSON-RPC call, or a batch of up to 10:

```bash
curl -s 'https://three.ws/api/evm-rpc?chainId=8453' \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}'
```

**Response** The upstream JSON-RPC envelope, unchanged:

```json
{ "jsonrpc": "2.0", "id": 1, "result": "0x1a2b3c" }
```

**Allowed methods.** Reads only: `eth_call`, `eth_getBalance`,
`eth_blockNumber`, `eth_getLogs`, `eth_getTransactionReceipt`,
`eth_getTransactionByHash`, `eth_chainId`, `eth_estimateGas`, `eth_getCode`,
`eth_getStorageAt`, `net_version`, `eth_gasPrice`, `eth_feeHistory`,
`eth_maxPriorityFeePerGas`, `eth_getBlockByNumber`. Anything that broadcasts a
transaction or opens a filter or subscription is refused: sign and send
transactions from the user's own wallet, not through this proxy.

**Errors**

| Status | `error` | Meaning |
|---|---|---|
| 400 | `unknown_chain` | `chainId` missing or not a supported EVM chain |
| 400 | `bad_body` | body was not valid JSON |
| 400 | `batch_too_large` | more than 10 calls in one batch |
| 403 | `method_not_allowed` | method is not on the read-only allowlist |
| 429 | `rate_limited` | per-IP or global RPC budget exhausted |
| 502 | `no_upstream` / `upstream_error` | no endpoint configured, or every endpoint for that chain failed |

Browser code should use `src/shared/evm-rpc-fallback.js`, which builds a
provider that tries this proxy first and falls back to public hosts when the
page is embedded on a third-party origin.

---

## Seeker verification

Prove that a signed-in user owns a Solana Seeker phone. Every Seeker mints one soulbound Seeker Genesis Token (a Token-2022 token) into its owner's wallet; a user who holds it in a wallet linked to their three.ws account gets the "Seeker verified" badge. Verification scans the wallet through Helius (`getTokenAccountsByOwnerV2`) and checks the token's mint against the official Seeker mint authority (`GT2zuHVaZQYZSyQMgJPLzvkmyztfyXg2NJunqFp4p3A4`) and token group (`GT22s89nU4iWFkNXj1Bw6uYhJJWDRPpShHt4Bk8f99Te`). A wallet must be linked first (Sign-In with Solana, `/api/auth/siws/*`).

### Seeker status

```
GET /api/seeker/status
```

Requires a session. Returns what the platform already knows; no RPC call is made.

**Response**

```json
{
	"verified": true,
	"wallets": [
		{ "address": "7Gq...seekerWallet", "tokenMint": "5Hn...deviceMint", "verifiedAt": "2026-08-27T12:00:00.000Z" }
	],
	"linkedSolanaWallets": ["7Gq...seekerWallet", "9Ab...otherWallet"]
}
```

---

### Verify Seeker ownership

```
POST /api/seeker/verify
```

Requires a session. Rate limited. Scans every linked Solana wallet (or only `wallet`, when given) for a Seeker Genesis Token, records each wallet that holds one, and forgets any previously verified wallet that no longer does.

**Request body** (optional)

```json
{ "wallet": "7Gq...seekerWallet" }
```

**Response:** the same shape as `GET /api/seeker/status` plus `checked`, the number of wallets scanned.

```json
{
	"verified": true,
	"wallets": [{ "address": "7Gq...seekerWallet", "tokenMint": "5Hn...deviceMint", "verifiedAt": "2026-08-27T12:00:00.000Z" }],
	"linkedSolanaWallets": ["7Gq...seekerWallet"],
	"checked": 1
}
```

**Errors**

| Status | Code | Meaning |
| --- | --- | --- |
| 401 | `unauthorized` | No session. |
| 400 | `wallet_not_linked` | `wallet` is not linked to this account as a Solana wallet. |
| 503 | `not_configured` | The deployment has no Helius RPC endpoint. |
| 502 | `rpc_failed` | Solana RPC failed; nothing was recorded (verification fails closed). |

```bash
curl -X POST https://three.ws/api/seeker/verify \
	-H 'content-type: application/json' \
	-b 'session=<your session cookie>' \
	-d '{}'
```

---

## Herald API: deliver a message in person

The rail behind [@three-ws/herald](./herald.md). Anything that can make an HTTPS
request posts a line here, and the browser tab the caller has open says it out
loud through their 3D companion.

An announcement is **always** delivered to the authenticated caller's own
sessions. There is no recipient field, so a key can never be used to interrupt
somebody else.

### Announce

```
POST /api/herald/announce
```

Auth: a signed-in session, or a Bearer API key carrying the `herald:announce`
scope (mint one at `/dashboard/developers`). Rate limit: 60 per minute per
account.

| Field | Type | Notes |
| --- | --- | --- |
| `text` (alias `message`) | string, 1-280 | Required. The line to say. |
| `from` | string, max 60 | Attribution, spoken with the line. |
| `importance` | int 0-100 | Default 70. The receiving client applies its own floor. |
| `url` | string, max 2048 | Same-origin path or absolute `http(s)`; anything else is dropped. |
| `tone` | `neutral` \| `alert` \| `celebrate` \| `error` | Default `alert`. |
| `emote` | string, max 40 | `wave`, `dance`, `punch`, `backflip`. |
| `key` | string, max 120 | Dedupe key; two announcements sharing one are said once. |
| `meta` | object | Passed through to the client untouched. |

```bash
curl -X POST https://three.ws/api/herald/announce \
	-H "Authorization: Bearer $THREE_WS_API_KEY" \
	-H 'content-type: application/json' \
	-d '{"text":"Deploy is green","importance":80,"url":"/dashboard","from":"CI"}'
```

```json
{
  "queued": true,
  "id": "6a293426-8f48-4254-bc14-cef9ada17680",
  "expires_in": 300,
  "announcement": {
    "id": "6a293426-8f48-4254-bc14-cef9ada17680",
    "text": "Deploy is green",
    "from": "CI",
    "importance": 80,
    "url": "/dashboard",
    "tone": "alert",
    "at": 1787888380209
  }
}
```

`202` means the line is queued for a live surface, not that a human heard it.

| Status | Code | Meaning |
| --- | --- | --- |
| 400 | `validation_error` | No `text`, or a field outside its bounds. |
| 401 | `unauthorized` | No session and no bearer credential. |
| 403 | `insufficient_scope` | A valid key without `herald:announce`. |
| 429 | `rate_limited` | More than 60 announcements in a minute. |
| 503 | `service_unavailable` | The rail is not reachable; nothing was queued. |

### Listen

```
GET /api/herald/stream
```

Server-sent events, session-cookie auth only (writing is for machines,
listening is for the person at the browser). Emits `open` once, then one
`announce` per queued line, with a `ping` every 15 seconds. The queue is
drained rather than broadcast, so a line is said by exactly one open tab, and
an undelivered one expires after about five minutes.

```bash
curl -N https://three.ws/api/herald/stream -b 'session=<your session cookie>'
```

```
event: open
data: {"ts":1787888542255}

event: announce
data: {"id":"6a29...","text":"Deploy is green","importance":80,"tone":"alert"}
```

---

## Glance API

One agent reduced to what fits in an operating-system widget slot: name, avatar, one live number (moves in the last 24 hours), and a link back. Powers the Windows 11 widget, the Android home screen widget, README badges and the `<agent-glance>` element. Spec: [specs/GLANCE_CARD.md](../specs/GLANCE_CARD.md). Guide: [glance.md](glance.md), [native-widgets.md](native-widgets.md).

### Public card

```
GET /api/glance/card?agent=<uuid>&format=json|svg|png|adaptive&size=small|medium|large&theme=auto|light|dark&scale=1|2|3
```

No auth. `json` is the card model, `svg` a self-contained image, `png` a bitmap (`scale` is pixel density, `theme` resolves `auto` to dark), `adaptive` a bound Adaptive Card 1.6. Carries an `ETag` and answers `304` to `if-none-match`. An unknown agent answers `404`; for `svg` and `png` the body is still a real card that says so.

### My card

```
GET /api/glance/mine?format=json|png&agent=<uuid>&size=…&theme=dark|light&scale=…
Authorization: Bearer glw_…        (widget token)   or the session cookie
```

Always `200`. JSON: `{ signedIn, state, via, card, notice, agents, signInUrl, createUrl, linkUrl }`, `state` one of `agent`, `signed-out`, `unlinked`, `no-agent`. PNG: the card bitmap for whichever state applies, with `x-glance-state`, `x-glance-url` (tap target), `x-glance-name`, `x-glance-metric`, `x-glance-agent`, `x-glance-updated` headers. `cache-control: private, no-store`.

### Widget tokens

```
POST   /api/glance/token            { label?, platform?: android|macos|ios|other, agent?: uuid }
GET    /api/glance/token
PATCH  /api/glance/token            { id, agent: uuid|null }
DELETE /api/glance/token?id=<uuid>
```

Session cookie required; writes must be same-site. `POST` answers `201` with `{ id, prefix, label, platform, agentId, createdAt, lastUsedAt, token, links: { android } }`. `token` is shown exactly once; `links.android` is the `intent://glance/link?token=…#Intent;scheme=threews;package=ws.three.app;…;end` URL that hands it to the Android app. At most 12 live tokens per account (`409 too_many_tokens`). `GET` answers `{ tokens: [...] }` without plaintexts. `DELETE` answers `{ revoked: true, id }`, or `404` for an id that is not the caller's live token.

| Error | Status | Meaning |
| --- | --- | --- |
| `unauthorized` | 401 | no session |
| `forbidden` | 403 | write from another origin |
| `not_found` | 404 | token or agent is not the caller's |
| `too_many_tokens` | 409 | 12 live tokens already |
| `rate_limited` | 429 | over the per-account write limit |

## Pagination

Paginated list endpoints use `limit`/`offset` query parameters unless noted otherwise (each endpoint's own parameter table is authoritative; some small per-user lists, like `/api/agents` and `/api/widgets`, return everything with no pagination).

```
GET /api/v1/pump/launches?limit=24&offset=24
```

`/api/explore` and `/api/showcase` use keyset (cursor-based) pagination for stability: pass the value the previous page returned (`cursor` on explore, `next_cursor` on showcase) as the `cursor` query parameter on the next request. `/api/agent-actions` and `/api/users/me/feed` are cursor-based too (`cursor` / `before` timestamps).

---

## Error codes

Codes are lowercase snake_case in the `error` field. The common ones, shared across endpoints:

| Code                 | HTTP Status | Description                                     |
| -------------------- | ----------- | ----------------------------------------------- |
| `unauthorized`       | 401         | Missing or invalid auth                         |
| `forbidden`          | 403         | Authenticated but not allowed                   |
| `insufficient_scope` | 403         | Bearer token lacks the required scope           |
| `not_found`          | 404         | Resource doesn't exist                          |
| `rate_limited`       | 429         | Too many requests (see `retry_after`)           |
| `validation_error`   | 400         | Request body or query validation failed         |
| `not_configured`     | 503         | A required provider/env is unset on this deploy |
| `upstream_error`     | 502         | A third-party upstream returned an error        |

Endpoint-specific codes (e.g. `quota_exceeded`, `invalid_avatar`, `no_client_id`) are documented in each endpoint's Errors table above.

---

## SDK

For building on the platform from JavaScript, the official npm package is [`@three-ws/sdk`](https://www.npmjs.com/package/@three-ws/sdk). It is not a thin wrapper over every REST route above; it ships the higher-level building blocks: `AgentKit` (chat panel + ERC-8004 registration + `.well-known` manifest generation), `AgentClient` (x402 agent-to-agent paid skill calls), `PermissionsClient` (ERC-7710 delegations), and the Solana identity/attestation helpers. Full docs: [SDK & Library](sdk.md).

For the endpoints on this page, call them directly with `fetch`/`curl` and a Bearer API key:

```js
const res = await fetch('https://three.ws/api/agents?limit=10', {
	headers: { Authorization: 'Bearer sk_live_xxxxx' },
});
const { agents } = await res.json();
```

---

## Related

- [SDK & Library](/docs/sdk): the npm packages and the web component bundle
- [MCP documentation](/docs/mcp): the same platform surface as MCP tools
- [x402](/docs/x402): how the paid `/api/x402/*` endpoints settle in USDC
- [Payment sessions](/docs/payment-sessions): the buyer side, letting an agent spend a budget without holding a key
- [Authentication](/docs/authentication): SIWE, sessions, API keys, and scopes
