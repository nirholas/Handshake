<p align="center">
  <a href="https://three.ws"><img src="https://three.ws/three-ws-mcp-icon.svg" width="72" height="72" alt="three.ws" /></a>
</p>

<h1 align="center">@three-ws/agent-guards</h1>

<p align="center"><strong>Safety rails for autonomous agents — cap what an agent can spend or trade before a transaction is ever signed.</strong></p>

<p align="center">
  <a href="https://www.npmjs.com/package/@three-ws/agent-guards"><img alt="npm" src="https://img.shields.io/npm/v/@three-ws/agent-guards?logo=npm&color=cb3837"></a>
  <a href="https://www.npmjs.com/package/@three-ws/agent-guards"><img alt="downloads" src="https://img.shields.io/npm/dm/@three-ws/agent-guards?color=cb3837"></a>
  <img alt="license" src="https://img.shields.io/npm/l/@three-ws/agent-guards?color=3b82f6">
  <img alt="node" src="https://img.shields.io/node/v/@three-ws/agent-guards?color=339933&logo=node.js">
</p>

<p align="center">
  <a href="#install">Install</a> ·
  <a href="#quick-start">Quick start</a> ·
  <a href="#api">API</a> ·
  <a href="#how-it-works">How it works</a> ·
  <a href="https://three.ws">three.ws</a>
</p>

---

> `@three-ws/agent-guards` is the official client for the three.ws **agent custody
> guardrails** — the same policy engine that governs every outbound movement of a
> custodial agent wallet on the platform. It lets an owner set hard spend and trade
> ceilings on an agent, and lets a caller pre-check a proposed buy/sell against
> those ceilings *before* signing. One policy is enforced uniformly across all four
> custody paths — discretionary trade, autonomous snipe, x402 pay, and owner
> withdraw — so an agent (or a stolen session token) can never drain a wallet past
> the leash its owner set. It wraps the live `/api/agents/:id/trade` and
> `/api/agents/:id/trade/limits` endpoints. All trading is SOL-quoted on Solana;
> the only coin three.ws promotes is [$THREE](https://three.ws).

## Why

An autonomous agent that can sign transactions is a loaded gun pointed at a wallet.
The moment you hand an LLM a key, you need an answer to one question on *every*
action: **is this allowed?** Hand-rolling that answer means re-deriving the same
math in four places — and the day the trade path and the snipe path disagree on
the daily cap is the day a wallet gets drained.

three.ws solves it once, server-side, as a single policy:

- **Two-tier ceilings.** A per-transaction cap stops one oversized trade; a
  rolling 24-hour cap stops a thousand small ones. Both are enforced atomically
  under a per-agent lock, so concurrent spends can't race past the limit.
- **A real kill switch.** Flip `kill_switch` (trades) or `frozen` (all autonomous
  paths) and every outbound action is rejected immediately — but the owner's own
  withdraw stays open, so a freeze locks down a misbehaving agent without trapping
  its funds.
- **Circuit breakers, not just caps.** A price-impact breaker and a slippage
  ceiling reject trades that would execute at a bad price, independent of size.
- **Owner-set, opt-in.** An unset ceiling means "no global cap" — existing flows
  keep working. The moment an owner tightens the policy it becomes a hard limit
  applied everywhere.

This SDK is the programmatic twin of the **Limits & Safety** surface in the
three.ws agent dashboard — the same policy, exposed as plain functions instead of
a settings panel.

## Install

```bash
npm install @three-ws/agent-guards
```

Zero runtime dependencies. Works in Node 18+ and the browser (uses `fetch`).
Setting or reading a policy is an owner-only action and requires the agent owner's
session cookie or bearer token.

## Quick start

Read an agent's current trade policy, then set a leash:

```js
import { guards } from '@three-ws/agent-guards';

const a = guards('agent_abc123', { token: process.env.THREE_WS_TOKEN });

// Set the rails: 0.5 SOL per trade, 2 SOL/day, reject >10% price impact.
await a.setTradeLimits({
  per_trade_sol: 0.5,
  daily_budget_sol: 2,
  max_price_impact_pct: 10,
  max_slippage_bps: 500,
});
```

Pre-check a proposed buy before you commit to signing it. `simulate: true` runs the
full quote → guard pipeline and returns the decision without moving funds:

```js
const decision = await a.checkTrade({ side: 'buy', mint, amount: 0.3 });

if (!decision.allowed) {
  console.log(decision.reason);   // e.g. 'per_trade_cap'
  console.log(decision.message);  // human-readable, actionable
} else {
  await a.trade({ side: 'buy', mint, amount: 0.3 }); // really executes
}
```

The kill switch, in one line:

```js
await a.setTradeLimits({ kill_switch: true }); // every discretionary trade now rejected
```

## Local guards (no network, no token)

The package ships the guard pipeline itself as pure functions, not just a client
for the hosted one. `policy()` normalizes a loose patch into the same bounded
leash the server would store, and `guard()` runs a proposed movement through
every predicate in the server's order. Nothing is fetched and nothing is signed,
so this half needs no token and runs in a browser, a test, or a simulator:

```js
import { policy, guard } from '@three-ws/agent-guards';

const p = policy({ per_trade_sol: 0.5, daily_budget_sol: 2, max_concurrent: 3 });

guard({ side: 'buy', amountSol: 0.9, priceImpactPct: 2 }, p);
// {
//   allow: false,
//   reason: 'per_trade_cap',
//   message: 'This trade of 0.9 SOL is over the per-trade cap of 0.5 SOL. Lower the
//             amount or raise the cap under Limits & Safety.',
//   detail: { amount_lamports: '900000000', cap_lamports: '500000000' },
// }
```

You supply the live numbers the guards compare against, exactly as the server
does: `amountSol` (or `amountLamports`), `priceImpactPct`, `openCount`,
`spentLamports` (rolling 24h SOL), `walletLamports`, `usdValue`, `spentUsd`, and
`destination` for a withdraw. Omit one and the guard that needs it is skipped
rather than guessing, so feed it everything you want enforced.

| Export | Purpose |
|---|---|
| `policy(patch)` | Normalize + bound a patch. Clamps `max_price_impact_pct` to 0-100, `max_slippage_bps` to 0-10000, `max_concurrent` to 1-10000; booleans coerce strictly to `=== true`. |
| `guard(tx, policy)` | Run every predicate in server order. Returns `{ allow, reason, message, detail }`. |
| `checkKillSwitch` · `checkFrozen` · `checkPriceImpact` · `checkPerTradeCap` · `checkConcurrency` · `checkDailyBudgetLamports` · `checkPerTxUsd` · `checkDailyUsd` · `checkSolHeadroom` · `checkAllowlist` | The individual predicates. Each returns `null` when the trade clears, or `{ reason, detail }` when it blocks. |
| `TRADE_LIMIT_DEFAULTS` · `SPEND_LIMIT_DEFAULTS` | The platform defaults applied when an owner has set no policy. |
| `LAMPORTS_PER_SOL` · `SOL_FEE_HEADROOM_LAMPORTS` | The lamport constants the caps are denominated in (headroom is ~0.003 SOL). |

Note the shape difference: the local `guard()` returns `allow`, while the hosted
`checkTrade()` below returns `allowed`. The `reason` codes are identical across
both, so a UI can share one renderer.

## API

### `guards(agentId, options?) → AgentGuards`

Bind the client to one agent. `options.token` is the owner's bearer token, or pass
`options.cookie` for a session. `options.baseUrl` overrides the default
`https://three.ws`.

### `.getTradeLimits() → Promise<TradeLimits & { defaults }>`

`GET /api/agents/:id/trade/limits`. Returns the effective discretionary-trade
policy plus the platform defaults. Lamport/SOL-denominated knobs that govern the
agent's own buys:

| Field | Type | Default | Meaning |
|---|---|---|---|
| `per_trade_sol` | `number \| null` | `null` | Max SOL on any single buy. `null` = uncapped. |
| `daily_budget_sol` | `number \| null` | `null` | Rolling-24h SOL buy budget across trade **and** snipe. `null` = uncapped. |
| `max_price_impact_pct` | `number` | `15` | Circuit breaker — reject a trade over this price impact. |
| `max_slippage_bps` | `number` | `1000` | Ceiling on client-supplied slippage (basis points). |
| `max_concurrent` | `number \| null` | `null` | Max open discretionary positions. `null` = unlimited. |
| `kill_switch` | `boolean` | `false` | When `true`, every discretionary trade is rejected. |

### `.setTradeLimits(patch) → Promise<TradeLimits>`

`PUT /api/agents/:id/trade/limits`. Owner-only, CSRF-gated (bearer callers exempt).
A **patch** — only the keys you pass change; the rest are preserved. Values are
normalized and bounded server-side (`max_price_impact_pct` clamps to 0–100,
`max_slippage_bps` to 0–10000, `max_concurrent` to 1–10000). Returns the new policy.

### `.checkTrade({ side, mint, amount, ... }) → Promise<Decision>`

Pre-flight a trade against every guard without moving funds — wraps the live
`POST /api/agents/:id/trade` with `simulate: true`. Returns:

| Field | Type | Notes |
|---|---|---|
| `allowed` | `boolean` | `true` if the trade clears every guard. |
| `reason` | `string \| null` | Machine code when blocked — see [reasons](#guard-reasons). |
| `message` | `string \| null` | Plain-language, actionable explanation. |
| `detail` | `object` | The numbers behind the decision (amounts, caps, spent-so-far). |

### `.trade({ side, mint, amount, ... }) → Promise<TradeResult>`

`POST /api/agents/:id/trade`. Executes the real trade — runs the identical
quote → guard → build → custody-claim → sign → confirm pipeline, so it can never
exceed the policy `checkTrade` reported on.

**Request body**

| Field | Type | Notes |
|---|---|---|
| `side` | `'buy' \| 'sell'` | Buys spend SOL; sells move SOL inward. Required. |
| `mint` | `string` | Base58 Solana mint of the coin to trade. Required. |
| `amount` | `number \| 'max'` | Buy: SOL to spend. Sell: tokens to sell, or `'max'`. |
| `slippageBps` | `number` | Slippage in bps. Clamped to `max_slippage_bps`. |
| `network` | `string` | `mainnet` (default) or `devnet`. |
| `simulate` | `boolean` | Dry run — never signs or records. `checkTrade` sets this for you. |
| `idempotency_key` | `string` | De-dupe retries of the same trade. |

Buys are gated on the per-trade cap, daily SOL budget, concurrency ceiling, the
cross-path USD ceiling, and a SOL fee/rent headroom floor (~0.003 SOL kept above
the spend). Sells only move SOL inward, so they skip the spend caps but still honor
the kill switch, the price-impact breaker, and the headroom floor.

### `.getSpendLimits()` / `.setSpendLimits(patch)`

The cross-path USD spend policy (distinct from the SOL trade limits above), stored
at `meta.spend_limits` and enforced uniformly across trade, snipe, x402 pay, and
withdraw. Patch semantics are identical to the trade limits.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `daily_usd` | `number \| null` | `null` | Rolling-24h USD-equivalent outflow ceiling. |
| `per_tx_usd` | `number \| null` | `null` | Max USD-equivalent for any single outbound tx. |
| `withdraw_allowlist` | `string[]` | `[]` | If non-empty, withdraws may only target these addresses (max 50, validated base58). |
| `frozen` | `boolean` | `false` | Kill switch for **all** autonomous paths. Owner withdraw stays open. |

## How it works

Every outbound movement of an agent wallet runs through one policy. The guards are
pure, synchronous predicates — the server fetches the live numbers (open count,
24h spend, wallet balance, quote) and hands them in, so the *same* comparison backs
both the discretionary trade endpoint and the autonomous sniper. A cap can never
drift between paths.

```
   proposed trade (side, mint, amount)
              │
              ▼
        quote the venue ──► price impact, expected out, USD value
              │
              ▼
   ┌──────────────────────── guard pipeline ────────────────────────┐
   │  kill switch ──► price-impact breaker ──► per-trade SOL cap     │
   │       ──► concurrency ceiling ──► daily SOL budget (rolling 24h)│
   │       ──► cross-path USD ceiling ──► SOL fee/rent headroom      │
   └─────────────────────────────┬───────────────────────────────────┘
              clear?  ──no──►  4xx { code, message, detail }   (never a 500)
              │ yes
              ▼
   reserve in the custody ledger ──► sign ──► confirm ──► finalize
```

The two caps that matter most — the rolling daily SOL budget and the daily USD
ceiling — are enforced **atomically under a per-agent advisory lock**. The check
and the ledger reservation happen in a single statement, so K concurrent spends
can never all read the same stale 24h total and all pass, turning an $X/day cap
into $X·K. A reservation that never settles is released, so a failed attempt does
not permanently consume the agent's budget.

## Guard reasons

A blocked trade is always a structured `4xx` with a machine code and a plain-language
message — never a thrown 500. `checkTrade` surfaces these on `decision.reason`;
`trade` rejects with the same shape.

| `reason` | HTTP | Meaning | Recovery |
|---|---|---|---|
| `kill_switch` | 403 | Discretionary trading is paused for this agent. | Re-enable trading (`kill_switch: false`). |
| `wallet_frozen` | 403 | The wallet is frozen; all autonomous spending is paused. | Unfreeze (`frozen: false`). Owner withdraw still works. |
| `per_trade_cap` | 422 | The buy exceeds `per_trade_sol`. | Lower the amount or raise the cap. |
| `daily_budget` | 422 | The buy would exceed the rolling-24h SOL budget. | Wait for the window to roll, or raise the budget. |
| `per_tx_exceeded` | 403 | The tx exceeds `per_tx_usd`. | Lower the amount or raise the per-tx USD limit. |
| `daily_exceeded` | 403 | The tx would exceed `daily_usd`. | Wait, or raise the daily USD limit. |
| `max_positions` | 409 | Open trades already at `max_concurrent`. | Close a position before opening another. |
| `price_impact` | 422 | Price impact above `max_price_impact_pct`. | Lower the trade size or raise the breaker. |
| `insufficient_sol` | 400 | Wallet can't cover the spend plus fee/rent headroom. | Fund the wallet and retry. |
| `destination_not_allowed` | 403 | Withdraw target not on `withdraw_allowlist`. | Add the address, or send to an allowed one. |

`detail` carries the raw numbers — e.g. `per_trade_cap` returns
`{ amount_lamports, cap_lamports }`, `daily_budget` returns
`{ spent_lamports, amount_lamports, budget_lamports }` — so a UI can render the
exact overage without re-deriving it.

## Examples

**Provision a new agent with conservative rails** before handing it a key:

```js
const a = guards(agentId, { token });

await a.setTradeLimits({
  per_trade_sol: 0.25,
  daily_budget_sol: 1,
  max_concurrent: 3,
  max_price_impact_pct: 8,
});
await a.setSpendLimits({ daily_usd: 100, per_tx_usd: 25 });
```

**Gate an LLM tool call** — let the model propose, but never let it sign past the
leash:

```js
async function agentBuy({ mint, sol }) {
  const check = await a.checkTrade({ side: 'buy', mint, amount: sol });
  if (!check.allowed) {
    return { ok: false, reason: check.reason, message: check.message };
  }
  return a.trade({ side: 'buy', mint, amount: sol, idempotency_key: crypto.randomUUID() });
}
```

**Emergency stop** — freeze every autonomous path while you investigate, without
locking yourself out of the funds:

```js
await a.setSpendLimits({ frozen: true }); // trades, snipes, x402 all rejected; withdraw stays open
```

**Read the policy under the hood** — the raw HTTP this SDK wraps:

```js
const res = await fetch(`https://three.ws/api/agents/${agentId}/trade/limits`, {
  headers: { authorization: `Bearer ${token}` },
});
const { data } = await res.json(); // { limits, defaults }
```

## Related

- [`@three-ws/x402-fetch`](https://www.npmjs.com/package/@three-ws/x402-fetch) — auto-pay x402 endpoints; the same spend policy governs every payment.
- [`@three-ws/forge`](https://www.npmjs.com/package/@three-ws/forge) — give your guarded agent a 3D body.

---

<p align="center">Built by <a href="https://three.ws">three.ws</a> · The only coin is <a href="https://three.ws">$THREE</a></p>
