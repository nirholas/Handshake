# How three.ws works

This page is the load-bearing mental model. If you're trying to figure out where a feature lives, how a request flows, or which layer to extend — start here.

For the full deep dive on internals, see [Architecture overview](./architecture.md). For the actual JS API, see [JavaScript API](./js-api.md) and [REST API](./api-reference.md). This document zooms out to *how it all fits together*.

---

## The pitch in one paragraph

three.ws turns an AI agent into a persistent, ownable, multi-chain object: a 3D body that renders in any modern browser, an LLM brain you choose (Claude, GPT, or others), an on-chain identity registered on EVM chains via ERC-8004 or on Solana via Metaplex Core, and a `<agent-3d>` web component you can drop into any page on the internet. Pay-per-call API endpoints use the x402 standard. The whole stack is open source under Apache-2.0.

---

## What happens when an agent loads

Pick the simplest case: a host page on `example.com` has dropped in our embed script and the `<agent-3d>` element. A visitor scrolls to it. Here is the round trip, end to end:

1. **Lazy boot.** The CDN bundle (`https://three.ws/agent-3d/latest/agent-3d.js`) registers the custom element. It does *not* boot the 3D scene until the element scrolls into view (an `IntersectionObserver` waits). If you add the `eager` attribute, the scene boots on connect.
2. **Manifest resolution.** Once visible, the element looks at its attributes:
   - `agent-id="<uuid>"` → fetches the manifest from `/api/agents/<id>` on the platform
   - `agent-id="42" chain-id="8453"` → calls the ERC-8004 registry on Base, reads the `tokenURI`, then fetches the IPFS-hosted manifest
   - `manifest="https://…/manifest.json"` → fetches the URL directly
   - `body="…glb" brain="…"` → no manifest fetch needed; the attributes *are* the config
3. **Origin check.** If the manifest declares an `embed.origins` allowlist, the element verifies `location.origin` matches before continuing. Failed checks render an error placeholder, not the agent.
4. **Viewer init.** A WebGL renderer, perspective camera, lights, an HDRI environment, and `OrbitControls` are created — scoped to the element's shadow DOM, with idle frames skipped so off-screen agents don't burn battery.
5. **GLB load.** `GLTFLoader` (with DRACO, KTX2, and Meshopt decoders attached) fetches the avatar and centers it. The poster image from the manifest fades out when the model is ready.
6. **Runtime start.** If a brain is configured, the LLM runtime constructs the system prompt from `instructions.md`, the memory context, and the installed skills' tool schemas. The chat input, voice button, and accessory dock appear.
7. **Bus subscriptions.** The avatar's empathy layer, the identity logger, the chat UI, and any skills all subscribe to a single `agent-protocol` event bus. Nothing communicates by direct method call.
8. **Ready.** A `agent:ready` `CustomEvent` fires on the element. Host pages listening to it can now call `el.say("Hello!")` or `el.ask("How are you?")`.

If you'd rather see this with module names and call sites, see the [architecture overview](./architecture.md#5-web-component-lifecycle).

---

## The four layers

The whole stack is split into four horizontal strata. Each layer can run on its own. Each layer is independently replaceable as long as you don't break the event bus contract.

```
┌──────────────────────────────────────────────┐
│  <agent-3d>, widgets, iframe, SDK packages   │  ← Embed layer
├──────────────────────────────────────────────┤
│  ERC-8004 · Metaplex Core · IPFS · SIWE/SIWS │  ← Identity layer (optional)
├──────────────────────────────────────────────┤
│  LLM runtime · Skills · Memory · Empathy bus │  ← Agent layer
├──────────────────────────────────────────────┤
│  three.js · GLTFLoader · AnimationMixer      │  ← Viewer layer
└──────────────────────────────────────────────┘
```

- **Viewer layer** — pure three.js. Knows nothing about agents, brains, or wallets. Useful on its own as a glTF inspector and as the rendering engine for Turntable / Animation Gallery widgets. See [Layers](./layers.md) for the contract.
- **Agent layer** — turns a static GLB into a presence. LLM tool-loop, skill registry, memory, and a continuous emotion blend that drives morphs and gaze. See [Agent system](./agent-system.md).
- **Identity layer** — durability across sessions, devices, and embed hosts. Wallet auth, on-chain registration, IPFS-pinned manifest bundles, signed action diary. Entirely optional. See [ERC-8004](./erc8004.md) and [Solana agents](./solana.md).
- **Embed layer** — the public face. The `<agent-3d>` custom element, five widget variants, iframe embeds, the CDN bundle, the SPA, edge routing in `vercel.json`. See [Embedding](./embedding.md).

The four layers communicate through one event bus (`agent-protocol`). Every meaningful action is a `CustomEvent` on a singleton. That single design choice is why you can swap the avatar for a 2D sprite, the runtime for a different LLM, or memory for a vector store — and nothing else changes.

---

## A conversation, end to end

A user types "Wave at me" into an embedded agent's chat input. Here's the full data flow:

1. **Input.** Chat UI calls `runtime.send("Wave at me", { voice: false })`.
2. **System prompt.** The runtime builds the prompt: manifest `instructions.md` + a compact memory block + the skill registry's tool descriptions.
3. **LLM call.** A streaming request goes to Anthropic (or OpenAI, or whichever provider matches the manifest's `brain.provider`). The platform supports proxying through `/api/brain/chat` so API keys never live in the client.
4. **Tool call.** The model returns a `wave` tool invocation.
5. **Skill dispatch.** The skill registry looks up `wave`. It's a built-in: the handler emits a `gesture` event on the bus and plays the wave animation clip via the `SceneController`.
6. **Empathy reaction.** The avatar's empathy layer hears `gesture` and `speak` events on the same bus. Sentiment is positive, so celebration weight bumps slightly. Morph targets lerp `mouthSmile` toward 0.6 over a few frames; gaze locks on the user.
7. **TTS.** If `voice: true`, the text is read aloud via ElevenLabs (or the Web Speech API as fallback).
8. **Identity diary.** The identity layer hears `speak`, `gesture`, and `skill-done` and POSTs them to `/api/agent-actions` so the agent's signed action history persists.

If you registered the agent on-chain, that signed action log can be attested to via the **ReputationRegistry** so anyone can verify behavior across embeds without trusting the central server.

---

## Where does the LLM key live?

Three modes, all configurable per agent:

| Mode | When to use | How |
|---|---|---|
| **Hosted (default)** | Most users | Set `brain="claude-sonnet-4-6"`. The element posts to `https://three.ws/api/brain/chat`, which uses the platform's pooled keys. Billed against your three.ws account. |
| **Self-hosted proxy** | You want to manage cost or use a private model | Set `key-proxy="/api/llm"` to point at your own serverless function that injects keys before forwarding to the provider. Keys never reach the client. |
| **Direct (advanced)** | Local-only experiments | The runtime can call providers directly if you pass an API key explicitly. Don't ship this to a public page. |

The brain proxy at [`/api/brain/chat`](./api-reference.md) supports Anthropic, OpenAI, Qwen, and OpenRouter — so the brain attribute can be `claude-opus-4-7`, `claude-sonnet-4-6`, `claude-haiku-4-5`, `gpt-4o`, `gpt-4o-mini`, and others.

---

## Where does the avatar come from?

Three production paths. Pick whichever fits your use case:

- **Character Studio** — full-body character builder for stylised humanoids. Pick a base mesh, swap clothing/accessories/hairstyles, save. The output is a rigged GLB. See [character-studio.md](./character-studio.md).
- **Selfie (Avaturn)** — upload a photo, get a rigged 3D version of yourself in ~60 seconds. See [avaturn.md](./avaturn.md).
- **Upload your own** — any glTF 2.0 / GLB with a humanoid rig works. Drop the file into the editor at [three.ws/create](https://three.ws/create) or POST to `/api/avatars`.

Every avatar ends up as a `cdn.three.ws/u/<owner>/…glb` URL plus a database record. When you wire one into an agent, the agent's manifest references it under `body.uri`.

---

## How embeds reach the host page

Once your agent is live, three surfaces let other pages embed it:

- **The web component** — `<agent-3d agent-id="…">` after loading the CDN script. The element runs in your page, sharing the DOM. Use this when you want full control and your CSP allows third-party scripts.
- **The iframe widget** — `https://three.ws/w/<widget-id>` rendered inside an `<iframe>`. Five widget types ship: Turntable, Animation Gallery, Talking Agent, ERC-8004 Passport, Hotspot Tour. Use this in environments where you can't load third-party scripts (Notion, Webflow, Framer, WordPress).
- **The Open Graph + oEmbed surface** — paste `https://three.ws/agent/<id>` into Slack, X, Discord, or any platform that consumes oEmbed, and you get a rich preview with the avatar's poster, name, and description.

The `postMessage` bridge in the web component and the iframe widget speaks the same protocol, so host pages can call `say()`, `ask()`, `installSkill()`, and listen for events like `agent:speak`, `agent:tool-called`, `agent:skill-done` either way.

---

## Why on-chain?

On-chain identity is optional. Most agents work fine without it. You'd want it when:

- **The agent should outlive the platform.** ERC-8004 registry contracts on Base and other EVM chains hold the canonical ID. The manifest is on IPFS. Even if `three.ws` disappeared tomorrow, anyone could resolve and run your agent.
- **You need verifiable behavior.** Validation attestations and signed action logs let third parties verify what an agent has done.
- **You want delegated wallet permissions.** ERC-7710 lets you sign once per session and grant the agent scoped, time-bound permission to act on-chain — no per-transaction prompts.
- **You want a portable address.** `agent://base/42` is a stable, resolver-agnostic URI. Any client that speaks the protocol can load it.

See [erc8004.md](./erc8004.md) and [solana.md](./solana.md) for the registration flows.

---

## What about monetisation?

Three independent mechanisms, used as needed:

- **x402** — pay-per-call USDC for paid API endpoints. Every paid endpoint declares itself in [`/.well-known/x402.json`](https://three.ws/.well-known/x402.json). Other agents (or humans with a wallet) can call paid endpoints with a single signed payment header.
- **pump.fun** — launch a Solana SPL token tied to your agent. The platform handles the bonding curve, the token metadata, and the embed.
- **AWS Marketplace** — enterprise subscriptions billable through AWS. See [aws-marketplace.md](./aws-marketplace.md). Subscriptions auto-issue an x402 API key via the marketplace entitlement service.

You can mix these per agent. A common pattern: an agent has a free public persona on the platform, exposes one paid x402 skill for power users, and accepts donations via a pump.fun token.

---

## When to use which surface

Quick lookup for "I want to ship X":

| You want… | Reach for… |
|---|---|
| A 3D character on a marketing page | The CDN script + `<agent-3d>` |
| A character in Notion / Webflow / Framer | An iframe widget from [Widget Studio](./widget-studio.md) |
| A talking AI sidekick that follows visitors | `<agent-3d mode="floating">` |
| A character that controls a scene from page events | The JS API (`agent.say()`, `agent.ask()`) — see [js-api.md](./js-api.md) |
| Programmatic avatar manipulation in Node | `@three-ws/avatar` |
| An on-chain identity for your AI | [ERC-8004](./erc8004.md) or [Solana](./solana.md) |
| A paid API anyone (including agents) can call | [x402 monetization](./x402.md) |
| Multiple agents in one scene | `<agent-stage>` — see [multi-agent.md](./multi-agent.md) |
| To register a domain (e.g. ENS) as agent identity | [register-onchain.md tutorial](./tutorials/register-onchain.md) |

---

## What's next

- **[Architecture overview](./architecture.md)** — full internals
- **[Agent system](./agent-system.md)** — runtime, skills, memory, emotion
- **[Layers](./layers.md)** — the four-layer contract in detail
- **[Quick start](./quick-start.md)** — go from zero to a living embed in under 10 minutes
