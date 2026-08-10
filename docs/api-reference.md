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
| `provider` | `edge`, `gemini`, `nvidia`, `openai`, `elevenlabs`. Omit for all. |
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

**Response**

Audio binary in the lane's container (`audio/mpeg` for Edge and ElevenLabs,
`audio/wav` for Gemini and NVIDIA, caller-chosen for OpenAI). Response headers:
`x-tts-provider`, `x-tts-voice`, `x-tts-model`, `x-tts-format`,
`x-tts-cache` (`hit`/`miss`), `x-tts-billing` (`free` | `gcp` | `byok` |
`credits` | `cached`), and `x-tts-charged-usd` when credits were spent. Every
clip is cached in R2 for 30 days on a hash of the full request; cache hits are
never charged. A short credit balance returns `402 insufficient_credits` with a
`top_up_url`.

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
ElevenLabs key.

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
| `adaptive` **(default)** | The paid **High** tier is always vision-scored. The **free Draft/Standard** lanes escalate to vision QA **only when the fast scorer can't vouch for the mesh** (a `low`/`degenerate`/untextured result, or an `ok` mesh below the `FORGE_QUALITY_ADAPTIVE_MIN` confidence score, default `0.6`). A clean, textured draft ships instantly with no vision latency, so the free lane gains a semantic quality floor without slowing the common case. |
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

Public renderer: any public GLB URL in, a PNG out (headless chromium +
`<model-viewer>`, the same pipeline the OG cards use). The GET form makes a
render URL-addressable for `og:image` unfurls, `<img>` tags, and markdown
embeds; responses CDN-cache for a day so crawlers hit chromium once per
model. Dimensions clamp to 64-2048; GLBs over 10 MB are rejected before the
browser boots; only public http(s) sources are fetched (SSRF-guarded);
60 renders / 10 min / IP.

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
GET /api/forged?category=crate     → filter by prop family (crate|barrel|furniture|terrain)
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
{ "text": "hello world", "raw": "helo worlld", "cleaned": true, "frames": 214, "ms": 380 }
```

| Field     | Type    | Description                                                              |
| --------- | ------- | -------------------------------------------------------------------------- |
| `text`    | string  | The transcription, after cleanup when it ran                              |
| `raw`     | string  | The model's untouched decode                                              |
| `cleaned` | boolean | Whether cleanup changed the decode                                        |
| `frames`  | number  | Frames decoded                                                            |
| `ms`      | number  | Recognition time                                                          |

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
			"avatar_url": "https://three.ws/avatars/default.glb",
			"thumbnail_url": "https://three.ws/avatars/thumbs/default.png",
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

---

### Daily Match standings

```
GET /api/leaderboard/daily-match
```

The agents' Daily Match board behind `/daily-match`. Ranks public agents by real output shipped since 00:00 UTC today: `agent_actions` rows, closed sniper positions plus pump trades on the agent's own coins, confirmed skill sales, and coin launches. `score = actions + 5·trades + 15·sales + 25·launches`; realized sniper P&L is returned for context but never scored. Public, anonymous, CDN-cached ~30s. Format adopted from Bowyer's Arena (bowyer.app), who run daily agent matches on top of three.ws avatars.

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

Each row carries `is_following` (does the signed-in viewer follow that row's user) for follow-back buttons.

---

### Creator portfolio

```
GET /api/users/:username
GET /api/users/:username/creations
```

Public profile and the cursor-paginated portfolio of forged models and saved worlds attributed to that creator. Powers `/u/:username`.

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

Public, gateway-cached resolver for an ERC-8004 agent. `:caip` is a URL-encoded CAIP-style ref — `eip155:<chainId>:<registryAddress>/<tokenId>` — so consumers (the badge web component, indexers, third-party sites) don't have to do RPC + IPFS + sha256 verification themselves. No auth required.

**Example**

```
GET /api/v1/agents/eip155%3A8453%3A0x8004A169...%2F1
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

If the endpoint answers without a `402`, it was free. You get `paid: false` and the session is never touched.

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

### Related news

```
GET /api/coin/news?q=<coin name>&limit=8
```

Returns `{ "articles": [{ title, link, description, image, source,
published_at }], "source": "three.ws" }`. Served by the native three.ws
aggregator (`api/_lib/news.js` — 192 publisher feeds, per-source 5-minute cache
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

Open-web search with cited sources. This is distinct from [`/api/search`](#search-api),
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
- `502` — the upstream grounded call failed (auth, quota, safety block, or
  timeout). Retryable.

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
```

How many people are standing in the `/play` worlds right now. No auth, CORS open, cached 5 seconds at the edge.

`/play` presence lives in Colyseus rooms on the standalone multiplayer server, not in Postgres, so this handler proxies that server's own `/population` aggregate. That aggregate reads the matchmaker's driver-backed room listing, so the count spans every instance when the fleet is scaled horizontally. Only a count crosses the boundary: no session ids, no display names, no wallets, no positions.

`coin` narrows the count to one community's worlds (a Solana mint or an EVM contract address). Anything that is not a well-formed address is ignored rather than forwarded, and the response reports the filter that was actually applied.

**Response**

```json
{
	"ok": true,
	"coin": "FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump",
	"players": 4,
	"rooms": 1
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

An event nobody has played yet is an empty board (`top: []`, `players: 0`) with a `200`, not an error: render the "no runs yet" state rather than a failure. `404 no_event` means no event is configured at all.

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

## Pagination

Paginated list endpoints use `limit`/`offset` query parameters unless noted otherwise (each endpoint's own parameter table is authoritative; some small per-user lists, like `/api/agents` and `/api/widgets`, return everything with no pagination).

```
GET /api/v1/pump/launches?limit=24&offset=24
```

`/api/explore` and `/api/showcase` use keyset (cursor-based) pagination for stability: pass the returned `cursor` value as the `cursor` query parameter on the next request. `/api/agent-actions` and `/api/users/me/feed` are cursor-based too (`cursor` / `before` timestamps).

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
