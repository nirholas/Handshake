# Layers

three.ws is split into four horizontal layers. Each layer can be used on its own. Each layer is independently replaceable as long as its contract with the rest of the system holds. This document describes what each layer owns, what it exports, and where to extend it.

For the overall request flow, see [How three.ws works](./how-it-works.md). For internal module names and paths, see [Architecture overview](./architecture.md).

---

## The contract

```
┌──────────────────────────────────────────────┐
│  Embed layer                                 │
│   <agent-3d> · widgets · iframe · SDKs       │
├──────────────────────────────────────────────┤
│  Identity layer  (optional)                  │
│   ERC-8004 · Metaplex Core · IPFS · SIWE/SIWS│
├──────────────────────────────────────────────┤
│  Agent layer                                 │
│   LLM runtime · skills · memory · empathy    │
├──────────────────────────────────────────────┤
│  Viewer layer                                │
│   three.js · GLTFLoader · AnimationMixer     │
└──────────────────────────────────────────────┘
```

The layers communicate through one event bus (`agent-protocol`). No layer calls another layer's methods directly. This is the load-bearing invariant — keep it intact and any layer can be replaced.

---

## Layer 1 — Viewer

**What it owns:** rendering, loading, animation, camera, lights, post-processing.

**Doesn't know about:** agents, brains, wallets, manifests, the protocol bus.

The Viewer is pure three.js. It can be used as a standalone glTF inspector with no agent at all — and is, in the Turntable and Animation Gallery widgets.

Concretely:

- `WebGLRenderer` configured for `devicePixelRatio`, demand-rendered (`viewer.invalidate()`), idle frames skipped.
- `GLTFLoader` with `DRACOLoader`, `KTX2Loader`, and `MeshoptDecoder` attached. Decoder URLs are version-pinned to the bundled three.js.
- `OrbitControls`, auto-disabled when an embedded glTF camera is selected.
- `AnimationMixer` plus a per-clip action-state map.
- HDRI environment, exposure / tone mapping controls, optional helpers (grid, axes, wireframe, skeleton).
- Multi-file resolution via `LoadingManager.setURLModifier()` so drag-and-drop `scene.gltf + scene.bin + textures/...` works locally without uploads.

**Extension points the next layer uses:**

- `viewer._afterAnimateHooks` — per-frame callbacks (emotion decay, tweens)
- `viewer.invalidate()` — request a render
- `viewer.content` / `viewer.scene` / `viewer.mixer`
- `viewer.animationManager` — external clip lazy-loading

If you only need a glTF viewer with no AI, importing `@three-ws/avatar` gives you this layer with a clean programmatic API (`loadAvatar()`, `playAnimation()`, etc.). The hosted Turntable and Animation Gallery widgets at `/w/<id>` are also pure viewer-layer.

---

## Layer 2 — Agent

**What it owns:** the LLM tool-loop, skills, memory, the empathy / emotion blend, the protocol bus.

**Doesn't know about:** how the LLM is hosted, where the wallet lives, which embed surface is showing it.

Modules:

- **`agent-protocol.js`** — singleton `EventTarget` bus. Every action is a `CustomEvent`. 200-event ring buffer (`protocol.history`) for debugging.
- **`runtime/index.js`** — LLM tool-loop. Builds the system prompt from `instructions.md` + memory + skills, calls the provider, dispatches tool calls, feeds results back. Capped at `MAX_TOOL_ITERATIONS = 8`.
- **`runtime/scene.js`** — `SceneController`, the only bridge between agent intent and three.js reality: `playClipByName`, `playAnimationByHint`, `lookAt`, `setExpression`, `loadGLB`, `loadClip`, `moveTo`.
- **`runtime/tools.js`** — built-in tools (`wave`, `lookAt`, `play_clip`, `setExpression`, `speak`, `remember`) and stage-scoped tools (`observe_agents`, `say_to_agent`).
- **`runtime/speech.js`** — TTS (ElevenLabs / Web Speech API) and STT (browser `SpeechRecognition`). Silent no-op where unavailable.
- **`agent-skills.js`** — skill registry. Skills are dynamically loaded bundles (`SKILL.md`, `tools.json`, `handlers.js`). Trust modes (`any` / `owned-only` / `whitelist`).
- **`agent-memory.js`** — four-type memory store (`user`, `feedback`, `project`, `reference`). File-based memories live as frontmatter `.md` files indexed by `MEMORY.md` plus an append-only `timeline.jsonl`.
- **`agent-avatar.js`** — the empathy layer. Translates bus events into a continuous emotion blend (neutral, concern, celebration, patience, curiosity, empathy) and drives morph targets, head tilt, and gaze.

The full agent layer can run against any three.js scene, not just our viewer — `SceneController` only needs the standard handles.

**Event bus vocabulary:** see [architecture.md §2](./architecture.md#2-the-event-bus-agent-protocoljs).

---

## Layer 3 — Identity

**What it owns:** persistent identity across sessions, devices, and embed hosts. Wallet auth, on-chain registration, IPFS-pinned manifests, signed action diary.

**Doesn't know about:** which avatar is loaded, what the LLM is doing.

**Entirely optional.** Most agents work fine without it. Removing this layer drops you back to a local-only experience — the agent still runs, but it has no persistent identity.

Modules:

- **`agent-identity.js`** — the passport + diary. Stable agent ID, owner address, signed action history. Backed by `localStorage` (cache) and `/api/agents/<id>` (canonical). Listens on the protocol bus and POSTs `speak` / `skill-done` / `validate` / `sign` events to `/api/agent-actions`.
- **`memory/`** — `local`, `ipfs`, `encrypted-ipfs`, or `none`. Declared on the manifest.
- **`erc8004/`** — on-chain registries. `IdentityRegistry` (mints agent token with `tokenURI`), `ReputationRegistry` (signed feedback), `ValidationRegistry` (validation report hashes). Per-chain addresses in `erc8004/abi.js`.
- **`solana-agent/`** — Solana counterpart. Metaplex Core asset mint + Solana Attestation Service (SAS) attestations.
- **`auth/` + `wallet/`** — SIWE / SIWS for backend mutations; Privy for email/social → embedded wallet onboarding; session cookies after wallet proof.

Per-chain registry addresses, ABIs, and helpers ship as `@three-ws/sdk`. ENS attestations are also handled here — see [register-onchain.md](./tutorials/register-onchain.md).

---

## Layer 4 — Embed

**What it owns:** the public face. The web component, widgets, iframe surfaces, the CDN bundle, the SPA, edge routing.

**Doesn't know about:** the contents of the manifest, what the LLM said, what the avatar is doing — only that they should be presented somewhere.

Modules:

- **`element.js`** — `<agent-3d>` custom element. Lazy-boots via `IntersectionObserver` (unless `eager`). Enforces origin allowlist. Exposes attributes for `body`, `brain`, `agent-id`, `manifest`, `mode` (`inline` / `floating` / `section` / `fullscreen`), `voice`, and more. Public methods: `say()`, `ask()`, `installSkill()`, `expressEmotion()`, `play()`, `lookAt()`, `dispose()`.
- **`agent-stage.js`** — `<agent-stage>` for hosting multiple agents in one shared scene. See [multi-agent.md](./multi-agent.md).
- **`widget-types.js`** — the five widget variants: Turntable, Animation Gallery, Talking Agent, ERC-8004 Passport, Hotspot Tour.
- **`lib.js`** — the CDN entry. Imports the element, registers it, re-exports the public surface (`defineElement`, `Agent3DElement`, `AgentStageElement`, helpers).
- **`embed-action-bridge.js`** — the `postMessage` protocol. Iframe widgets and the web component speak the same dialect, so host pages can drive either with the same code.
- **`app.js`** — the main SPA. URL routing via hash (`#model=`, `#agent=`, `#kiosk=`) and query (`?agent=`) params.
- **`vercel.json`** — edge routing. Clean URLs (`/agent/<id>`, `/agent/<id>/embed`, `/a/<chainId>/<agentId>`, `/w/<widget-id>`) map to the right HTML entries.

The embed layer's contract is the only thing third-party developers see directly. Keep its API surface small and stable; changes here are breaking changes per [SemVer](./changelog.md#versioning-policy).

---

## Cross-cutting: the protocol bus

Every layer above the Viewer subscribes to the same `agent-protocol` event bus.

- **Avatar layer** listens for `speak`, `gesture`, `skill-done`, `skill-error`, `validate`, `load-*` to pick emotion blends.
- **Identity layer** listens for `speak`, `remember`, `sign`, `skill-done`, `validate`, `load-end` and persists them.
- **Chat UI** listens for `speak` (render bubbles) and `voice:transcript` (live STT).
- **Memory** listens for `remember`.
- **`postMessage` bridge** mirrors a curated subset to host pages.

None of these modules know about each other. They subscribe by event type. That's the whole abstraction — and the reason any one of them can be ripped out and replaced.

If you're building a custom layer (a 2D sprite avatar, a vector-store memory backend, a different LLM provider), you only need to listen to and emit the same event vocabulary. Everything else is wiring.

---

## Build targets

The same source tree produces three independent builds:

- **App** — `npm run build`. The full SPA into `dist/`. Editor, agent pages, discover, studio, PWA manifest. Multi-page Rollup config with a Vercel-style dev middleware.
- **Library** — `npm run build:lib`. `src/lib.js` → `dist-lib/agent-3d.js` (ES module + UMD). Three.js and ethers stay bundled — the file is intentionally self-contained so a single `<script type="module">` is the only thing a third party needs.
- **Artifact** — `vite.config.artifact.js`. A zero-dependency bundle for Claude artifact embeds. Inlined everything, no external script tags, no dynamic imports.

Versioned CDN bundles are published at `/agent-3d/<version>/agent-3d.js`. Use `latest` for auto-updates or pin to a version for stability. See [changelog.md](./changelog.md) for release history.

---

## What's next

- **[Architecture overview](./architecture.md)** — module-by-module deep dive
- **[Agent system](./agent-system.md)** — runtime, skills, memory in detail
- **[Embedding](./embedding.md)** — the public face of the embed layer
- **[SDK reference](./sdk.md)** — `@three-ws/sdk` and friends
