---
title: "The generator was never the hard part: how Nemotron Nano made our text-to-3D pipeline usable"
venue: NVIDIA Developer Blog / NVIDIA Developer Forums (community showcase)
published: https://forums.developer.nvidia.com/t/how-nemotron-made-three-ws-text-to-3d-pipeline-usable/376445
account: three.ws (official)
description: "A founder's account of building browser-native 3D generation on NVIDIA NIM, and why a 12B vision model standing in front of the 3D generator mattered more than the 3D generator itself."
tags: [nemotron, nim, trellis, generative-3d, vision-language-models, guardrails]
canonical: https://three.ws/docs/nvidia-nemotron-spotlight.md
---

# The generator was never the hard part

I run [three.ws](https://three.ws). You type a sentence, and a few seconds later a textured, rigged 3D character is standing in your browser, ready to walk and talk. No games team. No Blender. No install.

For about a month, I believed the hard part of that sentence was the 3D model.

It isn't. It never was. The 3D model is a single API call. What made text-to-3D go from a demo that impresses engineers to a product that ordinary people use every day was a fleet of small NVIDIA models standing *around* the generator, doing judgment work. The protagonist of that story is **Nemotron Nano**.

This is what we learned, with the real numbers.

---

## The naive pipeline, and the night it fell apart

The first version of our forge pipeline was exactly what you would draw on a whiteboard:

```
prompt or photo  →  3D generator  →  GLB  →  render in browser
```

The generator is Microsoft TRELLIS, running on NVIDIA NIM. It is genuinely excellent, and NVIDIA hosts it free. Our draft tier finishes a text-to-3D generation inline in about **12-13 seconds** at 15 sampling steps, with none of the ~60-second cold start we were eating on other hosted lanes. When I first watched a GLB materialize out of a sentence, I thought we were basically done.

Then we opened it to real users, and the whiteboard drawing met the world.

Somebody uploaded a screenshot of a Discord conversation and asked for a 3D model of it. Somebody uploaded a photo of their living room: six objects, no subject. Somebody uploaded a picture so dark you could not tell it was a cat. Somebody uploaded a bar chart.

Every one of those consumed a rate-limited slot, occupied a GPU, took the full generation time, and handed the user a mesh of formless noise. The user does not know that their input was unreconstructable. They know that our product is broken. And they leave.

The generator did nothing wrong. It generated, faithfully, from garbage. **The pipeline had no judgment in it.**

---

## The fix was a smaller model, in front

The instinct is to reach for a bigger generator. The correct move was to reach for a smaller model and put it *earlier*.

Before we submit a photo for reconstruction, we now ask a vision-language model exactly one question. Here is the real prompt from [`api/_lib/forge-image-validate.js`](../api/_lib/forge-image-validate.js), unedited:

```
You are the input checker for a photo→3D model generator. The user uploaded this
image as the reference to reconstruct into a 3D object. Judge ONLY whether it is a
usable reference: it should show ONE clear physical subject (an object, character,
creature, or person) that could plausibly be turned into a 3D model.

Reply ONLY with compact JSON, no prose, in exactly this shape:
{"usable":true|false,"subject":"<2-5 word description>","issue":"none"|"text_screenshot"
|"multiple_subjects"|"no_clear_subject"|"too_dark_or_blurry"|"abstract_or_diagram"}

When in doubt, mark usable=true. A borderline photo still reconstructs.
```

The model answering that question is **`nvidia/nemotron-nano-12b-v2-vl`**. It returns in **1-2 seconds**. It costs us nothing. And it turned "your 3D model is garbage" into this:

> That looks like a screenshot of text or an interface, not a photo of an object. Upload a clear picture of the single thing you want to turn into a 3D model.

That is the entire difference between a demo and a product. Not a better mesh. A model small enough, and fast enough, and cheap enough to stand in front of the expensive thing and say *not this one*.

### Why Nemotron Nano specifically

We benchmarked the obvious candidates and picked on a metric nobody puts on a leaderboard: **image token footprint**.

For a small reference image, `nemotron-nano-12b-v2-vl` consumes roughly **281 prompt tokens**. A Llama-90B-vision class model consumed roughly **1,600** for the identical image. That is a ~5.7× difference in the tokens we push through a check that runs in front of *every single generation on the platform*. At our volume, that ratio decides whether the guardrail is free or whether the guardrail becomes the largest line item in the pipeline it was built to protect.

Nemotron Nano won on the axis that actually mattered. The 12B VL model is not competing with a frontier model on essay quality. It is being asked whether there is one clear object in a photograph, and that is a question it answers reliably, in 1-2 seconds, for nothing.

Our vision chain, in order:

```js
const NVIDIA_VISION_MODELS = [
  'nvidia/nemotron-nano-12b-v2-vl',      // leads: smallest image token footprint
  'meta/llama-3.2-11b-vision-instruct',  // different family = independent failure modes
];
// paid vision-capable backstop appended last, and only if its key is set
```

Note the comment on line two, because it is the load-bearing design decision in this file. The second lane is a **different model family**, not a bigger checkpoint of the first. A retry against the same family is a re-roll, not a fallback. If Nemotron Nano's failure mode is triggered by an input, Nemotron Super's probably is too. Llama 3.2 Vision fails differently. That is the whole point of having it.

### Nemotron's siblings do the rest of the judgment

Once we understood the pattern, we found the same shape everywhere in the product.

**Content safety.** Anonymous visitors can talk to any agent on the platform. We refuse unsafe messages ourselves rather than inheriting a downstream provider's moderation policy, using NVIDIA's `nvidia/llama-3.1-nemoguard-8b-content-safety` from the NeMo Guardrails family. Measured median latency on the free NIM tier: **~340 ms**, with a ~680 ms tail. We give it a 2-second abort budget, which is roughly six times its median. That's generous, and still fast to fail over.

**Reasoning turns.** When a feature wants a compact, reasoning-tuned model to actually lead rather than sit at the tail of a fallback chain, it opts into `nvidia/nvidia-nemotron-nano-9b-v2`. Prompt refinement, classification, structured extraction. A 9B model does these perfectly, and reaching for a frontier model to do them is a tax you pay on every request forever.

**Retrieval.** Agent memory embeds through `nvidia/nv-embedqa-e5-v5` at 1024 dimensions, with `nvidia/rerank-qa-mistral-4b` as an optional cross-encoder rerank stage.

Every one of those models, one `nvapi-` key, and a bill of zero. I want to be unambiguous about what that meant for us: **we could not have built this product on paid inference.** Not at the price of a guardrail in front of every generation. The economics only close because NVIDIA hosts these models free, and so the guardrail costs nothing to run.

---

## What I would tell you to do

We got here by getting it wrong first. Six things I would hand to anyone building a generative pipeline, whether it outputs meshes, images, video, or audio.

**1. Put the small model in front of the expensive one, not after.** Every team's instinct is to validate the output. Validating the *input* is cheaper, faster, and gives the user something they can act on before they have waited 30 seconds. A 1-second check that saves a 20-second GPU job pays for itself 20× and pays for itself again in trust.

**2. Fail open. Always. Without exception.** Our validator's contract is written at the top of the file in capital letters: if vision is unconfigured, times out, errors, or returns unparseable junk, it returns `{ ok: true }` and generation proceeds exactly as it did before the check existed. A guardrail that can take your product down is worse than no guardrail. It converts a vendor's bad afternoon into your outage. The only outcome that blocks a user is a successful, parsed, confident rejection.

**3. Choose models by the cost axis that binds you, not by the leaderboard.** Ours was image tokens per call. Yours might be time-to-first-token, or context window, or cold-start. Whatever it is, measure it on *your* payload. `nemotron-nano-12b-v2-vl` does not top a vision leaderboard. It tops the leaderboard that determines whether our product is viable, which is the only one I can pay salaries with.

**4. Make your second lane a different family.** Same-family fallback is superstition. Two independent architectures give you two independent failure modes, and that is what a fallback is for.

**5. Constrain the output, and constrain it hard.** `temperature: 0`, `max_tokens: 120`, compact JSON, and an explicit schema in the prompt. Then write a lenient parser anyway and treat anything you cannot read as *safe* rather than *failed*. A small model asked for a small, rigidly-shaped answer is astonishingly reliable. A small model asked for prose is not.

**6. Return the fix, never the error.** Every rejection reason in our validator maps to designed, actionable copy that tells the user what is wrong *and how to correct it*. `too_dark_or_blurry` becomes "Retake it in good light, hold steady, and keep the subject in focus." The VLM's job is not to say no. It is to tell the user how to get to yes.

### And three things I would ask of NVIDIA

Offered in the spirit of a team that has bet its pipeline on these lanes and wants them to win.

**Lift the image-input restriction on the hosted TRELLIS preview.** The hosted endpoint currently accepts only NVIDIA's predefined `example_id` sample images for `mode:"image"`. We verified this exhaustively against the live endpoint: inline base64 at every size, NVCF asset references with `NVCF-INPUT-ASSET-REFERENCES`, and bare asset ids all return 422. Self-deployed TRELLIS NIMs accept real image input, so this is a property of the hosted preview and not the model. It is the single biggest gap between the free lane and the self-hosted one, and it forces every photo-to-3D submission on our platform off NVIDIA infrastructure and onto a paid third party. We have kept the asset-handshake recipe ready for the day it lifts.

**Raise or document the 77-character TRELLIS prompt cap.** TRELLIS truncates the text prompt server-side at 77 characters. We clamp to it so the request is honest about what is actually conditioning the generation, and we spend 17 of those precious characters appending `", studio lighting"` because TRELLIS trends dark and gritty without an explicit lighting cue. Seventy-seven characters is a tight budget for a user's creative intent.

**Ship constrained/structured decoding on the NIM chat models.** Half of what we do with Nemotron Nano is coax rigidly-shaped JSON out of it. A guaranteed-schema decoding mode would let us delete our lenient parser and our fail-open bad-reply branch, and would make small models dramatically more attractive for exactly the pipeline-judgment role this entire article is about.

---

## Why any of this matters

I want to step back from the token counts.

For the whole history of the medium, 3D has been gated behind craft. Not taste, not ideas. Craft. Years of it. Topology and UV unwrapping and weight painting and retopology, an apprenticeship most people with something to say were never going to serve. The ideas were never the bottleneck. The tooling was. An enormous number of people who would have made extraordinary things in three dimensions simply never got past the first week of Blender, and we will never know what they would have built.

That is ending, and it is ending *now*, and it is not ending because one model got good at meshes.

It is ending because the entire supporting cast got good and got free at the same time. A vision model that can look at your photograph and tell you why it will not work. A safety model that returns in 340 milliseconds. An embedding model that gives your character a memory. A speech model that gives it a voice. A face model that makes its mouth move. Each one is unremarkable on its own. Together they are the difference between a research artifact and a thing a fourteen-year-old can use on a school Chromebook to build a world.

NVIDIA's most underrated contribution to 3D is not the GPU in the datacenter. It is the decision to put Nemotron Nano, NemoGuard, TRELLIS, FLUX, Riva, and Audio2Face behind one free API key. That decision is why a small team can put text-to-3D in a browser tab and charge nothing for it. It is why the guardrail is free. It is why the pipeline closes.

We are going to look back on this decade the way we look back on desktop publishing: a brief, strange window when the tools for a whole art form went from a priesthood to a text box, and the number of people who could participate went up by four orders of magnitude. The models that make that happen will mostly not be the famous ones. They will be 9B and 12B, they will run in a second, they will cost nothing, and they will spend their lives quietly telling people *not that photo, try this one instead*.

Build the small stuff. Put it in front. The generator was never the hard part.

---

*three.ws is a browser-native platform for generating 3D avatars, worlds, and agents from a sentence. The text-to-3D lane described here is free and open: no key, no account. Our full NVIDIA model map lives in [`docs/nvidia-models.md`](./nvidia-models.md), and the pipeline internals are in [`docs/3d-asset-pipeline.md`](./3d-asset-pipeline.md).*
