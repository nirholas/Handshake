# Architecture Overview

This document describes how three.ws is put together, how data moves through it, and where the seams are if you want to extend, self-host, or integrate it with another stack. It assumes familiarity with modern JavaScript, WebGL/three.js at a high level, and the basics of EVM blockchains and content-addressed storage.

three.ws is simultaneously a glTF viewer, an LLM-driven character runtime, an on-chain identity layer, and a distributable web component. These concerns are split into four layers that communicate through a single event bus rather than direct method calls. Most of the interesting design decisions live at the seams.

---

## 1. The four-layer architecture

Picture four horizontal strata. Each layer can run on its own — the viewer is a useful glTF inspector with no agent, the agent runtime works against any three.js scene, identity is an optional opt-in, and the embed layer wraps everything so it can be dropped onto any page.

### Layer 1 — Viewer (rendering)

The bottom layer is pure three.js. It knows nothing about agents, manifests, or wallets.

- **WebGLRenderer** with antialiasing, configured for the host's `devicePixelRatio`. Rendering is invalidated on demand (`viewer.invalidate()`) rather than via an unconditional rAF loop, so idle agents don't burn battery.
- **GLTFLoader** with **DRACOLoader**, **KTX2Loader**, and **MeshoptDecoder** wired in. Decoders load from `unpkg.com/three@<rev>/examples/jsm/libs/...` so they stay version-pinned to the bundled three.js.
- **OrbitControls**, automatically disabled when an embedded glTF camera is selected.
- **AnimationMixer** for clip playback, with a per-clip action-state map for the GUI.
- **dat.gui** panel for material/texture inspection, environments, exposure, tone mapping, morph targets, animations, and embedded cameras. Folders for animations, morph targets, and cameras are rebuilt on every load.
- **Stats panel**, helpers (grid, axes, wireframe, skeleton), screenshot capture.
- **Multi-file resolution** via `LoadingManager.setURLModifier()` that intercepts every relative URL inside a glTF and serves matching dropped files as blob URLs — drag-and-drop `scene.gltf + scene.bin + textures/...` resolves locally with no server round-trip.

Extension points the agent layer hooks into: `viewer._afterAnimateHooks` (per-frame callbacks for emotion decay and tweens), `viewer.invalidate()`, `viewer.content` / `scene` / `mixer`, and `viewer.animationManager` for external clip lazy-loading.

### Layer 2 — Agent runtime

This is the layer that turns a static GLB into a presence. It's structured as a handful of cooperating modules that communicate through one event bus.

- **`agent-protocol.js`** — the central `EventTarget` bus. Every action is a `CustomEvent`. Keeps a 200-action ring buffer for debugging (`protocol.history`).
- **`agent-avatar.js`** — the **Empathy Layer**. Translates bus events into a continuous emotion blend (neutral, concern, celebration, patience, curiosity, empathy). Each emotion has its own decay rate (celebration half-life ~4s, patience ~20s) and drives morph targets, head tilt, and gaze.
- **`runtime/index.js`** — the **LLM tool-loop engine**. Holds conversation history, builds the system prompt from manifest instructions + memory + skill descriptions, calls the provider, dispatches tool calls, feeds results back. Capped at `MAX_TOOL_ITERATIONS = 8`.
- **`runtime/scene.js`** — the **SceneController**. The single bridge between agent intent and three.js reality: `playClipByName`, `playAnimationByHint`, `lookAt`, `setExpression`, `loadGLB`, `loadClip`, `moveTo`. `<agent-stage>` can scope operations to a sub-group via `setGroup()`.
- **`runtime/tools.js`** — built-in tool defs (`wave`, `lookAt`, `play_clip`, `setExpression`, `speak`, `remember`) and stage-scoped tools (`observe_agents`, `say_to_agent`). Each is a JSON schema + an async handler `(args, ctx)`.
- **`runtime/speech.js`** — TTS (Web Speech API or ElevenLabs) and STT (browser `SpeechRecognition`). STT silently no-ops where unavailable.
- **`agent-skills.js`** + **`skills/`** — the skill registry. Skills are dynamically loaded bundles (`SKILL.md`, `tools.json`, `handlers.js`). Trust modes (`any` / `owned-only` / `whitelist`) gate installation.
- **`agent-memory.js`** + **`memory/`** — a four-type store (`user`, `feedback`, `project`, `reference`). The file-based variant writes frontmatter `.md` files, an auto-generated `MEMORY.md` index, and an append-only `timeline.jsonl`.

### Layer 3 — Identity & persistence

This layer is what keeps an agent's existence durable across sessions, devices, and embed hosts.

- **`agent-identity.js`** — the **passport + diary**. Stores the agent's stable id, owner address, and a signed action history. Backed by `localStorage` for the local cache and `/api/agents/:id` for the canonical record. Listens on the protocol bus for `speak`, `remember`, `sign`, `skill-done`, `validate`, `load-end` and POSTs them to the backend fire-and-forget.
- **`memory/`** — one of four modes: `local` (browser/disk), `ipfs` (pinned via Pinata or Filebase), `encrypted-ipfs` (still a stub), or `none` (stateless). Mode is declared on the manifest.
- **`erc8004/`** — the **on-chain identity** layer. Contains:
  - `IdentityRegistry` — mints an agent token whose `tokenURI` points at the manifest CID
  - `ReputationRegistry` — accepts signed feedback per agent
  - `ValidationRegistry` — stores hashes of validation reports (so anyone can verify a glTF was validated)
  - ABIs and per-chain deployment addresses live in `erc8004/abi.js`. Connection helpers, `registerAgent()`, and `pinToIPFS()` live alongside.
- **`auth/` + `wallet/`** — wallet auth via SIWE, Privy OAuth, and session cookies. SIWE proves wallet ownership without passwords; Privy provides email/social → embedded wallet onboarding.

### Layer 4 — Embed & distribution

The top layer is what lets an agent live somewhere other than the canonical app.

- **`element.js`** — the `<agent-3d>` custom web component. Lazy-boots via `IntersectionObserver` (unless `eager`), enforces an origin allowlist for embeds, and exposes attributes for body, brain, agent-id, manifest URL, mode (`inline` / `floating` / `section` / `fullscreen`), and more.
- **`widget-types.js`** — five widget variants (chat, action button, mini-card, full card, floating bubble) that share the underlying element but ship as separate ergonomic wrappers.
- **`lib.js`** — the CDN entry. Imports the element, registers it, and re-exports the public surface.
- **`app.js`** — the main SPA. URL routing happens here using hash params (`#model=`, `#agent=`, `#kiosk=`, `#brain=`, `#preset=`) and query params (`?agent=` for authenticated edit mode, `?pending=1` for post-login round-trips). The hash form stays in embed mode; the query form moves into edit mode.
- **`vercel.json`** — edge routing config. Maps clean URLs (`/agent/<id>`, `/agent/<id>/edit`, `/agent/<id>/embed`, `/a/<chainId>/<agentId>`) to the right HTML entry, and mounts `api/*` serverless functions.

---

## 2. The event bus (`agent-protocol.js`)

Every meaningful action in the agent runtime is a `CustomEvent` dispatched on a singleton `protocol` instance. This is the load-bearing design choice in the codebase.

The full vocabulary is small and stable:

| Type            | Payload                                                        | Notes                                |
| --------------- | -------------------------------------------------------------- | ------------------------------------ |
| `speak`         | `{ text, sentiment }` (-1..1)                                  | spoken output                        |
| `think`         | `{ thought }`                                                  | internal monologue                   |
| `gesture`       | `{ name, duration }`                                           | named one-shot body gesture          |
| `emote`         | `{ trigger, weight }`                                          | direct emotion injection             |
| `look-at`       | `{ target: 'user' \| 'camera' \| 'center' }`                   | gaze target                          |
| `perform-skill` | `{ skill, args, animationHint }`                               | a skill is starting                  |
| `skill-done`    | `{ skill, result: { success, output, sentiment, data } }`      | a skill finished                     |
| `skill-error`   | `{ skill, error }`                                             | a skill threw                        |
| `remember`      | `{ type, content, ... }`                                       | a memory was stored                  |
| `sign`          | `{ message, address }`                                         | wallet signature                     |
| `load-start` / `load-end` | `{ uri, error? }`                                    | model/asset lifecycle                |
| `validate`      | `{ errors, warnings }`                                         | validator outcome                    |
| `presence`      | `{ state }`                                                    | online/idle                          |

Listeners subscribe via `protocol.on(type, handler)` or `protocol.on('*', handler)` to monitor everything. The avatar listens for `speak`, `skill-done`, `skill-error`, `validate`, and `load-*` to pick the right emotion to blend in. The identity layer listens for the same set and persists them as a signed diary. The chat UI listens for `speak` to render bubbles. Memory listens for `remember`. None of these modules know about each other.

Why this matters in practice:

- **Hot-swap.** You can replace the avatar with a 2D sprite, the runtime with a different LLM, or the memory with a vector store, and as long as they speak the same protocol, nothing else changes.
- **Testability.** Snapshotting `protocol.history` after a turn is enough to assert the agent did what was expected.
- **Embed isolation.** When the element runs inside a sandboxed iframe, the bus is local to that iframe. The host page sees a curated subset via `postMessage` (see `embed-action-bridge.js`).

There is no rate limiter on `protocol.emit()` — a runaway skill can flood the bus, so handlers should be cheap.

---

## 3. The LLM tool-loop

The runtime ([src/runtime/index.js](../src/runtime/index.js)) is the agent's brain. The loop is straightforward but worth tracing once.

1. A user message arrives — either typed text or an STT transcript from `runtime.listen()`.
2. The runtime appends `{ role: 'user', content: text }` to its message history and notes it in memory.
3. It calls `provider.complete({ system, messages, tools })`. The provider is either `AnthropicProvider` (real Claude calls, optionally proxied) or `NullProvider` (echo for tests).
4. If the response contains no tool calls, the loop exits. The text becomes the agent's reply.
5. If there are tool calls, each is dispatched. Skill-provided tools take priority over built-ins (so a skill can intentionally shadow `wave` with its own variant). Each handler runs in a context object exposing `{ viewer, memory, llm, speak, listen, fetch, loadGLB, loadClip, loadJSON, call, stage, agentId }`.
6. Tool results — shaped `{ ok: true, ... }` or `{ ok: false, error }` — are fed back as a tool-result message and the loop iterates.
7. The loop is bounded at `MAX_TOOL_ITERATIONS = 8`.
8. If `voice: true` was passed to `send()`, the final text is read aloud by the TTS engine.

Throughout, the runtime dispatches events on its own `EventTarget` (`brain:message`, `brain:thinking`, `skill:tool-called`, `voice:speech-start`, `voice:transcript`) so the chat UI can stream incremental updates. These are runtime-local — they're separate from the global `protocol` bus, which fires only when a tool actually does something visible (e.g. `speak` or `remember`).

---

## 4. Agent manifest

The manifest is a JSON document that fully describes an embodied agent. It's intentionally Claude-shaped — `instructions.md`, `SKILL.md`, `MEMORY.md` are first-class files. A typical manifest looks like:

```jsonc
{
  "spec": "agent-manifest/0.2",
  "id": {
    "chain": "base",
    "registry": "0x...",
    "agentId": "1234",
    "owner": "0x..."
  },
  "name": "Coach Leo",
  "description": "A football coach who reviews your form.",
  "image": "ipfs://Qm.../poster.webp",
  "body": {
    "uri": "ipfs://Qm.../body.glb",
    "format": "gltf-binary",
    "rig": "mixamo",
    "boundingBoxHeight": 1.78
  },
  "brain": {
    "provider": "anthropic",
    "model": "claude-opus-4-7",
    "instructions": "instructions.md",
    "temperature": 0.7
  },
  "voice": { "tts": { "provider": "browser" }, "stt": { "provider": "browser" } },
  "skills": [{ "uri": "ipfs://Qm.../skills/wave/" }],
  "memory": { "mode": "local" },
  "personality": { "tone": "warm, direct", "domain": "football coaching" }
}
```

Key fields:

- **`name`, `description`, `creator`** — display metadata.
- **`body.uri`** — GLB / glTF / VRM URL. Resolution is deliberately polymorphic: `agent://chain/id` (resolved on-chain), `ipfs://CID/path`, `ar://TXID`, or plain `https://`. The resolver in `ipfs.js` walks gateway fallbacks (ipfs.io → dweb.link → nft.storage) so a single broken gateway never breaks an embed.
- **`skills[]`** — pointers to skill bundles. Each skill is loaded and validated by the registry. Trust mode determines whether unsigned/foreign skills are allowed.
- **`memory.mode`** — `local`, `ipfs`, `encrypted-ipfs`, or `none`.
- **`identity.chainId` / `identity.registryAddress`** — pin this manifest to an on-chain agent id.
- **`personality`** — flavor: tone, domain, and any extra system-prompt fragments.

`manifest.js` exposes `loadManifest(source)` and `normalize(json)`. `normalize()` will adapt either a full `agent-manifest/0.2` document or a bare ERC-8004 registration JSON into the shape the runtime expects, so registrations with minimal metadata still work.

---

## 5. Web component lifecycle

Booting `<agent-3d>` is a careful sequence — the goal is to never load a 50MB GLB on a page until the user has actually scrolled to it.

1. **Connect.** The element is added to the DOM. `connectedCallback` registers an `IntersectionObserver` (skipped if `eager` is set).
2. **Visibility.** When the element scrolls into view, the observer fires and triggers boot.
3. **Manifest load.** If `agent-id` is set, `agent-resolver.js` calls `/api/agents/:id` (or a chain RPC for `agent://chain/id`) to fetch the manifest. Inline config (`body=...`, `brain=...`) bypasses the resolver.
4. **Origin check.** If the manifest declares an embed policy with an origin allowlist, the element verifies the host page's origin is allowed before continuing. Failed checks render an error placeholder rather than the agent.
5. **Viewer init.** A canvas, renderer, OrbitControls, and lighting are created. The viewer is constrained to the element's bounding box and scopes events to its shadow root.
6. **GLB load.** `viewer.load(body.uri)` resolves the URI, fetches the model, and centers it. Loaders for Draco, KTX2, and Meshopt are reused across element instances.
7. **Runtime start.** If `brain` is set or the manifest has a brain config, the runtime is constructed with the SceneController, memory, and skill registry. The avatar is also booted and subscribes to the protocol bus.
8. **PostMessage bridge.** The `EmbedActionBridge` listens for messages from the host page (e.g. `{ type: 'agent:speak', text: '...' }`) and forwards them onto the protocol bus. Outgoing actions can be mirrored back to the host so an embedding page can react to what the agent does.

---

## 6. Multi-product build targets

There are three Vite build configurations, all driven from the same source tree.

- **App** (`npm run build`, default `TARGET=app`). Builds the full SPA into `dist/`: the editor, the agent-home/agent-edit/agent-embed pages, the discover/my-agents directory, the studio, and the PWA manifest. Multi-page Rollup config with a Vercel-style dev middleware that maps clean URLs to HTML entries.
- **Library** (`npm run build:lib`, `TARGET=lib`). Builds `src/lib.js` into `dist-lib/agent-3d.js` (ES module + UMD). Three.js and ethers stay bundled — the file is intentionally self-contained so a `<script type="module" src="https://cdn.../agent-3d.js">` is the only thing a third party needs. Expect ~600–900 KB gzipped today; further code-splitting is planned.
- **Artifact** (`vite.config.artifact.js`). A zero-dependency bundle for Claude artifact embeds. No external script tags, no dynamic imports — everything inlined so the artifact sandbox can run it.

---

## 7. Data flow for a conversation

Walking through a round trip ties the pieces together.

1. **User speaks.** The chat UI calls `runtime.listen()`. `SpeechRecognition` returns interim and final transcripts; the runtime dispatches `voice:transcript` events as they arrive.
2. **Transcript → runtime.** The final transcript is passed to `runtime.send(text, { voice: true })`.
3. **LLM call.** The runtime builds the system prompt from manifest instructions, the memory context block, and the skill registry's `systemPrompt()`, then calls `AnthropicProvider.complete()` with the message history and tool list.
4. **Tool call.** The model returns a `speak` tool call with `{ text: "Nice to meet you!" }`.
5. **Bus dispatch.** The handler emits `speak` on the protocol bus with `{ text, sentiment: +0.7 }`.
6. **Empathy reaction.** The avatar hears `speak`. Sentiment > 0.3 bumps celebration. The morph-target tick (on `viewer._afterAnimateHooks`) lerps `mouthSmile` toward 0.85 and tilts the head a few degrees on Z.
7. **TTS speaks.** The handler awaits `ctx.speak(text)`, calling the configured TTS engine. `voice:speech-start` and `voice:speech-end` fire.
8. **Memory logs.** The user turn was noted earlier (`note('user_said', ...)`); the runtime now appends the assistant turn to its history.
9. **Identity diary.** The identity layer hears `speak` and POSTs `{ type, payload, agentId, timestamp }` to `/api/agent-actions`, appending to the agent's signed action log.

If the agent had called `play_clip` instead, the SceneController would have walked `viewer.clips`, matched a clip, kicked off `mixer.clipAction(clip).play()`, and invalidated the renderer.

---

## 8. Blockchain integration (ERC-8004)

Agents can be registered on chain so anyone can resolve them by id without trusting a server.

The flow:

1. **User connects a wallet** via MetaMask, WalletConnect, or Privy embedded wallet.
2. **Manifest is pinned** to IPFS via Pinata or Filebase. The CID is the canonical pointer to the agent.
3. **Registration.** The user calls `IdentityRegistry.registerAgent(cid, metadata)` on the target chain (Base mainnet, Base Sepolia, or Ethereum mainnet). The registry mints a token whose `tokenURI` returns the manifest CID.
4. **Resolution.** Anyone with the chain id and agent id (or an ENS like `3dagent.eth`) can resolve the manifest: `manifest.js` reads `tokenURI(agentId)` from the registry, fetches the JSON over IPFS gateways, and normalizes it.
5. **Reputation.** Users can call `ReputationRegistry.submitFeedback(agentId, score, comment)` to attach reviews. The element exposes a small UI for this.
6. **Validation attestations.** When the glTF validator runs, the report can be hashed and posted to `ValidationRegistry.recordValidation(agentId, hash)` so anyone can verify the body has been spec-checked.

Per-chain registry addresses, ABIs, and helpers live in `src/erc8004/`. RPC endpoints fall back to public defaults but can be overridden with `?rpcURL=...`.

---

## 9. Security model

- **Client-side processing.** GLB files never leave the browser unless the user explicitly pins them. Drag-and-drop uses the File API and blob URLs — no upload.
- **Skill sandbox.** Skills are arbitrary JS. The registry has three trust modes: `any` (dev only), `owned-only` (skill author must match agent owner), and `whitelist`. Combined with **ERC-7710 delegation** for wallet-touching capabilities, a skill can only sign or transact with permissions the user has explicitly delegated.
- **CSP compatibility.** The embed bundle has no inline scripts; host pages can set strict CSP.
- **Embed policy.** The manifest can declare `embed.origins` as an allowlist or denylist. Enforced client-side by the element and server-side via referrer checks.
- **SIWE.** Sign-In With Ethereum for backend mutations: signed typed message with server nonce → session cookie. No passwords.
- **Blob URL lifecycle.** Every `URL.createObjectURL()` is paired with `URL.revokeObjectURL()`.

---

## 10. Self-hosting

To run the whole stack yourself, the minimum is:

- **Vercel (or any Node.js host)** for the SPA and `api/*` serverless functions. The provided `vercel.json` covers routing; on a non-Vercel host, reproduce the same path → handler map in your reverse proxy.
- **Neon DB (PostgreSQL)** for agents, widgets, sessions, and the action log.
- **Upstash Redis** for rate limiting, nonce storage, and short-lived caches.
- **AWS S3** (or any S3-compatible store — R2, B2) for hosted GLB and texture assets.
- **Anthropic API key** for the default LLM provider. The runtime can also point at a self-hosted proxy (`#proxyURL=`) for billing, logging, or a non-Anthropic backend.
- **Optional:** ElevenLabs for higher-quality TTS, Pinata or Filebase for IPFS pinning, Privy for non-wallet onboarding, an RPC endpoint for ERC-8004 reads.

A minimal Vercel + Neon + Anthropic deployment is enough for a single agent. The blockchain and IPFS pieces are opt-in — each layer can be replaced or removed. The protocol bus is the only thing you can't take out.
