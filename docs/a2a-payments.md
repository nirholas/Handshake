# Autonomous agent-to-agent payments

One three.ws agent can pay another agent's paid endpoint without a human
approving each payment. This is the developer reference for that path: how the
authorization is issued, which gates every payment passes, what the payment
leaves behind, and how to stop an agent that has gone wrong.

> Source: issue a mandate
> [`api/agents/a2a-mandate.js`](../api/agents/a2a-mandate.js), pay a peer
> [`api/agents/a2a-call.js`](../api/agents/a2a-call.js), the shared spend policy
> [`api/_lib/agent-trade-guards.js`](../api/_lib/agent-trade-guards.js), the
> owner surfaces (limits, custody ledger) in
> [`api/agents/solana-wallet.js`](../api/agents/solana-wallet.js), the economy
> statement [`api/agents/[id]/economy.js`](../api/agents/%5Bid%5D/economy.js).
> The whole chain is proven end to end by
> [`scripts/a2a-spend-hardening-proof.mjs`](../scripts/a2a-spend-hardening-proof.mjs).

Related: [the agent wallet control API](./agent-wallet-api.md) for the other
owner-only wallet surfaces, [financial controls](./financial-controls.md) for
the platform-wide picture, and [agent economy volume](./agent-economy-volume.md)
for what settled A2A payments add up to.

---

## The shape of the problem

An **Intent Mandate** is a signed, offline-verifiable bearer credential: the
user's recorded consent that a named agent may spend up to a total budget, with
a per-call cap, on named networks, for up to 90 days. That is what makes
autonomy possible, and it is also why the mandate cannot be the whole safety
story. A bearer credential has no revocation of its own: whoever holds it can
spend its remaining budget until it expires.

So every autonomous payment also runs through the agent's own server-side spend
policy, the same one the trade, snipe, x402 and withdraw paths already use. That
policy is stored on the agent, read fresh on every payment, and editable at any
moment by the owner. It is what makes an outstanding mandate stoppable.

## The gates, in order

`POST /api/agents/a2a-call` refuses at the first gate that says no, and nothing
downstream of a refusal happens: no peer is contacted, no key is touched, no
token moves.

| # | Gate | What it decides | Refusal code |
|---|------|-----------------|--------------|
| 1 | Mandate signature + ownership | Is this a real mandate, issued to this user, still unexpired? | `invalid_mandate`, `mandate_expired`, `mandate_not_yours` |
| 2 | Subject agent | Does the agent the mandate names still exist, and is it still this user's? | `agent_not_found`, `agent_not_yours` |
| 3 | Kill switch | Is the agent halted? Checked before the peer is even quoted | `wallet_frozen` |
| 4 | Mandate per-call policy | Is this amount, network, currency and resource inside what was authorized? | `amount_over_per_call`, `currency_mismatch`, `network_not_allowed`, `resource_not_allowed` |
| 5 | Peer reputation (opt-in) | Does the peer clear the caller's ERC-8004 trust bar? | `reputation_too_low`, `reputation_too_few_reviews`, `reputation_unavailable` |
| 6 | Mandate cumulative budget | Would lifetime spend under this mandate exceed its total cap? | `budget_exceeded` |
| 7 | The agent's own spend policy | Per-transaction, rolling-daily and per-counterparty ceilings, the owner's plain-English rules, the anomaly guard, any scoped capability | `per_tx_exceeded`, `daily_exceeded`, `counterparty_daily_exceeded`, `policy_blocked`, `policy_step_up`, `policy_freeze`, `wallet_anomaly_frozen`, `capability_required` |

Gate 7 is atomic: it enforces the ceilings **and** writes the payment's pending
receipt row in one statement under a per-agent advisory lock, so concurrent
calls cannot all pass on the same stale daily total. If the payment then fails
to settle, the row is released and stops counting toward the day.

### The policy is resolved fail-closed

The guards take the policy as `limits` (already read), as `meta` (the agent's
blob), or as neither. With neither, they read the agent's real policy from its
row. There is no argument shape that silently yields an unrestricted wallet, and
a spend for an agent that no longer exists is refused with `agent_not_found`
rather than falling through to empty defaults. This matters because autonomous
callers are background code with an agent id and an amount, not request handlers
holding a freshly-loaded row.

## The per-agent spend policy

Owner-only, on the agent's wallet:

```
GET  /api/agents/:id/solana/limits
PUT  /api/agents/:id/solana/limits      (CSRF-gated for cookie callers)
```

| Field | Meaning | Default |
|-------|---------|---------|
| `per_tx_usd` | Ceiling on any single payment | `null` (uncapped) |
| `daily_usd` | Rolling 24h ceiling on total outflow | `null` (uncapped) |
| `per_counterparty_daily_usd` | Rolling 24h ceiling **per payee** | `null` (uncapped) |
| `withdraw_allowlist` | If non-empty, owner withdraws may only target these addresses | `[]` |
| `frozen` | The kill switch. Halts every autonomous path | `false` |
| `require_capabilities` | Autonomous spends must present a covering scoped capability | `false` |

`per_counterparty_daily_usd` exists because a wallet-wide daily cap bounds total
damage but not concentrated damage. A peer that reprices upward every call, or a
compromised endpoint the agent keeps paying, can drain the entire daily budget
into one address while every individual payment stays under `per_tx_usd`.

```bash
curl -X PUT https://three.ws/api/agents/$AGENT_ID/solana/limits \
  -H 'content-type: application/json' -H "x-csrf-token: $CSRF" -b "$COOKIES" \
  -d '{"per_tx_usd":5,"daily_usd":25,"per_counterparty_daily_usd":10}'
```

The response returns the normalized policy plus `spent_today_usd`, so a UI can
show remaining headroom without a second call.

Ceilings are metered per `(agent, network)`, and every mainnet rail (Solana
mainnet and every EVM mainnet) folds into one `mainnet` budget on purpose: an
agent cannot double its real daily cap by alternating rails. Solana devnet keeps
its own budget.

## The kill switch

```bash
curl -X PUT https://three.ws/api/agents/$AGENT_ID/solana/limits \
  -H 'content-type: application/json' -H "x-csrf-token: $CSRF" -b "$COOKIES" \
  -d '{"frozen":true}'
```

The very next spend attempt fails, with no lock wait and no reservation written.
Precisely what it halts:

- **Halted:** every autonomous category. A2A payments, x402 payments, trades,
  snipes, scheduled orders, armed intents, autopilot rules. `a2a-call` refuses
  at gate 3, before the peer is contacted, so a halted agent does not even leak
  that it is alive or keep the peer's meter running.
- **Still open:** the owner's own withdraw. A freeze must never trap the owner's
  funds, so the safe direction (sweeping the balance out) stays available while
  the agent is locked down.

The anomaly guard ([`api/_lib/wallet-anomaly.js`](../api/_lib/wallet-anomaly.js))
can set the same flag automatically when an outbound movement scores far enough
outside the wallet's learned normal. Unfreezing is the same call with
`{"frozen": false}`.

## Receipts

Every agent-initiated payment writes one row to the agent's custody ledger:
pending at reservation, confirmed with the settlement signature once the peer's
task completes, released if it never settles. Nothing an agent pays for is
invisible to its owner afterwards.

```
GET /api/agents/:id/solana/custody?category=x402&limit=50
```

Owner-only (a stranger gets 403). Each item carries `usd`, `destination` (the
counterparty), `signature` and `explorer` (the settlement transaction),
`status`, `created_at`, and a `meta` blob that for an A2A payment holds
`kind: "a2a"`, the mandate id, the peer endpoint, the task id, the settlement
network, the atomic amount, the payer address, the signed AP2 cart mandate, and
the peer's own receipts. The response paginates with `next_cursor`.

The `a2a-call` response returns that row's id as `receipt_id`, alongside the
portable half of the receipt: `cart_mandate`, a signed proof of the exact
transaction that anyone can verify with
`POST /api/agents/a2a-cart-verify`.

For a rolled-up view, `GET /api/agents/:id/economy` returns the same payments as
a statement: `spending.x402` windowed in USD, and `receipts[]` entries with
`direction: "out"`, `kind: "x402"`, the counterparty, the resource, and the
signature, interleaved with the agent's inbound earnings.

## End to end

```bash
# 1. The human authorizes a class of spend: $10 total, $0.50 per call, 24h.
curl -X POST https://three.ws/api/agents/a2a-mandate \
  -H 'content-type: application/json' -b "$COOKIES" \
  -d '{"subjectAgentId":"'$AGENT_ID'","maxAtomics":"10000000","perCallAtomics":"500000","ttlSec":86400}'
# → 201 { "mandate": "<JWS>", "details": { … } }

# 2. The agent pays a peer, no human in the loop.
curl -X POST https://three.ws/api/agents/a2a-call \
  -H 'content-type: application/json' -b "$COOKIES" \
  -d '{"mandate":"<JWS>","endpoint":"https://peer.example/a2a","text":"Summarize this market."}'
# → 200 { "ok": true, "receipt_id": "8421", "usd": 0.25, "payer": "…",
#          "cart_mandate": "<JWS>", "artifacts": [ … ] }

# 3. The owner reads the receipt back.
curl -s "https://three.ws/api/agents/$AGENT_ID/solana/custody?category=x402&limit=5" -b "$COOKIES"
```

Amounts are USDC atomics (six decimals), so `500000` is $0.50. USDC is the only
currency the A2A rails settle in; any other asset is recorded unpriced rather
than guessed, and the unpriceable spend is governed by the allowlist and the
mandate rather than by a USD ceiling the guard cannot compute.

## Proving it still holds

Two layers, both runnable:

```bash
npx vitest run tests/a2a-payment-hardening.test.js   # deterministic, mocked DB
npm run prove:a2a-spend                              # real Postgres + live HTTP
```

`npm run prove:a2a-spend` starts a throwaway Postgres container, applies the real
schema, drives the real guard module and the real server, and asserts that each
ceiling blocks its over-limit attempt, that eight concurrent reserves for the
last dollar of headroom produce exactly one winner, that the kill switch halts
every autonomous category while the owner's withdraw stays open, and that the
receipts come back from the live owner surfaces. No funds move: every spend stops
at the reservation layer, which is the same layer that runs before any key is
touched in production. It needs `docker` and ports 5817, 5818 and 3817.

---

## Runnable example

[`agent-payments-sdk/`](https://github.com/nirholas/three.ws/tree/main/agent-payments-sdk) The `@three-ws/agent-payments` package: agent-to-agent payments over x402 and a2a, with its quickstart in the README.

It is part of the curated set `npm run export:satellites` publishes as the public
three.ws examples repo, so it is installed, run, and link-checked before every release.
