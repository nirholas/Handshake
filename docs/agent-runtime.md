# The agent runtime and the transaction guard

Every fund-moving tool an agent can call in [three.ws/chat](https://three.ws/chat) now passes
through a policy engine before it runs. This page explains what that engine is, what the
verdict you see in the transaction-approval modal means, and how developers can use the same
engine, `@three-ws/agent-runtime`, in their own agents.

## What happens when an agent tries to move money

Say you ask the chat agent to "send 2 SOL to my friend". The model emits a `solana_transfer`
tool call. Before that tool's code executes, and before your wallet ever prompts, the chat
client posts the call to `POST /api/agent/guard`, which evaluates it through seven independent
enforcement layers, in order:

1. **Security blacklist** - argument-level rules that force-block known-dangerous shapes
   (drainer-style destinations, destructive commands), regardless of any other setting.
2. **Human intervention** - the approval policy for this tool (`never` / `required` /
   `always`), combined with your session's approval mode.
3. **Capability** - is there a capability token covering this tool? (Skipped and reported
   when no validator is wired.)
4. **Permission** - the agent's permission level for this tool. (Same skip semantics.)
5. **Trade guard** - dollar-denominated policy: per-tier transaction caps, rolling 24-hour
   and 7-day windows, an auto-execute ceiling above which a human must sign off, an MEV
   slippage clamp, and a protocol audit lookup.
6. **Spend envelope** - the per-agent hard envelope: per-transaction / daily caps, a reserve
   floor, and a token + destination firewall.
7. **x402 budget** - for paid HTTP calls, the hourly autonomy budget.

The result is one verdict: `allow`, `require_approval`, or `block`.

- A **block** never reaches your wallet. The tool returns an error to the model explaining
  which layer refused and why, and the model tells you in plain language.
- Anything else proceeds into the familiar approval modal, now showing the verdict: a
  "cleared" or "review advised" chip, any warnings (for example "Slippage reduced to 100 bps
  for MEV protection"), and anything the platform *could not* check.

Two details worth knowing:

- **USD notionals are resolved server-side.** For SOL-denominated calls (SOL transfers,
  SOL-input swaps, pump.fun buys) the server multiplies the amount by the live SOL price, so
  the dollar caps compare against real numbers. When no notional can be resolved, the guard
  does not guess: the verdict carries a `VALUE_UNRESOLVED` finding instead.
- **The chain never short-circuits.** All seven layers always run, so the verdict can report
  that a call blocked by one layer also carried risk another layer saw, and, more
  importantly, which layers never evaluated the call at all. A guard that never ran looks
  exactly like a guard that passed; this engine treats that as a first-class finding
  ("blind spots") with a coverage score.

## The engine: `@three-ws/agent-runtime`

The endpoint is a thin shell over [`packages/agent-runtime`](../packages/agent-runtime), a
standalone, chain-agnostic package that also ships:

- **`AgentRuntime` + `GeneralChatAgent`** - a plan/execute decision loop for building agents:
  streaming LLM calls, parallel tool batches, human-in-the-loop pauses (approve / prompt /
  select), cost limits, interrupt and resume, and automatic context compression.
- **`ActionLedger`** - hash-chained ledger primitives (`computeEntryHash`, `verifyChain`):
  every recorded action commits to the entire history, so editing or deleting any historical
  row is detectable at the exact index it happened. The construction originated in the
  three.ws economy master ledger.
- **`TransactionPipeline`** - executes multi-step plans (approve → swap → bridge) in
  dependency order with rollback on failure and per-step approval gates.
- Reasoning utilities: structured self-correction on failed tool calls, response-quality
  evaluation, tool-relevance scoring, and token counting.

Quick taste (the same call the chat client makes, in library form):

```js
import { GuardChain, SpendGuard, TradeGuard } from '@three-ws/agent-runtime';

const chain = new GuardChain({
  defiGuard: new TradeGuard(),
  spendGuard: new SpendGuard({ perTxMaxUsd: 5000, firewall: { denyDestinations: ['0xbad'] } }),
});

const verdict = await chain.evaluate({
  identifier: 'solana_transfer',
  apiName: 'solana_transfer',
  arguments: { recipient: '9x…', amount: 250 },
  valueUsd: 42_000,
});
// verdict.decision === 'block' (free tier caps at $10,000 per tx)
```

The package README, [packages/agent-runtime/README.md](../packages/agent-runtime/README.md),
documents the full API, the tool registries, and how to register your own fund-moving tools.

## The endpoint

`POST /api/agent/guard` - open (no auth), rate-limited per IP, stateless. Evaluation uses
only what you send; nothing is stored and nothing executes.

```bash
curl -s https://three.ws/api/agent/guard \
  -H 'content-type: application/json' \
  -d '{
    "calls": [{
      "identifier": "solana_swap",
      "arguments": { "inputMint": "So11111111111111111111111111111111111111112", "amount": 120, "slippageBps": 300 }
    }],
    "userTier": "pro",
    "spend": { "perTxMaxUsd": 50000 }
  }'
```

Response: one verdict per call, each with `decision`, `blockedBy`, a per-layer trace
(`layers`), `warnings`, `blindSpots`, `coverageScore`, and `modifiedArguments` when the
engine recommends safer parameters (the chat client applies these before executing).

Body fields: `calls[]` (each: `identifier`, `apiName`, `arguments`, optional `valueUsd`,
`protocol`, `destination`, `token`, `interventionConfig`, `executionPath`, `x402`), plus
request-level `approvalMode`, `allowList`, `confirmedHistory`, `userTier`, `userSwapCaps`,
`userSwapVolume`, `balanceUsd`, `agentId`, `userId`, `spend` (a SpendGuard envelope), and
`x402HourlyBudgetUsd`.

## Related surfaces

- [Agent Sniper](./agent-sniper.md) - the autonomous trading pipeline with its own trade
  firewall and hash-chained decision ledger; this package generalizes those ideas into a
  reusable engine.
- [`@three-ws/agent-guards`](../packages/agent-guards) - the client SDK for custodial wallet
  spend policies (`/api/agents/:id/trade/limits`). The runtime evaluates arbitrary tool
  calls anywhere; agent-guards manages the platform-custody leash.
- [STRUCTURE.md](../STRUCTURE.md) - where everything lives.
