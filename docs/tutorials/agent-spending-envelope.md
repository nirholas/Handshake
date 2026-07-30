# Give an Agent a Spending Envelope (No Private Key)

By the end of this tutorial your agent will be able to buy things on the open internet, in real money, with a hard ceiling you set, and it will never touch a private key to do it. You create a budget from prepaid credits, get back a bearer token, and hand that token to the agent. The agent proposes a spend; the platform's spend governor decides whether to allow it, signs the payment with its own Solana wallet, and writes the result to a ledger you can read. Cancel the session and every unspent cent comes back to your credits.

This is the safe shape for autonomous spending. The usual alternative is to give an agent a funded wallet, which means giving it a key, which means the worst case is "the agent drained the wallet". Here the worst case is "the agent spent the budget you gave it, on hosts you allowed, in increments you capped".

> ## This spends real USDC
>
> Step 6 moves real money on Solana mainnet. It is not a sandbox and there is no undo on a settled payment. Every amount in this tutorial is deliberately tiny: a **$0.05** budget, a **$0.002** per-call cap, and one **$0.001** call. That is one twentieth of a cent per request. Keep those numbers until the whole loop works, then raise them once and watch the ledger.
>
> Steps 1 to 5 and step 7 cost nothing. Step 7 in particular is a full end-to-end wiring test against a free endpoint, so you can prove the plumbing before a single cent leaves your balance. Do it in that order.

**What you'll build:**

- A funded credit balance on three.ws, topped up from a Solana wallet you control
- A Payment Session: a spend envelope with a total budget, a per-call ceiling, a host allowlist, and an expiry
- An agent process holding nothing but a `pss_...` bearer token, calling paid x402 endpoints through `POST /api/pay/execute`
- A real settled payment with an on-chain transaction hash and an explorer link
- The audit trail: a per-session execution ledger showing every attempt, its price, its host, and its outcome
- A clean teardown: cancel the session, refund the remainder, verify the balance came back

**Prerequisites:**

- A three.ws account. Sign in at [three.ws/login](https://three.ws/login).
- A **Solana wallet linked to that account**, holding a little SOL or $THREE. Credits are funded by an on-chain transfer that the platform verifies, and it requires that one of the transaction's signers is a wallet linked to your account. Signing in with the wallet is the simplest way to link it.
- An API key for scripting, from `/dashboard` → **API Keys** → **Create Key**. The session and credits endpoints accept any authenticated bearer token; they do not require a special scope. A browser session cookie works too, and needs no CSRF token on these routes. See the [Authentication guide](/docs/authentication.md).
- `curl` and `jq`. Every command below is copy-pasteable.
- Optional but useful: read the [Payment Sessions reference](/docs/payment-sessions.md) first. This tutorial is the guided path through it; that page is the exhaustive field-by-field contract.

Set these once in your shell and the rest of the tutorial runs as written:

```bash
BASE=https://three.ws
AUTH='authorization: Bearer sk_live_replace_me'
```

---

## Step 1 - Understand what the token is, before you make one

Three things carry money in this system, and confusing them is the only way to get hurt:

| Thing | What it is | Blast radius if leaked |
|---|---|---|
| Your **Solana wallet key** | Actual custody of actual funds | Total. Never goes near an agent. The platform never asks for it. |
| Your **API key** (`sk_live_...`) | Your account identity | Can create sessions, which debits your credits. Treat as a password. Server-side only. |
| A **session token** (`pss_...`) | A time-bounded, capped, host-restricted spending grant | Limited to that session's remaining budget, on that session's allowed hosts, in increments under that session's per-call cap, until that session's expiry. |

Only the third one goes to the agent. That asymmetry is the entire point: the session token is designed to be handed to a process you do not fully trust, because the damage it can do is bounded by policy you wrote and the platform enforces.

The token is shown **exactly once**, at creation. The platform stores only an HMAC-SHA256 hash of it. If you lose it, you cannot recover it; cancel the session (which refunds the remainder) and create a new one.

---

## Step 2 - Check your credit balance

Credits are your prepaid balance, denominated in US dollars. A session's budget is debited from credits at creation and refunded to credits when the session ends.

```bash
curl -s $BASE/api/credits -H "$AUTH" | jq '{balance_usd, lifetime_deposited_usd, deposit}'
```

```json
{
  "balance_usd": 0,
  "lifetime_deposited_usd": 0,
  "deposit": {
    "wallet": "<the platform deposit address, read it from this response>",
    "network": "mainnet",
    "accepts": ["SOL", "THREE"],
    "three_mint": "FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump",
    "three_symbol": "THREE",
    "three_decimals": 6
  }
}
```

Read the deposit address out of this response rather than hardcoding it anywhere. It is served by the API precisely so that it can change without breaking your integration.

If `balance_usd` already covers the $0.05 you need, skip to Step 4.

Unauthenticated calls return `401 unauthorized` with `"sign in to view your credits"`. If you see that, your `AUTH` header is wrong or the key was revoked.

---

## Step 3 - Top up, if you need to

Funding is a two-part move, and the split matters: you send the transfer yourself, from your own wallet, and then you tell the platform to go look at it. The platform never initiates a transfer on your behalf and never needs your key.

1. **Send SOL or $THREE to the deposit wallet** from the Solana wallet linked to your account. Use whatever you normally use: a browser wallet, the CLI, an exchange withdrawal will *not* work because the signer must be your linked wallet. A dollar or two of SOL is plenty for this tutorial and leaves headroom to experiment.

2. **Verify the transfer** and get credited:

```bash
curl -s $BASE/api/credits/deposit \
  -H "$AUTH" \
  -H 'content-type: application/json' \
  -d '{ "asset": "SOL", "tx_signature": "<your transaction signature>", "network": "mainnet" }' | jq
```

```json
{
  "ok": true,
  "replay": false,
  "balance_usd": 2.14,
  "credited_usd": 2.14,
  "asset": "SOL",
  "amount": 0.0134,
  "price_usd": 160,
  "tx_signature": "..."
}
```

The platform reads the transaction on-chain, computes what actually arrived from the pre and post balances, prices it, and credits you. It is server-authoritative: you cannot inflate a deposit by claiming a bigger number, because no number you send is trusted.

Two responses to expect and handle:

- **`{ "ok": false, "pending": true, "status": "awaiting_finalization" }`** means the transaction is confirmed but not yet finalized. This is normal. Wait a few seconds and call again with the same signature.
- **`"replay": true` with `credited_usd: 0`** means that signature and asset were already credited. Crediting is idempotent per (signature, asset), so a retry after a network timeout is always safe.

The one error worth calling out is `403 wallet_not_linked`: the transfer was real but no signer on it is a wallet linked to your account. Sign in with the sending wallet to link it, then re-run the same verify call. The other codes (`tx_not_found`, `tx_failed`, `no_funds_received`, `amount_too_small`) are listed in the [Payment Sessions reference](/docs/payment-sessions.md).

---

## Step 4 - Read the price before you authorize a budget

Never size a budget from a guess. x402 endpoints publish their price in the `402` challenge they return to an unpaid request, and reading that challenge is free. Do it first.

```bash
curl -s $BASE/api/x402/rate-limit-probe | jq '{
  price: [.accepts[] | select(.network | startswith("solana")) | {network, amount, asset, feePayer: (.extra.feePayer != null)}],
  what: .resource.description
}'
```

```json
{
  "price": [
    {
      "network": "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
      "amount": "1000",
      "asset": "<the Solana USDC mint>",
      "feePayer": true
    }
  ],
  "what": "Rate-Limit Capacity Probe - pay $0.001 USDC to learn how many more calls the x402 autonomous loop can make to a target endpoint..."
}
```

Three things to read off that:

- **`amount` is in atomic units**, and USDC has 6 decimals, so `1000` is $0.001. A session's `max_per_tx_usd` is expressed in dollars, so the cap you want here is anything above `0.001`.
- **The accept must be on a `solana...` network** and must carry `extra.feePayer`. `POST /api/pay/execute` settles on Solana only. An endpoint that offers no Solana option fails with `no_solana_accept` and your budget is never touched.
- **The service fee payer covers the Solana transaction fee.** Your budget is charged the payment amount and nothing else.

This same endpoint answers a genuinely useful question (how much x402 capacity is left before a rate limit bites), which is why it makes a good first purchase instead of a throwaway. Browse more at [/bazaar](/bazaar), or read the [x402 protocol doc](/docs/x402.md) for how the challenge is constructed.

---

## Step 5 - Create the session

Now the envelope. Four policy fields do all the work:

```bash
CREATE=$(curl -s $BASE/api/pay/session \
  -H "$AUTH" \
  -H 'content-type: application/json' \
  -d '{
    "label": "capacity watcher",
    "budget_usd": 0.05,
    "max_per_tx_usd": 0.002,
    "allowed_hosts": ["three.ws"],
    "expiry_seconds": 3600,
    "metadata": { "purpose": "tutorial", "owner": "me" }
  }')

TOKEN=$(echo "$CREATE" | jq -r .token)
SID=$(echo "$CREATE" | jq -r .session.id)
echo "session $SID created"
```

The response is `201` and contains the token once:

```json
{
  "session": {
    "id": "0b2f...",
    "label": "capacity watcher",
    "budget_usd": 0.05,
    "spent_usd": 0,
    "remaining_usd": 0.05,
    "max_per_tx_usd": 0.002,
    "allowed_hosts": ["three.ws"],
    "network": "solana",
    "status": "active",
    "expires_at": "2026-07-30T05:00:00.000Z",
    "metadata": { "purpose": "tutorial", "owner": "me" },
    "created_at": "2026-07-30T04:00:00.000Z"
  },
  "token": "pss_0b2f..._4f8a...",
  "note": "Store this token securely. It is shown once and cannot be recovered."
}
```

Why each field matters:

| Field | This tutorial | How to think about it |
|---|---|---|
| `budget_usd` | `0.05` | The total the agent can ever spend on this token. Debited from credits **now**, refunded on cancel. Min $0.001, max $1000. |
| `max_per_tx_usd` | `0.002` | The ceiling on any single call. This is your defence against one expensive endpoint eating the whole envelope in one request. Set it just above the prices you expect, not at the budget. `null` removes the cap; do not do that on a first run. |
| `allowed_hosts` | `["three.ws"]` | Exact hostname or any subdomain of it. A call to any other host fails with `allowlist_blocked` before any money moves. An empty array means **any host**, which is almost never what you want. Max 50 entries. |
| `expiry_seconds` | `3600` | One hour. After this the session stops spending, and a sweep (`/api/cron/payment-session-sweep`, every 5 minutes) refunds the remainder automatically. Min 60, max 7776000 (90 days). |

Two more you did not set: `agent_id` associates the session with one of your agents, and `metadata` is arbitrary JSON stored and echoed back, which is where to put your own correlation IDs.

If your balance cannot cover the budget you get `402 insufficient_credits`, and the message includes both the required and available amounts. Out-of-range values give `400 invalid_budget` or `400 invalid_ttl`.

---

## Step 6 - Hand the token to the agent, and nothing else

The agent process gets one secret, by environment variable, and it is not your API key:

```bash
export THREE_WS_SESSION_TOKEN="$TOKEN"
```

That is the whole handoff. The agent needs no wallet, no seed phrase, no RPC endpoint, no API key, and no knowledge of Solana. If the agent runs on a different machine, in a container, or as a subprocess of an LLM loop, this is the only credential that crosses the boundary.

A useful mental check before you continue: **if this token leaked to a stranger right now, what could they do?** They could spend up to $0.05, in slices of at most $0.002, on `three.ws` only, for the next hour. That is the security model, and it is legible precisely because you wrote all four numbers yourself.

---

## Step 7 - Prove the wiring with a free call (costs nothing)

Before you spend anything, run the exact same code path against an endpoint that does not charge. `POST /api/pay/execute` probes the target first; if the target answers with anything other than `402`, the response comes straight back and the session is not touched at all.

`/api/x402/echo` is a free debug endpoint that reflects whatever you send it. Perfect for this:

```bash
curl -s $BASE/api/pay/execute \
  -H 'content-type: application/json' \
  -d '{
    "session_token": "'"$TOKEN"'",
    "url": "'"$BASE"'/api/x402/echo",
    "method": "GET"
  }' | jq
```

```json
{
  "ok": true,
  "paid": false,
  "note": "Endpoint served response without a 402 - no payment needed.",
  "status": 200,
  "result": { "ok": true, "method": "GET", "headers": { "...": "..." }, "body": null, "ts": "..." }
}
```

`"paid": false` is the signal you are looking for. Your token is valid, your JSON is well-formed, your network path works, and your budget is still exactly $0.05. Confirm that:

```bash
curl -s $BASE/api/pay/session/$SID -H "$AUTH" | jq '.session | {spent_usd, remaining_usd, status}'
```

While you are here, prove the allowlist works too. This is also free, because governance runs before anything is signed:

```bash
curl -s $BASE/api/pay/execute \
  -H 'content-type: application/json' \
  -d '{ "session_token": "'"$TOKEN"'", "url": "https://example.com/anything" }' | jq
```

```json
{
  "error": "allowlist_blocked",
  "error_description": "Host example.com is not in this session's allowlist",
  "detail": { "host": "example.com", "allowlist": ["three.ws"] }
}
```

Good. The policy is not decorative.

---

## Step 8 - Spend it

This is the step that moves money. One call, $0.001.

```bash
curl -s $BASE/api/pay/execute \
  -H 'content-type: application/json' \
  -d '{
    "session_token": "'"$TOKEN"'",
    "url": "'"$BASE"'/api/x402/rate-limit-probe",
    "method": "POST",
    "body": { "endpoint": "/api/x402/forge" },
    "idempotency_key": "envelope-tutorial-001"
  }' | jq '{paid, payment, session, duration_ms}'
```

```json
{
  "paid": true,
  "payment": {
    "session_id": "0b2f...",
    "amount_usd": 0.001,
    "network": "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
    "payer": "<platform payer wallet>",
    "pay_to": "<the service's receiving wallet>",
    "tx_hash": "5Kd...",
    "explorer": "https://solscan.io/tx/5Kd..."
  },
  "session": { "id": "0b2f...", "spent_usd": 0.001, "remaining_usd": 0.049 },
  "duration_ms": 1843
}
```

Open the `explorer` link. There is a real transfer there, on mainnet, for a tenth of a cent. That is the whole thesis of this tutorial made concrete: an agent bought something, and the only thing it was ever given was a policy-bounded token.

**Always send an `idempotency_key`.** The executions table is unique on it, so if your HTTP client retries after a timeout, the duplicate submission collapses to a single recorded execution instead of double-charging. Make it deterministic from the work you are doing (a job ID, a date plus a counter), not random.

What just happened inside the platform, in order:

1. **Token check** against the stored hash.
2. **Probe.** The endpoint is fetched with an SSRF-guarded client (20 second timeout, redirects not followed) to read its `402` challenge.
3. **Accept selection.** A Solana USDC accept with a `feePayer` is picked out of `accepts[]`.
4. **Governance.** Five checks in order: session active, not expired, host allowed, amount under `max_per_tx_usd`, remaining budget sufficient. The budget reservation is a single atomic SQL update, so concurrent calls can never collectively overspend the envelope. If two racing calls each fit individually but not together, exactly one wins and the other gets `insufficient_budget`.
5. **Sign and pay.** The platform's Solana payer wallet signs a USDC transfer matching the accept and re-requests the endpoint with an `X-PAYMENT` header.
6. **Record.** The execution lands in the session ledger with the settlement transaction hash and an explorer link.

Your agent's code did not participate in steps 2 through 6. It named a URL and a price ceiling. That is the division of labour: **the agent proposes spend; governance enforces policy.**

---

## Step 9 - Read the ledger

Two reads, both cheap, both worth wiring into whatever dashboard you already have.

The session's current state:

```bash
curl -s $BASE/api/pay/session/$SID -H "$AUTH" \
  | jq '.session | {status, budget_usd, spent_usd, remaining_usd, max_per_tx_usd, allowed_hosts, expires_at}'
```

And every payment attempt it made, newest first:

```bash
curl -s "$BASE/api/pay/session/$SID/executions" -H "$AUTH" | jq '.items'
```

```json
[
  {
    "id": "...",
    "endpoint_url": "https://three.ws/api/x402/rate-limit-probe",
    "endpoint_host": "three.ws",
    "method": "POST",
    "amount_usd": 0.001,
    "network": "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
    "tx_hash": "5Kd...",
    "payer_address": "...",
    "payee_address": "...",
    "status": "settled",
    "error_code": null,
    "duration_ms": 1843,
    "created_at": "2026-07-30T04:01:00.000Z"
  }
]
```

Failures are recorded here too, with `status: "failed"` and an `error_code`, which makes this the first place to look when an agent claims it could not buy something. Both endpoints paginate with `limit` (default 20, max 100) and `cursor`.

For the account-wide view, `GET /api/pay/session` lists all your sessions newest-first and adds aggregate `stats`: session counts by status, total budget, total spent, settled and failed execution counts, and how many distinct endpoints you have paid.

```bash
curl -s $BASE/api/pay/session -H "$AUTH" | jq .stats
```

---

## Step 10 - Tighten the policy without restarting the agent

An active session's policy is mutable. `label`, `allowed_hosts`, and `max_per_tx_usd` can all be changed in place, and the change applies to the next call the agent makes. The token does not rotate, so the agent never notices.

```bash
# Lower the per-call ceiling to $0.0015 and add a second allowed host.
curl -s -X PATCH $BASE/api/pay/session/$SID \
  -H "$AUTH" -H 'content-type: application/json' \
  -d '{ "max_per_tx_usd": 0.0015, "allowed_hosts": ["three.ws", "api.example.com"] }' \
  | jq '.session | {max_per_tx_usd, allowed_hosts}'
```

Budget, network, and expiry are immutable after creation. That is deliberate: those three are the guarantees you gave yourself, and a mutable budget is not a budget. If you need more headroom, cancel and create a new session, or run a second one alongside.

Pass `"max_per_tx_usd": null` to remove the cap entirely. `400 nothing_to_update` means none of the three recognized fields was present.

---

## Step 11 - Wire it into an agent loop

Everything above as the code an agent actually runs. Note what is absent: no wallet library, no key handling, no chain RPC, no retry-on-chain logic.

```js
// spender.js - the entire payment capability of an agent, in 40 lines.
const BASE = 'https://three.ws';
const TOKEN = process.env.THREE_WS_SESSION_TOKEN;
if (!TOKEN) throw new Error('THREE_WS_SESSION_TOKEN is required');

/**
 * Buy one thing. Returns { paid, result } on success.
 * Throws a labelled error the caller can branch on.
 */
async function buy(url, { method = 'GET', body = null, idempotencyKey } = {}) {
  const res = await fetch(`${BASE}/api/pay/execute`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      session_token: TOKEN,
      url,
      method,
      ...(body ? { body } : {}),
      ...(idempotencyKey ? { idempotency_key: idempotencyKey } : {}),
    }),
  });
  const data = await res.json();

  if (res.ok) {
    return { paid: data.paid === true, result: data.result, payment: data.payment ?? null };
  }

  // Budget exhausted or policy refused: a normal, expected outcome. Stop cleanly.
  if (['insufficient_budget', 'per_tx_exceeded', 'allowlist_blocked',
       'session_inactive', 'session_expired'].includes(data.error)) {
    const err = new Error(data.error_description || data.error);
    err.code = data.error;
    err.terminal = true;
    throw err;
  }

  // Chain state unknown: never retry blind. Read the ledger first.
  if (['settle_uncertain', 'upstream_error'].includes(data.error)) {
    const err = new Error(`${data.error}: check the session ledger before retrying`);
    err.code = data.error;
    err.terminal = true;
    throw err;
  }

  const err = new Error(data.error_description || data.error || `HTTP ${res.status}`);
  err.code = data.error;
  throw err;
}

// The agent's actual job: watch remaining x402 capacity, stop when the envelope runs out.
for (let i = 1; i <= 5; i++) {
  try {
    const { paid, result, payment } = await buy(`${BASE}/api/x402/rate-limit-probe`, {
      method: 'POST',
      body: { endpoint: '/api/x402/forge' },
      idempotencyKey: `capacity-check-${new Date().toISOString().slice(0, 10)}-${i}`,
    });
    console.log(`check ${i}:`, result, paid ? `(paid ${payment.amount_usd} USD, ${payment.tx_hash})` : '(free)');
  } catch (err) {
    console.error(`check ${i} stopped: ${err.code} - ${err.message}`);
    if (err.terminal) break;
  }
  await new Promise((r) => setTimeout(r, 5000));
}
```

Run it with a session token in the environment and it will buy until the envelope is empty, then stop with `insufficient_budget`. That is the behaviour you want from an autonomous spender: it hits a wall you built, and the wall holds.

The two `terminal` branches are the important design decision. `insufficient_budget` and friends mean "policy said no", which is not an error to retry. `settle_uncertain` and `upstream_error` mean "money may have moved and we cannot prove otherwise", which is emphatically not an error to retry. Both stop the loop; only one of them needs a human to look at the ledger.

---

## Step 12 - Cancel and get the refund

Teardown is one call, and it is the reason a tight expiry costs you nothing.

```bash
curl -s -X DELETE $BASE/api/pay/session/$SID -H "$AUTH" | jq
```

```json
{ "cancelled": true, "session_id": "0b2f...", "refunded_usd": 0.049 }
```

The unspent $0.049 is back in credits immediately. Verify:

```bash
curl -s $BASE/api/credits -H "$AUTH" | jq '{balance_usd, ledger: [.ledger[0]]}'
```

The refund is idempotent per session, so a repeated DELETE returns `404 not_found` rather than refunding twice. Sessions that pass their expiry while still active are refunded automatically by the 5-minute sweep, so there is nothing to clean up manually if you simply walk away.

Session `status` after teardown is one of:

| Status | Means |
|---|---|
| `active` | Spending allowed |
| `exhausted` | Budget fully spent. Can still be cancelled (refund will be $0). |
| `cancelled` | You called DELETE. Remainder refunded. |
| `expired` | Passed `expires_at`. The sweep refunded the remainder. |

---

## Troubleshooting

| Response | Meaning | Fix |
|---|---|---|
| `401 unauthorized` on `/api/credits` or `/api/pay/session` | Missing or bad bearer token | Check the `AUTH` header. Keys are shown once at creation; if you lost it, make a new one. |
| `400 missing_token` on execute | No `session_token` in the JSON body | Execute authenticates with the session token in the **body**, not an `Authorization` header. |
| `401 invalid_token` | Token malformed, unknown, or does not match its hash | The token is unrecoverable by design. Cancel the session and create a new one. |
| `402 insufficient_credits` on create | Balance below `budget_usd` | Top up (Step 3). The message states required and available. |
| `403 allowlist_blocked` | Target host not in `allowed_hosts` | `detail` carries the host and the allowlist. PATCH the session to add the host, or fix the URL. Subdomains of an allowed host are allowed. |
| `402 per_tx_exceeded` | Endpoint costs more than `max_per_tx_usd` | `detail` carries `amount_usd` and `cap_usd`. Raise the cap deliberately or pick a cheaper endpoint. |
| `402 insufficient_budget` | Remaining budget below the price | Expected end state. Create a new session, or note that a concurrent call won the race. |
| `422 no_solana_accept` | The endpoint offers no Solana option | Execute settles on Solana only. Endpoints that are Base-only cannot be paid through a session; pay those with your own client (see [x402 Buyer Client](/docs/x402-buyer.md)). |
| `422 unsupported_asset` / `missing_fee_payer` | The Solana accept is not USDC, or omits `extra.feePayer` | Not fixable from your side. Report it to the endpoint's operator. |
| `502 endpoint_unreachable` / `invalid_challenge` | Could not reach or parse the endpoint | Probe it yourself with a plain `curl` (Step 4). Budget untouched. |
| `502 settle_uncertain` | Network failure **after** signing | Do not retry. Read `GET /api/pay/session/:id/executions` and the payer wallet's activity first. Budget stays reserved on purpose. |
| `502 upstream_error` | Endpoint returned a non-402 error after payment | Same rule: check the ledger before retrying. Budget stays reserved. |
| `503 wallet_unconfigured` | Platform payer wallet is not configured in this environment | Nothing to fix client-side. Budget is rolled back. |
| `429` with `Retry-After` | Session and credits routes share a strict bucket (50 requests per 10 minutes per IP); `GET /api/credits` uses the read bucket (300 per 5 minutes) | Honour `Retry-After`. Do not poll the ledger in a tight loop. |

The two "budget stays reserved" cases are the only place the system deliberately declines to give money back, and it is the right call: funds may have moved on-chain, and the platform refuses to silently restore budget it cannot prove was unspent. Both are recorded as `failed` executions with the matching `error_code`, so the evidence is always in the ledger.

---

## What you learned

- The three-credential model, and why only the weakest one ever reaches an agent
- How to fund credits from a Solana wallet with a server-verified, idempotent deposit
- How to read an x402 price for free before authorizing any budget
- The four policy fields that define an envelope, and which of them are deliberately immutable
- How to prove the entire payment path against a free endpoint before spending a cent
- What the spend governor checks, in what order, and why the budget reservation is atomic
- How to read the execution ledger, and which two failure codes must never be retried blind
- Cancel-and-refund, plus the automatic sweep that makes short expiries free

## Next steps

- Build the other side of the trade: an endpoint that *charges* agents, in [Build a paid x402 endpoint](/docs/tutorials/paid-x402-endpoint.md).
- Pay from your own wallet instead of a platform-managed envelope, in [Discover and pay for an x402 service](/docs/tutorials/pay-for-x402-service.md).
- Debug a payment that misbehaved with the free echo, debug, and receipt-verification tools in [x402 Developer Tools](/docs/x402-dev-tools.md).
- Give the spending agent a body and a personality so a human can watch it work: [Give your agent a personality](/docs/tutorials/agent-personality.md).
- Read the full field-by-field contract in the [Payment Sessions reference](/docs/payment-sessions.md).
