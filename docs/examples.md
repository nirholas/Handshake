# Examples Gallery

Copy-paste ready code for common three.ws use cases. Each example runs as-is — swap your own model URL and go.

---

## 1. Minimal embed

The absolute simplest setup: one script tag, one custom element.

**Demonstrates:** loading `<agent-3d>`, inline display, no-build workflow.

**[View example →](/examples/minimal.html)**

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
    <p>The agent below is embedded inline — no build step, no framework.</p>

    <agent-3d
      body="/avatars/cz.glb"
      instructions="You are a friendly 3D guide."
      brain="claude-opus-4-6"
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

A pinned chatbot bubble that stays fixed in the viewport corner — like a support widget, but embodied.

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
  <p>The agent floats in the bottom-right corner. Scroll — it stays put.</p>

  <!-- Floating bubble — fixed, bottom-right -->
  <agent-3d
    body="/avatars/cz.glb"
    instructions="You are a cheerful greeter. Wave when users say hi."
    mode="floating"
    position="bottom-right"
    width="320px"
    height="420px"
    brain="claude-opus-4-6"
  ></agent-3d>

  <script type="module" src="https://three.ws/agent-3d/latest/agent-3d.js"></script>
</body>
</html>
```

**What to change:**
- `position` — `bottom-right`, `bottom-left`, `top-right`, or `top-left`
- `width` / `height` — size of the bubble when expanded
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
    body="/avatars/aria.glb"
    name="Aria"
    instructions="You are Aria, a friendly AI assistant. Be helpful and concise."
    brain="claude-opus-4-6"
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

**[View example →](/examples/two-agents.html)**

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
      body="/avatars/cz.glb"
      instructions="You are Coach Leo. Friendly, short answers. When another agent says hi, wave and greet them back by name."
      brain="claude-opus-4-6"
      eager
    ></agent-3d>
    <agent-3d
      id="mira"
      name="Mira"
      body="/avatars/cz.glb"
      instructions="You are Mira, a quiet observer who only speaks when spoken to."
      brain="claude-opus-4-6"
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
- `<agent-stage formation="row">` — hosts both agents in one shared canvas. `formation` controls layout (`row`, `circle`, `freeform`).
- `leo.say(text)` — sends a message directly into Leo's brain.
- `stage.broadcast(fromId, event)` — delivers a `stage:message` event to every agent in the stage.
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

export function AgentViewer({ body, name, instructions, brain = 'claude-opus-4-6', mode = 'inline', onMessage, style }) {
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
      body="/avatars/aria.glb"
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

Listen to the agent's event stream to drive a custom transcript UI — no built-in chat chrome needed.

**Demonstrates:** `brain:message`, `skill:tool-called`, `memory:write`, `agent:ready`, `agent:error`.

```html
<agent-3d
  id="agent"
  body="/avatars/cz.glb"
  instructions="You are a helpful assistant."
  brain="claude-opus-4-6"
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
  body="/avatars/cz.glb"
  instructions="Describe what you see in the scene."
  brain="claude-opus-4-6"
  style="display:block;width:400px;height:400px"
></agent-3d>

<div style="display:flex;gap:8px;margin-top:12px">
  <button onclick="load('/avatars/cz.glb')">Avatar 1</button>
  <button onclick="load('/avatars/aria.glb')">Avatar 2</button>
  <button onclick="load('/models/product.glb')">Product</button>
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

**Demonstrates:** `viewer.takeScreenshot()`, debug global `window.VIEWER`, keyboard shortcut `P`.

```html
<agent-3d
  id="viewer"
  body="/avatars/cz.glb"
  style="display:block;width:400px;height:400px"
></agent-3d>

<button id="capture" style="margin-top:12px">Download Screenshot</button>

<script type="module">
  import 'https://three.ws/agent-3d/latest/agent-3d.js';

  document.getElementById('capture').addEventListener('click', () => {
    // window.VIEWER is a debug global exposed by the runtime.
    // takeScreenshot() renders a fresh frame and downloads it as PNG.
    window.VIEWER?.takeScreenshot();
  });

  // Keyboard shortcut: press P to screenshot (built in)
</script>
```

> The `P` key is a built-in shortcut — no code needed. `takeScreenshot()` triggers a browser download directly; there is no return value.

**What to change:**
- Swap to the `P` key shortcut for a frameless experience — no button needed
- Listen for `agent:ready` before enabling the button so it's not clickable during load
- Chain a `brain:message` listener to auto-screenshot when the agent finishes speaking

---

## 9. iframe postMessage integration

Control an embedded agent from the host page using the versioned postMessage protocol. Every message uses the `{ v: 1, type, payload }` envelope.

**Demonstrates:** `EMBED_HOST_PROTOCOL`, `host.chat.message`, `host.action`, `embed.ready`, `embed.event`.

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
    src="https://three.ws/embed?agent=your-agent-id"
    width="400"
    height="500"
    style="border:none;border-radius:12px"
  ></iframe>

  <div style="margin-top:12px;display:flex;gap:8px">
    <button onclick="greet()">Say Hello</button>
    <button onclick="wave()">Wave</button>
    <button onclick="setDark()">Dark Mode</button>
  </div>

  <script>
    const EMBED_ORIGIN = 'https://three.ws/';
    const iframe = document.getElementById('embed');
    let ready = false;

    // Wait for embed.ready before sending commands
    window.addEventListener('message', e => {
      if (e.origin !== EMBED_ORIGIN) return;
      const { v, type, payload } = e.data;
      if (v !== 1) return;

      if (type === 'embed.ready') {
        ready = true;
        console.log('Agent ready:', payload.agentId, payload.capabilities);
      }

      if (type === 'embed.event') {
        console.log('Agent event:', payload.event, payload.data);
      }
    });

    function post(type, payload = {}) {
      if (!ready) return console.warn('Agent not ready yet');
      iframe.contentWindow.postMessage({ v: 1, type, payload }, EMBED_ORIGIN);
    }

    function greet() {
      // Deliver a chat turn into the agent
      post('host.chat.message', {
        role: 'user',
        text: 'Hello! How are you?',
        messageId: `msg_${Date.now()}`
      });
    }

    function wave() {
      // Trigger a named action — emote or speech
      post('host.action', { action: 'emote.wave', args: {} });
    }

    function setDark() {
      // Switch the embed theme
      post('host.theme', { mode: 'dark' });
    }
  </script>
</body>
</html>
```

**Key protocol rules:**
- Every message must include `v: 1` — messages without it are ignored.
- The embed sends `embed.ready` first; wait for it before sending commands.
- `host.chat.message` delivers a user turn; the agent responds and fires `embed.event` with `agent.speaking`.
- `host.action` supports `emote.wave`, `speak`, and any other named action.
- Always validate `e.origin` against the expected embed origin before processing.

**What to change:**
- Use `host.hello` after `embed.ready` to pass `userId` and `userName` for personalization
- Listen for `embed.event` with `event: 'agent.speaking'` to mirror the agent's transcript in the host UI
- Set `allowedOrigins` in the embed config to restrict which host pages can send commands

---

## 10. Coach Leo — a complete agent example

Coach Leo is a fully-configured agent with a personality, skills, and persistent memory. The source lives in [`/examples/coach-leo/`](/examples/coach-leo/).

**Demonstrates:** agent manifest, personality prompt, skill wiring, local memory.

### manifest.json

```json
{
  "$schema": "https://3d-agent.io/schemas/manifest/0.1.json",
  "spec": "agent-manifest/0.1",
  "name": "Coach Leo",
  "description": "Football coach. Reviews your form, cheers you on.",
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
  with `setExpression({ preset: "focused" })` while you explain, then smile.
- If the user shares something worth remembering (their position, goals,
  injuries, schedule), call `remember()` to save it durably.
- Reference past memory naturally — don't recite, weave it in.
- Keep replies short in voice mode: 1–2 sentences, then invite the user
  to respond.

## Your voice

- Direct. No coddling. "That's not quite right — try this instead."
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

**Skills extend tools.** The `wave` skill adds a `wave()` tool the brain can call. The manifest lists it under `skills:` with a URI; the runtime installs it and registers the tool automatically. To add more capabilities, add more entries to `skills:`.

**Memory persists between sessions.** `"mode": "local"` stores memories as `.md` files under `memory/`. When Leo calls `remember({ key: "position", value: "striker" })`, it writes to that directory and loads it back on the next boot. Switching to `"mode": "ipfs"` makes memories portable across devices.

**[View full source →](/examples/coach-leo/manifest.json)**

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
