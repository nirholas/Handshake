# agents/

Server-side agent implementations that live inside the main three.ws container. Each subdirectory is a library of plain ES modules (no per-directory `package.json`): the code is imported directly by the HTTP handlers in [api/](../api/) and by the cron dispatcher, and it reaches shared platform services (LLM chain, database, vision, x402 rail) through relative imports of [api/_lib/](../api/_lib/). The one exception is [x402-buildout/](x402-buildout/), which contains no code at all: it is the archive of task specifications that produced the autonomous x402 spend-loop pipelines. Note that [index.html](index.html) is unrelated to these subdirectories: it is the public Agent Index page served at `/agents` (routed by `vercel.json`), which lists every public user-created 3D AI agent from `GET /api/agents/public` with search, sort, and an on-chain filter.

| Agent | What it is |
|---|---|
| [endpoint-shopper](endpoint-shopper/README.md) | Autonomous shopper that discovers paid x402 endpoints in the Bazaar, plans a budget-capped execution, calls them, and synthesizes an answer. |
| [fact-checker](fact-checker/README.md) | Claim verification pipeline: LLM query generation, multi-provider web search, source-authority weighting, optional image evidence. |
| [tutor](tutor/README.md) | Pay-As-You-Learn tutor: structured, level-aware explanations billed $0.01 per answer with an itemized, attested session tab. |
| [unstoppable](unstoppable/README.md) | Self-sustaining agent with its own USDC treasury: earns from paid status checks, thinks on a 5-minute cron tick, and writes daily reflections. |
| [x402-buildout](x402-buildout/README.md) | 83 markdown task specs for the autonomous x402 self-call pipelines registered in `api/_lib/x402/autonomous-registry.js`. |
