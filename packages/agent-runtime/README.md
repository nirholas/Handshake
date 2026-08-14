<p align="center">
  <a href="https://three.ws"><img src="https://three.ws/three-ws-mcp-icon.svg" width="72" height="72" alt="three.ws" /></a>
</p>

<h1 align="center">@three-ws/agent-runtime</h1>

<p align="center"><strong>The three.ws agent engine - a plan/execute decision loop with a seven-layer guard chain, a tamper-evident action ledger, and a multi-step transaction pipeline.</strong></p>

<p align="center">
  <a href="#quick-start">Quick start</a> ·
  <a href="#the-guardchain">GuardChain</a> ·
  <a href="#the-decision-loop">Decision loop</a> ·
  <a href="#action-ledger">Action ledger</a> ·
  <a href="https://three.ws">three.ws</a>
</p>

---

> The runtime that sits between a model and anything irreversible. The
> **decision loop** turns an LLM into an agent (plan, call tools, pause for
> humans, finish); the **GuardChain** composes every enforcement layer into one
> deterministic verdict with a per-layer trace; the **action ledger** makes the
> resulting history tamper-evident. It is pure engine: no chain SDKs, no
> database, no HTTP - every external fact is injected, which is why the same
> code path serves the live `/api/agent/guard` preflight, simulators, and
> tests. Powers the transaction-guard preflight in [three.ws/chat](https://three.ws/chat).

## Why

An agent that can call `solana_transfer` is one bad tool call away from an
empty wallet. Most stacks scatter their defenses: an approval modal here, a
spend cap there, a blacklist somewhere else - each invoked from a different
place, with different inputs, and *nothing that can answer which layer would
stop a given call, or which layers would silently not evaluate it at all*.
A guard that never runs looks exactly like a guard that passed.

This package makes enforcement composable and observable:

| Piece | What it does |
|---|---|
| `AgentRuntime` | Plan → execute loop: `call_llm`, `call_tool`, batches, `finish`, and three human-in-the-loop instructions (`approve` / `prompt` / `select`), with cost limits, interrupts, and resume |
| `GeneralChatAgent` | The default "brain": routes phases to instructions, splits tool calls into execute-now vs. needs-approval, compresses context when it outgrows the window |
| `GuardChain` | Runs all seven layers over one call, returns decision + per-layer trace + **blind spots** (enforcement that should have applied but didn't) + a coverage score |
| `TradeGuard` | Default domain guard: tier per-tx caps, rolling 24h/7d windows, auto-execute ceiling, MEV slippage clamp, protocol audit lookup |
| `SpendGuard` | Per-agent spend envelope: per-tx / rolling / daily caps, reserve floor, token + destination firewall, custody-breach latch |
| `InterventionChecker` | Policy engine for human approval (`never` / `required` / `always`, argument-level rules, security blacklist) |
| `ActionLedger` | Hash-chained (sha256) append-only ledger primitives: `computeEntryHash`, `verifyChain`, drift audits |
| `TransactionPipeline` | Multi-step plan execution: dependency order, parallel independent steps, rollback on failure, approval gates |
| `DecisionJournal` | Fire-and-forget reasoning journal with an injected sink |
| Reasoning utilities | `SelfReflection` (structured retry prompts), `ExitDecisionEngine`, `ResponseQualityEvaluator`, `ToolRelevanceScorer`, token counting + context-compression checks |

## Install

```bash
npm install @three-ws/agent-runtime
```

ESM, Node 18+. One runtime dependency (`tokenx`, for token estimation).

## Quick start

### Preflight a tool call through every guard layer

```js
import { GuardChain, SpendGuard, TradeGuard, createX402Hook } from '@three-ws/agent-runtime';

const chain = new GuardChain({
  defiGuard: new TradeGuard(),                       // tier caps + slippage clamp
  spendGuard: new SpendGuard({ perTxMaxUsd: 5_000 }), // hard envelope
  x402Hook: createX402Hook(5),                        // $5/hour autonomy budget
});

const verdict = await chain.evaluate({
  identifier: 'solana_swap',
  apiName: 'solana_swap',
  arguments: { inputMint: 'So11111111111111111111111111111111111111112', amount: 120, slippageBps: 300 },
  valueUsd: 18_400,
  userTier: 'pro',
});

verdict.decision;      // 'block'        ($18,400 is over the $5,000 per-tx envelope)
verdict.blockedBy;     // 'spend_guard'  the layer that decided it
verdict.modifiedArguments; // { ..., slippageBps: 100 }  (MEV clamp, still applied)
verdict.coverageScore; // 74   two layers were left unwired below
verdict.blindSpots;    // [CAPABILITY_UNWIRED, PERMISSION_UNWIRED]
```

The capability and permission layers report themselves as blind spots because
this chain was built without a `checkCapability` / `checkPermission` resolver.
Inject both (each an `async (request) => ({ allowed })` backed by your
capability-token and permission records) and the same call scores `100` with no
blind spots. Raise `perTxMaxUsd` above the notional and the decision becomes
`require_approval` instead of `block`, driven by the trade guard's
auto-execute ceiling.

The layer order is `security_blacklist → intervention → capability →
permission → defi_guard → spend_guard → x402`. The chain never
short-circuits: a call blocked by the spend envelope still reports the MEV
exposure the trade guard saw, and every layer that could not evaluate the
call says so instead of reading as "green".

### Run the decision loop

```js
import { AgentRuntime, GeneralChatAgent } from '@three-ws/agent-runtime';

const agent = new GeneralChatAgent({
  modelRuntimeConfig: { model: 'llama-3.3-70b-versatile', provider: 'groq' },
});
agent.modelRuntime = myStreamingLlm; // async generator: yields { content?, tool_calls? }
agent.tools = { get_price: async (args) => fetchPrice(args) };

let state = AgentRuntime.createInitialState({ operationId: 'op-1' });
state.messages.push({ role: 'user', content: 'What is SOL at?' });

const runtime = new AgentRuntime(agent);
let context;
while (state.status !== 'done' && state.status !== 'error') {
  const step = await runtime.step(state, context);
  state = step.newState;
  context = step.nextContext;
  if (state.status === 'waiting_for_human') break; // surface state.pendingToolsCalling to the user
}
```

When the user approves a pending call, continue with
`runtime.approveToolCall(state, approvedCall)`. `runtime.interrupt()` /
`runtime.resume()` cover cancellation.

### Verify a ledger

```js
import { computeEntryHash, verifyChain } from '@three-ws/agent-runtime';

const rows = await loadAgentLedger(agentId); // ordered rows from your store
const result = verifyChain(rows);
result.valid;      // false if any historical row was edited or deleted
result.brokenAt;   // exact index where the chain first breaks
```

## Registering your tools

The guard layers key off two module-level registries seeded with the three.ws
tool surface (`solana_transfer`, `solana_swap`, `pumpfunBuy`, ...). A host
adding a new fund-moving tool registers it at boot:

```js
import { registerFundMovingTool, registerMutatingApi } from '@three-ws/agent-runtime';

registerFundMovingTool('my_bridge_tool');
registerMutatingApi('executeBridgeV2');
```

An unregistered fund-moving tool is not "unguarded by design" - the GuardChain
reports it as a critical `TOOL_UNREGISTERED` blind spot.

## Where it runs on three.ws

- **`POST /api/agent/guard`** preflights tool calls for the chat client: the
  chat wallet tools (`solana_transfer`, `solana_swap`, `evm_*`, pump.fun
  trades) are evaluated through this exact chain before their tool body runs,
  a `block` verdict never reaches the wallet, and the transaction-approval
  modal renders the verdict (decision, warnings, unchecked blind spots).
- The server resolves SOL notionals (amount × live SOL price) before
  evaluating, so dollar caps compare against real numbers.

## Relation to `@three-ws/agent-guards`

[`@three-ws/agent-guards`](../agent-guards) is the *client* for the platform's
custodial wallet policy (it wraps `/api/agents/:id/trade` limits). This
package is the *engine*: it evaluates arbitrary tool calls before execution
anywhere - client wallets, custodial paths, simulators - and is what
`/api/agent/guard` runs. The custodial trade path keeps its own enforcement;
both speak the same language of per-tx/daily caps and deny-lists.

## Provenance

Core of the engine (decision loop, guard composition, spend envelope,
pipeline) was battle-tested in a sibling project of the same author and
ported here de-branded; the action ledger's hash-chain construction
originated in the three.ws economy master ledger, so this is that design
coming home. All chain-specific analysis was left behind: this package is
chain-agnostic by construction, and three.ws wires Solana-first specifics
(notional resolution, tool registries) at the edges.

## License

See [LICENSE](./LICENSE).
