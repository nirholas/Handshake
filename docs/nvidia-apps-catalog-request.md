# Catalog inclusion request: email to NVIDIA Inception

The Inception portal has no "publish to the catalog" control. A product record makes the company eligible; the public [Accelerated Apps Catalog](https://marketplace.nvidia.com/en-us/enterprise/applications/) is curated and published by NVIDIA. This is the request that asks for the listing, sent after the portal record is corrected per [nvidia-apps-catalog-listing.md](./nvidia-apps-catalog-listing.md).

- **To:** inceptionprogram@nvidia.com
- **Subject:** three.ws (Inception member): request for Accelerated Apps Catalog listing
- **Sent:** not yet sent. Record the date here when it goes out.

---

Hello,

three.ws is an NVIDIA Inception member (accepted July 2026). Our product record is filed in the portal as Shipping / GPU Accelerated, and I would like to request consideration for the Accelerated Apps Catalog.

**What it is:** three.ws is a browser-native platform for generating 3D avatars and AI agents from a prompt. Text, image, or sketch input becomes a textured, auto-rigged GLB in seconds, and the resulting agent can talk, lip-sync, and be embedded on any site with one script tag. Free text-to-3D at https://three.ws/forge, no signup.

**Why it belongs in the catalog:** the whole product is NVIDIA accelerated computing end to end, in two layers.

Self-hosted: eight GPU workers on Google Cloud Run, twelve service deployments across two regions, eleven on NVIDIA L4 and one on RTX PRO 6000 Blackwell. They are built on `nvidia/cuda` 12.1 to 12.8 images with custom-compiled CUDA extensions (nvdiffrast, diffoctreerast, diff-gaussian-rasterization, torchmcubes) and NVIDIA Kaolin, and they run Hunyuan3D 2.1 and TRELLIS for image-to-3D, TripoSG for sketch-to-3D, TripoSR for fast drafts, Make-It-Animatable for auto-rigging, and Motion Diffusion Model for text-to-motion. The heavy image-to-3D lane is validated on RTX PRO 6000 Blackwell with `sm_120` kernel builds.

NVIDIA-hosted: Nemotron Super and Nano power agent reasoning, Nemotron Nano VL handles vision, NV-EmbedQA-E5-v5 and Mistral reranking power agent memory, NemoGuard 8B gates every public publish, Riva Magpie TTS and Riva ASR give agents a voice, and Audio2Face-3D drives real-time ARKit blendshape facial animation in the browser (live demo: https://three.ws/demos/audio2face).

**Public engineering work on the stack:**

- Image-to-3D on NVIDIA L4 and Blackwell (memory ceilings, `sm_120` kernels, regional GPU quota): https://three.ws/blog/image-to-3d-on-nvidia-l4-and-blackwell
- How Nemotron made our text-to-3D pipeline usable, posted to the NVIDIA Developer Forums: https://forums.developer.nvidia.com/t/how-nemotron-made-three-ws-text-to-3d-pipeline-usable/376445
- Our full NVIDIA integration map, model by model: https://three.ws/docs/nvidia-models

Suggested categorization: Industry, Media and Entertainment. Workload, Generative AI and Digital Humans. Type, SaaS web application.

If anything else is needed for the listing (logo, screenshots, a longer description, a specific form), tell me the format and I will send it the same day. Press kit and brand assets are ready at https://three.ws and I can supply 1920x1080 captures of the generation flow on request.

Thank you,

Nicholas
three.ws
https://three.ws
