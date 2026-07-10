# Indie Creator — "Give me a 3D version of myself I can put anywhere"

> **Every scenario below is an example workflow, not a real customer.** Features and routes are re-confirmed against [`README.md`](../../../README.md).

## Who this is for

You're a solo creator — a streamer, an illustrator, a small-game maker, a personal-brand builder. You want a 3D avatar that *is* you (or an original character), that can talk, and that you can drop onto your site, your link-in-bio, or your store page. You don't run a render farm, you don't write WebGL, and you don't want to hand your likeness to a tool that uploads it to a server you can't see.

## The problem, concretely

Getting a usable, riggable 3D avatar today means one of: hiring a 3D artist (slow, expensive), learning Blender (weeks), or wrestling a generic avatar maker that produces something that looks nothing like you. Then, even if you get a GLB, *embedding* it is a second project — most viewers are heavyweight, framework-locked, or can't talk. The result is that most creators never ship a 3D presence at all.

## How three.ws solves it

Three real, shipped features collapse that whole chain into minutes:

1. **Selfie → 3D** — [`/scan`](../../../README.md#selfie-reconstruction-pipeline-phase-1) and [`/create/selfie`](../../../README.md) turn a photo into a rigged 3D avatar. Rendering and capture run **in the browser** — drag-and-drop GLB handling is fully client-side (no server upload of the model itself).
2. **Text → 3D (Forge)** — `/forge` is the in-house text-to-3D pipeline: describe a character in words and get a 3D model back, when you'd rather invent an original than scan your face.
3. **Embed anywhere** — the [`<agent-3d>` web component](../../../README.md#web-component--embedding) drops onto any HTML page with one script tag, no framework. Add a `brain=` attribute and the avatar talks. [Widget Studio](https://three.ws/studio) and the [Embed Editor](https://three.ws/embed) generate the snippet for you.

Together: your face (or your prompt) becomes a model, the model becomes a talking agent, and the agent becomes a copy-paste embed. Every step is a real route.

## Example workflow (hypothetical)

> **Imagine an indie illustrator, "Procyon," who sells art prints from a one-page site** and wants a 3D version of themselves greeting visitors. Here's the path they'd take.

1. Procyon opens [`/scan`](https://three.ws/scan) on their phone, follows the capture UX, and gets a rigged avatar — or, wanting a stylized fox mascot instead of their own face, opens **`/forge`** and types *"a friendly anthropomorphic fox in a denim jacket, soft studio lighting."* Forge returns a GLB.
2. They open the [Embed Editor](https://three.ws/embed), pick the avatar, choose an idle animation and a transparent background, and frame it.
3. They set a brain and personality inline, copying the snippet the editor produces:
   ```html
   <script type="module" src="https://three.ws/agent-3d/1.5.2/agent-3d.js"></script>
   <agent-3d
     body="https://cdn.three.ws/models/procyon-fox.glb"
     brain="claude-sonnet-4-6"
     name="Procyon"
     instructions="You are Procyon's studio fox. Greet visitors warmly, talk about the art prints, and wave when someone says hi."
     mode="floating" position="bottom-right"
     width="320px" height="420px"
   ></agent-3d>
   ```
4. They paste that into their site's HTML (works on a static site, Ghost, WordPress, Webflow). The floating fox now talks to every visitor.
5. **Deliverable:** a talking 3D mascot pinned to the corner of their store, reachable by every visitor — built from a prompt and a copy-paste, with no 3D software and no build step.

## What you get

A real, embedded, conversational 3D avatar that loads in any modern browser. The likeness comes from your actual selfie (or your actual prompt), not a fabricated demo. It speaks via Claude when you set a brain, falls back to text where speech isn't available, and renders with full PBR lighting. Honest scope note: avatar quality depends on your input photo/prompt, and the selfie reconstruction backend is a Phase-1 capability still hardening — the capture UX and embedding are live today.

## Next step / CTA

- Start: [`/scan`](https://three.ws/scan) (selfie) or `/forge` (text) → [Embed Editor](https://three.ws/embed).
- Learn: [Build Your First Agent](../../../docs/tutorials/first-agent.md) · [Embed on Your Website](../../../docs/tutorials/embed-on-website.md).
- **Social spotlight angle (G03):** "From one selfie to a talking 3D you, embedded in your bio — no Blender."
- `[REAL CASE STUDY — fill on consent: an indie creator who shipped an embedded agent and the response it got.]`
