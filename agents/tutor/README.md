# Pay-As-You-Learn Tutor

The teaching engine behind the three.ws Tutor: ask a question (optionally with code or context) and get a structured, level-appropriate explanation billed at $0.01 per answer over x402. Each session keeps a running tab; every answered question appends an itemized charge, and ending the session produces an invoice with a SHA-256 attestation over the line items. It serves learners on the `/tutor` page, paying agents calling the endpoint directly, and the Schoolmarm NPC in `/play`.

## How it works

- **Teaching** ([src/teach.js](src/teach.js)): `teach({ question, context, level, anthropicKey })` builds a level-specific system prompt (`beginner`, `intermediate`, `expert`) and asks the shared LLM chain for a JSON object with `explanation`, `keyPoints` (2 to 5), `example`, and `followUp`. Malformed LLM output is coerced into that shape rather than failing. The output-token count is returned so the endpoint can bill accurately.
- **Session ledger** ([src/session.js](src/session.js)): sessions persist for 7 days with a 500-entry cap, so a learner can close the tab and resume. `appendCharge()` adds one line item per answer, `loadSession()` reloads the tab, and `closeSession()` marks the session closed and returns an idempotent, attested invoice (closing the same session twice returns the stored invoice verbatim). Closing an id that has no tab returns a zero invoice without writing anything, so a stray close can never make someone else's session id unusable.
- **Storage tiers** (`sessionBackend()` reports the active one): a Postgres `tutor_sessions` row when `DATABASE_URL` is set (the tier production runs on, table created lazily on first use), an Upstash-compatible KV key when a deployment has KV but no database, and process-local memory when neither is configured (local dev; resume then works inside one server process only). Reads propagate a storage fault to the caller rather than reporting an empty tab, because telling a learner who owes money that they owe nothing is worse than an error; writes on the paid path are best-effort, because a ledger outage must never cost the learner the answer they paid for.

## Key files

| File | Role |
|---|---|
| [src/teach.js](src/teach.js) | `teach()`: level-aware structured explanation generation; exports `LEVEL_NAMES` |
| [src/session.js](src/session.js) | Session ledger: `loadSession()`, `appendCharge()`, `closeSession()`, `atomicsToUsd()`, `sessionBackend()` |
| [../../api/x402/tutor.js](../../api/x402/tutor.js) | `POST /api/x402/tutor`: the paid endpoint, $0.01 per answer |
| [../../api/tutor/session.js](../../api/tutor/session.js) | Free session endpoint: `GET /api/tutor/session?sessionId=<id>` for the tab, `POST` with `{"action":"end"}` to close |
| [../../public/tutor.html](../../public/tutor.html) | The `/tutor` page |

## How to run

Direct module invocation from the repo root (Node 20+):

```bash
node --env-file=.env -e "import('./agents/tutor/src/teach.js').then(m => m.teach({ question: 'Why does my recursive function overflow the stack?', context: 'function f(n){ return f(n-1); }', level: 'beginner' })).then(r => console.log(JSON.stringify(r, null, 2)))"
```

Via the deployed endpoint (without an `X-PAYMENT` header this returns the 402 payment quote):

```bash
curl -s -X POST https://three.ws/api/x402/tutor -H 'content-type: application/json' -d '{"question":"What is a closure in JavaScript?","level":"beginner"}'
```

Reading a session tab is free:

```bash
curl -s 'https://three.ws/api/tutor/session?sessionId=my-session-1'
```

Or use the browser UI at [https://three.ws/tutor](https://three.ws/tutor).

## Environment variables

- `DATABASE_URL`: session persistence (preferred, and what production uses). The `tutor_sessions` table is created on first write.
- `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` (or `three_KV_REST_API_URL` / `three_KV_REST_API_TOKEN`, or `KV_REST_API_URL` / `KV_REST_API_TOKEN`): the KV tier, used only when no database is configured.
- With neither configured, sessions live in process memory and do not survive a restart or reach a second replica.
- LLM providers come from the shared chain in [../../api/_lib/llm.js](../../api/_lib/llm.js) (`GROQ_API_KEY`, `OPENROUTER_API_KEY`, and the rest); a caller-supplied Anthropic key can be passed through as BYOK.

## Platform connections

- **x402**: `POST /api/x402/tutor` charges 10000 atomics ($0.01) per answer in USDC on Base or Solana. The route is deliberately de-listed from the public x402 discovery catalog (internal-use: the `/tutor` page and the `/play` Schoolmarm NPC buy through it); do not re-add it.
- **Billing model**: simple per-call settlement, one micropayment per explanation. Viewing the tab and closing the session are always free.
- **Attestation**: the running tab and the final invoice each carry a SHA-256 attestation over the line items, so a learner or agent can verify the bill was not altered.
