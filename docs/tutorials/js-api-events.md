# Drive the agent with the JavaScript API

The script tag is the easy mode. It drops a 3D agent on your page, gives it a chat input, and walks away. That's enough for a contact widget. But once you start treating the agent like a real part of your product — something that reacts to clicks, scroll position, form submits, and checkout success — you need the JavaScript API.

This tutorial covers the full handle-to-event lifecycle. By the end you will know how to grab the agent element, wait for it to be truly ready, fire animations and speech in response to user actions, listen for the events the agent emits back, and chain everything together into a real product moment — a checkout celebration sequence that fires on a successful order.

**What you'll build:**
- A live page where the agent reacts to clicks and form events
- A "wait until ready" pattern that never tries to drive an unbooted agent
- A queue that chains `ask`, `play`, and `lookAt` without overlap
- A listener that reads back every word the agent says
- A checkout celebration flow — submit a form, the agent cheers, narrates, and goes idle

**Prerequisites:** Comfort with vanilla DOM APIs (`querySelector`, `addEventListener`), promises, and async/await. You should have completed the [first-agent tutorial](/tutorials/first-agent) or have an agent ID from [three.ws/my-agents](https://three.ws/my-agents).

---

## Step 1 — Drop the agent on the page

Start with the simplest possible embed. Create `index.html` and paste this:

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Agent JS API</title>
  <style>
    body { margin: 0; font-family: system-ui, sans-serif; background: #0a0a0a; color: #f5f5f5; padding: 40px; }
    h1   { font-weight: 600; letter-spacing: -0.02em; }
    .row { display: flex; gap: 32px; align-items: flex-start; margin-top: 32px; }
    .controls button {
      display: block; width: 220px; padding: 12px 16px; margin-bottom: 12px;
      background: #1a1a1a; color: #f5f5f5; border: 1px solid #2a2a2a;
      border-radius: 10px; font-size: 14px; cursor: pointer;
    }
    .controls button:hover { background: #222; }
    pre { background: #111; padding: 16px; border-radius: 8px; max-height: 320px; overflow: auto; font-size: 12px; }
  </style>
</head>
<body>
  <h1>Drive the agent</h1>

  <div class="row">
    <agent-3d
      id="agent"
      agent-id="YOUR_AGENT_ID"
      width="360px"
      height="480px"
    ></agent-3d>

    <div>
      <div class="controls">
        <button id="btn-wave">Wave</button>
        <button id="btn-greet">Say hello</button>
        <button id="btn-think">Think about something</button>
        <button id="btn-celebrate">Celebrate</button>
        <button id="btn-clear">Clear conversation</button>
      </div>
      <pre id="log"></pre>
    </div>
  </div>

  <script type="module" src="https://three.ws/agent-3d/latest/agent-3d.js"></script>
  <script type="module" src="./app.js"></script>
</body>
</html>
```

Swap `YOUR_AGENT_ID` for an actual ID from [three.ws/my-agents](https://three.ws/my-agents). The `<agent-3d>` web component self-registers when the CDN script loads.

Now create `app.js` alongside it. We'll fill it in as we go. For now:

```js
const agent = document.getElementById('agent');
const log = document.getElementById('log');

function logLine(text) {
  log.textContent += text + '\n';
  log.scrollTop = log.scrollHeight;
}

logLine('Page loaded. Waiting for agent to boot...');
```

Serve it locally — `python3 -m http.server 8080` works — and open `http://localhost:8080`. The agent appears. Nothing else does. Good.

---

## Step 2 — Get a handle to the agent

The `<agent-3d>` element is a custom element. `document.getElementById('agent')` gives you back an `Agent3DElement` instance with the full API attached — the CDN script's only job is registering that element, so every `<agent-3d>` tag on the page is a live API handle.

If you didn't put an `id` on the tag (or you're writing code that runs on pages you don't control), grab the first agent on the page instead:

```js
const agent = document.querySelector('agent-3d');
```

Either lookup returns the same element with the same JavaScript API from this point forward.

---

## Step 3 — Wait for ready, always

This is the rule that prevents 90% of the headaches you would otherwise hit. The agent does a lot at boot: fetches the manifest, downloads a GLB body (often several megabytes), warms up the runtime, registers skills, and resolves the brain. None of `.speak()`, `.wave()`, or `.say()` will do anything useful until that finishes.

The element emits an `agent:ready` event when boot is complete. Listen for it:

```js
agent.addEventListener('agent:ready', (e) => {
  logLine('Agent ready: ' + (e.detail.manifest?.name || 'unnamed'));
});
```

`e.detail.manifest` contains the resolved manifest — name, description, body URL, brain config, the lot. If you need anything from it, grab it here.

But what if you have code that runs *after* the page might have already booted? A common case: a button handler that fires whenever the user clicks, where the click could happen before or after boot. You need a promise that resolves when the agent is ready, no matter when you call it.

Build one:

```js
function whenReady(el) {
  return new Promise((resolve) => {
    if (el._mounted) { resolve(el); return; }
    const on = (e) => {
      el.removeEventListener('agent:ready', on);
      resolve(el);
    };
    el.addEventListener('agent:ready', on);
  });
}
```

The `_mounted` flag is set by the runtime once boot finishes, so if the agent is already ready the promise resolves immediately. Otherwise it waits for the event. This pattern is in the element's own `_waitForReady` helper — we're just exposing it as a public utility.

Now every action handler starts the same way:

```js
document.getElementById('btn-wave').addEventListener('click', async () => {
  await whenReady(agent);
  agent.wave();
});
```

No race conditions, no "I clicked but nothing happened on the first try" bugs.

---

## Step 4 — The two ways to speak

The agent has two methods that look similar but do different things. Picking the right one matters.

**`agent.speak(text)`** — plays a talking *gesture* sized to the length of the text (roughly 0.3s per word, minimum 1.5s). It is silent: no LLM, no audio, no chat bubble. Use it to add life to a scripted moment where the page itself supplies the words on screen. Cheap, instant, deterministic.

**`agent.say(text)`** — sends `text` to the brain as a user message. The reply renders in the chat bubble and is spoken aloud when the `voice` attribute is set. This is what the built-in chat input calls. It's fire-and-forget: it returns immediately, and if you call it again while a turn is in flight, the newest message replaces the queued one.

**`agent.ask(text)`** — same brain turn as `say`, but returns a promise that resolves with the reply text once the response (and its speech, if voice is on) has finished. Reach for it whenever you need to await the turn or use the reply.

Most page-driven interactions want `say` or `ask`. Use `speak` when all you need is the gesture.

Wire up two buttons:

```js
document.getElementById('btn-greet').addEventListener('click', async () => {
  await whenReady(agent);
  // Silent talking gesture — pair it with your own on-page caption.
  agent.speak('Hey there. Glad you stopped by.');
});

document.getElementById('btn-think').addEventListener('click', async () => {
  await whenReady(agent);
  // Goes through the LLM — the model decides what to say.
  agent.say('Tell me a one-sentence fun fact.');
});
```

Click both. The first animates instantly and makes no sound. The second pauses briefly while the model generates, then renders the reply (and speaks it if `voice` is enabled).

---

## Step 5 — Animations: exact clip vs emote

The agent has two ways to pick an animation clip. They map to two different mental models.

**`agent.play(name)`** — plays the clip with that name from the loaded rig (an exact match, falling back to a case-insensitive one). If the clip isn't in the model, it returns `false` and nothing plays. Use this when you know what's in the rig — for instance, if you've baked a `WaveLoop` clip yourself.

**`agent.playEmote(name)`** — the resilient one. Instead of a clip name it takes an intent — `'celebrate'`, `'cheer'`, or `'flinch'` — and walks a fallback chain of clips until one exists in the rig (`celebrate` → `wave`; `cheer` → `celebrate` → `wave`; `flinch` → `defeated` → `concern` → `shake`). If none of them are present, it finishes with a small head-bob, so it's guaranteed to do *something* regardless of the rig.

For product moments, prefer the emote version:

```js
document.getElementById('btn-celebrate').addEventListener('click', async () => {
  await whenReady(agent);
  // Tries the 'celebrate' clip first; falls back to 'wave', then a head-bob.
  agent.playEmote('celebrate');
});
```

Reach for `play(name)` only when you control the GLB and want one specific clip, no substitutes.

Convenience shortcuts: `agent.wave()`, `agent.lookAt('camera' | 'user' | 'model')`.

Add a clear button too while we're here:

```js
document.getElementById('btn-clear').addEventListener('click', async () => {
  await whenReady(agent);
  agent.clearConversation();
  logLine('Conversation cleared.');
});
```

`clearConversation()` resets the rolling memory the brain uses, but does not touch any long-term memory you've written.

---

## Step 6 — Listen back: the event lifecycle

So far we've been issuing commands. The agent also emits events you can listen for — and they're the foundation of most useful integrations.

Here are the events that actually fire, in the order you'll usually see them in one chat turn:

| Event | Fires when | `event.detail` |
|---|---|---|
| `agent:ready` | The avatar has booted and the API is live | `{ agent, manifest }` |
| `brain:thinking` | An LLM call has started | `{ thinking: true | false }` |
| `brain:stream` | A chunk of a streamed response arrived | `{ chunk: string }` |
| `brain:message` | A complete message landed (user or assistant) | `{ role, content, sentiment? }` |
| `skill:tool-start` | A tool/skill is about to run | `{ tool }` |
| `skill:tool-called` | A tool returned | `{ name, args, result }` |
| `voice:speech-start` | The agent began speaking out loud | `{ text }` |
| `voice:speech-end` | The agent finished speaking | — |
| `voice:transcript` | Mic input was transcribed | `{ text }` |
| `memory:write` | Something was written to memory | `{ scope, key, value }` |

Wire a logger to see them flow:

```js
const events = [
  'agent:ready',
  'brain:thinking',
  'brain:message',
  'skill:tool-called',
  'voice:speech-start',
  'voice:speech-end',
];
for (const ev of events) {
  agent.addEventListener(ev, (e) => {
    if (ev === 'brain:message') {
      logLine(`[${ev}] ${e.detail.role}: ${(e.detail.content || '').slice(0, 80)}`);
    } else if (ev === 'voice:speech-start') {
      logLine(`[${ev}] "${(e.detail.text || '').slice(0, 60)}"`);
    } else {
      logLine(`[${ev}]`);
    }
  });
}
```

Click "Think about something" and watch the order. Boot → ready → thinking starts → stream chunks arrive (we didn't subscribe to those above; add `brain:stream` if you want the raw token feed) → message lands → speech starts → speech ends.

Every one of these is a hook for your app. A few common patterns:

- **Show a typing indicator** — switch a CSS class on `brain:thinking` and clear it on `brain:message`.
- **Mirror chat to your own UI** — listen to `brain:message` and append `e.detail.content` to your message log when `role === 'assistant'`.
- **Track skill usage** — `skill:tool-called` tells you which skill ran, with what arguments, and what came back. Log it to your analytics.
- **React to speech state** — disable an input while `voice:speech-start` is active, re-enable on `voice:speech-end`. Stops the user from interrupting the agent mid-sentence.

---

## Step 7 — Sequencing: do A, then B, then C

A common pitfall: fire `speak` and `play` back-to-back, and they overlap. The second clip steps on the talking gesture and things look broken.

For LLM turns the clean fix is `ask()` — it resolves only after the reply is complete (including its speech, when `voice` is on), so a plain `await` sequences everything:

```js
async function intro() {
  await whenReady(agent);
  agent.wave();
  await agent.ask('Welcome the visitor to the tour in one short sentence.');
  agent.lookAt('user');
  await agent.ask('Tell them you will keep this brief.');
  agent.playEmote('cheer');
}
```

Each line waits for the previous one to land before the next runs. The result feels deliberate — not a stuttering pile-up.

For the silent `speak()` gesture there is no completion event — but its duration is deterministic (0.3s per word, minimum 1.5s), so you can mirror it:

```js
function gestureAndWait(el, text) {
  el.speak(text);
  const secs = Math.max(1.5, text.split(' ').length * 0.3);
  return new Promise((resolve) => setTimeout(resolve, secs * 1000));
}
```

And if you're reacting to real speech (an LLM reply being voiced), `voice:speech-end` is still the event to wait on — it fires when the spoken sentence is done:

```js
function nextSpeechEnd(el) {
  return new Promise((resolve) => {
    el.addEventListener('voice:speech-end', resolve, { once: true });
  });
}
```

---

## Step 8 — Error patterns

The bulk of mistakes fall into three buckets.

**Calling methods before ready.** `agent.speak('Hi')` issued during page load, before boot finishes. The method silently no-ops because the scene isn't mounted yet. Always gate on `whenReady()` (Step 3).

**Stale element reference.** If a router swaps the page out and back in, the `<agent-3d>` element is re-created. The reference you cached is now disconnected. In SPAs, look the element up at the start of every handler, not once at module load:

```js
// Bad: cached at load time, breaks after route change
const agent = document.getElementById('agent');

// Good: fresh reference every time
function getAgent() {
  return document.getElementById('agent');
}
```

Or use a small reactive wrapper if you're inside a framework — see the [Web Component end-to-end tutorial](/tutorials/web-component-end-to-end) for React and Vue patterns.

**LLM errors during a turn.** Network glitch, brain provider rate-limit, no API key. `say()` never rejects — it shows the error in the chat bubble and fires an `agent:error` event. When you need to handle the failure programmatically, use `ask()`, which rejects:

```js
try {
  await agent.ask(userText);
} catch (err) {
  console.error('Brain call failed:', err);
  showRetryToast('Something hiccupped. Try that again?'); // your own UI
  agent.speak('Sorry about that.'); // concerned talking gesture, no brain needed
}
```

The fallback `agent.speak(...)` does *not* go through the brain (it's a silent gesture), so it works even when the LLM path is broken — pair it with your own on-page error message for the words.

---

## Step 9 — The checkout celebration flow

Time to put it all together. You run a Shopify store, a Stripe checkout, or any form-driven flow. When a user submits a successful order, you want the agent to celebrate, narrate, and settle back to idle. The whole sequence should run on the success page.

The HTML:

```html
<form id="order-form">
  <input id="order-name" placeholder="Your name" required>
  <input id="order-item" placeholder="What did you buy?" required>
  <button type="submit">Complete order</button>
</form>

<agent-3d
  id="agent"
  agent-id="YOUR_AGENT_ID"
  width="360px"
  height="480px"
></agent-3d>
```

The JS:

```js
import './app.js'; // assumes whenReady is exported there

const form = document.getElementById('order-form');
const agent = document.getElementById('agent');

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = document.getElementById('order-name').value.trim();
  const item = document.getElementById('order-item').value.trim();
  if (!name || !item) return;

  // In a real app, you'd post to your backend here and only proceed on success.
  const ok = await placeOrder({ name, item });
  if (!ok) {
    agent.say("Tell the customer their order didn't go through and to try again in a moment.");
    return;
  }

  await celebrate({ name, item });
});

async function celebrate({ name, item }) {
  await whenReady(agent);
  agent.lookAt('user');
  agent.playEmote('celebrate');
  await agent.ask(
    `The customer ${name} just completed an order for "${item}". ` +
    `Thank them by name and confirm it's on the way, in one short sentence.`
  );
  agent.wave();
}

async function placeOrder({ name, item }) {
  const res = await fetch('/api/orders', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, item }),
  });
  return res.ok;
}
```

A few things this gets right:

- The form submit is intercepted with `preventDefault` so we control the flow.
- The real network call is awaited before the celebration runs — no fake confetti on a failed order.
- An explicit error branch speaks an apology if the order didn't go through.
- The celebration sequences animation → speech → animation cleanly, so each beat lands.
- `whenReady` is called even though we expect the agent to already be booted by submit time. Cheap insurance.

If you also wanted to log the celebration upstream — to your analytics, to a CRM — you'd subscribe to `voice:speech-end` once and fire an event:

```js
agent.addEventListener('voice:speech-end', () => {
  analytics.track('agent_celebration_spoken', { name, item });
}, { once: true });
```

The `{ once: true }` flag makes sure it only fires for the first speech-end after the celebration begins, not for every future utterance.

---

## What you learned

You now have the full event lifecycle in your head:

- `agent:ready` gates every interaction
- `brain:thinking`, `brain:stream`, `brain:message` cover the LLM round-trip
- `voice:speech-start` / `voice:speech-end` cover the spoken output
- `skill:tool-start` / `skill:tool-called` tell you when a skill ran
- `memory:write` tells you when something was committed to memory

And the methods you'll reach for most:

- `agent.speak(text)` for cheap, deterministic lines
- `agent.say(text)` for full LLM-driven turns
- `agent.wave()`, `agent.lookAt(target)`, `agent.playEmote(name)` for visual beats
- `agent.play(name)` for direct, exact-clip control
- `agent.clearConversation()` to reset rolling memory

The `whenReady`, awaited-`ask()`, and try/catch patterns are small but they remove almost every gotcha. Steal them.

## Next steps

- [Use the &lt;agent-3d&gt; web component end-to-end](/tutorials/web-component-end-to-end) — same API, in React, Vue, and your component system
- [Trigger the agent from page events](/tutorials/trigger-from-page-events) — scroll, route changes, idle time, onboarding flows
- [Give your agent a personality](/tutorials/agent-personality) — write a system prompt that holds across thousands of chats
