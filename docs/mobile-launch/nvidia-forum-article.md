---
venue: NVIDIA Developer Forums (community showcase)
account: three.ws (official)
suggested_title: "Three phones, one GPU fleet: shipping generative 3D to the Solana Seeker, Android, and iPhone on L4s, Blackwell, and NIM"
description: "What putting three.ws in a store app taught us about serving text-to-3D, selfie-to-avatar, rigging, and motion from NVIDIA GPUs to a phone: the lanes, the memory ceilings, the models that stand around the generator, and why the phone changed the shape of the problem."
tags: [nim, trellis, nemotron, generative-3d, cloud-run, mobile, inception]
canonical: https://three.ws/docs/mobile-launch/nvidia-forum-article.md
status: draft, owner approval required before posting (external-channel gate in CLAUDE.md)
---

# Three phones, one GPU fleet

I run [three.ws](https://three.ws). You type a sentence or take a selfie, and a rigged, textured 3D character stands in your browser a minute later, ready to walk, talk, and be placed in your room in AR. Every generation lane runs on NVIDIA silicon: our own Cloud Run fleet of L4s and one RTX PRO 6000 Blackwell, plus the hosted NIM catalog for the free lanes and the models that do judgment work around the generator. three.ws is a member of NVIDIA Inception, and I wrote here before about how a 12B vision model in front of the generator mattered more than the generator itself.

This post is about what happened next. three.ws is now three native apps: one on the Solana dApp Store for the Seeker phone, one on Google Play, and one on the App Store. Putting a GPU-backed generative product into a store app on a phone changed the shape of the problem in ways I did not predict, and most of them are about the GPU. I want to walk through the fleet as it is today, the lanes, the ceilings, the models around the generator, and the specific things a phone forced us to get right. Real numbers throughout, and every claim is checkable in the [open-source repository](https://github.com/nirholas/three.ws).

## Why a phone, and why that is a GPU question

A desktop browser renders three.ws perfectly well. But every input to a three.ws agent lives on a phone: the camera that takes the selfie, the photo roll, the share sheet, the AR camera, the GPS that lets an agent be pinned to a park bench, and the wallet. The product wanted to be on a phone from the first commit.

The trouble is that a phone user is the least patient user you have and the phone camera produces the worst input you will ever see. On desktop, a text-to-3D request came from someone who typed a considered prompt. On a phone, it comes from someone standing in a kitchen holding a backlit selfie at arm's length, and if the mesh is noise they do not know the input was unreconstructable; they know the app is broken. Every bad input that reaches the GPU burns a slot, a cold start, and the full generation time, and returns nothing. On a phone, that is the whole retention curve.

So the phone made two things non-negotiable: the judgment has to happen before the GPU, ideally on the device; and the lane has to be fast enough that a person holding a phone will wait for it.

## The fleet as it stands

Every 3D worker is a Cloud Run service with an NVIDIA GPU, scaling to zero when idle, which is most of why a free tier is economically sustainable. What runs where:

**Text-to-3D and image-to-3D.**
- Microsoft TRELLIS on the hosted NIM lane. This is the free draft tier. It finishes a text-to-3D generation inline in about 12 to 13 seconds at 15 sampling steps, with none of the roughly 60-second cold start our self-hosted lanes pay. It is text-only; the hosted preview rejects user images.
- TRELLIS-image-large, self-hosted on an L4, for the image path and the standard tier.
- Tencent Hunyuan3D 2.1, `hy3dshape` plus `hy3dpaint`, the named engine of the high tier because it produces PBR materials. More on where it actually runs below.
- TripoSR on an L4 as the fast fallback, roughly 5 to 15 seconds.
- TripoSG and TripoSG-scribble, a 1.5B rectified-flow transformer, for the sketch path, with RMBG-1.4 in front for background removal.

**Rigging.** Make-It-Animatable on an L4: a 52-bone Mixamo-compatible skeleton, skin weights, and ARKit-52 blendshapes from the ICT-FaceKit set. Any generated humanoid goes through it, so every character that comes out of the pipeline can walk, emote, and lip-sync.

**Photo-to-avatar.** The reconstruction worker carries two paths: a template-fit pipeline that runs MediaPipe FaceLandmarker's 468 landmarks to transfer a face's texture and geometry onto a fixed-topology, pre-rigged humanoid (the production lane, about a minute), and a multi-view path built on InstantMesh with Zero123++ synthesising six views from one to six photos.

**Motion.** A text-to-motion worker on the Motion Diffusion Model with the HumanML3D checkpoint, a video-to-motion worker, and a video-to-scene worker that turns a phone video into a point cloud.

**CPU workers around them.** Background removal (BRIA RMBG-2.0), stylisation (voxel, brick, voronoi, low-poly, all pure geometry), segmentation, and a remesh worker with QuadriFlow and xatlas that also handles the GLB, OBJ, FBX, STL, PLY, USDZ, and 3MF conversions a phone's AR viewer needs.

All of it sits behind one tier table: draft at 12,000 polygons with no textures, standard at 30,000 with 2K textures, high at 200,000 with PBR and HD. The tier picks a named free default per path, then walks a per-path free fallback chain, and only then reaches for a paid lane.

## The L4 memory ceiling, and where Blackwell earns its keep

The single hardest constraint in the fleet is not compute, it is the 32 GiB ceiling on a Cloud Run L4 instance and the regional quota bucket every L4 service draws from.

Hunyuan3D 2.1 is the clearest example. Its weight staging needs about 18 GiB of tmpfs on top of a 14 GiB model, and that combination OOMs the L4 ceiling with a signal 9 mid-load. The L4 build of the 2.1 worker is known-broken for real jobs and stays at zero instances. The lane that actually serves the high tier is a separate service on the RTX PRO 6000 Blackwell, which has the memory to hold both halves of the model resident. That one service is the reason the high tier exists.

Two operational facts about that Blackwell lane are worth knowing if you are planning a fleet:

1. The RTX PRO 6000 quota is enforced at one instance regardless of the granted preference value. Asking for more instances fails with `requested: 4 allowed: 1`. We treat the preference number as aspirational.
2. The accelerator type lives in the service's node selector, not in the template annotations. Reading the wrong place silently defaulted every service to L4 in our capacity tooling and charged the Blackwell service to the L4 pool, which made a region read as fully pinned when it had a spare L4. That mistake is now pinned by a test.

The L4 grant itself went from 6 to 22 instances across regions in July, and the blocker on the raise turned out to be a CLI flag rather than a policy. Two other regions were granted 8 each instantly.

And one lesson we learned twice, in two regions: warm pins are per region, and an idle standby in a region starves the lane that region actually serves. We pinned Hunyuan3D warm on an L4 in a region whose only production-routed lane was text-to-motion, and that lane logged 13 allocation denials in a week, most of them from the ten-minute keep-warm probe, while the standby sat idle with zero jobs in three days. Before pinning any GPU service warm, check which environment variable routes production traffic to that region.

## Failover is the product, not a feature

A phone user who waits sixty seconds for a cold start and then gets an error does not come back. So every lane has a health-gated failover chain, and the chain is shared across instances.

- `resolveBackendIdWithHealth()` walks the ordered lane list and skips any lane confirmed down.
- Per-lane circuit breakers put a lane on a 90-second cooldown after a failure; NIM lanes get 120 seconds per model and 30 seconds for the gateway.
- Poll-time failover re-dispatches a lane that dies mid-job under the same job id, so the phone keeps polling the same handle and never sees the swap.
- A subject-aware reorder at the high tier hoists the self-hosted TRELLIS lane for hard-surface prompts and keeps Hunyuan3D first for organic ones, because they are genuinely better at different things.
- The job id lives in the phone's local storage and is resumable for thirty minutes, so backgrounding the app, which Android does freely, does not lose the generation.

## The models standing around the generator

The 3D model is a single API call. What made text-to-3D usable was a set of small NVIDIA models doing judgment work, all unlocked by one `nvapi-` key on the hosted catalog:

- **Nemotron Nano 12B v2 VL** looks at the input before any GPU minute is spent: is there a subject, is it reconstructable, is this a bar chart. On the phone this matters more than anywhere, because the phone camera is where the bar charts and the six-object living rooms come from.
- **Nemotron 3 Super 120B-a12b** is the default LLM lane behind agent chat, with Nemotron 3 Nano 30B-a3b as the compact rung, and a garden of Llama-3.3-Nemotron 49B, Nemotron Nano 9B, Llama 4 Maverick, DeepSeek V4 Pro, Kimi K2.6, and MiniMax M2.7 selectable per agent.
- **FLUX.1-dev** paints a prompt into a reference view for the image path.
- **nv-embedqa-e5-v5** produces the 1024-dimensional embeddings behind agent memory and semantic search; **rerank-qa-mistral-4b** reranks, opt-in and fail-open.
- **Llama 3.1 NemoGuard 8B content safety** screens everything the official account publishes outbound, alongside Llama Guard 4. It is scoped to outbound publishing only, is not a jailbreak detector, and is fail-open, and the docs say so plainly.
- **Magpie TTS multilingual** over Riva gRPC gives agents eleven voice personas in nine languages, and Riva ASR handles the microphone.

The mobile app did not change which models we use. It changed how much of the judgment had to move onto the device.

## What the phone does before it touches a GPU

The selfie scanner runs a live 468-point face mesh in the browser, on the phone, using `@mediapipe/tasks-vision` served from our own bundle, before any upload. The shutter does not unlock until a face is found, and the hint line names the single most actionable fix: face the camera straight on, hold steady, too dark, too bright. Every threshold traces in a header comment to a real reconstruction failure mode: the worker's no-face rejection, the 35-degree morph-yaw ceiling, provider blur failures, the dim and backlit band from the robustness benchmark.

Two of those numbers were measured rather than reasoned about. The blur floor was calibrated against six real portraits framed as 720x1280 phone selfies and scored through the module's own math, sharp versus the worker's exact degradation kernels: sharp faces read 22.8 to 39.4, a Gaussian blur at radius `longestEdge/220` reads 10.6 to 15.7, and a radius-10 smear reads 6.3 to 9.4. The floor sits at 12, in the empty band between the populations. And because a blown-out face raises Laplacian response instead of lowering it, neither the blur gate nor the mean-luma gate can see window glare, so the face crop also reports the fraction of pixels pinned to near-white and gates that separately.

The effect on the fleet is direct: a rejected selfie never reaches an L4. On a phone, where the inputs are worst, that gate is worth more than another GPU.

The output side got the same treatment. The draft tier's 12,000-polygon cap and Meshopt compression exist so a GLB loads on a phone in the time a page takes to paint. iOS Quick Look has a practical ceiling around 15 MB and Scene Viewer around 20 MB, so the remesh worker produces a USDZ with the idle animation baked in for Apple's sealed viewer, and the high tier's 200,000-polygon PBR output goes to the desktop, Unity, and Unreal exports where it belongs.

## The apps themselves

All three are shells around the live product, because a WebGL product with 733 same-origin API call sites cannot sensibly be forked into a second codebase. On Android the app is a Trusted Web Activity; on iOS it is a Capacitor container; on desktop it is the installed PWA. The native layer is everything the web cannot do.

On the Seeker, every signature routes to the phone's hardware-isolated Seed Vault through Mobile Wallet Adapter; the private key never enters the app process. The app reads the Seeker Genesis Token, a soulbound Token-2022 asset, to badge verified Seeker owners, and the check fails closed on any RPC error. On every Android phone the share sheet drops a photo straight into the selfie scanner, and a home screen widget shows your agent's day, refreshed by WorkManager about every thirty minutes from a server-rendered PNG, because no widget host on any platform can run WebGL. On iPhone, universal links, the system share sheet, wallet redirects over a custom scheme, haptics, and real camera and motion prompts wrap the same product.

The GPU fleet does not know or care which of the three it is serving. That is the point of the architecture.

## Why 3D, why AR, why on-chain

Three short answers, because a forum post about GPUs should still say what the GPUs are for.

3D because humans experience presence through faces and posture, not text, and a rigged character with fifty-two blendshapes that looks at you carries more social information than any chat bubble. AR because a character standing on your floor casting a shadow is a presence, and a character on a screen is a picture; WebXR is the mode where the agent stays alive, with microphone, chat, and gaze tracking the camera, and it is a phone-only capability. On-chain because an agent that lives in one vendor's dashboard cannot be verified at a distance, cannot outlive the vendor, and cannot pay for its own inference; a public ledger gives it an identity, an owner, a wallet, and a signed history, and HTTP 402 gives it a way to pay per call in stablecoin with no human in the loop. The GPU fleet is a paid x402 endpoint too: rigging is $0.05 a call, and any agent with a wallet can buy a stage of the pipeline without an account.

## The platform in numbers

From the first commit in April to the end of August: 761 public pages, more than 2,700 changelog entries at roughly twenty shipped changes a day, 101 npm packages, 72 MCP servers in the official registry, 33 workers, 1,752 test files, more than 3,000 motion-capture clips and 106 rigged characters in the library, and a machine-payment rail that has settled over 110,000 calls on-chain. All Apache-2.0.

## What Inception adds, and what we are building next

Membership in NVIDIA Inception is a startup programme, not a partnership or an endorsement, and I say so every time. What it adds is exactly the constraint above: GPU capacity, which is the single hardest limit on how fast and how detailed generation can be, plus the technical guidance we are using for the next stage.

That stage, in order:

- **NVIDIA ACE.** Audio2Face-3D for facial animation driven by the agent's own speech, and Riva for the full speech loop, replacing the browser-side lip-sync with a GPU-side one.
- **Self-hosted NIM and TensorRT-LLM.** The hosted lane is free and rate-limited with no SLA, which is why every consumer keeps a fallback behind it. Bringing the Nemotron lane onto our own fleet is how the free-first design scales past the free tier.
- **Omniverse and OpenUSD.** Every character already exports to USDZ for Quick Look; a real OpenUSD interop path makes the library useful outside the browser.
- **iOS and macOS widgets, push, and the likeness track.** The selfie engine is wired end to end; fidelity is the open research problem, and it is the one that matters most.

If you are serving generative 3D to phones, the two things I would tell you first: put the judgment in front of the GPU, on the device if you can; and treat regional warm pins as a resource you are taking from the lane that region actually serves. Everything else is in the repo.

[github.com/nirholas/three.ws](https://github.com/nirholas/three.ws)

#NVIDIAInception
