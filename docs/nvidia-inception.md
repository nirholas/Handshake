# NVIDIA Inception membership

three.ws is a member of the **NVIDIA Inception program**, NVIDIA's global program for startups building on accelerated computing. Membership was accepted in July 2026.

This page explains what that means in practice: what already runs on NVIDIA, what membership adds, and where it shows up in the product.

---

## Why NVIDIA is a natural fit

Every 3D generation lane on three.ws already runs on NVIDIA silicon:

- **Text-to-3D and image-to-3D** (the [/forge](https://three.ws/forge) free lane and the paid lanes) generate on NVIDIA GPUs on Cloud Run.
- **Photo-to-avatar reconstruction, auto-rigging, and motion capture** run on the same GPU fleet.
- **LLM chat, vision, embeddings, speech, and facial animation** run on NVIDIA-hosted models. The full model-by-model map is in [NVIDIA models on three.ws](/docs/nvidia-models).

GPU capacity is the single hardest constraint on how fast and how detailed generation can be, which is exactly the constraint Inception helps relax.

## What membership adds

- **GPU credits and hardware access** — more capacity for avatar generation and open-model inference, on top of the free-first lanes.
- **Technical guidance** — migrating the digital-human stack toward NVIDIA ACE (Audio2Face + Riva) and NIM / TensorRT-LLM.
- **Ecosystem access** — Omniverse/OpenUSD interop, co-marketing, the NVIDIA VC Alliance, and the wider Inception network.

Membership is a startup program, not a partnership or an investment: NVIDIA reviews applicants and admits companies building seriously on accelerated computing.

## Where you'll see it

- The **NVIDIA Inception member badge** in the site footer, linking to [NVIDIA's startup program](https://www.nvidia.com/en-us/startups/).
- The [membership overview deck](/docs/nvidia-inception/index.html): the platform, the numbers, the team, and what we're doing with the program.
- The [changelog](https://three.ws/changelog), where membership was announced on 2026-07-21.

## Related

- [NVIDIA visibility map](./nvidia-visibility-map.md): every NVIDIA surface where three.ws can earn recognition, what each one requires, and which membership benefits are still unclaimed
- [NVIDIA models on three.ws](/docs/nvidia-models) — the free inference layer, model by model
- [The generator was never the hard part](/docs/nvidia-nemotron-spotlight): our Nemotron Nano write-up, published on the NVIDIA Developer Forums
- [Image-to-3D on NVIDIA L4 and Blackwell](https://three.ws/blog/image-to-3d-on-nvidia-l4-and-blackwell): the engineering post on the GPU fleet itself: memory ceilings, `sm_120` kernels, and regional quota
- [How the forge works](/docs/how-forge-works) — the 3D generation pipeline the GPUs power
