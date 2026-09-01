# NVIDIA models on three.ws — the free inference layer

If you generate a 3D model on [/forge](https://three.ws/forge), chat with an agent, or hear an avatar speak, there is a good chance an NVIDIA-hosted model did the work. This page is for developers and operators who want to know exactly which model sits behind each feature.

three.ws runs a large share of its AI on NVIDIA's free hosted models. **One key — `NVIDIA_API_KEY` (an `nvapi-…` token from [build.nvidia.com](https://build.nvidia.com)) — unlocks every model on this page.** There is no per-model billing, no per-seat cost, and no SLA: it is a rate-limited free tier, which is exactly why the platform treats it as a *free-first* lane and always keeps a fallback behind it.

This document is the canonical map of **which NVIDIA-hosted model does what, where it's wired, and why**. Every model and endpoint below is in production source — nothing here is aspirational.

As of July 2026, three.ws is also a **member of the NVIDIA Inception program** ([details](/docs/nvidia-inception)). The free hosted lane on this page is unchanged by that: membership adds GPU credits, hardware access, and engineering support on top of it, which is how the platform scales past free-tier rate limits without giving up the free-first design.

---

## How the platform talks to NVIDIA

NVIDIA exposes its catalog over a few distinct surfaces. three.ws uses four:

| Surface | Base URL | Shape | What runs here |
| --- | --- | --- | --- |
| **NIM (OpenAI-compatible)** | `https://integrate.api.nvidia.com/v1` | `chat/completions`, `embeddings` | LLM chat, vision (VLM), embeddings, content-safety |
| **GenAI invoke** | `https://ai.api.nvidia.com/v1/genai/…` | Async (202 + poll) or sync | TRELLIS text→3D, FLUX text→image |
| **Retrieval** | `https://ai.api.nvidia.com/v1/retrieval/nvidia/reranking` | Sync rerank | Cross-encoder reranking |
| **NVCF gRPC** | `grpc.nvcf.nvidia.com:443` | Riva gRPC | Magpie text-to-speech |
| **NVCF status** | `https://api.nvcf.nvidia.com/v2/nvcf/pexec/status/{id}` | Poll | Async job status (TRELLIS) |

Because it is one key for everything, a deployment either has the whole NVIDIA layer or none of it — every consumer below degrades gracefully when `NVIDIA_API_KEY` is absent.

---

## The catalog at a glance

| Capability | NVIDIA model(s) | Wired in | Free? |
| --- | --- | --- | --- |
| **Text → 3D** | `microsoft/trellis` | `api/_providers/nvidia.js`, `api/_lib/forge-tiers.js` | ✅ |
| **Text → image** | `black-forest-labs/flux.1-dev` | `api/_mcp3d/text-to-image.js` | ✅ |
| **LLM (default lane)** | `nvidia/nemotron-3-super-120b-a12b` (compact rung: `nvidia/nemotron-3-nano-30b-a3b`) | `api/_lib/llm.js`, `api/_lib/chat-models.js` | ✅ |
| **LLM (model garden)** | Nemotron 120B / 49B / Nano 9B, Llama 4 Maverick, DeepSeek V4 Pro, Kimi K2.6, MiniMax M2.7 | `api/brain/chat.js` | ✅ |
| **Vision / VLM** | `nvidia/nemotron-nano-12b-v2-vl`, `meta/llama-3.2-11b-vision-instruct` | `api/_lib/vision.js` | ✅ |
| **Embeddings** | `nvidia/nv-embedqa-e5-v5` | `api/_lib/embeddings.js` (and `api/agents/_id/embed.js`, which delegates to it) | ✅ |
| **Reranking** | `nvidia/rerank-qa-mistral-4b` | `api/_lib/rerank.js` | ✅ |
| **Content safety** | `nvidia/llama-3.1-nemoguard-8b-content-safety`, `meta/llama-guard-4-12b` | `api/_lib/publish-safety.js` | ✅ |
| **Text-to-speech** | `magpie-tts-multilingual` (Riva) | `api/_lib/tts-nvidia.js` | ✅ |

---

## 1. Text → 3D — Microsoft TRELLIS

**Model:** `microsoft/trellis` · **Endpoint:** `ai.api.nvidia.com/v1/genai/microsoft/trellis` → poll `api.nvcf.nvidia.com/v2/nvcf/pexec/status/{id}`
**Source:** [api/_providers/nvidia.js](../api/_providers/nvidia.js), registered as the `nvidia` backend in [api/_lib/forge-tiers.js](../api/_lib/forge-tiers.js).

This is the headline free model. **Microsoft TRELLIS hosted on NVIDIA NVCF gives `/forge` a zero-vendor-cost text→3D lane that returns a textured GLB.** It is the default draft/standard engine for prompt generations, per the platform's free-first policy.

**Where it's used:**
- The `/forge` web app — draft and standard tiers default here (`FREE_DEFAULT_FOR_TIERS`).
- The free **`forge_free` MCP tool** — text prompt → downloadable GLB + viewer link, no payment, no wallet, no key.
- The **IBM × three.ws x402 demo** — the free generator next to the paid USDC Forge.
- The **auto-generation gallery** — a fresh community avatar every minute.

**How it works:**
- Async by default. Submit returns `202 + NVCF-REQID`; the forge polls the NVCF status endpoint until the GLB is ready (or the job completes synchronously within a 30 s window).
- **Sampling steps are pinned to the proven budget.** TRELLIS accepts 10 to 50 steps, but the hosted preview only returns inside the gateway's synchronous window at the low end, so the free lane runs `15/15` (`ss_sampling_steps` / `slat_sampling_steps`) for both draft and standard tiers. The `40/40` budget is reserved for a self-hosted TRELLIS NIM; the high tier itself defaults to the self-hosted Hunyuan3D engine, not this lane.
- Prompts are clamped to **77 characters** (TRELLIS truncates server-side) and get a `, studio lighting` suffix unless the caller already supplied lighting/color cues — without it TRELLIS defaults to dark, gritty output.
- Output GLBs arrive in several shapes over time (inline base64, bare string, CDN URL, numeric-keyed object, raw bytes); the extractor normalizes all of them, then **persists the bytes to R2** so three.ws owns a durable public URL.

**Key constraint: text only.** NVIDIA's *hosted preview* rejects every user-image input form (verified live 2026-06-11). So **photo to 3D never routes here**: it falls to the free reconstruct chain in `FREE_FALLBACK_FOR_PATH` (the self-hosted TRELLIS GPU worker first, then the self-hosted Hunyuan3D worker, then the free Hugging Face Spaces lane). A self-deployed TRELLIS NIM accepts real images; this is a hosted-preview limitation, not a model one.

---

## 2. Text → image: FLUX.1-dev

**Model:** `black-forest-labs/flux.1-dev` · **Endpoint:** `ai.api.nvidia.com/v1/genai/black-forest-labs/flux.1-dev`
**Source:** [api/_mcp3d/text-to-image.js](../api/_mcp3d/text-to-image.js).

FLUX.1-dev is the **free NVIDIA text-to-image lane** (the hosted FLUX.1-schnell preview was retired, so the lane moved to the dev checkpoint at 20 steps, CFG 3.5). It is a synchronous invoke: the image returns inline as base64, no poll.

**Where it's used:**
- **The reference-image step of the image-intermediate 3D path.** When a prompt is reconstructed to a mesh, FLUX paints the reference view first, which the free reconstruction lanes (TRELLIS / Hunyuan3D) then turn into geometry. A photo-quality reference reconstructs into a far better mesh than a busy scene, so the lane steers FLUX toward a clean, centered subject.
- General text→image wherever the platform needs a synthesized image.

**Ladder order.** When `GOOGLE_CLOUD_PROJECT` is set, Vertex Imagen leads by default because it outdraws distilled FLUX for photoreal reference images and spends the GCP credit pool the platform is funded to burn (`VERTEX_IMAGEN_FIRST=0` restores the NIM-first order). After that: NVIDIA FLUX.1-dev (free) → the Hugging Face router (`HF_TOKEN`; fal-ai, then nscale, both serving FLUX.1-schnell in 2-5 s) → the Livepeer federation lane (behind `LIVEPEER_FEDERATION_ENABLED`) → Pollinations (keyless, so a fallback always exists past every keyed rung) → Replicate `flux-schnell` ($0.003/image, the paid backstop). The whole ladder shares one budget, `TEXT_TO_IMAGE_BUDGET_MS` (default 60 s): each lane gets a bounded slice of what remains so a stalled provider cannot hold a Forge submit for minutes, and exhausting the budget returns a retryable `rate_limited` error (`retryAfter: 15`) rather than a hung request.

---

## 3. LLM chat & reasoning

NVIDIA NIM hosts 100+ open-weight chat models behind the one key, all OpenAI-compatible at `integrate.api.nvidia.com/v1/chat/completions`. three.ws uses them two ways.

### 3a. The default production lane

**Model:** `nvidia/nemotron-3-super-120b-a12b` (with `nvidia/nemotron-3-nano-30b-a3b` as the compact Nemotron rung)
**Source:** [api/_lib/llm.js](../api/_lib/llm.js), [api/_lib/chat-models.js](../api/_lib/chat-models.js).

The platform's general LLM helper runs a **free-first ladder: Groq → Cerebras → OpenRouter → NVIDIA NIM**, followed by further keyless free rungs (OVH, Gemini, Pollinations) and only at the very end a paid backstop (Anthropic/OpenAI). Every free rung was re-pointed on 2026-08-27 to models the providers still serve: Groq now runs `qwen/qwen3.8-27b` (instant tier `openai/gpt-oss-20b`), Cerebras keeps `llama-3.3-70b`, and the NVIDIA rung runs Nemotron 3 Super 120B, an NVIDIA MoE on an independent provider, so an outage on the other free lanes still answers here. Both NVIDIA rungs are called with thinking disabled (`chat_template_kwargs: { enable_thinking: false }`) so a chat turn answers instead of reasoning out loud. Both are tool/function-calling capable, so they are eligible for tool-required requests.

This lane powers the platform's built-in AI surfaces — chat, embedded site widgets, the tutor, the fact-checker, persona tools, agent-to-agent talk, the transaction explainer — all of which lead with the free providers and only fall through to a paid model if every free lane fails.

### 3b. The Brain model garden

**Source:** [api/brain/chat.js](../api/brain/chat.js) — the Brain workbench lets users pick a model. The NVIDIA-hosted options, all unlocked by the single key:

| Brain label | Model id | Tier | What it's for |
| --- | --- | --- | --- |
| Nemotron 3 Super 120B | `nvidia/nemotron-3-super-120b-a12b` | flagship | NVIDIA's flagship Nemotron MoE — strong agentic reasoning |
| Llama-Nemotron Super 49B | `nvidia/llama-3.3-nemotron-super-49b-v1.5` | reasoning | Nemotron reasoning tuned on Llama 3.3 — math, code, planning |
| Nemotron Nano 9B | `nvidia/nvidia-nemotron-nano-9b-v2` | balanced | Compact Nemotron with built-in reasoning — strong quality per token |
| DeepSeek V4 Pro | `deepseek-ai/deepseek-v4-pro` | reasoning | Deep reasoning, hosted on NIM |
| Kimi K2.6 | `moonshotai/kimi-k2.6` | flagship | Moonshot long-context agentic model |
| Llama 4 Maverick | `meta/llama-4-maverick-17b-128e-instruct` | balanced | Meta's 128-expert MoE — fast, multimodal-capable |
| MiniMax M2.7 | `minimaxai/minimax-m2.7` | balanced | General reasoning and chat |

For anonymous (signed-out) callers, only the genuinely free tiers (the OpenRouter open-weight default plus these NVIDIA NIM models) are selectable. Each shows "unavailable" until the key is set. The routing catalog in `chat-models.js` also lists `nvidia/nemotron-3-super-120b-a12b`, `nvidia/nemotron-3-nano-30b-a3b`, and `nvidia/llama-3.3-nemotron-super-49b-v1.5` as tool-capable NVIDIA models, and the Brain's own fallback chain still appends `meta/llama-3.3-70b-instruct` on NIM behind the OpenRouter rungs when a chosen route is dead.

> **Where the line is:** Nemotron and the `nvidia/…`-prefixed models are NVIDIA's own. The others in this table (DeepSeek, Kimi, Llama 4, MiniMax) are third-party open weights that NVIDIA *hosts and serves free* on NIM — so they ride the same key, but the model itself isn't NVIDIA's. The point of NIM is exactly this: one free key, a whole model garden.

---

## 4. Vision / VLM — image understanding

**Models (in order):** `nvidia/nemotron-nano-12b-v2-vl` → `meta/llama-3.2-11b-vision-instruct`
**Source:** [api/_lib/vision.js](../api/_lib/vision.js).

Two free NIM vision lanes on the OpenAI-compatible chat host. Nemotron Nano VL leads because it carries the **smallest image-token footprint** (~281 prompt tokens for a small image vs ~1600 for a 90B-class model); the Llama 3.2 11B vision model is a different family, so its failure modes are independent — a true fallback, not a retry. Images pass as an http(s) URL (the model server fetches it) with SSRF validation on the URL before it leaves the box.

**Where it's used:**
- **Forge photo pre-check** — before a generation slot is spent, the uploaded photo is screened: a screenshot of text, a cluttered subject-less scene, or a too-dark image gets a heads-up and a fix (with a one-click "Generate anyway").
- **Fact Checker image evidence** — reads a picture alongside a claim, transcribes any text in it, and weighs it in the verdict.
- **Avatar gallery alt-text** — writes real, descriptive alt text from each avatar's thumbnail for screen-reader users.

All three **fail safe**: if the vision lane is unavailable, the feature quietly switches off — it never blocks or breaks the primary flow.

The chain is budgeted and remembers what hurt. Each attempt gets an even share of whatever remains on the caller's deadline (`laneAttemptTimeout`, never below 3.5 s), so the first rung cannot consume the budget of the rest, and the pre-chain inline image fetch is capped at a quarter of the deadline and 8 s. A lane that fails is cooled for 45 s through the shared provider-health ledger (`api/_lib/provider-health.js`) and moved behind the healthy rungs on the next call rather than re-picked; a `429` cools every sibling lane on that host and skips them for the rest of the call, and a `401`/`403`/`402` earns the longer auth cooldown. A success clears the lane's cooldown.

---

## 5. Embeddings — semantic retrieval

**Primary:** `nvidia/nv-embedqa-e5-v5` (1024-dim) · **Endpoint:** `integrate.api.nvidia.com/v1/embeddings`
**Source:** [api/_lib/embeddings.js](../api/_lib/embeddings.js) (tag `nvidia/nv-embedqa-e5-v5@1024`).

The default embedder for new vectors: **free with the one key, 1024 dimensions, hard-capped at 512 input tokens** (longer inputs are rejected upstream, so callers chunk to fit). Vectors are tagged with `model@dimension` so a later model swap can't silently mix incompatible spaces. Powers **agent memory and knowledge-widget retrieval**; the paid embedding provider is demoted to backup behind it. At ingest, `embedPassagesAny()` walks every configured embedder in free-first order (NIM → Vertex → OpenAI, the caller's preferred tag first), cooling a lane that fails for 45 s (longer on an auth fault) so the next ingest starts on a healthy rung, and returns the tag it actually used so the document set is stamped with the space its vectors live in. Search-side, the Agent Galaxy falls back to lexical ranking when the embedder cannot answer, because a query vector from another model cannot be compared against vectors stored in a different space.

**Also:** the agent-embed endpoint [api/agents/_id/embed.js](../api/agents/_id/embed.js) does not carry a provider list of its own. It delegates to the registry above, so `POST /api/agents/:id/embed` serves this same model and returns the tag alongside the vector. It previously called `baai/bge-m3` directly; NVIDIA stopped serving that model on the hosted endpoint (500 on every request), which is exactly the failure mode a single registry prevents.

---

## 6. Reranking — sharpening retrieval

**Model:** `nvidia/rerank-qa-mistral-4b` · **Endpoint:** `ai.api.nvidia.com/v1/retrieval/nvidia/reranking`
**Source:** [api/_lib/rerank.js](../api/_lib/rerank.js).

Cosine-over-embeddings recall is cheap but coarse. This **cross-encoder reranker** re-scores the top passages so the most relevant context leads. It is **opt-in** (`KNOWLEDGE_RERANK_ENABLED=1` plus the NVIDIA key) and **strictly fail-open** — any rerank error keeps the original cosine ordering. Reranking may improve retrieval but may never break it. Used to refine knowledge-widget answers.

---

## 7. Content safety — NemoGuard

**Primary:** `nvidia/llama-3.1-nemoguard-8b-content-safety` · **Drop-in alt:** `meta/llama-guard-4-12b`
**Endpoint:** `integrate.api.nvidia.com/v1/chat/completions` · **Source:** [api/_lib/publish-safety.js](../api/_lib/publish-safety.js).

A free content-safety classifier for what the platform publishes outward. Its only caller is the Sketchfab showcase cron, which uploads visitor-generated models to our own official account on a third party's platform. NemoGuard classifies the source prompt and returns a **JSON verdict plus named risk categories** (harm, self-harm, weapons, sexual content, …); the parser also accepts Llama Guard's `unsafe\nS#` text form, which is why the two are interchangeable. Median ~340 ms on the free tier.

**Scope and posture:** it screens OUTBOUND publishing only. No three.ws chat surface filters what a user may ask (owner directive 2026-08-07): whatever safety judgment the serving model makes is the only one those routes apply. It is also a *content*-safety classifier, **not** a jailbreak / prompt-injection detector, and it is **fail-open**: anything it can't parse returns "not flagged", so a classifier outage never stops a publish. Only a clean parsed "unsafe" verdict blocks an upload.

---

## 8. Text-to-speech — Magpie (Riva)

**Model:** `magpie-tts-multilingual` · **Transport:** Riva gRPC at `grpc.nvcf.nvidia.com:443`
**Source:** [api/_lib/tts-nvidia.js](../api/_lib/tts-nvidia.js) (mirrored in `packages/avatar-agent-mcp/src/lib/tts-nvidia.js`).

The free NVIDIA TTS lane: **Magpie multilingual on Riva**, selected by an NVCF `function-id`, speaking over the standard Riva gRPC synthesis contract (protos shipped in `api/_lib/riva-protos/` and loaded from a generated descriptor, so there's no `.proto` build step). Drives **avatar speech** with multilingual voices. Configured by the presence of `NVIDIA_API_KEY`; returns synthesized audio bytes, with a clear error if the lane returns empty audio.

---

## Design principles across every lane

1. **Free-first, always.** NVIDIA NIM leads its category (or sits in a free trio with Groq/OpenRouter) before any paid model is touched. Cost to the platform is $0.
2. **One key, whole layer.** `NVIDIA_API_KEY` is the only credential. Present → the layer is live; absent → every consumer degrades to its next lane or switches off cleanly.
3. **Fail-open / fail-safe.** Safety, rerank, and vision never break the primary flow — a NVIDIA outage downgrades quietly, it doesn't error the user.
4. **Independent fallbacks.** Where reliability matters, the fallback is a *different model family* (vision) or a *different provider* (chat), not a retry of the same thing.
5. **It's a free tier, not an SLA.** Rate-limited, no uptime guarantee — great for the default path precisely because there's always something behind it.

---

## Environment

| Variable | Unlocks |
| --- | --- |
| `NVIDIA_API_KEY` | Every model on this page (`nvapi-…` from build.nvidia.com) |
| `KNOWLEDGE_RERANK_ENABLED=1` | Turns on the rerank stage (§6) |
| `FORGE_PREFER_FREE` | Free-first reconstruct ordering (default on) |
| `TEXT_TO_IMAGE_BUDGET_MS` | Shared deadline for the whole text-to-image ladder (§2), default 60000 |
| `VERTEX_IMAGEN_FIRST=0` | Puts the free NIM FLUX lane ahead of Vertex Imagen again (§2) |
| `HF_TOKEN` | Unlocks the Hugging Face router rungs (fal-ai, nscale) in the text-to-image ladder (§2) |

---

## Related

- [NVIDIA Inception membership](/docs/nvidia-inception) - what membership adds on top of this free lane
- [The generator was never the hard part](/docs/nvidia-nemotron-spotlight) - our Nemotron Nano write-up, published on the NVIDIA Developer Forums
- [Image-to-3D on NVIDIA L4 and Blackwell](https://three.ws/blog/image-to-3d-on-nvidia-l4-and-blackwell) - the self-hosted GPU fleet behind the paid lanes, and the two walls we hit moving to Blackwell
- [How Forge works](/docs/how-forge-works) - the /forge product this layer powers
- [REST API](/docs/api-reference) - the endpoints these models serve
- [Configuration](/docs/configuration) - all environment variables
- [MCP](/docs/mcp) - the `forge_free` MCP tool on the free TRELLIS lane
