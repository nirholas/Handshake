# Payment Sessions

A Payment Session is a platform-managed spend envelope for agents. You fund a
budget from your prepaid credits, receive a bearer token, and hand that token
to an agent (or any script). The agent then calls paid x402 endpoints through
`POST /api/pay/execute` without ever holding a private key: the platform's
Solana wallet signs each payment, and a spend governor enforces your budget,
host allowlist, and per-transaction cap on every call. This is for developers
who want an agent to spend real money inside hard limits, with a full
execution ledger and an unspent-budget refund when the session ends.

The design principle: the agent does not hold a wallet. It proposes spend;
governance enforces policy.

Base URL: `https://three.ws`

---

## How the pieces fit

1. **Credits** are your prepaid balance, denominated in USD. Top up by sending
   SOL or $THREE to the platform deposit wallet, then verifying the transfer
   with `POST /api/credits/deposit`.
2. **A session** locks part of that balance into a budget envelope
   (`POST /api/pay/session`). Creation debits your credits up front and returns
   a one-time bearer token in the form `pss_<session-id>_<random>`. Only an
   HMAC-SHA256 hash of the token is stored; if you lose it, cancel the session
   and create a new one.
3. **Executions** spend the envelope. Each `POST /api/pay/execute` call probes
   the target URL for its 402 challenge, runs the governance checks, reserves
   budget atomically, signs a Solana USDC transfer with the platform payer
   wallet, presents the `X-PAYMENT` header, and records the result in the
   session's execution ledger.
4. **Cancel or expire** to get the rest back. `DELETE /api/pay/session/:id`
   refunds the unspent budget to your credits immediately; a scheduled sweep
   (`/api/cron/payment-session-sweep`, every 5 minutes) does the same for
   sessions that pass their expiry while still active.

## Authentication

The session-management and credits endpoints accept either credential:

- **Browser session cookie** (the normal three.ws login). These endpoints do
  not require a CSRF token.
- **`Authorization: Bearer <token>`** with a three.ws API key (`sk_live_...` /
  `sk_test_...`) or an OAuth access token.

`POST /api/pay/execute` is different: it authenticates with the **session
token itself** (`session_token` in the JSON body). No cookie or API key is
needed, which is the point: the token is a time-bounded spending grant you can
hand to an untrusted agent process.

Rate limits: `GET /api/credits` shares the authenticated-read bucket
(300 requests per 5 minutes per IP). Everything else here shares the strict
auth bucket (50 requests per 10 minutes per IP) and returns 429 with a
`Retry-After` header when exceeded.

---

## Prepaid credits

### `GET /api/credits`

Your balance, recent ledger, where to deposit, and the fixed-price actions
credits can buy.

```bash
curl -s https://three.ws/api/credits \
  -H 'authorization: Bearer sk_live_...'
```

```json
{
  "balance_usd": 12.5,
  "lifetime_deposited_usd": 20,
  "lifetime_spent_usd": 7.5,
  "deposit": {
    "wallet": "<platform deposit address>",
    "network": "mainnet",
    "accepts": ["SOL", "THREE"],
    "three_mint": "FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump",
    "three_symbol": "THREE",
    "three_decimals": 6
  },
  "buys": [ { "id": "...", "label": "...", "category": "...", "policy": "...", "usd": 0.05 } ],
  "ledger": [ { "id": "...", "kind": "deposit", "amount_usd": 20, "...": "..." } ],
  "next_cursor": null
}
```

`ledger` is newest-first (25 entries here); each item carries `id`, `kind`
(`deposit`, `refund`, `grant`, `adjust`, or a spend), `amount_usd`,
`balance_after`, `action`, `ref_type`, `ref_id`, `tx_signature`, `asset`,
`asset_amount`, `price_usd`, and `created_at`.

### `POST /api/credits/deposit`

Verify an on-chain transfer into the deposit wallet and credit your balance.
Server-authoritative: the platform confirms the transaction on-chain, requires
that a signer is a Solana wallet linked to your account, and computes the
amount actually received from pre/post balances. Credits land only once the
transaction is finalized.

```bash
curl -s https://three.ws/api/credits/deposit \
  -H 'authorization: Bearer sk_live_...' \
  -H 'content-type: application/json' \
  -d '{ "asset": "SOL", "tx_signature": "<signature>", "network": "mainnet" }'
```

Body fields:

| Field | Type | Notes |
|---|---|---|
| `asset` | string | `"SOL"` or `"THREE"`, required |
| `tx_signature` | string | The Solana transaction signature, required |
| `network` | string | `"mainnet"` (default) or `"devnet"` |

Success:

```json
{
  "ok": true,
  "replay": false,
  "balance_usd": 32.5,
  "credited_usd": 20,
  "usd": 20,
  "asset": "SOL",
  "amount": 0.125,
  "price_usd": 160,
  "tx_signature": "<signature>"
}
```

If the transaction is confirmed but not yet finalized you get a retryable
`{ "ok": false, "pending": true, "status": "awaiting_finalization", ... }`;
poll again in a few seconds. Crediting is idempotent per (signature, asset): a
replay returns `"replay": true` with `credited_usd: 0` instead of
double-crediting.

Error codes: `bad_request` (400), `wallet_not_linked` (403, the transfer was
not signed by a wallet linked to your account), `tx_failed`, `tx_not_found`,
`no_funds_received`, `amount_too_small` (all 422), `price_unavailable` and
`deposit_unavailable` (503).

---

## Creating a session

### `POST /api/pay/session`

```bash
curl -s https://three.ws/api/pay/session \
  -H 'authorization: Bearer sk_live_...' \
  -H 'content-type: application/json' \
  -d '{
    "label": "research agent",
    "budget_usd": 1.00,
    "max_per_tx_usd": 0.01,
    "allowed_hosts": ["three.ws"],
    "expiry_seconds": 86400
  }'
```

Body fields:

| Field | Type | Notes |
|---|---|---|
| `budget_usd` | number | Required. Min $0.001, max $1000. Debited from credits immediately. |
| `label` | string | Optional, trimmed to 120 chars. |
| `max_per_tx_usd` | number | Optional per-payment ceiling, must be above $0.000001. `null` means no cap. |
| `allowed_hosts` | string[] | Optional, max 50 entries, deduplicated. Empty means any host. |
| `agent_id` | string | Optional agent to associate with the session. |
| `network` | string | `"solana"` (default) or `"base"`. Stored on the session; execution settles on Solana (see below). |
| `expiry_seconds` | number | Default 3600. Min 60, max 7776000 (90 days). |
| `metadata` | object | Arbitrary caller metadata, stored and echoed back. |

Response is `201` with the session object and the token, **shown exactly
once**:

```json
{
  "session": {
    "id": "0b2f...",
    "user_id": "...",
    "agent_id": null,
    "label": "research agent",
    "budget_usd": 1,
    "spent_usd": 0,
    "remaining_usd": 1,
    "max_per_tx_usd": 0.01,
    "allowed_hosts": ["three.ws"],
    "network": "solana",
    "status": "active",
    "expires_at": "2026-07-31T00:00:00.000Z",
    "metadata": {},
    "created_at": "2026-07-30T00:00:00.000Z"
  },
  "token": "pss_0b2f..._4f8a...",
  "note": "Store this token securely ..."
}
```

Errors: `402 insufficient_credits` when your balance cannot cover
`budget_usd` (the message includes the required and available amounts), and
`400` with `invalid_budget`, `invalid_ttl`, or `bad_request` for out-of-range
fields.

Session `status` is one of `active`, `exhausted` (budget fully spent),
`cancelled`, or `expired`.

## Inspecting, listing, updating

### `GET /api/pay/session`

Lists your sessions newest-first plus aggregate stats. Query parameters:
`status` (filter by status), `limit` (default 20, max 100), `cursor` (pass the
previous page's `next_cursor`, a `created_at` timestamp).

```json
{
  "items": [ { "id": "...", "status": "active", "...": "..." } ],
  "next_cursor": null,
  "stats": {
    "sessions": { "active": 1, "exhausted": 0, "cancelled": 2, "expired": 0,
                  "total_budget_usd": 3, "total_spent_usd": 1.2 },
    "executions": { "settled": 40, "failed": 2, "settled_usd": 1.2, "unique_endpoints": 3 }
  }
}
```

### `GET /api/pay/session/:id`

Returns `{ "session": { ... } }` for a session you own, `404 not_found`
otherwise.

### `GET /api/pay/session/:id/executions`

The payment ledger for one session, newest-first, with `limit` (default 20,
max 100) and `cursor` pagination. Each item:

```json
{
  "id": "...",
  "endpoint_url": "https://three.ws/api/x402/ping",
  "endpoint_host": "three.ws",
  "method": "GET",
  "amount_usd": 0.001,
  "network": "solana",
  "tx_hash": "5Kd...",
  "payer_address": "...",
  "payee_address": "...",
  "status": "settled",
  "error_code": null,
  "duration_ms": 1843,
  "created_at": "2026-07-30T00:01:00.000Z"
}
```

`status` is `settled` or `failed`; failed rows carry an `error_code` (see the
execute error table below).

### `PATCH /api/pay/session/:id`

Update the mutable fields of an **active** session: `label`, `allowed_hosts`,
`max_per_tx_usd` (pass `null` to remove the cap). Budget, network, and expiry
cannot be changed after creation.

```bash
curl -s -X PATCH https://three.ws/api/pay/session/<id> \
  -H 'authorization: Bearer sk_live_...' \
  -H 'content-type: application/json' \
  -d '{ "allowed_hosts": ["three.ws", "api.example.com"] }'
```

Returns `{ "session": { ... } }`. Errors: `400 nothing_to_update` when no
recognized field is present, `404 not_found` when the session is missing, not
yours, or no longer active.

### `DELETE /api/pay/session/:id`

Cancels an `active` or `exhausted` session and refunds the unspent budget to
your credit balance. The refund is idempotent per session.

```json
{ "cancelled": true, "session_id": "0b2f...", "refunded_usd": 0.85 }
```

`404 not_found` if the session does not exist, is not yours, or is already
cancelled or expired. Expired sessions are refunded automatically by the
sweep, so there is nothing left to cancel.

---

## Spending a session

### `POST /api/pay/execute`

Executes one x402 payment against any public https endpoint, using the session
token as the only credential.

Body fields:

| Field | Type | Notes |
|---|---|---|
| `session_token` | string | Required. The `pss_...` token from session creation. |
| `url` | string | Required. Public https endpoint to call. Private and non-public addresses are rejected. |
| `method` | string | `"GET"` (default) or `"POST"`. Anything else is treated as GET. |
| `body` | object or string | Optional JSON body, sent when `method` is POST. |
| `idempotency_key` | string | Optional but recommended. Recorded with the execution; the executions table is unique on it, so duplicate submissions of the same key collapse to a single recorded execution. |

What happens, in order:

1. **Token check.** The token is verified against its stored hash.
2. **Probe.** The endpoint is fetched (SSRF-guarded, 20 s timeout, redirects
   not followed). If it answers with a success and no 402, the call was free:
   you get the response back with `"paid": false` and the session is not
   touched. If it answers with an error status and no 402, there was nothing to
   pay and nothing succeeded, so you get `502 endpoint_error` carrying the real
   `upstream_status` and `upstream_body`. The session is not touched either way.
3. **Accept selection.** From the 402 challenge's `accepts[]`, the platform
   picks a Solana USDC accept (the challenge must offer network `solana...`,
   asset USDC, and a `feePayer` in `extra`). Sessions created with
   `network: "base"` store that preference, but execute settles on Solana
   only; a challenge with no Solana option fails with `no_solana_accept`.
4. **Governance.** Five checks in order: session is active, not expired, host
   is in the allowlist (exact hostname or a subdomain of an allowed host),
   amount is within `max_per_tx_usd`, and remaining budget covers the amount.
   The budget reservation is a single atomic SQL update, so concurrent calls
   can never collectively overspend a session; when two racing calls both fit
   individually but not together, exactly one wins and the other gets
   `insufficient_budget`.
5. **Sign and pay.** The platform Solana payer wallet signs a USDC transfer
   matching the accept and re-requests the endpoint with the `X-PAYMENT`
   header. The service's fee payer covers the transaction fee; your budget is
   charged only the payment amount.
6. **Record.** The execution lands in the session ledger with the settlement
   transaction hash (read from the endpoint's `x-payment-response` header)
   and a Solscan explorer link. On a pre-settlement rejection (the endpoint
   answers 402 again), the reservation is rolled back and your budget is
   restored.

```bash
curl -s https://three.ws/api/pay/execute \
  -H 'content-type: application/json' \
  -d '{
    "session_token": "pss_0b2f..._4f8a...",
    "url": "https://three.ws/api/x402/rate-limit-probe",
    "method": "POST",
    "body": { "endpoint": "/api/x402/forge" },
    "idempotency_key": "probe-2026-07-30-001"
  }'
```

Success:

```json
{
  "ok": true,
  "paid": true,
  "result": { "remaining_calls": 412, "reset_at": "...", "cooldown_active": false },
  "payment": {
    "session_id": "0b2f...",
    "amount_usd": 0.001,
    "network": "solana",
    "payer": "...",
    "pay_to": "...",
    "tx_hash": "5Kd...",
    "explorer": "https://solscan.io/tx/5Kd..."
  },
  "session": { "id": "0b2f...", "spent_usd": 0.001, "remaining_usd": 0.999 },
  "duration_ms": 1843
}
```

Free endpoint (no 402 challenge):

```json
{ "ok": true, "paid": false, "note": "Endpoint served response without a 402 ...", "status": 200, "result": { "...": "..." } }
```

### Execute error codes

| HTTP | Code | Meaning | Budget |
|---|---|---|---|
| 400 | `missing_token`, `missing_url`, `invalid_url` | Request is malformed or the URL is not a public https endpoint. | untouched |
| 400 | `blocked_url` | The target resolves to a private or unreachable address. | untouched |
| 401 | `invalid_token` | Token is malformed, unknown, or does not match its stored hash. | untouched |
| 403 | `session_inactive`, `session_expired` | Session is exhausted, cancelled, or past its expiry. | untouched |
| 403 | `allowlist_blocked` | Target host is not in the session's allowlist. `detail` carries the host and the allowlist. | untouched |
| 402 | `per_tx_exceeded` | The endpoint's price exceeds `max_per_tx_usd`. `detail` carries `amount_usd` and `cap_usd`. | untouched |
| 402 | `insufficient_budget` | Remaining budget cannot cover the price. `detail` carries `need_usd` and `remaining_usd`. | untouched |
| 402 | `payment_rejected` | The service rejected the payment before settlement. | rolled back |
| 422 | `no_solana_accept`, `unsupported_asset`, `missing_fee_payer` | The challenge offers no payable Solana USDC option. | untouched |
| 502 | `endpoint_unreachable`, `invalid_challenge` | Could not reach the endpoint or parse its challenge. | untouched |
| 502 | `endpoint_error` | The endpoint answered an error status with no payment challenge. Carries `upstream_status` and `upstream_body`. | untouched |
| 502 | `build_failed` | Building the Solana transaction failed. | rolled back |
| 502 | `settle_uncertain` | Network failure after signing: chain state unknown. Do not retry immediately; check the session executions and wallet activity first. | kept reserved |
| 502 | `upstream_error` | The endpoint returned a non-402 error after payment. Check wallet activity before retrying. | kept reserved |
| 503 | `wallet_unconfigured` | The platform payer wallet is not configured. | rolled back |

The two "kept reserved" cases are deliberate: funds may have moved on-chain,
so the platform refuses to silently restore budget it cannot prove was
unspent. Both are recorded as `failed` executions with the matching
`error_code`.

---

## Full walkthrough

```bash
BASE=https://three.ws
AUTH='authorization: Bearer sk_live_...'

# 0. Check your credit balance (top up first via POST /api/credits/deposit if empty)
curl -s $BASE/api/credits -H "$AUTH" | jq '{balance_usd, deposit}'

# 1. Create a $0.50 session, capped at $0.01 per call, three.ws only, 24 h
CREATE=$(curl -s $BASE/api/pay/session -H "$AUTH" -H 'content-type: application/json' -d '{
  "label": "walkthrough",
  "budget_usd": 0.50,
  "max_per_tx_usd": 0.01,
  "allowed_hosts": ["three.ws"],
  "expiry_seconds": 86400
}')
TOKEN=$(echo "$CREATE" | jq -r .token)
SID=$(echo "$CREATE" | jq -r .session.id)

# 2. Spend it: pay a $0.001 x402 endpoint (no auth header needed, the token is the credential)
curl -s $BASE/api/pay/execute -H 'content-type: application/json' -d '{
  "session_token": "'$TOKEN'",
  "url": "'$BASE'/api/x402/rate-limit-probe",
  "method": "POST",
  "body": { "endpoint": "/api/x402/forge" },
  "idempotency_key": "walkthrough-1"
}' | jq '{paid, payment, session}'

# 3. Inspect the session and its execution ledger
curl -s $BASE/api/pay/session/$SID -H "$AUTH" | jq .session
curl -s $BASE/api/pay/session/$SID/executions -H "$AUTH" | jq .items

# 4. Cancel and refund the unspent budget back to credits
curl -s -X DELETE $BASE/api/pay/session/$SID -H "$AUTH" | jq .
curl -s $BASE/api/credits -H "$AUTH" | jq .balance_usd
```

## Related

- [x402 Protocol](./x402.md): the challenge / verify / settle mechanics behind every paid call.
- [x402 Buyer Client](./x402-buyer.md): paying x402 endpoints from your own wallet instead of a session.
- [x402 Developer Tools](./x402-dev-tools.md): free echo / debug / receipt-verification tools for debugging a paid call.
