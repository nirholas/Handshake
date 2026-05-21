# API Reference

Base URL: `https://three.ws/api`

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

| Tier | Limit |
|------|-------|
| Authenticated | 100 req/min |
| Unauthenticated | 20 req/min |

Rate-limited responses return HTTP 429 with `{ "error": "...", "code": "RATE_LIMITED" }`.

---

## Agents API

### List agents

```
GET /api/agents
```

Returns the authenticated user's agents. Requires auth.

**Query parameters**

| Parameter | Type | Description |
|-----------|------|-------------|
| `limit` | integer | Max results (default: 20) |
| `offset` | integer | Pagination offset (default: 0) |

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
  "manifest": { }
}
```

**Response**

```json
{
  "id": "new-agent-id",
  "agent": { }
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

| Parameter | Type | Description |
|-----------|------|-------------|
| `limit` | integer | Max results (default: 20) |
| `offset` | integer | Pagination offset (default: 0) |
| `type` | string | Filter by widget type |
| `agent_id` | string | Filter by agent ID |

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
      "avatar": { }
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

| Parameter | Type | Description |
|-----------|------|-------------|
| `agent_id` | string | Required. Filter by agent ID |
| `limit` | integer | Max results (default: 20) |
| `cursor` | string | Cursor for keyset pagination |

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

| Parameter | Type | Description |
|-----------|------|-------------|
| `agentId` | string | Required. The agent's ID |
| `type` | string | Filter by memory type: `user`, `feedback`, `project`, `reference` |
| `since` | string | ISO 8601 timestamp — return only memories updated after this time |
| `limit` | integer | Max results (default: 50) |

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
  "messages": [
    { "role": "user", "content": "What animations do you have?" }
  ],
  "context": {
    "model_name": "avatar.glb",
    "animations": ["wave", "idle", "dance"],
    "settings": { }
  }
}
```

The `context` object is included in the system prompt so the model knows what's loaded in the viewer.

**Available action tools**

The LLM can invoke these viewer actions in its response:

| Tool | Description |
|------|-------------|
| `setWireframe` | Toggle wireframe mode |
| `setSkeleton` | Toggle skeleton overlay |
| `setGrid` | Toggle ground grid |
| `setAutoRotate` | Start/stop auto-rotation |
| `setBgColor` | Set background color |
| `setTransparentBg` | Toggle transparent background |
| `setEnvironment` | Set environment map |
| `takeScreenshot` | Capture viewport screenshot |
| `loadModel` | Load a different model URL |
| `runValidation` | Run glTF validation |
| `showMaterialEditor` | Open material editor UI |

**Response (streaming SSE)**

```
data: {"type": "content", "text": "I have three animations..."}
data: {"type": "tool_call", "name": "play_clip", "args": {"name": "wave"}}
data: {"type": "done"}
```

Usage events (token counts, latency, triggered actions) are recorded after each request.

---

### We-pay LLM proxy

```
POST /api/llm/anthropic?agent=<agent_id>
```

"We-pay" proxy. Enforces the agent's embed policy (allowed origins, allowed surfaces, brain mode) and deducts from the agent's monthly token budget. The request body is always Anthropic-shape; the server inspects `model` and routes to Anthropic, Groq, or OpenRouter, translating wire formats both ways so the response stream is also Anthropic-shape.

Requires that the calling origin is listed in the agent's declared `origins`. Wildcard patterns are supported.

**Supported models**

| Model ID | Upstream | Cost |
|----------|----------|------|
| `meta-llama/llama-3.3-70b-instruct:free` | OpenRouter | free (default) |
| `openai/gpt-oss-120b:free` | OpenRouter | free |
| `nousresearch/hermes-3-llama-3.1-405b:free` | OpenRouter | free |
| `llama-3.3-70b-versatile` | Groq | free, sub-second |
| `llama-3.1-8b-instant` | Groq | free, fastest |
| `claude-haiku-4-5-20251001` | Anthropic | paid |
| `claude-sonnet-4-6` | Anthropic | paid |
| `claude-opus-4-6` | Anthropic | paid |
| `claude-opus-4-7` | Anthropic | paid |

Request and response format match the [Anthropic Messages API](https://docs.anthropic.com/en/api/messages) exactly. Free-model routes are translated server-side. Upstream errors are sanitized before being returned to the client.

**Rate limits:** Per-IP and per-agent limits apply in addition to the standard platform limits.

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

## Authentication API

Authentication is covered in detail in the [Authentication documentation](authentication.md). Quick reference:

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/auth/siwe/nonce` | GET | Get a SIWE nonce |
| `/api/auth/siwe/verify` | POST | Verify SIWE signature, create session |
| `/api/auth/session` | GET | Get current session |
| `/api/auth/session` | DELETE | Logout / destroy session |
| `/api/auth/privy/[handler]` | GET/POST | Privy OAuth handlers |
| `/api/auth/wallets` | GET | List wallets linked to current user |
| `/api/auth/wallets` | POST | Link a new wallet |

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

| Scope | Description |
|-------|-------------|
| `avatars:read` | Read agents and avatars |
| `avatars:write` | Create and update agents and avatars |
| `avatars:delete` | Delete agents and avatars |
| `profile` | Read user profile data |

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

| Parameter | Type | Description |
|-----------|------|-------------|
| `q` | string | Full-text search query |
| `only3d` | `1` | Filter to agents with 3D avatars only |
| `chain` | integer | Filter by chain ID |
| `cursor` | string | ISO 8601 timestamp cursor for keyset pagination |
| `limit` | integer | Max results (default: 20) |

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

| Parameter | Type | Description |
|-----------|------|-------------|
| `net` | string | `mainnet`, `testnet`, or `all` (default: `all`) |
| `sort` | string | `newest` or `oldest` |
| `chain` | integer | Filter by chain ID |
| `limit` | integer | Max results (default: 20) |
| `cursor` | string | Keyset pagination cursor (`registered_at,chain_id,agent_id` tuple) |

**Response:** Same shape as `/api/explore`. Cursor encodes the full keyset tuple for stable pagination under concurrent inserts.

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

| Tool | Scope required | Description |
|------|---------------|-------------|
| `list_my_avatars` | `avatars:read` | List authenticated user's avatars |
| `get_avatar` | `avatars:read` | Fetch single avatar by ID or owner+slug |
| `search_public_avatars` | none | Search the public avatar gallery |
| `render_avatar` | `avatars:read` | Generate `<model-viewer>` HTML embed |
| `delete_avatar` | `avatars:delete` | Soft-delete an avatar |
| `validate_model` | none | Run Khronos glTF-Validator on a remote URL |
| `inspect_model` | none | Parse GLB/glTF and return structural stats |
| `optimize_model` | none | Return optimization suggestions for a model |

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

| Code | HTTP Status | Description |
|------|-------------|-------------|
| `UNAUTHORIZED` | 401 | Missing or invalid auth |
| `FORBIDDEN` | 403 | Authenticated but not allowed |
| `NOT_FOUND` | 404 | Resource doesn't exist |
| `RATE_LIMITED` | 429 | Too many requests |
| `INVALID_INPUT` | 400 | Request body validation failed |
| `AGENT_NOT_FOUND` | 404 | Agent ID not found |
| `WIDGET_NOT_FOUND` | 404 | Widget ID not found |
| `CHAIN_NOT_SUPPORTED` | 400 | chainId not in supported list |
| `IPFS_FAILED` | 503 | IPFS pinning service unavailable |
| `LLM_ERROR` | 502 | LLM provider returned an error |
| `TTS_LIMIT_EXCEEDED` | 429 | Character limit for TTS exceeded |
| `QUOTA_EXCEEDED` | 429 | Agent's monthly token budget exhausted |
| `EMBED_POLICY_DENIED` | 403 | Request origin blocked by agent embed policy |

---

## SDK

Use the official SDK instead of raw HTTP calls:

```js
import { AgentAPI } from '@3dagent/sdk';

const api = new AgentAPI({ apiKey: 'sk_live_xxxxx' });

const agents = await api.agents.list({ limit: 10 });
const agent  = await api.agents.get('abc123');
const widget = await api.widgets.create({
  agentId: 'abc123',
  type: 'turntable',
  config: { auto_rotate_speed: 0.5, preset: 'venice' }
});
```

The SDK handles auth headers, retries on 429, and TypeScript types for all request/response shapes.
