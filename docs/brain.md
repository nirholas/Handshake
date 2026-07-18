# Multi-LLM Brain: one prompt, every model, side by side

The Brain lab sends a single prompt to many frontier models at once and streams
their answers side by side, each with live latency and token stats. Claude, GPT,
Qwen, ModelScope, Groq, and more respond in parallel so you can compare tone, speed,
and cost before you wire a model into an agent. It is the fastest way to decide which
brain an agent should carry.

Page: [/brain](https://three.ws/brain) · API: `/api/brain/chat`

## Why it exists

Choosing a model from a spec sheet is guesswork. The only honest comparison is the
same prompt, at the same moment, across every candidate, with real timing. Brain
gives you that: a compare view that fans one prompt out to the whole roster and shows
you who answered first, who was most thorough, and what each one cost in tokens. It
also doubles as the model picker behind the Brain tab of
[Agent Studio](./agent-studio.md), so the model you pick here is the model your agent
runs on.

## How it works

`/api/brain/chat` is a multi-LLM proxy with two verbs.

- **`GET /api/brain/chat`** returns the available providers and which are currently
  reachable, so the UI can gray out anything whose upstream key is missing.
- **`POST /api/brain/chat`** takes `{ provider, messages, system?, maxTokens? }` and
  streams the answer back as Server-Sent Events:
  - `event: meta` with `{ provider, label, network, model, tier }`
  - `event: first` with `{ firstTokenMs }` (the time-to-first-token the UI shows)
  - data-only frames carrying JSON-encoded text chunks
  - `event: done` with `{ elapsedMs, firstTokenMs, usage }` (the token stats)
  - `event: error` with `{ message, elapsedMs }`

Each provider spec declares its native first-party model (built from a first-party
key when present) and the OpenRouter model id that mirrors it. The proxy prefers the
native model and falls back to routing through OpenRouter, and if a native provider
hits a quota, billing, or rate-limit error at request time it reroutes around the
outage through the mirrored OpenRouter id. The roster spans Anthropic (Claude Fable
5, Mythos 5, Opus 4.7, Sonnet 4.6, Haiku 4.5), OpenAI (GPT-OSS 120B, the GPT-5.x
family, o3 family), xAI (Grok 4.x), Groq (Llama 3.3 70B), DashScope (Qwen Plus),
ModelScope (Qwen3-Coder 480B), DeepSeek R1, and IBM Granite on watsonx.ai. In compare
mode the page opens one streaming POST per selected provider and renders them in a
grid, so every model streams concurrently rather than in sequence.

Anonymous callers are gated to the genuinely free tiers only (the OpenRouter-routed
open-weight default and the free NVIDIA NIM models); every paid first-party model
requires sign-in so an unauthenticated script cannot drain the server's billed API
keys.

## Walkthrough

1. **Open [/brain](https://three.ws/brain).** The provider roster loads from
   `GET /api/brain/chat`; unavailable providers are marked.
2. **Pick your models.** Select one for a focused chat, or switch to Compare mode to
   query all selected models at once.
3. **Type one prompt.** Optionally set a system prompt to steer every model
   identically.
4. **Watch them stream.** Each column shows the model streaming in real time, with
   time-to-first-token appearing the moment the first chunk lands.
5. **Read the stats.** When a model finishes, its column shows total elapsed time and
   token usage from the `done` event.
6. **Commit a choice.** Carry the winner into your agent via the Brain tab of
   [Agent Studio](./agent-studio.md).

## Examples

List the reachable providers:

```bash
curl -s https://three.ws/api/brain/chat
# returns { providers: [ { key, label, network, available, ... }, ... ] }
```

Stream one model's answer as SSE (the free default needs no auth; paid models need a
session or bearer token, see [Authentication](./authentication.md)):

```bash
curl -N -s -X POST https://three.ws/api/brain/chat \
  -H 'content-type: application/json' \
  -d '{
    "provider": "gpt-oss-120b",
    "system": "You are terse.",
    "messages": [{ "role": "user", "content": "Name three uses for a 3D avatar." }],
    "maxTokens": 256
  }'
# streams event: meta ... / event: first { firstTokenMs } / data chunks / event: done { elapsedMs, usage }
```

To compare, open one POST per provider concurrently (this is exactly what Compare mode
does in the browser):

```bash
for p in claude-sonnet-4-6 gpt-oss-120b groq-llama modelscope-qwen; do
  curl -N -s -X POST https://three.ws/api/brain/chat \
    -H 'content-type: application/json' \
    -H "authorization: Bearer $THREEWS_TOKEN" \
    -d "{\"provider\":\"$p\",\"messages\":[{\"role\":\"user\",\"content\":\"One-line pitch for three.ws\"}]}" &
done; wait
```

## States and limits

- **Availability gating.** A provider whose upstream key is absent shows as
  unavailable in the roster and is skipped rather than erroring mid-stream.
- **Anonymous scope.** Signed-out users can only call the free tiers (the
  OpenRouter-routed default and free NVIDIA NIM models). Paid first-party models
  return an auth requirement.
- **Automatic failover.** A native provider outage (quota, billing, rate limit) is
  rerouted through the mirrored OpenRouter model at request time, so a single upstream
  hiccup does not blank a column.
- **Streaming errors are per-column.** An `event: error` frame fails only that
  provider's column; the rest keep streaming.
- **Token stats.** `usage` in the `done` event reflects the provider's reported token
  counts; context window and tier shown per model come from the roster metadata.

## Related

- [Agent Studio](./agent-studio.md): the Brain tab uses this same backend
- [Agent System](./agent-system.md): how a chosen brain fits the agent model
- [Persona Hub](./persona-hub.md): synthesizing the system prompt a brain runs
- [API reference](./api-reference.md) and [Authentication](./authentication.md)
- Pages: [/brain](https://three.ws/brain), [/agent-studio](https://three.ws/agent-studio)
