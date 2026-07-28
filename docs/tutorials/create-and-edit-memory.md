# Create, enhance & edit agent memory

By the end of this tutorial you'll be able to give any of your agents a **custom memory** — a durable fact it carries into every future conversation — and then sharpen, edit, or remove it. You'll do it five ways: from the dashboard with no code, by letting the agent remember on its own, over the MCP tools, over the REST API, and from inside a skill.

Along the way you'll understand the four memory types, how salience and recency decide what an agent recalls, and why editing a memory quietly re-indexes it.

**Prerequisites:** a three.ws account with at least one agent ([create one](/create)). The code paths assume light JavaScript familiarity; the dashboard path assumes none.

---

## What you're building

A custom memory is one fact, attached to one agent, that survives between sessions:

```
You (once):  "Always quote prices in USDC, never in SOL."
        ↓    [stored as a feedback memory on the agent]
Agent (every session after):  reads it at boot, quotes in USDC without being asked
```

Without memory, every conversation starts cold — the agent re-learns who you are and re-makes the same mistakes. A custom memory is how you teach it something once and have it stick.

This tutorial covers the full lifecycle: **create → enhance → edit → forget**.

---

## How memory works (two minutes of theory)

Every memory has a **type**. The type decides how strongly the agent prioritizes the fact when it builds context for a new turn:

| Type | What it stores | Pull | Example |
|---|---|---|---|
| `user` | Who the user is — role, goals, preferences | high | "Maria is a Solana dev; prefers terse answers" |
| `feedback` | Corrections and confirmed instructions | **highest** | "Quote prices in USDC, never SOL" |
| `project` | Ongoing work — goals, deadlines, stakeholders | medium | "Shipping the marketplace by July; blocked on x402" |
| `reference` | Pointers to external systems | low (looked up on demand) | "Design tokens live in docs/DESIGN-TOKENS.md" |

`feedback` is weighted highest on purpose: a correction the user had to give once should never need repeating. `reference` gets no boost — it's retrieved when relevant, not kept front-of-mind.

Two more levers govern what surfaces in a given conversation:

- **Salience** — a 0–1 weight. Higher = more likely to be recalled. Defaults to `0.5`.
- **Recency** — a 7-day exponential half-life. Yesterday's note outranks an equally-salient one from two weeks ago.

The agent ranks candidate memories by a blend of relevance-to-the-moment, salience, and recency, then injects the top ones into its system prompt. You don't call anything to make this happen — storing the memory is enough.

For the full data model (storage modes, the file format, IPFS persistence), see the [Memory System reference](/docs/memory). This tutorial is the hands-on path.

---

## Path A — Create a memory from the dashboard (no code)

The fastest way to add a custom memory.

1. Open **[Library → Memory](/dashboard/library)** in your dashboard.
2. Click **+ Add a note**.
3. **Attach to agent** — pick which agent should remember this.
4. **Type** — choose `user`, `feedback`, `project`, or `reference` (see the table above; default is `project`).
5. **Content** — write the fact in plain language. One fact per memory.
6. Click **Save**.

The note appears immediately in the list, tagged with its type and agent, newest first. The next time that agent loads, the fact is part of its context.

```
Type:     feedback
Content:  When I ask for a summary, give me three bullets max — no preamble.
```

The Memory tab lists every memory across all your agents in one place, so this is also where you audit what your agents currently know. Long notes collapse to three lines with a **Show more** toggle.

> The dashboard is the place to **create and review** memories. To **edit** an existing memory in place or **delete** one, use the API or MCP paths below, or just tell the agent (Path B). The agent's own corrections and the API write to the same store the dashboard reads from.

---

## Path B — Let the agent remember on its own

Every agent has a built-in `remember` capability. When a conversation contains something worth keeping, the agent stores it without you lifting a finger:

```
You:    My name is Maria and I prefer to be addressed formally.
Agent:  [remembers → type: user, "User is Maria; prefers formal address"]
        Noted, Maria. I'll keep it formal from here on.
```

You can also instruct it directly:

```
You:    Remember that our standup is every Tuesday at 9am.
You:    Forget my old shipping address.
```

This is the most natural path for end users. The agent picks the type, writes a tight summary, and confirms. Everything it saves shows up in **Library → Memory** alongside the notes you added yourself — the two paths share one store.

---

## Path C — Create & forget over the MCP tools

If you drive your agent from an MCP client (Claude Desktop, Cursor, an agent-to-agent flow), connect to `/api/mcp` and you get three memory tools. They're scoped to agents you own via three.ws OAuth (`memory:read` / `memory:write`).

**`remember`** — store a memory. Always adds a new entry (additive, never overwrites):

```jsonc
{
  "name": "remember",
  "arguments": {
    "agent_id": "your-agent-uuid",
    "content": "Quote prices in USDC, never in SOL.",
    "type": "feedback",          // user | feedback | project | reference (default: reference)
    "tags": ["pricing", "currency"],
    "salience": 0.8,             // 0–1, default 0.5
    "expires_at": "2026-12-31T00:00:00Z"  // optional ISO-8601; excluded from recall after this
  }
}
```

**`recall`** — retrieve the most relevant memories for a query. Ranks by query relevance blended with salience and recency, skipping expired entries:

```jsonc
{
  "name": "recall",
  "arguments": { "agent_id": "your-agent-uuid", "query": "how should I quote prices?", "limit": 8 }
}
```

**`forget`** — delete a memory by id (get the id from a `recall` result):

```jsonc
{ "name": "forget", "arguments": { "memory_id": "the-memory-uuid" } }
```

> `remember` only ever inserts. To **change** a fact over MCP, `forget` the stale one and `remember` the corrected version — or simply `remember` the correction with higher salience; recall will surface the newer, stronger memory first.

If a call comes from an anonymous, pay-per-call x402 principal (no account), the tools refuse with a clear message — memory is account-scoped, so sign in with three.ws OAuth and pass an `agent_id` you own.

---

## Path D — Create & edit over the REST API

The dashboard and the agent both write through one endpoint: `POST /api/agent-memory`. Calls are owner-scoped — you can only touch agents you own.

**Create** (omit `id`; the server assigns one):

```js
await fetch('/api/agent-memory', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  credentials: 'include',
  body: JSON.stringify({
    agentId: 'your-agent-uuid',
    entry: {
      type: 'feedback',
      content: 'Quote prices in USDC, never in SOL.',
      salience: 0.8,
      tags: ['pricing'],
    },
  }),
});
// → 201 { entry: { id, type, content, salience, tier, createdAt, ... } }
```

**Edit** — pass the existing memory's `id`. The endpoint upserts: same id → in-place update.

```js
await fetch('/api/agent-memory', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  credentials: 'include',
  body: JSON.stringify({
    agentId: 'your-agent-uuid',
    entry: {
      id: 'existing-memory-uuid',
      type: 'feedback',
      content: 'Quote prices in USDC by default; show SOL only if asked.',
      salience: 0.9,
    },
  }),
});
```

Editing the `content` is more than a text swap: the server resets that row's stored embedding and extracted entities, so the memory **re-indexes itself** on the next read. An edited memory becomes findable by its new wording — you don't have to do anything to refresh the index.

**Read** what an agent knows:

```js
const { entries } = await (await fetch('/api/agent-memory?agentId=your-agent-uuid&limit=200', { credentials: 'include' })).json();
```

Filter with `&type=feedback` or fetch only recent changes with `&since=<unix-ms>`.

**Delete:**

```js
await fetch(`/api/agent-memory/${memoryId}`, { method: 'DELETE', credentials: 'include' });
```

These calls run same-origin from a signed-in session (the dashboard's own `post()` helper handles the CSRF token for you). For server-to-server automation, prefer the MCP tools in Path C, which authenticate with an OAuth bearer.

---

## Path E — Create & edit from inside a skill

When you're building a [custom skill](/docs/tutorials/custom-skill), the handler's `ctx.memory` API writes to the same memory the agent reads at boot. Here the **key** is the identity — writing the same key again **edits in place**:

```js
export async function set_preference({ units }, ctx) {
  // Same key → overwrites/updates the existing memory (this is the edit path)
  ctx.memory.write('preferred_units', {
    name: 'Preferred units',
    description: `user prefers ${units}`,
    type: 'user',
    body: `Always present measurements in ${units}.`,
  });
  return { ok: true, units };
}

export async function get_preference(_args, ctx) {
  const pref = ctx.memory.read('preferred_units'); // { meta, body } or null
  return { ok: true, units: pref?.meta?.description ?? 'unknown' };
}
```

`ctx.memory.note(type, data)` appends to a timeline for ephemeral history, and `ctx.memory.recall(query)` searches across stored memories. See the [skill context API](/docs/tutorials/custom-skill) for the full surface.

---

## The portable file format

Under the hood, the file-based layer stores one Markdown file per memory, with YAML frontmatter — the same shape Claude Code uses, so memory is portable and human-editable:

```markdown
---
name: Pricing currency
description: quote prices in USDC, never SOL
type: feedback
created: 2026-06-21
updated: 2026-06-21
---

Quote all prices in USDC by default. Show SOL only when the user explicitly asks.

**Why:** user corrected this twice in early sessions.
**How to apply:** default every quote to USDC; offer SOL as a follow-up, not the headline.
```

To **edit** a memory at this layer, change the body and bump `updated` — the `MEMORY.md` index is rebuilt automatically on the next write. The `**Why:**` / `**How to apply:**` convention (used for `feedback` and `project` memories) is what turns a fact into something the agent can act on, not just recall.

---

## Enhancing a memory: make it actually get used

Creating a memory is easy. Making it reliably *recalled and acted on* is the craft. Five things move the needle:

1. **Pick the sharpest type.** A correction is `feedback`, not `project` — it gets the highest salience and surfaces first. Miscategorizing buries good guidance.
2. **One fact per memory.** "Maria is a Solana dev who ships on Tuesdays and hates emoji" is three memories. Splitting them means each can be recalled, edited, or forgotten on its own.
3. **Add tags.** Tags both boost salience slightly and widen lexical recall — `["pricing","currency"]` makes the memory findable by either word.
4. **Raise salience for durable, load-bearing facts.** Bump important standing instructions to `0.8`–`0.9` so recency decay never sinks them below the noise.
5. **Write the body for action.** For `feedback`/`project`, add **Why:** (so it isn't second-guessed) and **How to apply:** (so the agent knows the behavior, not just the rule). Set `expires_at` on anything time-bound so it self-cleans.

A weak memory and a strong one carry the same fact but behave differently:

```
Weak:    type=project  "usdc"
Strong:  type=feedback  salience=0.85  tags=[pricing,currency]
         "Quote prices in USDC, never SOL.
          **Why:** user corrected twice.  **How to apply:** default every quote to USDC."
```

---

## Verify it worked

After creating or editing, confirm the agent can actually retrieve it:

- **Dashboard:** the note shows in [Library → Memory](/dashboard/library) with its type, agent, and salience.
- **MCP / API:** `recall` (or `GET /api/agent-memory`) returns it, ranked. Run a query in the user's own words — if it doesn't surface in the top results, raise salience or add a matching tag.
- **In conversation:** start a fresh session and prompt the situation the memory covers. The agent should act on it unprompted. If it doesn't, the memory is probably mistyped or too low-salience.

---

## What not to store

Memory is for facts a *future* session needs and can't otherwise find:

- ❌ Anything derivable from the agent's code, skills, or manifest
- ❌ Ephemeral context ("we were just talking about X")
- ❌ Secrets, API keys, wallet seeds — **ever**
- ✅ Stated preferences, corrections, durable project context, external pointers

The test: *would the agent need this next week, and could it not just look it up in its current state?* If yes, it's a memory.

---

## Troubleshooting

- **`401` / "sign in required"** — the write needs an authenticated owner. (Public embeds get an empty list, never an error, by design.)
- **`403` / "not your agent"** — the `agentId` belongs to another account. You can only write memories on agents you own.
- **`409` / "memory id already in use"** — you tried to upsert with an `id` that belongs to a different agent. Drop the `id` to create a fresh memory.
- **Type silently became `project` (or `reference`)** — an invalid `type` was sent; the server falls back to a safe default. Use exactly `user`, `feedback`, `project`, or `reference`.
- **MCP tool refused** — anonymous x402 callers have no account. Sign in with three.ws OAuth and pass an `agent_id` you own.
- **Edited a memory but recall still returns the old wording** — re-index is lazy; it refreshes on the next read after the content changes. Run `recall` once and try again.

---

## Recap

You learned five ways to give an agent a custom memory and manage it:

- **Dashboard** ([Library → Memory](/dashboard/library)) — create and review, no code.
- **The agent itself** — it remembers and forgets in conversation.
- **MCP tools** (`remember` / `recall` / `forget`) — for MCP clients and agent-to-agent flows.
- **REST API** (`POST` / `GET` / `DELETE /api/agent-memory`) — create, edit-by-id (re-indexes), read, delete.
- **Skill `ctx.memory`** — write-by-key (same key edits in place), read, recall, note.

The leverage is in *enhancement*: the right type, one fact per memory, tags, deliberate salience, and an action-oriented body are what turn a stored string into something the agent reliably uses. For the underlying data model and storage modes, continue to the [Memory System reference](/docs/memory).
