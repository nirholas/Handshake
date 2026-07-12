<p align="center">
  <a href="https://three.ws"><img src="https://three.ws/three-ws-mcp-icon.svg" alt="three.ws" width="88" height="88"></a>
</p>

<h1 align="center">@three-ws/notifications-mcp</h1>

<p align="center"><strong>Your three.ws notification inbox, delivery preferences, and Web Push devices — from any AI agent.</strong></p>

<p align="center">
  <a href="https://www.npmjs.com/package/@three-ws/notifications-mcp"><img alt="npm" src="https://img.shields.io/npm/v/@three-ws/notifications-mcp?logo=npm&color=cb3837"></a>
  <a href="https://www.npmjs.com/package/@three-ws/notifications-mcp"><img alt="downloads" src="https://img.shields.io/npm/dm/@three-ws/notifications-mcp?color=cb3837"></a>
  <img alt="license" src="https://img.shields.io/npm/l/@three-ws/notifications-mcp?color=3b82f6">
  <img alt="node" src="https://img.shields.io/node/v/@three-ws/notifications-mcp?color=339933&logo=node.js">
  <a href="https://registry.modelcontextprotocol.io/?q=io.github.nirholas"><img alt="MCP Registry" src="https://img.shields.io/badge/MCP%20Registry-io.github.nirholas-0ea5e9"></a>
  <a href="https://three.ws"><img alt="three.ws" src="https://img.shields.io/badge/built%20by-three.ws-000"></a>
</p>

<p align="center">
  <a href="#install">Install</a> ·
  <a href="#quick-start">Quick start</a> ·
  <a href="#tools">Tools</a> ·
  <a href="#authentication">Authentication</a> ·
  <a href="#errors">Errors</a> ·
  <a href="https://three.ws">three.ws</a>
</p>

---

> A [Model Context Protocol](https://modelcontextprotocol.io) server that gives an AI assistant its own three.ws **notification inbox + delivery control** over stdio. Read inbound events (pump/market alerts, sales & earnings, purchase receipts, social mentions, IRL interactions, account/security notices), mark them read, tune the per-category → per-channel delivery matrix, and register Web Push devices — all live, all account-scoped.

## Why

An agent that trades, sells skills, or stands in the real world generates inbound events around the clock — a coin it launched pumps, a skill it published sells, someone taps its IRL pin. Without an inbox surface, the agent polls a dozen endpoints or misses everything. This server turns the platform's own notification feed into seven MCP tools: the agent reads what happened since it last looked, triages it, and controls exactly which channels (`in_app`, `push`, `email`, `telegram`) each category of event uses to reach its owner.

Every read and write hits the real three.ws API. The server is **authenticated**: it carries a three.ws API key (or OAuth access token) as a `Bearer` credential and resolves the owning account on every call. It signs nothing locally and holds no other secret.

## Install

```bash
npm install @three-ws/notifications-mcp
```

Or run with `npx` (no install):

```bash
THREE_WS_API_KEY=sk_live_… npx @three-ws/notifications-mcp
```

Node 20+. Two runtime dependencies (`@modelcontextprotocol/sdk`, `zod`).

## Quick start

**Claude Code**, one line:

```bash
claude mcp add notifications -e THREE_WS_API_KEY=sk_live_… -- npx -y @three-ws/notifications-mcp
```

**Claude Desktop / Cursor / any MCP client** — add to your MCP config (`claude_desktop_config.json`, `.cursor/mcp.json`, `.mcp.json`):

```json
{
	"mcpServers": {
		"notifications": {
			"command": "npx",
			"args": ["-y", "@three-ws/notifications-mcp"],
			"env": { "THREE_WS_API_KEY": "sk_live_…" }
		}
	}
}
```

Restart the client and the seven tools appear. Inspect the surface in a GUI:

```bash
npx -y @modelcontextprotocol/inspector npx -y @three-ws/notifications-mcp
```

Then ask in plain language:

> Anything new in my inbox? Mark the pump alerts read, and turn off email for social mentions.

Runs `list_notifications` → `mark_read` → `set_preferences`.

## Tools

| Tool | Kind | What it does |
|------|------|--------------|
| [`list_notifications`](#list_notifications) | read | The inbox, newest first, filterable by `type`, with an `unread_count`. |
| [`mark_read`](#mark_read) | write | Mark one notification — or every unread one — read. Idempotent. |
| [`delete_notification`](#delete_notification) | write ⚠️ | Permanently remove one notification (irreversible). |
| [`get_preferences`](#get_preferences) | read | The per-category → per-channel delivery matrix. |
| [`set_preferences`](#set_preferences) | write | Patch which channels deliver each category. Idempotent. |
| [`register_push_device`](#register_push_device) | write | Register a Web Push device from a browser `PushSubscription`. Idempotent. |
| [`unregister_push_device`](#unregister_push_device) | write ⚠️ | Remove a Web Push device (tears down delivery to it). Idempotent. |

Every tool ships [MCP tool annotations](https://modelcontextprotocol.io/specification/2025-06-18/server/tools#tool-annotations): the two reads advertise `readOnlyHint: true`, and the two ⚠️ tools are flagged `destructiveHint: true`, so annotation-aware clients prompt before running them.

### `list_notifications`

Read the account's inbox — the inbound-event feed the platform delivers: market/pump alerts, sales & earnings, purchase receipts, social mentions, IRL interactions, and account/security notices. Wraps `GET /api/notifications`.

| Arg | Type | Required | Notes |
|---|---|---|---|
| `type` | `string` | no | Return only one notification type (e.g. `"pump_alert"`, `"skill_purchased"`, `"referral_earned"`, `"security_alert"`). Lower_snake_case, ≤ 40 chars. Omit for all types. |
| `limit` | `number` | no | How many to return, newest first. 1–50, default 20. |

Example call and response (shape illustration — your inbox contents will differ):

```jsonc
// call
{ "type": "pump_alert", "limit": 2 }

// response (example)
{
  "ok": true,
  "type": "pump_alert",
  "unread_count": 5,
  "count": 2,
  "notifications": [
    {
      "id": "5d1c2f0a-9b1e-4c3d-8e7f-000000000001",
      "type": "pump_alert",
      "payload": { "mint": "FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump", "symbol": "THREE" },
      "read": false,
      "read_at": null,
      "created_at": "2026-07-11T18:04:12.000Z"
    }
  ]
}
```

`read` is derived from `read_at` (`null` ⇒ unread). `unread_count` is the total unread across the whole inbox, not just this page.

### `mark_read`

Mark notifications read. Wraps `POST /api/notifications/:id/read` (one) and `POST /api/notifications/read-all` (all). Pass **exactly one** of the two arguments. Marking read only sets `read_at` — nothing is deleted, and re-running is a no-op.

| Arg | Type | Required | Notes |
|---|---|---|---|
| `id` | `string` (UUID) | one of | A single notification to mark read (from `list_notifications`). |
| `all` | `boolean` | one of | `true` ⇒ mark every unread notification read. |

```jsonc
// call
{ "all": true }

// response (example)
{ "ok": true, "scope": "all", "marked_read": 5 }
```

With `id`, the response is `{ "ok": true, "scope": "one", "id": "…", "read_at": "…" }`.

### `delete_notification`

Permanently remove one notification. Wraps `DELETE /api/notifications/:id`. Irreversible — prefer `mark_read` for normal triage. Only a notification the caller owns can be deleted; a missing or already-deleted `id` returns a not-found error.

| Arg | Type | Required | Notes |
|---|---|---|---|
| `id` | `string` (UUID) | **yes** | The notification to delete (from `list_notifications`). |

```jsonc
// call
{ "id": "5d1c2f0a-9b1e-4c3d-8e7f-000000000001" }

// response (example)
{ "ok": true, "id": "5d1c2f0a-9b1e-4c3d-8e7f-000000000001", "deleted": true }
```

### `get_preferences`

Read the resolved delivery matrix — for each category, which channels deliver it. No arguments. Wraps `GET /api/notifications/preferences`. Read this before `set_preferences` so you patch from real current state.

```jsonc
// response (example)
{
  "ok": true,
  "categories": [
    { "key": "sales", "label": "Sales & earnings", "description": "…" },
    { "key": "alerts", "label": "Market & pump alerts", "description": "…" }
    /* purchases, social, irl, account … */
  ],
  "channels": ["in_app", "push", "email", "telegram"],
  "prefs": {
    "categories": { "alerts": { "in_app": true, "push": true, "email": false, "telegram": false } },
    "telegram_chat_id": null
  },
  "push": { "subscribed_devices": 1 }
}
```

The six categories are `sales`, `purchases`, `social`, `irl`, `alerts`, `account`; the four channels are `in_app`, `push`, `email`, `telegram`. `prefs.categories` is the effective matrix with the user's sparse overrides already merged onto platform defaults.

### `set_preferences`

Patch the delivery matrix. Wraps `PUT /api/notifications/preferences`. Provide at least one of the two arguments. Only the category/channel pairs you pass change; unknown keys are dropped server-side; untouched pairs keep their current value. Re-applying the same values is a no-op.

| Arg | Type | Required | Notes |
|---|---|---|---|
| `categories` | `object` | at least one | Outer keys: `sales`, `purchases`, `social`, `irl`, `alerts`, `account`. Inner keys: `in_app`, `push`, `email`, `telegram` → boolean. |
| `telegram_chat_id` | `string` | at least one | Numeric Telegram chat id to deliver the `telegram` channel to, or `""` to unlink. ≤ 24 chars. |

```jsonc
// call — stop emailing social mentions, push pump alerts
{ "categories": { "social": { "email": false }, "alerts": { "push": true } } }

// response (example) — the full resolved matrix after the update
{ "ok": true, "prefs": { "categories": { "social": { "email": false /* … */ } }, "telegram_chat_id": null } }
```

### `register_push_device`

Register a Web Push device so the account receives push notifications on it. Wraps `POST /api/push/subscribe`. The `subscription` argument is **exactly** what the browser's `pushManager.subscribe().toJSON()` returns. Push endpoints are globally unique — re-registering the same device upserts (latest owner wins), so this is idempotent. Whether a category actually delivers over push is still governed by `set_preferences`.

| Arg | Type | Required | Notes |
|---|---|---|---|
| `subscription` | `object` | **yes** | `{ endpoint, keys: { p256dh, auth } }` — `endpoint` is the push-service URL (≤ 2048 chars); `p256dh`/`auth` are the base64url-encoded keys from the browser. |

```jsonc
// call
{
  "subscription": {
    "endpoint": "https://fcm.googleapis.com/fcm/send/exampleSubscriptionId",
    "keys": { "p256dh": "BNcRd…", "auth": "tBHI…" }
  }
}

// response (example)
{ "ok": true, "registered": true, "endpoint": "https://fcm.googleapis.com/fcm/send/exampleSubscriptionId" }
```

### `unregister_push_device`

Remove a Web Push device so it stops receiving pushes. Wraps `DELETE /api/push/subscribe`. Provide **at least one** of the two arguments — the endpoint is what locates the device. Idempotent: removing an endpoint that isn't registered still returns `ok`. Only push delivery to that device changes; `in_app`, `email`, and `telegram` preferences are untouched.

| Arg | Type | Required | Notes |
|---|---|---|---|
| `endpoint` | `string` (URL) | one of | The push endpoint URL of the device to remove (preferred). |
| `subscription` | `object` | one of | Alternatively the full subscription object; its `endpoint` is used. |

```jsonc
// call
{ "endpoint": "https://fcm.googleapis.com/fcm/send/exampleSubscriptionId" }

// response (example)
{ "ok": true, "unregistered": true, "endpoint": "https://fcm.googleapis.com/fcm/send/exampleSubscriptionId" }
```

## Authentication

Every endpoint is account-scoped and returns `401` without a valid credential — this server can never read or change another account.

Set `THREE_WS_API_KEY` to either:

- a **three.ws API key** (`sk_live_…` / `sk_test_…`) — create one in your [three.ws dashboard](https://three.ws/dashboard), or
- an **OAuth access token** for the account.

Both are carried as `Authorization: Bearer …` on every request. Bearer auth is CSRF-exempt server-side, so writes need no extra token. `THREE_WS_TOKEN` and `THREE_WS_BEARER` are accepted aliases. Treat the credential like a password — it grants full read/write over the account's inbox and delivery settings.

## Configuration

| Env var | Required | Default | Description |
|---------|----------|---------|-------------|
| `THREE_WS_API_KEY` | **yes** | — | three.ws API key or OAuth access token (see [Authentication](#authentication)). Aliases: `THREE_WS_TOKEN`, `THREE_WS_BEARER`. |
| `THREE_WS_BASE` | no | `https://three.ws` | API base URL. Override only when self-hosting or targeting a preview. |
| `THREE_WS_TIMEOUT_MS` | no | `20000` | Per-request timeout in milliseconds. Must be a positive number. |

The credential is checked when a tool runs, not at startup — the server boots and advertises its tool surface without one, so `tools/list` always works.

## Errors

A failed tool call returns an MCP error result (`isError: true`) whose text is a single JSON object:

```jsonc
// error shape (example)
{ "ok": false, "error": "upstream_error", "message": "Not found", "status": 404, "detail": { /* API body */ } }
```

| `error` | HTTP | Meaning | Recovery |
|---|---|---|---|
| `missing_credential` | 401 | No `THREE_WS_API_KEY` (or alias) configured. | Set the env var and restart the client. |
| `validation_error` | 400 | Bad arguments (e.g. neither `id` nor `all` on `mark_read`). | Fix the call — the message says exactly what's missing. |
| `upstream_error` | as returned | The three.ws API rejected the request; `status` + `detail` carry the real response (401 bad key, 404 unknown id, 429 rate-limited). | Act on `status` — a 429 is safe to retry after a pause. |
| `timeout` | — | No response within `THREE_WS_TIMEOUT_MS`. | Retry; raise the timeout if it recurs. |
| `network_error` | — | The request never reached the API (DNS, offline). | Check connectivity / `THREE_WS_BASE`. |

Reads are always safe to retry. The writes are idempotent by design (`mark_read`, `set_preferences`, `register_push_device`, `unregister_push_device` re-run to the same state) — only `delete_notification` is not, and a repeat simply returns not-found.

## Related

- [`@three-ws/brain-mcp`](https://www.npmjs.com/package/@three-ws/brain-mcp) — the three.ws multi-provider LLM router over MCP.
- [`@three-ws/pumpfun-mcp`](https://www.npmjs.com/package/@three-ws/pumpfun-mcp) — free, read-only pump.fun + Solana data (the source of many `pump_alert` events).
- [`@three-ws/irl`](https://www.npmjs.com/package/@three-ws/irl) — the real-world presence layer whose interactions land in the `irl` category.

## Links

- Homepage: https://three.ws
- Changelog: https://three.ws/changelog
- Issues: https://github.com/nirholas/three.ws/issues
- License: Apache-2.0 — see [LICENSE](./LICENSE)

---

<p align="center">
  <sub>
    Part of the <a href="https://three.ws">three.ws</a> SDK suite — 3D AI agents, on-chain identity, and agent payments.<br/>
    <a href="https://three.ws">Website</a> · <a href="https://three.ws/changelog">Changelog</a> · <a href="https://github.com/nirholas/three.ws">GitHub</a>
  </sub>
</p>
