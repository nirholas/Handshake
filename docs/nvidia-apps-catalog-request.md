# The NVIDIA Inception email: send-ready packet

Everything needed to send the Accelerated Apps Catalog request in one sitting: the pre-send portal fix, the paste-ready email, the assets, and what to do with each reply.

The Inception portal has no "publish to the catalog" control. A product record makes the company eligible; the public [Accelerated Apps Catalog](https://marketplace.nvidia.com/en-us/enterprise/applications/) is curated and published by NVIDIA. This email is the request that asks for the listing, and it carries four other asks that have never been made. Per [nvidia-visibility-map.md](./nvidia-visibility-map.md), every Tier 1 ask routes to the same inbox, so they are batched here deliberately. **Do not split these into separate emails.** A program manager who receives one clear email with five asks answers it. Five separate emails read as noise.

- **To:** inceptionprogram@nvidia.com
- **Subject:** three.ws (Inception member): catalog listing, Showcase, and co-marketing
- **From:** the address on the Inception portal account
- **Sent:** not yet sent. Record the date here when it goes out.

---

## Step 1: fix the portal record first (about 5 minutes)

Do this before sending. The email's first two asks are judged against the record, and as filed the record reads as a CUDA consumer rather than a digital-human app. Verified 2026-09-04: still uncorrected.

Go to the Inception portal, Products, then Edit on the `three.ws` row.

**Move these from Considering to Technologies Used:**

| Toggle | Evidence it is shipping |
|---|---|
| **Riva** | [api/_lib/asr-nvidia.js](../api/_lib/asr-nvidia.js) (ASR) and [api/_lib/tts-nvidia.js](../api/_lib/tts-nvidia.js) (Magpie TTS), both Riva gRPC over NVCF |
| **Audio2Face** | [api/_lib/a2f-nvidia.js](../api/_lib/a2f-nvidia.js) against `grpc.nvcf.nvidia.com`, browser playback in [src/voice/a2f-player.js](../src/voice/a2f-player.js), live at [/demos/audio2face](https://three.ws/demos/audio2face) |
| **NIM microservices** (if the form offers it as hosted APIs) | `integrate.api.nvidia.com`: Nemotron 3 Super and Nano, Nemotron Nano VL, NV-EmbedQA-E5-v5, NemoGuard 8B |

**Uncheck entirely: DeepVariant NIM.** It is genomics variant calling. It has nothing to do with this product and it weakens category fit with a curator who reads the record.

**Leave under Considering: TensorRT, Triton Inference Server, Omniverse Kit.** The GPU workers are PyTorch plus CUDA today and OpenUSD interop is roadmap. Do not claim them.

**Keep under Used, and add if the form offers them:** CUDA Toolkit, cuDNN, cuBLAS, CUDA Python, NVIDIA Kaolin, nvdiffrast, L4 GPUs, RTX PRO 6000 Blackwell.

Save the record. Then send the email below.

## Step 2: the five asks, and why each one is in this email

| # | Ask | Basis |
|---|---|---|
| 1 | Accelerated Apps Catalog listing | Curated by NVIDIA; no self-serve route exists |
| 2 | Inception Startup Showcase feature | Member benefit: "member spotlights and story opportunities" |
| 3 | Co-marketing kit and official badge | Member benefit: "official badges, co-branded social content, and customizable assets for events" |
| 4 | Redirect to the ACE / digital-human team | No public intake form found for ACE |
| 5 | GTC Startup Pavilion and other event slots | Pavilion placement is negotiated with the program team, not a CFP submission |

Asks 2 and 3 are entitlements listed on NVIDIA's own [program page](https://www.nvidia.com/en-us/startups/), not favors. Ask 3 is the specific unlock for social amplification: NVIDIA's social team can only reshare a post carrying the official badge and `#NVIDIAInception`. Without the kit there is no mechanism for them to amplify anything.

## Step 3: paste this

Plain text, no formatting needed. Every link in it was checked and answered 200 on 2026-09-04.

```
Hello,

three.ws is an NVIDIA Inception member (accepted July 2026). Our product
record is filed in the portal as Shipping / GPU Accelerated. I have five
requests, batched into one email rather than five.


1. ACCELERATED APPS CATALOG

I would like to request consideration for the Accelerated Apps Catalog.

What it is: three.ws is a browser-native platform for generating 3D avatars
and AI agents from a prompt. Text, image, or sketch input becomes a textured,
auto-rigged GLB in seconds, and the resulting agent can talk, lip-sync, and be
embedded on any site with one script tag. Free text-to-3D at
https://three.ws/forge, no signup.

Why it belongs in the catalog: the whole product is NVIDIA accelerated
computing end to end, in two layers.

Self-hosted: eight GPU workers on Google Cloud Run, twelve service deployments
across two regions, eleven on NVIDIA L4 and one on RTX PRO 6000 Blackwell.
They are built on nvidia/cuda 12.1 to 12.8 images with custom-compiled CUDA
extensions (nvdiffrast, diffoctreerast, diff-gaussian-rasterization,
torchmcubes) and NVIDIA Kaolin, and they run Hunyuan3D 2.1 and TRELLIS for
image-to-3D, TripoSG for sketch-to-3D, TripoSR for fast drafts,
Make-It-Animatable for auto-rigging, and Motion Diffusion Model for
text-to-motion. The heavy image-to-3D lane is validated on RTX PRO 6000
Blackwell with sm_120 kernel builds.

NVIDIA-hosted: TRELLIS on NVCF is our default free text-to-3D lane. Nemotron 3
Super and Nano power agent reasoning, Nemotron Nano VL handles vision,
NV-EmbedQA-E5-v5 and Mistral reranking power agent memory, NemoGuard 8B gates
every public publish, Riva Magpie TTS and Riva ASR give agents a voice, and
Audio2Face-3D drives real-time ARKit blendshape facial animation in the
browser (live demo: https://three.ws/demos/audio2face).

Public engineering work on the stack:

- Image-to-3D on NVIDIA L4 and Blackwell (memory ceilings, sm_120 kernels,
  regional GPU quota):
  https://three.ws/blog/image-to-3d-on-nvidia-l4-and-blackwell
- How Nemotron made our text-to-3D pipeline usable, posted to the NVIDIA
  Developer Forums:
  https://forums.developer.nvidia.com/t/how-nemotron-made-three-ws-text-to-3d-pipeline-usable/376445
- How we translate the app into 100 languages with NVIDIA NIM, also on the
  Developer Forums:
  https://forums.developer.nvidia.com/t/how-three-ws-translates-a-web-app-into-100-languages-with-nvidia-nim-an-llm-powered-i18n-pipeline/377379
- Our full NVIDIA integration map, model by model:
  https://three.ws/docs/nvidia-models

Suggested categorization: Industry, Media and Entertainment. Workload,
Generative AI and Digital Humans. Type, SaaS web application.

If anything else is needed for the listing (logo, screenshots, a longer
description, a specific form), tell me the format and I will send it the same
day. Brand assets and a press kit are ready at
https://three.ws/brand/three-ws-press-kit.zip and I can supply 1920x1080
captures of the generation flow on request.


2. INCEPTION STARTUP SHOWCASE

The program page describes member spotlights and story opportunities through
the Inception Startup Showcase. I would like to put three.ws forward for
consideration.

The story we would tell is the one in the engineering posts above: a small team
running a self-hosted NVIDIA GPU fleet plus NVIDIA-hosted models to make 3D
agent generation fast enough and cheap enough to give away for free in a
browser, with no signup. If a written profile, a founder interview, or a
specific template is the format you need, tell me which and I will turn it
around the same week.


3. CO-MARKETING ASSETS

The program page lists official badges, co-branded social content, and
customizable event assets as a member benefit. We have never requested the kit,
and as a result our Inception membership has never been announced on our own
channels, because we would rather announce it correctly the first time.

Please send the current co-marketing kit and the badge usage guidelines. I want
to confirm the correct badge lockup, the required attribution wording, and
which handle to tag for digital-human content before we post anything.


4. A REDIRECT TO THE ACE / DIGITAL-HUMAN TEAM

I could not find a public intake route for the ACE team, so I am asking here
for a redirect.

We are running Audio2Face-3D in a browser tab. The client streams 16 kHz mono
16-bit PCM into the ACE A2FControllerService over NVCF gRPC and renders the
returned ARKit blendshape track against a WebGL avatar, mapping ARKit-52 onto
whatever morph convention the user's own model ships (ARKit, VRM vowels,
Oculus visemes), alongside Riva ASR in and Magpie TTS out. Live and public, no
install and no signup: https://three.ws/demos/audio2face

To be precise about what we are claiming: we consume ACE microservices as
hosted APIs. We do not self-host NIM. Most A2F work we have seen lives in
Unreal or Omniverse, so a browser-native implementation seemed worth putting in
front of the team that owns it, whether that is useful as a reference
integration, a feedback channel, or neither.


5. GTC STARTUP PAVILION AND OTHER EVENTS

I understand the GTC 2026 call for submissions has closed, and that Pavilion
placement is arranged with the program team rather than through the CFP. Two
questions:

- Is there a route to the Inception Startup Pavilion for the next GTC in San
  Jose, and when does that conversation normally start? I would also like to
  know when the call for submissions is expected to open so we do not miss it.
- The program materials mention Inception exposure at Oracle AI World, KubeCon,
  Supercomputing, Microsoft Ignite, AWS re:Invent, and NeurIPS. Which of those
  carry startup slots we would be eligible for, and what are their lead times?

I would rather ask now and plan around the real dates than miss a window by a
month.


Thank you,

Nicholas
three.ws
https://three.ws
```

## Attachments

None are required; every asset is linked in the body and the links are live. Attach only if you prefer the curator not to have to click:

- Logo mark: [public/brand/three-ws-mark.png](../public/brand/three-ws-mark.png)
- Lockups: [three-ws-lockup-on-dark.png](../public/brand/three-ws-lockup-on-dark.png), [three-ws-lockup-on-light.png](../public/brand/three-ws-lockup-on-light.png)
- Press kit (6.3 MB, may trip attachment limits; the link in the body is safer): [public/brand/three-ws-press-kit.zip](../public/brand/three-ws-press-kit.zip)

Screenshots are deliberately not attached. The email offers them on request, which is a cheaper second touch than guessing the spec now. If they ask, capture 1920x1080 from [/forge](https://three.ws/forge) (generation in progress plus result), [/agora](https://three.ws/agora), and [/character-library](https://three.ws/character-library).

## After you send

1. Record the send date in the **Sent** field at the top of this doc.
2. File the second product record, the `<agent-3d>` digital-human embed. Copy is ready in [nvidia-apps-catalog-listing.md](./nvidia-apps-catalog-listing.md) under "Second product record". It targets the Digital Humans workload filter that the main record does not, and it is independent of the reply.
3. Route each reply:

| Reply | Where it goes next |
|---|---|
| Catalog form or asset request | Answer same day. Everything is in [nvidia-apps-catalog-listing.md](./nvidia-apps-catalog-listing.md). |
| Showcase interest | Draft the profile against the engineering posts, not marketing copy. |
| Co-marketing kit arrives | Unblocks the badge post. Copy is drafted in [marketing/nvidia-inception/social-copy.md](../marketing/nvidia-inception/social-copy.md), owner-gated. |
| ACE redirect | The forum post 3 draft, [nvidia-forum-browser-digital-human.md](./nvidia-forum-browser-digital-human.md), is the technical brief to send them. |
| GTC dates | Put them on the watch in [nvidia-visibility-map.md](./nvidia-visibility-map.md) Tier 3 and write the abstracts. |
| No reply in 3 weeks | One follow-up on ask 1 only, and use the "Maximize Your Membership" webinar Q&A to ask 2 and 3 live. |

## Verification log

Checked 2026-09-04 before this packet was finalized:

- Every URL in the email body returned HTTP 200, including both Developer Forums posts, the blog post, the demo, the docs pages, and the press kit.
- The Riva, Audio2Face, and NIM claims were re-read against the code they cite. A2F still targets `nvidia_ace.services.a2f_controller.v1.A2FControllerService` on `grpc.nvcf.nvidia.com:443` at 16 kHz mono, matching the wording in ask 4.
- The text-to-image lane is FLUX.1-dev, not schnell (the hosted schnell preview was retired). FLUX is not claimed in this email, so no change was needed here.
- The GPU fleet count (eight workers, twelve deployments, eleven L4, one RTX PRO 6000) is carried over from the 2026-09-02 live recount. `gcloud` credentials in the dev container had expired, so it was not re-run today. To refresh before sending: `gcloud run services list --project aerial-vehicle-466722-p5 --format="csv[no-heading](metadata.name,spec.template.spec.nodeSelector)" | grep -i accelerator`
