# Multi-Agent Scenes

A multi-agent scene loads two or more `<agent-3d>` characters simultaneously — each with its own brain, memory, and persona — sharing a common stage. Use cases include:

- A debate between two AI characters
- A customer support agent paired with a product expert
- An educational scene with a teacher and a student
- A marketplace with multiple vendor agents
- An interview panel

This guide covers the two main approaches — a **shared stage** (one WebGL context, recommended) and **side-by-side embeds** (independent contexts) — plus agent communication, turn-based conversations, orchestration patterns, memory sharing, and performance limits.

---

## The simplest setup: `<agent-stage>`

The `<agent-stage>` element is a shared scene host. All `<agent-3d>` children render inside a single WebGL canvas — one renderer, one context, positioned automatically in a named formation.

```html
<script type="module" src="https://three.ws/agent-3d/latest/agent-3d.js"></script>

<agent-stage id="stage" formation="row" style="width:100%;height:540px">
  <agent-3d
    id="leo"
    name="Coach Leo"
    body="/avatars/leo.glb"
    instructions="You are Coach Leo. Friendly, short answers."
    eager
  ></agent-3d>

  <agent-3d
    id="mira"
    name="Mira"
    body="/avatars/mira.glb"
    brain="none"
    instructions="You are Mira, a quiet observer who only speaks when spoken to."
    eager
  ></agent-3d>
</agent-stage>
```

The `formation` attribute controls avatar placement:

| Value | Layout |
|---|---|
| `row` | Side by side, evenly spaced |
| `circle` | Equidistant around a centre point |
| `freeform` | All overlapping at origin — position manually |

Each `<agent-3d>` child keeps its own brain, memory, and chat chrome. Setting `brain="none"` gives an agent a live avatar with animations and emotions but no LLM — useful for characters that only react, or that you drive programmatically.

See the full working example at `/examples/two-agents.html`.

---

## Alternative: side-by-side embeds

If you don't need a shared 3D space, you can place two independent `<agent-3d>` elements anywhere on the page. Each creates its own WebGL context and is completely self-contained.

```html
<div style="display:flex;gap:16px">
  <agent-3d
    id="host"
    body="/avatars/aria.glb"
    instructions="You are Aria, the host."
    style="width:300px;height:400px"
    eager
  ></agent-3d>

  <agent-3d
    id="guest"
    body="/avatars/leo.glb"
    instructions="You are Leo, the guest."
    style="width:300px;height:400px"
    eager
  ></agent-3d>
</div>
```

This approach is simpler to set up but costs two WebGL contexts. Read the [WebGL context limits](#webgl-context-limits) section before using it on mobile or with more than a few agents.

---

## Making agents communicate

By default, each agent's brain is isolated. To make agents interact, use the host page as coordinator.

### Using `stage.routeMessage()`

When agents live inside an `<agent-stage>`, use `routeMessage` to send one agent's reply directly to another:

```js
const stage = document.getElementById('stage');
const leo   = document.getElementById('leo');

leo.addEventListener('brain:message', async (e) => {
  if (e.detail.role !== 'assistant') return;
  const said = e.detail.content;

  // Forward what Leo said to Mira
  const reply = await stage.routeMessage('leo', 'mira', said);
  console.log('Mira replied:', reply.reply);
});
```

`routeMessage(fromId, toId, text)` prefixes the message with `[from leo]` so the receiving agent knows who is speaking. It returns `{ ok: true, reply: '...' }` on success, or `{ ok: false, error: '...' }` if the target agent ID wasn't found.

### Using `stage.broadcast()`

`broadcast(fromId, event)` sends a custom event payload to every other agent on stage. Each target agent receives a `stage:message` DOM event:

```js
// Fire a cue to all agents on stage
stage.broadcast('test-harness', { kind: 'cue', text: 'Start the debate.' });

// Each child agent-3d receives:
leo.addEventListener('stage:message', (e) => {
  console.log(e.detail.from, e.detail.event);
  // → "test-harness" { kind: "cue", text: "Start the debate." }
});
```

`broadcast` is useful for scene cues that every agent should react to — a director's "action" call, a timed stage event, or a user interaction that should affect all characters simultaneously.

### Bridging side-by-side embeds manually

For standalone `<agent-3d>` elements without an `<agent-stage>`, bridge agents through the `brain:message` event:

```js
const host  = document.getElementById('host');
const guest = document.getElementById('guest');

host.addEventListener('brain:message', async (e) => {
  if (e.detail.role !== 'assistant') return;

  // Pass the host's reply into the guest's context
  await guest.say(`Host said: "${e.detail.content}" — How do you respond?`);
});
```

The `brain:message` event fires for both `role: "user"` and `role: "assistant"` turns. Always check `e.detail.role` before triggering the other agent, or you will create a feedback loop.

---

## Turn-based conversation

To automate a full back-and-forth between two agents, use `ask()` — which sends a message and returns the reply text — inside a recursive turn loop:

```js
const agents = [leo, mira];
let turn = 0;

async function nextTurn(previousSpeech) {
  if (turn >= 10) return; // limit to 10 turns

  const speaker = agents[turn % 2];
  const prompt  = turn === 0
    ? 'Start the conversation with a greeting.'
    : `The other character said: "${previousSpeech}". Respond to them.`;

  const reply = await speaker.ask(prompt);
  turn++;

  // Brief pause so TTS and animations finish before the next prompt
  await new Promise(r => setTimeout(r, 1500));
  nextTurn(reply);
}

// Start once both agents are ready
let readyCount = 0;
for (const el of [leo, mira]) {
  el.addEventListener('agent:ready', () => {
    if (++readyCount === 2) nextTurn('');
  }, { once: true });
}
```

`ask(text)` is a convenience wrapper around `say(text)` that resolves to the assistant's reply string. If the runtime is still processing a previous turn, `say()` throws — add a `try/catch` in production loops to recover gracefully instead of crashing the conversation.

---

## Stage events

`<agent-stage>` fires lifecycle events as agents join or leave:

```js
stage.addEventListener('stage:agent-joined', (e) => {
  console.log('joined:', e.detail.agentId, e.detail.manifest?.name);
});

stage.addEventListener('stage:agent-left', (e) => {
  console.log('left:', e.detail.agentId);
});

stage.addEventListener('stage:message', (e) => {
  // Fires whenever broadcast() is called
  console.log('broadcast from', e.detail.from, e.detail.event);
});
```

You can inspect and modify the agent lineup at runtime:

```js
// Query who's on stage
stage.getAgents();
// → [{ agentId: 'Coach Leo', name: 'Coach Leo', position: [-0.55, 0, 0], element }, ...]

// Add a new agent dynamically
const el = await stage.addAgent({ name: 'Extra', body: { uri: '/avatars/extra.glb' } });

// Remove by agentId
stage.removeAgent('Coach Leo');
```

---

## Orchestration patterns

Three patterns cover most multi-agent scenes:

**Pattern A — Parallel (independent)**

Both agents receive the same user message and respond independently. Good for showing different perspectives or running an agent comparison side by side.

```
User message → broadcast to both → both respond concurrently
```

Implementation: call `leo.say(text)` and `mira.say(text)` without waiting for either to finish. Both brains run in parallel.

**Pattern B — Sequential (turn-based)**

Agents alternate, each responding to what the other said. Good for debates, interviews, or structured storytelling. The turn-loop above implements this pattern.

```
User → Agent 1 → Agent 2 → Agent 1 → ...
```

**Pattern C — Hierarchical (manager + specialists)**

One manager agent receives all user input, decides which specialist to involve, and synthesizes the result. Good for complex domains where no single agent has complete knowledge — for example, a triage agent routing medical questions to a pharmacology specialist and a symptoms specialist separately.

```
User → Manager (routes) → Specialist → Manager (synthesizes) → User
```

Implement Pattern C by giving the manager agent a custom skill that calls `stage.routeMessage()` to query a specialist, then incorporates the returned text into its own final reply.

---

## Agent-to-agent context sharing

Agents don't share memory by default. Each agent's memory is namespaced to its `name` or `agent-id`. To inject information from one agent's conversation into another's context, write to the target agent's memory explicitly:

```js
leo.addEventListener('brain:message', async (e) => {
  if (e.detail.role !== 'assistant') return;

  // Write Leo's reply into Mira's memory so she has context
  await mira.memory.note('shared_context', { from: 'leo', text: e.detail.content });
});
```

For a fully shared namespace across agents, set both to the same IPFS memory namespace in their manifests:

```json
{
  "memory": {
    "mode": "ipfs",
    "namespace": "shared-scene-001"
  }
}
```

Both agents then read from and write to the same memory bundle. New memories written by Leo during a conversation will be visible to Mira on her next turn. Note that the `encrypted-ipfs` mode is not yet fully wired; use plain `ipfs` for shared scenes.

---

## WebGL context limits

Browsers cap the number of active WebGL contexts per page. The typical limit is **8–16 on desktop**, and as low as **4 on mobile**. Exceeding it causes older contexts to be silently lost — avatars freeze or disappear without an error.

**`<agent-stage>` uses one context for all children.** Two agents inside an `<agent-stage>` consume one context total. This is its primary advantage over side-by-side embeds.

Two standalone `<agent-3d>` elements each consume their own context. Keep the total count low (≤ 3–4) on pages that also use other WebGL libraries such as maps, data visualizations, or other 3D widgets.

To release a context when an agent is no longer needed:

```js
el.destroy(); // tears down the runtime and releases the WebGL context
el.remove();  // remove from DOM
```

**Test on actual mobile hardware.** Browser DevTools emulation does not enforce the lower context limits that real mobile devices impose.

---

## Performance considerations

Running multiple LLM connections simultaneously is expensive, especially when most agents are idle at any given moment.

**Recommendations:**

- Set `brain="none"` on agents that only react (animations, emotion blends) rather than generate text. The avatar and empathy layers are cheap; the LLM layer is not.
- Call `el.pause()` on agents waiting for their turn in a sequential scene. This cancels any in-progress TTS and STT. Call `el.say()` to resume when it's their turn again.
- Avoid turn loops that fire without a delay. Add at least 1–1.5 seconds between turns so TTS and animations finish before the next prompt starts.
- On mobile, prefer `formation="row"` with two agents maximum. The shared-stage approach keeps GPU work to a single draw pass per frame regardless of how many agents are loaded.
- If you need more than four agents on the same page, use `<agent-stage>` for all of them rather than standalone elements. One shared context handles any number of agents without hitting browser limits.

---

## Walking through the example

Open `/examples/two-agents.html` to see a complete, runnable scene with real avatar files. Key things to notice:

1. **Single `<agent-stage>` with `formation="row"`** — both agents share one canvas and one WebGL context. No separate renderers.
2. **Leo has a brain; Mira has `brain="none"`** — Leo drives the conversation; Mira is an avatar waiting to be spoken to. Her animations and emotions still run; her LLM does not.
3. **"Send to Leo" button calls `leo.say(text)`** — the user's message goes only to Leo's brain.
4. **"Broadcast" button calls `stage.broadcast('test-harness', {...})`** — demonstrates the stage's event bus. Both Leo and Mira receive the `stage:message` event.
5. **The log panel subscribes to `brain:message` and `skill:tool-called`** — shows how to observe what each agent is thinking and doing in real time without touching their internals.

To extend this into a full turn-based scene, add a `brain` attribute to Mira with a model name (e.g., `brain="claude-haiku-4-5"`), then wire the `brain:message` listener to call `stage.routeMessage('leo', 'mira', said)` after each of Leo's replies. That is the minimal diff between a one-active-agent demo and a full dialogue scene.
