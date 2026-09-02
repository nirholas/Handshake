# NVIDIA Accelerated Apps Catalog: three.ws listing kit

Everything needed to submit three.ws to the NVIDIA Inception Accelerated Apps Catalog. The form lives behind the Inception portal login (Portal > Profile > Add product), so this doc holds the copy, categories, links, and assets ready to paste. Submissions are reviewed by NVIDIA on a rolling basis; approval is subject to fit.

Related docs: [nvidia-inception.md](./nvidia-inception.md) (membership overview), [nvidia-models.md](./nvidia-models.md) (full model map, the source of truth for every NVIDIA claim below), [nvidia-visibility-map.md](./nvidia-visibility-map.md) (every other NVIDIA surface, and the asks to batch into the request email below).

---

## Status: product record filed, public listing not live (2026-08-14)

The portal shows the product row (`three.ws | Shipping | GPU Accelerated`), but a search for `three.ws` on the public catalog returns 0 results. That is expected, not a bug: **the portal record and the public catalog are two different systems.**

- **Portal > Profile > Products** makes the company benefits-eligible and feeds NVIDIA's internal recommendation engine. The portal's own wording is "we **may** feature it in the personalized recommendations we share with our customers."
- **The public catalog** ([marketplace.nvidia.com/en-us/enterprise/applications](https://marketplace.nvidia.com/en-us/enterprise/applications/), filtered view for startups at [nvidia.com/en-gb/accelerated-applications/inception](https://www.nvidia.com/en-gb/accelerated-applications/inception/)) is curated and published by NVIDIA. Submissions are reviewed on a rolling basis and approval is subject to availability and fit. Nothing in the portal auto-publishes.

So there are exactly two things to do: make the record obviously worth featuring, then ask for the listing.

### 1. Correct the portal record (the record understates the stack)

As filed, the record lists only CUDA libraries as used, and parks every NVIDIA platform product under "Considering." That reads as a CUDA consumer, not a digital-human app, and it is wrong against the shipping code. Move these to **Technologies Used**:

| Technology | Evidence it is shipping |
|---|---|
| **Riva** (ASR + TTS) | [api/_lib/asr-nvidia.js](../api/_lib/asr-nvidia.js), [api/_lib/tts-nvidia.js](../api/_lib/tts-nvidia.js), Riva gRPC over NVCF |
| **Audio2Face** (A2F-3D) | [api/_lib/a2f-nvidia.js](../api/_lib/a2f-nvidia.js) against `grpc.nvcf.nvidia.com`, browser playback in [src/voice/a2f-player.js](../src/voice/a2f-player.js), live demo at [/demos/audio2face](https://three.ws/demos/audio2face) |
| **NIM microservices (hosted APIs)** | `integrate.api.nvidia.com`: Nemotron Super/Nano, Nemotron Nano VL, NV-EmbedQA-E5-v5, NemoGuard 8B |

Keep in **Technologies Used** and add if the form offers them: CUDA Toolkit, cuDNN, cuBLAS, CUDA Python, **NVIDIA Kaolin**, **nvdiffrast**, **L4 GPUs**, **RTX PRO 6000 Blackwell (sm_120)**.

Remove and leave unchecked:

- **DeepVariant NIM** is genomics variant calling. It has nothing to do with this product and it weakens category fit. Uncheck it.
- **TensorRT** and **Triton Inference Server** stay under "Considering": the GPU workers are PyTorch + CUDA today. Do not claim them.
- **Omniverse Kit** stays under "Considering" (OpenUSD interop is roadmap, not shipping).

### 2. Ask for the catalog listing

The portal has no "publish to catalog" button, so the request goes to the program team. Send the email in [nvidia-apps-catalog-request.md](./nvidia-apps-catalog-request.md) to `inceptionprogram@nvidia.com` after the record corrections above are saved, and note the send date there.

---

## Core fields

**App name:** three.ws

**Company name:** three.ws

**Product URL:** https://three.ws

**Tagline:** Give your AI a body.

### Short description (about 130 characters)

> three.ws turns a sentence into a rigged, animated 3D AI agent. Every generation lane runs on NVIDIA GPUs and NVIDIA-hosted models.

### Medium description (about 500 characters)

> three.ws is a browser-native platform for generating 3D avatars, worlds, and AI agents from a prompt. Text, image, and sketch inputs become textured, auto-rigged GLB models in seconds, generated on a self-hosted fleet of NVIDIA L4 GPUs (Hunyuan3D, TRELLIS, TripoSG, TripoSR) and NVIDIA-hosted models via NIM. Agents get an LLM brain (Nemotron), a voice (Riva TTS and ASR), a face (Audio2Face-3D), on-chain identity, and pay-per-call x402 monetization, then embed on any website with one script tag.

### Long description (about 1,900 characters)

> three.ws is the AI-agent layer for the open web: a browser-native platform where anyone can build, embed, and monetize autonomous agents with real 3D bodies. Type a prompt at three.ws/forge and a textured 3D model appears in seconds; upload a photo or a sketch and it becomes a mesh; one more click auto-rigs it with a full skeleton and ARKit-52 blendshapes, ready to talk, walk, and be embedded anywhere with a single script tag. No plugins, no installs, no account required for the free lane.
>
> The entire generation stack runs on NVIDIA accelerated computing, in two layers. The self-hosted layer is a fleet of NVIDIA L4 GPU workers on Google Cloud Run running PyTorch with custom-compiled CUDA extensions and NVIDIA Kaolin: Hunyuan3D 2.1 and Microsoft TRELLIS for image-to-3D, TripoSG for sketch-to-3D, TripoSR for fast drafts, Make-It-Animatable for auto-rigging, and Motion Diffusion Model for text-to-animation. The Blackwell-generation RTX PRO 6000 path is validated with sm_120 kernel builds. The hosted layer is one NVIDIA API key wide: TRELLIS text-to-3D on NVCF, Nemotron LLMs for agent brains, NV-EmbedQA embeddings and Mistral reranking for agent memory, NemoGuard content safety on every public publish, Riva Magpie multilingual TTS and Riva ASR for voice, and Audio2Face-3D driving real-time facial animation in the browser.
>
> Around the bodies sits a full agent economy: on-chain identity (ERC-8004 on EVM, Metaplex Core on Solana), x402 pay-per-call so agents can charge for and pay for services autonomously, an MCP server exposing free text-to-3D to any AI assistant, and 60+ open npm SDKs. three.ws is an NVIDIA Inception member; the engineering field notes on running image-to-3D on L4 and Blackwell are published on the three.ws blog and the NVIDIA Developer Forums.

## Categories

Pick the closest available options in the form; the taxonomy varies.

- **Industry:** Media and Entertainment (alt: Gaming, Software/Internet)
- **Use case / workload:** Generative AI, 3D content creation, Digital humans / conversational AI, AI agents
- **App type:** SaaS / web application (browser-native, no install)

## NVIDIA technologies used

Every item below is live in production unless marked otherwise. Do not claim TensorRT, Triton, or self-hosted NIM microservices; the GPU workers are PyTorch + CUDA today (TensorRT-LLM is an Inception roadmap item).

Also do not claim the **video-to-scene world scanner** or the **texture worker**, and do not re-add **FlashInfer** on their behalf. Both have a GPU `cloudbuild.yaml` in the tree but neither is deployed in any region (verified 2026-08-17 and re-verified 2026-09-02 with the recount command below), so they are built code, not a running lane. The long description above used to carry the world-scanner claim in defiance of this rule; it was removed on 2026-09-02, because a submission is exactly where an unbacked claim costs the most. Deploy them and they belong here; until then a curator who checks would find nothing behind the claim.

- **NVIDIA L4 GPUs** (Google Cloud Run GPU) running the entire self-hosted 3D generation fleet: image-to-3D, sketch-to-3D, auto-rigging, text-to-motion. Eight GPU workers, twelve deployments across `us-central1` and `us-east4` (eleven L4, one RTX PRO 6000). Recount before submitting: `gcloud run services list --project aerial-vehicle-466722-p5 --format="csv[no-heading](metadata.name,region,spec.template.spec.nodeSelector)" | grep -i accelerator` Re-counted 2026-09-02: unchanged, and every public link in the [Links for the form](#links-for-the-form) section answered 200 the same day.
- **CUDA** with custom-compiled extensions (nvdiffrast, diffoctreerast, diff-gaussian-rasterization, torchmcubes)
- **NVIDIA Kaolin** (TRELLIS worker)
- **NIM APIs** (integrate.api.nvidia.com): Nemotron Super and Nano LLMs, Nemotron Nano VL vision, NV-EmbedQA-E5-v5 embeddings, Mistral 4B reranking, NemoGuard 8B content safety
- **NVCF**: microsoft/trellis text-to-3D (the free default forge lane) and FLUX.1-schnell text-to-image
- **NVIDIA Riva**: Magpie multilingual TTS and Riva ASR over NVCF gRPC
- **NVIDIA Audio2Face-3D**: audio-driven ARKit blendshape facial animation, live at three.ws/demos/audio2face
- **RTX PRO 6000 Blackwell**: validated (sm_120 builds) for the heavy image-to-3D lane; not the default production GPU

## Links for the form

- Product: https://three.ws
- Live demo, no signup: https://three.ws/forge (text-to-3D) and https://three.ws/ar (one-tap AR)
- Audio2Face demo: https://three.ws/demos/audio2face
- Docs: https://three.ws/docs
- NVIDIA integration map: https://three.ws/docs/nvidia-models
- Engineering blog (L4 + Blackwell): https://three.ws/blog/image-to-3d-on-nvidia-l4-and-blackwell
- NVIDIA Developer Forums post: https://forums.developer.nvidia.com/t/how-nemotron-made-three-ws-text-to-3d-pipeline-usable/376445
- GitHub: https://github.com/nirholas/three.ws
- X: https://x.com/trythreews

## Assets to upload

All in the repo, web-ready:

- Logo mark: `public/brand/three-ws-mark.png` (also `public/three.svg` for vector)
- Lockups: `public/brand/three-ws-lockup-on-dark.png`, `public/brand/three-ws-lockup-on-light.png`
- Social/OG image: `public/og-image.png`
- Full press kit: `public/brand/three-ws-press-kit.zip`
- Screenshots: capture live from https://three.ws/forge (generation in progress plus result), https://three.ws/agora (3D world), and https://three.ws/character-library (rigged character grid) at 1920x1080

## Second product record: the `<agent-3d>` digital-human embed

A genuinely distinct shipping surface with its own NVIDIA story, filed as a separate portal product AFTER the main record is corrected. It targets the Digital Humans / conversational AI workload filter, which the main (Generative AI content creation) entry does not.

**Product name:** three.ws Agent Embed (`<agent-3d>`)

**Stage:** Shipping

**Acceleration:** GPU Accelerated

**Product URL:** https://three.ws/docs/embedding

### Short description (about 130 characters)

> One script tag puts a talking, lip-synced 3D AI agent on any website. Voice by NVIDIA Riva, facial animation by Audio2Face-3D.

### Medium description (about 500 characters)

> The `<agent-3d>` web component embeds a live, conversational 3D avatar on any site with one script tag: no plugins, no framework requirements. The avatar listens (NVIDIA Riva ASR), reasons (Nemotron via NIM APIs), speaks (Riva Magpie multilingual TTS), and moves its face in real time from NVIDIA Audio2Face-3D ARKit blendshape tracks, mapped at runtime onto whatever morph convention the visitor's avatar ships (ARKit-52, VRM vowels, Oculus visemes). Every reply is gated by NemoGuard content safety.

### Technologies Used (this record)

- Riva (ASR + Magpie TTS over NVCF gRPC)
- Audio2Face (A2F-3D blendshape streams driving browser playback)
- NIM APIs (Nemotron brains, NemoGuard safety)
- CUDA Toolkit / cuDNN (the avatar bodies it renders come from the L4 fleet)

Nothing else checked. TensorRT/Triton/Omniverse stay unchecked here too.

### Links (this record)

- Docs: https://three.ws/docs/embedding
- Live A2F demo: https://three.ws/demos/audio2face
- Voice stack source: https://github.com/nirholas/three.ws/tree/main/src/voice

---

## Submission checklist

1. Log in to the Inception portal, go to Profile, then Add product.
2. Paste the core fields above; use the description length the form allows (short, medium, or long).
3. Select categories per the Categories section, adjusting to the form's actual taxonomy.
4. Check every NVIDIA technology the form offers that appears in the list above; check nothing that does not.
5. Upload the logo mark and OG image; add screenshots if the form accepts them.
6. Submit. Listings are reviewed on a rolling basis; note the submission date in this doc when done.
7. Correct the existing record per the Status section (move Riva/Audio2Face/NIM to Used, drop DeepVariant NIM) BEFORE adding anything new.
8. Add the `<agent-3d>` embed as a second product using its section above. Do not file more records than these two: duplicates read as noise to the curator.
9. Send the inclusion-request email in [nvidia-apps-catalog-request.md](./nvidia-apps-catalog-request.md) to inceptionprogram@nvidia.com and record the send date there.
