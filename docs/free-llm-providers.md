# Free LLM providers: the failover chain

three.ws never depends on a single AI vendor. Every text completion on the platform (chat, agent brains, copilots, translations) runs through one shared failover chain that tries free providers first, in order, and only touches a paid key as a last resort. This page is the map of that chain: which providers are in it, what each one costs (nothing), where the keys come from, and how to add the next one.

The chain lives in [`api/_lib/llm.js`](../api/_lib/llm.js) (`providerChain()` + `llmComplete()`). The interactive chat ladder in [`api/chat.js`](../api/chat.js) uses the same policy with a shorter list (see `DEFAULT_PROVIDER_ORDER` in [`api/_lib/chat-models.js`](../api/_lib/chat-models.js)).

## The chain, in order

Free rungs run first, 70B-class models before smaller ones. A keyed rung is skipped when its env var is unset; the three keyless rungs are always present, so the chain can never be empty.

| # | Rung | Model | Key | Free tier |
|---|------|-------|-----|-----------|
| 1 | Groq | `qwen/qwen3.8-27b` | `GROQ_API_KEY` | Per-minute and per-day caps, no card. Llama 3.x left Groq's catalog in August 2026; Qwen 3.8 27B is the fastest non-reasoning model left there. [console.groq.com](https://console.groq.com) |
| 2 | Cerebras | `llama-3.3-70b` | `CEREBRAS_API_KEY` | About 1M tokens/day. [cloud.cerebras.ai](https://cloud.cerebras.ai) |
| 3 | OpenRouter | `openai/gpt-oss-20b:free` | `OPENROUTER_API_KEY` (+ fallback keys) | `:free` models only; the platform key is never billed. [openrouter.ai](https://openrouter.ai) |
| 4 | NVIDIA NIM | `nvidia/nemotron-3-super-120b-a12b` | `NVIDIA_API_KEY` | Free developer tier, about 40 req/min. `meta/llama-3.x` on NIM reached end of life on 2026-08-26 (HTTP 410); Nemotron 3 is a reasoning family, so the rung sends `enable_thinking: false` to keep the answer in `content`. [build.nvidia.com](https://build.nvidia.com) |
| 5 | SambaNova | `Meta-Llama-3.3-70B-Instruct` | `SAMBANOVA_API_KEY` | About 20 req/min, 200K tokens/day per model, no card. [cloud.sambanova.ai](https://cloud.sambanova.ai) |
| 6 | Mistral | `mistral-small-latest` | `MISTRAL_API_KEY` | Experiment tier: about 1B tokens/month at 1 req/sec (account opts into data training). [console.mistral.ai](https://console.mistral.ai) |
| 7 | Z.AI | `glm-4.7-flash` | `ZAI_API_KEY` | Permanently free, rate-limited Flash models. [z.ai](https://z.ai), docs at [docs.z.ai](https://docs.z.ai) |
| 8 | Cloudflare Workers AI | `@cf/meta/llama-3.3-70b-instruct-fp8-fast` | `CLOUDFLARE_ACCOUNT_ID` + `CLOUDFLARE_AI_API_TOKEN` | 10,000 neurons/day. [developers.cloudflare.com/workers-ai](https://developers.cloudflare.com/workers-ai/) |
| 9 | OVHcloud AI Endpoints | `Meta-Llama-3_3-70B-Instruct` | none (keyless) | Anonymous trial lane, 2 req/min per IP. |
| 10 | Gemini (AI Studio) | `gemini-2.5-flash-lite` | `GEMINI_API_KEY` | AI Studio free tier, no card. [aistudio.google.com](https://aistudio.google.com) |
| 11 | Vertex Gemini | `google/gemini-2.5-flash` | GCP service account | The reliability anchor: billed to platform GCP credits, no third-party quota. |
| 12 | Pollinations | `openai-fast` | none (keyless) | Anonymous, always on. |
| 13 | LLM7.io | `gemini-3.1-flash-lite` | none (keyless) | Anonymous, about 30 req/min per IP. |
| 14 | SiliconFlow | `Qwen/Qwen3-8B` | `SILICONFLOW_API_KEY` | Free-tier small model, own quota pool. [siliconflow.com](https://siliconflow.com) |
| 15 | Groq instant | `openai/gpt-oss-20b` | `GROQ_API_KEY` | Separate per-model quota from rung 1. |

After rung 15 come the paid backstops (Vertex Claude, Anthropic, OpenAI, Grok), which never lead and which no flow depends on.

The interactive chat ladder (`/api/chat`) uses: groq → openrouter → nvidia → sambanova → mistral → zai → paid backstops, with the Vertex Gemini anchor always appended at the tail. SambaNova, Mistral, and Z.AI are also selectable as explicit `provider` values in the chat API, and anonymous callers may use them. When every anonymous-eligible free lane is throttled or in cooldown at once, `/api/chat` answers `503 rate_limited` ("The AI chat is at capacity right now") with a `Retry-After: 20` header and the `providers_tried` list, never a 401 asking a signed-out visitor to sign in for a throttle they cannot fix.

## Why so many

Every rung is an independent quota pool on independent infrastructure. Free tiers throttle, retire models without notice (OpenRouter dropped its whole `:free` Llama roster in one day, Groq and NVIDIA NIM both removed Llama 3.x in August 2026, GitHub Models was retired outright in 2026), and queue under load (NVIDIA NIM). One provider failing costs nothing; the chain moves on in under a second. The platform's baseline reliability is the product of how many independent free lanes stand between a request and an error.

Two providers were evaluated and deliberately excluded:

- **GitHub Models**: in a scheduled retirement brownout (HTTP 410) as of August 2026; the product is being sunset.
- **Cohere**: the free trial key is licensed for non-commercial use only, which three.ws does not satisfy.

## Cost accounting

All of these rungs are zero-marginal-cost, and the accounting knows it:

- `FREE_PROVIDERS` in [`api/_lib/llm-pricing.js`](../api/_lib/llm-pricing.js) prices their traffic at $0 (vs "unpriced", which is an audit failure).
- The per-user daily spend cap in `checkUserLlmSpendCap()` ([`api/_lib/llm.js`](../api/_lib/llm.js)) excludes them, so free traffic can never lock a user out.

## Adding the next provider

1. Get the model id and OpenAI-compatible endpoint (nearly every free tier has one; probe it with `curl` before writing code).
2. `api/_lib/env.js`: add the key getter with a comment stating the tier's limits.
3. `api/_lib/llm.js`: add a model `const` with rationale, then a guarded `chain.push(openaiCompatProvider({...}))` at the right rung: 70B-class before step-downs, always before the Vertex anchor if free.
4. `api/_lib/llm-pricing.js`: add the provider name to `FREE_PROVIDERS`; add it to the spend-cap exclusion list in `llm.js`.
5. `tests/api/llm-free-chain-reachability.test.js`: add the rung to `HOSTS`/`FREE_CHAIN`/`ENV_KEYS`; the exact-order assertion fails until you do.
6. If the provider should be user-selectable in chat: register it in `api/chat.js` (`PROVIDERS`, the provider enum, `FALLBACK_SIBLINGS`) and `api/_lib/chat-models.js` (`MODEL_CATALOG`, `PROVIDER_MODEL_DEFAULTS`, `DEFAULT_PROVIDER_ORDER`, `ANON_PROVIDER_LIST`).
7. `.env.example` and the env tables in [`ARCHITECTURE.md`](../ARCHITECTURE.md).

Related: [nvidia-models.md](nvidia-models.md) for the full NVIDIA NIM surface map.
