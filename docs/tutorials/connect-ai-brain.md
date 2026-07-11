# Connect Anthropic or OpenAI as the brain

The agent's body is the avatar. The agent's voice is the TTS. The agent's *brain* is whatever LLM is generating its replies. By default the platform routes through a managed Claude endpoint, which works out of the box but bills against your free tier. The moment you want real production traffic, full control over which model runs, or your own usage observability, you bring your own API key.

This tutorial covers the whole brain layer. Where the LLM call actually happens (and why your key never ends up in HTML), how to attach your Anthropic or OpenAI key in My Agents, choosing between Claude Sonnet 4.6, Claude Opus 4.7, GPT-4o, GPT-5, and the smaller models, the latency and cost tradeoffs, configuring streaming and system prompts, tool-use support per model, and where to watch your token spend. The embed snippet doesn't change when you switch models — every config is on the agent record.

**What you'll build:**
- An agent powered by your own Anthropic key, with model selection
- An agent powered by your own OpenAI key, switchable to GPT-5
- A working understanding of which model fits which use case (cost, latency, capability)
- A streaming-enabled brain so replies feel responsive
- An observability dashboard you can use to monitor spend per agent

**Prerequisites:** You have an agent at [three.ws/my-agents](https://three.ws/my-agents). You have an API key from Anthropic ([console.anthropic.com](https://console.anthropic.com)) or OpenAI ([platform.openai.com](https://platform.openai.com)). Familiarity with the concept of system prompts (see [agent personality](/tutorials/agent-personality)).

---

## Step 1 — Where the LLM call actually happens

The single most important architectural detail: **the LLM call is server-side, always**. The browser never talks to Anthropic or OpenAI directly. Your API key never leaves the platform's backend.

When the agent on the page calls `agent.say('hi')`, the flow is:

1. The browser sends the user's message, the agent ID, and a session token to `three.ws/api/chat`.
2. The platform looks up the agent's brain configuration (provider, model, system prompt, attached tools).
3. The platform looks up the agent owner's stored API key for that provider (or falls back to the managed free-tier credit).
4. The platform makes the LLM call from the server, streams the response back over Server-Sent Events to the browser.
5. The browser fires `brain:stream` events with chunks and a final `brain:message` event with the complete reply.

This matters for three reasons:

- **Keys stay secret.** Even a "view source" attack on your page reveals nothing. The key lives only in the platform's key store.
- **Rate-limit shaping happens once, server-side.** The platform manages backoff and retries for you.
- **The embed snippet doesn't know which model is running.** You can swap from Claude Sonnet 4.6 to GPT-5 in My Agents and every page that embeds your agent picks up the change on next load. No code edits anywhere.

The corollary: setting `api-key="sk-ant-..."` directly on the `<agent-3d>` tag is supported but discouraged. It exposes your key in DOM. Use it only for local prototypes that never get deployed. Production agents store their key on the platform side.

---

## Step 2 — Add your API key in My Agents

The key store is per-account, not per-agent — once you've added a key, every agent you own can use it.

For Anthropic:

1. Open [console.anthropic.com](https://console.anthropic.com).
2. **Settings → API Keys → Create Key.** Give it a label like "three.ws production".
3. Copy the key (it starts with `sk-ant-`). You won't see it again.
4. Open [three.ws/my-agents](https://three.ws/my-agents).
5. Click the gear icon → **API Keys → Anthropic → Add key.**
6. Paste, save.

For OpenAI:

1. Open [platform.openai.com/api-keys](https://platform.openai.com/api-keys).
2. **Create new secret key.** Label it.
3. Copy (starts with `sk-`).
4. In three.ws My Agents, **API Keys → OpenAI → Add key.**
5. Paste, save.

You can store both keys at once and route different agents to different providers.

After saving, the keys are stored encrypted at rest. The dashboard shows the last four characters and a creation timestamp; the full key is never displayed back. If you suspect a leak, rotate the key on the provider side and replace it in the dashboard — the platform invalidates the old one immediately.

---

## Step 3 — Pick a model

Each agent has a single active brain at a time. You change it in the agent's settings panel under **Brain → Model**.

The current production-ready models, with the tradeoffs that actually matter for agent use:

### Anthropic models

**Claude Sonnet 4.6** (`claude-sonnet-4-6`) — the default for most agents.

- **Cost:** Low. Roughly $3 per million input tokens, $15 per million output. For a typical 20-turn chat this is fractions of a cent.
- **Latency:** First token in ~600ms. Full reply for a 2-sentence answer in 1.2-2 seconds.
- **Capability:** Excellent at tool use, structured output, and following system prompts. The right default for support, sales, concierge, and personal agents.
- **Context window:** 200K tokens. Plenty of room for long system prompts and memory.

**Claude Opus 4.7** (`claude-opus-4-7`) — when you need the smartest model.

- **Cost:** ~5x Sonnet. Worth it for high-stakes agents (legal, medical, financial assistants) and complex reasoning chains.
- **Latency:** First token in ~1.2s. Full reply 2.5-4s for a typical turn.
- **Capability:** Best-in-class at multi-step reasoning, ambiguous instruction handling, and long-context retrieval. Holds character better under adversarial pressure.
- **Context window:** 200K tokens. Same headroom as Sonnet — the upgrade is depth of reasoning, not window size.

**Claude Haiku 4.5** (`claude-haiku-4-5-20251001`) — when latency matters more than depth.

- **Cost:** ~1/3 of Sonnet.
- **Latency:** First token in ~250ms. Full reply in well under a second.
- **Capability:** Good for FAQ-style agents, lookups, and short interactions. Drops noticeably below Sonnet on long context or nuanced tone.
- **Use it when:** you have an agent that handles many short turns (a wave-and-greet, a status-check agent) and you want it to feel instant.

### OpenAI models

**GPT-4o** (`gpt-4o`) — the comparable peer to Sonnet 4.6.

- **Cost:** $2.50 per million input, $10 per million output. Slightly cheaper than Sonnet.
- **Latency:** First token in ~700ms.
- **Capability:** Strong at multimodal input (vision, audio) and at general chat. Tool use is reliable.

**GPT-5** (`gpt-5`) — OpenAI's reasoning-grade model, comparable to Opus.

- **Cost:** Premium. Comparable to Opus per token.
- **Latency:** Higher than GPT-4o; first token in ~1.5s, more if reasoning is engaged.
- **Capability:** Excellent at hard tasks, math, code, complex tool chains. Overkill for casual chat.

**GPT-4o-mini** (`gpt-4o-mini`) — the budget option.

- **Cost:** Lowest in the OpenAI lineup.
- **Latency:** Fast.
- **Capability:** Roughly comparable to Haiku for short interactions. Less coherent on long conversations.

### Picking a model

A practical rule of thumb:

| Use case | Recommended model |
|---|---|
| Support / FAQ agent for a SaaS | Sonnet 4.6 or GPT-4o |
| Personal-website-me agent | Sonnet 4.6 |
| Onboarding co-pilot, sales bot | Sonnet 4.6 |
| Museum tour guide, long-form domain agent | Sonnet 4.6, escalate to Opus only if needed |
| Legal, medical, financial assistant | Opus 4.7 or GPT-5 |
| Status-check, wave-and-greet, micro-interaction | Haiku 4.5 or GPT-4o-mini |
| Multi-step tool chains, code assistance | Opus 4.7 or GPT-5 |

Start at Sonnet 4.6 for almost everything. Move to Haiku if latency is the bottleneck. Move to Opus or GPT-5 only when you have a specific quality issue that the smaller model can't fix with prompt iteration.

---

## Step 4 — Configure the system prompt

The system prompt and the model are configured separately. You can swap models without touching the prompt, and vice versa.

In **Brain → System prompt**, paste your full prompt. The same prompt works across all the models above, with one caveat: smaller models (Haiku, GPT-4o-mini) follow instructions less precisely, so prompts written for them benefit from being shorter and more explicit. A 600-word prompt that Sonnet handles cleanly may overflow Haiku's instruction-following budget.

If you're targeting Haiku or GPT-4o-mini specifically, trim:

- Cut the longer "voice" descriptions to 2-3 traits
- Reduce the rules list to 3-4 hard bans
- Keep fallback responses but cut any explanatory commentary

For Sonnet, Opus, GPT-4o, and GPT-5, the full prompt template from the [agent personality](/tutorials/agent-personality) tutorial works without modification.

A few configuration knobs alongside the prompt:

| Setting | What it does | Recommended |
|---|---|---|
| **Temperature** | 0-2 range, controls randomness | 0.7-0.9 for chat agents, 0.3-0.5 for FAQ |
| **Max tokens** | Hard cap on reply length | 512 for voice agents, 1024 for text-mode |
| **Top-p** | Nucleus sampling threshold | Leave at default unless you have a specific reason |
| **Stream** | Whether to stream tokens as they arrive | On — see Step 5 |

The temperature setting is the second-most impactful knob after the prompt itself. Too low and the agent becomes mechanical; too high and it goes off-script. 0.8 is a safe centre for any conversational agent.

---

## Step 5 — Streaming responses

By default the platform streams responses from the model as they generate. The browser receives tokens in `brain:stream` events and the full message arrives in `brain:message` once the model finishes.

You can see this in action:

```js
const agent = document.querySelector('agent-3d');

agent.addEventListener('brain:stream', (e) => {
  // e.detail.chunk is a small string — usually 1-5 tokens
  console.log('chunk:', e.detail.chunk);
});

agent.addEventListener('brain:message', (e) => {
  if (e.detail.role === 'assistant') {
    console.log('complete:', e.detail.content);
  }
});
```

For a custom chat UI, build incremental rendering on `brain:stream` so the user sees text arriving instead of waiting for the whole reply. The built-in chat input already does this — assistant messages fill in word by word.

To turn streaming off (rarely useful, but available if you're piping the output somewhere that can only handle complete messages), set **Brain → Stream → off** in the agent settings. You'll get a single `brain:message` event with the whole reply and no `brain:stream` events.

Streaming impacts perceived latency *much* more than actual end-to-end latency. A reply that takes 2 seconds to fully generate feels nearly instant with streaming on; without streaming, the same 2-second wait feels like the agent is broken.

---

## Step 6 — Tool use per model

Tool use (the model invoking a function you've defined — a `searchProducts(query)` skill, a `lookupOrder(id)` skill) is supported across all the models above, but the quality varies.

| Model | Tool use quality |
|---|---|
| Claude Opus 4.7 | Excellent. Handles complex multi-tool chains and ambiguous tool selection cleanly. |
| Claude Sonnet 4.6 | Excellent. Indistinguishable from Opus for most tool flows. The default recommendation. |
| Claude Haiku 4.5 | Good for single-tool flows. Struggles with chains that require 3+ sequential tool calls. |
| GPT-5 | Excellent, similar to Opus. Strong at parallel tool calls. |
| GPT-4o | Very good. Slightly more prone to mis-formatting tool arguments than Sonnet. |
| GPT-4o-mini | Functional. Avoid for anything with 2+ tools or non-trivial schemas. |

If you're building a skill-heavy agent — one that needs to look up products, check inventory, search documentation, and place orders, all in one conversation — pick Sonnet or GPT-4o at minimum. Haiku and mini are acceptable for single-purpose lookups but get confused on chains.

See the [custom skill tutorial](/tutorials/custom-skill) for the full skill-writing workflow.

---

## Step 7 — Observability and cost

Every chat turn costs tokens. For agents handling real traffic, you need to know where your spend is going.

The dashboard at [three.ws/my-agents](https://three.ws/my-agents) → your agent → **Usage** tab shows:

- **Total tokens** by day, separated into input and output
- **Estimated cost** at the rate of your selected model
- **Per-agent breakdown** if you have multiple agents
- **Top conversations** by token spend (useful for finding runaway prompt loops)

Two specific things to watch:

**Input-token growth across a session.** Long conversations accumulate context — every turn includes the full conversation history as input to the next turn. By turn 50 of a chat, your input tokens per turn might be 20x what they were at turn 1. If you're seeing surprisingly large bills, this is usually the cause. The fix is either tighter session-end heuristics (clear memory after N minutes idle) or summarising older turns into a single context message.

**Tool-call expansion.** A tool that returns 5000 tokens of JSON balloons the next-turn input. If you have a skill that returns large data, summarise the response before it goes back to the model rather than passing the raw payload through.

For agents handling 1000+ chats per day, you can set up **usage alerts** under **Account → Billing → Alerts**. Pick a threshold (a daily spend or a token count); the platform emails you when you cross it.

---

## Step 8 — Switch models without changing your embed

This is the part that often surprises people: the embed snippet on your website doesn't know which model is running. Everything is on the agent record.

If you have:

```html
<script type="module" src="https://three.ws/agent-3d/latest/agent-3d.js"></script>
<agent-3d agent-id="YOUR_AGENT_ID" id="agent"></agent-3d>
```

…on a thousand pages, you can switch the brain from Sonnet to Opus to GPT-5 entirely from the dashboard. No deploy. No code edit. The next page load picks up the new model.

This makes A/B testing painless. Common patterns:

- **Cost optimisation pass.** Move a low-stakes agent from Sonnet to Haiku, watch the quality and spend for a week, decide whether to keep the change.
- **Capability spike.** Promote an agent to Opus for a busy week (a launch, a marketing campaign), then dial back down to Sonnet for steady-state.
- **Provider failover.** If Anthropic has a brief outage, you can switch the agent to GPT-4o in the dashboard and keep traffic moving while you wait. Both keys are stored, both providers are reachable from the same agent record.

The trick to making this work cleanly is to write your system prompt in a model-agnostic style. Prompts that lean hard on Claude-specific quirks ("respond in XML tags") can produce slightly different output on GPT. The prompt template in the [agent personality](/tutorials/agent-personality) tutorial is intentionally portable across providers — use that style and your switch-day surprises are minimal.

---

## Step 9 — Self-hosted keys via key-proxy (advanced)

The standard path is to store your key in the platform dashboard. If you have a stricter security posture and want to keep the key on infrastructure you control entirely, the platform supports a **key proxy** pattern: you run a tiny endpoint that vends short-lived, scoped tokens, and the platform calls your endpoint instead of holding the long-lived key.

The flow:

1. You run an endpoint at, say, `https://your-domain.com/api/llm-key`. It returns a JSON response with a short-lived API key (or a session token usable as one), valid for some window you control.
2. You set the `key-proxy` attribute on your `<agent-3d>` element or in the agent's dashboard settings:

```html
<agent-3d
  agent-id="YOUR_AGENT_ID"
  key-proxy="https://your-domain.com/api/llm-key"
></agent-3d>
```

3. When the platform needs to make an LLM call for this agent, it calls your endpoint first to get a fresh key, then uses that key for the LLM request.

This is genuinely advanced — most teams don't need it. The reasons to reach for it:

- Compliance requirements that prohibit storing third-party API keys outside your infrastructure
- Multi-tenant SaaS where each customer brings their own key and you don't want to pool them into a single account
- A desire to track per-request usage in your own logging stack before the LLM provider sees the call

For everything else, the dashboard key store is the right answer.

---

## Step 10 — A concrete switch: walk through

To make this concrete, here's the actual sequence for moving a production agent from the managed free tier to your own Anthropic key, then upgrading the model from Sonnet to Opus.

1. **Get your key.** [console.anthropic.com](https://console.anthropic.com) → API Keys → Create Key. Label it "three.ws production".
2. **Add to platform.** [three.ws/my-agents](https://three.ws/my-agents) → gear icon → API Keys → Anthropic → paste, save.
3. **Switch the agent's brain provider.** Open your agent. **Brain → Provider → Anthropic.** Verify the dropdown for **Use my key** is selected, not **Use managed credit**.
4. **Test.** Open any page that embeds the agent. Send a message. Check the Usage tab — input/output tokens should be incrementing against your key, not the managed credit.
5. **Upgrade the model.** **Brain → Model → Claude Opus 4.7.** Save.
6. **Test again.** Notice the reply time is slightly slower (~1.5s first token vs ~600ms) and the responses are noticeably more thoughtful on hard questions.
7. **Set a budget alert.** Account → Billing → Alerts → $20 / day. You'll get an email if Opus pushes your spend up faster than expected.

Total time: under five minutes. The agent IDs in your existing embeds don't change. Visitors notice the smarter replies but the front-end is identical.

---

## What you learned

The brain layer in full:

- LLM calls happen server-side; your key never leaves the platform's backend
- Keys are stored per-account in My Agents; one key serves all your agents from that provider
- Sonnet 4.6 is the default; Opus 4.7 and GPT-5 are the reasoning-grade upgrades; Haiku and mini are the latency picks
- Streaming is on by default and matters more than total latency for perceived speed
- Tool-use quality varies by model — pick Sonnet or larger for skill-heavy agents
- Usage and cost are visible in the dashboard, with alerts available for spend caps
- Switching models is a dashboard toggle; the embed snippet never needs to change
- Key proxies are an advanced option for compliance-heavy setups

The brain is the part of the agent you'll iterate on most after the system prompt. Pick a sensible default (Sonnet 4.6), ship, and only upgrade once you've identified a specific quality gap that prompt iteration can't close.

## Next steps

- [Give your agent a personality](/tutorials/agent-personality) — write a system prompt that holds across thousands of chats
- [Add a custom skill](/tutorials/custom-skill) — give the brain tools to use
- [Trigger the agent from page events](/tutorials/trigger-from-page-events) — wire the brain into your product flow
