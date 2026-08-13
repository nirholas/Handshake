# NVIDIA Accelerated Apps Catalog: three.ws listing kit

Everything needed to submit three.ws to the NVIDIA Inception Accelerated Apps Catalog. The form lives behind the Inception portal login (Portal > Profile > Add product), so this doc holds the copy, categories, links, and assets ready to paste. Submissions are reviewed by NVIDIA on a rolling basis; approval is subject to fit.

Related docs: [nvidia-inception.md](./nvidia-inception.md) (membership overview), [nvidia-models.md](./nvidia-models.md) (full model map, the source of truth for every NVIDIA claim below).

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
> The entire generation stack runs on NVIDIA accelerated computing, in two layers. The self-hosted layer is a fleet of NVIDIA L4 GPU workers on Google Cloud Run running PyTorch with custom-compiled CUDA extensions and NVIDIA Kaolin: Hunyuan3D 2.1 and Microsoft TRELLIS for image-to-3D, TripoSG for sketch-to-3D, TripoSR for fast drafts, Make-It-Animatable for auto-rigging, Motion Diffusion Model for text-to-animation, and a video-to-point-cloud world scanner accelerated with FlashInfer. The Blackwell-generation RTX PRO 6000 path is validated with sm_120 kernel builds. The hosted layer is one NVIDIA API key wide: TRELLIS text-to-3D on NVCF, Nemotron LLMs for agent brains, NV-EmbedQA embeddings and Mistral reranking for agent memory, NemoGuard content safety on every public publish, Riva Magpie multilingual TTS and Riva ASR for voice, and Audio2Face-3D driving real-time facial animation in the browser.
>
> Around the bodies sits a full agent economy: on-chain identity (ERC-8004 on EVM, Metaplex Core on Solana), x402 pay-per-call so agents can charge for and pay for services autonomously, an MCP server exposing free text-to-3D to any AI assistant, and 60+ open npm SDKs. three.ws is an NVIDIA Inception member; the engineering field notes on running image-to-3D on L4 and Blackwell are published on the three.ws blog and the NVIDIA Developer Forums.

## Categories

Pick the closest available options in the form; the taxonomy varies.

- **Industry:** Media and Entertainment (alt: Gaming, Software/Internet)
- **Use case / workload:** Generative AI, 3D content creation, Digital humans / conversational AI, AI agents
- **App type:** SaaS / web application (browser-native, no install)

## NVIDIA technologies used

Every item below is live in production unless marked otherwise. Do not claim TensorRT, Triton, or self-hosted NIM microservices; the GPU workers are PyTorch + CUDA today (TensorRT-LLM is an Inception roadmap item).

- **NVIDIA L4 GPUs** (Google Cloud Run GPU) running the entire self-hosted 3D generation fleet: image-to-3D, sketch-to-3D, auto-rigging, text-to-motion, video-to-scene
- **CUDA** with custom-compiled extensions (nvdiffrast, diffoctreerast, diff-gaussian-rasterization, torchmcubes)
- **NVIDIA Kaolin** (TRELLIS worker)
- **FlashInfer** paged-KV-cache attention (video-to-scene worker)
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

## Submission checklist

1. Log in to the Inception portal, go to Profile, then Add product.
2. Paste the core fields above; use the description length the form allows (short, medium, or long).
3. Select categories per the Categories section, adjusting to the form's actual taxonomy.
4. Check every NVIDIA technology the form offers that appears in the list above; check nothing that does not.
5. Upload the logo mark and OG image; add screenshots if the form accepts them.
6. Submit. Listings are reviewed on a rolling basis; note the submission date in this doc when done.
