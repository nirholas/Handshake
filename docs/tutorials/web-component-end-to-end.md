# Use the &lt;agent-3d&gt; web component end-to-end

The iframe snippet is convenient. Paste it, agent on the page. But once your site has a component system — React, Vue, Svelte, a design system — that opaque iframe starts to feel like a stranger in the codebase. You want the agent to be a real component, with props, refs, lifecycle, and a place in your component library.

That's what `<agent-3d>` is for. It's a standards-based custom element that drops cleanly into any framework, exposes the full JavaScript API (methods, events, live attributes), and supports reactive attribute changes — you can swap the loaded agent at runtime by changing one prop.

By the end of this tutorial you'll know the spec well enough to pick the right embed style for any project, wire the element into React and Vue with refs and reactivity, slot your own UI alongside the avatar, and react to attribute changes after mount.

**What you'll build:**
- A standalone `<agent-3d>` tag with the full attribute surface
- A React `<Agent3D>` wrapper that exposes events as props
- A Vue 3 wrapper using the Composition API
- A reactive `agent-id` swap that re-mounts the agent without reloading the page
- A slotted layout where your chat input lives next to the avatar
- A short web-components primer if you've never built a custom element

**Prerequisites:** Familiarity with React (hooks, refs) or Vue 3 (Composition API). You don't need prior experience with the Custom Elements spec — Step 1 covers the basics.

---

## Step 1 — A 60-second web components primer

If you already know custom elements, skip to Step 2. Otherwise, here's the part of the spec that matters for using `<agent-3d>`.

A custom element is a tag your browser doesn't ship by default. Someone (us, in this case) registers a JavaScript class against a name, and from that point on the tag works exactly like any built-in element. You can put `<agent-3d>` in HTML, in JSX, in a Vue template — anywhere a `<div>` would go.

Three things make custom elements powerful:

1. **Attributes are the API.** Like `<input type="text">`, you configure the element with HTML attributes. The element watches the ones it cares about (via `observedAttributes`) and reacts when they change.
2. **Methods and properties.** Once you have an element reference, you can call methods on it (`el.say('hi')`) and read/set properties just like any DOM node.
3. **Events.** The element dispatches custom events you subscribe to with `addEventListener`. These bubble out of the shadow DOM so framework event handlers can pick them up.

`<agent-3d>` uses all three. It's registered to the global `customElements` registry the moment the runtime script loads:

```html
<script type="module" src="https://three.ws/agent-3d/1.5.2/agent-3d.js"></script>
```

From that point on, `<agent-3d>` is a real tag in the document. No further setup needed.

---

## Step 2 — iframe embed vs the custom element

The platform offers two embed styles for the same agent. The differences are ergonomic.

**iframe form** — sandboxed, self-contained, no script tag on your page:

```html
<iframe
  src="https://three.ws/a/8453/42/embed"
  width="320"
  height="420"
  frameborder="0"
  allow="microphone"
  style="border-radius: 16px;"
></iframe>
```

The agent runs entirely inside the iframe. You can't call methods on it or listen to its events from your page — the trade for that isolation is zero integration surface.

This is the right embed when:

- You're on a no-code platform (Webflow, Squarespace, Notion, Substack) where you can paste a snippet but not control the `<head>`
- You want strict sandboxing between the agent and your page
- You don't need to drive the agent from your own JavaScript

**Custom element form** — explicit, structured, framework-friendly:

```html
<script type="module" src="https://three.ws/agent-3d/1.5.2/agent-3d.js"></script>

<agent-3d
  agent-id="YOUR_AGENT_ID"
  width="360px"
  height="480px"
  position="bottom-right"
  background="transparent"
></agent-3d>
```

You separate "load the runtime" from "place the agent". The agent can appear anywhere in your tree, with explicit attributes you can read from a build system, type-check, or template — and you get the full JS API: `say()`, `ask()`, `wave()`, `play()`, and the event stream.

This is the right embed when:

- You're inside a framework with a component tree (React, Vue, Angular, Svelte)
- You want multiple agents on the same page
- You need to call the agent's methods or subscribe to its events

The rest of this tutorial uses the custom-element form, because that's the one that benefits from a wrapper. (The [embedding guide](./embed-on-website.md) covers the iframe path and the no-code platforms in depth.)

---

## Step 3 — The full attribute surface

Here's the full list of attributes the element observes, in the categories you'll actually reach for.

**Identity (one of these is required):**

| Attribute | What it does |
|---|---|
| `agent-id` | The platform-hosted agent ID. Resolves the manifest from three.ws. |
| `manifest` | URL to a JSON manifest file. Use this for self-hosted agents. |
| `body` | Direct URL to a GLB model. Bypasses the manifest path entirely — useful for quick tests. |
| `src` | Legacy alias for `manifest`. Prefer `manifest` for new code. |

**Layout:**

| Attribute | Values | Default |
|---|---|---|
| `mode` | `inline`, `floating`, `section`, `fullscreen` | `inline` |
| `position` | `bottom-right`, `bottom-left`, `top-right`, `top-left` | `bottom-right` |
| `width` | Any CSS length (`360px`, `100%`, `40vw`) | auto |
| `height` | Any CSS length | auto |
| `background` | `transparent`, `dark`, `light` | `transparent` |
| `responsive` | `true` / `false` | `true` |

**Behaviour:**

| Attribute | What it does |
|---|---|
| `name` | The agent's display name in the nameplate |
| `voice` | Set to `livekit` to opt into LiveKit-backed real-time voice |
| `avatar-chat` | Set to `off` to hide the built-in chat input |
| `avatar-walk` | Set to `off` to disable the walk-when-talking behaviour |
| `framing` | Set to `portrait` for a head-and-shoulders camera framing; the default frames the full body |
| `eager` | Skip the lazy-load wait — boot immediately even when off-screen |
| `api-key` | Override the brain API key (use sparingly; backends are safer) |
| `key-proxy` | URL of your own proxy that vends scoped keys |

Every observed attribute can be changed after mount. Step 6 shows what that looks like in practice.

---

## Step 4 — A reusable React wrapper

React doesn't know about custom elements out of the box. The DOM does — React just passes attributes and children through. That means most things "just work", with two exceptions:

1. **Booleans:** React converts `eager={true}` into the string `"true"`, which is *not* the same as the bare `eager` attribute. Use `eager=""` or omit the attribute entirely.
2. **Events:** React's `onSomething` props only work for events the framework knows about. Custom events need an `addEventListener` in a `useEffect`.

Here's a clean wrapper:

```jsx
// src/Agent3D.jsx
'use client'; // for Next.js app router

import { useEffect, useRef } from 'react';

// Load the runtime once, when this module is first imported.
let loadPromise = null;
function ensureRuntime() {
  if (typeof window === 'undefined') return Promise.resolve();
  if (loadPromise) return loadPromise;
  loadPromise = new Promise((resolve, reject) => {
    const existing = document.querySelector('script[data-agent-3d-runtime]');
    if (existing) { resolve(); return; }
    const s = document.createElement('script');
    s.type = 'module';
    s.src = 'https://three.ws/agent-3d/1.5.2/agent-3d.js';
    s.dataset.agent3dRuntime = '';
    s.onload = resolve;
    s.onerror = reject;
    document.head.appendChild(s);
  });
  return loadPromise;
}

export default function Agent3D({
  agentId,
  width = '360px',
  height = '480px',
  position = 'bottom-right',
  background = 'transparent',
  mode = 'inline',
  name,
  onReady,
  onMessage,
  onSpeechStart,
  onSpeechEnd,
}) {
  const ref = useRef(null);

  useEffect(() => {
    let cancelled = false;
    ensureRuntime().then(() => {
      if (cancelled || !ref.current) return;
      // Element is in the DOM; events can be bound.
    });

    const el = ref.current;
    if (!el) return;

    const handlers = [];
    function bind(eventName, fn) {
      if (!fn) return;
      el.addEventListener(eventName, fn);
      handlers.push([eventName, fn]);
    }
    bind('agent:ready', onReady);
    bind('brain:message', onMessage);
    bind('voice:speech-start', onSpeechStart);
    bind('voice:speech-end', onSpeechEnd);

    return () => {
      cancelled = true;
      for (const [n, fn] of handlers) el.removeEventListener(n, fn);
    };
  }, [onReady, onMessage, onSpeechStart, onSpeechEnd]);

  return (
    <agent-3d
      ref={ref}
      agent-id={agentId}
      width={width}
      height={height}
      mode={mode}
      position={position}
      background={background}
      name={name}
    />
  );
}
```

And the usage:

```jsx
import Agent3D from './Agent3D';

export default function Page() {
  return (
    <div>
      <h1>Talk to Aria</h1>
      <Agent3D
        agentId="YOUR_AGENT_ID"
        width="400px"
        height="520px"
        onReady={(e) => console.log('booted', e.detail.manifest?.name)}
        onMessage={(e) => {
          if (e.detail.role === 'assistant') console.log('agent:', e.detail.content);
        }}
      />
    </div>
  );
}
```

A few notes on what the wrapper does:

- **Runtime loaded once.** `ensureRuntime()` guards against re-injecting the script on every mount. It checks for an existing tag with `data-agent-3d-runtime` and resolves immediately if found.
- **Events bound in `useEffect`.** Custom event names map to props (`onReady`, `onMessage`). The cleanup function unbinds them, so the wrapper plays nicely with strict mode and unmount.
- **No camelCase attribute names.** Custom elements use dash-case (`agent-id`, not `agentId`). React passes attributes through as-is — `agent-id` is fine in JSX.
- **`useRef` is the API handle.** If you need to call `ref.current.say('hi')` from a parent, expose the ref via `forwardRef` or pass an `apiRef` prop in.

For TypeScript, drop this in a `.d.ts`:

```ts
declare namespace JSX {
  interface IntrinsicElements {
    'agent-3d': React.DetailedHTMLProps<
      React.HTMLAttributes<HTMLElement>,
      HTMLElement
    > & {
      'agent-id'?: string;
      manifest?: string;
      body?: string;
      mode?: 'inline' | 'floating' | 'section' | 'fullscreen';
      position?: string;
      width?: string;
      height?: string;
      background?: 'transparent' | 'dark' | 'light';
      eager?: string;
    };
  }
}
```

---

## Step 5 — A Vue 3 wrapper

Vue handles custom elements gracefully provided you flag them as such. Add `agent-3d` to the compiler's custom-element list in your build config:

```js
// vite.config.js
import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

export default defineConfig({
  plugins: [
    vue({
      template: {
        compilerOptions: {
          isCustomElement: (tag) => tag === 'agent-3d',
        },
      },
    }),
  ],
});
```

Without this flag, Vue warns "Failed to resolve component" because it tries to treat `<agent-3d>` as a Vue component.

The wrapper itself:

```vue
<!-- src/components/Agent3D.vue -->
<script setup>
import { onMounted, onBeforeUnmount, ref } from 'vue';

const props = defineProps({
  agentId: { type: String, required: true },
  width:   { type: String, default: '360px' },
  height:  { type: String, default: '480px' },
  mode:    { type: String, default: 'inline' },
  position:{ type: String, default: 'bottom-right' },
  background: { type: String, default: 'transparent' },
});

const emit = defineEmits(['ready', 'message', 'speech-start', 'speech-end']);
const root = ref(null);

const eventMap = [
  ['agent:ready', 'ready'],
  ['brain:message', 'message'],
  ['voice:speech-start', 'speech-start'],
  ['voice:speech-end', 'speech-end'],
];

const handlers = [];

onMounted(async () => {
  await import('https://three.ws/agent-3d/1.5.2/agent-3d.js');
  const el = root.value;
  if (!el) return;
  for (const [domEvent, vueEvent] of eventMap) {
    const fn = (e) => emit(vueEvent, e.detail, e);
    el.addEventListener(domEvent, fn);
    handlers.push([domEvent, fn]);
  }
});

onBeforeUnmount(() => {
  const el = root.value;
  if (!el) return;
  for (const [name, fn] of handlers) el.removeEventListener(name, fn);
});

defineExpose({
  // Forward common methods so the parent can call them via template refs.
  say: (text) => root.value?.say(text),
  ask: (text) => root.value?.ask(text),
  wave: () => root.value?.wave(),
  playAnimation: (name, opts) => root.value?.play(name, opts),
});
</script>

<template>
  <agent-3d
    ref="root"
    :agent-id="agentId"
    :width="width"
    :height="height"
    :mode="mode"
    :position="position"
    :background="background"
  />
</template>
```

Usage in a parent component:

```vue
<script setup>
import { ref } from 'vue';
import Agent3D from './components/Agent3D.vue';

const agent = ref(null);

function onReady(detail) {
  console.log('Agent ready:', detail.manifest?.name);
  agent.value.say('Greet the visitor with a one-sentence welcome.');
}

function onMessage(detail) {
  if (detail.role === 'assistant') console.log('Agent:', detail.content);
}
</script>

<template>
  <Agent3D
    ref="agent"
    agent-id="YOUR_AGENT_ID"
    width="400px"
    height="520px"
    @ready="onReady"
    @message="onMessage"
  />
</template>
```

The `defineExpose` block matters: without it, the parent's `agent.value.say(...)` would be undefined. Vue 3 SFCs are private by default, and you have to opt methods into the public surface.

---

## Step 6 — Reactive attribute changes

This is the moment when the custom-element approach really pays off. The element observes its key attributes, so changing one re-runs the relevant boot logic.

Want to swap which agent is loaded based on a user setting? Change `agent-id`:

```jsx
const [activeAgent, setActiveAgent] = useState('agent_a');

return (
  <>
    <select onChange={(e) => setActiveAgent(e.target.value)}>
      <option value="agent_a">Sales bot</option>
      <option value="agent_b">Support bot</option>
      <option value="agent_c">Onboarding bot</option>
    </select>
    <Agent3D agentId={activeAgent} />
  </>
);
```

React passes the new `agent-id` to the DOM. The element sees the change in `attributeChangedCallback`, tears down the current agent, and re-boots with the new ID. No page reload, no remount of your wrapper.

The same trick works for `body`, `manifest`, `src`, and the layout attributes (`mode`, `position`, `width`, `height`, `background`). Each of those is in the element's `observedAttributes` list. Changing `mode="inline"` → `mode="floating"` at runtime re-applies the layout cleanly without re-downloading the GLB.

There are a few attributes worth treating carefully:

- `eager` — only matters at first mount; toggling it after boot has no effect since boot already happened.
- `api-key` — changing this mid-session won't re-issue in-flight LLM calls. Treat it as set-once for any given agent instance.
- `tracked-mint` — changing this swaps the on-chain trade feed the agent is reacting to. Useful for token-aware widgets.

If you need a *full* fresh re-mount (rare — usually the in-place swap is what you want), key the element on the agent ID:

```jsx
<Agent3D key={activeAgent} agentId={activeAgent} />
```

The `key` prop forces React to unmount and remount the wrapper, which fully tears down the old element.

---

## Step 7 — Slotting your own UI

The element has a built-in chat input at the bottom. That's fine for a drop-in widget. For an integrated product page, you usually want your own input — styled to match your design system, sharing the page layout, with custom send buttons.

Two parts to this.

**Hide the built-in UI** with `avatar-chat="off"`:

```html
<agent-3d
  id="agent"
  agent-id="YOUR_AGENT_ID"
  avatar-chat="off"
  width="100%"
  height="100%"
></agent-3d>
```

**Wire your own UI** that calls the element's API:

```html
<div class="agent-shell">
  <div class="canvas">
    <agent-3d id="agent" agent-id="YOUR_AGENT_ID" avatar-chat="off"></agent-3d>
  </div>
  <div class="composer">
    <input id="message" placeholder="Ask me anything" />
    <button id="send">Send</button>
  </div>
</div>

<style>
  .agent-shell { display: grid; grid-template-rows: 1fr auto; height: 600px; }
  .canvas      { position: relative; }
  agent-3d     { position: absolute; inset: 0; }
  .composer    { display: flex; gap: 8px; padding: 12px; border-top: 1px solid #2a2a2a; }
  #message     { flex: 1; padding: 10px 14px; border-radius: 24px; border: 1px solid #2a2a2a; background: #111; color: #f5f5f5; }
  #send        { padding: 10px 18px; border-radius: 24px; background: #6366f1; color: white; border: none; cursor: pointer; }
</style>

<script type="module">
  const agent = document.getElementById('agent');
  const input = document.getElementById('message');
  const send  = document.getElementById('send');

  async function dispatch() {
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    try {
      await agent.ask(text);
    } catch (err) {
      console.error('Agent failed:', err);
    }
  }

  send.addEventListener('click', dispatch);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') dispatch(); });

  // Mirror assistant replies into a chat log if you have one.
  agent.addEventListener('brain:message', (e) => {
    if (e.detail.role === 'assistant') console.log('assistant:', e.detail.content);
  });
</script>
```

That's the bare minimum. In a real product page you would also add a chat-log element, a "thinking" indicator that toggles on `brain:thinking`, and a transcript field that fills in on `voice:transcript`.

Two cautions when going custom-UI:

- **Don't try to inject DOM into the agent's shadow root.** The element uses Shadow DOM (`mode: 'open'`) — you *can* technically reach into it, but anything in there is internal and will change between versions. Build your UI *around* the agent, not *inside* it.
- **Style the wrapper, not the internals.** CSS rules on `<agent-3d>` itself (width, height, position) work fine. CSS rules targeting its shadow children won't survive a minor version bump.

---

## Step 8 — A complete example, top to bottom

Here's a single-file working example you can drop into any Vite or Next.js app. It's the full pattern from Steps 4 and 6 combined — a wrapper, a reactive agent swap, and event handling.

```jsx
// pages/agents.jsx (Next.js) or src/Agents.jsx (Vite)
import { useState, useRef } from 'react';
import Agent3D from './Agent3D';

const AGENTS = [
  { id: 'agent_sales',    label: 'Sales' },
  { id: 'agent_support',  label: 'Support' },
  { id: 'agent_concierge', label: 'Concierge' },
];

export default function AgentsPage() {
  const [active, setActive] = useState(AGENTS[0].id);
  const [log, setLog] = useState([]);
  const apiRef = useRef(null);

  function append(line) { setLog((prev) => [...prev.slice(-40), line]); }

  return (
    <main style={{ padding: 32, color: '#f5f5f5', background: '#0a0a0a', minHeight: '100vh' }}>
      <h1>Switch agents on the fly</h1>

      <select value={active} onChange={(e) => setActive(e.target.value)}>
        {AGENTS.map((a) => (<option key={a.id} value={a.id}>{a.label}</option>))}
      </select>

      <div style={{ display: 'flex', gap: 24, marginTop: 24 }}>
        <Agent3D
          agentId={active}
          width="360px"
          height="480px"
          onReady={(e)   => append(`ready: ${e.detail.manifest?.name || active}`)}
          onMessage={(e) => {
            if (e.detail.role === 'assistant') append(`agent: ${e.detail.content}`);
          }}
          onSpeechEnd={() => append('(spoken)')}
        />
        <pre style={{ background: '#111', padding: 12, minWidth: 320, maxHeight: 480, overflow: 'auto' }}>
          {log.join('\n')}
        </pre>
      </div>
    </main>
  );
}
```

Pick an agent from the dropdown, the active one swaps in place, and the event log fills up as the brain talks back. That's the whole loop.

---

## What you learned

You can now treat `<agent-3d>` as a real component in any framework. The big takeaways:

- The iframe and custom-element embeds serve different jobs — sandboxed drop-in vs a full-API component; reach for the element whenever your own code needs to drive the agent
- Attribute changes are reactive; you can swap agents, modes, and layouts at runtime
- React works fine once you bind events in `useEffect`; remember dash-case attribute names
- Vue works fine once you flag the tag as a custom element in the compiler config
- Use `avatar-chat="off"` to bring your own composer when you want full control
- Don't reach into the shadow DOM; style the wrapper, not the internals

The web component is the most robust integration point the platform offers. Build your design system around it once and the agent fits anywhere you ship.

## Next steps

- [Drive the agent with the JavaScript API](/tutorials/js-api-events) — methods and events covered in depth
- [Embed a three.ws agent on your website](./embed-on-website.md) — the no-framework paths (Webflow, WordPress, Squarespace) for completeness
- [Trigger the agent from page events](/tutorials/trigger-from-page-events) — once it's mounted, make it react to the user journey
