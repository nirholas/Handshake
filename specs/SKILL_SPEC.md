# Skill Spec v0.1

A **skill** is a portable, content-addressed capability bundle that any compatible agent can install at runtime. Skills are the npm of embodied AI: publish once (IPFS or HTTPS), install anywhere.

A skill bundles three things:

1. **Instructions** (`SKILL.md`) — when and how to use it, written for the LLM.
2. **Tool schema** (`tools.json`) — the tool-use functions the LLM can call.
3. **Assets** (optional) — animation clips, morph target presets, shaders, audio, prompts.

## Bundle layout

```
skill-name/
├── SKILL.md              # instructions (required)
├── tools.json            # tool schema (required if skill exposes tools)
├── handlers.js           # tool implementations (optional; omitted = declarative-only)
├── manifest.json         # metadata, deps, version (required)
├── clips/                # animation GLBs (optional)
│   ├── wave-casual.glb
│   └── wave-enthusiastic.glb
├── morphs/               # morph target presets (optional)
│   └── happy.json
├── prompts/              # prompt templates referenced by SKILL.md (optional)
│   └── greeting.txt
├── assets/               # arbitrary other files (optional)
└── LICENSE
```

## manifest.json

```jsonc
{
	"spec": "skill/0.1",
	"name": "wave",
	"version": "0.1.0",
	"description": "Wave at the user with context-appropriate enthusiasm.",
	"author": "0xDeadBeef...", // optional wallet
	"license": "MIT",
	"tags": ["greeting", "gesture", "mixamo-compatible"],

	// Compatibility
	"requires": {
		"rig": ["mixamo", "any"], // rigs this skill works with
		"runtime": ">=0.1.0",
		"tools": ["play_clip"], // built-in tools this skill depends on
	},

	// Dependencies on other skills (composition)
	"dependencies": {
		"ipfs://bafy.../gesture-base/": "^1.0.0",
	},

	// What this skill adds
	"provides": {
		"tools": ["wave"], // declared in tools.json
		"triggers": ["greeting"], // semantic tags for skill discovery
	},

	// Content-addressed integrity (optional but recommended)
	"integrity": {
		"SKILL.md": "sha256-...",
		"tools.json": "sha256-...",
		"clips/wave-casual.glb": "sha256-...",
	},
}
```

## SKILL.md

Frontmatter + markdown. The LLM sees this as a system-prompt fragment whenever the skill is loaded.

```markdown
---
name: wave
description: Wave at the user with context-appropriate enthusiasm.
triggers:
    - user_greeting
    - user_farewell
    - introduction
cost: low
---

# Wave

When the user greets you, says goodbye, or when you are introduced to
someone, wave at them. Pick the clip based on the vibe:

- **wave-casual** — default, for most greetings
- **wave-enthusiastic** — when the user seems excited, or after a win
- **wave-subtle** — in a professional context or mid-conversation

Call `wave({ style: "casual" | "enthusiastic" | "subtle" })`.

Do not wave more than once per turn. Do not wave if you just waved.
```

Frontmatter fields:

| Field         | Type                        | Purpose                                                           |
| ------------- | --------------------------- | ----------------------------------------------------------------- |
| `name`        | string                      | Must match `manifest.json`                                        |
| `description` | string                      | One-line, used in skill discovery UIs                             |
| `triggers`    | string[]                    | Semantic tags — when LLM router sees these, it surfaces the skill |
| `cost`        | `low` \| `medium` \| `high` | Latency/token hint for the runtime to decide eager vs. lazy load  |

## tools.json

Standard tool-use schema (Anthropic / OpenAI compatible). This is what the LLM sees as callable functions.

```jsonc
{
	"tools": [
		{
			"name": "wave",
			"description": "Wave at the user.",
			"input_schema": {
				"type": "object",
				"properties": {
					"style": {
						"type": "string",
						"enum": ["casual", "enthusiastic", "subtle"],
						"default": "casual",
					},
					"duration_ms": {
						"type": "integer",
						"minimum": 500,
						"maximum": 5000,
						"default": 1500,
					},
				},
				"required": [],
			},
		},
	],
}
```

## handlers.js (optional)

ES module exporting one function per tool. Receives `(args, context)` where `context` exposes the live scene, viewer, memory, and built-in tools.

```js
// skills/wave/handlers.js
export async function wave(args, ctx) {
	const { style = 'casual', duration_ms = 1500 } = args;
	const clipUri = new URL(`clips/wave-${style}.glb`, ctx.skillBaseURI).href;

	const clip = await ctx.loadClip(clipUri);
	ctx.viewer.play(clip, { duration: duration_ms, blend: 0.2 });

	// Optional — annotate memory so the LLM doesn't double-wave
	ctx.memory.note('just_waved', { at: Date.now(), style });

	return { ok: true, played: style };
}
```

Handlers run in a sandboxed scope with a fixed `context` API. **They cannot**:

- Import arbitrary modules (only `ctx.*` is available)
- Touch `window` directly
- Make network calls outside `ctx.fetch` (which enforces CORS + IPFS gateway policy)
- Persist state outside `ctx.memory`

### The `context` API

```ts
interface SkillContext {
	// Scene control
	viewer: {
		play(clip: AnimationClip, opts?: PlayOptions): void;
		stop(clipName?: string): void;
		setExpression(preset: string): void;
		lookAt(target: Vector3 | 'user' | 'camera'): void;
		moveTo(position: Vector3, opts?: MoveOptions): void;
		scene: Scene; // read-only reference
	};

	// LLM
	llm: {
		complete(prompt: string, opts?: CompleteOpts): Promise<string>;
		embed(text: string): Promise<Float32Array>;
	};

	// Memory
	memory: {
		read(key: string): any;
		write(key: string, value: any): void;
		note(type: string, data: any): void; // appends to a timeline
		recall(query: string): Promise<MemoryEntry[]>;
	};

	// Asset loading
	loadClip(uri: string): Promise<AnimationClip>;
	loadGLB(uri: string): Promise<GLTF>;
	loadJSON(uri: string): Promise<any>;
	skillBaseURI: string; // base for relative asset resolution

	// Safe network
	fetch(uri: string, opts?: FetchOpts): Promise<Response>;

	// Cross-skill calls
	call(toolName: string, args: any): Promise<any>;

	// User interaction
	speak(text: string): Promise<void>;
	listen(opts?: ListenOpts): Promise<string>;
}
```

## Resolution & loading

```
manifest.json: skills: [{ uri: "ipfs://.../wave/", version: "0.1.0" }]
         │
         ▼
  fetch {uri}/manifest.json
         │
         ▼
  verify integrity hashes (if present)
         │
         ▼
  check requires.rig matches agent body.rig
         │
         ▼
  parallel fetch: SKILL.md, tools.json, handlers.js (if any)
         │
         ▼
  merge tools into runtime tool-use schema
         │
         ▼
  inject SKILL.md into system prompt
         │
         ▼
  skill is live; LLM can now call its tools
```

## Declarative-only skills

A skill without `handlers.js` is valid — it's pure prompt engineering + assets. Example: a "british-accent" skill that only contains `SKILL.md` ("Speak with a British accent. Use terms like 'brilliant', 'cheers', etc.") — no tools, no code, just context injection.

## Skill discovery

The runtime class is `SkillRegistry` ([src/skills/index.js](../src/skills/index.js)). Skills are installed explicitly with `registry.install({ uri, version })` and removed with `registry.uninstall(name)`; there is no built-in search method. Discovery over the installed set is caller-side iteration — e.g. filter `registry.all()` by manifest fields such as `tags`:

```js
const greeters = registry.all().filter((s) => s.manifest.tags?.includes("greeting"));
```

`registry.allTools()` merges every installed skill's tool schemas into the runtime tool-use schema, `registry.findSkillForTool(name)` resolves a tool name back to its skill, and `registry.systemPrompt()` concatenates the installed skills' `SKILL.md` fragments for the system prompt.

Install specs come from:

1. The local manifest's `skills` array.
2. Optional HTTPS skill index (community-hosted).
3. On-chain skill registry (if deployed) — same ERC-8004-style pattern, agents can publish + own skills.

## Security model

- **Declarative skills** (no `handlers.js`) are always safe to load.
- **Code skills** execute in a shared **Web Worker** (`src/skills/sandbox-worker.js`). The worker has no DOM, no `window`, no `document`, and no `localStorage` or `cookie` access. Handlers cannot read or write page state.
- The worker receives handler source as text and loads it via a `blob:` URL dynamic `import()`. This prevents handlers from importing external modules at load time.
- Each `ctx.*` method call from inside the worker becomes a structured-cloneable `postMessage` round-trip to the main thread. The main thread validates and dispatches the call, then returns the result. Non-serializable objects (e.g. `AnimationClip`, `GLTF`) are stored in a host-side handle registry and represented to the worker as opaque `"@h:N"` strings.
- `ctx.fetch` and `ctx.loadJSON` use the worker's native `fetch` — no main-thread proxy is needed. Standard CORS rules apply (same-origin and credentialed-CORS requests work; cross-origin without CORS headers are blocked by the browser as usual).
- Individual `ctx.*` calls time out after **30 seconds**. A timed-out or errored handler surfaces as `{ error: "..." }` to the runtime without crashing the worker.
- Agent owners set a **skill trust policy** per agent: `trust: "any" | "whitelist" | "owned-only"`.
    - `owned-only` (default) — only run skills signed by the agent's owner wallet.
    - `whitelist` — allow a list of publisher wallets.
    - `any` — wild west, allowed for kiosks/demos.
- Integrity hashes are verified before handlers execute.

### Opt-out: `sandboxPolicy: "trusted-main-thread"`

Owner-signed skills that require main-thread capabilities (Three.js direct access, `window.*` APIs, or performance-sensitive frame-tick work) can bypass the worker by setting in `manifest.json`:

```jsonc
{
	"sandboxPolicy": "trusted-main-thread",
}
```

When this flag is present, `handlers.js` is loaded via a direct `import()` in the main thread and called synchronously — the same as the pre-sandbox behavior. This opt-out is only meaningful for skills that pass the `owned-only` or `whitelist` trust check; `any`-trust skills should remain sandboxed.

Rationale for the name: it describes where the code runs (`main-thread`) and the precondition (`trusted`), making the security trade-off explicit to manifest authors.

### What sandboxed handlers cannot do

- Read `document.cookie`, `window.localStorage`, `sessionStorage`, or any DOM API.
- Access `window`, `navigator`, or `location` from handler code.
- Import external modules (no `import` statements in handler source — the blob context has no base URL for relative imports).
- Make arbitrary network calls outside `ctx.fetch` / `ctx.loadJSON` (CORS still applies).

### What sandboxed handlers can still do

All `ctx.*` capabilities listed in the API section above — animation, memory, speech, LLM, cross-skill calls — work identically via the postMessage proxy.

## Worked example: the `wave` skill

```
skills/wave/
├── manifest.json
├── SKILL.md
├── tools.json
├── handlers.js
├── clips/
│   ├── wave-casual.glb
│   ├── wave-enthusiastic.glb
│   └── wave-subtle.glb
└── LICENSE
```

Files above — `manifest.json`, `SKILL.md`, `tools.json`, `handlers.js` — are exactly as shown in the sections above. A publisher can `ipfs add -r skills/wave/` and hand out the resulting CID; any agent can then install via:

```json
{ "uri": "ipfs://bafy.../", "version": "0.1.0" }
```

## Versioning

- `spec: skill/0.1` — skill format itself.
- `version` in `manifest.json` — semver, author-controlled.
- Agents can pin `"version": "0.1.0"` or range `"^0.1.0"`.
- Version resolution prefers highest-compatible published version within range.

## See also

- [AGENT_MANIFEST.md](./AGENT_MANIFEST.md) — how agents reference skills
- [EMBED_SPEC.md](./EMBED_SPEC.md) — how skills are surfaced in the web component
