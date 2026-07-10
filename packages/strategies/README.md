<p align="center">
  <a href="https://three.ws"><img src="https://three.ws/three-ws-mcp-icon.svg" width="72" height="72" alt="three.ws" /></a>
</p>

<h1 align="center">@three-ws/strategies</h1>

<p align="center"><strong>Automated on-chain trading strategies for agents — DCA, copy-trading, and mirror execution, in one import.</strong></p>

<p align="center">
  <a href="https://www.npmjs.com/package/@three-ws/strategies"><img alt="npm" src="https://img.shields.io/npm/v/@three-ws/strategies?logo=npm&color=cb3837"></a>
  <a href="https://www.npmjs.com/package/@three-ws/strategies"><img alt="downloads" src="https://img.shields.io/npm/dm/@three-ws/strategies?color=cb3837"></a>
  <img alt="license" src="https://img.shields.io/npm/l/@three-ws/strategies?color=3b82f6">
  <img alt="node" src="https://img.shields.io/node/v/@three-ws/strategies?color=339933&logo=node.js">
</p>

<p align="center">
  <a href="#install">Install</a> ·
  <a href="#quick-start">Quick start</a> ·
  <a href="#api">API</a> ·
  <a href="#how-it-works">How it works</a> ·
  <a href="https://three.ws">three.ws</a>
</p>

---

> `@three-ws/strategies` is the official client for the three.ws **strategy
> engine** — the system that turns a rule set into real, server-signed,
> fully-leashed trading for an agent. Three strategy families, one import:
> **DCA** (buy a fixed size on a daily/weekly schedule), **copy-trading**
> (mirror a public leader's fills into your own wallet, non-custodial), and
> **mirror execution** (custodial follow that sizes and lands a leader's trades
> through your agent's wallet). Every order — scheduled, copied, or mirrored —
> passes through the SAME spend guardrails (per-trade cap, daily budget, USD
> ceiling, price-impact breaker, rug/honeypot firewall, kill switch) the
> discretionary trade endpoint uses. A strategy can never bypass a limit. It
> wraps the public three.ws strategy endpoints; this README documents both the
> ergonomic SDK surface and the raw HTTP it sits on.

## Why

Automated trading is mostly plumbing nobody wants to write twice: a scheduler
that survives restarts, a leader-trade detector, position sizing that respects a
budget, idempotency so a retry never double-spends, MEV-aware broadcast, and an
honest performance ledger. three.ws built that once, behind a small set of
endpoints, and clamps every strategy to the agent's spend policy. This SDK is the
one-line front door:

- **One call per strategy.** `dca({ ... })`, `copy(leaderAgentId, { ... })`,
  `mirror(agentId, leaderAgentId, { ... })`. No scheduler, no detector, no
  signing code.
- **Leashed by construction.** The strategy's own caps (per-trade size, slippage,
  cooldown, max concurrent) are *additional* constraints on top of the agent's
  server-side spend policy — never a way around it.
- **Real performance only.** Rankings and stats come from real closed on-chain
  positions. A strategy with no closed trades is honestly "unproven" — never a
  fabricated backtest curve.
- **Ownable & forkable.** Wrap a rule set as a [Strategy Object](#strategy-objects):
  publish it, let others fork the *rules* (never wallet access), and rank it on a
  real-performance leaderboard.

This is the same engine that powers the strategy surfaces on
[three.ws](https://three.ws), exposed as plain functions.

## Install

```bash
npm install @three-ws/strategies
```

Zero runtime dependencies. Works in Node 18+ and the browser (uses `fetch`).
Auth is a three.ws session cookie or a bearer token — pass it once when you
construct the client.

## Quick start

```js
import { strategies } from '@three-ws/strategies';

const sx = strategies({ token: process.env.THREE_WS_TOKEN }); // bearer or cookie

// 1. DCA — buy a fixed size on a schedule, executed by the platform cron.
await sx.dca({
  agentId: 'THREEsynthetic-agent-uuid',
  delegationId: 'THREEsynthetic-delegation-uuid',
  tokenIn: '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE',
  tokenOut: '0x0000000000000000000000000000000000000000',
  tokenOutSymbol: 'THREE',
  amountPerExecution: '1000000000000000000', // wei
  interval: 'daily', // daily | weekly
  slippageBps: 50,
});

// 2. Copy a public leader's fills into your own wallet (non-custodial).
await sx.copy('THREEsynthetic-leader-uuid', {
  copierWallet: 'THREEsynthetic1111111111111111111111111111',
  fixedSol: 0.25,
  perTradeCapSol: 0.5,
  dailyBudgetSol: 2,
});

// 3. Mirror a leader through your agent's wallet (custodial, sized + landed).
await sx.mirror('THREEsynthetic-agent-uuid', 'THREEsynthetic-leader-uuid', {
  sizingMode: 'proportional',
  proportionPct: 50,
  maxPerTradeSol: 0.3,
  dailyBudgetSol: 1.5,
});
```

Every example uses `$THREE` (CA `FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump`)
or a clearly-synthetic placeholder. The engine is generic plumbing: the token to
trade is always supplied at runtime — it never hardcodes a coin.

## API

### `strategies(options) → Client`

| Option | Type | Default | Notes |
|---|---|---|---|
| `token` | `string` | — | Bearer token. Omit to rely on the three.ws session cookie. |
| `baseUrl` | `string` | `https://three.ws` | Override for self-hosted / preview deploys. |
| `network` | `'mainnet' \| 'devnet'` | `'mainnet'` | Default network for copy/mirror calls. |
| `csrfToken` | `string` | — | Required for cookie-session writes (bearer clients are exempt). |

### `dca(input) → Promise<DcaStrategy>`

Create a dollar-cost-averaging strategy. The platform cron executes it on the
chosen interval. Wraps `POST /api/dca-strategies`.

| Field | Type | Notes |
|---|---|---|
| `agentId` | `string` (uuid) | The agent that owns the strategy. |
| `delegationId` | `string` (uuid) | An **active**, unexpired delegation for that agent. |
| `tokenIn` / `tokenOut` | `string` | `0x`-prefixed 40-char hex addresses. |
| `tokenOutSymbol` | `string` | Must be on the operator's `DCA_ALLOWED_TOKEN_OUT` whitelist. |
| `amountPerExecution` | `string` | Amount in wei (decimal integer string). |
| `interval` | `'daily' \| 'weekly'` | Maps to `period_seconds` `86400` / `604800`. |
| `chainId` | `number?` | Optional; falls back to the operator's `DCA_CHAIN_ID`. |
| `slippageBps` | `number` | 1–500, default 50. Capped server-side at 500. |

Returns `{ id, status, next_execution_at, created_at }`. Companion reads:
`listDca(agentId)` (`GET /api/dca-strategies?agent_id=`, each row carries its
`last_execution`) and `cancelDca(id)` (`DELETE /api/dca-strategies/:id`).

### `copy(leaderAgentId, input) → Promise<Subscription>`

Subscribe to a public leader. The copy engine sizes each of the leader's fills
against your rules and drops a **copy intent** into your inbox — non-custodial,
so you (or your agent) execute it from your own wallet. Wraps
`POST /api/copy/subscriptions`.

| Field | Type | Default | Notes |
|---|---|---|---|
| `copierWallet` | `string` | — | Your Solana address (base58). Required. |
| `sizingRule` | `'fixed' \| 'multiplier' \| 'pct_balance'` | `'fixed'` | How each copy is sized. |
| `fixedSol` | `number` | — | SOL per copy when `sizingRule: 'fixed'`. |
| `multiplier` | `number` | — | × the leader's entry when `'multiplier'`. |
| `pctBalance` | `number` | — | 0–100 % of your balance when `'pct_balance'`. |
| `perTradeCapSol` | `number` | — | Hard cap per copy. Required, > 0. |
| `minOrderSol` | `number` | `0` | Skip copies sized below this. |
| `dailyBudgetSol` | `number` | — | Daily fan-out cap. Required, > 0. |
| `maxOpenCopies` | `number` | `5` | Cap on pending intents (1–100). |
| `mcapFloorUsd` / `mcapCeilingUsd` | `number?` | — | Skip coins outside this market-cap band. |
| `copySells` | `boolean` | `true` | Mirror the leader's exits, not just entries. |
| `requireSafetyPass` | `boolean` | `false` | Skip when coin safety can't be confirmed. |
| `minOracleScore` | `number?` | — | 0–100 conviction gate. |
| `perfFeeBps` | `number` | `1000` | Performance fee to the leader (0–3000 bps). |

Reads: `listSubscriptions()`, `copyExecutions({ status })` (your intent inbox —
`pending` by default), `pauseCopy(id)` / `stopCopy(id)`.

### `mirror(agentId, leaderAgentId, input) → Promise<Follow>`

**Custodial** follow: your agent's wallet sizes and lands the leader's trades
automatically through the leashed runtime. Wraps the agent strategy surface
(`POST /api/agents/:id/strategies` family).

| Field | Type | Default | Notes |
|---|---|---|---|
| `sizingMode` | `'fixed' \| 'proportional' \| 'pct_balance'` | `'proportional'` | How each mirror is sized. |
| `fixedSol` | `number` | — | SOL per mirror when `'fixed'`. |
| `proportionPct` | `number` | `100` | % of the leader's size when `'proportional'`. |
| `pctBalance` | `number` | — | 0–100 % of your balance when `'pct_balance'`. |
| `maxPerTradeSol` | `number?` | — | Per-mirror cap (the agent's own cap is the hard backstop). |
| `dailyBudgetSol` | `number?` | — | Per-follow daily cap (stacks under the agent's budget). |
| `minLeaderSol` | `number` | `0` | Ignore leader buys below this. |
| `copySells` | `boolean` | `true` | Mirror exits. |
| `mintAllowlist` / `mintDenylist` | `string[]` | `[]` | Restrict / block specific mints. |

Mirror controls: `killSwitch(agentId, engaged)` (per-owner global halt),
`sweep(agentId)` ("run now"), and `equipped(agentId)` (live equips + open
positions + kill state).

### Strategy Objects

A reusable, publishable, forkable rule set — ranked by **real** performance.

| Method | Wraps | Purpose |
|---|---|---|
| `createStrategy({ name, config })` | `POST /api/strategies` | Author a rule set (validated before it persists). |
| `listStrategies({ scope, sort, q })` | `GET /api/strategies` | `scope=mine\|published`; `sort=performance\|recent\|forks\|equips`. |
| `getStrategy(id)` | `GET /api/strategies/:id` | One strategy + live performance + equip count. |
| `leaderboard({ limit })` | `GET /api/strategies/leaderboard` | Proven strategies ranked by real ROI. |
| `forkStrategy(id)` | `POST /api/strategies/:id/fork` | Clone the **rules** into your library (no wallet access transferred). |
| `publishStrategy(id, published)` | `POST /api/strategies/:id/publish` | Toggle marketplace visibility. |
| `updateStrategy(id, patch)` | `PATCH /api/strategies/:id` | Edit name/description/config (bumps version). |

The `config` is a structured plan — `entry` (trigger, age, market-cap, liquidity,
creator history), `sizing` (`amount_sol`, `max_slippage_bps`), `exits`
(`take_profit_pct`, `stop_loss_pct`, `trailing_stop_pct`, `max_hold_minutes`),
and `risk` (`max_concurrent_positions`, `cooldown_minutes`). It is normalized and
bounds-checked server-side, so a malformed rule set can never be saved or run.

## How it works

```
        DCA                    copy                     mirror
 ┌──────────────┐      ┌───────────────────┐     ┌──────────────────┐
 │ schedule +   │      │ leader fills →     │     │ leader fills →   │
 │ delegation   │      │ planCopyOrder()    │     │ planMirror()     │
 └──────┬───────┘      └─────────┬─────────┘     └────────┬─────────┘
        │ cron tick              │ sized INTENT           │ sized order
        ▼                        ▼ (you execute)          ▼
   run-dca executor      copy_executions inbox    runStrategyTrade()
        │                  (non-custodial)               │ (custodial)
        └──────────────┬──────────────────────────────────┘
                       ▼
        ┌──────────────────────────────────────────────┐
        │ shared spend guardrails — kill switch,        │
        │ per-trade cap, daily budget, USD ceiling,     │
        │ price-impact breaker, rug/honeypot firewall,  │
        │ SOL headroom, custody idempotency             │
        └───────────────────────┬──────────────────────┘
                                ▼
              MEV-aware execution (Jito-aware broadcast)
                                ▼
              real on-chain fill → custody + position ledger
```

- **DCA** records a strategy bound to a delegation; the platform cron
  (`run-dca`) executes it each interval and writes a `dca_executions` row per
  fill (`tx_hash`, `amount_in`, `amount_out`, `status`).
- **Copy** is non-custodial. The pure `planCopyOrder` engine sizes each leader
  fill against your subscription, clamps it to your per-trade cap and remaining
  daily budget, and emits a copy intent. You act on it from your own wallet — the
  platform never signs.
- **Mirror** is custodial. The pure `planMirror` engine sizes the leader's trade,
  then `runStrategyTrade` runs it through the full guard + custody path and the
  MEV-aware execution engine. Sizing is the *first* clamp; the agent's spend
  policy is the hard backstop.
- **Strategy Objects** drive the same custodial runtime from rules instead of a
  leader: real pump.fun launches are matched against `entry`; open positions are
  marked-to-market with real sell re-quotes and closed on TP / SL / trailing /
  timeout.

Every custodial fill is idempotency-keyed in the custody ledger, so a retried
order replays instead of double-spending.

## Errors & edge cases

The SDK surfaces the endpoints' error codes as a typed `StrategyError` with a
`code` and the HTTP `status`:

| `code` | HTTP | Meaning | Recovery |
|---|---|---|---|
| `unauthorized` | 401 | No valid session/bearer. | Pass a `token` or sign in. |
| `not_configured` | 400 | DCA whitelist or chain not set by the operator. | Set `DCA_ALLOWED_TOKEN_OUT` / `DCA_CHAIN_ID`, or pass `chainId`. |
| `validation_error` | 400 | Bad field, off-whitelist symbol, or invalid rule set. | Read `errors`; fix the offending field. |
| `delegation_expired` | 409 | The DCA delegation has lapsed. | Re-authorize a fresh delegation. |
| `conflict` | 409 | An active DCA strategy already exists for this token pair. | Cancel the existing one first. |
| `invalid_wallet` | 400 | `copierWallet` isn't a valid Solana address. | Provide a base58 address. |
| `leader_not_found` | 404 | Leader isn't a public agent. | Use a public leader's agent id. |
| `forbidden` | 403 | Not the owner of the agent/strategy. | Operate on your own resources. |
| `not_found` | 404 | Unknown strategy / agent / subscription. | Check the id. |
| `rate_limited` | 429 | Too many requests. | Honour `retryAfter` on the error. |

Strategy runtime "skips" are designed states, not errors — every custodial skip
carries a machine + human reason (`per_trade_cap`, `daily_budget`,
`firewall_blocked`, `cooldown`, `max_concurrent`, `insufficient_sol`, …) so the
owner's activity feed always explains why an order didn't fire. The copy and
mirror engines do the same (`below_min_order`, `daily_budget_spent`,
`mint_denylisted`, `mirror_killed`, …). Surface these — don't treat a leashed
skip as a failure.

## Examples

**Schedule a weekly DCA into $THREE**

```js
await sx.dca({
  agentId, delegationId,
  tokenIn: '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE',
  tokenOut: '0x0000000000000000000000000000000000000000',
  tokenOutSymbol: 'THREE',
  amountPerExecution: '500000000000000000',
  interval: 'weekly',
});
```

**Copy a leader, but only safe coins above a market-cap floor**

```js
await sx.copy(leaderAgentId, {
  copierWallet: 'THREEsynthetic1111111111111111111111111111',
  sizingRule: 'multiplier',
  multiplier: 0.5,
  perTradeCapSol: 0.4,
  dailyBudgetSol: 3,
  requireSafetyPass: true,
  mcapFloorUsd: 50_000,
});

// Poll the non-custodial intent inbox and act from your own wallet.
const { executions } = await sx.copyExecutions({ status: 'pending' });
```

**Publish a Strategy Object and rank it honestly**

```js
const strategy = await sx.createStrategy({
  name: 'Fresh-launch momentum',
  config: {
    entry: { trigger: 'new_launch', max_age_minutes: 30, require_socials: true },
    sizing: { amount_sol: 0.1, max_slippage_bps: 500 },
    exits: { take_profit_pct: 150, stop_loss_pct: 40, trailing_stop_pct: 25 },
    risk: { max_concurrent_positions: 3, cooldown_minutes: 10 },
  },
});
await sx.publishStrategy(strategy.id, true);

const { leaders } = await sx.leaderboard({ limit: 10 }); // proven, real-ROI ranked
```

## Related

- [`@three-ws/x402-fetch`](https://www.npmjs.com/package/@three-ws/x402-fetch) — auto-pay any x402-gated three.ws endpoint.
- [`@three-ws/agenc`](https://www.npmjs.com/package/@three-ws/agenc) — agent coordination + delegation primitives.
- [`@three-ws/reputation`](https://www.npmjs.com/package/@three-ws/reputation) — ERC-8004 reputation behind leader discovery.
- [`@three-ws/intel`](https://www.npmjs.com/package/@three-ws/intel) — market intel to feed strategy entry rules.

---

<p align="center">Built by <a href="https://three.ws">three.ws</a> · The only coin is <a href="https://three.ws">$THREE</a></p>
