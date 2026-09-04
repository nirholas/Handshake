# Developer Platform

Everything you need to build against three.ws programmatically: API keys for
machine access, usage metrics for your account, webhooks that push avatar and
agent events to your server, a one-call MCP connection test, and two public
discovery endpoints (the MCP tool catalog and the agent skills manifest).

The browser UI for all of this lives in the dashboard:

- **`/dashboard/api`**: create, list, and revoke API keys, and run the MCP
  "Test connection" button (source: `src/dashboard-next/pages/api.js`).
- **`/dashboard/developers`**: the Developer Hub with webhooks and the usage
  overview (source: `src/dashboard-next/pages/developers.js`).

Base URL: `https://three.ws`

Related docs: [MCP integration](./mcp.md), [API reference](./api-reference.md),
[Authentication](./authentication.md), [x402 developer tools](./x402-dev-tools.md).

---

## Authentication model

The management endpoints on this page (`/api/keys`, `/api/developer/*`) are
**session-authenticated**: they manage your credentials, so they require your
browser session cookie (`__Host-sid`), not an API key. Unauthenticated calls
get `401 unauthorized`.

State-changing calls (POST, PATCH, DELETE) additionally require a CSRF token:

1. `GET /api/csrf-token` (with your session cookie) returns
   `{ "token": "...", "expires_in": 3600 }`.
2. Echo it in the `X-CSRF-Token` header on the mutating request.

Tokens are **single-use** and expire after 1 hour, so fetch a fresh one per
mutation. A missing header fails with `403 csrf_missing`; a consumed or expired
token fails with `403 csrf_invalid`.

All errors use one envelope:

```json
{ "error": "code", "error_description": "human-readable message" }
```

Validation failures add an `issues` array (path, code, message per field).
Rate-limit rejections are `429 rate_limited` with a `retry_after` field and a
`Retry-After` header.

The two discovery endpoints at the bottom of this page
(`/api/tool_schema`, `/api/skills-manifest`) are fully public: no cookie, no
key, no CSRF.

---

## API keys

API keys are bearer credentials for machine clients: the MCP server at
`/api/mcp` (see [MCP integration](./mcp.md)) and the account-scoped REST
endpoints that accept `Authorization: Bearer` (see the
[API reference](./api-reference.md)). Each key carries a set of scopes:

`avatars:read`, `avatars:write`, `avatars:delete`, `profile`, `memory:read`,
`memory:write`, `agents:read`, `agents:write`

One more scope, `herald:announce` (posting through the
[Herald](./herald.md)), is accepted by `/api/keys`, the dashboard form, and the
older `POST /api/api-keys` route documented in
[Authentication](./authentication.md#available-scopes).

Keys are stored as a SHA-256 hash. The plaintext secret is returned **exactly
once**, in the create response. Only the 12-character prefix is kept for
display.

Each key-management route has its own rate limit bucket, per user, so that one
cannot starve another: minting is **30 per hour**, listing is **120 per
minute** (the dashboard lists on every load and after every mutation), and
revoking is **60 per hour** (killing a leaked key must never be blocked by a
spent mint budget).

### POST /api/keys

Create a key. Session + CSRF required.

Request body:

| Field | Type | Required | Notes |
|---|---|---|---|
| `name` | string | yes | 1 to 80 characters, trimmed |
| `scope` | string | no | space-separated scopes; default `avatars:read avatars:write` |
| `expires_in_days` | integer | no | positive, max 3650; omitted = never expires |
| `environment` | `"live"` or `"test"` | no | default `"live"`; selects the key prefix |

The secret has the form `sk_live_...` or `sk_test_...` (prefix plus 38
base64url characters).

```bash
SID='<your __Host-sid session cookie value>'
CSRF=$(curl -s https://three.ws/api/csrf-token -b "__Host-sid=$SID" | jq -r .token)

curl -s https://three.ws/api/keys \
  -b "__Host-sid=$SID" \
  -H "x-csrf-token: $CSRF" \
  -H 'content-type: application/json' \
  -d '{"name":"CI renderer","scope":"avatars:read agents:read","expires_in_days":90}'
```

Response, `201`:

```json
{
  "key": {
    "id": "…",
    "name": "CI renderer",
    "prefix": "sk_live_Ab12",
    "scope": "avatars:read agents:read",
    "expires_at": "2026-10-28T00:00:00.000Z",
    "created_at": "2026-07-30T00:00:00.000Z",
    "secret": "sk_live_…"
  }
}
```

Store `secret` now; it is never returned again.

Repeated scopes are stored once. Sending `scope` as an empty or whitespace-only
string is rejected rather than defaulted: it would mint a key that grants
nothing. Omit the field entirely to take the default.

Errors: `401 unauthorized`, `403 csrf_missing` / `csrf_invalid`,
`400 validation_error` (zod issues, `unknown scopes: <list>` for a scope
outside the allowed set, or `scope must name at least one permission`),
`429 rate_limited`.

### GET /api/keys

List your keys, newest first. Session required, no CSRF. Includes revoked and
expired keys so the dashboard can show history; the secret is never present.

```bash
curl -s https://three.ws/api/keys -b "__Host-sid=$SID"
```

Response, `200`:

```json
{
  "keys": [
    {
      "id": "…",
      "name": "CI renderer",
      "prefix": "sk_live_Ab12",
      "scope": "avatars:read agents:read",
      "last_used_at": null,
      "expires_at": "2026-10-28T00:00:00.000Z",
      "revoked_at": null,
      "created_at": "2026-07-30T00:00:00.000Z"
    }
  ]
}
```

### DELETE /api/keys/:id

Revoke a key (sets `revoked_at`; the row is kept). Session + CSRF required.
The revocation is written to the audit log as `revoke_api_key`.

```bash
CSRF=$(curl -s https://three.ws/api/csrf-token -b "__Host-sid=$SID" | jq -r .token)

curl -s -X DELETE "https://three.ws/api/keys/$KEY_ID" \
  -b "__Host-sid=$SID" \
  -H "x-csrf-token: $CSRF"
```

Response, `200`: `{ "ok": true }`

Errors: `400 invalid_id` when `:id` is not a UUID, `401 unauthorized`,
`403 csrf_missing` / `csrf_invalid`, `404 not_found` when the key does not
exist, belongs to someone else, or is already revoked, `429 rate_limited`.

---

## Usage metrics

### GET /api/developer/usage

Aggregated activity for your account over a lookback window, built from the
audit log, webhook deliveries, and settled x402 checkout calls against the SKUs
you own. Session required.

Query parameters:

| Param | Values | Default |
|---|---|---|
| `days` | `7`, `30`, `90` | `30` (any other value silently falls back to 30) |

```bash
curl -s 'https://three.ws/api/developer/usage?days=7' -b "__Host-sid=$SID"
```

Response, `200`:

```json
{
  "period": { "days": 7, "since": "2026-07-23T00:00:00.000Z" },
  "api_keys": { "total_keys": 3, "active_keys": 2 },
  "requests": {
    "total": 412,
    "unique_actions": 9,
    "errors": 3,
    "error_rate": 0.73,
    "first_at": "2026-07-23T08:11:00.000Z",
    "last_at": "2026-07-29T21:04:00.000Z"
  },
  "timeseries": [ { "day": "2026-07-23", "requests": 61 } ],
  "top_actions": [ { "action": "avatar.render", "count": 118 } ],
  "webhooks": { "total_deliveries": 24, "succeeded": 23, "failed": 1 },
  "x402": { "payments": 5, "volume_usdc": 1.25, "volume_atomics": "1250000" },
  "degraded": []
}
```

Field notes, exactly as computed:

- `requests` counts your audit-log rows in the window; `errors` counts actions
  matching `%.error%` or `%fail%`; `error_rate` is a percentage rounded to two
  decimals (0 when there are no requests).
- `timeseries` is one row per day with activity (days with zero requests are
  absent).
- `top_actions` is the top 10 actions by count.
- `webhooks.succeeded` counts deliveries with a 2xx status; `failed` counts
  null status (network failure) or status >= 400.
- `x402.payments` counts settled checkout calls (`response_status < 400`)
  against the SKUs you own, over the same window. `volume_atomics` is their
  gross in USDC atomic units as a string; `volume_usdc` is the same figure in
  whole USDC.
- Each aggregate degrades independently to zeros or an empty array if its
  source query fails, so the endpoint never 500s over one missing table. When
  that happens the section names itself in `degraded` (`["x402"]`,
  `["timeseries"]`, …) so you can tell "no activity" from "unavailable".
  `degraded` is `[]` on a healthy response.

Errors: `401 unauthorized`.

---

## Webhooks

Register HTTPS endpoints and three.ws POSTs you events when your avatars and
agents change. Up to **10 webhooks per account**.

Event types:

- `avatar.created`
- `avatar.updated`
- `avatar.deleted`
- `avatar.appearance.changed`
- `agent.created`
- `agent.updated`
- `agent.deleted`
- `forge.completed`
- `forge.failed`

### Generation job events

A forge generation is asynchronous and outlives the request that started it: you
submit to `POST /api/forge`, get a `job_id` back, and the platform finishes the
job even if the caller disconnects (see
[forge-background-generation.md](./forge-background-generation.md)). Without a
push, the only way to learn the outcome is to keep polling
`GET /api/forge?job=<job_id>`. These two events replace that poll loop.

They are scoped to your account, so they fire for generations made while signed
in (a session cookie or a bearer token on the submit). Anonymous browser
generations have no account to deliver to.

`forge.completed` fires from the single completion writer every generation lane
flows through, which makes it exactly-once per job and independent of how the
job finished: the free lane, a paid x402 call, or the unattended finalizer that
picks up an abandoned job all deliver the same event.

```json
{
  "id": "3f2b9c40-1a77-4d2e-9c31-8a0e5b7d41aa",
  "status": "done",
  "prompt": "a small wooden toy boat with a striped sail",
  "glb_url": "https://three.ws/cdn/forge/<client>/<id>.glb",
  "preview_image_url": "https://three.ws/cdn/forge/<client>/<id>.webp",
  "backend": "trellis_selfhost",
  "tier": "draft",
  "path": "image",
  "size_bytes": 1638400,
  "latency_ms": 150000
}
```

`forge.failed` fires only when a job is genuinely dead. A generation that fails
on one lane and is automatically redispatched to another is **not** reported
here: the platform is still working on it, and you get `forge.completed` if the
retry lands. That is why a failure event can arrive several minutes after the
lane error itself.

```json
{
  "id": "3f2b9c40-1a77-4d2e-9c31-8a0e5b7d41aa",
  "status": "failed",
  "prompt": "a small wooden toy boat with a striped sail",
  "error": "generation timed out after 45 minutes",
  "backend": "trellis_selfhost",
  "tier": "draft"
}
```

Subscribe to just these two and submit a job:

```bash
# 1. register the receiver
curl -s https://three.ws/api/developer/webhooks \
  -b "__Host-sid=$SID" -H "x-csrf-token: $CSRF" \
  -H 'content-type: application/json' \
  -d '{"url":"https://example.com/hooks/forge","events":["forge.completed","forge.failed"],"description":"generation results"}'

# 2. submit a generation; the response returns immediately with a job_id
curl -s https://three.ws/api/forge \
  -b "__Host-sid=$SID" \
  -H 'content-type: application/json' \
  -d '{"prompt":"a small wooden toy boat with a striped sail","tier":"draft"}'
```

Verify the signature exactly as for every other event (see
[Delivery format and signature verification](#delivery-format-and-signature-verification));
the `forge.*` payloads carry no separate signing scheme.

### GET /api/developer/webhooks

List your webhooks, newest first, each with 7-day delivery stats. Session
required.

```bash
curl -s https://three.ws/api/developer/webhooks -b "__Host-sid=$SID"
```

Response, `200`:

```json
{
  "webhooks": [
    {
      "id": "…",
      "url": "https://example.com/hooks/threews",
      "events": ["avatar.created"],
      "active": true,
      "description": "prod receiver",
      "created_at": "2026-07-01T00:00:00.000Z",
      "updated_at": "2026-07-01T00:00:00.000Z",
      "stats_7d": { "total": 24, "succeeded": 23, "failed": 1, "last_delivery_at": "2026-07-29T20:00:00.000Z" }
    }
  ],
  "event_types": ["avatar.created", "avatar.updated", "avatar.deleted", "avatar.appearance.changed", "agent.created", "agent.updated", "agent.deleted", "forge.completed", "forge.failed"]
}
```

### POST /api/developer/webhooks

Create a webhook. Session + CSRF required.

Request body:

| Field | Type | Required | Notes |
|---|---|---|---|
| `url` | string | yes | HTTPS only, max 2048 characters, must resolve to a public address |
| `events` | string[] | no | empty or omitted = **all events**; an unknown event type is rejected, it is never silently dropped |
| `description` | string | no | trimmed, truncated to 200 characters |

The URL is checked against SSRF at registration time: a hostname that resolves
to a private, loopback, link-local, or cloud-metadata address is rejected with
`400 bad_request` ("Webhook URL must resolve to a public address"). Delivery
re-validates and pins the connection on every attempt, so a DNS record that
later flips to an internal address still cannot be reached.

```bash
CSRF=$(curl -s https://three.ws/api/csrf-token -b "__Host-sid=$SID" | jq -r .token)

curl -s https://three.ws/api/developer/webhooks \
  -b "__Host-sid=$SID" \
  -H "x-csrf-token: $CSRF" \
  -H 'content-type: application/json' \
  -d '{"url":"https://example.com/hooks/threews","events":["avatar.created","agent.created"],"description":"prod receiver"}'
```

Response, `201`:

```json
{
  "webhook": {
    "id": "…",
    "url": "https://example.com/hooks/threews",
    "events": ["avatar.created", "agent.created"],
    "active": true,
    "description": "prod receiver",
    "created_at": "2026-07-30T00:00:00.000Z",
    "secret": "whsec_…"
  }
}
```

`secret` (`whsec_` plus 32 base64url characters) is returned **only here**.
Store it; you need it to verify signatures.

Errors: `400 bad_request` (missing/invalid/too-long/non-HTTPS/non-public URL,
an unknown or non-array `events` value, malformed JSON, or a non-JSON content
type), `409 limit_reached` at 10 webhooks, `401`, `403` (CSRF).

### GET /api/developer/webhooks/:id

Webhook details plus its 50 most recent delivery attempts. Session required.

```bash
curl -s "https://three.ws/api/developer/webhooks/$WEBHOOK_ID" -b "__Host-sid=$SID"
```

Response, `200`: `{ "webhook": { … }, "deliveries": [ … ] }` where each
delivery is
`{ id, event_type, event_id, status_code, error, attempt, created_at }`.

### PATCH /api/developer/webhooks/:id

Partial update. Session + CSRF required. Any subset of:

- `url` (same HTTPS, length, and SSRF validation as create)
- `events` (replaces the array; same validation as create, so an unknown type is
  a `400` and an empty array resets the webhook to all events)
- `active` (boolean; pause or resume delivery)
- `description`

A body with no recognized fields is a no-op that returns the current webhook.
Response, `200`: `{ "webhook": { … } }` with `updated_at` refreshed.

### DELETE /api/developer/webhooks/:id

Delete the webhook and stop all delivery. Session + CSRF required.
Response, `200`: `{ "deleted": true }`.

Errors for all three `:id` routes: `404 not_found` when the ID does not exist,
is not yours, or is not a well-formed UUID; `400 bad_request` when the ID is
missing.

### Delivery format and signature verification

Deliveries are `POST` requests in the
[Standard Webhooks](https://www.standardwebhooks.com) format:

| Header | Value |
|---|---|
| `content-type` | `application/json` |
| `webhook-id` | unique event ID (`evt_…`), stable across retries |
| `webhook-timestamp` | unix epoch seconds |
| `webhook-signature` | `v1,{base64url HMAC-SHA256}` |
| `user-agent` | `three.ws-webhooks/1.0` |

Body:

```json
{
  "id": "evt_…",
  "type": "avatar.created",
  "created_at": "2026-07-30T00:00:00.000Z",
  "data": { }
}
```

The signature is HMAC-SHA256 over `` `${id}.${timestamp}.${rawBody}` `` keyed
with your `whsec_` secret, encoded as unpadded base64url. Verify it against the
**raw** request body, before any JSON parsing:

```js
import { createHmac, timingSafeEqual } from 'node:crypto';

function verifyWebhook(secret, headers, rawBody) {
  const msg = `${headers['webhook-id']}.${headers['webhook-timestamp']}.${rawBody}`;
  const expected = createHmac('sha256', secret).update(msg).digest('base64url');
  const received = String(headers['webhook-signature'] || '').replace(/^v1,/, '');
  const a = Buffer.from(expected);
  const b = Buffer.from(received);
  return a.length === b.length && timingSafeEqual(a, b);
}
```

Delivery behavior, exactly as implemented:

- Up to **3 attempts** with exponential backoff, 10-second timeout per attempt.
- Redirects are **not followed**; a 3xx is recorded as a failure
  (`redirect_not_followed`).
- Response bodies are stored truncated to 1024 characters for the deliveries
  view.
- A 2xx from your server ends the retry loop; anything else (including network
  errors) retries.
- A webhook that accumulates **50 failed deliveries within 24 hours** is
  automatically set `active: false`. Fix your endpoint, then re-enable it with
  `PATCH { "active": true }`.

---

## MCP connection test

### POST /api/developer/mcp-test

Runs the real MCP `initialize` then `tools/list` handshake against the server
at `/api/mcp`, authenticated as one of your API keys. This is what the "Test
connection" button on `/dashboard/api` calls. The selected key is validated
exactly as the bearer path validates it (owned by you, not revoked, not
expired) and the handshake is dispatched with that key's real scope, so the
result reflects what an MCP client carrying that key would see.

Session + CSRF required. Rate limit: 1200 requests per minute per user (the
shared MCP transport bucket).

Request body: `{ "keyId": "<id from GET /api/keys>" }`

```bash
CSRF=$(curl -s https://three.ws/api/csrf-token -b "__Host-sid=$SID" | jq -r .token)

curl -s https://three.ws/api/developer/mcp-test \
  -b "__Host-sid=$SID" \
  -H "x-csrf-token: $CSRF" \
  -H 'content-type: application/json' \
  -d "{\"keyId\":\"$KEY_ID\"}"
```

Response, `200` on a successful handshake:

```json
{
  "ok": true,
  "protocolVersion": "2025-06-18",
  "serverInfo": { "name": "…", "version": "…" },
  "tools": [ { "name": "getting_started" }, { "name": "list_my_avatars" } ],
  "scopes": ["avatars:read", "agents:read"]
}
```

If either JSON-RPC step returns an error, the HTTP status is still `200` and
the body is `{ "ok": false, "error": { …JSON-RPC error… } }`.

Errors: `400 bad_request` (`keyId` missing or not a string),
`404 not_found` (key does not exist, is not yours, or is not a well-formed
UUID), `400 revoked`, `400 expired`, `401`, `403` (CSRF), `429`.

See [MCP integration](./mcp.md) for configuring a real client against
`/api/mcp`.

---

## Public discovery endpoints

### GET /api/tool_schema

A public dump of the full MCP tool catalog: the same definitions `tools/list`
returns, with internal fields stripped. No auth, GET only. Also reachable at
the alias `/tool_schema`.

The response is a JSON **array** of MCP tool definitions. Each entry has
`name`, `description`, `inputSchema` (JSON Schema), and `annotations`
(`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`). The
first entry is always the free `getting_started` tool, whose description
carries the server overview and per-call pricing of the paid tools.

```bash
curl -s https://three.ws/api/tool_schema | jq 'length, .[0].name, [.[].name]'
```

Use this to build tool pickers, generate client bindings, or diff the catalog
between deploys without an MCP handshake.

### GET /api/skills-manifest

A machine-readable manifest of the browser agent's skills (see
[Agent skills](./agent-skills.md)). Public, CORS `*`, cached for 60 seconds
(`cache-control: public, max-age=60`).

```bash
curl -s https://three.ws/api/skills-manifest | jq .
```

Response, `200`:

```json
{
  "agent": { "id": "3d-agent", "version": "…" },
  "skills": [
    {
      "name": "greet",
      "description": "Greet the user and introduce the agent",
      "args": { "userName": "string?" }
    }
  ]
}
```

`args` maps each argument name to its JSON Schema type; a trailing `?` marks
it optional (`"string?"`), no suffix marks it required. `version` is the
platform's `package.json` version. The skill list is generated at build time
(`scripts/build-skill-metadata.mjs` writes
`data/_generated/skill-metadata.json`); skills without a description are
omitted from the manifest.

---

## Endpoint summary

| Endpoint | Method | Auth | CSRF | Purpose |
|---|---|---|---|---|
| `/api/keys` | GET | session | no | list keys |
| `/api/keys` | POST | session | yes | create key (secret shown once) |
| `/api/keys/:id` | DELETE | session | yes | revoke key |
| `/api/developer/usage` | GET | session | no | usage metrics (7/30/90d) |
| `/api/developer/webhooks` | GET | session | no | list webhooks + 7d stats |
| `/api/developer/webhooks` | POST | session | yes | register webhook (secret shown once) |
| `/api/developer/webhooks/:id` | GET | session | no | webhook detail + last 50 deliveries |
| `/api/developer/webhooks/:id` | PATCH | session | yes | update url/events/active/description |
| `/api/developer/webhooks/:id` | DELETE | session | yes | delete webhook |
| `/api/developer/mcp-test` | POST | session | yes | live MCP handshake with a key |
| `/api/tool_schema` | GET | none | no | public MCP tool catalog |
| `/api/skills-manifest` | GET | none | no | public agent skills manifest |
