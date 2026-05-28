# Introduction & Overview

## What is three.ws?

three.ws is an open-source, browser-native platform for creating, hosting, and embedding interactive AI agents that live inside 3D avatars. It combines a WebGL 3D viewer — built on [three.js](https://three.ws) with full glTF 2.0 / GLB support — with an AI agent runtime that gives each avatar personality, memory, skills, and optionally an on-chain identity.

The result is an agent that doesn't just respond in a chat box. It occupies a three-dimensional body, plays animations, responds to voice, and can be embedded into any web page with a single script tag and a custom HTML element.

**Key facts:**

- **License:** Apache-2.0 — use it, fork it, self-host it
- **Hosted platform:** [https://three.ws](https://three.ws)
- **CDN bundle:** `https://three.ws/agent-3d/latest/agent-3d.js` (also pinnable to a version, e.g. `/agent-3d/1.5.1/agent-3d.js`)
- **npm packages:** [`@three-ws/sdk`](https://www.npmjs.com/package/@three-ws/sdk), [`@three-ws/agent-ui`](https://www.npmjs.com/package/@three-ws/agent-ui), [`@three-ws/avatar`](https://www.npmjs.com/package/@three-ws/avatar), [`@three-ws/solana-agent`](https://www.npmjs.com/package/@three-ws/solana-agent), [`@3d-agent/mcp-server`](https://www.npmjs.com/package/@3d-agent/mcp-server)
- **No server required** for basic use — the viewer, agent runtime, and skill system all run in the browser via WebGL 2.0
- **glTF 2.0 / GLB** with Draco, KTX2, and Meshopt decompression supported out of the box
- **AWS Partner** — available on [AWS Marketplace](https://aws.amazon.com/marketplace) as a SaaS product, billable through your AWS account
- **x402 payments** — every paid endpoint discoverable at [`/.well-known/x402.json`](https://three.ws/.well-known/x402.json); MCP server at [`/api/mcp`](https://three.ws/api/mcp)

---

## Core Value Propositions

### Embodied AI

Most AI interfaces are text boxes. three.ws is different: the AI runtime is bound to a 3D avatar that expresses emotion, plays animations, and exists inside a rendered scene. When an agent speaks, a talk animation plays. When something goes wrong, the avatar can express that state visually. The connection between what an agent says and what it does in 3D space is a first-class concern, not an afterthought.

This matters in product contexts where trust, presence, and brand identity are important — a 3D character carrying your brand is more memorable than a floating modal.

### Embeddable Anywhere

The `<agent-3d>` custom element is designed for drop-in embedding. Any page that can load a `<script type="module">` tag can host an agent. No iframes required (though iframe embedding is also supported). The element handles its own shadow DOM, responsive layout, and lifecycle — the host page does not need to know anything about three.js or WebGL.

Four layout modes are available: `inline` (fills its container), `floating` (fixed bubble at a corner of the viewport), `section` (aspect-ratio hero block), and `fullscreen`.

### Extensible

Agents are built from composable pieces. The skill system lets you install modular capabilities — from built-in scene tools like `wave` and `lookAt`, to custom skills loaded from IPFS or HTTPS at runtime. Voice I/O (TTS and STT) is pluggable by provider. Memory backends can be local (localStorage), IPFS, encrypted IPFS, or none. The LLM provider and model are configurable per-agent.

The element exposes a full JavaScript API (`say()`, `ask()`, `installSkill()`, `expressEmotion()`, and more) so host applications can drive the agent programmatically.

### Decentralized

Agent identity can be registered on-chain using ERC-8004, the standard for three.ws identity. Once registered, an agent has a canonical address — `agent://base/42`, for example — that resolves to an IPFS-hosted manifest bundle containing the avatar, skills, memory config, and persona. Memories can be stored on IPFS. Signed ERC-7710 delegations let agents perform scoped, time-bound on-chain actions without per-transaction signing prompts.

For developers who don't need any of this, on-chain identity is entirely optional. A bare GLB URL is enough to get started.

### Open

The platform is Apache-2.0 licensed. You can self-host the full application, publish the library to your own CDN, or fork and modify any layer. The manifest format, embed protocol, and agent spec are all documented in the `/specs` directory of the repository.

---

## Key Concepts

### Agent

An agent is an AI entity with a 3D avatar, a persona (defined in `instructions.md`), a memory store, and a set of installed skills. At runtime, the agent runtime connects an LLM to the 3D scene: the model's outputs can trigger animations, speak through TTS, write to memory, or invoke skill tools. An agent can be as simple as an animated avatar that responds to text, or as complex as an on-chain entity with registered identity and delegated wallet permissions.

### Avatar

The avatar is the 3D model that visually represents the agent. It is a glTF 2.0 / GLB file loaded via three.js's `GLTFLoader`. The manifest specifies the avatar URI, its expected format, an optional rig type for animation retargeting, and a bounding box height for scale normalization. Any glTF-compatible model works; a `rig` field enables retargeting standard Mixamo or Humanoid animation clips to the specific skeleton.

### Skill

A skill is a modular capability bundle installed into an agent. Each skill has a manifest of its own, a set of tools exposed to the LLM, and optional scene hooks. Built-in examples include `wave` (plays a wave animation), `validate-model` (runs the glTF validator on the loaded body), and `sign-action` (performs a scoped on-chain action via a delegation). Skills are loaded lazily from relative paths, IPFS CIDs, or HTTPS URLs, and fire a `skill:loaded` event when ready. The host page can install or uninstall skills at runtime via the JS API.

### Widget

A widget is a pre-built, embeddable view built on top of the agent and viewer primitives. Five widget types ship with the platform:

| Widget | Description |
|---|---|
| **Turntable** | Auto-rotating 3D model viewer, no agent runtime |
| **Animation Gallery** | Displays and plays named animations from a GLB |
| **Talking Agent** | Full agent with avatar, voice, and chat UI |
| **ERC-8004 Passport** | On-chain identity card for a registered agent |
| **Hotspot Tour** | Annotated model with interactive camera waypoints |

Widgets can be embedded via iframe with a single line of HTML from Widget Studio at [https://three.ws/studio](https://three.ws/studio).

### Manifest

The manifest is a JSON file (typically `manifest.json`) that fully describes an agent — its identity, avatar, brain configuration, voice settings, installed skills, memory backend, and on-chain attestations. It is the single source of truth for what an agent is. Manifests are content-addressed: when an agent is registered on-chain, its canonical form is an IPFS bundle containing `manifest.json`, `instructions.md`, `body.glb`, a poster image, and any installed skill bundles.

A minimal manifest looks like:

```json
{
  "specVersion": "0.1",
  "name": "Aria",
  "body": { "uri": "./body.glb", "format": "glb" },
  "brain": {
    "provider": "anthropic",
    "model": "claude-sonnet-4-6",
    "instructions": "./instructions.md"
  }
}
```

The `<agent-3d>` element accepts a manifest via the `src`, `manifest`, or `agent-id` attribute, or falls back to a raw `body` GLB URL for zero-config embedding.

### ERC-8004

ERC-8004 is the on-chain standard used to register three.ws identity. A registered agent has a numeric ID tied to a specific chain (e.g., Base), an owner address, and a content-addressed pointer to its manifest bundle on IPFS. Registration makes an agent discoverable at a canonical URI (`agent://base/42`) and enables sharing, oEmbed previews, and delegated permissions. Registration is optional — agents work entirely without it.

---

## Architecture at a Glance

three.ws is organized into four layers, each building on the one below.

### Viewer Layer

The foundation is a WebGL 2.0 renderer powered by three.js r176. A `Viewer` class manages the scene graph, perspective camera, ambient and directional lighting, HDR environment maps, and a per-frame animation mixer. `GLTFLoader` handles model loading with Draco geometry compression, KTX2 texture supercompression, and Meshopt mesh optimization. `OrbitControls` provides interactive camera navigation. The viewer exposes a clean API used by higher layers — load a model, set environment, play an animation, move the camera.

### Agent Layer

Above the viewer sits the agent runtime. A `SceneController` bridges the LLM output to scene operations — calling `wave()`, `lookAt()`, `expressEmotion()`, or any skill tool. The `Runtime` class owns the LLM connection, conversation history, and tool dispatch loop. A `SkillRegistry` manages installed skills and their tool schemas. An emotion system translates intent signals from the protocol event bus into morph target weights or animation triggers on the avatar.

### Identity Layer

The identity layer is optional but unlocks the decentralized features. An ERC-8004 registry contract maps numeric agent IDs to IPFS manifest CIDs on supported chains. IPFS stores the manifest bundle. Sign-In with Ethereum (SIWE) authenticates the user's wallet, and ERC-7710 delegations encode scoped permissions the agent can redeem on behalf of its owner.

### Embed Layer

The embed layer is what developers interact with. `Agent3DElement` (`<agent-3d>`) is a custom HTML element with a fully encapsulated shadow DOM. It handles manifest resolution, responsive layout, viewport observation (lazy-mounting off-screen), the chat and voice UI, and a `postMessage` bridge for iframe communication. A `defineElement()` helper lets you register the element under a custom tag name for white-labeling. The CDN bundle (`lib.js`) re-exports all public classes so host applications can import and use them directly.

```
┌─────────────────────────────────────────┐
│           <agent-3d> element            │  ← Embed Layer
│  (shadow DOM, layout, postMessage)      │
├─────────────────────────────────────────┤
│  ERC-8004 registry │ IPFS │ SIWE/ERC-7710│  ← Identity Layer
├─────────────────────────────────────────┤
│   Runtime │ SkillRegistry │ Memory      │  ← Agent Layer
│   SceneController │ EmotionSystem       │
├─────────────────────────────────────────┤
│   Viewer │ GLTFLoader │ three.js r176   │  ← Viewer Layer
│   WebGLRenderer │ AnimationMixer       │
└─────────────────────────────────────────┘
```

---

## What You Can Build

**Talking product demo.** Embed a 3D character on your docs site that has been given your product documentation as its system prompt. Users ask questions; the character answers and plays contextual animations. No backend required for the agent itself.

**On-chain AI agent.** Register an agent to your ENS name or wallet address. Anyone can resolve it via `agent://base/<id>`, and its manifest — including skills and memory config — lives on IPFS. The agent can perform scoped on-chain actions via ERC-7710 delegations without per-transaction prompts.

**Kiosk widget.** Drop a Turntable widget into a marketing page for an auto-rotating 3D product model. Configure it in Widget Studio, copy the iframe embed, and paste it anywhere that accepts HTML — WordPress, Webflow, Notion, Framer, Shopify.

**Personal AI companion.** Build an agent with long-term IPFS memory that persists across sessions. Give it a custom voice, a distinctive avatar, and a detailed persona in `instructions.md`. Users can speak to it via microphone and it will remember past conversations.

**3D asset validator.** Use the `validate-model` skill to build an embeddable asset review tool. Drop a GLB onto the viewer; the agent runs the glTF validator, summarizes issues by severity, and tells you what to fix.

**Multi-agent scene.** Use `AgentStageElement` (also exported from `lib.js`) to host multiple agents in a shared scene. Agents can be scripted to interact with each other via the JS API — `say()`, `lookAt()`, `play()` — composing character-driven experiences.

---

## How It Compares

### vs. `<model-viewer>` (Google)

[`<model-viewer>`](https://modelviewer.dev) is a solid, well-maintained web component for displaying glTF models with AR support. It excels at simple 3D display and is the right choice if that's all you need. three.ws adds the entire AI agent stack on top: LLM runtime, skill system, memory, voice I/O, emotion system, and on-chain identity. It also adds Widget Studio for no-code embeds and a manifest format for portable agent definitions. If you want a talking, interactive character rather than a static viewer, three.ws is the right tool.

### vs. General LLM Chatbots

General-purpose chat interfaces (embedded or hosted) are text-first. They have no awareness of 3D space, no avatar, and no ability to control a scene. three.ws's agent layer is purpose-built to bridge LLM outputs to three.js operations: the model can trigger animations, adjust camera position, highlight hotspots, and express emotions through the avatar. It also has native glTF understanding — the LLM can reason about the loaded model's structure via the validator tool.

### vs. Unity / Unreal WebGL Exports

Game engine WebGL exports ship a large runtime (~10–50 MB) and require their own asset pipeline. They are not designed to be embedded as lightweight web components. three.ws is browser-native: no game engine, no plugin, no proprietary format. The CDN bundle is compact, the element self-initializes with a script tag, and the viewer runs on standard WebGL 2.0 available in every modern browser. The trade-off is that three.ws is not a general-purpose game engine — it is optimized for avatar-centric, interactive AI agent experiences.

---

## Quick Start

The minimum to get a three.ws on screen is two lines of HTML:

```html
<script type="module" src="https://three.ws/agent-3d/latest/agent-3d.js"></script>
<agent-3d body="https://example.com/avatar.glb"></agent-3d>
```

This loads your GLB file into a viewer with orbit controls, auto-sized to its container. No server, no build step, no API key required for a basic viewer.

To add an AI brain:

```html
<agent-3d
  body="https://example.com/avatar.glb"
  brain="claude-sonnet-4-6"
  key-proxy="/api/llm"
  instructions="You are Aria, a helpful product guide."
  voice
></agent-3d>
```

The `key-proxy` attribute points to a serverless function that injects your API key — the key never touches the client. The `voice` attribute enables microphone input and TTS output.

For a full step-by-step walkthrough, see the [Quick Start guide](./quick-start.md).

---

## What's Next

Once you have the basics working, the following guides go deeper:

- **[Quick Start](./quick-start.md)** — step-by-step from zero to a talking agent
- **[Embedding Guide](./embedding.md)** — all attributes, modes, events, and the JS API
- **[Widget Types](./widgets.md)** — Turntable, Animation Gallery, Talking Agent, Passport, Hotspot Tour
- **[Agent System Overview](./agent-system.md)** — runtime, skill registry, memory, emotion system
- **[Manifest Reference](./agent-manifest.md)** — full JSON schema with examples
- **[REST API](./api-reference.md)** and **[JavaScript API](./js-api.md)** — backend and in-browser surfaces
- **[Agents vs. avatars](./agents-vs-avatars.md)** — the difference, and when to care

If you want to look at what's already in the hosted platform — browsing agents, using Widget Studio, or registering on-chain — visit [https://three.ws](https://three.ws).
