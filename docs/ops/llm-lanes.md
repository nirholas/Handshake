# LLM lanes: what actually serves traffic, what it costs, and how to add Claude

The platform never calls one model. Every text surface runs an ordered chain of
providers and falls through it on any failure, so the question "which model
answered" has a different answer per request. This doc is the operator's view of
that chain: which rungs are alive, which are dead and why, how spend is metered,
and the exact command to add Claude when a key arrives.

Every number here was measured, not remembered. Re-measure before trusting it:
the probe commands are in [Probing a lane](#probing-a-lane) and they take
seconds.

---

## The chain

`api/_lib/llm.js` builds it. Free rungs first, always, because the paid keys in
production are routinely dead and a chain that depends on them fails:

| # | Rung | Key | Cost to us | State |
|---|---|---|---|---|
| 1 | Groq `qwen/qwen3.8-27b` | `GROQ_API_KEY` | free | **serving** (200, ~0.4s, 2026-09-04). Capped at 8,000 tokens/MINUTE, which is ~3 fact-check stance calls: a burst falls past it while it is perfectly healthy. |
| 1b | Groq `openai/gpt-oss-120b` | `GROQ_API_KEY` | free | **serving** (200, ~1.4s, 2026-09-04). Added 2026-09-04. Same key, separate 8,000 tok/min bucket, because Groq meters per model id. |
| 2 | Cerebras `llama-3.3-70b` | `CEREBRAS_API_KEY` | free | not configured in prod |
| 3 | OpenRouter `:free` routes, one rung per key | `OPENROUTER_API_KEY`, `OPENROUTER_FALLBACK_KEYS` | free | **model id was dead 2026-09-04**: `openai/gpt-oss-20b:free` was retired and 404'd all five rungs at once (fixed, now `google/gemma-4-31b-it:free`). The account is separately capped at 1,000 free-model requests/DAY across every key (they share one owner), and was at 0 remaining when measured. |
| 4 | NVIDIA NIM `nvidia/nemotron-3-super-120b-a12b` | `NVIDIA_API_KEY` | free | **serving** (200, 1.8s-10.5s on a full-size prompt, 2026-09-04). Carried the whole platform on 2026-09-04 when Groq was token-capped, OpenRouter was dead, and both paid anchors were on billing holds. |
| 5 | SambaNova `Meta-Llama-3.3-70B-Instruct` | `SAMBANOVA_API_KEY` | free | added 2026-08-05; skipped when the key is unset |
| 6 | Mistral `mistral-small-latest` (Experiment tier) | `MISTRAL_API_KEY` | free | added 2026-08-05; skipped when the key is unset |
| 7 | Z.AI `glm-4.7-flash` | `ZAI_API_KEY` | free | added 2026-08-05; skipped when the key is unset |
| 8 | Cloudflare Workers AI `@cf/meta/llama-3.3-70b-instruct-fp8-fast` | `CLOUDFLARE_ACCOUNT_ID` + `CLOUDFLARE_AI_API_TOKEN` | free | added 2026-08-05; skipped when either is unset |
| 9 | OVH AI Endpoints `Meta-Llama-3_3-70B-Instruct` | none (keyless) | free | **serving** (200, ~1.2s, 2026-08-02) |
| 10 | Gemini Flash-Lite (AI Studio) | `GEMINI_API_KEY` | free | not configured in prod |
| 11 | **Vertex Gemini Flash** | GCP service account | GCP credits | **dead**: 403 `Lightning dunning decision is deny for project` since 2026-08-27, re-measured 2026-09-04. A billing hold on the whole GCP project, not IAM. This is the chain's designed anchor, so while it is down the free rungs above it are load-bearing rather than best-effort. |
| 12 | Pollinations `openai-fast` | none (keyless) | free | **serving** (200, ~3.7s, 2026-08-02) |
| 13 | LLM7.io `gemini-3.1-flash-lite` | `LLM7_API_KEY` | free | **dead without a key**: llm7.io retired the anonymous tier it was added on, and every unauthenticated call answers 401 `invalid_api_key` (measured 2026-09-02, the `unused` token its docs used to accept included). Key-gated since, so a deployment without the key skips it. Free key at https://dash.llm7.io/#/api-keys |
| 14 | SiliconFlow `Qwen/Qwen3-8B` | `SILICONFLOW_API_KEY` | free | added 2026-08-05; skipped when the key is unset |
| 15 | Groq `openai/gpt-oss-20b` | `GROQ_API_KEY` | free | serving (a third separate per-model quota) |
| 16 | Vertex Claude | GCP service account + `VERTEX_CLAUDE_ENABLED=1` | GCP credits | **off and unentitled** (see below) |
| 17 | Anthropic first-party | `ANTHROPIC_API_KEY` | paid | **absent** (no key anywhere) |
| 18 | OpenRouter Claude mirror | `OPENROUTER_CLAUDE_MIRROR_MODEL` | paid | off by default (see below) |
| 19 | OpenAI `gpt-5.4-nano` | `OPENAI_API_KEY` | paid | **dead**: 429 `billing_not_active` |
| 20 | xAI Grok | `GROK_API_KEY` | paid | not configured in prod |

The 2026-08-05 widening (SambaNova, Mistral, Z.AI, Cloudflare, LLM7,
SiliconFlow) added six independent free quota pools; each is documented with
its tier limits in `docs/free-llm-providers.md`. LLM7 joined that round as a
keyless rung and is no longer one (row 13), so the keyless floor a zero-env
deployment falls to is OVH and Pollinations, two rungs rather than three. Both
answered 429 from this workspace's shared egress IP on 2026-09-02, so treat the
keyless floor as best-effort: it is a real lane, not a substitute for a key.

Rungs 1 to 15 are not a degradation path any more. They are production. Every
one of them is covered by a transport-level failover test
(`tests/api/llm-free-chain-reachability.test.js`): each case kills the rungs
above it the way a provider actually dies (dropped socket, abort, empty 503) and
requires the next rung to answer. A fallback that only catches a parse error is
bypassed exactly when the provider fails, which is the defect class that test
exists to prevent.

`/brain` (`api/brain/chat.js`) runs its own chain with the same shape: requested
model → OpenRouter mirror of that model → free safety net (Groq → OpenRouter
`:free` per key → NVIDIA → SambaNova → Mistral → Z.AI) → the Vertex Gemini
anchor.

### Why the paid rungs are out

- **OpenAI**: the account returns `429 "Your account is not active, please check
  your billing details"`. The key is set and valid; the billing is not. Every
  OpenAI backstop in the platform is therefore a wasted attempt.
- **OpenRouter platform key**: `total_credits: 30`, `total_usage: 30.24`. Spent.
  It burned on paid vendor mirrors routed through `/brain`, and the metering
  reported `$0` for all of it (see [Metering](#metering)). The `:free` routes on
  the fallback keys still serve.
- **Anthropic**: no `ANTHROPIC_API_KEY` in `.env`, `.env.local`, or on the
  `three-ws-api` service. `api/chat.js`, `api/_lib/llm.js` and the embed proxy
  `api/llm/anthropic.js` reach Claude only through `api.anthropic.com`, so they
  get no Claude at all. `/brain` is the exception: it reaches Claude through the
  OpenRouter mirrors, which is why the Claude rows in its menu are selectable.
- **Vertex Claude**: `VERTEX_CLAUDE_ENABLED=0`, `VERTEX_CLAUDE_PRIMARY=0`, and
  the project is not entitled. `rawPredict` returns `404 Publisher model ... not
  found` for every Claude id in both `global` and `us-east5` while the same
  token serves Gemini fine. Flipping the flag alone would 404 every request.

---

## Adding Claude: one command

When an `ANTHROPIC_API_KEY` arrives, this is the whole rollout:

```sh
gcloud run services update three-ws-api --region us-central1 \
  --project aerial-vehicle-466722-p5 --update-env-vars ANTHROPIC_API_KEY=sk-ant-...
```

`--update-env-vars` merges. **Never `--set-env-vars`**: it replaces the entire
env set and would strip every other variable on the service.

No code change is needed. The key is read by `env.ANTHROPIC_API_KEY` and appends
an Anthropic rung to the tail of every chain automatically, ahead of the dead
OpenAI backstop and behind every free lane.

### Rate limits: keep it off the high-QPS lanes

A fresh Anthropic account starts at **Tier 1**, which is a low requests-per-minute
and tokens-per-minute ceiling, not a per-day budget. Tier 1 traffic must stay on
the low-volume surfaces:

- **Allowed**: `/chat`, `/brain`, reflection and backstop traffic. These are
  human-paced, so a per-minute ceiling is invisible.
- **Not allowed**: the x402 ring or any other agent loop that issues sustained
  automated requests. A Tier 1 key behind a machine-paced lane 429s continuously,
  and the chain then treats Claude as a dead rung on every request.

Raise the tier before widening the lanes. Two model notes that will otherwise
look like bugs:

- `claude-fable-5` requires 30-day data retention on the org. Under zero data
  retention it returns `400`.
- `claude-mythos-5` is deliberately absent from the `/brain` menu: it is
  restricted-access, so listing it would render a selectable row that 404s at
  call time. It stays in `MODEL_CATALOG` as an explicit-only, BYOK-reachable id.

### The interim option: the OpenRouter Claude mirror (off by default)

`api/chat.js` and `api/_lib/llm.js` have no OpenRouter mirror for Claude the way
`/brain` does. One exists but is **off unless explicitly enabled**, because it
spends real money on the platform key for ordinary agent traffic:

```sh
# Only with owner approval: this draws real spend.
gcloud run services update three-ws-api --region us-central1 \
  --project aerial-vehicle-466722-p5 \
  --update-env-vars OPENROUTER_CLAUDE_MIRROR_MODEL=anthropic/claude-sonnet-5
```

What it costs: the mirror bills the underlying model's list price. Sonnet 5 at
$3/$15 per 1M tokens is about **$0.006 on a 1,000-in / 300-out turn**, so roughly
**$6 per thousand such turns**. Opus 5 at $5/$25 is about 1.9x that. The platform
key's $30 balance is already spent, so enabling this also requires funding the
key first.

Guardrails, all enforced in code:

- The model must be registered `paid: true` in `MODEL_CATALOG`
  (`isPaidModel()`), or the rung is refused with a warning. That registration is
  what makes it metered rather than priced as free openrouter traffic, and what
  keeps it away from anonymous callers.
- It sits in the **paid tail**, after every free rung, never leading.
- It is skipped entirely when a caller BYOK key, a server `ANTHROPIC_API_KEY`, or
  Vertex Claude is available. It is a gap-filler, not a competitor.

---

## Metering

`api/_lib/llm-pricing.js` is the single source of truth for "what did that call
cost us", and the rule is: **a lane that spends money must never report exactly
$0.**

That rule was violated in the most expensive way possible. `openrouter` sat on a
blanket free-provider list, and OpenRouter namespaces every model by vendor
(`anthropic/claude-opus-5`), which matched no key in the price table. So a
$5/$25-per-1M-token Claude turn priced to zero twice over, and a real $30 balance
drained while the dashboard read "served free" the entire way down.

How it works now:

- OpenRouter is free **only** on its `:free` routes. Vendor mirrors price at the
  underlying model, including the dotted ids OpenRouter uses
  (`anthropic/claude-haiku-4.5` resolves to `claude-haiku-4-5`).
- Every OpenRouter request opts into usage accounting (`usage: {include: true}`)
  and records `usage.cost`, the exact amount the account was charged. A reported
  cost always outranks the price table. This works for the direct-fetch chain and
  for the AI SDK routes in `/brain` (`api/_lib/openrouter-usage.js` wraps the
  provider's `fetch`, injects the opt-in, and reads the cost off a teed copy of
  the response so streaming is untouched).
- An unpriceable spending lane records **`null` (unknown)** and logs a warning.
  It never records `0`. `usage_events.cost_micro_usd` is nullable precisely so
  unknown reads as unknown.
- `/brain` writes a `kind:'llm'` usage event per turn. It previously wrote
  nothing at all, which is why its spend was invisible. `api/chat.js` now writes
  provider, model, tokens and cost in their own columns rather than only in
  `meta`. BYOK routes record `0`: the caller's key, not the platform's.
- The one unmetered `/brain` lane is watsonx. IBM bills its trial entitlement
  outside per-token pricing, so there is no honest per-call number to record.

### The check

```sh
npm run audit:llm-metering              # last 24h
npm run audit:llm-metering -- --hours 168
npm run audit:llm-metering -- --json
```

It aggregates `usage_events` by provider and model and fails (exit 1) when any
lane with traffic reports exactly `$0` without being genuinely free, when any
call recorded an unknown cost, when tokens were served with no provider
recorded, or when a free lane somehow booked spend. It is read-only and needs
`DATABASE_URL`. The rule itself lives in `api/_lib/llm-metering-rule.js` and is
unit-tested in `tests/llm-metering-rule.test.js`, so the guard is proven to fire
without writing fake rows into the production ledger.

It is not wired into `npm run gate`: the gate is offline and this needs the
database. Run it after any change to a provider chain or the price table.

---

## Probing a lane

A set key is not a working key. That is the entire lesson of the OpenAI rung, so
never conclude a lane is healthy from a config read.

```sh
# Any OpenAI-compatible lane (groq / nvidia / openai / openrouter / ovh):
curl -s -X POST https://api.groq.com/openai/v1/chat/completions \
  -H "authorization: Bearer $GROQ_API_KEY" -H 'content-type: application/json' \
  -d '{"model":"llama-3.3-70b-versatile","max_tokens":16,"messages":[{"role":"user","content":"say ok"}]}'

# OpenRouter balance (the number that went to zero unnoticed):
curl -s -H "authorization: Bearer $OPENROUTER_API_KEY" https://openrouter.ai/api/v1/credits

# Vertex Claude entitlement: 404 here means Model Garden terms are not accepted.
TOK=$(gcloud auth print-access-token)
curl -s -o /dev/null -w '%{http_code}\n' -X POST \
  -H "Authorization: Bearer $TOK" -H 'content-type: application/json' \
  -d '{"anthropic_version":"vertex-2023-10-16","max_tokens":16,"messages":[{"role":"user","content":"hi"}]}' \
  "https://aiplatform.googleapis.com/v1/projects/aerial-vehicle-466722-p5/locations/global/publishers/anthropic/models/claude-sonnet-5:rawPredict"

# What production actually has set (every API key is a Secret Manager
# reference since 2026-09-02, so read them through the resolver):
node scripts/read-service-env.mjs '_API_KEY$' --names   # which secret backs each
node scripts/read-service-env.mjs '^OPENAI_API_KEY$' --raw   # one value
```

---

## Owner actions

Named here rather than waited on. The platform serves traffic without any of
them:

1. **Reactivate OpenAI billing**, or accept that every OpenAI rung is a dead
   attempt. (Removing the key entirely would be cheaper than leaving it dead.)
2. **Fund the OpenRouter platform key**, or accept `:free`-only OpenRouter. The
   fallback keys still serve free routes today.
3. **Accept Anthropic terms in Vertex Model Garden** for
   `aerial-vehicle-466722-p5`. This is the only gate on billing Claude to the
   GCP credits. Then re-probe `rawPredict` (above) and set
   `VERTEX_CLAUDE_ENABLED=1`; the Claude 5 ids are already in
   `VERTEX_ANTHROPIC_MODELS`.
4. **Supply an `ANTHROPIC_API_KEY`** if first-party Claude is wanted before
   Vertex entitlement lands. One command, above.

## Related

- [gcp-credits.md](gcp-credits.md): the credit program, the Vertex lanes, and
  the revert runbook.
- [gcp-production.md](gcp-production.md): the full production runbook.
- `api/_lib/llm.js`: the chain itself, with the policy comment at the top.
- `api/_lib/chat-models.js`: the model catalog, capability flags, and
  `isPaidModel()`.
