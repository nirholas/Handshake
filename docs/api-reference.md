# REST API Reference

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

All responses are JSON. Successful responses return the resource or a result object. Errors return:

```json
{
	"error": "Message describing what went wrong",
	"code": "ERROR_CODE"
}
```

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

Returns the authenticated user's agents. Requires auth.

**Query parameters**

| Parameter | Type    | Description                    |
| --------- | ------- | ------------------------------ |
| `limit`   | integer | Max results (default: 20)      |
| `offset`  | integer | Pagination offset (default: 0) |

**Response**

```json
{
	"agents": [
		{
			"id": "abc123",
			"name": "Aria",
			"description": "Product guide",
			"avatar_url": "https://cdn.example.com/aria.glb",
			"thumbnail_url": "https://cdn.example.com/aria.png",
			"creator_address": "0xabc...",
			"created_at": "2025-01-15T10:00:00Z",
			"chain_id": 8453,
			"chain_agent_id": 42
		}
	],
	"total": 5,
	"limit": 20,
	"offset": 0
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

**Response**

```json
{
	"id": "new-agent-id",
	"agent": {}
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

Requires auth. Returns the authenticated user's widgets, including joined avatar data.

**Query parameters**

| Parameter  | Type    | Description                    |
| ---------- | ------- | ------------------------------ |
| `limit`    | integer | Max results (default: 20)      |
| `offset`   | integer | Pagination offset (default: 0) |
| `type`     | string  | Filter by widget type          |
| `agent_id` | string  | Filter by agent ID             |

**Response**

```json
{
	"widgets": [
		{
			"id": "wdgt_abc123def456",
			"agent_id": "abc123",
			"type": "turntable",
			"config": { "auto_rotate_speed": 0.5, "preset": "venice" },
			"is_public": true,
			"created_at": "2025-01-15T10:00:00Z",
			"view_count": 42,
			"avatar": {}
		}
	],
	"total": 8,
	"limit": 20,
	"offset": 0
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

**Supported widget types:** `turntable`, `animation-gallery`, `talking-agent`, `passport`, `hotspot-tour`

**Request body**

```json
{
	"agent_id": "abc123",
	"type": "turntable",
	"config": {
		"auto_rotate_speed": 0.5,
		"preset": "venice"
	},
	"visibility": "public"
}
```

**Response**

```json
{
	"id": "wdgt_abc123def456",
	"embed_url": "https://three.ws/widgets/view?id=wdgt_abc123def456"
}
```

Widget IDs use the format `wdgt_` + 12 random base64url characters.

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

### Open Graph metadata

```
GET /api/widgets/og?id=wdgt_abc123def456
```

Returns Open Graph metadata for a widget, used by social preview scrapers (Twitter, Slack, etc.). No auth required.

**Response:** JSON with `og:title`, `og:description`, `og:image`, `og:url`.

---

### oEmbed

```
GET /api/widgets/oembed?url=https%3A%2F%2Fthree.ws%2Fwidgets%2Fview%3Fid%3Dwdgt_abc123
```

oEmbed endpoint for rich embeds in Notion, Substack, and other oEmbed-compatible platforms. No auth required.

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
	"provider": "claude-sonnet-4-6",
	"messages": [{ "role": "user", "content": "Hello" }],
	"system": "You are a friendly product guide.",
	"maxTokens": 1024
}
```

**Supported `provider` IDs**

| Provider            | Network          | Tier     |
| ------------------- | ---------------- | -------- |
| `claude-opus-4-7`   | Anthropic        | flagship |
| `claude-sonnet-4-6` | Anthropic        | balanced |
| `claude-haiku-4-5`  | Anthropic        | fast     |
| `gpt-4o`            | OpenAI           | flagship |
| `gpt-4o-mini`       | OpenAI           | fast     |
| `qwen-*`            | Qwen / Alibaba   | varies   |
| `openrouter:*`      | OpenRouter (any) | varies   |

Call `GET /api/brain/chat` for the live list of providers actually available on the current deployment (depends on which provider keys are configured).

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

---

## TTS API

### Text-to-speech

```
POST /api/tts/eleven
```

Text-to-speech via ElevenLabs with R2 caching. Requires auth.

**Limits**

- Max 500 characters per request
- 1,000 characters per hour per user (tracked via Redis)

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
		"glb_url": "https://cdn.three.ws/forge/anon/<id>.glb",
		"viewer_url": "https://three.ws/viewer?src=https%3A%2F%2Fcdn.three.ws%2Fforge%2Fanon%2F%3Cid%3E.glb",
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
{ "ok": true, "url": "https://cdn.three.ws/material-studio/checkpoints/<uuid>.glb", "bytes": 842113 }
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
	"glbUrl": "https://cdn.three.ws/material-studio/restyle/<uuid>.glb",
	"sourceGlbUrl": "https://cdn.three.ws/creations/<id>/mesh.glb",
	"instruction": "make it chrome",
	"factors": { "name": "Polished chrome", "baseColorFactor": [0.79, 0.81, 0.83], "metallicFactor": 1, "roughnessFactor": 0.05, "emissiveFactor": [0, 0, 0] },
	"materialsEdited": 1,
	"lineage": [
		{ "index": 0, "parentIndex": null, "glbUrl": "https://cdn.three.ws/creations/<id>/mesh.glb", "refKind": "origin" },
		{ "index": 1, "parentIndex": 0, "glbUrl": "https://cdn.three.ws/material-studio/restyle/<uuid>.glb", "instruction": "make it chrome", "refKind": "restyle" }
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
	"sourceGlbUrl": "https://cdn.three.ws/creations/<id>/mesh.glb",
	"preset": "chrome",
	"seed": 42,
	"count": 3,
	"variants": [
		{ "glbUrl": "https://cdn.three.ws/material-studio/variants/<uuid1>.glb", "label": "Chrome 1", "seed": 42, "config": { "color": "#c9ced4", "metalness": 1, "roughness": 0.05 }, "lineageIndex": 1 },
		{ "glbUrl": "https://cdn.three.ws/material-studio/variants/<uuid2>.glb", "label": "Chrome 2", "seed": 43, "config": { "color": "#a1c9d4", "metalness": 0.94, "roughness": 0.09 }, "lineageIndex": 2 }
	],
	"lineage": [
		{ "index": 0, "parentIndex": null, "glbUrl": "https://cdn.three.ws/creations/<id>/mesh.glb", "refKind": "origin" },
		{ "index": 1, "parentIndex": 0, "glbUrl": "https://cdn.three.ws/material-studio/variants/<uuid1>.glb", "instruction": "Chrome 1", "refKind": "variant" },
		{ "index": 2, "parentIndex": 0, "glbUrl": "https://cdn.three.ws/material-studio/variants/<uuid2>.glb", "instruction": "Chrome 2", "refKind": "variant" }
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
	"url": "https://cdn.three.ws/forge/refs/<id>.jpg",
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

```bash
curl -s 'https://three.ws/api/v1/market/projects?limit=5&chain=solana'
```

**Degradation & errors** (both aixbt-backed routes)

| Status | Code            | Meaning                                                                 |
| ------ | --------------- | ------------------------------------------------------------------------ |
| `429`  | `rate_limited`   | Either the shared aixbt ceiling or the per-IP gateway budget is spent    |
| `503`  | `not_configured` | `AIXBT_API_KEY` isn't set on this deployment — never a raw 500           |
| `502`  | `aixbt_upstream_error` | aixbt returned an unexpected error — retry shortly                 |

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

## Authentication API

Authentication is covered in detail in the [Authentication documentation](authentication.md). Quick reference:

| Endpoint                    | Method   | Description                           |
| --------------------------- | -------- | ------------------------------------- |
| `/api/auth/siwe/nonce`      | GET      | Get a SIWE nonce                      |
| `/api/auth/siwe/verify`     | POST     | Verify SIWE signature, create session |
| `/api/auth/session`         | GET      | Get current session                   |
| `/api/auth/session`         | DELETE   | Logout / destroy session              |
| `/api/auth/privy/[handler]` | GET/POST | Privy OAuth handlers                  |
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

Paginated search over ERC-8004 registered agents. No auth required.

**Query parameters**

| Parameter | Type    | Description                                     |
| --------- | ------- | ----------------------------------------------- |
| `q`       | string  | Full-text search query                          |
| `only3d`  | `1`     | Filter to agents with 3D avatars only           |
| `chain`   | integer | Filter by chain ID                              |
| `cursor`  | string  | ISO 8601 timestamp cursor for keyset pagination |
| `limit`   | integer | Max results (default: 20)                       |

**Response**

```json
{
	"agents": [
		{
			"id": "onchain_abc",
			"name": "Aria",
			"description": "Product guide",
			"avatar_url": "https://cdn.example.com/aria.glb",
			"thumbnail_url": "https://cdn.example.com/aria.png",
			"chain_id": 8453,
			"chain_agent_id": 42,
			"registered_at": "2025-01-15T10:00:00Z",
			"services": [],
			"explorer_url": "https://basescan.org/..."
		}
	],
	"total": 142,
	"total_3d": 89,
	"cursor": "2025-01-10T10:00:00Z"
}
```

---

### Featured agents

```
GET /api/showcase
```

Public directory of ERC-8004 agents with 3D avatars, for homepage and gallery use. CDN-cached (`max-age=60`, `s-maxage=60`, `stale-while-revalidate=300`). No auth required.

**Query parameters**

| Parameter | Type    | Description                                                        |
| --------- | ------- | ------------------------------------------------------------------ |
| `net`     | string  | `mainnet`, `testnet`, or `all` (default: `all`)                    |
| `sort`    | string  | `newest` or `oldest`                                               |
| `chain`   | integer | Filter by chain ID                                                 |
| `limit`   | integer | Max results (default: 20)                                          |
| `cursor`  | string  | Keyset pagination cursor (`registered_at,chain_id,agent_id` tuple) |

**Response:** Same shape as `/api/explore`. Cursor encodes the full keyset tuple for stable pagination under concurrent inserts.

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

## ERC-8004 API

### Resolve on-chain agent

```
GET /api/erc8004/:chainId/:agentId
```

Resolves an on-chain ERC-8004 agent by chain ID and agent ID, returning its full manifest JSON. No auth required.

**Example**

```
GET /api/erc8004/8453/42
```

**Response:** Full agent manifest JSON as registered on-chain.

Returns `400 CHAIN_NOT_SUPPORTED` if `chainId` is not in the platform's supported chain list.

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

**Authentication:** Bearer OAuth access token or API key.

**POST** — send JSON-RPC 2.0 requests. Batch requests supported (max 32 per request).

**GET** — SSE notification stream (reserved for future use).

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

### Related news

```
GET /api/coin/news?q=<coin name>&limit=8
```

Returns `{ "articles": [{ title, link, description, image, source,
published_at }], "source": "three.ws" }`. Served by the native three.ws
aggregator (`api/_lib/news.js` — 38 publisher feeds, per-source 5-minute cache
with serve-stale-on-error).

---

## Crypto News API

The engine behind [/markets/news](https://three.ws/markets/news) and
[/markets/archive](https://three.ws/markets/archive). Free, key-less, CORS `*`.

### Live feed

```
GET /api/news/feed?category=defi&q=etf&source=coindesk&limit=30&offset=0&meta=1
```

Aggregates 38 publisher RSS/Atom feeds natively (registry:
`api/_lib/news-sources.js`). All params optional: `category` (one of the 14
canonical categories — `general`, `bitcoin`, `ethereum`, `solana`,
`defi`, `nft`, `trading`, `research`, `onchain`, `institutional`,
`mainstream`, `asia`, `regulation`, `journalism`), `source` (a single source
key, overrides `category`), `q` (full-text over title/description/tickers),
`limit` ≤ 50, `offset`. Returns
`{ articles: [{ id, title, link, description, image, author, source,
source_key, category, pub_date, tickers[], sentiment: { score, label,
confidence } }], total, sources_ok, sources_total, fetched_at }`; with
`meta=1` it also returns `categories[]` and the `sources[]` registry. Each
source is cached server-side for 5 minutes and served stale (up to 24 h) if
its publisher goes down. CDN cache 120 s.

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
`{ url, title, source, image, author, published_at, description, extraction,
paragraphs[], content_chars, tickers[], summary, key_points[], sentiment
("bullish"|"bearish"|"neutral"), analysis_provider, related[], fetched_at }`.
`extraction` tells you where the text came from: `"page"` (publisher page),
`"feed"` (the publisher's own `content:encoded` feed body — used when the
page blocks server fetches), or `"preview"` (metadata only; `blocked_reason`
set). `analysis_provider` is `groq`/`openrouter` when the platform LLM chain
is configured, else `heuristic` (extractive summary + lexicon sentiment —
always available). Cached 30 min per URL.

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
(aggregator)`. Adding a provider directory in the repo: [`api/v1/README.md`](../api/v1/README.md).

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
			"url": "https://cdn.three.ws/animations/library/clips/mx-hip-hop-dancing.json"
		}
	],
	"total": 2400,
	"generated_at": "2026-07-04T00:00:00.000Z"
}
```

Returns `{ "clips": [], "total": 0 }` until the library has been published, so clients can feature-detect by emptiness. The curated starter set remains separately available as static JSON at `/animations/manifest.json`.

---

## Config API

```
GET /api/config
```

Returns public platform configuration. No auth required. CORS open.

**Response**

```json
{
	"walletConnectProjectId": "..."
}
```

---

## Pagination

All list endpoints use offset pagination unless noted otherwise.

```
GET /api/agents?limit=20&offset=40
```

Responses always include `total`, `limit`, and `offset`.

`/api/explore` and `/api/showcase` use keyset (cursor-based) pagination for stability — pass the returned `cursor` value as the `cursor` query parameter on the next request.

---

## Error codes

| Code                  | HTTP Status | Description                                  |
| --------------------- | ----------- | -------------------------------------------- |
| `UNAUTHORIZED`        | 401         | Missing or invalid auth                      |
| `FORBIDDEN`           | 403         | Authenticated but not allowed                |
| `NOT_FOUND`           | 404         | Resource doesn't exist                       |
| `RATE_LIMITED`        | 429         | Too many requests                            |
| `INVALID_INPUT`       | 400         | Request body validation failed               |
| `AGENT_NOT_FOUND`     | 404         | Agent ID not found                           |
| `WIDGET_NOT_FOUND`    | 404         | Widget ID not found                          |
| `CHAIN_NOT_SUPPORTED` | 400         | chainId not in supported list                |
| `IPFS_FAILED`         | 503         | IPFS pinning service unavailable             |
| `LLM_ERROR`           | 502         | LLM provider returned an error               |
| `TTS_LIMIT_EXCEEDED`  | 429         | Character limit for TTS exceeded             |
| `QUOTA_EXCEEDED`      | 429         | Agent's monthly token budget exhausted       |
| `EMBED_POLICY_DENIED` | 403         | Request origin blocked by agent embed policy |

---

## SDK

Use the official SDK instead of raw HTTP calls:

```js
import { AgentAPI } from '@three-ws/sdk';

const api = new AgentAPI({ apiKey: 'sk_live_xxxxx' });

const agents = await api.agents.list({ limit: 10 });
const agent = await api.agents.get('abc123');
const widget = await api.widgets.create({
	agentId: 'abc123',
	type: 'turntable',
	config: { auto_rotate_speed: 0.5, preset: 'venice' },
});
```

The SDK handles auth headers, retries on 429, and TypeScript types for all request/response shapes.
