# Multi-Agent Coordination

By the end of this tutorial you'll have a working team of agents that collaborate to solve a single task. Two agents on the same page, both visible, taking turns and handing off based on what the visitor actually needs. The handoff is explicit, the shared context is bounded, and the conflict-resolution rules are spelled out — not vibes.

This tutorial assumes you've built at least one agent ([first-agent](/tutorials/first-agent)) and shipped a custom skill ([custom-skill](/tutorials/custom-skill)). Comfort with the embed API, manifest format, and skill bundle layout is required.

**What you'll build:**

- A "sales + technical" pair: a friendly sales agent that greets visitors and a technical agent that takes over for deep questions
- An explicit handoff protocol: who's speaking, who's listening, when to hand off, how
- A shared scratch memory so the second agent picks up context without re-asking
- A simple conflict-resolution rule for when both agents want to speak
- Concrete patterns for sequential delegation, parallel fan-out, and turn-taking
- A working "I don't actually need two agents, I need two skills" alternative you can fall back to

**Prerequisites:**

- Two saved agents in your dashboard at `https://three.ws/dashboard`. They can be variants of the same avatar or two completely different characters.
- A live web page where you can add a `<script>` tag and two `<agent-3d>` elements, and own the surrounding HTML/JS. A static `.html` file served by `npx serve .` is enough to get started.
- Familiarity with the embed JS API (`say`, `ask`, `play`, events like `brain:message`, `voice:speech-end`, `agent:ready`). The reference is in [js-api-events](/tutorials/js-api-events) and the source of truth is the published bundle at `https://three.ws/agent-3d/1.5.2/agent-3d.js`.
- Each agent has a personality configured. See [agent-personality](/tutorials/agent-personality) if either of yours doesn't yet — they need distinct voices for the handoff to feel coherent.

---

## Step 1 — When two agents is the wrong answer

Before you build a coordination layer, satisfy yourself that you genuinely need two agents. The cheapest answer to almost every multi-agent question is **one agent with two skills**.

A skill bundle (see [custom-skill](/tutorials/custom-skill)) adds capability to one agent — a tool to invoke, a behavioral contract to follow, optional 3D assets to load. If your "two agents" really means "one persona that knows about both topics," that's a one-agent-two-skills shape and you should build it as one agent.

You actually need two agents when:

- You want two **visible characters** on the page at the same time (a salesperson and an engineer; a teacher and a student; an interviewer and a candidate). The 3D presence is the point.
- You want **two different operators** — e.g., the sales agent is owned by your company, the technical agent is owned by an open-source vendor whose docs are embedded.
- You want a **clean failure boundary** — if the technical agent goes down, the sales agent should still work and gracefully apologize for its absent colleague.
- You want **independent rate-limit budgets** — the technical agent uses a more expensive LLM and has a tighter cap on calls per visitor.

If none of those are true, stop here and instead read [custom-skill](/tutorials/custom-skill) — combine the two specialties into one agent with two skills.

The rest of this tutorial assumes you've decided yes, two agents.

---

## Step 2 — The example we'll build

A SaaS pricing page. Two agents:

- **Riley (Sales)** — front-of-stage. Greets visitors, answers high-level pricing/positioning questions, sniffs intent. Cheap LLM (Claude Haiku or GPT-5.6 Luna class).
- **Devon (Engineer)** — stays in the background until summoned. Answers integration, security, architecture, and SDK questions. More expensive LLM (Claude Sonnet/Opus class) because the answers must be technically accurate.

The handoff rule is concrete: when Riley detects a "deep technical" question, Riley narrates the handoff and Devon steps forward. When Devon's done, control returns to Riley. There's a shared scratch memory so Devon knows what Riley already covered.

This is a real product pattern. Pricing pages have always had a buy-now button next to a "talk to engineering" link. We're making the page do that flow inline, with two agents that talk to each other and to the visitor.

---

## Step 3 — Page layout

A two-agent layout where both characters are always visible. Riley on the left, Devon on the right, one shared chat input.

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>Pricing — talk to Riley and Devon</title>
    <script type="module" src="https://three.ws/agent-3d/1.5.2/agent-3d.js"></script>
    <style>
      body { margin: 0; font-family: system-ui, sans-serif; background: #0b0b10; color: #fff; }
      .stage { display: grid; grid-template-columns: 1fr 1fr; height: 60vh; gap: 1rem; padding: 1rem; }
      .stage > div { background: #14141c; border-radius: 12px; overflow: hidden; position: relative; }
      .stage h3 { position: absolute; top: 12px; left: 16px; margin: 0; font-size: 14px; letter-spacing: 0.04em; }
      .stage .active { box-shadow: 0 0 0 2px #6366f1; }
      .chat { padding: 1rem; max-width: 760px; margin: 0 auto; }
      .chat input { width: 100%; padding: 12px 16px; font-size: 16px; border-radius: 10px; border: 1px solid #2a2a3a; background: #14141c; color: #fff; }
      .log { margin-top: 1rem; line-height: 1.5; font-size: 14px; }
      .log .msg { margin: 6px 0; padding: 8px 12px; border-radius: 8px; background: #1a1a25; }
      .log .who { color: #8b8baa; font-size: 11px; text-transform: uppercase; letter-spacing: 0.08em; }
    </style>
  </head>
  <body>
    <div class="stage">
      <div id="riley-stage" class="active">
        <h3>Riley · Sales</h3>
        <agent-3d id="riley" agent-id="<RILEY_AGENT_ID>" avatar-chat="off" voice eager
                  style="width:100%;height:100%"></agent-3d>
      </div>
      <div id="devon-stage">
        <h3>Devon · Engineering</h3>
        <agent-3d id="devon" agent-id="<DEVON_AGENT_ID>" avatar-chat="off" voice eager
                  style="width:100%;height:100%"></agent-3d>
      </div>
    </div>
    <div class="chat">
      <input id="msg" placeholder="Ask anything — pricing, integration, security…" autofocus />
      <div id="log" class="log"></div>
    </div>
    <script type="module" src="./coordinator.js"></script>
  </body>
</html>
```

One loader `<script>` in the `<head>` registers the `<agent-3d>` element; two tags with `agent-id` attributes point at your saved agents. Three attribute choices matter here: `avatar-chat="off"` hides each agent's built-in chat input (this page has its own shared composer), `voice` enables text-to-speech so the avatars actually speak their replies (and fire the `voice:speech-start`/`voice:speech-end` events we lean on later), and `eager` boots both agents immediately instead of waiting for them to scroll into view. `coordinator.js` is the file we'll write next.

Replace `<RILEY_AGENT_ID>` and `<DEVON_AGENT_ID>` with the actual agent IDs from your dashboard. They're displayed under each agent in `https://three.ws/dashboard`.

---

## Step 4 — The coordinator's job

The coordinator is the small piece of JavaScript on the page that decides which agent speaks. It does five things:

1. **Wait for both agents to be `agent:ready`.** Until then, hold the user's input.
2. **Pick a starting agent.** Default: Riley.
3. **Route the user's message.** Pass it to the current agent.
4. **Listen for handoff signals.** A handoff is the current agent saying "I'm going to hand you to <other agent>." We detect it from `brain:message` events.
5. **Maintain shared scratch memory.** When a handoff happens, the new agent gets a brief that contains what the previous agent did.

Create `coordinator.js`:

```js
// coordinator.js — two-agent turn manager
const riley = document.getElementById('riley');
const devon = document.getElementById('devon');
const input = document.getElementById('msg');
const log = document.getElementById('log');

const rileyStage = document.getElementById('riley-stage');
const devonStage = document.getElementById('devon-stage');

const state = {
  active: null,            // the currently-speaking agent element
  ready: { riley: false, devon: false },
  scratch: [],             // shared transcript shared on handoff
};

function appendLog(who, text) {
  const div = document.createElement('div');
  div.className = 'msg';
  div.innerHTML = `<div class="who">${who}</div>${text}`;
  log.appendChild(div);
  log.scrollTop = log.scrollHeight;
}

function setActive(agentEl) {
  state.active = agentEl;
  rileyStage.classList.toggle('active', agentEl === riley);
  devonStage.classList.toggle('active', agentEl === devon);
}

function onReady(name, el) {
  return () => {
    state.ready[name] = true;
    appendLog('system', `${name} ready.`);
    if (state.ready.riley && state.ready.devon) {
      setActive(riley);
      riley.say(
        "Introduce yourself to the visitor in one or two sentences: you're Riley " +
        "from sales, and your colleague Devon is on hand for deep technical questions."
      );
    }
  };
}

riley.addEventListener('agent:ready', onReady('riley', riley));
devon.addEventListener('agent:ready', onReady('devon', devon));
```

This boots both agents, marks both `agent:ready`, then has Riley introduce the pair. Devon stands by silently. `say(text)` pushes a message into the agent's conversation exactly as if the visitor typed it — here it carries a stage direction, and Riley's brain generates the actual greeting, which arrives via the `brain:message` event we wire next.

---

## Step 5 — Routing user input

The shared input box sends to the active agent via the same `say()` method we used for the greeting — it pushes a message into the agent's conversation as if the user typed it directly:

```js
input.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' || !input.value.trim()) return;
  const text = input.value.trim();
  input.value = '';
  if (!state.active) return;     // not ready yet
  appendLog('you', text);
  state.scratch.push({ role: 'user', content: text });
  state.active.say(text);
});
```

The agent's response comes back via the `brain:message` event:

```js
function wireMessages(name, el) {
  el.addEventListener('brain:message', (e) => {
    const { role, content } = e.detail;
    if (role === 'assistant' && content) {
      appendLog(name, content);
      state.scratch.push({ role: 'assistant', name, content });
      considerHandoff(name, content);
    }
  });
}
wireMessages('riley', riley);
wireMessages('devon', devon);
```

`state.scratch` is the shared transcript. Both agents append to it, and at the moment of a handoff we'll inject a summary of it into the new active agent.

---

## Step 6 — The handoff signal

Two ways to detect that the current agent wants to hand off:

**(a) Marker in the message text.** Cheap and reliable. The agent's system prompt tells it to emit a sentinel string when it wants to delegate. Easy to parse, easy to debug, doesn't depend on tool-use availability.

**(b) Dedicated tool call.** Add a `handoff_to_devon()` tool to Riley's skill bundle. Cleaner in principle, more moving parts in practice.

We'll use (a) because it works with any LLM, any agent, no skill bundle required.

In Riley's system prompt (set via the agent's "Personality" tab in the editor, or via the manifest's `instructions.md` file), append:

```
You are Riley, the sales lead on this pricing page. Devon, our staff
engineer, is here to handle deep technical questions. When the visitor
asks something genuinely technical (architecture, SDKs, security
posture, integration mechanics, on-prem options, latency budgets, data
residency, encryption-at-rest details), say one sentence acknowledging
the question and then emit exactly this line on its own:

[HANDOFF→DEVON]

After the marker, stop. Do not answer the technical question yourself.
Devon will pick up.

Topics that are NOT technical handoffs (you should answer these
yourself): pricing tiers, plan comparisons, billing cycles, refund
policy, trial length, who else uses us, marketing claims.
```

In Devon's system prompt:

```
You are Devon, the staff engineer on this pricing page. Riley, our
sales lead, just handed off to you because the visitor has a technical
question. Read the conversation so far carefully. Answer with
specificity — version numbers, RFCs, concrete architecture details.
Don't repeat what Riley already said.

If the question turns back to commercial topics (price, contract,
billing), wrap up briefly and emit:

[HANDOFF→RILEY]

After the marker, stop. Riley will pick up.
```

Now the coordinator watches for those markers:

```js
const HANDOFF_RX = /\[HANDOFF→(RILEY|DEVON)\]/i;

function considerHandoff(speakerName, text) {
  const m = text.match(HANDOFF_RX);
  if (!m) return;
  const target = m[1].toLowerCase();
  if (target === speakerName) return; // sanity: don't hand off to yourself

  const targetEl = target === 'riley' ? riley : devon;

  // Build a brief: last 6 turns + a one-line summary of what just happened.
  const brief = buildBrief(state.scratch, target);

  setActive(targetEl);
  appendLog('system', `→ handoff to ${target}`);
  // Inject the brief into the new active agent's conversation.
  targetEl.say(brief);
}

function buildBrief(scratch, target) {
  const recent = scratch.slice(-6);
  const transcript = recent
    .map((m) => {
      if (m.role === 'user') return `Visitor: ${m.content}`;
      return `${m.name || 'Assistant'}: ${m.content}`;
    })
    .join('\n');
  return [
    `[Stage director: you (${target}) are now the active speaker on the page.`,
    'Read the recent conversation below and continue from where it left off.',
    'Speak directly to the visitor; do not address the other agent by name.]',
    '',
    transcript,
  ].join('\n');
}
```

`targetEl.say(brief)` pushes the brief into the target agent's conversation as an ordinary message — there is no separate system-role channel, which is exactly why `buildBrief` wraps the transcript in an explicit `[Stage director: …]` framing: the model reads the bracketed preamble as direction rather than visitor speech, and responds with its next visitor-facing message. Because both elements run with `avatar-chat="off"`, the brief never renders anywhere the visitor can see; the only transcript on the page is the one your `brain:message` handler builds in the log.

---

## Step 7 — Hide the handoff marker from the user

The marker `[HANDOFF→DEVON]` is useful to the coordinator but ugly to the visitor. Strip it before logging:

```js
function cleanForUser(text) {
  return text.replace(HANDOFF_RX, '').trim();
}

function wireMessages(name, el) {
  el.addEventListener('brain:message', (e) => {
    const { role, content } = e.detail;
    if (role !== 'assistant' || !content) return;
    const cleaned = cleanForUser(content);
    if (cleaned) appendLog(name, cleaned);
    state.scratch.push({ role: 'assistant', name, content });
    considerHandoff(name, content);
  });
}
```

The `state.scratch` keeps the raw text (so the brief built in `buildBrief` is faithful to what the model actually said), but the UI only shows the cleaned version.

---

## Step 8 — Speech-end synchronization

Because both elements carry the `voice` attribute from Step 3, every reply is spoken aloud: the runtime fires `voice:speech-start` when TTS begins and `voice:speech-end` when the avatar finishes saying its line (without `voice`, neither event fires). Use the pair to gate the next user input:

```js
let speaking = false;

function wireSpeechGate(el) {
  el.addEventListener('voice:speech-start', () => { speaking = true; input.disabled = true; });
  el.addEventListener('voice:speech-end', () => { speaking = false; input.disabled = false; input.focus(); });
}
wireSpeechGate(riley);
wireSpeechGate(devon);
```

Without this, an eager visitor types over the avatar's spoken response and the conversation tangles. With it, each turn completes cleanly.

For a handoff specifically, you want the OLD agent's `voice:speech-end` to fire *before* the NEW agent starts speaking. The event order is naturally correct because the coordinator calls `targetEl.say(brief)` immediately, but the new agent doesn't start speaking until its LLM responds — which is well after the old agent finished its last syllable. No extra coordination needed in practice.

---

## Step 9 — Test the happy path

Open the page. Watch for:

1. Both agents load. Riley waves and says hi.
2. Type "what does the team plan cost?" → Riley answers (sales topic, no handoff).
3. Type "do you encrypt data at rest, and how does key rotation work?" → Riley acknowledges the question, the coordinator detects `[HANDOFF→DEVON]`, the active indicator moves to Devon's stage, Devon answers with specifics about KMS, key rotation cadence, etc.
4. Type "great, what's the price for that?" → Devon wraps up, emits `[HANDOFF→RILEY]`, control returns to Riley, Riley quotes the plan.

If any of those fail, the typical causes:

- **Riley doesn't hand off.** The system prompt isn't strong enough. Make the trigger list more concrete or use few-shot examples in the prompt.
- **Devon answers technical questions Riley should have answered.** Check that the handoff topics list in Riley's prompt is *exclusive* — explicitly say "do NOT hand off when the visitor asks X."
- **Both agents speak at once.** The `voice:speech-start`/`voice:speech-end` gate isn't wired, or one of the agents is mis-receiving the chat input. Confirm `state.active` is correctly set and the `say()` call only goes to `state.active`.

---

## Step 10 — Pattern: parallel fan-out

The example so far is **sequential delegation** — one agent speaks at a time. The other big multi-agent pattern is **parallel fan-out**: two agents work simultaneously on different parts of a task and the coordinator joins the results.

A concrete example: a research agent and a copy-editor agent. The visitor asks "draft a 200-word blog post on the new feature." The research agent gathers facts; the copy-editor agent drafts the prose using those facts.

The primitive that makes this work is `ask()` — the promise-returning sibling of `say()`. It sends a message into the agent's conversation and resolves with the assistant's reply text, so the coordinator can `await` both agents at once and join the results:

```js
async function parallelTask(userPrompt) {
  const [facts, outline] = await Promise.all([
    researcher.ask(
      `List the verifiable facts we can cite about: ${userPrompt}. Bullet points only.`
    ),
    writer.ask(
      `Draft a tight outline for a 200-word blog post on: ${userPrompt}. Headings only.`
    ),
  ]);
  // Join: hand the researcher's facts to the writer for the final pass.
  return writer.ask(
    `Write the final 200-word post from your outline, using only these facts.\n\n` +
    `Facts:\n${facts}\n\nOutline:\n${outline}`
  );
}
```

If either agent does its part through tools — a skill bundle that fetches a feed, hits an API, reads a knowledge base — you can observe every call from the page via the `skill:tool-start` and `skill:tool-called` events:

```js
researcher.addEventListener('skill:tool-called', (e) => {
  const { tool, result } = e.detail;
  console.log('researcher ran', tool, result);
});
```

Build the tools themselves as skills (see [custom-skill](/tutorials/custom-skill)); the orchestration logic stays in the coordinator on the page.

There's also a platform-native alternative to page-level orchestration: the `<agent-stage>` element. A stage hosts every child `<agent-3d>` in one shared WebGL scene (with a `formation` attribute — `row`, `circle`, or `freeform`), exposes `getAgents()`, `broadcast(fromId, event)`, and `routeMessage(fromId, toId, text)` to your code, and grants each staged agent two extra built-in tools — `observe_agents` (who else is on stage) and `say_to_agent` (address a colleague directly) — so the LLMs can delegate to each other without any coordinator glue. When the agents, not the page, should decide who does what, reach for the stage. The full patterns are in [Multi-Agent Scenes](../multi-agent.md).

Parallel fan-out is **harder to debug** than sequential delegation because errors are non-deterministic in order and any latency outlier blocks the join. Use it when the wall-clock saving is worth the complexity. For a chat UX with a human in the loop, sequential is almost always the right default.

---

## Step 11 — Pattern: shared scratch memory

The `state.scratch` we built earlier is shared transcript. A richer version is a **structured scratch** that both agents can read and write — useful for tasks where the agents collaborate on a non-textual artifact (a form being filled in, a JSON spec being constructed, a 3D scene being arranged).

Shape:

```js
const scratch = {
  visitor: { name: null, email: null, company_size: null },
  needs: { plan: null, integrations: [], compliance_requirements: [] },
  draft_quote: null,
};

function writeToScratch(path, value) {
  // path like 'visitor.name'
  const segs = path.split('.');
  let cur = scratch;
  for (let i = 0; i < segs.length - 1; i++) cur = cur[segs[i]];
  cur[segs[segs.length - 1]] = value;
}

function readScratch() {
  return JSON.parse(JSON.stringify(scratch));
}
```

Expose `writeToScratch` and `readScratch` as tools each agent can call (via a skill bundle). Now Riley writes `visitor.company_size = "50-200"` and `needs.plan = "team"` based on the conversation; Devon reads it to compute deployment recommendations without re-asking the visitor.

Pitfalls:

- **Schema drift.** If both agents write to overlapping keys, you get races. Define ownership: Riley owns `visitor.*` and `needs.plan`; Devon owns `needs.integrations` and `needs.compliance_requirements`.
- **No history.** The scratch is current state, not a log. Keep the transcript scratch (Step 5) alongside the structured scratch — they serve different purposes.
- **Stale data.** When a turn ends, snapshot the scratch into `state.scratch` so a misbehaving agent that overwrote something can be unwound.

---

## Step 12 — Pattern: conflict resolution

Two agents that both want to speak is a fixable bug. Two agents that disagree about an answer is a design problem.

The cleanest rule for conflict on a UX surface: **one agent has the floor; the other is silent unless given the floor.** No simultaneous speech. The handoff marker is the only legal way to transfer the floor.

That handles the UX. What about substantive disagreement — Riley says "we support SOC2," Devon corrects with "we support SOC2 Type II but not Type I"? The fix is upstream of the runtime: **the system prompts must define one source of truth per topic.** Sales never makes claims about compliance; engineering never makes claims about pricing. If both must speak about a topic, the system prompt assigns a primary and a deferrer:

```
Riley: When asked about compliance, do not list specifics. Hand off to Devon.
Devon: When asked about pricing, do not name numbers. Hand off to Riley.
```

The runtime cannot fix prompts that contradict each other. Catch contradictions during prompt review, not in production.

---

## Step 13 — Pattern: turn-taking with no human

Sometimes the two agents are talking to each other, with the human watching. A debate, a roleplay, a brainstorm. This is the cleanest pattern in terms of code (no human input gate; each turn feeds the previous reply to the other agent) and the hardest pattern in terms of LLM behavior (without grounding in real user input, both agents drift into hallucinated agreement after about six turns).

Concrete loop — `ask()` does all the sequencing for you, because with `voice` enabled it resolves only after the reply has been generated *and* spoken:

```js
async function autoplay(topic, turns = 6) {
  let speaker = riley;
  let prompt = `Let's debate this: ${topic}. Open with your position in two sentences.`;
  for (let i = 0; i < turns; i++) {
    setActive(speaker);
    const reply = await speaker.ask(prompt);
    prompt = `The other debater said: "${reply}". Respond in two sentences.`;
    speaker = speaker === riley ? devon : riley;
    // Brief beat between turns so the handover doesn't feel robotic.
    await new Promise((r) => setTimeout(r, 800));
  }
}
```

For a demo this is great. For anything load-bearing, cap `turns` aggressively and have a third "moderator" agent (or just code-as-moderator) stop the loop when the conversation stops making progress.

---

## Step 14 — When you really should just have used skills

After building all the above, look at your two agents critically:

- Do both characters have a meaningful 3D presence the user benefits from? If no, you've used 3D as a stylistic choice that costs you a second LLM budget — collapse to one agent.
- Are the handoff topics genuinely orthogonal? If sales topics and technical topics blur in 30% of conversations, the handoff is a constant interruption. Collapse to one agent with two skills.
- Does either agent ever do anything different from the other except answer questions? If both are just chat, there's nothing to coordinate — collapse.

The skills-only alternative for this exact example:

- One agent ("Riley + Devon")
- Two skills: `sales-handbook` (a SKILL.md with pricing details) and `engineering-handbook` (a SKILL.md with technical specifics)
- One LLM call per turn, no handoff complexity, no shared scratch needed

That alternative loses the visual-handoff effect but gains massive simplicity. Real product teams almost always end up there. Build the two-agent version when the visual is the product.

---

## Step 15 — Operational considerations

When you go from a demo to production, two-agent pages introduce real concerns:

**LLM budget.** Two agents are two budgets. If each visitor's session does six turns and each turn is two agents (one speaking, one preloading context on handoff), your token spend per visitor is meaningfully higher than a single agent. Profile it.

**Latency.** The handoff cost is one extra LLM round trip (the brief injected as a stage direction triggers a response). Visible to the user as ~1.5 extra seconds. Acceptable for a substantive question, intolerable for trivial ones — which is why the handoff list in Riley's prompt must be restrictive.

**Failure modes.** Devon's LLM provider goes down. Now Riley still works but the handoff lands on a dead agent. Mitigation: deliver the brief with `ask()` instead of `say()` — same send, but it returns a promise you can race against a timeout — and fall back to Riley on failure. Note the fallback message is a stage direction, not a scripted line: Riley's brain generates the actual apology in Riley's voice.

```js
async function safeHandoff(targetEl, brief, fallbackEl, originalQuestion) {
  try {
    await Promise.race([
      targetEl.ask(brief),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('handoff timed out')), 8000)),
    ]);
  } catch (err) {
    setActive(fallbackEl);
    fallbackEl.say(
      "Devon is unavailable right now. Apologize briefly, take your best shot at " +
        "the visitor's technical question yourself, and offer a written follow-up. " +
        "The question was: " + originalQuestion
    );
  }
}
```

**Observability.** Log every handoff (which agent, which topic, what the user asked next). Over a week, you'll have data on whether Riley is over- or under-handing-off. Tune the prompt accordingly.

**Embeds on third-party sites.** If you ship this two-agent page as an embed, both `agent-id`s are visible in the page source — anyone can see which agents you're using. That's by design; the agents are public artifacts. If you don't want them publicly identifiable, mark them as unlisted in the dashboard (they remain reachable by ID but don't appear in `/explore`).

---

## What you learned

- The decision criteria for "is two agents the right shape, or do I really want one agent with two skills?"
- A working sequential-delegation pattern with explicit handoff markers
- Shared scratch memory: transcript form (logged exchanges) and structured form (typed state)
- The other two patterns — parallel fan-out and turn-taking — and when they fit
- Conflict resolution rules: one floor at a time, prompt-level source-of-truth assignments
- Production concerns: budget, latency, fallbacks, observability

## Next steps

- Give each agent a sharper, distinct personality so the handoff feels natural — [agent-personality](/tutorials/agent-personality)
- Expose either agent as an MCP server so external clients can call it as a tool — [mcp-server-for-your-agent](/tutorials/mcp-server-for-your-agent)
- Have one agent pay another for work via x402 — [paid-x402-endpoint](/tutorials/paid-x402-endpoint)
- Build a database-backed skill that both agents share — [skill-with-database-auth](/tutorials/skill-with-database-auth)
