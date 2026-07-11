# Game Studio — "Living NPCs and a shared 3D world without building the stack"

> **Every scenario below is an example workflow, not a real customer.** Features and routes are re-confirmed against [`README.md`](../../../README.md).

## Who this is for

You're a small or mid-size game studio — a few engineers and an artist or two — building something browser-playable or browser-adjacent. You want NPCs that actually converse, a multiplayer space players can hang out in, and a way to ship 3D characters without standing up your own renderer, netcode, and LLM runtime from scratch.

## The problem, concretely

A "talking NPC" that feels alive is three hard systems stitched together: a robust glTF/GLB rendering pipeline, an LLM runtime with tool-calling and emotion so the character *acts* and not just chats, and authoritative multiplayer netcode so players share a world. Each is months of work. Most studios cut the NPC to a dialogue tree and skip multiplayer entirely, because the infrastructure cost dwarfs the gameplay payoff.

## How three.ws solves it

three.ws ships those three systems as real, composable surfaces:

1. **GLB rendering pipeline** — the [viewer](../../../README.md#key-features) loads and validates glTF 2.0 / GLB with Draco, KTX2, and Meshopt, plus skinned animation and morph targets, all in WebGL 2.0. Drop a character at [`/app`](https://three.ws/app) and it renders instantly.
2. **Agent runtime + skills** — the [LLM tool-loop runtime](../../../README.md#the-agent-system) gives a character built-in tools (`wave`, `lookAt`, `play_clip`, `setExpression`, `speak`, `remember`) and a [composable skill system](../../../specs/SKILL_SPEC.md) so you can add game-specific abilities. The Empathy Layer blends emotion from protocol events, so NPCs emote instead of staring blankly.
3. **Multiplayer worlds** — [`/walk`](https://three.ws/walk) is an authoritative multiplayer walk scene backed by a Colyseus server (deployable on Google Cloud Run), and [`/play`](https://three.ws/play) is a shared, coin-keyed 3D world where players who pick the same world land **together** — peer avatars, chat, emotes, voxel building. Author motion and poses in [`/pose`](https://three.ws/pose) and [`/mocap-studio`](https://three.ws/mocap-studio).

## Example workflow (hypothetical)

> **Imagine a three-person studio, "Driftwood Games," prototyping a social exploration game** and wanting a guide NPC plus a shared hub. Here's the path they'd take.

1. The artist exports the guide character as a Draco-compressed GLB and drops it on [`/app`](https://three.ws/app) to confirm it renders, animates, and validates against the Khronos spec.
2. An engineer embeds the character as an [`<agent-3d>`](../../../README.md#web-component--embedding) element in the game's hub page, sets `brain=` and `instructions=` for the guide's personality, and writes one custom [skill](../../../specs/SKILL_SPEC.md) — `give_quest` — so the NPC can hand out objectives through the tool-loop instead of a static script.
3. For the shared space, they point players at [`/walk`](https://three.ws/walk) (authoritative Colyseus world) so testers can roam together with live peer avatars and chat while the studio dials in gameplay.
4. They author the guide's idle and point gestures in [`/pose`](https://three.ws/pose) and bind them to the NPC's `play_clip` tool calls.
5. **Deliverable:** a browser-playable hub with a conversational, gesturing guide NPC and a shared multiplayer space — assembled from real GLB rendering, a real agent runtime, and real netcode, without the studio writing any of those three engines.

## What you get

A character that renders with production-grade glTF handling, converses through a real tool-loop (with up to 8 tool iterations per turn) and emotes via the Empathy Layer, plus an authoritative multiplayer world players share. The runtime, viewer, and multiplayer server are open source under Apache 2.0, so the studio can self-host the Colyseus layer and extend the skill system. Honest scope note: this is a platform to build on, not a drop-in game engine — you still design the gameplay; three.ws supplies the avatar, runtime, and world plumbing.

## Next step / CTA

- Start: [`/app`](https://three.ws/app) to render a GLB, then [`/walk`](https://three.ws/walk) for the shared world. The Colyseus server lives in `multiplayer/`.
- Learn: [Write a Custom Skill](../../../docs/tutorials/custom-skill.md) · [Agent System docs](../../../docs/agent-system.md) · [Skill spec](../../../specs/SKILL_SPEC.md).
- **Social spotlight angle (G03):** "An NPC that emotes and hands out quests through a real tool-loop — plus a shared world players walk into together."
- `[REAL CASE STUDY — fill on consent: a studio that shipped a three.ws-powered NPC or multiplayer hub.]`
