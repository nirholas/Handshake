---
title: "Give your AI agent a budget, not a private key"
venue: AWS Builder Center
account: three.ws (official)
status: draft
description: "An autonomous agent that pays for tools needs spending power, and every shortcut for granting it ends with a private key inside a prompt-injectable loop. Here is the pattern we shipped instead: a Payment Session that separates custody from authority from execution, enforced atomically in Postgres, with the real code, the race condition, and the failure mode nobody writes about."
tags: [agentic-ai, ai-agents, security, serverless, api]
index: docs/aws-builder-center.md
---

# Give your AI agent a budget, not a private key

There is a moment in every agentic build where the agent needs to buy something.

Maybe it is a paid data feed mid-reasoning. Maybe it is another agent's tool. Maybe it is a rendering job it decided to queue. Whatever it is, the agent has hit a `402 Payment Required` and the loop stops, because the one thing your agent does not have is spending power.

So you give it some. And this is where most designs quietly go wrong.

The obvious move is to put a wallet key in the agent's environment. It works immediately, which is the problem: you have now placed an unbounded bearer credential inside a system whose entire job is to read untrusted text and decide what to do next. Prompt injection is not a hypothetical against that design. It is the design's specification.

This is a walk through the pattern we shipped instead, in production, at [three.ws](https://three.ws). It is called a **Payment Session**, and the one-line version is:

> The agent does not hold a wallet. It proposes spend. Governance enforces policy.

Everything below is real code from our source-available repository, including the concurrency bug we had to design around and the failure mode that has no clean answer.

## The three bad options, and what each one actually costs

Before the pattern, the alternatives, because the pattern only looks good next to them.

| Approach | What the agent holds | What a compromise costs you | Why teams pick it |
|---|---|---|---|
| Hand the agent a wallet key | Full signing authority, forever | Everything in the wallet, plus everything the key can authorize later | It takes four minutes |
| Give the agent a funded burner wallet | Full authority over a smaller pot | The burner's balance, plus a refill treadmill and dust stranded across dozens of addresses | It feels bounded |
| Human-in-the-loop on every payment | Nothing | Nothing, but the agent is no longer autonomous | It is defensible in a review |

The burner wallet is the interesting failure, because it looks like the right answer. It is bounded, so a compromise is capped. But you have replaced a security problem with an operations problem: every agent now needs funding, refunding, and sweeping, and capital disperses one way into wallets that never send it back. We ran a fleet like this. The dispersion, not the theft, is what hurt.

What all three share is a category error. They conflate three separate concerns that only look like one:

- **Custody**: who holds the key that signs.
- **Authority**: who decides how much may be spent, on what, and until when.
- **Execution**: who initiates a given payment.

A private key fuses all three into one secret. Split them apart and the design gets much better very quickly.

## The pattern

```
   Developer                    Platform                        Agent
   ─────────                    ────────                        ─────
   funds a budget    ──────>    holds the keys        <──────   proposes a payment
   sets the policy   ──────>    enforces the policy   ──────>   gets the result
                                signs the tx
                                logs everything
```

The developer creates a session: a budget envelope with a total, a per-transaction ceiling, a host allowlist, a network, and an expiry. In return they get a bearer token, once.

They hand that token to the agent. The agent can now call paid endpoints. It cannot exceed the budget, cannot pay a host outside the allowlist, cannot spend after the expiry, and cannot sign anything itself, because the platform's wallet does the signing and the agent never sees a key.

Custody sits with the platform. Authority sits with the developer. Execution sits with the agent. Compromising the agent gets an attacker exactly one thing: the remaining budget, spendable only at hosts you already approved, only until the session expires.

That is not zero. It is a number you chose in advance, which is the entire point.

## The data model

Two tables. The session is the policy plus the counter, and the execution log is the immutable audit trail.

```sql
create table if not exists payment_sessions (
    id                  uuid primary key default gen_random_uuid(),
    user_id             uuid not null references users(id) on delete cascade,
    agent_id            uuid references agent_identities(id) on delete set null,

    label               text not null default '',
    budget_usdc         bigint not null check (budget_usdc > 0),
    spent_usdc          bigint not null default 0 check (spent_usdc >= 0),
    max_per_tx_usdc     bigint check (max_per_tx_usdc > 0),
    allowed_hosts       text[] not null default '{}',
    network             text not null default 'solana' check (network in ('solana', 'base')),

    status              text not null default 'active'
                            check (status in ('active', 'exhausted', 'expired', 'cancelled')),
    expires_at          timestamptz not null,
    token_hash          text not null,

    session_metadata    jsonb not null default '{}'::jsonb,
    created_at          timestamptz not null default now(),
    updated_at          timestamptz not null default now()
);
```

Three details in there are load-bearing.

**Money is `bigint`, never `float`.** USDC has six decimals, so every amount is stored in atomic units and converted at the edges. A rounding error in a budget check is a security bug, not a display bug.

```js
export function usdToAtomics(usd) {
  return BigInt(Math.round(Number(usd) * 1_000_000));
}
export function atomicsToUsd(atomics) {
  return Number(atomics) / 1_000_000;
}
```

**`spent_usdc` lives on the session row, not derived from the log.** It is tempting to compute spend with `SELECT sum(amount) FROM executions`. Do not. That number has to be checked and incremented in the same atomic operation as the authorization decision, and a sum over a second table cannot give you that without a lock you will regret. The log reconciles the counter; it does not replace it.

**The token is never stored.** Only its HMAC is:

```js
const TOKEN_PREFIX = 'pss_';

export function generateSessionToken(sessionId) {
  const rand = randomBytes(16).toString('hex');
  return `${TOKEN_PREFIX}${sessionId}_${rand}`;
}

export function hashToken(token) {
  return createHmac('sha256', hmacKey()).update(String(token)).digest('hex');
}
```

The session id is embedded in the token so lookup is a primary-key hit rather than a table scan over hashes, and verification is `WHERE id = $1 AND token_hash = $2`. A dumped database row is inert without the HMAC key; a leaked token is bounded by the policy on the row it points at.

## The request path

The agent makes one call: `POST /api/pay/execute` with a session token and a URL. Six phases run behind it.

### Phase 0: verify the token before touching the network

```js
try {
  await verifySessionToken(sessionToken);
} catch (err) {
  if (err instanceof SpendGovernorError) {
    return error(res, err.status, err.code, err.message, err.detail);
  }
  throw err;
}
```

Cheap check first. There is no reason to make an outbound request on behalf of a token that does not exist.

### Phase 1: probe for the payment challenge

x402 works over ordinary HTTP. You request the resource, and a paid endpoint answers `402` with a JSON body describing what it will accept: network, asset, amount, and where to send it. So we ask before we authorize, because until the endpoint tells us the price, there is no amount to check the policy against.

```js
let accept = challenge.accepts.find(
  (a) => typeof a?.network === 'string' &&
    a.network.startsWith('solana') &&
    a.asset === USDC_SOLANA_MINT,
);
```

If the endpoint answers with something other than a `402`, it was free, and we return the response without ever touching the session:

```js
if (probeResult.free) {
  return json(res, 200, {
    ok: true,
    paid: false,
    note: 'Endpoint served response without a 402. No payment needed.',
    status: probeResult.status,
    result: probeResult.result,
  });
}
```

Small thing, easy to skip, and it matters: an agent should not burn budget discovering that something was free.

### Phase 2: the governor

Now the policy runs, in order, cheapest and most decisive first: status, then expiry, then the allowlist, then the per-transaction ceiling, then the budget.

The allowlist check is the one worth showing, because the subdomain rule is where these go wrong:

```js
const canonicalAllowlist = allowedHosts.map(normalizeHost).filter(Boolean);
const allowed = canonicalAllowlist.some(
  (h) => targetHost === h || targetHost.endsWith(`.${h}`),
);
```

`targetHost.endsWith('.' + h)` and not `targetHost.endsWith(h)`. Without the dot, an allowlist entry of `example.com` also authorizes `evil-example.com`, and an attacker who can steer your agent to a URL just needs to register the right domain. Hosts are normalized through the URL parser first, so `HTTPS://Example.COM:443/x` and `example.com` compare equal.

### Phase 3: the atomic reservation

Here is the concurrency bug, and it is not a theoretical one. Agents are concurrent by nature. A single agent run can have three tool calls in flight, and a multi-agent orchestrator can have thirty.

Read-then-write does not work:

```
Session budget: $1.00 remaining

Request A: SELECT remaining -> $1.00. Enough for $0.80? Yes.
Request B: SELECT remaining -> $1.00. Enough for $0.80? Yes.
Request A: UPDATE spent = spent + 0.80
Request B: UPDATE spent = spent + 0.80

Spent: $1.60 against a $1.00 budget.
```

The fix is to make the check and the increment the same statement, and let the database resolve the race:

```js
const [updated] = await sql`
  UPDATE payment_sessions
  SET spent_usdc = spent_usdc + ${amount.toString()},
      updated_at = now()
  WHERE id = ${session.id}
    AND status = 'active'
    AND (budget_usdc - spent_usdc) >= ${amount.toString()}
  RETURNING id, spent_usdc, budget_usdc
`;
```

Row-level locking means the second `UPDATE` re-evaluates its `WHERE` clause against the first one's committed result. It matches zero rows, `updated` is undefined, and the caller gets a precise error rather than an overdraft:

```js
if (!updated) {
  const [fresh] = await sql`
    SELECT budget_usdc, spent_usdc FROM payment_sessions WHERE id = ${session.id}
  `;
  const remaining = fresh ? BigInt(fresh.budget_usdc) - BigInt(fresh.spent_usdc) : 0n;
  throw new SpendGovernorError(
    'insufficient_budget',
    `Insufficient session budget. Need $${atomicsToUsd(amount)}, remaining $${atomicsToUsd(remaining)}`,
    { need_usd: atomicsToUsd(amount), remaining_usd: atomicsToUsd(remaining) },
  );
}
```

No advisory locks, no transaction retry loop, no distributed lock service. One statement whose `WHERE` clause is the invariant. If you take one thing from this article, take this: **write the budget check as a predicate in the `UPDATE`, not as a `SELECT` before it.**

Note that this is a *reservation*, taken before the payment is attempted. Optimistic ordering, because the alternative is holding budget open across a network call to a third party.

### Phase 4: sign and present

The platform payer signs a Solana USDC transfer, serializes it, and presents it in the `X-PAYMENT` header on a retry of the original request. The agent's token never enters this path, and the keypair never leaves the server.

```js
const xPayment = Buffer.from(JSON.stringify(paymentPayload)).toString('base64');

paid = await guardedFetch(targetUrl, {
  method,
  body: requestBody,
  headers: { 'X-PAYMENT': xPayment },
});
```

`guardedFetch` is not `fetch`. More on that below.

### Phase 5: settle, or fail honestly

This is the section most write-ups skip, and it is the one that decides whether you can run this in production.

A payment has three possible outcomes, not two, and the third is the interesting one.

**Rejected before settlement.** The service answers `402` again. No funds moved, so the reservation is safe to release and the budget goes back:

```js
if (paid.status === 402) {
  await rollbackReservation(sessionRecord.id, amountAtomics).catch(() => {});
  // ... record the failed execution ...
  return error(res, 402, 'payment_rejected',
    'Service rejected the payment before settlement. Budget has been restored.');
}
```

**Settled.** Log the tx hash, return the result, done.

**Unknown.** The request was submitted and the connection died before an answer came back. The transaction may have landed on-chain. It may not have. We cannot know from here.

```js
} catch (err) {
  // Network failure AFTER signing: chain state unknown, do NOT roll back.
  await recordExecution({
    /* ... */
    status: 'failed',
    errorCode: 'settle_uncertain',
    errorMessage: err?.message,
  }).catch(() => {});
  return error(res, 502, 'settle_uncertain',
    'Payment was submitted but confirmation was not received. Do not retry immediately.');
}
```

The comment carries the whole decision: **do not roll back.** Restoring the budget after a payment that may have settled means the next call can spend money that is already gone. So the session stays debited, the execution is logged as `settle_uncertain`, and the error message tells the caller not to retry blindly.

This is worse for the user than an automatic refund and better than a silent double-spend. When you cannot know the truth, bias the accounting toward the conservative answer and make the uncertainty legible instead of hiding it. Every payment system reaches this fork. Most of them pretend they do not.

Idempotency is the companion control. Every execution can carry a caller-supplied key with a `unique` constraint behind it, so a retried run cannot bill twice:

```sql
idempotency_key     text unique,
```

## The target URL is attacker-influenced. Treat it that way.

Step back and look at what this endpoint does: it takes a URL chosen (at least partly) by an LLM and makes a server-side request to it, from inside your infrastructure. That is a server-side request forgery primitive with a payment attached.

So the fetch is guarded, and the guard runs before the payment is signed:

```js
async function guardedFetch(rawUrl, { method = 'GET', headers = {}, body } = {}) {
  const url = validatePublicUrl(rawUrl);
  const addrs = await resolvePublicHost(url.hostname);
  const agent = pinnedAgent(url.hostname, addrs);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method,
      redirect: 'manual',
      signal: controller.signal,
      dispatcher: agent,
      /* ... */
    });
```

Four controls, each closing a specific hole:

- `validatePublicUrl` rejects non-public schemes and address ranges: link-local, loopback, private space, and the cloud metadata endpoint at `169.254.169.254` that turns SSRF into credential theft on every major cloud.
- `resolvePublicHost` resolves DNS and validates the answers, so a hostname that resolves into private space is caught.
- `pinnedAgent` pins the connection to the addresses that were validated. Without this you have a DNS rebinding window between the check and the connect.
- `redirect: 'manual'` stops a public URL from bouncing you to an internal one after validation has already passed.

The allowlist is policy. This is the floor underneath it, and it applies even when a session sets no allowlist at all.

## Wiring it into an agent

The interface is an MCP server, so any client that speaks the Model Context Protocol gets these as ordinary tools. Nothing here is specific to a particular agent framework: it is an npm bridge to an HTTP API, so it drops into a Bedrock AgentCore agent, a Strands agent, a Claude Code session, or your own loop, without caring where the agent runs.

```json
{
  "mcpServers": {
    "three-ws-payments": {
      "command": "npx",
      "args": ["-y", "@three-ws/agentcore-payments-mcp"],
      "env": {
        "THREE_WS_SESSION": "__Host-sid=...",
        "PAYMENT_SESSION_TOKEN": "pss_..."
      }
    }
  }
}
```

Create a session with the policy you are willing to live with:

```json
{
  "budget_usd": 10.00,
  "label": "Research agent, June sprint",
  "expiry_seconds": 86400,
  "max_per_tx_usd": 0.50,
  "allowed_hosts": ["api.example.com", "data.provider.io"],
  "network": "solana"
}
```

Then the agent pays:

```json
{
  "url": "https://api.example.com/data",
  "method": "GET",
  "session_token": "pss_...",
  "idempotency_key": "run-42-fetch-data"
}
```

It gets back the result it wanted plus the receipt it did not ask for: amount, network, payer, payee, transaction hash, explorer link, and the updated budget. The audit trail is a side effect of the design rather than an integration you have to remember to add.

```json
{
  "ok": true,
  "paid": true,
  "result": { "...": "the endpoint's response" },
  "payment": {
    "amount_usd": 0.05,
    "network": "solana",
    "tx_hash": "...",
    "explorer": "https://solscan.io/tx/...",
    "pay_to": "..."
  },
  "session": { "spent_usd": 1.35, "remaining_usd": 8.65 }
}
```

## Budgets that expire have to give the money back

A budget is debited from the developer's credit balance the moment the session is created, which means an expiry that just marks a row `expired` quietly keeps their money. A sweep runs every five minutes and refunds the difference:

```js
const allExpired = await sql`
  UPDATE payment_sessions
  SET status = 'expired', updated_at = now()
  WHERE status = 'active'
    AND expires_at < now()
  RETURNING id, user_id, budget_usdc, spent_usdc
`;
```

Then, per row, with an idempotency key derived from the session id so overlapping ticks cannot double-refund:

```js
await creditAccount({
  userId: row.user_id,
  amountUsd: atomicsToUsd(refundAtomics),
  kind: 'refund',
  action: 'payment_session_expire',
  refType: 'payment_session',
  refId: row.id,
  idempotencyKey: `paysess_expire_${row.id}`,
});
```

The same refund path runs on manual cancellation. Short-lived sessions are the security posture we want people to adopt, so expiring one has to be free. If it costs the user money, they will set the TTL to a year and the control is gone.

## What we would tell you to copy

The specifics here are Solana, USDC, Postgres, and x402, and none of that is the transferable part. The pattern is:

1. **Separate custody, authority, and execution.** Whatever your rail (a card token, an internal ledger, a cloud budget), do not let one credential carry all three. Everything else follows from this.
2. **Give the agent a grant, not a key.** Bounded by amount, by destination, and by time. Then a compromise costs a number you picked instead of a number an attacker picks.
3. **Enforce the budget as a predicate in the write.** `UPDATE ... WHERE remaining >= amount RETURNING` is the whole concurrency story. Read-then-write is an overdraft waiting for enough traffic.
4. **Design the uncertain outcome first.** Success and rejection are easy. The submitted-but-unconfirmed case is the one that decides whether your accounting can be trusted, and it deserves an explicit state rather than a `catch` that guesses.
5. **Assume the URL is hostile.** Any agent-driven outbound request is an SSRF primitive. Validate, resolve, pin, and refuse redirects, before anything is signed.
6. **Make expiry cheap.** Refund on expiry and on cancel, idempotently, or nobody will use short sessions.

An autonomous agent with a private key is a liability you cannot bound. An autonomous agent with a budget is a line item. The difference is about four hundred lines of code, and most of them are the boring ones.

## Resources

- **Source:** [`api/pay/execute.js`](https://github.com/nirholas/three.ws/blob/main/api/pay/execute.js) is the request path, [`api/_lib/pay/spend-governor.js`](https://github.com/nirholas/three.ws/blob/main/api/_lib/pay/spend-governor.js) is the governor, [`api/_lib/pay/payment-session.js`](https://github.com/nirholas/three.ws/blob/main/api/_lib/pay/payment-session.js) is the lifecycle
- **MCP server:** [`@three-ws/agentcore-payments-mcp`](https://github.com/nirholas/three.ws/tree/main/packages/agentcore-payments-mcp)
- **x402:** [x402.org](https://www.x402.org), the HTTP-native pay-per-call standard the payments settle over
- **Model Context Protocol:** [modelcontextprotocol.io](https://modelcontextprotocol.io)
- **Our previous Builder Center article:** [How we metered a SaaS product through AWS Marketplace with the AWS SDK for JavaScript v3](https://builder.aws.com/content/3ESpll50BdSp9eiCEIxcfG9pGUN/how-we-metered-a-saas-product-through-aws-marketplace-with-the-aws-sdk-for-javascript-v3), which covers the other half of this: how the credits that fund a session get billed to an AWS invoice

---

*three.ws is a verified AWS Partner and an open-source platform for 3D AI agents and on-chain communities, available on AWS Marketplace with AWS billing wired into its metered API. Live at [three.ws](https://three.ws).*
