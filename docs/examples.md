# Examples Gallery

Copy-paste ready code for common three.ws use cases. Each example runs as-is: swap your own model URL and go.

> **Want to run these without cloning anything?** [three.ws/examples](https://three.ws/examples) renders the same core snippets with a **Run** button on each one: the code executes in a sandboxed frame on the page, against the production CDN bundle. This document is the deeper written companion, and it also indexes every runnable file in [`examples/`](../examples/).

---

## 1. Minimal embed

The absolute simplest setup: one script tag, one custom element.

**Demonstrates:** loading `<agent-3d>`, inline display, no-build workflow.

**[View source →](https://github.com/nirholas/three.ws/blob/main/examples/minimal.html)**, run it with `npm run dev`, then open `http://localhost:3000/examples/minimal.html`.

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>3D Viewer</title>
  <style>
    body { margin: 0; background: #fafafa; font-family: system-ui, sans-serif; }
    main { max-width: 720px; margin: 0 auto; padding: 64px 32px; }
    agent-3d { display: block; width: 100%; height: 320px; }
  </style>
</head>
<body>
  <main>
    <h1>Hello</h1>
    <p>The agent below is embedded inline: no build step, no framework.</p>

    <agent-3d
      body="https://three.ws/avatars/cz.glb"
      instructions="You are a friendly 3D guide."
      brain="claude-opus-4-7"
      width="100%"
      height="320px"
    ></agent-3d>
  </main>

  <script type="module" src="https://three.ws/agent-3d/latest/agent-3d.js"></script>
</body>
</html>
```

**What to change:**
- Replace `body=` with your own `.glb` URL
- Remove `brain=` to disable the AI layer (model viewer only)
- Add `mode="floating" position="bottom-right"` for a chatbot bubble in the corner

---

## 2. Floating bubble

A pinned chatbot bubble that stays fixed in the viewport corner, like a support widget, but embodied.

**Demonstrates:** `mode="floating"`, positional placement, inline instructions.

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>My Page</title>
  <style>
    body { margin: 0; font-family: system-ui, sans-serif; padding: 64px; }
  </style>
</head>
<body>
  <h1>My page content</h1>
  <p>The agent floats in the bottom-right corner. Scroll and it stays put.</p>

  <!-- Floating bubble: fixed, bottom-right -->
  <agent-3d
    body="https://three.ws/avatars/cz.glb"
    instructions="You are a cheerful greeter. Wave when users say hi."
    mode="floating"
    position="bottom-right"
    width="320px"
    height="420px"
    brain="claude-opus-4-7"
  ></agent-3d>

  <script type="module" src="https://three.ws/agent-3d/latest/agent-3d.js"></script>
</body>
</html>
```

**What to change:**
- `position`: `bottom-right`, `bottom-left`, `top-right`, or `top-left`
- `width` / `height`: size of the bubble when expanded
- Add `name-plate` attribute to show the agent's name below the viewer

---

## 3. Agent with a chat UI

A full AI-powered agent with a text input. The agent reads your messages, reasons, and responds using its configured model.

**Demonstrates:** `brain=` attribute, `say()` JS API, keyboard submit.

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Chat with Aria</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background: #0d0d1a;
      font-family: system-ui, sans-serif;
      color: white;
      height: 100vh;
      display: grid;
      grid-template-rows: 1fr auto;
    }
    agent-3d { display: block; width: 100%; height: 100%; }
    .chat {
      padding: 16px;
      border-top: 1px solid #222;
      display: flex;
      gap: 8px;
    }
    input {
      flex: 1;
      padding: 10px 14px;
      background: #1a1a2e;
      border: 1px solid #333;
      border-radius: 8px;
      color: white;
      font-size: 15px;
    }
    button {
      padding: 10px 20px;
      background: #6366f1;
      border: none;
      border-radius: 8px;
      color: white;
      cursor: pointer;
      font-size: 15px;
    }
  </style>
</head>
<body>
  <agent-3d
    id="aria"
    body="https://three.ws/avatars/michelle.glb"
    name="Aria"
    instructions="You are Aria, a friendly AI assistant. Be helpful and concise."
    brain="claude-opus-4-7"
  ></agent-3d>

  <div class="chat">
    <input id="input" type="text" placeholder="Ask Aria something..." autofocus>
    <button id="send">Send</button>
  </div>

  <script type="module">
    import 'https://three.ws/agent-3d/latest/agent-3d.js';

    const aria = document.getElementById('aria');
    const input = document.getElementById('input');

    document.getElementById('send').addEventListener('click', send);
    input.addEventListener('keypress', e => { if (e.key === 'Enter') send(); });

    function send() {
      const msg = input.value.trim();
      if (!msg) return;
      input.value = '';
      aria.say(msg);  // sends text → agent brain → response
    }
  </script>
</body>
</html>
```

**What to change:**
- Replace `instructions=` with your agent's personality and domain knowledge
- Replace `body=` with your avatar GLB
- Add `voice` attribute to enable speech input/output

---

## 4. Two agents on a shared stage

Two agents sharing a single WebGL canvas via `<agent-stage>`. Each keeps its own brain, memory, and conversation. Click "Send to Leo" to message one agent; click "Broadcast" to send to all.

**Demonstrates:** `<agent-stage>`, multi-agent formation, `stage.broadcast()`, `leo.say()`, event logging.

**[View source →](https://github.com/nirholas/three.ws/blob/main/examples/two-agents.html)**, run it with `npm run dev`, then open `http://localhost:3000/examples/two-agents.html`.

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Two agents, one canvas</title>
  <style>
    body { margin: 0; background: #0f0f0f; color: #e9e9e9; font-family: system-ui, sans-serif; padding: 24px; }
    agent-stage { display: block; width: 100%; height: 540px; background: #1a1a1a; border-radius: 8px; }
    .row { display: flex; gap: 8px; margin-top: 16px; }
    .row input { flex: 1; padding: 10px 14px; border-radius: 999px; border: 1px solid #333; background: #111; color: #eee; font: 14px system-ui; }
    .row button { padding: 10px 18px; border-radius: 999px; border: 0; background: #3b82f6; color: white; cursor: pointer; font: 14px system-ui; }
    .log { font: 12px/1.5 ui-monospace, monospace; color: #8fd4a4; background: #111; border-radius: 6px; padding: 12px; margin-top: 16px; max-height: 180px; overflow-y: auto; }
  </style>
</head>
<body>
  <!--
    agent-stage hosts both agents in one WebGL context.
    formation="row" places them side by side.
  -->
  <agent-stage id="stage" formation="row">
    <agent-3d
      id="leo"
      name="Coach Leo"
      body="https://three.ws/avatars/cz.glb"
      instructions="You are Coach Leo. Friendly, short answers. When another agent says hi, wave and greet them back by name."
      brain="claude-opus-4-7"
      eager
    ></agent-3d>
    <agent-3d
      id="mira"
      name="Mira"
      body="https://three.ws/avatars/cz.glb"
      instructions="You are Mira, a quiet observer who only speaks when spoken to."
      brain="claude-opus-4-7"
      eager
    ></agent-3d>
  </agent-stage>

  <div class="row">
    <input id="prompt" value="Say hi to Mira and ask her how she's doing." placeholder="Message for Leo...">
    <button id="send">Send to Leo</button>
    <button id="broadcast">Broadcast</button>
  </div>
  <div class="log" id="log"></div>

  <script type="module">
    import 'https://three.ws/agent-3d/latest/agent-3d.js';

    const log = document.getElementById('log');
    const stage = document.getElementById('stage');
    const leo = document.getElementById('leo');
    const mira = document.getElementById('mira');

    const line = text => {
      const d = document.createElement('div');
      d.textContent = text;
      log.appendChild(d);
      log.scrollTop = log.scrollHeight;
    };

    // Stage-level events
    stage.addEventListener('stage:agent-joined', e => line(`joined: ${e.detail.agentId}`));
    stage.addEventListener('stage:agent-left', e => line(`left: ${e.detail.agentId}`));
    stage.addEventListener('stage:message', e => line(`stage msg from ${e.detail.from}: ${JSON.stringify(e.detail.event)}`));

    // Per-agent brain events
    for (const el of [leo, mira]) {
      el.addEventListener('brain:message', e =>
        line(`[${el.id}/${e.detail.role}] ${e.detail.content || ''}`)
      );
      el.addEventListener('skill:tool-called', e =>
        line(`[${el.id}] tool ${e.detail.tool}(${JSON.stringify(e.detail.args)})`)
      );
    }

    document.getElementById('send').addEventListener('click', () => {
      const text = document.getElementById('prompt').value.trim();
      if (text) leo.say(text);
    });

    document.getElementById('broadcast').addEventListener('click', () => {
      // Broadcasts a raw event to every agent in the stage
      stage.broadcast('host', { kind: 'hello', text: 'hello from the page!' });
    });
  </script>
</body>
</html>
```

**Key parts:**
- `<agent-stage formation="row">`: hosts both agents in one shared canvas. `formation` controls layout (`row`, `circle`, `freeform`).
- `leo.say(text)`: sends a message directly into Leo's brain.
- `stage.broadcast(fromId, event)`, delivers a `stage:message` event to every agent in the stage.
- `brain:message` fires for every turn: `{ role: 'user'|'assistant', content: '...' }`.
- `stage:agent-joined` fires when each `<agent-3d>` child finishes booting.

**What to change:**
- Give each agent a different `body=` GLB to distinguish them visually
- Remove `brain=` from Mira and add `brain="none"` to make her a passive avatar
- Change `formation="circle"` for more than two agents

---

## 5. React component wrapper

A reusable React component that wraps `<agent-3d>` and surfaces the `agent:ready` and `brain:message` events as props.

**Demonstrates:** custom element in React, ref-based event handling, TypeScript-friendly pattern.

```jsx
// components/AgentViewer.jsx
import { useEffect, useRef, useState } from 'react';

// Load the web component once at module level
import 'https://three.ws/agent-3d/latest/agent-3d.js';

export function AgentViewer({ body, name, instructions, brain = 'claude-opus-4-7', mode = 'inline', onMessage, style }) {
  const ref = useRef(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const handleReady = () => setReady(true);
    const handleMessage = e => onMessage?.(e.detail);

    el.addEventListener('agent:ready', handleReady);
    el.addEventListener('brain:message', handleMessage);
    return () => {
      el.removeEventListener('agent:ready', handleReady);
      el.removeEventListener('brain:message', handleMessage);
    };
  }, [onMessage]);

  return (
    <agent-3d
      ref={ref}
      body={body}
      name={name}
      instructions={instructions}
      brain={brain}
      mode={mode}
      style={{ display: 'block', ...style }}
    />
  );
}
```

```jsx
// Usage
function App() {
  return (
    <AgentViewer
      body="https://three.ws/avatars/michelle.glb"
      name="Aria"
      instructions="You are Aria, a helpful assistant."
      style={{ width: '400px', height: '500px' }}
      onMessage={({ role, content }) => console.log(role, content)}
    />
  );
}
```

**What to change:**
- Add an `onReady` prop and call it from the `agent:ready` handler if you need a callback when the agent finishes loading
- Add a `voiceEnabled` prop that conditionally adds the `voice` attribute to enable speech
- Expose a `sayRef` via `useImperativeHandle` to let parent components call `el.say(text)` imperatively

---

## 6. Event-driven integration

Listen to the agent's event stream to drive a custom transcript UI, no built-in chat chrome needed.

**Demonstrates:** `brain:message`, `skill:tool-called`, `memory:write`, `agent:ready`, `agent:error`.

```html
<agent-3d
  id="agent"
  body="https://three.ws/avatars/cz.glb"
  instructions="You are a helpful assistant."
  brain="claude-opus-4-7"
  style="display:block;width:400px;height:500px"
></agent-3d>

<div
  id="transcript"
  style="max-height:200px;overflow-y:auto;padding:16px;background:#111;color:#ddd;font-size:14px;border-radius:8px;margin-top:12px"
></div>

<script type="module">
  import 'https://three.ws/agent-3d/latest/agent-3d.js';

  const agent = document.getElementById('agent');
  const transcript = document.getElementById('transcript');

  function addLine(speaker, text) {
    const p = document.createElement('p');
    p.style.margin = '4px 0';
    const color = speaker === 'Agent' ? '#6366f1' : speaker === 'User' ? '#aaa' : '#555';
    p.innerHTML = `<strong style="color:${color}">${speaker}:</strong> ${text}`;
    transcript.appendChild(p);
    transcript.scrollTop = transcript.scrollHeight;
  }

  agent.addEventListener('agent:ready', () => {
    addLine('System', 'Agent loaded and ready');
  });

  agent.addEventListener('agent:error', e => {
    addLine('System', `Error during ${e.detail.phase}: ${e.detail.error?.message}`);
  });

  // brain:message fires for every conversation turn
  agent.addEventListener('brain:message', e => {
    if (e.detail.role === 'user') addLine('User', e.detail.content);
    if (e.detail.role === 'assistant') addLine('Agent', e.detail.content || '');
  });

  // skill:tool-called fires when the agent invokes a tool
  agent.addEventListener('skill:tool-called', e => {
    addLine('System', `[tool: ${e.detail.tool}(${JSON.stringify(e.detail.args)})]`);
  });

  // memory:write fires when the agent saves something
  agent.addEventListener('memory:write', e => {
    addLine('System', `[memory write: ${JSON.stringify(e.detail)}]`);
  });
</script>
```

**What to change:**
- Replace the transcript `div` with a proper chat component in your UI framework
- Filter `brain:message` to `role === 'assistant'` only if you control the user input separately
- Add `voice:transcript` listener to show speech-to-text output in real time

---

## 7. Programmatic model switching

Load different GLB models at runtime by calling `say()` or by swapping the `body` attribute.

**Demonstrates:** attribute mutation, `attributeChangedCallback` re-boot, dynamic model selection.

```html
<agent-3d
  id="viewer"
  body="https://three.ws/avatars/cz.glb"
  instructions="Describe what you see in the scene."
  brain="claude-opus-4-7"
  style="display:block;width:400px;height:400px"
></agent-3d>

<div style="display:flex;gap:8px;margin-top:12px">
  <button onclick="load('https://three.ws/avatars/cz.glb')">Avatar 1</button>
  <button onclick="load('https://three.ws/avatars/michelle.glb')">Avatar 2</button>
  <button onclick="load('https://three.ws/accessories/hat-cowboy.glb')">Product</button>
</div>

<script type="module">
  import 'https://three.ws/agent-3d/latest/agent-3d.js';

  window.load = (url) => {
    // Setting the body attribute triggers a re-boot with the new model.
    document.getElementById('viewer').setAttribute('body', url);
  };
</script>
```

**What to change:**
- Add a loading indicator by listening to `agent:load-progress` events (`{ phase, pct }`)
- Use `agent:ready` to re-enable the buttons after the new model finishes loading
- Pass a different `instructions=` string along with each model to give it context-appropriate behavior

---

## 8. Screenshot / capture

Take a PNG snapshot of the current viewer state. The viewer renders a fresh frame and triggers a file download directly.

**Demonstrates:** the built-in `P` keyboard shortcut, triggering it programmatically, `window.VIEWER` on the studio page.

```html
<agent-3d
  id="viewer"
  body="https://three.ws/avatars/cz.glb"
  style="display:block;width:400px;height:400px"
></agent-3d>

<button id="capture" style="margin-top:12px">Download Screenshot</button>

<script type="module">
  import 'https://three.ws/agent-3d/latest/agent-3d.js';

  // The viewer binds a window-level shortcut: pressing P (when no input is
  // focused) renders a fresh frame and downloads it as a PNG. The button
  // below triggers the same handler programmatically.
  document.getElementById('capture').addEventListener('click', () => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'P' }));
  });
</script>
```

> The `P` key is a built-in shortcut: no code needed. The screenshot triggers a browser download directly; there is no return value. On the full studio page ([three.ws/app](https://three.ws/app)) the viewer is also exposed as the debug global `window.VIEWER`, where you can call `window.VIEWER.takeScreenshot()` from the console; standalone embeds don't set that global.

**What to change:**
- Skip the button and just document the `P` key for a frameless experience
- Listen for `agent:ready` before enabling the button so it's not clickable during load
- Chain a `brain:message` listener to auto-screenshot when the agent finishes speaking

---

## 9. iframe postMessage integration

Control an embedded agent from the host page using the iframe bridge on `/agent/<id>/embed`. Every message carries the `agentId` so one host page can drive several iframes deterministically.

**Demonstrates:** the frozen v1 `agent:*` bridge: `agent:hello`, `agent:ready`, `agent:action`, `agent:ping`/`agent:pong`.

```html
<!-- host.html -->
<!doctype html>
<html>
<head>
  <title>Host page</title>
</head>
<body>
  <iframe
    id="embed"
    src="https://three.ws/agent/YOUR_AGENT_ID/embed"
    width="400"
    height="500"
    style="border:none;border-radius:12px"
  ></iframe>

  <div style="margin-top:12px;display:flex;gap:8px">
    <button onclick="greet()">Say Hello</button>
    <button onclick="wave()">Wave</button>
  </div>

  <script>
    const AGENT_ID = 'YOUR_AGENT_ID';
    const EMBED_ORIGIN = 'https://three.ws'; // no trailing slash; must equal e.origin exactly
    const iframe = document.getElementById('embed');
    let ready = false;

    // Wait for agent:ready before sending commands
    window.addEventListener('message', e => {
      if (e.origin !== EMBED_ORIGIN) return;
      const msg = e.data;
      if (!msg || msg.agentId !== AGENT_ID) return;

      if (msg.type === 'agent:ready') {
        ready = true;
        console.log('Agent ready:', msg.name, msg.capabilities);
      }
      if (msg.type === 'agent:action') {
        console.log('Agent action echo:', msg.action);
      }
      if (msg.type === 'agent:blocked') {
        console.warn('Embed policy denied this host page');
      }
    });

    // Handshake: the iframe replies with agent:ready (now or when init completes)
    iframe.addEventListener('load', () => {
      iframe.contentWindow.postMessage(
        { type: 'agent:hello', agentId: AGENT_ID },
        EMBED_ORIGIN
      );
    });

    function post(action) {
      if (!ready) return console.warn('Agent not ready yet');
      iframe.contentWindow.postMessage(
        { type: 'agent:action', agentId: AGENT_ID, action },
        EMBED_ORIGIN
      );
    }

    function greet() {
      // Speak through the agent's TTS voice (drives lip-sync too)
      post({ type: 'speak', text: 'Hello! How are you?' });
    }

    function wave() {
      // Named body gesture on the protocol bus (point, wave, nod, shrug)
      post({ type: 'gesture', payload: { name: 'wave' } });
    }
  </script>
</body>
</html>
```

**Key protocol rules:**
- Every message must include the `agentId`; messages without it (or with a foreign id) are ignored.
- Send `agent:hello` first and wait for `agent:ready` (it includes `capabilities`: `speak`, `gesture`, `look-at`, `emote`, `present-model`).
- `agent:action` forwards an action onto the iframe's protocol bus: `speak` and `speak:stop` are handled specially; anything else (e.g. `gesture`, `emote`, `look-at`) is emitted as-is.
- The iframe locks onto the first authenticated sender origin and ignores messages from any other origin afterward. Always validate `e.origin` on your side too, comparing against the bare origin (`https://three.ws`, no trailing slash).
- If the agent's embed policy doesn't allow your domain, the iframe posts `agent:blocked` instead of `agent:ready`.

**What to change:**
- Use `agent:ping` (`{ type: 'agent:ping', agentId, id }`) and listen for `agent:pong` for a liveness probe
- Listen for `agent:resize` (`{ height }`) to grow the iframe to the content's preferred height
- For script (non-iframe) embeds of `<agent-3d>`, use the `EmbedHostBridge` class (`src/embed-host-bridge.js`) instead of raw `postMessage`; it handles the handshake and response correlation for you

---

## 10. Coach Leo: a complete agent example

Coach Leo is a fully-configured agent with a personality, skills, and persistent memory. The source lives in [`examples/coach-leo/`](https://github.com/nirholas/three.ws/tree/main/examples/coach-leo).

**Demonstrates:** agent manifest, personality prompt, skill wiring, local memory.

### manifest.json

```json
{
  "$schema": "https://3d-agent.io/schemas/manifest/0.1.json",
  "spec": "agent-manifest/0.1",
  "name": "Coach Leo",
  "description": "Football coach. Reviews your form, cheers you on.",
  "image": "/avatars/cz.glb",
  "tags": ["coach", "football", "argentina"],
  "body": {
    "uri": "/avatars/cz.glb",
    "format": "gltf-binary",
    "rig": "mixamo",
    "boundingBoxHeight": 1.78
  },
  "brain": {
    "provider": "anthropic",
    "model": "claude-opus-4-6",
    "instructions": "instructions.md",
    "temperature": 0.8,
    "maxTokens": 2048
  },
  "voice": {
    "tts": { "provider": "browser", "rate": 1.05 },
    "stt": { "provider": "browser", "language": "en-US" }
  },
  "skills": [{ "uri": "../skills/wave/", "version": "0.1.0" }],
  "memory": {
    "mode": "local",
    "index": "memory/MEMORY.md",
    "maxTokens": 8192
  },
  "tools": ["wave", "lookAt", "play_clip", "setExpression", "speak", "remember"],
  "version": "0.1.0"
}
```

### instructions.md (the personality prompt)

```markdown
---
name: Coach Leo
model: claude-opus-4-6
temperature: 0.8
---

You are Coach Leo, a former Argentine midfielder turned football coach.
You wear the Argentina jersey with pride. You are warm, direct, and
genuinely invested in the user's progress.

## How you work

- When the user greets you, call `wave()` to wave at them.
- When they describe a drill or ask about form, set a focused expression
  with `setExpression({ preset: "focused" })` while you explain, then smile
  afterward.
- If the user shares something worth remembering (their position, goals,
  injuries, schedule), call `remember()` to save it durably.
- Reference past memory naturally: don't recite, weave it in.
- Keep replies short in voice mode: 1, 2 sentences, then invite the user
  to respond. Save long explanations for when they ask for depth.

## Your voice

- Direct. No coddling. "That's not quite right: try this instead."
- Warm. Genuine wins get genuine praise.
- Never break character.
```

### Using Leo in a page

```html
<agent-3d
  manifest="/examples/coach-leo/manifest.json"
  voice
  style="display:block;width:400px;height:500px"
></agent-3d>

<script type="module" src="https://three.ws/agent-3d/latest/agent-3d.js"></script>
```

### Design decisions

**Personality prompt as a separate file.** `instructions.md` is loaded at boot via the `"instructions": "instructions.md"` field in the manifest. Keeping it separate makes it easy to iterate on the prompt without touching the manifest schema.

**Skills extend tools.** The `wave` skill ([`examples/skills/wave/`](https://github.com/nirholas/three.ws/tree/main/examples/skills/wave)) adds a `waveAndGreet` tool the brain can call; its ten-line handler chains the built-in `wave` gesture with a spoken greeting. The manifest lists it under `skills:` with a URI; the runtime installs it and registers the tool automatically. To add more capabilities, add more entries to `skills:`.

**Memory persists between sessions.** `"mode": "local"` stores memories as `.md` files under `memory/`. When Leo calls `remember({ key: "position", value: "striker" })`, it writes to that directory and loads it back on the next boot. Switching to `"mode": "ipfs"` makes memories portable across devices.

**[View full source →](https://github.com/nirholas/three.ws/blob/main/examples/coach-leo/manifest.json)**

---

## Quick API reference

| Method | Description |
|--------|-------------|
| `el.say(text)` | Send a message to the agent brain; agent responds |
| `el.ask(text)` | Like `say()` but returns the agent's reply as a string |
| `el.wave()` | Play the wave animation |
| `el.lookAt(target)` | Direct gaze: `'user'`, `'model'`, or `'camera'` |
| `el.play(name, opts)` | Play a named animation clip |
| `el.installSkill(uri)` | Install a skill at runtime |
| `el.clearConversation()` | Reset the conversation history |
| `el.destroy()` | Tear down the element and release WebGL resources |

| Event | Fires when |
|-------|-----------|
| `agent:ready` | Agent finishes booting |
| `agent:error` | Boot or runtime error |
| `agent:load-progress` | Loading phase update (`{ phase, pct }`) |
| `brain:message` | Conversation turn (`{ role, content }`) |
| `brain:thinking` | Agent starts reasoning |
| `skill:tool-called` | Agent invokes a tool (`{ tool, args, result }`) |
| `skill:loaded` | A skill finishes installing |
| `memory:write` | Agent writes to memory |
| `voice:transcript` | Speech-to-text result |

---

<!-- BEGIN GENERATED EXAMPLES INDEX (npm run build:examples) -->

<!-- Generated by scripts/build-examples-index.mjs. Do not edit inside these markers. -->

## Every runnable example in the repo

The repo ships 47 examples: 11 web component demos, 10 end-to-end projects, and 26 package example sets. This table is generated from what is on disk, so it cannot list one that was deleted or miss one that was added. The machine-readable version is [data/examples.json](../data/examples.json).

### Example projects

| Example | What it shows | Run it |
|---|---|---|
| [`examples/agenc-task-roundtrip`](../examples/agenc-task-roundtrip) | End-to-end demonstration of a three.ws agent participating in the AgenC coordination protocol on Solana devnet. A creator wallet posts a task; a worker wallet (the "three.ws agent") claims and completes it. | `node examples/agenc-task-roundtrip/run.mjs` |
| [`examples/agent-native-3d`](../examples/agent-native-3d) | An agent given a goal ("get yourself a body") generates the 3D assets it needs and uses them - no browser, no mocks, no human in the loop. | `node examples/agent-native-3d/run.mjs` |
| [`examples/coach-leo`](../examples/coach-leo) | A complete, minimal example of a three.ws agent defined entirely as files: a manifest pointing at a 3D body, a brain, a voice, a memory policy, and one installed skill. | Reference files, nothing to execute |
| [`examples/skills`](../examples/skills) | Six installable skill bundles for the three.ws agent runtime. | Reference files, nothing to execute |
| [`examples/metamask-agent-wallet`](../examples/metamask-agent-wallet) | A single-page demo that gives a three.ws agent a real server-side wallet through the MetaMask Agentic CLI (mm). | `node examples/metamask-agent-wallet/server.mjs` |
| [`examples/monicas-apartment`](../examples/monicas-apartment) | A single, self-contained HTML file that rebuilds the iconic Monica Geller apartment set from Friends as a walkable first-person 3D scene: purple walls, the purple front door with the yellow peephole frame, teal kitchen cabinets, the mismatched dining chairs, | `npm run dev, then open /examples/monicas-apartment/index.html` |
| [`examples/paid-mcp-server`](../examples/paid-mcp-server) | A complete, runnable MCP server whose tools charge per call in USDC on Solana over x402. It ships two tools on purpose: | `cd examples/paid-mcp-server && npm install && npm run start` |
| [`examples/pump-fun-agent`](../examples/pump-fun-agent) | An example agent manifest that composes all four production pump.fun skills into one 3D trading agent: swap, coin creation, creator-fee collection, and token payments. | Reference files, nothing to execute |
| [`examples/three-concierge`](../examples/three-concierge) | The reference agent for manifest spec agent-manifest/0.2. Trinity welcomes users to three.ws, explains the platform, and launches and trades $three on pump.fun through the real pump.fun skills in pump-fun-skills/. | Reference files, nothing to execute |
| [`examples/wallet-sign-in`](../examples/wallet-sign-in) | A single-page, no-build demo of the two wallet authentication rails three.ws runs itself: Sign-In with Solana (SIWS) and Sign-In with Ethereum (SIWE). | `npm run dev, then open /examples/wallet-sign-in/index.html` |

### Package examples

| Example | What it shows | Run it |
|---|---|---|
| [`packages/agentcore-payments-mcp/examples`](../packages/agentcore-payments-mcp/examples) | Two runnable examples. Neither one spends money, needs a wallet, or needs an account, so you can run both before deciding whether to fund anything. | `node packages/agentcore-payments-mcp/examples/list-tools.mjs` |
| [`assistant-sdk/examples`](../assistant-sdk/examples) | A 3D avatar assistant for any website, in one script tag. A floating launcher opens a real, animated 3D avatar in a panel, standing directly on your page (transparent), or against a color or gradient. It has two modes: | `npm run dev, then open /assistant-sdk/examples/index.html` |
| [`avatar-sdk/examples`](../avatar-sdk/examples) | A self-contained page, no build step. It loads the SDK's @three-ws/avatar/agent entry from a CDN, awaits ensureAgent3D() to register the <agent-3d> element, and renders the real three.ws default avatar using the documented src and kiosk attributes. | `npm run dev, then open /avatar-sdk/examples/index.html` |
| [`packages/avatar-schema/examples`](../packages/avatar-schema/examples) | JSON Schema and validator for three.ws on-chain avatar manifests - the canonical, hash-anchored format any cross-chain client can use to resolve an avatar. | Reference files, nothing to execute |
| [`concierge-sdk/examples`](../concierge-sdk/examples) | Runnable examples for every way to use the concierge. The HTML files load the SDK from ../dist, build it first (npm run build in the package root), then serve this folder (npx serve .) and open each file. | `npm run dev, then open /concierge-sdk/examples/custom-avatar.html` |
| [`herald-sdk/examples`](../herald-sdk/examples) | Three runnable examples, smallest first. Each one is a single file with no build step: open the HTML in a browser, or run the Node file with node. | `node herald-sdk/examples/ci-notify.mjs` |
| [`packages/kol-mcp/examples`](../packages/kol-mcp/examples) | Two runnable examples. Both spawn this package's own MCP server over stdio (the same node src/index.js entry point the README documents), speak real MCP JSON-RPC to it, and read the live public KOL API. | `node packages/kol-mcp/examples/list-tools.mjs` |
| [`packages/loom-mcp/examples`](../packages/loom-mcp/examples) | Two runnable examples. Both spawn this package's own MCP server over stdio (the same node src/index.js entry point the README documents), speak real MCP JSON-RPC to it, and read the live public Loom gallery. | `node packages/loom-mcp/examples/browse-loom.mjs` |
| [`packages/marketplace-mcp/examples`](../packages/marketplace-mcp/examples) | Two runnable examples. Both spawn this package's own MCP server over stdio (the same node src/index.js entry point the README documents), speak real MCP JSON-RPC to it, and read the live public marketplace. | `node packages/marketplace-mcp/examples/browse-marketplace.mjs` |
| [`mcp-server/examples`](../mcp-server/examples) | Two zero-dependency walkthroughs of the MCP Streamable HTTP lifecycle against the live three.ws server at https://three.ws/api/mcp (MCP 2025-06-18, JSON-RPC 2.0). | `node mcp-server/examples/client.mjs` |
| [`page-agent-sdk/examples`](../page-agent-sdk/examples) | Run these from the package root with any static server so the import map can resolve the unbundled source from ../src: | `npm run dev, then open /page-agent-sdk/examples/custom-avatar.html` |
| [`packages/portal/example`](../packages/portal/example) | Turn any website into a walkable 3D world. | `npm run dev, then open /packages/portal/example/index.html` |
| [`packages/pumpfun-mcp/examples`](../packages/pumpfun-mcp/examples) | Two runnable examples. Both spawn this package's own MCP server over stdio (the same node src/index.js entry point the README documents), speak real MCP JSON-RPC to it, and read live Solana mainnet data through the canonical three.ws backend. | `node packages/pumpfun-mcp/examples/list-tools.mjs` |
| [`sdk/example`](../sdk/example) | Ship a cross-chain 3D AI agent with EVM + Solana identity, a chat panel, and discoverable .well-known endpoints. | `npm run dev, then open /sdk/example/index.html` |
| [`packages/sign-language/example`](../packages/sign-language/example) | American Sign Language for 3D avatars. | `node packages/sign-language/example/compile-utterance.mjs` |
| [`packages/skill-license/example`](../packages/skill-license/example) | On-chain skill licenses for agents - each purchased skill is a 1/1 SPL NFT plus a deterministic SkillLicense PDA. Mint, verify, and read trustless skill access in one import, no database required. | `node packages/skill-license/example/verify-license.mjs` |
| [`tour-sdk/examples`](../tour-sdk/examples) | The guide walks from feature to feature across your real pages. | `npm run dev, then open /tour-sdk/examples/shopify-storefront.html` |
| [`packages/vanity-mcp/examples`](../packages/vanity-mcp/examples) | Two runnable examples. Both spawn this package's own MCP server over stdio (the same node src/index.js entry point the README documents), speak real MCP JSON-RPC to it, and read the live grind-bounty market. | `node packages/vanity-mcp/examples/list-tools.mjs` |
| [`packages/vision-mcp/examples`](../packages/vision-mcp/examples) | Two runnable examples. Both spawn this package's own MCP server over stdio (the same node src/index.js entry point the README documents), speak real MCP JSON-RPC to it, and hit the live three.ws vision pipeline. | `node packages/vision-mcp/examples/list-tools.mjs` |
| [`packages/voice/examples`](../packages/voice/examples) | Run it from the package directory: | `node packages/voice/examples/voice-loop.mjs` |
| [`packages/x402-fetch/examples`](../packages/x402-fetch/examples) | Two runnable scripts against the live three.ws x402 Market Data API. Node 20+ is the only requirement; the package has zero production dependencies. | `node packages/x402-fetch/examples/discover.mjs` |
| [`packages/x402-mcp/examples`](../packages/x402-mcp/examples) | Two runnable examples. Both spawn this package's own MCP server over stdio (the same node src/index.js entry point the README documents), speak real MCP JSON-RPC to it, and hit live data. Neither one pays for anything. | `node packages/x402-mcp/examples/inspect-price.mjs` |
| [`x402-modal-sdk/examples`](../x402-modal-sdk/examples) | A drop-in payment modal for any x402 paid endpoint. | `node x402-modal-sdk/examples/server.mjs` |
| [`packages/x402-server/examples`](../packages/x402-server/examples) | Runnable examples for the seller half of x402. Each is a standalone .mjs file. | `node packages/x402-server/examples/express-metered-api.mjs` |
| [`examples`](../examples) | Runnable demos for the three.ws SDKs and agent runtime. Two kinds live here: | `npm run dev, then open /examples/agent-presence.html` |
| [`agent-payments-sdk/src/solana/examples`](../agent-payments-sdk/src/solana/examples) | Runnable examples for the Solana half of @three-ws/agent-payments. They read live mainnet data and never sign or send a transaction, so nothing here can spend. | Reference files, nothing to execute |

### Web component demos

| Example | What it shows | Run it |
|---|---|---|
| [`examples/agent-wallet-embed.html`](../examples/agent-wallet-embed.html) | The wallet is portable on its own too - mount it into any element (here, a light-DOM card; it also works inside a closed shadow root). | `http://localhost:3000/examples/agent-wallet-embed.html` |
| [`examples/agent-presence.html`](../examples/agent-presence.html) | Standalone test for the global presence element - all three modes + live market reactions, on real data. | `http://localhost:3000/examples/agent-presence.html` |
| [`examples/two-agents.html`](../examples/two-agents.html) | Both agents render in a single WebGL context. Each keeps its own brain, memory, and chat chrome. | `http://localhost:3000/examples/two-agents.html` |
| [`examples/web-component.html`](../examples/web-component.html) | Minimal, auto-rotate, and poster/reveal variants of the Custom Element wrapper. | `http://localhost:3000/examples/web-component.html` |
| [`examples/bare-avatar.html`](../examples/bare-avatar.html) | JUST the avatar - the default. No chat, no input, no debug GUI, no name-plate, transparent background. Add the `chat` attribute to opt into the conversational UI. | `http://localhost:3000/examples/bare-avatar.html` |
| [`examples/minimal.html`](../examples/minimal.html) | This is a plain HTML page. The floating agent in the corner was added with a single <agent-3d> tag - no build step, no framework. | `http://localhost:3000/examples/minimal.html` |
| [`examples/one-line-demo.html`](../examples/one-line-demo.html) | Everything below the heading is a single <agent-3d> tag. | `http://localhost:3000/examples/one-line-demo.html` |
| [`examples/sign-language.html`](../examples/sign-language.html) | Left: an agent whose every reply is signed, from one HTML attribute. Right: the signing engine on its own, compiling whatever you type into a single animation clip. | `http://localhost:3000/examples/sign-language.html` |
| [`examples/embed-test.html`](../examples/embed-test.html) | Testing the <agent-3d> web component embed. | `http://localhost:3000/examples/embed-test.html` |
| [`examples/widget-rpc.html`](../examples/widget-rpc.html) | This page loads /widget in the iframe and drives it through the ThreeWidget SDK. Open the source - it's ~70 lines, no build step. | `http://localhost:3000/examples/widget-rpc.html` |
| [`examples/three-concierge.html`](../examples/three-concierge.html) | Trinity, the three.ws concierge, mounted live from a JSON manifest: a glTF body, browser voice, skills, and scene tools - wired end to end. | `http://localhost:3000/examples/three-concierge.html` |

Run any command from the repo root after `npm install`. The web component demos need `npm run dev` first, since they import from `src/` so edits hot-reload into them. Anything that can spend money is gated behind an environment variable and off by default.

<!-- END GENERATED EXAMPLES INDEX -->
