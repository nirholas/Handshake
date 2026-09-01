# Agent wallet control API

Every three.ws agent owns one custodial **Solana** wallet. Seven owner-only HTTP surfaces hang off it, and this is their developer reference: exact routes, exact request and response JSON, exact error codes, and a working curl call for each.

This document is the API reference the surrounding docs deliberately leave out. Read those first for the "why":

- [Agent wallets](agent-wallets.md) for how the wallet is created, how its key is held, and which paths may spend.
- [Custody you can verify](custody.md) for the limits, the freeze switch, the Merkle proof of custody, and the social-recovery model.
- [Financial controls](financial-controls.md) for the plain-English spend-rule layer and the anomaly guard behind `/solana/guard`.
- [The Trading Copilot](trading-copilot.md) for the conversational surface that proposes trades a human confirms.
- [Coin Autopilot](autopilot.md) for the *coin* cockpit at `/api/pump/autopilot`. That is a different feature from the **Treasury Autopilot** documented here, which runs the agent's own wallet rather than a launched coin.

## Orientation

All seven surfaces address the same custodial Solana keypair, obey the same owner gate, and are clamped by the same spend policy. None of them can widen authority: each one either reads the wallet, or narrows and schedules what the wallet is already allowed to do.

| Surface | Route root | What it controls |
|---|---|---|
| Capabilities | `/api/agents/:id/capabilities` | Scoped, time-boxed, revocable session keys for autonomous spend |
| Orders | `/api/agents/:id/orders` | The programmable order engine (limit, stop, trailing, DCA, TWAP, conditional) |
| Intents | `/api/agents/:id/intents` | Plain-language wallet rules compiled into structured, armed intents |
| Treasury Autopilot | `/api/agents/:id/autopilot` | The self-funding treasury policy and its runway view |
| Portfolio | `/api/agents/:id/portfolio` | FIFO cost basis, realized and unrealized P&L by source, live risk metrics |
| Recovery | `/api/agents/:id/recovery` | Guardians, approval threshold, dead-man check-in, inheritance |
| Solana guard | `/api/agents/:id/solana/guard` | The behavioral anomaly baseline, its sensitivity, and freeze adjudication |

The shared model, in one paragraph. A caller is resolved to a user id from either a session cookie or a bearer token. That user must own the agent, or the surface refuses (recovery is the one exception: guardians and the beneficiary get a scoped view). Every mutation is CSRF-gated for cookie callers. Anything that can move funds runs through the shared spend guards in [`api/_lib/agent-trade-guards.js`](../api/_lib/agent-trade-guards.js), so the wallet-wide policy (`per_tx_usd`, `daily_usd`, `per_counterparty_daily_usd`, `withdraw_allowlist`, `frozen`, `require_capabilities`) is enforced at the signing boundary, not per feature. A scheduled order, an armed intent, an autopilot rule, and an autonomous agent-to-agent payment are therefore all subject to the same ceilings and the same freeze as a manual trade. That enforcement fails closed on its inputs: a caller that hands the guard neither a pre-read policy nor the agent's meta gets the agent's real policy read from its row, and a spend for an agent that no longer exists is refused rather than defaulted to an unrestricted wallet. See [autonomous agent-to-agent payments](./a2a-payments.md) for the policy fields, the kill switch, and the receipts they leave behind.

## Shared conventions

### Base path and the agent id

Every route below is relative to `https://three.ws/api/agents/<agent-id>`. The agent id must be a UUID. A malformed id is rejected with `404 not_found` by the dispatcher in [`api/agents/[id].js`](../api/agents/%5Bid%5D.js) before any handler runs, so a bad id never surfaces as a database error.

### Authentication

Two credential types are accepted, resolved in this order:

1. **Session cookie.** The browser session issued by the normal sign-in flow.
2. **Bearer token.** `Authorization: Bearer <token>`, where the token is either an API key (`sk_live_…` or `sk_test_…`) or an OAuth access token.

The resolved user id is then compared against `agent_identities.user_id`. The three gate outcomes are identical across surfaces:

| Status | `error` | Meaning |
|---|---|---|
| `401` | `unauthorized` | No session and no valid bearer token |
| `404` | `not_found` | No such agent, or it is soft-deleted |
| `403` | `forbidden` | Authenticated, but not the agent's owner |

Recovery differs: it computes the caller's relationship to the agent (owner, guardian, beneficiary) and authorizes per action. See [Recovery](#recovery-guardians-threshold-and-inheritance).

### CSRF

Every state-changing request passes through [`api/_lib/csrf.js`](../api/_lib/csrf.js).

- **Bearer callers are exempt.** The token is itself the proof of intent, and browsers do not attach it automatically.
- **Cookie callers must double-submit.** Fetch a token from `GET /api/csrf-token` and echo it in the `X-CSRF-Token` header. Tokens are bound to the user id, expire after one hour, and are consumed on use, so each mutation needs a fresh one.

Failures are `403 csrf_missing` (header absent) and `403 csrf_invalid` (wrong user, expired, or already consumed).

### Network selection

Solana is the home chain and mainnet is the default. Append `?network=devnet` to switch a read or a write to devnet; any other value falls back to mainnet. Capabilities are network-independent and ignore the parameter.

### Error envelope

Errors are JSON, never cached:

```json
{ "error": "forbidden", "error_description": "not your agent" }
```

Some errors carry extra keys: validation failures on capabilities add `detail` with the offending `field`; recovery conflicts add `detail` with the request phase; internal failures add a `ref` you can quote to support; `429` adds `retry_after` and sometimes `reason`.

### Rate limits

Reads use a per-user wallet-read bucket. Order creation uses a per-user trade bucket. Intent compile and intent copilot use a per-user chat bucket. Capability mutations and recovery mutations use a per-IP critical-action bucket. Exceeding one returns `429 rate_limited` with a `retry-after` header. The exact ceilings live in [`api/_lib/rate-limit.js`](../api/_lib/rate-limit.js); treat that file as the source of truth rather than hardcoding numbers.

### Response envelope

Orders, intents, autopilot, portfolio, recovery, and the guard wrap their payload in `{ "data": … }`. Capabilities returns its keys at the top level. The examples below show each surface exactly as coded.

A cookie-authenticated mutation therefore looks like this:

```bash
CSRF=$(curl -s -b cookies.txt https://three.ws/api/csrf-token | jq -r .token)
curl -s -b cookies.txt \
  -H "x-csrf-token: $CSRF" \
  -H 'content-type: application/json' \
  -d '{"require_capabilities":true}' \
  -X PUT "https://three.ws/api/agents/$AGENT_ID/capabilities/settings"
```

Every later example uses a bearer token for brevity. Substitute the two headers above to drive the same route from a browser session.

## Capabilities: scoped session keys

Source: [`api/agents/capabilities.js`](../api/agents/capabilities.js), enforcement in [`api/_lib/wallet-capabilities.js`](../api/_lib/wallet-capabilities.js). Product tour: [Access](agent-abilities/wallet/21-access.md).

A capability is a signed, time-boxed grant that lets one named holder spend a narrow slice of the wallet's authority. Grants strictly subtract: on every autonomous spend both the capability ceiling and the wallet-wide policy must pass. The scope is HMAC-signed with `WALLET_CAPABILITY_SECRET` and re-verified on use, so an edited or forged row fails its integrity check and is rejected.

| Method | Route | Purpose |
|---|---|---|
| `GET` | `/capabilities` | List grants (live and historical), settings, action vocabulary, suggestions |
| `POST` | `/capabilities` | Mint a scoped grant |
| `PUT` | `/capabilities/settings` | Toggle least-privilege mode |
| `POST` | `/capabilities/:capabilityId/revoke` | Revoke one grant, immediately |
| `POST` | `/capabilities/revoke-all` | Revoke every live grant (kill switch) |

`GET` is owner-gated and needs no CSRF. All three mutations are owner-gated, CSRF-gated, and rate-limited per IP.

### GET /capabilities

```json
{
  "capabilities": [
    {
      "id": "8f14e45f-ceea-467a-9c3f-2a1b7c4d5e6f",
      "label": "Sniper strategy",
      "holder_kind": "strategy",
      "holder_ref": "41",
      "actions": ["snipe"],
      "per_use_usd": 12,
      "aggregate_usd": 240,
      "target_kind": "mint",
      "targets": ["FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump"],
      "expires_at": "2026-07-31T09:00:00.000Z",
      "revoked_at": null,
      "revoked_reason": null,
      "created_at": "2026-07-30T09:00:00.000Z",
      "last_used_at": "2026-07-30T11:42:07.512Z",
      "use_count": 3,
      "spent_usd": 31.4,
      "spend_count": 3,
      "status": "active"
    }
  ],
  "settings": { "require_capabilities": false },
  "actions": ["trade", "snipe", "x402"],
  "suggestions": []
}
```

`status` is derived, not stored: `active`, `revoked`, `expired`, or `tampered` (the HMAC no longer matches the row's scope). `spent_usd` and `spend_count` are summed from the same custody ledger that backs the wallet's daily ceiling, so a grant's meter and the wallet's audit trail can never disagree. The list includes revoked and expired grants and is capped at the 200 newest.

`suggestions` proposes least-privilege defaults so strict mode is not a chore. For each armed sniper strategy with a positive daily budget and no live grant scoped to it, the server drafts a `snipe` grant sized from that strategy's own budget:

```json
{
  "kind": "strategy",
  "holder_ref": "41",
  "label": "Sniper strategy",
  "reason": "This strategy can spend up to ◎0.500/day. A scoped key makes that explicit and revocable on its own.",
  "draft": {
    "label": "Sniper strategy",
    "holder_kind": "strategy",
    "holder_ref": "41",
    "actions": ["snipe"],
    "per_use_usd": 9,
    "aggregate_usd": 88,
    "target_kind": "any",
    "targets": [],
    "ttl_seconds": 86400
  }
}
```

The `draft` object is shaped to be POSTed straight back, which is how the Access tab implements one-tap accept. When the SOL price feed is unavailable both USD figures come back `null` and the draft narrows by action and expiry alone.

### POST /capabilities

| Field | Type | Notes |
|---|---|---|
| `label` | string | Up to 120 chars. Defaults to a generated label from holder kind and actions |
| `holder_kind` | string | `skill`, `strategy`, `integration`, `manual`. Anything else becomes `manual` |
| `holder_ref` | string | Stable id of the holder (a strategy id, a service host, a skill key). Up to 128 chars |
| `actions` | string[] | Required. One or more of `trade`, `snipe`, `x402`. Unknown values are dropped |
| `per_use_usd` | number | Optional per-spend ceiling |
| `aggregate_usd` | number | Optional lifetime budget. Must be at least `per_use_usd` |
| `target_kind` | string | `any` (default), `mint`, `service`, `destination` |
| `targets` | string[] | Required when `target_kind` is not `any`. Up to 50 entries |
| `expires_at` | ISO date | Absolute expiry. Takes precedence over `ttl_seconds` |
| `ttl_seconds` | number | Relative expiry, clamped to 60 seconds through one year. Defaults to 24 hours |
| `meta` | object | Free-form metadata stored with the grant |

`withdraw` is deliberately not a grantable action: an owner sweep is not a delegated capability. `service` targets are normalized to bare lowercase hostnames, so `https://api.example.com/v1` and `api.example.com` both store as `api.example.com` and both match a payment to that host.

Success is `201` with the grant shaped exactly like a list row:

```json
{ "capability": { "id": "…", "status": "active", "spent_usd": 0, "spend_count": 0 } }
```

Issuance errors are `400` with `error: "invalid"` and a `detail.field` pointer. The refusals, in the order they are checked:

| Condition | `detail.field` |
|---|---|
| No recognized action | `actions` |
| A non-`any` target kind with no usable targets | `targets` |
| Neither a ceiling nor a target restriction (the grant would narrow nothing) | `ceiling` |
| `per_use_usd` greater than `aggregate_usd` | `per_use_usd` |
| `expires_at` unparseable, in the past, or more than a year out | `expires_at` |

If `WALLET_CAPABILITY_SECRET` is missing or shorter than 8 characters the mint fails closed with `503 config` rather than issuing a grant whose signature could be forged.

```bash
curl -s -X POST "https://three.ws/api/agents/$AGENT_ID/capabilities" \
  -H "authorization: Bearer $THREE_WS_TOKEN" \
  -H 'content-type: application/json' \
  -d '{
    "label": "Weather skill",
    "holder_kind": "skill",
    "holder_ref": "weather-v1",
    "actions": ["x402"],
    "per_use_usd": 0.25,
    "aggregate_usd": 10,
    "target_kind": "service",
    "targets": ["api.example.com"],
    "ttl_seconds": 604800
  }'
```

### PUT /capabilities/settings

Body: `{ "require_capabilities": true | false }`. A non-boolean is `400 validation_error`. The flag is written into the wallet's spend policy, so turning it on means every autonomous spend without a covering grant is denied at the signing boundary. Owner withdrawals are unaffected.

```json
{ "settings": { "require_capabilities": true } }
```

### POST /capabilities/:capabilityId/revoke

Revocation is immediate and idempotent. Revoking an already-dead grant still returns `200`, with `already: true`:

```json
{ "revoked": true, "id": "8f14e45f-ceea-467a-9c3f-2a1b7c4d5e6f", "already": false }
```

A grant id belonging to a different agent is `404 not_found`. Every revoke writes a custody event.

### POST /capabilities/revoke-all

No body. Returns the number of live grants killed:

```json
{ "revoked": true, "count": 4 }
```

```bash
curl -s -X POST "https://three.ws/api/agents/$AGENT_ID/capabilities/revoke-all" \
  -H "authorization: Bearer $THREE_WS_TOKEN"
```

### Routing notes

The dispatcher only recognizes `GET` with no sub-path, `POST` with no sub-path, `PUT /settings`, `POST /revoke-all`, and `POST /<id>/revoke`. Anything else, including `GET /capabilities/<id>` and `DELETE`, returns `405 method_not_allowed`.

## Orders: the programmable order engine

Source: [`api/agents/orders.js`](../api/agents/orders.js), order model and condition language in [`api/_lib/orders.js`](../api/_lib/orders.js). Product tour: [Orders](agent-abilities/wallet/12-orders.md).

Orders are evaluated by the [`workers/agent-orders`](../workers/agent-orders/README.md) sweep and fire through the same guarded, firewalled, audited trade pipeline as a manual trade. The endpoint creates and manages them; it never signs. That worker is built and tested but not deployed yet, so orders created today stay `active` until it runs; the endpoint behaves identically either way.

| Method | Route | Purpose |
|---|---|---|
| `GET` | `/orders` | Orders, summary, live balance, freeze and kill-switch state |
| `POST` | `/orders` | Create a validated order |
| `POST` | `/orders/preview` | Validate plus a live preview: current metric, would-fire-now, firewall verdict |
| `POST` | `/orders/cancel-all` | Cancel every non-terminal order (orders kill switch) |
| `GET` | `/orders/schema` | The closed condition vocabulary that drives the UI builder |
| `GET` | `/orders/stream` | Server-sent events: the order list as it changes |
| `GET` | `/orders/:orderId` | One order plus its fills |
| `PUT` | `/orders/:orderId` | Edit price, trail, slippage, expiry, or pause state |
| `DELETE` | `/orders/:orderId` | Cancel one order, instantly |

Reads are owner-gated. `POST`, `PUT`, and `DELETE` are additionally CSRF-gated. `:orderId` must be a UUID; a non-UUID sub-path is `404 not_found`, and an unsupported method on a UUID path is `405 method_not_allowed`.

### The order model

| Type | Fires when |
|---|---|
| `limit` | A buy at or below the target, a sell at or above it |
| `stop` | A buy once the level breaks upward, a sell once it breaks downward |
| `trailing` | A sell after `trail_pct` off the high-water mark, a buy after `trail_pct` off the low |
| `dca` | On a fixed interval, `slices` times |
| `twap` | One total order sliced over time to cut price impact |
| `conditional` | A validated signal condition becomes true |

Shared fields: `type`, `side` (`buy` or `sell`), `mint` (validated Solana address), optional `symbol`, `slippage_bps` (clamped to 1 through 5000, default 500), optional `max_price_impact_pct`, optional `expires_at`, and `trigger_metric` (`price_sol`, `mcap_sol`, or `mcap_usd`, default `mcap_usd`).

Sizing: a buy needs `size_sol`; a sell needs either `size_tokens` (raw base units) or `sell_pct` (over 0 through 100). A TWAP buy takes `total_sol` and derives the per-slice size; a TWAP sell takes `total_tokens` or `sell_pct` and divides it across the slices.

Per-type fields: `limit_price` for `limit`, `stop_price` for `stop`, `trail_pct` (over 0, under 100) for `trailing`, `schedule: { interval_seconds, slices }` for `dca` (minimum 60 seconds, 1 slice) and `twap` (minimum 30 seconds, 2 slices, maximum 1000 slices), and `condition` for `conditional`.

A condition is one level deep, with no expressions and no code: `{ "all": [leaf, …] }` or `{ "any": [leaf, …] }`, at most 8 leaves. Each leaf is `{ signal, op, value }`. The closed signal set is `price_sol`, `mcap_sol`, `mcap_usd`, `price_change_pct`, `smart_money_score` (numeric, operators `gt`, `gte`, `lt`, `lte`, `eq`, `ne`), plus `dev_dump` and `graduated` (boolean, operators `is_true`, `is_false`). A signal the worker cannot read is treated as indeterminate: it never counts as satisfied and is reported in `missing`, so an order cannot fire on absent data.

### GET /orders

```json
{
  "data": {
    "orders": [
      {
        "id": "1b0e2c44-7f2a-4f7f-9a3c-6f8f9d0a1b2c",
        "network": "mainnet",
        "mint": "FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump",
        "symbol": "THREE",
        "type": "limit",
        "side": "buy",
        "size_sol": 0.25,
        "size_tokens": null,
        "sell_pct": null,
        "trigger_metric": "mcap_usd",
        "limit_price": 40000,
        "stop_price": null,
        "trail_pct": null,
        "peak_price": null,
        "reference_price": null,
        "schedule": null,
        "next_fire_at": null,
        "condition": null,
        "slippage_bps": 500,
        "max_price_impact_pct": null,
        "expires_at": null,
        "status": "active",
        "filled_sol": 0,
        "filled_tokens": 0,
        "fill_count": 0,
        "last_eval_at": "2026-07-30T12:00:03.118Z",
        "last_price": 51200,
        "last_error": null,
        "readback": "Buy 0.25 SOL of $THREE when it reaches $40,000 mcap (limit buy)."
      }
    ],
    "summary": {
      "total": 6,
      "active": 2,
      "filled": 3,
      "lifetime_fills": 5,
      "lifetime_filled_sol": 1.15,
      "balance_sol": 2.418,
      "frozen": false,
      "kill_switch": false
    }
  }
}
```

`readback` is a generated plain-language description of the order, produced by the same function the UI and the worker use. `balance_sol` is a live chain read and comes back `null` if the RPC read fails, which never fails the request.

### POST /orders

Returns `201` with `{ "data": { "order": … } }`. Validation failures are `422` and carry the specific code from the normalizer: `invalid_order`, `invalid_type`, `invalid_side`, `invalid_mint`, `invalid_size`, `invalid_price`, `invalid_trail`, `invalid_schedule`, `invalid_expiry`, or `invalid_condition`, each with a human-readable `error_description`. A malformed body is `400 bad_request`, a wrong content type is `415`, and a database failure is `500 create_failed`.

DCA and TWAP orders are created with `next_fire_at` set to now, so the first slice fires on the next worker sweep.

```bash
curl -s -X POST "https://three.ws/api/agents/$AGENT_ID/orders" \
  -H "authorization: Bearer $THREE_WS_TOKEN" \
  -H 'content-type: application/json' \
  -d '{
    "type": "trailing",
    "side": "sell",
    "mint": "FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump",
    "symbol": "THREE",
    "sell_pct": 50,
    "trail_pct": 18,
    "trigger_metric": "mcap_usd",
    "slippage_bps": 700
  }'
```

### POST /orders/preview

Preview is a validator, not a creator, so an invalid order comes back `200` with `ok: false` instead of `422`:

```json
{ "data": { "ok": false, "error": "invalid_trail", "message": "trail_pct must be between 0 and 100" } }
```

A valid order returns the normalized spec, its readback, a live market snapshot, and (for buys) a real firewall verdict:

```json
{
  "data": {
    "ok": true,
    "order": { "type": "limit", "side": "buy", "size_sol": 0.25 },
    "readback": "Buy 0.25 SOL of $THREE when it reaches $40,000 mcap (limit buy).",
    "preview": {
      "current": {
        "metric": "mcap_usd",
        "value": 51200,
        "price_sol": 0.0000004,
        "mcap_sol": 320,
        "mcap_usd": 51200,
        "graduated": false
      },
      "would_fire_now": false,
      "missing": []
    },
    "firewall": { "verdict": "allow", "score": 0.12, "simulated": true, "reasons": [] },
    "spend_limits": {
      "per_tx_usd": null,
      "daily_usd": 250,
      "frozen": false,
      "kill_switch": false,
      "per_trade_sol": 0.5,
      "daily_budget_sol": 2
    }
  }
}
```

Three honest nulls to expect. `preview.current` is `null` when the quote lane misses, and the endpoint still succeeds. `would_fire_now` is always `false` for a trailing order, because a trail needs a tracked high or low-water mark that does not exist until the order is live. `firewall` is `null` for sells, for a wallet with no Solana address, and when the on-chain simulation cannot be run.

### POST /orders/cancel-all

No body. Cancels every order in `active`, `partial`, `firing`, or `paused` on the selected network and returns the count:

```json
{ "data": { "cancelled": 3 } }
```

### GET /orders/schema

Returns `order_types`, `trigger_metrics`, `number_ops`, `bool_ops`, and `signals` (each signal as `{ kind, label }`). Build a client against this rather than hardcoding the vocabulary, since the endpoint and the worker import it from one module.

### GET /orders/:orderId

```json
{
  "data": {
    "order": { "id": "1b0e2c44-7f2a-4f7f-9a3c-6f8f9d0a1b2c", "status": "partial" },
    "fills": [
      {
        "id": 91,
        "slice_index": 0,
        "side": "buy",
        "trigger_reason": "limit_price",
        "trigger_price": 39880,
        "sol_amount": 0.25,
        "token_amount": 1840221,
        "price_impact_pct": 0.7,
        "venue": "pump",
        "signature": "5xQ…",
        "custody_event_id": 4412,
        "status": "confirmed",
        "detail": {},
        "created_at": "2026-07-30T12:01:44.019Z"
      }
    ]
  }
}
```

Each fill carries a `custody_event_id`, which is the join back into the custody ledger that the daily spend ceiling and the proof-of-custody attestation are computed from.

### PUT /orders/:orderId

Only a bounded set of fields can change, and `type`, `side`, and `mint` are immutable (cancel and recreate instead). Accepted keys: `limit_price` (on a `limit` order), `stop_price` (on a `stop`), `trail_pct` (on a `trailing`), `slippage_bps`, `expires_at`, and `paused`.

`paused: true` parks the order in a non-evaluated state without losing fill progress. `paused: false` returns it to `partial` if it has fills, otherwise `active`. An empty patch is a no-op that returns the unchanged order.

Errors: `404 not_found` for an unknown order, `422 immutable` for a filled, cancelled, or expired order, `422 invalid_price`, `422 invalid_trail`, `422 invalid_expiry`, and `500 update_failed`.

### DELETE /orders/:orderId

Instant and idempotent. Returns `{ "data": { "order": … } }` with the order in its terminal state. A cancel on an already-terminal order returns that order rather than an error; an unknown id is `404 not_found`.

### GET /orders/stream

Server-sent events, read-only, no CSRF. The connection closes itself after about 40 seconds and the browser's `EventSource` reconnects.

| Event | Payload | Meaning |
|---|---|---|
| `orders` | `{ orders, summary }` | The list changed (status, fill count, last price, or last error) |
| `ping` | `{ t }` | Nothing changed on this tick, or a tick failed to read |
| `close` | `{ reason: "duration_limit" }` | The stream is ending; reconnect |

```bash
curl -N "https://three.ws/api/agents/$AGENT_ID/orders/stream?network=mainnet" \
  -H "authorization: Bearer $THREE_WS_TOKEN"
```

## Intents: plain language to structured wallet rules

Source: [`api/agents/wallet-intents.js`](../api/agents/wallet-intents.js), engine in [`api/_lib/wallet-intents.js`](../api/_lib/wallet-intents.js). Product tour: [Intents](agent-abilities/wallet/14-intents.md).

An intent is a trigger plus an action plus the owner's own caps. The compiler turns a sentence into that structure and never arms it; arming is a separate, explicit call.

| Method | Route | Purpose |
|---|---|---|
| `GET` | `/intents` | The agent's intents plus a live summary |
| `POST` | `/intents/compile` | Compile plain language into a validated intent (preview only) |
| `POST` | `/intents` | Arm a validated intent |
| `POST` | `/intents/run` | Test one intent now, dry by default |
| `POST` | `/intents/copilot` | Ask about the wallet over real holdings and custody P&L |
| `GET` | `/intents/:intentId` | One intent |
| `PUT` | `/intents/:intentId` | Enable, disable, retitle, publish, or replace the rule |
| `DELETE` | `/intents/:intentId` | Remove an intent |

All writes are owner-gated and CSRF-gated. `:intentId` must be a UUID.

### The intent model

Triggers: `on_tip_received` (optional `min_sol`), `on_income`, `on_balance_below` (required `threshold_sol`), `on_schedule` (`cadence` of `daily` or `weekly`, `weekday` 0 through 6, `hour` 0 through 23 UTC), `on_launch_matching` (needs a base58 `creator` and/or a `max_mcap_usd`, optional `min_mcap_usd`), and `on_stream_started`.

Actions: `tip`, `transfer`, `withdraw`, `split_income` (move SOL: take `pct` with an `of` basis of `tip`, `income`, or `balance`, or a fixed `amount_sol`, or for a withdraw an `above_sol` floor, plus a `destination`), `buy` and `snipe` (need `amount_sol`, plus a `mint` unless the trigger is `on_launch_matching`, with an optional `slippage_pct` clamped to 0 through 50 and defaulting to 5), `freeze` (no parameters, the kill switch), and `notify` (optional `message`, `channel` of `email` or `log`).

A tip-back to whoever just tipped needs no destination: with `on_tip_received` plus a `tip` action the engine fills in the tipper at fire time and marks `to_tipper`.

Owner caps live in `limits`: `per_action_usd`, `daily_usd`, `total_usd`. They are additive to the wallet policy, never a replacement, and a breach downgrades the fire to `skipped` or `paused` with an explanation rather than throwing.

Every rolling ceiling a fire answers to (the rule's `daily_usd` and `total_usd`, and the wallet policy's own `daily_usd`) is reserved in the same statement that claims the execution row, under a per-agent lock, counting in-flight spends as spent. Two intents firing in the same sweep, or two overlapping sweeps, therefore cannot both spend headroom only one of them had.

Validation failures are `422` with a precise code: `bad_trigger`, `bad_action`, `needs_threshold`, `needs_filter`, `needs_amount`, `needs_pct`, `needs_mint`, or `needs_destination`.

### GET /intents

```json
{
  "data": {
    "intents": [
      {
        "id": "a3f0c9ee-4b1d-4c2f-8a10-11c0ffee1234",
        "title": "On a tip -> tip back",
        "trigger": { "type": "on_tip_received", "min_sol": 0.2 },
        "action": { "type": "tip", "pct": 10, "of": "tip", "to_tipper": true },
        "limits": { "per_action_usd": 5, "daily_usd": 25, "total_usd": null },
        "network": "mainnet",
        "enabled": true,
        "public_trait": false,
        "source_text": "tip back 10% of any tip over 0.2 SOL",
        "readback": "When someone tips more than 0.2 SOL, tip back 10% of tip.",
        "stats": {
          "fire_count": 7,
          "spent_usd": 3.42,
          "last_fired_at": "2026-07-29T22:04:11.000Z",
          "last_status": "ok",
          "last_note": null,
          "last_signature": "3Kd…"
        }
      }
    ],
    "summary": {
      "count": 3,
      "enabled": 2,
      "lifetime_usd": 12.9,
      "lifetime_fires": 19,
      "balance_sol": 2.418,
      "frozen": false,
      "spend_limits": { "per_tx_usd": null, "daily_usd": 250 }
    }
  }
}
```

### POST /intents/compile

Body: `{ "text": "…", "history": [{ "role": "user" | "assistant", "content": "…" }] }`. Only the last four history turns are used, and each is truncated. An empty `text` is `400 validation_error`; text over 1000 characters is rejected by the compiler.

The provider chain is tried in order: the caller's own Anthropic key, then Grok, then OpenRouter, each read from the user's stored provider keys and falling back to the deployment's environment. Three outcomes:

- **Compiled.** `200` with `ok: true`, the structured `intent`, its `readback`, a concrete `simulation`, and the `provider` that answered.
- **Needs one more detail.** `200` with `ok: false`, `error: "clarify"`, and a `clarify` question. This is a `200` on purpose so a conversational client can keep the turn going.
- **Cannot compile.** `422` with `error` set to the validation code (or `parse_failed`, or `bad_destination`), or `503` with `error: "unavailable"` when no provider key is configured at all, whose message points the owner at the manual form.

```json
{
  "data": {
    "ok": true,
    "intent": {
      "title": "On income -> split income",
      "trigger": { "type": "on_income" },
      "action": { "type": "split_income", "pct": 20, "of": "income", "destination": "7Xy…", "destination_label": "treasury.sol" },
      "limits": { "per_action_usd": null, "daily_usd": 50, "total_usd": null }
    },
    "readback": "On income, split 20% of income to treasury.sol.",
    "simulation": {
      "balance_sol": 2.418,
      "lines": ["Each fire moves 20% of income to treasury.sol.", "Daily budget: $50."]
    },
    "provider": "anthropic"
  }
}
```

A `.sol` name or `@username` destination is resolved to a real base58 address at compile time, and the original text is kept as `destination_label`. An unresolvable name returns `bad_destination` with a `clarify` question rather than storing an unusable rule.

```bash
curl -s -X POST "https://three.ws/api/agents/$AGENT_ID/intents/compile" \
  -H "authorization: Bearer $THREE_WS_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"text":"every Friday at 14:00 UTC withdraw anything above 3 SOL to treasury.sol"}'
```

### POST /intents

Body: `{ "intent": { … }, "source_text": "…", "public_trait": false }`. `intent` is required and is re-validated server-side, so a client cannot arm something the compiler would have rejected. A resolved `destination`, `destination_label`, `to_tipper`, and `mint` from the compile step are preserved through re-validation. `source_text` is stored (truncated to 1000 characters) so the owner can see the sentence the rule came from. `public_trait: true` publishes the rule as a visible agent trait.

Success is `201` with `{ "data": { "intent": … } }`. A missing intent object is `400 validation_error`, an invalid one is `422`, and a write failure is `500 create_failed`.

### POST /intents/run

Body: `{ "intent_id": "<uuid>", "dry_run": true }`. **`dry_run` defaults to `true`**: it is only a real run when you explicitly send `"dry_run": false`. A missing or non-UUID `intent_id` is `400 validation_error`.

A real run honors the freeze, the wallet spend policy, and the intent's own caps exactly like the scheduler, and claims an idempotent custody row so one event can never fire the same intent twice.

```json
{
  "data": {
    "ran": true,
    "dryRun": true,
    "results": [
      {
        "id": "a3f0c9ee-4b1d-4c2f-8a10-11c0ffee1234",
        "title": "On a tip -> tip back",
        "trigger": "on_tip_received",
        "action": "tip",
        "status": "would_run",
        "note": "would move ~$1.87",
        "usd": 1.87
      }
    ]
  }
}
```

`ran: false` comes back with a `reason` of `not_found` or `disabled`. Per-result `status` values are `would_run` (dry run), `ok`, `skipped` (under a cap, or already fired for this event), `paused` (would breach a budget, or the wallet policy refused), and `error`. Testing a launch-matching snipe rule reports readiness instead of picking a launch, since a manual test has no real launch to match.

### POST /intents/copilot

Body: `{ "message": "how am I doing?" }`, trimmed to 500 characters. An empty message is `400 validation_error`. **Funds never move here**: the copilot reads and explains only.

The real numbers are gathered first (live balance, plus 30 days of tips in, spend out, and intent activity from the custody ledger), then phrased in the agent's persona if a model is reachable. With no model key the endpoint still returns the same facts with `provider: "facts"`, so the feature never goes dark.

```json
{
  "data": {
    "reply": "You are up 41 dollars over the last month, and your tip-back rule has fired seven times.",
    "facts": {
      "balance_sol": 2.418,
      "tips_30d_usd": 82.5,
      "spend_30d_usd": 41.1,
      "net_30d_usd": 41.4,
      "active_intents": 2,
      "intent_fires": 19,
      "intent_moved_usd": 12.9
    },
    "provider": "anthropic"
  }
}
```

### PUT and DELETE /intents/:intentId

`PUT` accepts any of `enabled`, `public_trait`, `title`, and `intent` (a full replacement rule, re-validated). `404 not_found` for an unknown id, `422` with the normalizer's code for an invalid replacement. `DELETE` returns `{ "data": { "deleted": true } }`.

```bash
curl -s -X PUT "https://three.ws/api/agents/$AGENT_ID/intents/$INTENT_ID" \
  -H "authorization: Bearer $THREE_WS_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"enabled":false}'
```

## Treasury Autopilot

Source: [`api/agents/autopilot.js`](../api/agents/autopilot.js), engine in [`api/_lib/treasury-autopilot.js`](../api/_lib/treasury-autopilot.js). Product tour: [Autopilot](agent-abilities/wallet/13-autopilot.md).

Treasury Autopilot is the policy that lets an agent fund its own existence: pay its metered compute, hold a buffer, accumulate `$THREE`, compound its coin fees, and sweep real profit to its owner. It is stored on the agent, compiled from English, and armed only by an explicit owner write. Not to be confused with [Coin Autopilot](autopilot.md), which governs a launched coin at `/api/pump/autopilot`.

| Method | Route | Purpose |
|---|---|---|
| `GET` | `/autopilot` | Policy, the real runway view, and the read-only spend ceilings |
| `POST` | `/autopilot/compile` | Compile plain English into structured rules (preview only) |
| `PUT` | `/autopilot` | Save rules, arm, disarm, kill, or edit |
| `POST` | `/autopilot/run` | Run one cycle now |

All writes are owner-gated and CSRF-gated. An unknown sub-path is `404 not_found`.

### The rule model

Five rule kinds, executed in a fixed order per cycle: `self_fund` (pay the agent's own compute), `buffer` (maintain `buffer_sol`), `dca`, `buyback`, then `sweep` last.

| Kind | Parameters |
|---|---|
| `self_fund` | `cadence`: `hourly` (default), `daily`, `weekly` |
| `buffer` | None. The amount is the policy-level `buffer_sol` |
| `dca` | `basis` (`surplus` default, or `income`), `pct` or `amount_sol`, `cadence` (default `daily`), `weekday`, `slippage_bps` (clamped 50 to 2000, default 300) |
| `buyback` | `pct_of_fees` (0 to 100, default 100), `cadence` (default `weekly`), `weekday`, `slippage_bps` (default 500) |
| `sweep` | `threshold_sol`, `destination` (validated Solana address), `cadence` (default `weekly`), `weekday` |

The DCA target is always `$THREE` and is not owner-overridable: the field is set server-side, so a client cannot redirect the accumulation. `weekday` is 0 for Sunday through 6 for Saturday, or `null` for any day. Each rule carries `id`, `enabled`, `paused`, a generated `label`, and its last run stamp (`last_run_at`, `last_status`, `last_note`). At most 20 rules are kept.

### GET /autopilot

```json
{
  "data": {
    "policy": {
      "armed": true,
      "kill_switch": false,
      "buffer_sol": 1,
      "sweep_destination": "7Xy…",
      "rules": [
        { "id": "self_fund_m2k41x", "kind": "self_fund", "enabled": true, "paused": false, "params": { "cadence": "hourly" }, "label": "Pay the agent's own metered compute costs from its wallet", "last_run_at": "2026-07-30T11:00:02.441Z", "last_status": "ok", "last_note": null }
      ],
      "source_text": "pay your own compute, keep a 1 SOL buffer, sweep over 3 SOL to me on Fridays",
      "compiled_at": "2026-07-28T10:12:00.000Z",
      "approved_at": "2026-07-28T10:12:00.000Z",
      "compute_settled_at": "2026-07-30T11:00:02.441Z",
      "updated_at": "2026-07-30T11:00:02.441Z"
    },
    "runway": {
      "network": "mainnet",
      "price_usd": 168.4,
      "balance_sol": 2.418,
      "balance_usd": 407.2,
      "buffer_sol": 1,
      "buffer_usd": 168.4,
      "three_accumulated": 128400.5,
      "window_days": 30,
      "income_usd": 82.5,
      "cost_usd": 41.1,
      "net_usd": 41.4,
      "net_positive": true,
      "daily_burn_usd": 1.37,
      "daily_income_usd": 2.75,
      "net_daily_usd": 1.38,
      "runway_days": null,
      "self_sustaining": true,
      "self_funded_usd": 41.1,
      "dca_usd": 18,
      "dca_count": 9,
      "buyback_usd": 0,
      "buyback_count": 0,
      "swept_usd": 120,
      "swept_sol": 0.71,
      "sweep_count": 2,
      "armed": true,
      "kill_switch": false,
      "explorer_account": "https://solscan.io/account/…"
    },
    "spend_limits": { "daily_usd": 250, "per_tx_usd": null, "withdraw_allowlist": [], "frozen": false, "require_capabilities": false }
  }
}
```

Two things to read carefully. `runway_days` is `null` both when the agent is self-sustaining (an infinite runway, flagged by `self_sustaining: true`) and when the balance cannot be valued, so pair it with `self_sustaining` and `balance_usd` rather than treating `null` as unknown. Every number traces to a live chain read or a ledger row over a fixed 30-day window; a net-negative agent shows the truth rather than a projection. A runway computation failure is `500 runway_failed`.

### POST /autopilot/compile

Body: `{ "text": "…", "sweep_destination": "<base58>" }`. An invalid `sweep_destination` is ignored in favor of the policy's stored one rather than failing the request. The compiler prefers the configured model and falls back to a real deterministic parser, so it always compiles; `via` tells you which ran (`model` or `heuristic`).

```json
{
  "data": {
    "ok": true,
    "via": "model",
    "source_text": "pay your own compute, keep a 1 SOL buffer, sweep over 3 SOL to me on Fridays",
    "buffer_sol": 1,
    "sweep_destination": "7Xy…",
    "rules": [{ "kind": "self_fund", "params": { "cadence": "hourly" } }],
    "warnings": [],
    "contradictions": []
  }
}
```

`warnings` names every default the compiler had to assume. `contradictions` names rules that cannot all hold, including a structural check the endpoint adds itself: a sweep threshold at or below the buffer would fight the buffer every cycle. Compiling never arms anything, so a contradiction is reported rather than blocking. An empty policy is `400 empty_policy`; a compiler crash is `500 compile_failed`.

### PUT /autopilot

A patch, not a replacement. Accepted keys: `rules` (array; a non-array is `400 bad_request`), `buffer_sol`, `sweep_destination` (validated, `400 invalid_address` on a bad one, `null` to clear), `source_text`, `armed`, and `kill_switch`.

Arming is treated as explicit consent: sending `"armed": true` stamps `approved_at` and `compiled_at` server-side at the current time. Returns `{ "data": { "policy": … } }` with the newly normalized policy. Ownership is re-verified inside the write, so a `403 forbidden` or `404 not_found` can still surface here.

```bash
curl -s -X PUT "https://three.ws/api/agents/$AGENT_ID/autopilot" \
  -H "authorization: Bearer $THREE_WS_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"armed":true}'
```

### POST /autopilot/run

Body: `{ "dry_run": true }`. **The default is a real cycle.** Unlike `/intents/run`, this endpoint only simulates when you explicitly send `"dry_run": true`; an empty body executes for real. Send the dry run first if you are exploring.

A run honors the kill switch, the disarmed state, the freeze, and the spend policy exactly like the scheduler, and refuses rather than guessing when it cannot trust its inputs:

```json
{ "data": { "ran": false, "reason": "wallet_frozen", "results": [], "note": "Wallet is frozen. Unfreeze it under Limits and Safety." } }
```

Refusal reasons: `not_found`, `kill_switch`, `disarmed`, `no_rules`, `no_wallet`, `wallet_frozen`, `price_feed_unavailable` (the SOL/USD feed is the trust anchor for every conversion, so the cycle pauses instead of guessing with real money), `balance_read_failed`, `no_secret`, and `key_recover_failed`.

A cycle that ran returns `{ "ran": true, "trigger": "manual", "dryRun": false, "results": [ … ] }`, one entry per due rule, each stamped with its `last_status` and `last_note`. A rule whose weekday does not match today is reported as skipped rather than silently omitted. An unexpected failure is `500 run_failed`.

The `dca` and `buyback` rules swap through Jupiter, and the engine treats the two halves of that call differently. The quote is an idempotent read, so a 429, a 5xx, or a network failure is retried up to three times with jittered backoff inside a 15 second per-attempt deadline, while a 4xx (no route for this pair) is taken as the answer and the rule pauses with `no_route` and the reason in its `last_note`. Building the swap returns an unsigned transaction, so it is retried once, and only on a 5xx or network failure (`swap_failed` otherwise). Signing and broadcasting are never retried.

## Portfolio: valuation, P&L, and risk

Source: [`api/agents/portfolio.js`](../api/agents/portfolio.js), engine in [`api/_lib/portfolio.js`](../api/_lib/portfolio.js). Product tour: [Portfolio](agent-abilities/wallet/03-portfolio.md).

| Method | Route | Purpose |
|---|---|---|
| `GET` | `/portfolio` | Full snapshot: holdings, cost basis, attribution, risk |
| `GET` | `/portfolio/stream` | Server-sent events: revalued snapshots on an interval |

Both are read-only, owner-gated, and rate-limited. Attribution is derived from the custody ledger, which is owner-sensitive, so unlike the public balance read there is no visitor view. An unknown sub-path is `404 not_found`.

Cost basis is FIFO over a unified trade ledger (sniper positions plus custody trades), which is what makes realized and unrealized P&L attributable to the source that opened the lot.

### GET /portfolio

```json
{
  "data": {
    "agent": { "id": "…", "name": "Ada", "image": "https://…", "wallet": "7Xy…" },
    "network": "mainnet",
    "sol_usd": 168.4,
    "t": 1785412800000,
    "net_worth": {
      "sol": 2.94,
      "usd": 495.1,
      "realized_pnl_sol": 0.41,
      "realized_pnl_usd": 69.04,
      "unrealized_pnl_sol": -0.08
    },
    "holdings": [
      {
        "mint": null,
        "symbol": "SOL",
        "name": "Solana",
        "amount": 2.418,
        "decimals": 9,
        "price": 168.4,
        "usd": 407.2,
        "logo": null,
        "isNative": true,
        "stable": false,
        "is_three": false,
        "priceable": true,
        "usd_value": 407.2,
        "cost_basis_sol": null,
        "unrealized_sol": null,
        "unrealized_pct": null,
        "liquidity_warning": null
      }
    ],
    "attribution": [
      {
        "source": "sniper",
        "label": "Sniper",
        "realized_sol": 0.41,
        "realized_usd": 69.04,
        "unrealized_sol": -0.08,
        "unrealized_usd": -13.47,
        "total_sol": 0.33,
        "spent_sol": null,
        "spent_usd": null,
        "sells": 6,
        "is_outflow": false
      }
    ],
    "risk": {
      "net_worth_usd": 495.1,
      "concentration_hhi": 0.6821,
      "top_position_pct": 82.24,
      "top_position_mint": "SOL",
      "top_position_is_reserve": true,
      "top_risk_position_pct": 17.76,
      "top_risk_position_mint": "FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump",
      "reserve_usd": 407.2,
      "reserve_pct": 82.24,
      "risk_assets_count": 1,
      "volatile_exposure_usd": 87.9,
      "exposure_pct": 17.76,
      "tape_beta": 0.178,
      "max_drawdown_pct": 12.4,
      "max_drawdown_sol": 0.09,
      "realized_volatility_pct": 31.8,
      "holdings_count": 2,
      "valued_count": 2,
      "unpriceable_count": 0
    },
    "risk_flags": [{ "level": "info", "text": "No elevated concentration, exposure, or drawdown risk detected." }],
    "metrics": {},
    "basis_note": "Sniper P&L is on-chain actuals; discretionary P&L is FIFO-derived from recorded trade quotes."
  }
}
```

Notes that matter when you consume this:

- Holding keys are mixed-case as coded: `isNative`, `stable`, `is_three`, `priceable`, `usd_value`. `mint` is `null` for native SOL.
- A holding that cannot be priced is reported with `usd: null` and `liquidity_warning: "unpriceable"`. It is never valued at a guess, which is why `net_worth.usd` can be lower than the intuitive total.
- `attribution` buckets are `sniper`, `discretionary`, `strategy`, `x402`, and `withdraw`. The last two are pure outflows: they carry `spent_sol` and `spent_usd` with `is_outflow: true` and no round-trip P&L.
- `risk_flags` is always non-empty. A reserve-heavy or quiet wallet gets an explicit "no elevated risk" or "dry powder ready to deploy" flag rather than an ambiguous silence.
- Concentration keys off the largest *volatile* position (`top_risk_position_pct`), so a wallet that is mostly SOL or a stablecoin is not falsely flagged as a concentrated bet.
- `metrics` is the trader metric set (realized P&L, drawdown, and related figures) from [`api/_lib/trader-stats.js`](../api/_lib/trader-stats.js).

A valuation failure is `502 portfolio_failed`; a missing agent inside the engine is `404 not_found`.

```bash
curl -s "https://three.ws/api/agents/$AGENT_ID/portfolio?network=mainnet" \
  -H "authorization: Bearer $THREE_WS_TOKEN" | jq '.data.net_worth, .data.risk_flags'
```

### GET /portfolio/stream

| Event | Payload | Meaning |
|---|---|---|
| `hello` | `{ ts, network }` | The stream opened |
| `snapshot` | `{ t, sol_usd, net_worth, risk, risk_flags, attribution, holdings }` | A revaluation, pushed every 20 seconds |
| `ping` | `{ ts }` | Keep-alive, every 15 seconds |
| `warn` | `{ message: "revaluation_failed" }` | One revaluation failed; the stream stays open |
| `bye` | `{ reason: "max_duration" \| "not_found" }` | The stream is ending |

The first `snapshot` is pushed immediately on connect. The stream carries only the live-moving parts of the payload, so fetch `GET /portfolio` once for the full body and then keep it fresh from the stream. It self-terminates after 40 seconds and expects the client to reconnect.

## Recovery: guardians, threshold, and inheritance

Source: [`api/agents/recovery.js`](../api/agents/recovery.js), engine in [`api/_lib/agent-recovery.js`](../api/_lib/agent-recovery.js). Product tour: [Recovery](agent-abilities/wallet/22-recovery.md), and the counterpart console in [Guardian](guardian.md).

Recovery transfers *ownership*, never the key. The wallet secret is never decrypted, displayed, or moved. This is the one surface here that is not owner-only: a guardian or a beneficiary is a first-class caller with a scoped view.

| Method | Route | Who may call |
|---|---|---|
| `GET` | `/recovery` | Owner, guardian, or beneficiary |
| `PUT` | `/recovery` | Owner |
| `POST` | `/recovery/checkin` | Owner |
| `GET` | `/recovery/requests` | Owner |
| `POST` | `/recovery/requests` | Guardian or beneficiary |
| `POST` | `/recovery/requests/:requestId/approve` | Active guardian |
| `POST` | `/recovery/requests/:requestId/decline` | Active guardian |
| `POST` | `/recovery/requests/:requestId/confirm` | Guardian or beneficiary (inheritance) |
| `POST` | `/recovery/requests/:requestId/cancel` | Owner (reject) or the requester (withdraw) |
| `POST` | `/recovery/requests/:requestId/complete` | Anyone in the circle, plus the nominee |
| `POST` | `/recovery/inheritance/arm` | Guardian or beneficiary |

Every write is CSRF-gated and rate-limited per IP. A caller with no relationship to the agent gets `403 forbidden` on the read too. A non-UUID request id is `404 not_found`.

### GET /recovery

```json
{
  "data": {
    "agent": { "id": "…", "name": "Ada", "avatar_url": "https://…" },
    "viewer": { "is_owner": true, "is_guardian": false, "is_beneficiary": false, "user_id": "…" },
    "config": { "threshold": 2, "effective_threshold": 2, "dead_man": { "enabled": true, "inactivity_days": 90, "grace_days": 14, "last_check_in": "2026-07-30T09:00:00.000Z" } },
    "guardians": [
      { "id": "12", "user_id": "…", "role": "guardian", "username": "sam", "display_name": "Sam", "email_masked": "s…@example.com", "avatar_url": null, "label": "Sam", "since": "2026-06-01T00:00:00.000Z" }
    ],
    "guardian_count": 3,
    "beneficiary": { "label": "@kai", "avatar_url": null, "is_you": false },
    "dead_man": {
      "enabled": true,
      "inactivity_days": 90,
      "grace_days": 14,
      "inactive_days": 0,
      "last_active_at": "2026-07-30T11:58:00.000Z",
      "arm_at": "2026-10-28T11:58:00.000Z",
      "ms_until_arm": 7776000000,
      "eligible_to_arm": false,
      "signals": { "session": "…", "custody": "…", "usage": "…", "agent_updated": "…", "check_in": "…" }
    },
    "active_request": null,
    "max_guardians": 10
  }
}
```

The view is redacted by role. An owner sees the full guardian roster (with masked emails) and the full dead-man picture including the activity `signals` it was derived from. A guardian or beneficiary sees only `{ role, label, avatar_url, is_you }` per guardian and the bare dead-man settings, with no `inactive_days` and no `signals`.

`effective_threshold` is the number of approvals actually required: it defaults to 2-of-N (or all guardians when fewer than two exist) until an owner sets `threshold` explicitly, and is always clamped into the roster size.

### PUT /recovery

Owner only. Body:

| Field | Type | Notes |
|---|---|---|
| `guardians` | string[] | Handles: username, `@handle`, email, or user id. At most 10 |
| `beneficiary` | string | One handle, or omit for none |
| `threshold` | number | At least 1, no greater than the guardian count |
| `dead_man` | object | `{ enabled, inactivity_days, grace_days }`. Days are clamped to 7 through 365 and 1 through 90 |

Handle resolution is strict, so a typo is a clean error naming the offending value rather than a silently dropped guardian: `400 unknown_guardian`, `400 unknown_beneficiary`, `400 self_guardian`, `400 self_beneficiary`, `400 too_many_guardians`, `400 bad_threshold`, and `400 dead_man_needs_beneficiary` (the switch needs someone to inherit). Duplicates in the list are collapsed rather than rejected. Returns the new roster and config.

```bash
curl -s -X PUT "https://three.ws/api/agents/$AGENT_ID/recovery" \
  -H "authorization: Bearer $THREE_WS_TOKEN" \
  -H 'content-type: application/json' \
  -d '{
    "guardians": ["@sam", "kai@example.com"],
    "beneficiary": "@kai",
    "threshold": 2,
    "dead_man": { "enabled": true, "inactivity_days": 90, "grace_days": 14 }
  }'
```

### POST /recovery/checkin

Owner only, no body. The canonical "I am here" action: it resets the dead-man clock and aborts any inheritance already in flight.

```json
{ "data": { "checked_in_at": "2026-07-30T12:00:00.000Z", "aborted_inheritance": 1 } }
```

### /recovery/requests

`GET` (owner only) returns `{ "data": { "items": [ … ] } }`, the recent request history for the audit view.

`POST` opens a recovery. Body: `{ "reason": "…" }`, optional. Returns `201` with the decorated request. Refusals: `403 not_a_guardian`, `409 already_owner`, `409 process_in_progress`, and `422 not_enough_guardians` (recovery needs at least one guardian other than the requester, so the inheritance path is the route when there are none).

A decorated request looks like this:

```json
{
  "data": {
    "id": "…",
    "agent_id": "…",
    "kind": "recovery",
    "status": "time_locked",
    "needs_beneficiary_confirmation": false,
    "stored_status": "open",
    "requester_id": "…",
    "prev_owner_id": "…",
    "new_owner_id": "…",
    "approvals": 2,
    "approvals_required": 2,
    "declines": 0,
    "approved": true,
    "timelock_until": "2026-08-01T12:00:00.000Z",
    "ms_until_unlock": 172800000,
    "ms_until_expiry": 1036800000,
    "reason": "lost my password",
    "created_at": "2026-07-30T12:00:00.000Z",
    "completed_at": null,
    "votes": [{ "user_id": "…", "decision": "approve", "at": "…", "label": "Sam" }]
  }
}
```

`status` is the live computed phase, while `stored_status` is the raw row. Approvals are counted only from *currently active* guardians, so removing a guardian retracts their vote. The safety rails are enforced server-side, in this order: the requester cannot approve their own takeover (`403 no_self_approve`), threshold approvals start a 48-hour time-lock, unmet requests expire after 14 days, and the real owner can cancel at any point.

### Voting, confirming, cancelling, completing

- **`/approve` and `/decline`** record a vote. `404 not_found`, `409 not_open`, `403 not_a_guardian`, `403 no_self_approve`, `400 bad_decision`. Returns the re-decorated request.
- **`/confirm`** is the inheritance beneficiary's or a guardian's confirmation. `403 not_a_party` when the caller is neither. A guardian's confirm is recorded as an approval.
- **`/cancel`** is a reject when the owner calls it and a withdrawal when the requester does. Anyone else gets `403 forbidden`. `409 not_open` once the request is closed.
- **`/complete`** finalizes a ready request and transfers ownership. The caller must be in the circle, or be the requester or the nominee, and the server re-verifies readiness regardless of who calls: `409 not_ready` carries `detail` with the phase, milliseconds until unlock, and the current approval count; `409 awaiting_beneficiary` means control cannot pass until the beneficiary confirms. Completion is idempotent (`{ "transferred": false, "alreadyOwned": true }` on a re-run) and aborts with `409 owner_changed` if ownership moved underneath it.

```bash
curl -s -X POST "https://three.ws/api/agents/$AGENT_ID/recovery/requests/$REQUEST_ID/approve" \
  -H "authorization: Bearer $GUARDIAN_TOKEN"
```

### POST /recovery/inheritance/arm

Guardian or beneficiary only. No body. Arms the dead-man switch once the owner has genuinely gone quiet. Returns `201` with the new inheritance request, or `409 not_eligible` when the owner is still active, no beneficiary is set, or a process is already running. Any owner check-in cancels the whole thing.

## Solana guard: the self-defending wallet

Source: [`api/agents/solana-guard.js`](../api/agents/solana-guard.js), scoring in [`api/_lib/wallet-anomaly.js`](../api/_lib/wallet-anomaly.js), event store in [`api/_lib/anomaly-events.js`](../api/_lib/anomaly-events.js). Behavior narrative: [Financial controls](financial-controls.md).

Scoring and freezing happen inline on the spend path, not here. This endpoint is the owner's window into that system and the control over it: read the learned baseline and the anomaly timeline, tune sensitivity, set a safe-sweep address, and adjudicate a freeze.

| Method | Route | Purpose |
|---|---|---|
| `GET` | `/solana/guard` | Config, presets, freeze state, baseline, open flags, paginated timeline |
| `PUT` | `/solana/guard` | Tune sensitivity, enable or disable, set the safe address, clear what was learned |
| `POST` | `/solana/guard` | Adjudicate: approve, deny, mark swept, or unfreeze |

All three are owner-gated and rate-limited; the two mutations are CSRF-gated. Any other method is `405`.

### GET /solana/guard

Query: `limit` (1 to 100, default 40) and `before` (a numeric event id cursor).

```json
{
  "data": {
    "config": {
      "enabled": true,
      "sensitivity": "balanced",
      "safe_address": "7Xy…",
      "size_ceiling_usd": 40,
      "extra_hours": [3],
      "learned_destinations": 2,
      "updated_at": "2026-07-29T18:22:04.881Z"
    },
    "presets": [
      { "key": "relaxed", "label": "Relaxed", "threshold": 0.85, "description": "Only freezes on the clearest threats. Fewest alerts." },
      { "key": "balanced", "label": "Balanced", "threshold": 0.7, "description": "Recommended. Freezes on strong anomalies, lets normal behavior through." },
      { "key": "strict", "label": "Strict", "threshold": 0.5, "description": "Freezes on the first sign of unusual activity. Most alerts." }
    ],
    "frozen": true,
    "baseline": {
      "version": 1,
      "n": 34,
      "total_events": 41,
      "usd": { "max": 38.2, "p95": 22.4, "mean": 7.9, "samples": 34 },
      "velocity": { "per_hour_p95": 3, "per_hour_max": 6, "active_hour_buckets": 19 },
      "counterparties": ["7Xy…"],
      "counterparty_count": 4,
      "active_hours": [9, 10, 11, 14, 15],
      "assets": ["SOL", "USDC"],
      "first_at": "2026-06-02T09:11:00.000Z",
      "last_at": "2026-07-30T11:04:00.000Z",
      "computed_at": "2026-07-30T12:00:00.000Z",
      "low_history": false
    },
    "open_flags": [
      {
        "id": "4417",
        "network": "mainnet",
        "category": "withdraw",
        "asset": "SOL",
        "usd": 310.5,
        "destination": "9Qz…",
        "score": 0.88,
        "decision": "freeze",
        "critical": true,
        "sensitivity": "balanced",
        "factors": [{ "key": "size", "weight": 0.4, "text": "8x larger than this wallet's normal spend" }],
        "summary": "Unusually large withdrawal to a new destination",
        "status": "flagged",
        "hour_utc": 3,
        "swept": false,
        "adjudicated_at": null,
        "created_at": "2026-07-30T03:14:59.000Z"
      }
    ],
    "timeline": { "items": [], "next_cursor": "4402" }
  }
}
```

`learned_destinations` is a count, not the list: the owner sees how much has been taught without the response echoing an allowlist wholesale. `low_history` is `true` while the wallet has too few spends for the baseline to mean much, which is the honest signal to show instead of a confident-looking profile. `next_cursor` is non-null only when the page came back full; pass it as `before` for the next page.

### PUT /solana/guard

| Field | Effect |
|---|---|
| `enabled` | Boolean. Turns the guard on or off |
| `sensitivity` | `relaxed`, `balanced`, or `strict`. Anything else is `400 invalid_sensitivity` |
| `safe_address` | A validated Solana address for one-tap sweep-to-safety, or `null` / `""` to clear |
| `clear_learned` | `true` resets every learned pattern: destinations, size ceiling, and extra hours |

`safe_address` validation is deliberately strict: an off-curve program address (a PDA) is rejected with `400 invalid_address` because funds sent there could be unrecoverable. Returns `{ "data": { "config": … } }`.

```bash
curl -s -X PUT "https://three.ws/api/agents/$AGENT_ID/solana/guard" \
  -H "authorization: Bearer $THREE_WS_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"sensitivity":"strict","safe_address":"7Xy…"}'
```

### POST /solana/guard

Body: `{ "action": "…", "event_id": "…" }`. `action` must be `approve`, `deny`, `mark_swept`, or `unfreeze`, otherwise `400 bad_request`. All but `unfreeze` require a numeric `event_id` that belongs to this agent (`400 bad_request` if absent, `404 not_found` if unknown).

| Action | What it does | Response |
|---|---|---|
| `approve` | Teaches the baseline from the flagged action (destination, size, hour) so the same pattern will not re-trip, then unfreezes and marks the event approved | `{ "frozen": false, "action": "approve", "event_id": "…", "config": { … } }` |
| `deny` | Confirmed bad. Keeps the wallet frozen and records the verdict | `{ "frozen": true, "action": "deny", "event_id": "…" }` |
| `mark_swept` | Records that the owner evacuated the wallet with a normal audited withdraw. Keeps it frozen | `{ "action": "mark_swept", "event_id": "…", "swept": true }` |
| `unfreeze` | Owner override not tied to a flag: unfreezes and settles every still-open flag as approved | `{ "frozen": false, "action": "unfreeze" }` |

The difference between `approve` and `unfreeze` is the one that matters operationally: `approve` teaches, so the pattern is permanently normal for this wallet; `unfreeze` only clears the current state, so the same spend can trip the guard again. `mark_swept` records the sweep on the flag but does not itself move funds; the money leaves through the normal withdraw endpoint under the usual guards.

```bash
curl -s -X POST "https://three.ws/api/agents/$AGENT_ID/solana/guard" \
  -H "authorization: Bearer $THREE_WS_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"action":"approve","event_id":"4417"}'
```

## Related

- [Agent wallets](agent-wallets.md) for the wallet itself: creation, key custody, and the five spend paths.
- [Custody you can verify](custody.md) for limits, freeze, proof of custody, and the recovery model in prose.
- [Financial controls](financial-controls.md) for the plain-English spend rules and the wallet-defense behaviors.
- [The Trading Copilot](trading-copilot.md) for the conversational read-and-propose surface over the same wallet.
- [Coin Autopilot](autopilot.md) for the separate coin cockpit at `/api/pump/autopilot`.
- [What agents can do](agent-abilities.md) for a page per wallet ability, including [Access](agent-abilities/wallet/21-access.md), [Orders](agent-abilities/wallet/12-orders.md), [Intents](agent-abilities/wallet/14-intents.md), [Autopilot](agent-abilities/wallet/13-autopilot.md), [Portfolio](agent-abilities/wallet/03-portfolio.md), and [Recovery](agent-abilities/wallet/22-recovery.md).
- [Guardian console](guardian.md) for the other side of a recovery request.
