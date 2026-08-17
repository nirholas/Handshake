# The NVIDIA Inception email: five asks, one thread

The Inception portal has no "publish to the catalog" control. A product record makes the company eligible; the public [Accelerated Apps Catalog](https://marketplace.nvidia.com/en-us/enterprise/applications/) is curated and published by NVIDIA. This is the request that asks for the listing, sent after the portal record is corrected per [nvidia-apps-catalog-listing.md](./nvidia-apps-catalog-listing.md).

It also carries four other asks that have never been made. Per [nvidia-visibility-map.md](./nvidia-visibility-map.md), every Tier 1 ask routes to the same inbox, so they are batched here deliberately. **Do not split these into separate emails.** A program manager who receives one clear email with five asks answers it. Five separate emails read as noise.

- **To:** inceptionprogram@nvidia.com
- **Subject:** three.ws (Inception member): catalog listing, Showcase, and co-marketing
- **Sent:** not yet sent. Record the date here when it goes out.
- **Blocked on:** the portal record correction, [nvidia-apps-catalog-listing.md](./nvidia-apps-catalog-listing.md) step 1. As filed the record reads as a CUDA consumer rather than a digital-human app, which undercuts asks 1 and 2. Correct it, save it, then send.

### The five asks, and why each one is here

| # | Ask | Basis |
|---|---|---|
| 1 | Accelerated Apps Catalog listing | Curated by NVIDIA; no self-serve route exists |
| 2 | Inception Startup Showcase feature | Member benefit: "member spotlights and story opportunities" |
| 3 | Co-marketing kit and official badge | Member benefit: "official badges, co-branded social content, and customizable assets for events" |
| 4 | Redirect to the ACE / digital-human team | No public intake form found for ACE |
| 5 | GTC Startup Pavilion and other event slots | Pavilion placement is negotiated with the program team, not a CFP submission |

Asks 2 and 3 are entitlements listed on NVIDIA's own [program page](https://www.nvidia.com/en-us/startups/), not favors. Ask 3 is the specific unlock for social amplification: NVIDIA's social team can only reshare a post carrying the official badge and `#NVIDIAInception`. Without the kit there is no mechanism for them to amplify anything.

---

Hello,

three.ws is an NVIDIA Inception member (accepted July 2026). Our product record is filed in the portal as Shipping / GPU Accelerated. I have five requests, batched into one email rather than five.

## 1. Accelerated Apps Catalog

I would like to request consideration for the Accelerated Apps Catalog.

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

## 2. Inception Startup Showcase

The program page describes member spotlights and story opportunities through the Inception Startup Showcase. I would like to put three.ws forward for consideration.

The story we would tell is the one in the engineering posts above: a small team running a self-hosted NVIDIA GPU fleet plus NVIDIA-hosted models to make 3D agent generation fast enough and cheap enough to give away for free in a browser, with no signup. If a written profile, a founder interview, or a specific template is the format you need, tell me which and I will turn it around the same week.

## 3. Co-marketing assets

The program page lists official badges, co-branded social content, and customizable event assets as a member benefit. We have never requested the kit, and as a result our Inception membership has never been announced on our own channels, because we would rather announce it correctly the first time.

Please send the current co-marketing kit and the badge usage guidelines. I want to confirm the correct badge lockup, the required attribution wording, and which handle to tag for digital-human content before we post anything.

## 4. A redirect to the ACE / digital-human team

I could not find a public intake route for the ACE team, so I am asking here for a redirect.

We are running Audio2Face-3D in a browser tab. The client streams 16 kHz mono PCM into the ACE `A2FControllerService` over NVCF gRPC and renders the returned ARKit blendshape track against a WebGL avatar, mapping ARKit-52 onto whatever morph convention the user's own model ships, alongside Riva ASR in and Magpie TTS out. Live and public, no install and no signup: https://three.ws/demos/audio2face

To be precise about what we are claiming: we consume ACE microservices as hosted APIs. We do not self-host NIM. Most A2F work we have seen lives in Unreal or Omniverse, so a browser-native implementation seemed worth putting in front of the team that owns it, whether that is useful as a reference integration, a feedback channel, or neither.

## 5. GTC Startup Pavilion and other events

I understand the GTC 2026 call for submissions has closed and that Pavilion placement is arranged with the program team rather than through the CFP. Two questions:

- Is there a route to the Inception Startup Pavilion for the next GTC, and when does that conversation normally start?
- The program materials mention Inception exposure at Oracle AI World, KubeCon, Supercomputing, Microsoft Ignite, AWS re:Invent, and NeurIPS. Which of those carry startup slots we would be eligible for, and what are their lead times?

I would rather ask now and plan around the real dates than miss a window by a month.

Thank you,

Nicholas
three.ws
https://three.ws
