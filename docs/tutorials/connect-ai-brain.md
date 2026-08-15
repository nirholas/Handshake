# Connect Anthropic, OpenAI, or xAI (Grok) as the brain

The agent's body is the avatar. The agent's voice is the TTS. The agent's *brain* is whatever LLM is generating its replies. By default an embedded agent runs on a **free open-weight lane** (`openai/gpt-oss-20b:free`, routed through OpenRouter on the platform's key), which works out of the box at no cost to you. The moment you want a frontier model, full control over which one runs, or your own usage observability, you bring your own API key.

This tutorial covers the whole brain layer. Where the LLM call actually happens (and why your key never ends up in HTML), how to attach your Anthropic, OpenAI, or xAI key, choosing between the Claude 5 family, the GPT-5.x family, Grok, and the free lanes, the latency and cost tradeoffs, how streaming and system prompts are configured, tool-use support per model, and where to watch your spend. The embed snippet doesn't change when you switch models — the model lives on the agent's embed policy, not in your HTML.

**What you'll build:**
- An agent powered by your own Anthropic, OpenAI, or xAI key
- A working understanding of which model fits which use case (cost, latency, capability)
- An embed policy that pins the model, the monthly quota, and the per-minute rate limit
- A concrete read on what your agents are actually spending

**Prerequisites:** You have an agent at [three.ws/my-agents](https://three.ws/my-agents). You have an API key from Anthropic ([console.anthropic.com](https://console.anthropic.com)), OpenAI ([platform.openai.com](https://platform.openai.com)), or xAI ([console.x.ai](https://console.x.ai)). Familiarity with the concept of system prompts (see [agent personality](/tutorials/agent-personality)).

---

## Step 1 — Where the LLM call actually happens

The single most important architectural detail: **the LLM call is server-side, always**. The browser never talks to Anthropic or OpenAI directly. Your API key never leaves the platform's backend.

When the agent on the page calls `agent.say('hi')`, the flow is:

1. The browser posts an Anthropic-shape body (`{ model, system, messages, tools, stream }`) to `three.ws/api/llm/anthropic?agent=<agentId>` (`api/llm/anthropic.js`).
2. The proxy reads that agent's **embed policy** and checks the referring origin against its allowlist, its per-minute rate limit, and its monthly quota — all before a single upstream token is spent.
3. It resolves which model actually runs (see the clamp below), looks up the matching upstream credential, and calls the provider from the server.
4. The response streams back as Anthropic-shape Server-Sent Events, whatever the upstream was — Groq, OpenRouter, NVIDIA, Mistral, xAI, and Vertex are all translated into that one wire format so the browser parser never changes.
5. The runtime fires `brain:stream` events with chunks and a final `brain:message` event with the complete reply. Both are re-dispatched on the `<agent-3d>` host element, so you listen on the element.

This matters for four reasons:

- **Keys stay secret.** Even a "view source" attack on your page reveals nothing. Keys live only on the server.
- **Rate-limit shaping and quota happen once, server-side**, per agent, from the embed policy.
- **A visitor cannot escalate you onto a paid model.** The proxy clamps the requested model: a caller may pick freely among the free lanes, but any model billed to a first-party vendor key (every Claude and every Grok id) is forced back to whatever the *owner* configured in `policy.brain.model`. The response echoes the model actually used, so a clamped caller can see what it got.
- **The embed snippet doesn't know which model is running.** Change `policy.brain.model` and every page that embeds your agent picks up the change on next load. No code edits anywhere.

There is also a lane-failover chain: if the configured model's upstream returns a quota/billing/rate-limit error mid-request, the proxy retries down a chain of free fallbacks rather than failing the turn, and the response reports the model it landed on.

The corollary: setting `api-key="sk-ant-..."` directly on the `<agent-3d>` tag is supported but discouraged. It exposes your key in the DOM. Use it only for local prototypes that never get deployed. Production agents keep their key server-side.

---

## Step 2 — Add your API key in My Agents

Keys live at **[/dashboard/account](https://three.ws/dashboard/account)**, in the **AI Provider Keys** panel. The store is per-account, not per-agent — once you've added a key, every agent you own can use it.

For Anthropic:

1. Open [console.anthropic.com](https://console.anthropic.com).
2. **Settings → API Keys → Create Key.** Give it a label like "three.ws production".
3. Copy the key (it starts with `sk-ant-`). You won't see it again.
4. Open [/dashboard/account](https://three.ws/dashboard/account) → **AI Provider Keys**.
5. Paste it into **Anthropic (Claude)** and save.

For OpenAI:

1. Open [platform.openai.com/api-keys](https://platform.openai.com/api-keys).
2. **Create new secret key.** Label it.
3. Copy it (starts with `sk-proj-`).
4. Paste it into **OpenAI (GPT-4)** in the same panel and save.

For xAI (Grok):

1. Open [console.x.ai](https://console.x.ai).
2. **API Keys → Create API key.** Label it.
3. Copy it (starts with `xai-`).
4. Paste it into **Grok (xAI)** in the same panel and save.

You can store all three at once. The same panel also holds keys for the non-LLM providers the platform can call on your behalf (Meshy, Tripo, Rodin, Stability, Replicate, ElevenLabs).

Under the hood this is `GET`/`PATCH /api/user/provider-keys`. The `GET` returns only which providers are set — never a value — and a `PATCH` with `null` for a provider deletes that key. Keys are stored encrypted at rest and are never displayed back. If you suspect a leak, rotate it on the provider side and replace it here.

---

## Step 3 — Pick a model

Each agent has a single active brain at a time, pinned as `brain.model` on its embed policy (Step 8 covers changing it). To compare models interactively before you commit, the **model grid and multi-model playground at [/dashboard/brain](https://three.ws/dashboard/brain)** streams the same prompt across several models side by side. That page reads its roster from `GET /api/brain/chat`, which reports every model and whether it is currently available, so it is the live source of truth rather than a hardcoded list.

Prices below are USD per million tokens (input / output) from the platform's own price table (`api/_lib/llm-pricing.js`).

### Anthropic models

**Claude Sonnet 5** (`claude-sonnet-5`) — the default recommendation.

- **Cost:** $3 / $15. For a typical 20-turn chat this is fractions of a cent.
- **Capability:** Near-Opus quality on coding and agentic work at Sonnet cost. The right default for support, sales, concierge, and personal agents.
- **Context window:** 200K tokens. Plenty of room for long system prompts and memory.

**Claude Opus 5** (`claude-opus-5`) — when you need depth.

- **Cost:** $5 / $25.
- **Capability:** Deep reasoning, agentic and long-horizon work. **Thinks by default**, which is the tradeoff: better answers on hard questions, more latency and more billed output tokens on easy ones.
- **Context window:** 200K tokens.

**Claude Fable 5** (`claude-fable-5`) — the most capable model on the platform.

- **Cost:** $10 / $50.
- **Capability:** State-of-the-art reasoning, long-horizon agentic work, knowledge work, and vision. Reach for it when a specific quality gap survives prompt iteration on Opus.
- **Note:** thinking is always on and is not configurable; the proxy strips any non-adaptive `thinking` config rather than letting the upstream reject the call.

**Claude Haiku 4.5** (`claude-haiku-4-5`) — when latency matters more than depth.

- **Cost:** $1 / $5, a third of Sonnet.
- **Capability:** Good for FAQ-style agents, lookups, and short interactions. Drops noticeably below Sonnet on long context or nuanced tone.
- **Use it when:** you have an agent handling many short turns (a wave-and-greet, a status-check agent) and you want it to feel instant.

The previous generation stays selectable and priced identically to its successor tier: **Claude Opus 4.7** (`claude-opus-4-7`, $5 / $25) and **Claude Sonnet 4.6** (`claude-sonnet-4-6`, $3 / $15). There is no reason to start a new agent on them, but existing agents keep working untouched.

> Both Opus 4.7+ and the whole Claude 5 family reject sampling parameters upstream. The proxy strips `temperature` for those models and upgrades a `budget_tokens`-style `thinking` config to the adaptive form, so an embed that ships its SDK's defaults doesn't draw an avoidable 400. You don't have to do anything; just don't expect `temperature` to change a Claude 5 reply.

### OpenAI models

**GPT-5.6 Terra** (`gpt-5.6-terra`) is the balanced peer to Sonnet.

- **Cost:** $2.50 / $15. The same band as Sonnet.
- **Capability:** Strong at multimodal input and general chat. Tool use is reliable. The right OpenAI default for support, sales, and concierge agents.
- **Context window:** 1M tokens.

**GPT-5.6 Sol** (`gpt-5.6-sol`) is the reasoning-grade OpenAI flagship.

- **Cost:** $5 / $30.
- **Capability:** Frontier reasoning, coding, and agentic work. Excellent at hard tasks, math, and complex tool chains. Overkill for casual chat.
- **Context window:** 1M tokens.

**GPT-5.6 Luna** (`gpt-5.6-luna`) is the budget pick of the 5.6 family.

- **Cost:** $1 / $6.
- **Capability:** Vision-capable, roughly comparable to Haiku for short interactions. Less coherent on long conversations.
- **Context window:** 1M tokens.

**o3** (`o3`) is the reasoning specialist, with `o3-pro` above it.

- **Cost:** Reasoning tokens bill as output, so replies cost more than their visible length suggests.
- **Capability:** Deep chain-of-thought for math, logic, and structured planning. Not a general chat pick; reach for it when the agent's job is to reason, not to converse.

The platform also carries GPT-5.5 and GPT-5.5 Pro, the more affordable GPT-5.4 tier (`gpt-5.4`, `gpt-5.4-pro`, `gpt-5.4-mini`, `gpt-5.4-nano`, the cheapest current GPT), and GPT-5.3 Codex (`gpt-5.3-codex`) for code-centric agents.

Legacy ids keep working: `gpt-4o`, `gpt-4o-mini`, and `o3-mini` are accepted as aliases and resolve to `gpt-5.6-sol`, `gpt-5.6-luna`, and `o3` (the GPT-4o family was deprecated upstream in July 2026), so existing agents upgrade in place with no config change.

### xAI (Grok) models

**Grok 4.5** (`grok-4.5`) is the xAI flagship: $2 / $6, cheaper than Sonnet per token, with a 500K context window. Frontier reasoning and strong real-time knowledge of X. A good pick for agents that discuss current events or social sentiment.

**Grok 4.3** (`grok-4.3`) is the long-context option: $1.25 / $2.50, 1M-token window. Reach for it when the agent carries very large system prompts or memory.

**Grok 4.1 Fast** (`grok-4.1-fast`) is the budget workhorse on paper ($0.20 / $0.50, 2M-token window), but check availability before you pin it: OpenRouter dropped it from its catalog, so it only runs when a first-party `GROK_API_KEY` is configured. `GET /api/brain/chat` reports it as unavailable otherwise.

### Free lanes (no key, no bill)

The embed default, `openai/gpt-oss-20b:free`, costs nothing and is tool-call capable. Signed-out callers are restricted to these free lanes on purpose, so an unauthenticated script can't drain the server's billed keys. Alongside GPT-OSS the platform carries free NVIDIA NIM models (Nemotron, DeepSeek, Kimi K2, Llama 4 Maverick, MiniMax M2), Groq's sub-second Llama lanes, SambaNova, Mistral's experiment tier, and Z.AI's GLM Flash. They are the fallback rungs the proxy walks when a paid lane errors, and they are perfectly serviceable as a primary brain for a low-stakes agent.

### Picking a model

A practical rule of thumb:

| Use case | Recommended model |
|---|---|
| Kicking the tyres, low-stakes embed | `openai/gpt-oss-20b:free` (the default — no key, no bill) |
| Support / FAQ agent for a SaaS | Sonnet 5 or GPT-5.6 Terra |
| Personal-website-me agent | Sonnet 5 |
| Onboarding co-pilot, sales bot | Sonnet 5 |
| Museum tour guide, long-form domain agent | Sonnet 5, escalate to Opus 5 only if needed |
| Legal, medical, financial assistant | Opus 5 or GPT-5.6 Sol |
| Hardest reasoning, vision-heavy knowledge work | Fable 5 |
| Status-check, wave-and-greet, micro-interaction | Haiku 4.5 or GPT-5.6 Luna |
| Multi-step tool chains, code assistance | Opus 5 or GPT-5.6 Sol |
| Current events, social sentiment | Grok 4.5 |

Start at Sonnet 5 for almost everything. Move to Haiku if latency is the bottleneck. Move to Opus 5, Fable 5, or GPT-5.6 Sol only when you have a specific quality issue that the smaller model can't fix with prompt iteration.

---

## Step 4 — Configure the system prompt

The system prompt and the model are configured separately. You can swap models without touching the prompt, and vice versa.

The prompt lives on the agent's persona, which you build in the **Brain Studio** panel of the agent editor. It is an interview, not a text box: you direct a character with trait sliders and sample exchanges, and the studio extracts the system prompt from that. Read the extracted prompt back with `GET /api/agents/:id/persona`.

The same prompt works across all the models above, with one caveat: smaller models (Haiku, GPT-5.6 Luna) follow instructions less precisely, so prompts written for them benefit from being shorter and more explicit. A 600-word prompt that Sonnet handles cleanly may overflow Haiku's instruction-following budget.

If you're targeting Haiku or GPT-5.6 Luna specifically, trim:

- Cut the longer "voice" descriptions to 2-3 traits
- Reduce the rules list to 3-4 hard bans
- Keep fallback responses but cut any explanatory commentary

For Sonnet, Opus, GPT-5.6 Terra, and GPT-5.6 Sol, the full prompt template from the [agent personality](/tutorials/agent-personality) tutorial works without modification.

**Sampling knobs are set on the client, not in a dashboard.** The runtime's provider takes them when it is constructed, and the `<agent-3d>` element passes them through from the agent manifest's `brain` block:

| Setting | Where it lives | Default | Notes |
|---|---|---|---|
| `temperature` | `manifest.brain.temperature` | `0.7` | 0.8 is a safe centre for a conversational agent. **Silently stripped for Opus 4.7+ and the whole Claude 5 family**, which reject sampling parameters upstream. |
| `maxTokens` | `manifest.brain.maxTokens` | `4096` | The proxy defaults a missing value to 4096, and floors thinking-by-default models at 4096 so the visible reply isn't squeezed out by thinking tokens. |
| `thinking` | `manifest.brain.thinking` | `'auto'` | `'always'` requests extended thinking. Coerced to the adaptive form on models that demand it. |

There is no top-p knob and no streaming toggle: the client always requests `stream: true` (see Step 5). A long, stable system prompt gets a prompt-cache breakpoint added automatically once it clears the per-model length threshold, which bills repeat turns at roughly a tenth of the input price. You don't opt in.

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

There is no streaming off-switch: the runtime always requests `stream: true`. If you need whole messages only, ignore `brain:stream` and read `brain:message`, which fires once with the complete reply — the same end state, with no wiring change.

Streaming impacts perceived latency *much* more than actual end-to-end latency. A reply that takes 2 seconds to fully generate feels nearly instant with streaming on; without streaming, the same 2-second wait feels like the agent is broken.

---

## Step 6 — Tool use per model

Tool use (the model invoking a function you've defined — a `searchProducts(query)` skill, a `lookupOrder(id)` skill) is supported across all the models above, but the quality varies.

| Model | Tool use quality |
|---|---|
| Claude Fable 5 | Excellent. The strongest option for long, ambiguous tool chains. |
| Claude Opus 5 | Excellent. Handles complex multi-tool chains and ambiguous tool selection cleanly. |
| Claude Sonnet 5 | Excellent. Indistinguishable from Opus for most tool flows. The default recommendation. |
| Claude Haiku 4.5 | Good for single-tool flows. Struggles with chains that require 3+ sequential tool calls. |
| GPT-5.6 Sol | Excellent, similar to Opus. Strong at parallel tool calls. |
| GPT-5.6 Terra | Very good. Slightly more prone to mis-formatting tool arguments than Sonnet. |
| GPT-5.6 Luna | Functional. Avoid for anything with 2+ tools or non-trivial schemas. |
| Grok 4.5 | Reliable. A fair substitute for Terra when you also want current-events knowledge. |
| Free lanes (GPT-OSS, NVIDIA NIM, Groq) | Tool-call capable — that is why they are the fallback rungs — but noticeably weaker at picking the right tool. Fine for one or two tools with simple schemas. |

If you're building a skill-heavy agent — one that needs to look up products, check inventory, search documentation, and place orders, all in one conversation — pick Sonnet 5 or GPT-5.6 Terra at minimum. Haiku and Luna are acceptable for single-purpose lookups but get confused on chains.

The runtime caps a single turn at 8 tool iterations, so a chain that can't resolve inside 8 round trips returns whatever it has rather than looping forever.

See the [custom skill tutorial](/tutorials/custom-skill) for the full skill-writing workflow.

---

## Step 7 — Observability and cost

Every chat turn costs tokens. For agents handling real traffic, you need to know where your spend is going.

**The per-agent read.** `GET /api/agents/:id/usage` (owner-only) returns that agent's brain usage:

```js
const usage = await (await fetch(`/api/agents/${agentId}/usage`, { credentials: 'include' })).json();
// → {
//     agentId,
//     monthlyQuota,        // from the agent's embed policy; null = unlimited
//     currentMonthCalls,   // LLM calls this calendar month
//     dailyBreakdown: [{ day, calls }]   // last 30 days
//   }
```

Note what this is and isn't: it counts **calls**, not tokens, and it is the same counter the proxy enforces `monthly_quota` against. It is the number to watch for "is this agent about to hit its cap", not for a dollar figure.

**The account read.** `GET /api/usage/summary` returns your account-level numbers (plan quotas, avatar count and bytes, MCP tool calls in the last 24h, total events in the last 30 days).

**Cost.** The platform prices every call server-side through `api/_lib/llm-pricing.js` and records it, so the spend cap in `checkUserLlmSpendCap` is enforced on real numbers. What there is *not* today is a self-serve token-and-dollar breakdown chart per conversation, nor threshold email alerts. Budget with `monthly_quota` and `rate_limit_per_min` on the embed policy (Step 8) — those are hard, enforced-before-spend limits, which is a stronger control than an after-the-fact alert.

Two specific things to watch:

**Input-token growth across a session.** Long conversations accumulate context — every turn includes the full conversation history as input to the next turn. By turn 50 of a chat, your input tokens per turn might be 20x what they were at turn 1. If you're seeing surprisingly large bills, this is usually the cause. The fix is either tighter session-end heuristics (clear memory after N minutes idle) or summarising older turns into a single context message.

**Tool-call expansion.** A tool that returns 5000 tokens of JSON balloons the next-turn input. If you have a skill that returns large data, summarise the response before it goes back to the model rather than passing the raw payload through.

For agents handling real volume, set `monthly_quota` deliberately rather than leaving the 1000-call default: once an agent crosses it the proxy stops serving paid lanes for the rest of the month, which is a blunt but effective ceiling. Pair it with a tight `origins` allowlist so nobody else's site can spend your quota in the first place.

---

## Step 8 — Switch models without changing your embed

This is the part that often surprises people: the embed snippet on your website doesn't know which model is running. Everything is on the agent record.

If you have:

```html
<script type="module" src="https://three.ws/agent-3d/latest/agent-3d.js"></script>
<agent-3d agent-id="YOUR_AGENT_ID" id="agent"></agent-3d>
```

…on a thousand pages, you can switch the brain from Sonnet 5 to Opus 5 to GPT-5.6 Sol by changing one field. No deploy. No code edit. The next page load picks up the new model.

That field is `brain.model` on the agent's **embed policy**, read and written at `GET`/`PUT /api/agents/:id/embed-policy`. The `PUT` takes the whole policy document, so read it first, change the one field, and write it back:

```js
const { policy } = await (await fetch(`/api/agents/${agentId}/embed-policy`, {
  credentials: 'include',
})).json();

await fetch(`/api/agents/${agentId}/embed-policy`, {
  method: 'PUT',
  headers: { 'Content-Type': 'application/json' },
  credentials: 'include',   // the dashboard's own helper attaches the CSRF token
  body: JSON.stringify({
    ...policy,
    brain: { ...policy.brain, model: 'claude-sonnet-5' },
  }),
});
```

The whole `brain` block is what you tune here:

| Field | Default | What it does |
|---|---|---|
| `mode` | `'we-pay'` | `we-pay` uses the platform's credential. `key-proxy` calls your endpoint for a key (Step 9) and requires `proxy_url`. `wallet-gated` and `none` close the lane. |
| `model` | `'openai/gpt-oss-20b:free'` | The model the agent actually runs, and the ceiling a visitor is clamped to. |
| `monthly_quota` | `1000` | LLM calls per calendar month before the lane closes. `null` = unlimited. |
| `rate_limit_per_min` | `10` | Per-minute request cap. |

The `origins` block on the same document is the other half of cost control: with `mode: 'allowlist'` and your own hosts, a request from anywhere else is rejected *before* your model budget is touched. The [/dashboard/api](https://three.ws/dashboard/api) page has an editor for that allowlist.

This makes A/B testing painless. Common patterns:

- **Cost optimisation pass.** Move a low-stakes agent from Sonnet 5 to Haiku, watch the quality and spend for a week, decide whether to keep the change.
- **Capability spike.** Promote an agent to Opus 5 for a busy week (a launch, a marketing campaign), then dial back down to Sonnet 5 for steady-state.
- **Provider failover.** If one vendor has a brief outage, switch `brain.model` to a peer on another provider and keep traffic moving. You don't have to do this for transient errors, though: the proxy already walks a free-lane fallback chain on a quota/billing/rate-limit failure mid-request.

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
- Sonnet 4.6 is the default; Opus 4.7 and GPT-5.6 Sol are the reasoning-grade upgrades; Haiku and GPT-5.6 Luna are the latency picks
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
