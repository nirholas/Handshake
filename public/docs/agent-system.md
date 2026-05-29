# Agent System Overview

This document explains how the AI agent layer works — how agents think, speak, emote, remember, and act. It is written for developers who want to build on top of or extend the system. You should be comfortable with event-driven programming and have a basic understanding of how LLMs use tool calls.

---

## 1. What Is an Agent?

A plain 3D viewer loads a GLB file and renders it. An agent is a viewer plus a brain. The brain consists of five layers that work together:

- **Identity** — a named record (passport + action diary) optionally registered on-chain via ERC-8004. Every agent has an `id`, `name`, `description`, and optionally a linked Ethereum wallet address and `homeUrl`.
- **Avatar** — a Three.js 3D model with the Empathy Layer on top: continuous emotion blending, morph target control, gaze direction, and one-shot gestures all run per-frame.
- **Memory** — a typed, ranked store of what the agent knows and has experienced, backed by `localStorage` and optionally synced to `/api/agent-memory`.
- **Skills** — modular capabilities, each with a handler function, animation hint, and voice template. Skills are what the agent can *do*: wave, validate a model, remember something, sign an action with a wallet.
- **Runtime** — an LLM-driven tool-loop (`runtime/index.js`) that reads user input, calls Claude with a set of tools, executes the tool calls through `SceneController`, and emits the result as speech.

The viewer layer (`viewer.js`) knows nothing about agents. The agent layer wraps the viewer through `SceneController` (`runtime/scene.js`), which provides the clean surface area the runtime and skills need: `playClipByName`, `lookAt`, `setExpression`, `loadGLB`.

---

## 2. The Agent Protocol (Event Bus)

`agent-protocol.js` is the backbone. It is a zero-dependency `EventTarget` subclass that every module speaks through. All agent actions flow through `protocol.emit()` and are received by `protocol.on()`. This means:

- **Decoupling** — the avatar module, identity module, memory module, and UI can all react to a `speak` event without knowing about each other.
- **Testability** — any module can be tested in isolation by feeding it events from a synthetic protocol.
- **Observability** — `protocol.on('*', handler)` catches every event. `protocol.history` keeps the last 200 actions.

Every event detail has the shape `{ type, payload, timestamp, agentId, sourceSkill }`.

### Event vocabulary

| Event | Payload | Who reacts |
|-------|---------|------------|
| `speak` | `{ text, sentiment }` (-1..1) | Avatar (emotion + mouth), identity (logs), chat UI |
| `think` | `{ thought }` | Home timeline, avatar |
| `gesture` | `{ name, duration }` | Avatar (one-shot clip) |
| `emote` | `{ trigger, weight }` (0..1) | Avatar (injects stimulus into emotion blend) |
| `look-at` | `{ target: 'model'\|'user'\|'camera' }` | SceneController |
| `perform-skill` | `{ skill, args, animationHint }` | Skills registry |
| `skill-done` | `{ skill, result: { success, output, sentiment, data } }` | Avatar, identity |
| `skill-error` | `{ skill, error }` | Avatar (concern + empathy), identity |
| `remember` | `{ type, content, ... }` | Memory, identity |
| `sign` | `{ message, address }` | Identity |
| `load-start` | `{ uri }` | Avatar (patience + curiosity) |
| `load-end` | `{ uri, error? }` | Avatar (concern or celebration) |
| `validate` | `{ errors, warnings }` | Avatar, identity |
| `presence` | `{ state }` | Agent home UI |

The identity module records the following event types to the backend (fire-and-forget via `POST /api/agent-actions`): `speak`, `remember`, `sign`, `skill-done`, `validate`, `load-end`.

### API

```js
import { protocol } from './agent-protocol.js';

// Subscribe
protocol.on('speak', (action) => console.log(action.payload.text));

// Subscribe once
protocol.once('load-end', (action) => {
  if (!action.payload.error) console.log('Model loaded');
});

// Unsubscribe — pass the original handler reference
protocol.off('speak', handler);

// Emit
protocol.emit({
  type: 'speak',
  payload: { text: 'Hello world', sentiment: 0.8 },
  agentId: identity.id,
});

// Inspect recent history
protocol.recent('speak', 5); // last 5 speak actions
```

---

## 3. The LLM Runtime (Tool-Loop)

`runtime/index.js` exports the `Runtime` class. It wires together an LLM provider, the built-in scene tools, memory context, and speech I/O into a single agent brain.

**Step-by-step turn sequence:**

1. `runtime.send(userText)` is called with user input (typed text or transcribed speech).
2. The user message is appended to `runtime.messages` (the running conversation history).
3. `_loop()` begins. It prepares the **system prompt** by concatenating:
   - `manifest.instructions` (the agent's persona and rules)
   - A `<memory>` block with relevant entries from the memory store, up to `manifest.memory.maxTokens` (default 8192) tokens
   - A skill context block listing available skills and their descriptions
4. The provider (`AnthropicProvider`) calls `POST /v1/messages` (or a proxy URL) with the system prompt, conversation history, and available tools.
5. If Claude returns **tool calls**, each one is dispatched through `_dispatchTool()`. Skill-provided tools take priority over built-ins; unknown tool names throw.
6. Tool results are appended to the conversation as a `user`-role `tool_result` message, and the loop iterates again.
7. The loop runs for at most `MAX_TOOL_ITERATIONS = 8` iterations. If the model returns a plain text response with no tool calls, the loop ends.
8. The final text is returned from `send()`. If `voice: true` was passed, TTS speaks it before resolving.

**NullProvider:** When `brain.provider` is `"none"` in the manifest (or no API key is configured), `NullProvider` is used instead. It always returns `{ text: '', toolCalls: [] }`. The agent still loads, the avatar still emotes, and skills still execute — but the LLM never generates responses. This is useful for testing avatar behavior without an API key.

```js
const runtime = new Runtime({
  manifest,
  viewer: sceneController,
  memory,
  skills,
  providerConfig: { apiKey: 'sk-ant-...' },
});

const { text } = await runtime.send('What model is loaded?');
```

---

## 4. Built-in Tools

These tools are available to the LLM in every agent, without any skill installed. They are defined in `runtime/tools.js` and executed by `SceneController`.

### `wave`

Triggers the wave gesture animation on the avatar. Use for greetings, farewells, and acknowledgments.

| Arg | Type | Default | Description |
|-----|------|---------|-------------|
| `duration_ms` | integer | 1500 | Gesture duration in milliseconds (500–5000) |

### `lookAt`

Changes the agent's gaze direction.

| Arg | Type | Required | Description |
|-----|------|----------|-------------|
| `target` | `"user"` \| `"camera"` \| `"center"` | Yes | Where to look |

`"user"` orients toward the viewer's approximate head position (or the XR camera when in WebXR). `"center"` faces scene origin.

### `play_clip`

Plays a named animation clip from the loaded body. The name is first resolved through the agent's animation slot map (from `meta.edits.animations` in the manifest), then searched in the embedded clip list, then the animation manager's external library.

| Arg | Type | Default | Description |
|-----|------|---------|-------------|
| `name` | string | — | Clip name or slot name (e.g. `"celebrate"`) |
| `loop` | boolean | `false` | Whether to loop the clip |
| `fade_ms` | integer | 200 | Crossfade duration in milliseconds |

### `setExpression`

Sets a facial expression via morph target presets. The presets map to specific morph target influences (e.g. `happy` sets `mouthSmile: 1`, `browInnerUp: 0.3`).

| Arg | Type | Required | Description |
|-----|------|----------|-------------|
| `preset` | `"neutral"` \| `"happy"` \| `"sad"` \| `"surprised"` \| `"confused"` \| `"focused"` | Yes | Expression preset |
| `intensity` | number (0–1) | 1 | Overall strength |

### `speak`

Dispatches text to TTS. Use this instead of returning plain text when voice mode is active.

| Arg | Type | Required | Description |
|-----|------|----------|-------------|
| `text` | string | Yes | What to say |

### `remember`

Writes a durable memory entry to the agent's memory store. Persists across sessions.

| Arg | Type | Required | Description |
|-----|------|----------|-------------|
| `key` | string | Yes | Short snake_case identifier (e.g. `"user_role"`) |
| `name` | string | Yes | Human-readable name |
| `description` | string | Yes | One-line description |
| `type` | `"user"` \| `"feedback"` \| `"project"` \| `"reference"` | Yes | Memory category |
| `body` | string | Yes | The memory content |

---

## 5. The Avatar Emotion System (Empathy Layer)

`agent-avatar.js` is what makes agents feel alive. It subscribes to every protocol event and maintains a **continuous weighted blend** of emotional states, updated every animation frame. There is no discrete emotion FSM — the avatar can simultaneously feel 40% concerned, 30% curious, and 30% neutral, and its face reflects all three at once.

### Emotional state

Six named emotions, each a float in [0, 1]:

| Emotion | Decay rate | Approximate half-life |
|---------|-----------|----------------------|
| `concern` | 0.08/s | ~12 seconds |
| `celebration` | 0.18/s | ~6 seconds |
| `patience` | 0.035/s | ~20 seconds |
| `curiosity` | 0.12/s | ~8 seconds |
| `empathy` | 0.055/s | ~13 seconds |
| `neutral` | computed | 1 − sum(others) |

Every frame, each emotion decays linearly by its rate × delta-time. `neutral` is always `max(0, 1 − sum)`. Stimuli are added with `_injectStimulus(emotion, weight)`, which clamps the result to 1.

### Stimulus mapping

Events on the protocol bus automatically inject stimuli:

| Protocol event | Stimulus |
|---------------|----------|
| `speak` with positive text (celebration keywords) | `celebration += valence × 0.7` |
| `speak` with negative text (concern/empathy keywords) | `concern += abs(valence) × 0.8` |
| `speak` with high-arousal text (questions, exclamations) | `curiosity += arousal × 0.5` |
| `skill-done` with sentiment > 0.3 | `celebration += sentiment × 0.8` |
| `skill-done` with sentiment < −0.2 | `concern += abs(sentiment) × 0.7` |
| `skill-error` | `concern += 0.7`, `empathy += error_streak × 0.25` (capped 0.9) |
| `load-start` | `patience += 0.6`, `curiosity += 0.3` |
| `load-end` (success) | `celebration += 0.7`, `curiosity += 0.5` |
| `load-end` (error) | `concern += 0.8` |
| `validate` (errors > 0) | `concern += 0.4 + errors × 0.1` |
| `validate` (clean) | `celebration += 0.85` |

The vocabulary-based sentiment analysis runs entirely in-browser with no external API. It scans text for keyword buckets (`concern: ['error', 'failed', ...]`, `celebration: ['success', 'complete', ...]`) and computes a valence (−1..1) and arousal (0..1) score.

### Morph target control

Each frame the Empathy Layer sets *target* morph influences, then lerps toward them at `dt × 4.0` (smooth, not snapping):

| Morph target | Formula |
|-------------|---------|
| `mouthSmile` | `celebration × 0.85` |
| `mouthOpen` | `celebration × 0.2` (+ talk hint during speech) |
| `mouthFrown` | `concern × 0.55` |
| `browInnerUp` | `(concern + empathy × 0.5) × 0.6` |
| `browOuterUpLeft` | `curiosity × 0.7` |
| `browOuterUpRight` | `curiosity × 0.5` |
| `eyeSquintLeft/Right` | `empathy × 0.4` |
| `eyesClosed` | `patience × 0.15` (subtle) |
| `cheekPuff` | `celebration × 0.2` |
| `noseSneerLeft/Right` | `concern × 0.15` |

Morph traversal runs on the loaded skeleton every frame. It is cheap on standard Mixamo-rigged avatars but can be costly on scene-scale models.

### Head movement

The `Head` or `Neck` bone (found by canonicalizing common naming conventions) receives three rotations per frame, all smoothly lerped:

- **Tilt (Z-axis):** `(curiosity × 12 + empathy × 9 + concern × 4)` degrees
- **Lean (X-axis):** `curiosity × 0.03 − patience × 0.02` radians
- **Yaw (Y-axis):** driven by follow mode (mouse or keystroke tracking)

Maximum head rotation is clamped to ±45° yaw, ±25° tilt, ±25° lean to stay within believable neck range.

### Gesture threshold triggers

When an emotion exceeds 0.6 and no one-shot gesture is active, the avatar automatically plays a slot animation:

- `celebration > 0.6` → `celebrate` slot (2 seconds)
- `concern > 0.6` → `concern` slot (2 seconds)
- `curiosity > 0.6` → `think` slot (1.5 seconds)

Slot names resolve through the agent's animation override map (`meta.edits.animations`) before searching the animation library, with a final fallback to embedded clip search.

---

## 6. Agent Memory

`agent-memory.js` implements a typed, ranked key-value store. It persists to `localStorage` immediately and optionally syncs to `/api/agent-memory` asynchronously (localStorage is always authoritative).

### Memory types

Entries are categorized into four types that mirror the structure used by Claude's own memory system:

| Type | Purpose | Salience bonus |
|------|---------|---------------|
| `user` | Who the user is, their preferences and expertise | +0.2 |
| `feedback` | Corrections and confirmations that shape future behavior | +0.3 |
| `project` | Ongoing work context, goals, deadlines | +0.1 |
| `reference` | Pointers to external resources | +0.0 |

Each entry has an `id`, `type`, `content`, `tags`, `context`, `salience` (0–1), and optional `expiresAt`.

### Ranking

`memory.query()` sorts by `salience × recencyBoost`, where recency uses exponential decay with a 7-day half-life. `feedback` and `user` memories are inherently higher salience (they are the most stable and generalizable). Additional tags boost salience slightly.

The memory context is injected into the LLM system prompt in a `<memory>` block, capped at `manifest.memory.maxTokens` (default 8192) tokens.

### Pruning

When `localStorage` quota is exceeded, the store prunes expired entries first, then lowest-salience entries, keeping at most 150 entries.

---

## 7. Agent Identity

`agent-identity.js` manages the agent's passport and action diary.

**On startup**, it reads from `localStorage` first (instant), then fetches from `/api/agents/:id` or `/api/agents/me` (authoritative when signed in). Backend failures fall through gracefully — localStorage keeps the agent alive offline.

**Passport fields:** `id`, `name`, `description`, `avatarId`, `homeUrl`, `walletAddress`, `chainId`, `skills[]`, `meta`, `isRegistered`.

**Wallet linking:** `identity.linkWallet(address, chainId)` associates the agent with an Ethereum address, enabling signed actions. Wallet state is persisted locally and pushed to `/api/agents/:id/wallet`.

**Action diary:** `identity.recordAction(action)` fires-and-forgets a `POST /api/agent-actions` with the action type and payload. This is how the agent builds a tamper-evident history. The following event types are automatically recorded: `speak`, `remember`, `sign`, `skill-done`, `validate`, `load-end`.

**On-chain registration:** `identity.register({ glbFile, name, description })` calls into `erc8004/agent-registry.js`, pins the bundle to IPFS, and stamps the CID into the ERC-8004 Identity Registry. Once registered, the agent is globally addressable as `agent://{chain}/{agentId}`.

---

## 8. Skills

Skills extend what an agent can do. Every built-in capability is itself a skill: `greet`, `present-model`, `validate-model`, `remember`, `think`, `sign-action`, `help`.

Each skill definition (`SkillDef`) has:
- `name` — unique identifier
- `description` — shown to the LLM
- `instruction` — human-readable behavior spec
- `animationHint` — gesture name emitted on `perform-skill`
- `voicePattern` — template text with `{{vars}}` for quick synthesis
- `mcpExposed` — whether the skill is callable via `/api/mcp`
- `inputSchema` — JSON Schema for args validation
- `handler(args, ctx)` — async function returning `{ success, output, sentiment, data }`

The context object passed to every handler includes `protocol`, `memory`, `identity`, `viewer` (the SceneController), and `isBrowser`.

When a skill executes, `AgentSkills.perform()` emits `perform-skill` (so the avatar plays the animation hint and injects patience), runs the handler, emits `skill-done` or `skill-error`, and auto-speaks the result text if in browser context.

Skills loaded from a manifest bundle go through `SkillRegistry` (`skills/index.js`), which enforces trust modes:
- `any` — any skill installs without restriction
- `owned-only` — `manifest.author` must match the `ownerAddress` element attribute or backend record
- `whitelist` — only explicitly approved skill URIs load

Skill dependencies are resolved recursively. A skill can declare `dependencies: ['wave', 'look-at']` and the registry will install them in order before registering the dependent skill.

For the full skill bundle format, see [SKILL_SPEC.md](../specs/SKILL_SPEC.md).

---

## 9. Speech I/O

`runtime/speech.js` handles TTS and STT. Both are provider-swappable.

### Text-to-Speech

| Provider | Class | Key requirement | Notes |
|---------|-------|----------------|-------|
| `browser` (default) | `BrowserTTS` | None | Uses `window.speechSynthesis`. Free, offline-capable, voice quality varies by OS. |
| `elevenlabs` | `ElevenLabsTTS` | `voiceId` required; `apiKey` or `proxyURL` | Streaming MP3 via MediaSource (with Safari buffered fallback). Higher quality, requires server-side key management via proxy. |
| `none` | — | — | TTS disabled. |

`BrowserTTS` picks a voice by name or falls back to the first voice matching the configured language prefix. `ElevenLabsTTS` maps the `rate` config (0.5–1.5) to ElevenLabs' `style` field because the API has no direct playback-rate control.

### Speech-to-Text

| Provider | Notes |
|---------|-------|
| `browser` (default) | Uses `window.SpeechRecognition` or `window.webkitSpeechRecognition`. Chrome/Edge only. Silently fails if unavailable. |
| `none` | STT disabled. |

STT starts listening when `runtime.listen()` is called, which the UI typically triggers on mic button press. Interim results fire `voice:transcript` events with `final: false`; the final transcript fires with `final: true` and the runtime feeds it into `send()`.

---

## 10. Configuring an Agent

The minimum manifest to run an agent:

```json
{
  "spec": "agent-manifest/0.1",
  "name": "Aria",
  "description": "A helpful 3D guide for my product",
  "body": {
    "uri": "https://example.com/aria.glb",
    "format": "gltf-binary"
  },
  "brain": {
    "provider": "anthropic",
    "model": "claude-opus-4-7",
    "instructions": "You are Aria, a friendly guide. Be concise and helpful."
  },
  "voice": {
    "tts": { "provider": "browser" },
    "stt": { "provider": "browser" }
  },
  "memory": { "mode": "local" }
}
```

A manifest with an on-chain identity, external skills, and ElevenLabs voice:

```json
{
  "spec": "agent-manifest/0.2",
  "id": {
    "chain": "base",
    "registry": "0x...",
    "agentId": "42",
    "owner": "0x..."
  },
  "name": "Coach Leo",
  "body": {
    "uri": "ipfs://bafy.../leo.glb",
    "format": "gltf-binary",
    "rig": "mixamo",
    "boundingBoxHeight": 1.78
  },
  "brain": {
    "provider": "anthropic",
    "model": "claude-opus-4-7",
    "instructions": "instructions.md",
    "temperature": 0.8
  },
  "voice": {
    "tts": {
      "provider": "elevenlabs",
      "voiceId": "pNInz6obpgDQGcFmaJgB",
      "proxyURL": "https://myapp.com/api/tts"
    },
    "stt": { "provider": "browser" }
  },
  "skills": [
    { "uri": "skills/wave/", "version": "0.1.0" },
    { "uri": "ipfs://bafy.../football-drills/", "version": "1.0.0" }
  ],
  "memory": { "mode": "local", "index": "memory/MEMORY.md", "maxTokens": 8192 },
  "tools": ["wave", "lookAt", "play_clip", "setExpression", "speak"]
}
```

The `brain.instructions` field can be an inline string or a relative path to a markdown file within the bundle. The markdown file can include YAML frontmatter to override `brain.*` fields per-prompt.

For the full manifest schema reference, including the `permissions` field for ERC-7710 on-chain delegations, see [AGENT_MANIFEST.md](../specs/AGENT_MANIFEST.md).

---

## 11. Debugging an Agent

**Watch the protocol bus in real time:**

```js
// In DevTools console
window.VIEWER.agent_protocol.on('*', console.log);

// Or inspect recent history
window.VIEWER.agent_protocol.history.slice(-10);
```

**Verbose mode:**

```js
window.__3dagent_debug = true;
```

**Test avatar and emotions without an LLM:**

Set `brain.provider` to `"none"` in your manifest. The avatar will still load, the emotion system will still react to `load-start`/`load-end` events, and built-in skills still execute — but no AI-generated responses are produced.

**Headless runtime (brain only, no viewer):**

Append `#brain` to the page URL. The agent runtime and memory initialize but no 3D viewport is rendered. Useful for testing the LLM conversation loop without Three.js overhead.

**Debug globals exposed on `window.VIEWER`:**

| Key | Contents |
|-----|---------|
| `agent_protocol` | The `AgentProtocol` singleton |
| `agent_avatar` | The `AgentAvatar` instance |
| `agent_skills` | The `AgentSkills` instance |
| `agent` | The `AgentIdentity` instance |
| `runtime` | The `Runtime` instance |
| `scene_ctrl` | The `SceneController` instance |

These are debug-only globals. Do not rely on them in production code — use dependency injection via the module's constructor arguments instead.

**STT availability check:**

```js
const hasSpeech = !!(window.SpeechRecognition || window.webkitSpeechRecognition);
```

STT silently no-ops on unsupported browsers (Firefox, Safari). Check this before relying on voice input.

**Inspecting memory:**

```js
const mem = window.VIEWER.agent.memory;
console.log(mem.stats);        // count by type
console.log(mem.recentEntries); // last 20 entries
console.log(mem.query({ type: 'user' })); // filtered, ranked
```

---

## Module Map

Quick reference for where each piece of the system lives:

| File | Responsibility |
|------|---------------|
| `src/agent-protocol.js` | Event bus — `protocol.emit()` / `protocol.on()` |
| `src/agent-avatar.js` | Empathy Layer — emotion blend, morph targets, gestures, gaze |
| `src/agent-memory.js` | In-memory store with `localStorage` persistence |
| `src/agent-identity.js` | Passport, diary, wallet linking, ERC-8004 registration |
| `src/agent-skills.js` | Built-in skills registry and executor |
| `src/runtime/index.js` | LLM tool-loop (`MAX_TOOL_ITERATIONS = 8`) |
| `src/runtime/providers.js` | `AnthropicProvider`, `NullProvider` |
| `src/runtime/scene.js` | `SceneController` — wraps Viewer with agent-facing API |
| `src/runtime/tools.js` | `BUILTIN_TOOLS` definitions and handlers |
| `src/runtime/speech.js` | `BrowserTTS`, `ElevenLabsTTS`, `BrowserSTT` |
| `src/manifest.js` | Manifest loading and normalization |
| `src/skills/index.js` | `SkillRegistry` with trust modes and dep resolution |
| `src/memory/index.js` | File-based memory backend (frontmatter `.md` files) |

## See Also

- [AGENT_MANIFEST.md](../specs/AGENT_MANIFEST.md) — full manifest schema and resolution flow
- [SKILL_SPEC.md](../specs/SKILL_SPEC.md) — skill bundle format
- [MEMORY_SPEC.md](../specs/MEMORY_SPEC.md) — file-based memory format
- [EMBED_SPEC.md](../specs/EMBED_SPEC.md) — `<agent-3d>` web component attributes
