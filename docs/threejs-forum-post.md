---
venue: three.js Forum (discourse.threejs.org), category "Resources" (cross-post the demo to "Showcase")
account: nichxbt
description: "Forum post for three.js developers: five open-source pieces pulled out of a production WebGL avatar platform, covering universal humanoid retargeting with no rig allowlist, progressive GLB streaming over plain HTTP, a terminal renderer, structural GLB diffing, and a free physics-readiness grade for glTF."
tags: [three.js, gltf, glb, animation, retargeting, webgl]
status: draft, owner approval required before posting (external-channel gate in CLAUDE.md)
---

# Five things we had to build to animate 3D characters nobody on our team modelled

_Post for the [three.js forum](https://discourse.threejs.org), category Resources._

I work on [three.ws](https://three.ws), a browser-native platform where you type a sentence and get a rigged, animated 3D character you can embed anywhere. Apache-2.0, source at [github.com/nirholas/three.ws](https://github.com/nirholas/three.ws).

The constraint that shaped everything: **we never see the model before it arrives.** It might come from our own generation lane, from Mixamo, from VRoid, from Daz, from a Blender export somebody made in 2019, or from a user's photo processed into a mesh ninety seconds ago. The rig is not ours and we do not get to pick the conventions.

Five pieces fell out of that, each published on its own so you can use them without the rest of the platform. All of them are things I looked for first and could not find.

## 1. Retargeting with no rig allowlist

**Package: `@three-ws/retarget`**

The usual approach to "animate any humanoid" is a curated list of supported rigs. It works until the eleventh rig, and every asset marketplace produces new ones faster than you can add them.

Instead we canonicalise bone names first, then retarget onto the canonical set. The mapping covers Mixamo, Avaturn, Unreal, VRM and VRoid, VRM 1.0, Daz/Genesis, MakeHuman, Blender `.L`/`.R` suffixes, and the simple `shoulderL` style rigs, and adding a new convention is one mapping entry plus a test case rather than a new code path.

Two details that took us longer than they should have:

**Legs are where naive retargeting falls apart.** Arm chains forgive a lot of proportion mismatch. Hip and foot chains do not, and the failure mode is a character that walks with its feet sliding, which readers describe as "the animation is broken" rather than "the retarget is wrong".

**The fallback must not be a T-pose.** If a model genuinely cannot be skeleton-driven (no skin, a non-humanoid prop), we detect that and fall back to a default rig rather than rendering a bind-pose statue. A T-pose in production reads as a bug to every user, and as "unsupported" to zero of them.

If you have ever hand-mapped a skeleton table, this is the package I would have wanted.

## 2. Progressive GLB over plain HTTP

**Package: `@three-ws/avatar-stream`**

A 12 MB avatar on a phone on a train is a blank canvas for eight seconds and then, suddenly, a character. Every user reads that pause as a broken page.

`avatar-stream` packs a GLB into a layered stream so the viewer shows something structurally correct early and refines it, over ordinary HTTP with no special server. It is not a replacement for compression, it composes with it. The reason we wrote our own rather than reaching for an existing progressive format is that we needed the first frame to be *correct*, not a blob: an avatar that appears with the wrong proportions and then snaps is worse than one that appears late.

## 3. A structural diff for glTF

**Package: `@three-ws/glb-diff`, live at three.ws/diff**

When a generation pipeline iterates on a mesh, "did that change anything" is asked constantly, and eyeballing two viewers side by side is a bad instrument. `glb-diff` answers structurally: node graph, meshes, primitives, materials, textures, skins, animations, and what moved between two versions.

It started as an internal debugging tool for our refine loop and turned out to be the thing I reach for most when a model looks subtly wrong. If you run any pipeline that mutates glTF (optimisation, retexturing, decimation), this is worth ten minutes.

## 4. A physics-readiness grade, and a CC0 spec for it

**Free endpoint: `GET https://three.ws/api/sim-readiness?src=<glb>` . Spec: `specs/SIM_READINESS.md`, CC0**

This is the one I would most like this forum to tear apart, because I think the gap is real and I do not think our answer is final.

A renderer forgives almost everything. A rigid-body solver forgives nothing. The same mesh that renders beautifully in three.js can sink through the floor in a physics engine, behave as if hollow, or turn out to be a metre tall because the generator fitted it to a unit box. **A GLB carries no claim about whether it can be simulated**, so every robotics, game-physics and world-model pipeline rediscovers the same defects by hand, one asset at a time.

The grade answers four things mechanically: closed surface, consistent winding, positive volume, and whether the extents are plausible real-world metres.

```bash
curl "https://three.ws/api/sim-readiness?src=https://three.ws/avatars/cesium-man.glb"
```

Four verdicts. `simulation_ready` is the only one that licenses trusting the reported mass. `needs_scale` means the geometry is sound and only the units are missing (multiply and go). `needs_repair` means open, non-manifold, or inconsistently wound, so the mass properties are reported but unreliable. `unusable` means no triangles or zero volume. There is a fifth value, `unreadable`, for bytes that are not binary glTF 2.0 at all, deliberately distinct: one is a broken file, the other is a valid file with nothing to simulate.

Results are content-addressed by the file's SHA-256, so the same bytes always get the same verdict.

It is free and keyless on purpose: a check that costs money is a check nobody runs, and a check nobody runs prevents nothing.

## 5. A terminal renderer, which sounds like a joke and is not

**Packages: `@three-ws/tty-3d` (core), `@three-ws/tty-avatar` (the CLI)**

```bash
npx @three-ws/tty-avatar 81a076b6-55ff-49a2-b007-1d88e7dce2aa
```

That draws a skinned, animated GLB in colour at 24fps in a plain terminal, no browser and no GPU. Three glyph modes: truecolor half-blocks (two colours per cell), braille (2x4 dots per cell for four times the vertical detail), and a plain luminance ramp when the output is piped.

Two reasons it is not a toy. First, it forced the animation stack to be renderer-agnostic, which caught two bugs that WebGL was hiding. Second, wire it to a coding agent's hooks and the avatar becomes that agent's face: thinking while it reads, nodding while it edits, shaking when a tool fails, bouncing when it finishes. An ambient posture in a second pane is a better progress indicator than a spinner because you read it without switching focus.

## Assorted production notes, since this forum appreciates them

**Meshopt will bite you server-side.** Most of our avatars ship with `EXT_meshopt_compression`. Anything in the pipeline that reads geometry outside a browser (our Python workers use trimesh) has to decode it first, and the failure is confusing because the file loads fine in every viewer you test with. If you run a server-side glTF pipeline, put the decode in front of everything, once, rather than per consumer.

**Release the context between scenes.** Our splat viewer held onto the GPU between scenes and the third scene load on a laptop was a slideshow. Disposing properly on unmount is table stakes advice that everyone including us learns twice.

**Wake heavy previews on view, not on load.** A grid of 3D previews that all initialise on page load will jank on any machine. Intersection-observer gating turned our marketplace grid from a stutter into a scroll.

**Soft shadows are the first thing to silently regress.** A renderer change that makes shadows hard does not throw, does not warn, and nobody notices for a week. Ours regressed across three studio pages at once. If you have a shared light rig, pin it in a test that renders and compares, not in a code review.

**52 ARKit blendshapes is the interchange currency for faces.** Not because it is elegant, but because it is what the tooling, the capture stacks and the models converge on. We map onto it and let the rig-specific weirdness live in one adapter.

## What is where

- Retargeting: `@three-ws/retarget`
- Progressive streaming: `@three-ws/avatar-stream`
- Diffing: `@three-ws/glb-diff`, and the page at [three.ws/diff](https://three.ws/diff)
- Physics readiness: [three.ws/docs/sim-readiness](https://three.ws/docs/sim-readiness), spec CC0
- Terminal rendering: `@three-ws/tty-3d`, `@three-ws/tty-avatar`
- Viewer look and feel: `@three-ws/viewer-presets` (light rigs, floor reflections, bloom, PBR presets)
- The whole platform, if you want to see them in situ: [github.com/nirholas/three.ws](https://github.com/nirholas/three.ws)

The generation side runs open model families on our own GPU fleet, and the free lane is keyless if you want to make something to test any of this against: [three.ws/forge](https://three.ws/forge).

Questions welcome, especially on 1 and 4. The retarget mapping wants more rig conventions from people who have hit ones we have not, and the readiness spec wants adversarial review from anyone who has shipped assets into a physics engine in anger.
