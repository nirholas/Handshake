# Endpoint Shopper

An agent that spends money on other agents' behalf. Given a natural-language task and a budget ceiling, it discovers relevant paid x402 endpoints in the three.ws Bazaar, plans a multi-step execution with an LLM, calls each endpoint within budget, and synthesizes a concise final answer. Every response includes the full step trace with a per-step USDC cost breakdown, so callers can see exactly where funds went. It serves agent builders who want one call that fans out across the paid-API marketplace, and it doubles as a live demo of x402 agent-to-agent commerce.

## How it works

`run({ task, maxCostUsd })` in [src/orchestrator.js](src/orchestrator.js) executes four phases:

1. **Discover**: search the Bazaar for endpoints matching the task ([src/discover.js](src/discover.js) queries `/api/bazaar/search`, with `/api/bazaar/list` also exported). Results are normalized to `{ url, serviceName, description, tags, priceUsdc, network, priceAtomics }`, picking the cheapest accept entry across networks.
2. **Plan**: an LLM turns the task plus the catalog into a JSON step plan of `discover`, `call`, and `synthesize` actions ([src/planner.js](src/planner.js)). Unparseable LLM output falls back to a minimal synthesize-only plan.
3. **Call**: up to 3 `call` steps run against real endpoints, each gated against the budget (default $0.50, hard cap $2.00, tracked in USDC atomics). A 402 response is captured in the step output as `payment_required` with the payment requirements, and costs nothing.
4. **Synthesize**: an LLM combines collected results (or, if everything returned 402, the catalog itself) into a 2 to 4 sentence answer.

## Key files

| File | Role |
|---|---|
| [src/orchestrator.js](src/orchestrator.js) | `run()`: the full discover, plan, call, synthesize cycle with budget enforcement |
| [src/discover.js](src/discover.js) | `discoverEndpoints()` and `listEndpoints()`: Bazaar search and list, result normalization |
| [src/planner.js](src/planner.js) | `planSteps()`: LLM task decomposition into a sanitized step plan |
| [../../api/agents/endpoint-shopper-run.js](../../api/agents/endpoint-shopper-run.js) | The paid HTTP endpoint wrapping `run()` |
| [../../src/shopper-app.js](../../src/shopper-app.js) | Browser UI on the `/shopper` page ([../../pages/shopper.html](../../pages/shopper.html)) |
| [../../api/_lib/x402/agents/endpoint-shopper.js](../../api/_lib/x402/agents/endpoint-shopper.js) | Ring-economy buyer that autonomously pays this endpoint to generate real volume |

## How to run

Direct module invocation from the repo root (Node 20+):

```bash
node --env-file=.env -e "import('./agents/endpoint-shopper/src/orchestrator.js').then(m => m.run({ task: 'What x402 endpoints can check a Solana token for sniper activity?', maxCostUsd: 0.10 })).then(r => console.log(JSON.stringify(r, null, 2)))"
```

Via the deployed paid endpoint (returns a 402 payment quote without an `X-PAYMENT` header):

```bash
curl -s -X POST https://three.ws/api/agents/endpoint-shopper-run -H 'content-type: application/json' -d '{"task":"What is the current SOL price?","maxCostUsd":0.5}'
```

Or use the browser UI at [https://three.ws/shopper](https://three.ws/shopper).

## Environment variables

- `PUBLIC_APP_ORIGIN` or `APP_ORIGIN`: base origin for Bazaar and endpoint calls (defaults to `https://three.ws`).
- `ANTHROPIC_API_KEY`: optional operator key for planning and synthesis. Without it, the shared LLM chain in [../../api/_lib/llm.js](../../api/_lib/llm.js) runs on the platform's funded free providers (`GROQ_API_KEY`, `OPENROUTER_API_KEY`, and the rest of that chain).
- `X402_PRICE_ENDPOINT_SHOPPER_RUN`: optional atomics override for the endpoint's own price (default 10000, which is $0.01).

## Platform connections

- **Bazaar**: discovery goes through the platform's `/api/bazaar/search` and `/api/bazaar/list` proxies, which aggregate all configured x402 facilitators.
- **x402**: `POST /api/agents/endpoint-shopper-run` is itself a paid, Bazaar-discoverable x402 endpoint ($0.01 base, USDC on Base or Solana, `x402:bypass` API-key scope supported). It is listed in [../../api/_lib/x402/ring-catalog.js](../../api/_lib/x402/ring-catalog.js) and bought on a schedule by the autonomous ring buyer, so the shopper both spends and earns on the rail.
- **LLM**: planning and synthesis route through the shared provider policy in `api/_lib/llm.js`.
