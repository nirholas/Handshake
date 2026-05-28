# Skills System

Skills are the extension mechanism for three.ws — modular, portable capability bundles that tell an agent *what it can do* and *how to do it*. A skill packages together the LLM instructions, the tool schema, and the JavaScript handler that runs when the tool is called. Because a skill is just a directory of files served from any URL, the same wave skill can be installed in every agent you build without copying any code.

This document covers how to install skills, how to write them, the full context API available to handlers, the security model, and the lifecycle events that let host pages observe skill execution.

---

## What a skill contains

Every skill is a directory (a "bundle") with up to four files:

| File | Required | Purpose |
|------|----------|---------|
| `manifest.json` | yes | Metadata, version, dependencies, compatibility |
| `SKILL.md` | yes | LLM instructions — injected into the system prompt |
| `tools.json` | yes (if exposing tools) | JSON Schema tool definitions the LLM can invoke |
| `handlers.js` | no | ES module that implements each tool |

A skill without `handlers.js` is valid — it is a *declarative skill* that only injects prompt context. A "british-accent" skill that contains only `SKILL.md` ("Speak with a British accent. Use terms like 'brilliant', 'cheers'.") needs no handlers and no tools.

### Full bundle layout

```
wave/
├── manifest.json
├── SKILL.md
├── tools.json
├── handlers.js
├── clips/
│   ├── wave-casual.glb
│   ├── wave-enthusiastic.glb
│   └── wave-subtle.glb
├── morphs/
│   └── happy.json
├── prompts/
│   └── greeting.txt
├── assets/
└── LICENSE
```

Assets (clips, morphs, prompts) are co-located in the bundle. Handlers reference them via `ctx.skillBaseURI` — the runtime resolves relative paths against the bundle's base URL automatically.

---

## Built-in skills

These skills come pre-installed in every agent. They live in `src/agent-skills.js` and require no installation.

| Skill | What it does |
|-------|-------------|
| `greet` | Wave and say hello on load |
| `present-model` | Describe the loaded 3D model (name, animations, polygon count) |
| `validate-model` | Run glTF validation and report errors and warnings |
| `remember` | Store user-provided information to agent memory |
| `think` | Surface internal reasoning as a thought bubble in the UI |
| `sign-action` | Sign the current action with the connected wallet |
| `help` | List available skills and commands |

Built-in skills that are `mcpExposed: true` are also surfaced as MCP tools via `/api/mcp` — external tools can invoke them by name as `skill_<name>` (hyphens converted to underscores).

---

## Installing a skill

### From the agent manifest

Reference skills by URI in the agent's `manifest.json`. The runtime fetches and installs them at startup:

```json
{
  "skills": [
    { "uri": "https://cdn.three.ws/skills/wave/", "version": "0.1.0" },
    { "uri": "ipfs://bafy.../validate-model/", "version": "^1.0.0" }
  ]
}
```

URIs can be HTTPS, IPFS (`ipfs://`), or Arweave (`ar://`). IPFS URIs are resolved through a gateway fallback chain (ipfs.io → dweb.link → nft.storage).

### Via the web component attribute

Pass a JSON array to the `skills` attribute:

```html
<agent-3d
  agent-id="my-agent"
  skills='[{"uri":"https://cdn.three.ws/skills/wave/","version":"0.1.0"}]'
></agent-3d>
```

### At runtime via JavaScript

```js
const el = document.querySelector('agent-3d');
await el.agent.skills.install({ uri: 'https://example.com/skills/weather/' });
```

---

## Skill manifest format

`manifest.json` describes the skill, its compatibility requirements, and what it provides:

```jsonc
{
  "spec": "skill/0.1",
  "name": "wave",
  "version": "0.1.0",
  "description": "Wave at the user with context-appropriate enthusiasm.",
  "author": "0xDeadBeef...",   // optional — wallet address or name
  "license": "MIT",
  "tags": ["greeting", "gesture", "mixamo-compatible"],

  // Compatibility — runtime checks these before installing
  "requires": {
    "rig": ["mixamo", "any"],  // rigs this skill works with
    "runtime": ">=0.1.0",
    "tools": ["play_clip"]     // built-in tools this skill depends on
  },

  // Skill dependencies — installed recursively before this skill
  "dependencies": {
    "https://cdn.three.ws/skills/gesture-base/": "^1.0.0"
  },

  // What this skill adds to the agent
  "provides": {
    "tools": ["wave"],
    "triggers": ["greeting", "farewell", "introduction"]
  },

  // Content-addressed integrity (optional but recommended)
  "integrity": {
    "SKILL.md": "sha256-...",
    "tools.json": "sha256-...",
    "handlers.js": "sha256-..."
  }
}
```

**Field reference:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `spec` | string | yes | Always `"skill/0.1"` |
| `name` | string | yes | Unique identifier; must match `SKILL.md` frontmatter |
| `version` | string | yes | Semver |
| `description` | string | yes | One-line summary |
| `requires` | object | no | Runtime/rig/tool compatibility constraints |
| `dependencies` | object | no | Other skill URIs to install first (recursive) |
| `provides` | object | no | Declared tools and semantic trigger tags |
| `integrity` | object | no | SHA-256 hashes for verification before execution |
| `sandboxPolicy` | string | no | Set to `"trusted-main-thread"` to bypass the worker sandbox |
| `author` | string | no | Wallet address or author name; enforced under `owned-only` trust |
| `license` | string | no | SPDX license identifier |
| `tags` | array | no | Used by skill discovery queries |

---

## SKILL.md — LLM instructions

The `SKILL.md` file is injected into the agent's system prompt whenever the skill is loaded. It tells the LLM when and how to use the skill's tools. Write it as instruction, not description — it speaks directly to the model.

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

**Frontmatter fields:**

| Field | Type | Purpose |
|-------|------|---------|
| `name` | string | Must match `manifest.json` |
| `description` | string | Used in skill discovery UIs |
| `triggers` | string[] | Semantic tags that surface this skill in the router |
| `cost` | `low` \| `medium` \| `high` | Latency hint — controls eager vs. lazy loading |

The runtime wraps the markdown body in a `<skill name="..." version="...">` XML tag before injecting it, so the LLM can attribute which skill each instruction came from.

---

## tools.json — tool schema

`tools.json` defines the callable functions the LLM sees. The format follows the Anthropic tool-use schema (`input_schema`, not `parameters`):

```json
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
            "default": "casual"
          },
          "duration_ms": {
            "type": "integer",
            "minimum": 500,
            "maximum": 5000,
            "default": 1500
          }
        },
        "required": []
      }
    }
  ]
}
```

The runtime merges tool schemas from all installed skills before each LLM call. If two skills expose a tool with the same name, the later-installed skill wins and a warning is logged.

---

## Writing a handler

Handlers are ES modules. Export one `async` function per tool name. The function receives the validated arguments from the LLM call and a context object:

```js
// handlers.js
export async function wave(args, ctx) {
  const { style = 'casual', duration_ms = 1500 } = args;

  // Try to play a style-specific clip shipped with the skill bundle.
  let played = false;
  try {
    const clip = await ctx.loadClip(
      new URL(`clips/wave-${style}.glb`, ctx.skillBaseURI).href
    );
    if (clip) {
      await ctx.viewer.play(clip, { blend: 0.2 });
      played = true;
    }
  } catch {
    // No bundled clip — fall back to built-in animation hint.
  }

  if (!played) {
    played = ctx.viewer.playAnimationByHint('wave', { duration_ms });
  }

  ctx.memory.note('waved', { style, played });
  return { ok: played, style };
}
```

**Handler signature:**

```js
async function toolName(args, ctx) {
  // args: validated parameters from the LLM tool call
  // ctx:  SkillContext — see full API below
  return { ok: true, ...result };
}
```

Return `{ ok: true, ... }` on success and `{ ok: false, error: 'message' }` on failure. The runtime surfaces errors to the LLM and to the `skill-error` protocol event.

### The context API

```ts
interface SkillContext {
  // Scene control
  viewer: {
    play(clip: AnimationClip, opts?: { blend?: number }): Promise<void>;
    stop(clipName?: string): void;
    setExpression(preset: string): void;
    lookAt(target: Vector3 | 'user' | 'camera'): void;
    moveTo(position: Vector3, opts?: MoveOptions): void;
    playAnimationByHint(hint: string, opts?: { duration_ms?: number }): boolean;
    scene: Scene;  // read-only reference to the Three.js scene
  };

  // LLM access
  llm: {
    complete(prompt: string, opts?: CompleteOpts): Promise<string>;
    embed(text: string): Promise<Float32Array>;
  };

  // Memory
  memory: {
    read(key: string): any;
    write(key: string, value: any): void;
    note(type: string, data: any): void;    // appends to timeline
    recall(query: string): Promise<MemoryEntry[]>;
  };

  // Asset loading (paths resolved relative to skillBaseURI)
  loadClip(uri: string): Promise<AnimationClip>;
  loadGLB(uri: string): Promise<GLTF>;
  loadJSON(uri: string): Promise<any>;
  skillBaseURI: string;  // base URL of this skill's bundle

  // Network (CORS rules apply)
  fetch(uri: string, opts?: RequestInit): Promise<Response>;

  // Cross-skill calls
  call(toolName: string, args: any): Promise<any>;

  // User interaction
  speak(text: string): Promise<void>;
  listen(opts?: ListenOpts): Promise<string>;
}
```

**Key points:**

- `ctx.skillBaseURI` always ends with `/`. Use `new URL('./clips/file.glb', ctx.skillBaseURI).href` for portable asset resolution.
- `ctx.memory.recall()` is substring search — no embeddings yet.
- `ctx.call()` invokes another tool by name. It crosses skill boundaries — you can call a built-in like `speak` from inside a custom skill handler.
- `ctx.viewer.scene` is a read-only reference. Use the `viewer` methods to manipulate state rather than mutating the scene graph directly.
- Individual `ctx.*` calls time out after **30 seconds**. A timed-out handler surfaces as `{ error: "..." }` without crashing the agent.

---

## Skill sandboxing

By default, handlers run in a Web Worker (`src/skills/sandbox-worker.js`). The worker has no DOM, no `window`, no `document`, no `localStorage`, and no `cookie` access.

The worker receives handler source as text and loads it via a `blob:` URL dynamic `import()`. Each `ctx.*` call from inside the worker becomes a structured-cloneable `postMessage` round-trip to the main thread, which validates and dispatches it, then returns the result. Non-serializable objects (like `AnimationClip` or `GLTF`) are stored in a host-side handle registry and represented to the worker as opaque handle strings.

**Sandboxed handlers cannot:**
- Read `document.cookie`, `window.localStorage`, `sessionStorage`, or any DOM API
- Access `window`, `navigator`, or `location`
- Import external modules (no `import` statements in handler source — the blob context has no base URL for relative imports)
- Make network requests outside `ctx.fetch` and `ctx.loadJSON` (standard CORS rules apply)

**Sandboxed handlers can still do everything via `ctx.*`** — animation, memory, speech, LLM calls, cross-skill calls — through the postMessage proxy.

### Trusted main-thread opt-out

Owner-signed skills that require direct Three.js access, `window.*` APIs, or per-frame work can opt out of the sandbox:

```jsonc
{
  "sandboxPolicy": "trusted-main-thread"
}
```

When this flag is present, `handlers.js` is loaded via a direct `import()` in the main thread. This opt-out only applies to skills that pass the `owned-only` or `whitelist` trust check — `any`-trust skills remain sandboxed regardless.

---

## Trust and security

The `SkillRegistry` enforces a trust policy set per agent:

| Mode | Behavior |
|------|---------|
| `owned-only` | Only run skills where `manifest.author` matches the agent owner's wallet (default) |
| `whitelist` | Allow skills from a configured list of publisher wallets |
| `any` | All skills from any URL are allowed — use for kiosks and demos |

Trust is configured in the agent manifest or passed to `SkillRegistry`:

```js
new SkillRegistry({ trust: 'owned-only', ownerAddress: '0xDeadBeef...' });
```

If a skill's `author` field does not match `ownerAddress` under `owned-only` policy, `install()` throws before fetching any handler code. If `integrity` hashes are present in the manifest, they are verified before any handler executes.

Declarative skills (no `handlers.js`) are always safe to load regardless of trust policy.

---

## Skill dependencies

Skills can depend on other skills. The registry installs dependencies recursively before the depending skill:

```jsonc
{
  "name": "full-coaching-kit",
  "version": "1.0.0",
  "dependencies": {
    "https://cdn.three.ws/skills/wave/": "^0.1.0",
    "https://cdn.three.ws/skills/validate-model/": "^1.0.0"
  },
  "provides": { "tools": [] }
}
```

The `dependencies` object maps skill URIs to version ranges. Circular dependencies are detected and rejected. If a skill URI is already installed, it is not re-fetched.

---

## Skill lifecycle events

The agent protocol bus fires events at each stage of skill execution. Listen to these in the host page to react to skill activity:

```js
const el = document.querySelector('agent-3d');

// Fires when the runtime dispatches a tool call to a skill handler
el.addEventListener('perform-skill', e => {
  console.log('Skill starting:', e.detail.skill, e.detail.args);
});

// Fires when the handler returns successfully
el.addEventListener('skill-done', e => {
  console.log('Skill done:', e.detail.skill, e.detail.result);
});

// Fires when the handler throws or times out
el.addEventListener('skill-error', e => {
  console.error('Skill error:', e.detail.skill, e.detail.error);
});
```

**Event payloads:**

| Event | `detail` shape |
|-------|---------------|
| `perform-skill` | `{ skill: string, args: object, animationHint?: string }` |
| `skill-done` | `{ skill: string, result: { ok, output?, sentiment?, data? } }` |
| `skill-error` | `{ skill: string, error: string }` |

`skill-done` results with a `sentiment` number (−1 to 1) trigger the avatar's empathy layer — positive values produce a celebration blend, negative values produce concern.

---

## Calling skills programmatically

```js
const el = document.querySelector('agent-3d');

// Execute a skill tool directly, bypassing the LLM
const result = await el.agent.skills.perform('wave', { style: 'enthusiastic' });
console.log(result); // { ok: true, style: 'enthusiastic' }

// List all installed skills (built-in + installed)
const skills = el.agent.skills.list();

// Get a specific skill definition
const waveDef = el.agent.skills.get('wave');
```

For external skills installed via `SkillRegistry`, invoke via the registry:

```js
const skill = el.agentRuntime.skillRegistry.findSkillForTool('get_weather');
const result = await skill.invoke('get_weather', { city: 'Berlin' }, ctx);
```

---

## Skill loading sequence

When a skill URI is installed, the runtime follows this sequence:

```
{ uri, version }
      │
      ▼
fetch {uri}/manifest.json
      │
      ▼
enforce trust policy (author vs. ownerAddress)
      │
      ▼
verify integrity hashes (if present)
      │
      ▼
check requires.rig matches agent body.rig
      │
      ▼
install dependencies (recursive)
      │
      ▼
parallel fetch: SKILL.md, tools.json, handlers.js
      │
      ▼
merge tools into runtime tool-use schema
      │
      ▼
inject SKILL.md into system prompt as <skill> fragment
      │
      ▼
skill is live — LLM can now call its tools
```

---

## Worked example: the `wave` skill

The wave skill in `examples/skills/wave/` is the minimal complete example. Here is every file.

### `manifest.json`

```json
{
  "spec": "skill/0.1",
  "name": "wave",
  "version": "0.1.0",
  "description": "Wave at the user with context-appropriate enthusiasm.",
  "license": "MIT",
  "tags": ["greeting", "gesture", "mixamo-compatible"],
  "requires": {
    "rig": ["mixamo", "any"],
    "runtime": ">=0.1.0",
    "tools": []
  },
  "provides": {
    "tools": ["wave"],
    "triggers": ["greeting", "farewell", "introduction"]
  }
}
```

### `tools.json`

```json
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
            "default": "casual"
          },
          "duration_ms": {
            "type": "integer",
            "minimum": 500,
            "maximum": 5000,
            "default": 1500
          }
        },
        "required": []
      }
    }
  ]
}
```

### `SKILL.md`

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

When the user greets you, says goodbye, or when you are introduced,
wave at them. Pick the clip based on the vibe:

- **wave-casual** — default, for most greetings
- **wave-enthusiastic** — when the user seems excited, or after a win
- **wave-subtle** — in a professional context or mid-conversation

Call `wave({ style: "casual" | "enthusiastic" | "subtle" })`.

Do not wave more than once per turn.
```

### `handlers.js`

```js
export async function wave(args, ctx) {
  const { style = 'casual', duration_ms = 1500 } = args;

  let played = false;
  try {
    const clip = await ctx.loadClip(
      new URL(`clips/wave-${style}.glb`, ctx.skillBaseURI).href
    );
    if (clip) {
      await ctx.viewer.play(clip, { blend: 0.2 });
      played = true;
    }
  } catch {
    // No bundled clip — fall back to built-in animation hint.
  }

  if (!played) {
    played = ctx.viewer.playAnimationByHint('wave', { duration_ms });
  }

  ctx.memory.note('waved', { style, played });
  return { ok: played, style };
}
```

The handler tries to load a style-specific GLB clip from the bundle (e.g. `clips/wave-casual.glb`). If the clip is not found, it falls back to `playAnimationByHint('wave')`, which searches the loaded model's existing animation tracks for one tagged with the `wave` hint. This makes the skill work on any Mixamo avatar whether or not you ship animation clips.

---

## Worked example: Coach Leo

`examples/coach-leo/` shows a complete agent manifest that references the wave skill. Key sections of [examples/coach-leo/manifest.json](../../examples/coach-leo/manifest.json):

```json
{
  "spec": "agent-manifest/0.1",
  "name": "Coach Leo",
  "body": {
    "uri": "/avatars/cz.glb",
    "rig": "mixamo",
    "boundingBoxHeight": 1.78
  },
  "brain": {
    "provider": "anthropic",
    "model": "claude-opus-4-7",
    "instructions": "instructions.md",
    "temperature": 0.8,
    "maxTokens": 2048
  },
  "skills": [
    { "uri": "../skills/wave/", "version": "0.1.0" }
  ],
  "tools": ["wave", "lookAt", "play_clip", "setExpression", "speak", "remember"]
}
```

The `tools` array in the agent manifest is the allowlist of built-in tools the LLM can call directly. The `skills` array references external skill bundles to install. Together they define the agent's complete capability surface.

Coach Leo's `instructions.md` uses the wave skill naturally:

```markdown
When the user greets you, call `wave()` to wave at them.
When they describe a drill, set a focused expression with
`setExpression({ preset: "focused" })` while you explain,
then smile afterward.
```

This is the pattern: `SKILL.md` in the skill bundle explains the tool in the abstract; the agent's `instructions.md` tells this specific persona when and why to use it.

---

## Publishing a skill

A skill is just a directory of static files. Publish it anywhere:

- **GitHub Releases** — attach a zip, reference the raw URL
- **Vercel / Netlify / S3** — deploy the directory as a static site
- **IPFS** — `ipfs add -r skills/wave/` and distribute the CID
- **npm** — include the bundle under `public/skills/skill-name/` and reference via a CDN like jsDelivr

**Convention:** name the manifest `manifest.json` and co-locate `handlers.js` in the same directory. Agents resolve all relative paths (`./clips/`, `./prompts/`) against the manifest's URL, so the layout must be preserved.

```
skills/wave/
├── manifest.json      ← fetched first
├── SKILL.md
├── tools.json
├── handlers.js
└── clips/
    ├── wave-casual.glb
    └── wave-enthusiastic.glb
```

For IPFS publishing, the CID of the directory becomes the stable URI. Agents can pin a specific version by CID and upgrade by updating the URI.

---

## Versioning

- `spec: "skill/0.1"` — the skill bundle format version.
- `version` in `manifest.json` — semver, author-controlled, used for dependency resolution.
- Agent manifests can pin an exact version (`"0.1.0"`) or a range (`"^0.1.0"`).
- The runtime prefers the highest-compatible published version within range.

---

## See also

- [Architecture Overview](./architecture.md) — how skills fit into the agent runtime
- [Agent System](./agent-system.md) — the protocol bus and built-in tool system
- [Web Component](./web-component.md) — embedding agents and passing skill attributes
- `specs/SKILL_SPEC.md` — the authoritative skill bundle specification
- `specs/PERMISSIONS_SPEC.md` — ERC-7710/ERC-7715 delegation for fine-grained skill permissions
