# `<agent-3d>` Web Component API Reference

`<agent-3d>` is a custom HTML element that ships the entire three.ws stack in a single script tag. Drop the loader, use the element — no build step, no framework required.

```html
<script type="module" src="https://three.ws/agent-3d/1.5.1/agent-3d.js"
        integrity="sha384-…" crossorigin="anonymous"></script>

<agent-3d src="agent://base/42" style="width:400px;height:500px"></agent-3d>
```

All four layout modes, voice I/O, the LLM brain, persistent memory, and an extensible skill system are built in. Every feature is opt-in — a bare `<agent-3d body="./avatar.glb">` renders a silent 3D viewer with no API key and no external calls beyond the GLB itself.

---

## Boot lifecycle

The element is designed to be zero-overhead until it is needed.

1. **Element added to DOM** — `connectedCallback` fires. Shadow DOM shell (canvas container, chat chrome, poster, loading indicator) is rendered immediately.
2. **IntersectionObserver** starts watching the element. Nothing else happens until at least one pixel is visible in the viewport. Add the `eager` attribute to skip this and boot immediately on connection.
3. **Manifest resolved** — the element reads its source attributes (`src`, `agent-id`, `manifest`, or `body`) in priority order and fetches or constructs an agent manifest. See [Source attributes](#source-attributes) for the priority chain.
4. **Embed policy checked** — if the manifest maps to a backend agent ID, the element fetches the agent's embed policy and refuses to continue if the current origin is not permitted.
5. **Viewer constructed** — a three.js renderer is created inside the shadow DOM canvas. The GLB referenced by `manifest.body.uri` is loaded.
6. **Memory, skills, and runtime initialized** — the memory store is opened, skills listed in the manifest are installed, and the LLM runtime is wired up (or a null provider is used if `brain` is `none` or omitted).
7. **`agent:ready` fires** on the element with `{ agent, manifest }`. The loading indicator is hidden and the poster fades out.

If any step throws, `agent:error` fires and an error overlay is shown in place of the canvas.

---

## HTML attributes

### Source attributes (pick one)

These tell the element what to load. When multiple are set, priority is `src` > `agent-id` > `manifest` > `body`.

| Attribute | Form | Example |
|-----------|------|---------|
| `src` | On-chain URI | `src="agent://base/42"` |
| `agent-id` | Numeric id (pair with `chain-id`) | `agent-id="42" chain-id="8453"` |
| `agent-id` | CAIP-10 + token | `agent-id="eip155:8453:0xReg…:42"` |
| `agent-id` | Shorthand onchain: | `agent-id="onchain:8453:42"` |
| `agent-id` | Backend account ID | `agent-id="a_abc123"` |
| `manifest` | IPFS or HTTPS manifest URL | `manifest="ipfs://bafy…/manifest.json"` |
| `body` | Bare GLB URL (ad-hoc agent) | `body="./avatar.glb"` |

Using `body` with no manifest creates an ad-hoc agent. Its name, instructions, and brain model can be provided as additional attributes:

```html
<agent-3d
  body="/avatars/guide.glb"
  name="Guide"
  instructions="You are a friendly 3D guide."
  brain="claude-opus-4-7"
></agent-3d>
```

### Scene and rendering

| Attribute | Type | Default | Description |
|-----------|------|---------|-------------|
| `environment` | preset name or HDRI URL | `neutral` | IBL environment. Accepts built-in preset names or an HDRI URL. |
| `auto-rotate` | boolean | off | Slowly rotates the model around the Y-axis. |
| `camera-controls` | boolean | off | Enables orbit, pan, and zoom with mouse/touch. |
| `ar` | boolean | off | Shows an AR launch button. Uses WebXR on Android, Quick Look on iOS. |
| `shadows` | boolean | on | Enables contact and soft shadows. |
| `exposure` | number | `1.0` | Tone-mapping exposure multiplier. |
| `background` | `transparent` \| `dark` \| `light` | `transparent` | Canvas clear color. `transparent` lets the page background show through. |
| `skybox` | URL | — | HDRI rendered as visible sky behind the model. |
| `poster` | URL | — | Image shown while the model loads. Fades out on completion. |

### Brain (LLM runtime)

| Attribute | Type | Default | Description |
|-----------|------|---------|-------------|
| `brain` | model ID | from manifest | LLM model to use, e.g. `claude-opus-4-7`. Set to `none` to disable the brain entirely. |
| `instructions` | URL or inline text | from manifest | System prompt. Can be a URL ending in `.md` or an inline string. Overrides `manifest.brain.instructions`. |
| `api-key` | string | — | API key injected directly. **Development use only.** Prefer `key-proxy` for any page that will be public. |
| `key-proxy` | URL | — | URL of your backend that injects API keys into outbound LLM requests. |
| `thinking` | `auto` \| `always` \| `never` | `auto` | Extended thinking hint passed to the provider. |

### Voice

| Attribute | Type | Default | Description |
|-----------|------|---------|-------------|
| `voice` | boolean | on if manifest configures voice | Master on/off switch for speech I/O. |
| `tts` | provider ID | `browser` | Text-to-speech provider. Overrides the manifest. |
| `stt` | provider ID | `browser` | Speech-to-text provider. Overrides the manifest. |
| `mic` | `push-to-talk` \| `continuous` \| `off` | `push-to-talk` | Microphone activation policy. |

### Skills and memory

| Attribute | Type | Default | Description |
|-----------|------|---------|-------------|
| `skills` | comma-separated URIs | — | Additional skill URIs to install on top of (or instead of) manifest skills. |
| `skills-only` | boolean | off | When set, ignores manifest skills and uses only the `skills` attribute. |
| `skill-trust` | `any` \| `whitelist` \| `owned-only` | from manifest | Controls which skill URIs are allowed to install. `owned-only` allows only skills whose author matches the agent's `ownerAddress`. |
| `memory` | `local` \| `ipfs` \| `encrypted-ipfs` \| `none` | from manifest | Memory storage mode. |
| `memory-key` | string | agent ID or name | Namespace under which memory is persisted. Useful when embedding the same agent in multiple contexts. |

### Layout

| Attribute | Type | Default | Description |
|-----------|------|---------|-------------|
| `mode` | `inline` \| `floating` \| `section` \| `fullscreen` | `inline` | Layout mode. See [Display modes](#display-modes). |
| `position` | `bottom-right` \| `bottom-left` \| `top-right` \| `top-left` \| `bottom-center` | `bottom-right` | Corner anchor for `floating` mode. |
| `offset` | CSS length pair | `24px 24px` | Distance from the edge in floating mode (vertical horizontal). |
| `width` | CSS length | `100%` inline, `320px` floating | Element width. |
| `height` | CSS length | `480px` | Element height. |
| `responsive` | boolean | on | Applies `clamp()`-based shrinking on small viewports. Disable with `responsive="false"`. |

### On-chain identity

| Attribute | Type | Description |
|-----------|------|-------------|
| `chain` | `base` \| `base-sepolia` \| `ethereum` | Overrides the chain in `src="agent://…"`. |
| `chain-id` | number | Numeric chain ID, e.g. `8453`. Required when `agent-id` is a bare number. |
| `registry` | `0x` address | Override the deployed registry contract (for CAIP-10 precision). |

### Developer and display options

| Attribute | Description |
|-----------|-------------|
| `eager` | Boot immediately on DOM connection, bypassing the IntersectionObserver lazy-load. |
| `kiosk` | Hides all UI chrome: chat input, mic button, validator panel, editor links. Use for display contexts where end users should not interact. |
| `debug` | Overlays scene graph stats, tool-call log, and memory inspector in the shadow DOM. |
| `name-plate` | Controls the name overlay. Set to `"off"` to hide it. |

---

## JavaScript properties

Access these after the element is connected. Properties that depend on the runtime return `null` before `agent:ready` fires.

```js
const el = document.querySelector('agent-3d');

el.manifest   // The loaded agent manifest object
el.runtime    // The Runtime instance (LLM brain + tool loop)
el.memory     // The Memory instance
el.skills     // Array of installed Skill objects
```

**`el.manifest`** — The resolved manifest object as loaded from `manifest.json`, the on-chain registry, or constructed from `body`/`instructions` attributes. Available after `agent:ready`.

**`el.runtime`** — The `Runtime` instance that drives the LLM tool loop. Emits its own events (`brain:thinking`, `brain:message`, `voice:*`, `memory:write`) which are re-dispatched on the element.

**`el.memory`** — The `Memory` instance. Supports `read(key)`, `write(key, value)`, and `export()` for portability.

**`el.skills`** — Array of all currently installed `Skill` objects. Updated live as skills are installed or uninstalled.

---

## Methods

All methods are safe to call before `agent:ready` — those that need the runtime will wait internally.

---

### `say(text, opts?)`

Send a text turn to the agent's LLM brain. The agent processes the message, runs any tools, and may speak a reply.

```js
await el.say('Hello, what animations do you have?');
// With voice output enabled:
await el.say('Tell me about this product.', { voice: true });
```

| Parameter | Type | Description |
|-----------|------|-------------|
| `text` | string | The user message to send. |
| `opts.voice` | boolean | Force voice output for this turn, overriding the `voice` attribute. |

Returns a Promise that resolves when the agent's reply is complete.

---

### `ask(text, opts?)`

Convenience wrapper around `say()` that resolves to the agent's reply text as a string.

```js
const reply = await el.ask('What can you help me with?');
console.log(reply); // "I can walk you through the product..."
```

Returns `Promise<string>`.

---

### `wave(opts?)`

Plays the avatar's wave animation.

```js
await el.wave({ style: 'enthusiastic' });
```

---

### `lookAt(target)`

Points the avatar's gaze at a target.

```js
await el.lookAt('user');    // face the viewer
await el.lookAt('camera');  // face the camera directly
await el.lookAt('model');   // look at another element in the scene
```

---

### `play(name, opts?)`

Plays a named animation clip from the loaded GLB.

```js
await el.play('idle_wave');
await el.play('dance', { loop: true });
```

| Parameter | Type | Description |
|-----------|------|-------------|
| `name` | string | Clip name as it appears in the GLB's animation list. |
| `opts.loop` | boolean | Whether to loop the clip. |
| `opts.duration` | number | Override playback duration in seconds. |

---

### `speak(text, opts?)`

Triggers a speak animation on the avatar (lip-sync / talking gesture) without sending the text to the LLM. Use this to drive the avatar from your own logic.

```js
el.speak('Welcome to my portfolio!');
```

The method selects the best available talking animation (`talk` → `yes` → `wave` fallback) and plays it for a duration proportional to the word count of `text`.

---

### `clearConversation()`

Resets the LLM conversation history. Subsequent `say()` calls start a fresh context.

```js
el.clearConversation();
```

---

### `installSkill(uri)`

Dynamically installs a skill at runtime.

```js
await el.installSkill('ipfs://bafy…/dance/');
```

Returns a Promise that resolves to the installed `Skill` instance. Throws if the skill's author does not pass the current `skill-trust` policy.

---

### `uninstallSkill(name)`

Removes an installed skill by name.

```js
el.uninstallSkill('dance');
```

---

### `expressEmotion(trigger, weight?)`

Fires an emotion stimulus on the avatar's Empathy Layer. The emotion blends into the avatar's continuous facial state and decays naturally over time.

```js
el.expressEmotion('celebration', 0.9);
el.expressEmotion('concern');           // weight defaults to 0.7
```

| Parameter | Type | Description |
|-----------|------|-------------|
| `trigger` | string | Emotion name: `celebration`, `concern`, `curiosity`, `empathy`, `patience`. |
| `weight` | number | Intensity from 0 to 1. Defaults to `0.7`. Clamped to `[0, 1]`. |

Returns `true` if the element is mounted, `false` if it has not booted yet.

---

### `setMode(mode)`

Changes the layout mode at runtime. Equivalent to setting the `mode` attribute.

```js
el.setMode('floating');
el.setMode('fullscreen');
```

---

### `setPosition(position, offset?)`

Updates the floating anchor position.

```js
el.setPosition('bottom-left', '16px 16px');
```

---

### `setSize(width, height)`

Updates the element's width and height.

```js
el.setSize('400px', '520px');
```

---

### `pause()`

Suspends the runtime (LLM stream, mic, voice).

```js
el.pause();
```

---

### `destroy()`

Tears down the element completely: disposes the WebGL renderer, disconnects all observers, destroys the runtime. Use when removing the element from the DOM programmatically.

```js
el.destroy();
```

---

## Events

All events bubble and are `composed: true`, meaning they cross shadow DOM boundaries and are catchable on any ancestor element.

### Lifecycle events

| Event | Detail | When |
|-------|--------|------|
| `agent:ready` | `{ agent, manifest }` | Fully booted — manifest loaded, skills installed, brain connected. |
| `agent:load-progress` | `{ phase, pct }` | Incremental boot progress. `phase` is one of `"manifest"`, `"body"`, `"memory"`, `"skills"`, `"brain"`. `pct` is 0–1. |
| `agent:error` | `{ phase, error }` | A fatal error occurred during boot or at runtime. |

### Brain events

| Event | Detail | When |
|-------|--------|------|
| `brain:message` | `{ role, content }` | Each completed turn: `role` is `"user"` or `"assistant"`. |
| `brain:thinking` | `{ content }` | Streamed thinking tokens (only when extended thinking is enabled). |

### Voice events

| Event | Detail | When |
|-------|--------|------|
| `voice:speech-start` | `{ text }` | TTS playback begins. |
| `voice:speech-end` | `{}` | TTS playback ends. |
| `voice:listen-start` | `{}` | Microphone opens. |
| `voice:transcript` | `{ text, final }` | STT chunk received. `final: true` means the utterance is complete. |

### Skill events

| Event | Detail | When |
|-------|--------|------|
| `skill:loaded` | `{ name, uri }` | A skill was successfully installed during boot. |
| `skill:tool-called` | `{ tool, args, result }` | The LLM invoked a tool. `result` has shape `{ ok, ... }`. |

### Memory events

| Event | Detail | When |
|-------|--------|------|
| `memory:write` | `{ key, type }` | A memory entry was written. |

### Listening example

```js
const el = document.querySelector('agent-3d');

el.addEventListener('agent:ready', () => {
  console.log('Agent is live');
});

el.addEventListener('brain:message', (e) => {
  if (e.detail.role === 'assistant') {
    console.log('Agent said:', e.detail.content);
  }
});

el.addEventListener('skill:tool-called', (e) => {
  console.log(`Tool ${e.detail.tool} called with`, e.detail.args);
});

el.addEventListener('agent:error', (e) => {
  console.error('Boot failed at phase', e.detail.phase, e.detail.error);
});
```

---

## postMessage bridge (iframe embeds)

When `<agent-3d>` is hosted inside an `<iframe>`, the host page communicates with the embed using a structured postMessage protocol. All messages share a versioned envelope:

```json
{ "v": 1, "type": "<direction>.<category>", "id": "optional", "payload": {} }
```

- `v` is the protocol version integer (currently `1`).
- `type` uses `host.*` for host-to-embed messages and `embed.*` for embed-to-host messages.
- `id` is used to correlate request/response pairs.
- Messages missing `v` or `type` are malformed and silently discarded.

### Handshake

The embed sends `embed.ready` as soon as it boots. The host should send `host.hello` after the iframe's `load` event fires.

```
Host                          Embed (inside iframe)
 |                              |
 | <iframe src="…" loads>       |
 |                              | boots → sends embed.ready
 | ← embed.ready ────────────── |
 |                              |
 | ─── host.hello ────────────► |
```

**`embed.ready`** (embed → host):

```js
// Received by the host page:
window.addEventListener('message', (e) => {
  if (e.data.type === 'embed.ready') {
    const { agentId, version, capabilities } = e.data.payload;
    console.log('Agent ready:', agentId, version);
  }
});
```

**`host.hello`** (host → embed):

```js
iframe.contentWindow.postMessage({
  v: 1,
  type: 'host.hello',
  payload: {
    hostName: 'my-site.com',
    hostVersion: '1.0',
    hostOrigin: window.location.origin
  }
}, '*');
```

### Host → embed messages

| `type` | Payload | Description |
|--------|---------|-------------|
| `host.hello` | `{ hostName, hostVersion, hostOrigin, userId?, userName? }` | Initiates the handshake after iframe load. |
| `host.chat.message` | `{ role, text, messageId }` | Delivers a chat turn. `role` is `"user"` or `"assistant"`. |
| `host.action` | `{ action, args? }` | Triggers a named agent action. |
| `host.theme` | `{ mode }` | Updates visual theme. `mode` is `"dark"` or `"light"`. |
| `host.response` | `{ result? } or { error? }` | Reply to an `embed.request`, matched by `id`. |

**Sending a chat message:**

```js
iframe.contentWindow.postMessage({
  v: 1,
  type: 'host.chat.message',
  payload: {
    role: 'user',
    text: 'What can you help me with?',
    messageId: 'msg_001'
  }
}, '*');
```

**Triggering an action:**

```js
// Make the agent wave
iframe.contentWindow.postMessage({
  v: 1,
  type: 'host.action',
  payload: { action: 'emote.wave', args: {} }
}, '*');

// Make the agent speak
iframe.contentWindow.postMessage({
  v: 1,
  type: 'host.action',
  payload: { action: 'speak', args: { text: 'Welcome back!' } }
}, '*');
```

### Embed → host messages

| `type` | Payload | Description |
|--------|---------|-------------|
| `embed.ready` | `{ agentId, version, capabilities }` | Agent fully booted. |
| `embed.event` | `{ event, data? }` | Agent lifecycle event. Common events: `agent.speaking`, `agent.idle`, `agent.emote`, `agent.error`. |
| `embed.request` | `{ method, params? }` | Ask the host for data. Host replies with `host.response` matching `id`. |
| `embed.error` | `{ code, message }` | Protocol-level error (malformed message, unsupported action). |

**Listening for agent events:**

```js
window.addEventListener('message', (e) => {
  if (!e.data?.type?.startsWith('embed.')) return;

  switch (e.data.type) {
    case 'embed.ready':
      console.log('Agent capabilities:', e.data.payload.capabilities);
      break;
    case 'embed.event':
      if (e.data.payload.event === 'agent.speaking') {
        console.log('Agent said:', e.data.payload.data?.text);
      }
      break;
  }
});
```

### Security

- The embed validates `e.source === window.parent` before processing any message.
- The host should validate that `e.source` is the expected iframe's `contentWindow`.
- Neither side should `eval()` or `new Function()` message content.

---

## Display modes

All four modes run the same agent runtime — only the layout differs. Switch at any time with `el.setMode()` or by changing the `mode` attribute.

### `inline` (default)

Fills its container. Set dimensions via CSS on the element or via the `width`/`height` attributes.

```html
<agent-3d src="agent://base/42" style="width:100%;height:480px"></agent-3d>
```

When only `width` is set and `responsive` is on, the element automatically maintains a 3:4 portrait aspect ratio via CSS `aspect-ratio`.

### `floating`

Fixed-position bubble. Does not affect document flow. Defaults to the bottom-right corner.

```html
<agent-3d
  src="agent://base/42"
  mode="floating"
  position="bottom-right"
  offset="24px 24px"
  width="320px"
  height="420px"
></agent-3d>
```

On viewports narrower than 480 px (when `responsive` is on), the floating bubble automatically collapses to a 56 px pill. Tapping the pill expands it into a bottom-sheet. Swiping down or tapping outside collapses it again.

### `section`

Fills a parent container with aspect-ratio preservation. Suited for hero sections and feature rows.

```html
<section class="hero">
  <agent-3d src="agent://base/42" mode="section"></agent-3d>
</section>
```

### `fullscreen`

Takes over the full viewport (`position: fixed; inset: 0`).

```html
<agent-3d src="agent://base/42" mode="fullscreen"></agent-3d>
```

---

## Kiosk mode

The `kiosk` attribute strips all interactive chrome: the chat input, mic button, validator overlays, and editor entry points are all hidden. The 3D canvas fills the element. Use this for signage, product displays, and presentation contexts where end-user interaction is not desired.

```html
<agent-3d
  src="agent://base/42"
  kiosk
  auto-rotate
  style="width:100%;height:600px"
></agent-3d>
```

Kiosk mode is applied at element construction time. Toggling the `kiosk` attribute after boot has no effect on the existing shadow DOM — destroy and recreate the element if a runtime toggle is needed.

---

## CSS custom properties

Themeable properties are exposed on the `:host`. They apply to the chat surface, input row, and mic button.

```css
agent-3d {
  --agent-bubble-radius: 16px;     /* corner radius (floating mode) */
  --agent-accent: #3b82f6;         /* button + focus color */
  --agent-surface: rgba(17, 24, 39, 0.92);  /* chat/input background */
  --agent-on-surface: #f9fafb;     /* chat text color */
  --agent-chat-font: system-ui, -apple-system, sans-serif;
  --agent-mic-glow: #22c55e;       /* mic button active glow */
  --agent-shadow: 0 20px 60px rgba(0,0,0,0.3);  /* floating mode shadow */
}
```

The host page's stylesheet cannot leak into the shadow DOM beyond these properties.

---

## Shadow DOM slots

Content placed inside `<agent-3d>` is rendered as a fallback when JavaScript is disabled or the script fails to load.

```html
<agent-3d src="agent://base/42">
  <!-- Shown if JS is blocked or unavailable -->
  <img src="./leo-poster.webp" alt="Coach Leo (requires JavaScript)" />
</agent-3d>
```

The element also accepts named slots:

| Slot | Purpose |
|------|---------|
| `poster` | Shown during load; fades out when the model is ready. |
| `error` | Shown if loading fails. Replaces the default error overlay. |
| `ar-button` | Custom AR launch button (same pattern as `<model-viewer>`). |
| `chat` | Full chat UI override — host your own chat surface and subscribe to events. |

---

## CSP and sandboxing

`<agent-3d>` is compatible with strict Content Security Policies:

- No inline `<script>` tags are injected into the host page.
- No `eval()` or `new Function()`.
- External resources (GLB, HDRI, manifests) are loaded only from URLs you provide in attributes.
- WASM decoders (DRACO, KTX2) are fetched from configurable CDN paths; a self-hosted mode is supported.
- LLM API calls route through `key-proxy` when set — no API keys in client-side markup.

When embedding in a sandboxed `<iframe>`, include at minimum:

```html
<iframe
  src="https://three.ws/a/8453/42/embed"
  sandbox="allow-scripts allow-same-origin"
></iframe>
```

`allow-same-origin` is required for WebGL context creation. `allow-scripts` is required for the element to run at all.

---

## Framework integration

`<agent-3d>` is a standard custom element and works in any framework that renders HTML.

### React

TypeScript users need to declare the element type to suppress JSX warnings.

```tsx
// Declare once, e.g. in global.d.ts
declare namespace JSX {
  interface IntrinsicElements {
    'agent-3d': React.DetailedHTMLProps<React.HTMLAttributes<HTMLElement>, HTMLElement> & {
      src?: string;
      'body'?: string;
      'agent-id'?: string;
      'chain-id'?: string;
      mode?: string;
      brain?: string;
      kiosk?: boolean;
      eager?: boolean;
    };
  }
}

// Usage
import '@three-ws/sdk';

function AgentCard() {
  return (
    <agent-3d
      src="agent://base/42"
      style={{ width: '400px', height: '500px' }}
    />
  );
}
```

Attach event listeners via `useEffect` and a `ref`:

```tsx
import { useEffect, useRef } from 'react';

function AgentCard() {
  const ref = useRef<HTMLElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const handler = (e: Event) => {
      const ce = e as CustomEvent;
      console.log('Agent said:', ce.detail.content);
    };
    el.addEventListener('brain:message', handler);
    return () => el.removeEventListener('brain:message', handler);
  }, []);

  return <agent-3d ref={ref} src="agent://base/42" style={{ width: '400px', height: '500px' }} />;
}
```

### Vue 3

Tell the Vue compiler that `agent-3d` is a custom element so it does not try to resolve it as a Vue component.

```js
// vite.config.js
import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

export default defineConfig({
  plugins: [
    vue({
      template: {
        compilerOptions: {
          isCustomElement: (tag) => tag === 'agent-3d'
        }
      }
    })
  ]
});
```

```vue
<template>
  <agent-3d
    src="agent://base/42"
    style="width: 400px; height: 500px"
    @agent:ready="onReady"
  />
</template>

<script setup>
import '@three-ws/sdk';

function onReady(e) {
  console.log('ready', e.detail.manifest.name);
}
</script>
```

### Svelte

Svelte handles custom elements natively. No configuration needed.

```svelte
<script>
  import '@three-ws/sdk';
  let el;

  function onReady(e) {
    console.log('ready', e.detail.manifest.name);
  }
</script>

<agent-3d
  bind:this={el}
  src="agent://base/42"
  style="width:400px;height:500px"
  on:agent:ready={onReady}
/>
```

### Vanilla JS (ESM)

```js
import 'https://three.ws/agent-3d/1.5.1/agent-3d.js';

const el = document.querySelector('agent-3d');
el.addEventListener('agent:ready', async () => {
  const reply = await el.ask('Hello!');
  console.log(reply);
});
```

### UMD (no ES modules)

```html
<script src="https://three.ws/agent-3d/1.5.1/agent-3d.umd.cjs"></script>
```

---

## Multi-agent scenes (`<agent-stage>`)

To render multiple agents in a single WebGL context, wrap `<agent-3d>` elements in `<agent-stage>`. Each agent keeps its own brain, memory, and voice pipeline; the stage manages shared renderer resources.

```html
<agent-stage formation="row" style="width:100%;height:540px">
  <agent-3d
    id="leo"
    name="Coach Leo"
    body="/avatars/leo.glb"
    instructions="You are Coach Leo."
    eager
  ></agent-3d>
  <agent-3d
    id="mira"
    name="Mira"
    body="/avatars/mira.glb"
    brain="none"
    eager
  ></agent-3d>
</agent-stage>
```

```js
const stage = document.querySelector('agent-stage');

stage.addEventListener('stage:agent-joined', (e) => console.log('joined:', e.detail.agentId));
stage.addEventListener('stage:message', (e) => console.log('msg:', e.detail));

// Broadcast a protocol event to all agents in the stage
stage.broadcast('narrator', { kind: 'cue', text: 'Action!' });
```

---

## Resource usage

- **Lazy mount** — the element does nothing until it intersects the viewport. Add `eager` to override.
- **Pause off-screen** — the RAF render loop pauses when the element is fully off-screen and resumes on re-entry.
- **Tab visibility** — mic and LLM streaming suspend when the tab is hidden; the scene render loop pauses.
- **Single WebGL context** — the framework enforces one renderer per element. `<agent-stage>` shares one context across all its agents.

---

## CDN versioning

Three URL channels are available. Pick based on how strictly you need to control updates.

| Path | Cache | Use when |
|------|-------|----------|
| `/agent-3d/<MAJOR>.<MINOR>.<PATCH>/agent-3d.js` | `immutable` | **Production.** Pin exact bytes. Combine with SRI. |
| `/agent-3d/<MAJOR>.<MINOR>/agent-3d.js` | 5 min | Follow patch releases automatically. |
| `/agent-3d/<MAJOR>/agent-3d.js` | 5 min | Follow minor + patch releases. |
| `/agent-3d/latest/agent-3d.js` | 5 min | Demos and prototypes only. Never in production. |

Current SRI hashes are at `/agent-3d/<version>/integrity.json`. The full release manifest is at `/agent-3d/versions.json`.

**Recommended production snippet:**

```html
<script
  type="module"
  src="https://three.ws/agent-3d/1.5.1/agent-3d.js"
  integrity="sha384-…"
  crossorigin="anonymous"
></script>
```

---

## Custom tag name

If you need to ship the element under your own brand name, call `defineElement` with a custom tag:

```js
import { defineElement } from 'https://three.ws/agent-3d/1.5.1/agent-3d.js';

defineElement('my-agent');
// <my-agent src="agent://base/42"></my-agent>
```

`defineElement` is a no-op if the tag is already registered.

---

## Browser compatibility

- Chrome, Edge, Firefox, Safari — modern evergreen versions with WebGL 2 support.
- No framework dependency — works in React, Vue, Svelte, Angular, plain HTML, WordPress, Webflow, Framer, Notion embeds, and Shopify.
- iOS Safari — WebXR is not supported. AR falls back to Quick Look (USDZ).
- Browsers without `IntersectionObserver` (very old) boot immediately rather than lazily.
- Browsers without `SpeechRecognition` (`window.SpeechRecognition || window.webkitSpeechRecognition`) — mic/STT silently no-ops. Voice output (TTS) still works.
