# NVIDIA models on three.ws — the free inference layer

three.ws runs a large share of its AI on NVIDIA's free hosted models. **One key — `NVIDIA_API_KEY` (an `nvapi-…` token from [build.nvidia.com](https://build.nvidia.com)) — unlocks every model on this page.** There is no per-model billing, no per-seat cost, and no SLA: it is a rate-limited free tier, which is exactly why the platform treats it as a *free-first* lane and always keeps a fallback behind it.

This document is the canonical map of **which NVIDIA-hosted model does what, where it's wired, and why**. Every model and endpoint below is in production source — nothing here is aspirational.

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
| **Text → image** | `black-forest-labs/flux.1-schnell` | `api/_mcp3d/text-to-image.js` | ✅ |
| **LLM (default lane)** | `meta/llama-3.3-70b-instruct` | `api/_lib/llm.js`, `api/_lib/chat-models.js` | ✅ |
| **LLM (model garden)** | Nemotron 120B / 49B / Nano 9B, Llama 4 Maverick, DeepSeek V4 Pro, Kimi K2.6, MiniMax M2.7 | `api/brain/chat.js` | ✅ |
| **Vision / VLM** | `nvidia/nemotron-nano-12b-v2-vl`, `meta/llama-3.2-11b-vision-instruct` | `api/_lib/vision.js` | ✅ |
| **Embeddings** | `nvidia/nv-embedqa-e5-v5`, `baai/bge-m3` | `api/_lib/embeddings.js`, `api/agents/_id/embed.js` | ✅ |
| **Reranking** | `nvidia/rerank-qa-mistral-4b` | `api/_lib/rerank.js` | ✅ |
| **Content safety** | `nvidia/llama-3.1-nemoguard-8b-content-safety`, `meta/llama-guard-4-12b` | `api/_lib/moderation.js` | ✅ |
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
- **Quality scales by sampling steps**, clamped to TRELLIS's 10–50 window: draft `15/15`, standard `25/25`, high `40/40` (`ss_sampling_steps` / `slat_sampling_steps`).
- Prompts are clamped to **77 characters** (TRELLIS truncates server-side) and get a `, studio lighting` suffix unless the caller already supplied lighting/color cues — without it TRELLIS defaults to dark, gritty output.
- Output GLBs arrive in several shapes over time (inline base64, bare string, CDN URL, numeric-keyed object, raw bytes); the extractor normalizes all of them, then **persists the bytes to R2** so three.ws owns a durable public URL.

**Key constraint — text only.** NVIDIA's *hosted preview* rejects every user-image input form (verified live; see `tasks/nvidia-nim/probes/trellis.md`). So **photo→3D never routes here** — it falls to the free Hugging Face Spaces lane (Hunyuan3D / TRELLIS / TripoSR). A self-deployed TRELLIS NIM accepts real images; this is a hosted-preview limitation, not a model one.

---

## 2. Text → image — FLUX.1-schnell

**Model:** `black-forest-labs/flux.1-schnell` · **Endpoint:** `ai.api.nvidia.com/v1/genai/black-forest-labs/flux.1-schnell`
**Source:** [api/_mcp3d/text-to-image.js](../api/_mcp3d/text-to-image.js).

FLUX.1-schnell is the **free, first-choice text-to-image lane**. It's a synchronous invoke — the image returns inline as base64 (no poll) in ~1–2 s — and it's Apache-2.0, commercial-OK.

**Where it's used:**
- **The reference-image step of the image-intermediate 3D path.** When a prompt is reconstructed to a mesh, FLUX paints the reference view first, which the free reconstruction lanes (TRELLIS / Hunyuan3D) then turn into geometry. A photo-quality reference reconstructs into a far better mesh than a busy scene, so the lane steers FLUX toward a clean, centered subject.
- General text→image wherever the platform needs a synthesized image.

**Fallback order:** NVIDIA FLUX (free) → Vertex Imagen (`GOOGLE_CLOUD_PROJECT`) → Replicate `flux-schnell` ($0.003/image). The free NVIDIA lane always leads.

---

## 3. LLM chat & reasoning

NVIDIA NIM hosts 100+ open-weight chat models behind the one key, all OpenAI-compatible at `integrate.api.nvidia.com/v1/chat/completions`. three.ws uses them two ways.

### 3a. The default production lane

**Model:** `meta/llama-3.3-70b-instruct`
**Source:** [api/_lib/llm.js](../api/_lib/llm.js), [api/_lib/chat-models.js](../api/_lib/chat-models.js).

The platform's general LLM helper runs a **free-first ladder: Groq → OpenRouter → NVIDIA NIM**, and only then a paid backstop (Anthropic/OpenAI). NVIDIA is the **independent third free lane** — same Llama 3.3 70B family as the Groq/OpenRouter entries, but a different provider, so an outage on two lanes still answers on the third. It's tool/function-calling capable, so it's eligible for tool-required requests.

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

For anonymous (signed-out) callers, only the genuinely free tiers — the OpenRouter open-weight default plus these NVIDIA NIM models — are selectable. Each shows "unavailable" until the key is set, and `meta/llama-3.3-nemotron-super-49b-v1.5` also appears in the routing catalog as a tool-capable fallback model.

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

---

## 5. Embeddings — semantic retrieval

**Primary:** `nvidia/nv-embedqa-e5-v5` (1024-dim) · **Endpoint:** `integrate.api.nvidia.com/v1/embeddings`
**Source:** [api/_lib/embeddings.js](../api/_lib/embeddings.js) (tag `nvidia/nv-embedqa-e5-v5@1024`).

The default embedder for new vectors — **free with the one key, 1024 dimensions, hard-capped at 512 input tokens** (longer inputs are rejected upstream, so callers chunk to fit). Vectors are tagged with `model@dimension` so a later model swap can't silently mix incompatible spaces. Powers **agent memory and knowledge-widget retrieval**; the paid embedding provider is demoted to backup behind it.

**Also:** `baai/bge-m3` — a second NIM-hosted embedder used by [api/agents/_id/embed.js](../api/agents/_id/embed.js) for the agent-embed path.

---

## 6. Reranking — sharpening retrieval

**Model:** `nvidia/rerank-qa-mistral-4b` · **Endpoint:** `ai.api.nvidia.com/v1/retrieval/nvidia/reranking`
**Source:** [api/_lib/rerank.js](../api/_lib/rerank.js).

Cosine-over-embeddings recall is cheap but coarse. This **cross-encoder reranker** re-scores the top passages so the most relevant context leads. It is **opt-in** (`KNOWLEDGE_RERANK_ENABLED=1` plus the NVIDIA key) and **strictly fail-open** — any rerank error keeps the original cosine ordering. Reranking may improve retrieval but may never break it. Used to refine knowledge-widget answers.

---

## 7. Content safety — NemoGuard

**Primary:** `nvidia/llama-3.1-nemoguard-8b-content-safety` · **Drop-in alt:** `meta/llama-guard-4-12b`
**Endpoint:** `integrate.api.nvidia.com/v1/chat/completions` · **Source:** [api/_lib/moderation.js](../api/_lib/moderation.js).

A free content-safety pre-filter for anonymous chat. NemoGuard classifies the inbound user message and returns a **JSON verdict plus named risk categories** (harm, self-harm, weapons, sexual content, …); the parser also accepts Llama Guard's `unsafe\nS#` text form, which is why the two are interchangeable. Median ~340 ms on the free tier.

**Scope and posture:** it is a *content*-safety classifier, **not** a jailbreak / prompt-injection detector. It is **fail-open** — anything it can't parse returns "not flagged" so a moderation outage never takes chat down. Only a clean parsed "unsafe" verdict blocks a message.

---

## 8. Text-to-speech — Magpie (Riva)

**Model:** `magpie-tts-multilingual` · **Transport:** Riva gRPC at `grpc.nvcf.nvidia.com:443`
**Source:** [api/_lib/tts-nvidia.js](../api/_lib/tts-nvidia.js) (mirrored in `packages/avatar-agent-mcp/src/lib/tts-nvidia.js`).

The free NVIDIA TTS lane — **Magpie multilingual on Riva**, selected by an NVCF `function-id`, speaking over the standard Riva gRPC synthesis contract (protos shipped in `riva-protos/` and loaded from a generated descriptor, so there's no `.proto` build step). Drives **avatar speech** with multilingual voices. Configured by the presence of `NVIDIA_API_KEY`; returns synthesized audio bytes, with a clear error if the lane returns empty audio.

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

Probe transcripts for every lane — request/response shapes, limits, verified behavior — live under `tasks/nvidia-nim/probes/`.
