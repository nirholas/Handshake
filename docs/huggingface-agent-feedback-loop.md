---
venue: Hugging Face community article (huggingface.co/blog/three-ws/...)
account: three-ws (organization)
suggested_title: "Generate, look, grade, iterate: closing the feedback loop for agentic 3D"
description: "Third three.ws article for the Hugging Face community. Text-to-3D has been one-shot since it existed, because the model that generates an asset cannot perceive it. This is the loop we built to fix that: rendering results back into the model's own modality, a mechanical physics-readiness grade, structural diffing between iterations, and universal retargeting, all on open models running on our own GPUs."
tags: [3d, agents, mcp, open-models, evaluation]
house_rules: |
  Hugging Face blog rules as applied to our previous two articles: keep it AI-focused.
  No coin, exchange, listing, or token content anywhere in this piece. Partner status
  may be stated factually where it is technically relevant, never as promotion.
status: draft, owner approval required before posting (external-channel gate in CLAUDE.md)
---

# Generate, look, grade, iterate: closing the feedback loop for agentic 3D

This is the third piece we have published here. The [first](https://huggingface.co/blog/three-ws/giving-ai-agents-bodies-and-wallets) argued that agents need bodies. The [second](https://huggingface.co/blog/three-ws/building-3d-ai-agents-end-to-end) walked the whole stack end to end. This one is about a single missing primitive that we think holds back every agentic 3D pipeline, ours included, and what happened when we built it.

**The problem in one sentence: every text-to-3D API in existence answers with a URL to a binary file, and a language model cannot read a binary file.**

That is why agentic 3D has been stuck at one shot since it began. The agent spends GPU time, receives a link, and has no way to tell a clean mesh from a melted one. It hands the link to a human and hopes. There is no error signal, so there is no loop, so there is no agency: just a very expensive random draw.

Everything below is Apache-2.0 at [github.com/nirholas/three.ws](https://github.com/nirholas/three.ws), and every endpoint marked free is keyless.

## 1. Let the model look at what it made

The fix is embarrassingly simple once you say it out loud: render the result back into a modality the model actually perceives.

Our `look_at_model` tool renders a GLB from several angles and returns the frames as **MCP image content blocks**, so a multimodal client renders them straight into the conversation. Alongside the frames it returns the geometry facts (triangle count, bounds, material count, whether it is skinned) and a plain-language reading of them.

Three ways in, because different consumers want different shapes:

| You are | Use | You get |
|---|---|---|
| An MCP client | `look_at_model` on `https://three.ws/api/mcp-studio` | frames as image blocks, rendered inline |
| A Node program | `@three-ws/see` | `see(url)` returns views, stats, notes |
| Anything with HTTP | `POST https://three.ws/api/3d/look` | JSON with a frame URL per angle |

```bash
curl -s -X POST https://three.ws/api/3d/look \
  -H 'content-type: application/json' \
  -d '{"src":"https://three.ws/avatars/cesium-man.glb"}'
```

What changes is not the quality of any single generation. What changes is that the agent can now **judge** one, which means it can decide to refine, and every refinement is its own version with its own artifacts. Generate, look, judge, refine, look again.

The generalisation is the part worth taking away, and it is not about 3D at all: **any tool that hands an agent a binary is a tool that needs a companion that renders it into the agent's own modality.** Ours was a mesh. Yours might be a PDF, a spreadsheet, an audio file, a CAD assembly, a compiled binary. If your agent cannot perceive its own output, it is not iterating, it is guessing.

## 2. A grade, so "good" means something mechanical

Perception gets you taste. It does not get you a specification.

A renderer forgives almost everything; a rigid-body solver forgives nothing. A mesh that looks perfect on screen can sink through the floor in MuJoCo, behave as if hollow in Bullet, or turn out to be a metre tall because the generator fitted it to a unit box and nothing in the file says so. Every robotics, game-physics and world-model pipeline rediscovers those defects by hand, one asset at a time.

So we published the claim, mechanically, free, and CC0:

```bash
curl "https://three.ws/api/sim-readiness?src=https://three.ws/avatars/cesium-man.glb"
```

Four verdicts:

| Verdict | Meaning |
|---|---|
| `simulation_ready` | Closed surface, consistent winding, positive volume, real-world extents. The only verdict that licenses trusting the reported mass. |
| `needs_scale` | Geometry is sound, only the units are missing. Multiply; mass properties scale with it. |
| `needs_repair` | Open, non-manifold, or inconsistently wound. Mass is reported but unreliable. |
| `unusable` | No triangles, or zero volume. |

A fifth value, `unreadable`, covers bytes that are not binary glTF 2.0 at all, kept deliberately distinct: one is a broken file, the other is a valid file with nothing to simulate. Verdicts are content-addressed by the file's SHA-256, so identical bytes always get an identical grade and caching is trivially correct.

Two design decisions I would defend to anyone building evaluation infrastructure:

**Free, permanently.** It is also exposed as a free tool on our *paid* MCP server, which is a deliberate exception to that server's pricing. An assurance check that costs money is a check nobody runs, and a check nobody runs prevents nothing.

**A spec, not a service.** [`specs/SIM_READINESS.md`](https://github.com/nirholas/three.ws/blob/main/specs/SIM_READINESS.md) is CC0 and the grader is a pure function you can vendor. If this becomes a standard that other people implement and we never see the traffic, that is the successful outcome, not a lost one. The glTF ecosystem has no machine-readable claim about physical usability, and that hole gets filled either by a shared spec or by fifty incompatible internal scripts.

## 3. Diff, so "changed" means something structural

Between iterations, "did that actually change anything" gets asked constantly, and comparing two viewers by eye is a bad instrument at any scale.

`@three-ws/glb-diff` answers structurally: node graph, meshes, primitives, materials, textures, skins, animations, and what moved. It began as an internal debugging tool for the refine loop, and it is now the thing we reach for whenever a model is subtly wrong. If your pipeline mutates glTF anywhere (optimisation, retexturing, decimation, rigging), it is worth wiring in.

Together with the grade, this is what turns a refine loop into something you can actually evaluate: perception says whether it looks right, the grade says whether it is usable, and the diff says whether the last change did anything at all.

## 4. Retargeting, because the rig is never yours

The other half of "agentic 3D" is that the asset has to *do* something, and animation is where pipelines quietly fail.

Our constraint is that we never see the model first. It might come from our own lanes, from Mixamo, VRoid, Daz, Unreal, or a Blender export from 2019. So instead of a curated allowlist of supported rigs, we canonicalise bone names, then retarget onto the canonical set. The mapping covers Mixamo, Avaturn, Unreal, VRM and VRoid, VRM 1.0, Daz/Genesis, MakeHuman, Blender `.L`/`.R` and simple `shoulderL` conventions, and a new convention is one mapping entry plus a test, not a new code path. A model that genuinely cannot be skeleton-driven falls back to a default rig rather than a bind-pose T-pose, because a T-pose reads as a bug to every user and as "unsupported" to none of them.

It is published on its own as `@three-ws/retarget`.

## 5. The models underneath, and the fleet that serves them

None of this is interesting without generation that works, and all of ours is open models on hardware we run:

- **TRELLIS** for native single-hop image to 3D, taking both user photos and the synthesized view our text lane produces.
- **Hunyuan3D** for high-poly image-conditioned reconstruction, poly-budget aware.
- **TripoSG** for sketch to 3D, and **TripoSR** in the family around it.
- Plus the pipeline workers: rigging, remeshing, texturing, segmentation, stylization, background removal, avatar reconstruction from a photo, text to motion, video to motion, video to scene, and sign-language synthesis.

Thirty-two workers, most published as Docker images. They run as individual GPU services (NVIDIA L4s, plus one RTX PRO 6000 Blackwell for the heaviest lane), each speaking the same task shape, each with a failover chain so an unavailable model degrades quality rather than failing the request.

Three production notes that will save someone a day:

**Decode meshopt before anything reads geometry.** Most of our avatars ship with `EXT_meshopt_compression`. Every server-side consumer that reads geometry (ours are Python and use trimesh) must decode first, and the failure is confusing because the file loads perfectly in every browser viewer you test with.

**Model end-of-life is a silent outage.** When an upstream family reached end of life on one of our free rungs, the rung answered `410`. The chain fell through correctly, but the real lesson was that a scheduled job should diff your hardcoded model ids against the live catalogues so you learn before users do.

**Never let a failover chain have an empty rung.** Two rungs in our text chain are keyless on purpose, so the bottom of the chain always exists even when every keyed provider is unset or throttled.

## 6. What we would like the community to take, argue with, or fork

- **`look_at_model` is the pattern, not the product.** Render your agent's output into your agent's modality. This costs a weekend and changes what your pipeline can do.
- **The readiness spec is CC0 and we want implementations, not traffic.** If you ship assets into a simulator, tell us where the four verdicts are wrong.
- **Retargeting without an allowlist is achievable**, and the mapping table wants conventions we have not hit.
- **Publish the negative results.** We evaluated approaches that did not survive contact (including exposing our agent as a smart-home device) and published the reasoning, and every time we have done that somebody has arrived with a better argument.

Free to try, no account and no key: [three.ws/forge](https://three.ws/forge) for generation, `https://three.ws/api/mcp-studio` for the eleven-tool MCP server, and the [three-ws organization](https://huggingface.co/three-ws) here for the avatar model repo and the viewer Space.

three.ws is an NVIDIA Inception member and an IBM Business Partner; both are programme designations rather than endorsements, and neither company has reviewed this article.
