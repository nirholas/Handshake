# Memory System

Agent memory lets an agent remember things between sessions. Without it, every conversation starts fresh — the agent has no idea who you are, what you talked about last time, or what preferences you've stated. With memory, the agent builds up a persistent model of the user and context that it draws on automatically at the start of each conversation.

This document covers how agent memory works, how to configure storage modes, and how to read and write memories from code.

> **Just want to add a memory?** Start with the hands-on tutorial: [Create, enhance & edit agent memory](/docs/tutorials/create-and-edit-memory) walks through every path — the dashboard, the agent itself, MCP tools, the REST API, and skills — plus how to sharpen, edit, and forget. This reference is the underlying data model.

---

## Two layers

Memory in the three.ws runtime has two distinct layers:

**In-memory store** ([agent-memory.js](../src/agent-memory.js)) — A fast, typed, salience-ranked store that lives in the JavaScript runtime. Loaded on boot, queried during conversations, written as things happen. Persists to `localStorage` immediately and optionally syncs to a backend API.

**File-based persistence** ([memory/index.js](../src/memory/index.js)) — A structured collection of Markdown files with YAML frontmatter, one file per memory topic. Human-readable, portable across environments, and the same format used by Claude Code's own memory system. Serialized to `localStorage` in local mode, or pinned to IPFS in distributed modes.

Both layers are active at the same time. The file-based layer is what gets injected into the LLM's system prompt. The in-memory store provides a fast queryable index and handles salience ranking and decay.

---

## Memory types

All memories are organized into four semantic types. The type determines salience weighting and how the agent prioritizes retrieval.

| Type | What it stores | Salience bonus | Example |
|------|---------------|---------------|---------|
| `user` | Who the user is — role, goals, preferences, knowledge level | +0.2 | "Alex is a mechanical engineer, prefers metric units" |
| `feedback` | Corrections and confirmations that shape future behavior | +0.3 (highest) | "User prefers direct critique, not encouragement-first" |
| `project` | Ongoing work context — goals, deadlines, stakeholders | +0.1 | "Training for a tournament in June 2026; knee injury, no high-impact drills until May" |
| `reference` | Pointers to external systems | +0.0 | "Match clips live in the shared Drive folder" |

`feedback` gets the highest salience weight because corrections that the user had to give once should never need to be given again. `user` memories are also elevated because they shape every response. `reference` memories get no bonus — they're looked up when needed, not front-of-mind.

### How salience affects retrieval

Each query ranks results by `salience × recency`. Recency uses a 7-day exponential half-life — a memory from yesterday outscores an equally-salient one from two weeks ago. You can override salience entirely by setting `important: true` on a memory entry, which pins it to 1.0.

Tag count also slightly boosts salience: more tags means a more deliberate memory write.

---

## Storage modes

Configure the persistence mode in the agent's `manifest.json`:

```json
{
  "memory": {
    "mode": "local"
  }
}
```

| Mode | Description | Best for |
|------|-------------|---------|
| `local` | Stored in browser `localStorage`. Fast, private, device-specific. | Development, demos, single-device personal agents |
| `remote` | Synced to the platform backend (`/api/agent-memory`) per signed-in user. | Cross-device memory for platform-hosted agents |
| `ipfs` | Loaded from a pinned IPFS bundle. Portable across devices. | Distributing a curated memory bundle with an agent |
| `encrypted-ipfs` | Same as `ipfs` but content is AES-GCM encrypted before pinning. | Agents that handle user PII |
| `none` | No persistence. Memory exists only for the current session. | Kiosks, one-shot interactions, demos |

Custom backends can also be registered programmatically with `Memory.registerBackend(name, backend)` (a `backend` object with `load` / `persist` / optional `recall` hooks, see `specs/MEMORY_SPEC.md`); any unknown mode falls back to `local` with a warning.

### Local mode (default)

Memory is serialized to `localStorage` under a single namespaced key:

```
localStorage["agent:<agentId>:memory"]
```

The value is a JSON blob containing the index text, all memory files, and the recent timeline. It is written synchronously on every `write()` or `note()` call, so there is no data loss on page unload.

If the write fails because `localStorage` is full, the runtime automatically prunes expired entries and entries with the lowest salience, keeping a maximum of 150 entries.

**Limitations:**
- Device-specific: memory on your phone is not the same as memory on your desktop
- Typically ~5 MB per origin in most browsers
- Lost if the user clears site data or the browser's storage

### IPFS mode

```json
{
  "memory": {
    "mode": "ipfs"
  }
}
```

In `ipfs` mode the agent loads its memory from a pinned bundle: `Memory.load({ mode: 'ipfs', manifestURI })` fetches `MEMORY.md` from the bundle, follows its links to the individual memory files, and hydrates the store. Runtime writes stay in-memory for the session; publishing an updated bundle is an explicit step (pin the `memory/` directory again and point `manifestURI` at the new CID).

Pinning goes through the pluggable pinner in [src/pinning/index.js](../src/pinning/index.js) (`createPinner(config)`):

| Provider | `createPinner` config |
|----------|----------------------|
| `web3-storage` (default) | `{ provider: 'web3-storage', token }` |
| `pinata` | `{ provider: 'pinata', token }` (JWT) |
| `filebase` | `{ provider: 'filebase', accessKeyId, secretAccessKey, bucket }` |
| `memory` | in-memory dev pinner (real CIDs, nothing persisted) |

Server-side, the platform's pinning endpoints (`/api/pinning/*`) read `PINATA_JWT` or `WEB3_STORAGE_TOKEN` from the environment.

The benefit is cross-device persistence with content-addressed verification — the CID uniquely identifies the exact content, so you always know what you got back from the network.

### Encrypted IPFS mode

```json
{
  "memory": {
    "mode": "encrypted-ipfs"
  }
}
```

Same as IPFS mode but every file is encrypted with **AES-GCM-256** ([src/memory/crypto.js](../src/memory/crypto.js), pure `crypto.subtle`) before pinning. Only the holder of the encryption key can decrypt it, so memory content remains private even on a public IPFS network.

The key is not stored anywhere: `Memory.load({ mode: 'encrypted-ipfs', deriveKey })` requires a `deriveKey` function, and the standard implementation derives a non-extractable AES key from a deterministic wallet signature. `memory.save()` then encrypts each file and pins it via `POST /api/agents/<id>/memory/pin`, returning the per-file CIDs plus the CID of the rebuilt `MEMORY.md` index (the index itself is pinned in plaintext, since it only lists filenames and CIDs).

> **Warning:** There is no key recovery. If the wallet (and therefore the derived key) is lost, the memories are permanently inaccessible. Make sure users understand this before enabling encrypted-ipfs mode.

### None mode

```json
{
  "memory": { "mode": "none" }
}
```

The agent is completely stateless. Nothing is written to storage. Memory calls are accepted (they won't throw) but nothing persists past the current page session. Useful for kiosks, one-shot demos, or any agent where statefulness is undesirable.

---

## Memory file format

The file-based layer stores one Markdown file per memory topic, each with YAML frontmatter. This is intentionally the same shape as Claude Code's memory system.

```markdown
---
name: Tone
description: user wants direct critique, not encouragement-first
type: feedback
created: 2026-03-22
updated: 2026-04-14
---

User prefers direct critique over encouragement-first framing. "Just tell me
what's wrong" — their words after session #4.

**Why:** user explicitly corrected the first two sessions' overly warm tone.
**How to apply:** lead with the issue, follow with the fix. Save warmth for
genuine wins, not every message.
```

### Frontmatter fields

| Field | Required | Purpose |
|-------|----------|---------|
| `name` | yes | Human-readable title for the memory |
| `description` | yes | One-line summary used during retrieval to judge relevance |
| `type` | yes | `user` \| `feedback` \| `project` \| `reference` |
| `created` | yes | ISO date of first write |
| `updated` | yes | ISO date of last edit — bumped on every `write()` |
| `source` | no | Which conversation or event produced this memory |
| `decay` | no | `never` \| `30d` \| `90d` — hint to the retrieval layer |

### The MEMORY.md index

A `MEMORY.md` file is automatically maintained alongside the individual memory files. It lists all memories by type, one line each, and is always loaded into the LLM's system context regardless of token budget.

```markdown
# Agent Memory

## User
- Role (`user_role.md`) — Argentina fan, plays weekly 5-a-side on Saturdays
- Preferences (`user_preferences.md`) — terse feedback, no emojis

## Feedback
- Tone (`feedback_tone.md`) — stay warm but don't coddle; user asked for direct critique
- Drill pacing (`feedback_pacing.md`) — 3 drills per session max

## Project
- Season goal (`project_season.md`) — user is training for a tournament in June 2026

## Reference
- Highlight reel (`reference_reel.md`) — shared Drive folder where user stores match clips
```

Keep the index concise. Lines beyond 200 are truncated before injection into context.

### The timeline

The timeline is an append-only event log. Skills write ephemeral events here via `ctx.memory.note(type, data)`. In memory it is capped at 1000 entries; in `local` mode, the last 200 entries are persisted. The bundle spec reserves a `memory/timeline/` directory (one JSONL file per day) for exported bundles; the runtime does not hydrate the timeline from IPFS on load.

```json
{"ts":"2026-04-14T12:03:12Z","type":"waved","style":"enthusiastic"}
{"ts":"2026-04-14T12:03:45Z","type":"user_said","text":"how's my form?"}
{"ts":"2026-04-14T12:04:10Z","type":"played_clip","name":"demo-kick"}
```

Timeline entries feed the LLM's short-term context. The runtime injects the most recent entries that fit within the remaining token budget after loading the index and ranked files.

---

## How the LLM reads memory

The runtime calls `memory.contextBlock({ maxTokens: 8192 })` before each LLM turn. This method builds a context string within the token budget (estimated at 4 chars per token):

1. **Always included:** the full `MEMORY.md` index
2. **Ranked by relevance:** individual memory file bodies, in order, until the budget is exhausted
3. **Recent timeline entries:** the last N events that fit in the remaining budget

This context block is injected into the system prompt. The LLM sees it as structured background knowledge, not as user messages.

Memory retrieval currently uses substring matching against `description` fields and body content. Embedding-based semantic search is planned but not yet implemented — `memory.recall(query)` does substring matching today.

---

## How the LLM writes memory

The `remember` tool is a built-in tool available to every agent. When the LLM determines something is worth remembering, it calls this tool:

```
User: "My name is Alex and I prefer to be addressed formally."
Agent: [calls remember tool]
  key: "user_name"
  name: "User name and address preference"
  description: "User is Alex, prefers formal address"
  type: "user"
  body: "User's name is Alex. They prefer formal address — use 'you' not first name."
Agent: "Noted, Alex. I'll address you formally from now on."
```

The tool handler calls `ctx.memory.write(key, { name, description, type, body })`, which updates the memory file and rebuilds the index automatically.

---

## Programmatic API

### Writing memory from a skill

```js
// Write a structured memory file
ctx.memory.write('feedback_tone', {
  name: 'Tone preference',
  description: 'user wants direct critique, not encouragement-first',
  type: 'feedback',
  body: 'User prefers direct critique over encouragement-first.\n\n**Why:** corrected twice.\n**How to apply:** lead with the issue.',
});

// Append to the timeline
ctx.memory.note('played_clip', { name: 'demo-kick', uri: 'kick.glb' });
```

### Reading memory from a skill

```js
// Read a single file (returns { meta, body } or null)
const tone = ctx.memory.read('feedback_tone');
if (tone) {
  console.log(tone.meta.type); // "feedback"
  console.log(tone.body);      // full body text
}

// Substring search across all files
const hits = await ctx.memory.recall('how does the user prefer feedback');
// hits: [{ file, meta, body, score }, ...]
```

### Exporting and importing

Memory can be exported as a portable blob and imported into another agent instance:

```js
// Export all memory as a JSON blob
const blob = await agent.memory.export();
// { version: "memory/0.1", mode, namespace, index, files, timeline }

// Import into another instance (merge strategy: local wins on conflict)
await otherAgent.memory.import(blob, { strategy: 'merge' });

// Replace strategy: incoming wins on conflict
await agent.memory.import(blob, { strategy: 'replace' });
```

This enables memory-as-inheritance: fork an agent, carry the memories forward.

### Loading memory directly

```js
import { Memory } from './src/memory/index.js';

const memory = await Memory.load({
  mode: 'local',
  namespace: 'my-agent-id',
});

// Or load from IPFS manifest
const memory = await Memory.load({
  mode: 'ipfs',
  namespace: 'my-agent-id',
  manifestURI: 'https://ipfs.io/ipfs/Qm.../manifest.json',
  fetchFn: fetch.bind(window),
});
```

---

## What not to store

Directly from the spec — these should not go in memory:

- Information already derivable from code, skills, or the manifest
- Ephemeral conversation context ("we were just discussing X")
- Anything already documented in `SKILL.md` or `instructions.md`
- Secrets, API keys, or tokens — ever

The test: would a future session of the agent need this, and is it not otherwise findable by reading the current state? If yes, it's a memory. If no, it doesn't belong here.

---

## Forgetting

The LLM can forget a memory when the user requests it ("forget that my name is Alex"):

1. The relevant memory file is deleted
2. `MEMORY.md` is rebuilt without it
3. A `forgot` entry is appended to the timeline for audit

Automatic decay (via the `decay` frontmatter field) down-weights a memory during retrieval without deleting it. Files are not deleted without explicit user instruction.

---

## Multi-device and multi-tab behavior

**Single device (local mode):** straightforward read-through of `localStorage`. Writes are synchronous and immediately visible.

**Multi-device (ipfs mode):** last-write-wins with additive merge on load. Conflicts are rare because most writes add new files rather than editing existing ones. In the case of a true conflict, the LLM can mediate.

**Multiple tabs (same device):** writes are synchronous `localStorage.setItem` calls, so the last tab to write wins. There is no cross-tab lock; if you run the same agent in several tabs at once, expect the most recent tab's memory state to be the one that persists.

---

## Bundle layout (IPFS mode)

When using IPFS mode, the agent's manifest bundle includes a `memory/` directory:

```
agent/
└── memory/
    ├── MEMORY.md
    ├── user_role.md
    ├── user_preferences.md
    ├── feedback_tone.md
    ├── project_goal.md
    └── timeline/
        ├── 2026-04-14.jsonl
        └── 2026-04-13.jsonl
```

The `Memory._loadIPFS()` method fetches `memory/MEMORY.md` first, parses its links to discover individual files, then fetches each one (and decrypts it in `encrypted-ipfs` mode). If any file fails to fetch, it is skipped silently and the rest of memory loads normally. A wrong decryption key throws so callers can detect it.

---

## Privacy

| Mode | Who can read the data |
|------|-----------------------|
| `local` | Only the device/browser where it was written. Never leaves the browser. |
| `remote` | The signed-in owner via the platform backend (`/api/agent-memory`). |
| `ipfs` | Anyone who knows the CID. CIDs are not guessable, but if leaked, the content is public. |
| `encrypted-ipfs` | Only the holder of the encryption key. Content is opaque to the IPFS network. |
| `none` | No one — data is never written. |

**Consider what you're storing.** User names, stated preferences, and conversation summaries can constitute personally identifiable information (PII) in some jurisdictions. If your agent runs in a regulated context, use `encrypted-ipfs` or keep all PII out of memory and handle it in your own backend with proper consent flows.

In `ipfs` mode without encryption, treat the memory as semi-public. Don't store anything the user wouldn't want visible to anyone with the CID.

---

## Related

- [Create, enhance & edit agent memory](/docs/tutorials/create-and-edit-memory): the hands-on tutorial
- [Agent system](/docs/agent-system): how memory feeds the LLM runtime
- [Skills](/docs/skills): the `ctx.memory` API skills use
- [Architecture overview](/docs/architecture): where memory sits in the four layers
