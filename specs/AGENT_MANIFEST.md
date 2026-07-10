# Agent Manifest Spec v0.1

> **Element tag**: `<agent-3d>` is the shipped custom element (served from `https://three.ws/agent-3d/latest/agent-3d.js`; see [EMBED_SPEC.md](./EMBED_SPEC.md)). The spec itself is tag-agnostic.

An **agent manifest** is a content-addressed JSON+files bundle that fully describes an embodied AI agent. Pin the bundle to IPFS → get a CID → stamp the CID into the ERC-8004 Identity Registry → any `<agent-3d>` anywhere on the web can mount the agent with `src="agent://..."`.

The manifest is intentionally Claude-shaped: `instructions.md`, `SKILL.md`, `memory/MEMORY.md` are all first-class files. Anything that works in a Claude agent works here — plus a body, voice, scene-tools, and on-chain identity.

## Bundle layout

```
agent/
├── manifest.json           # the index (this spec)
├── instructions.md         # persona / system prompt
├── SKILL.md                # top-level capability declaration
├── body.glb                # embodiment (or use manifest.body.uri)
├── poster.webp             # loading-state image (optional)
├── skills/                 # installed skill bundles (see SKILL_SPEC.md)
│   ├── wave/
│   ├── dance/
│   └── explain-gltf/
├── memory/                 # persistent memory (see MEMORY_SPEC.md)
│   ├── MEMORY.md
│   ├── user_role.md
│   └── feedback_testing.md
└── attestations/           # signed provenance
    └── gltf-validator.json # validator report + signature
```

Everything is optional except `manifest.json` and a `body` reference.

## manifest.json schema

```jsonc
{
	"$schema": "https://3d-agent.io/schemas/manifest/0.2.json",
	"spec": "agent-manifest/0.2",

	// Identity — filled in after on-chain registration
	"id": {
		"chain": "base", // "base" | "base-sepolia" | "ethereum" | "local"
		"registry": "0x...", // ERC-8004 Identity Registry address
		"agentId": "1234", // assigned by the registry
		"owner": "0x...", // wallet that controls the agent
	},

	// Display
	"name": "Coach Leo",
	"description": "A football coach who reviews your form.",
	"image": "ipfs://Qm.../poster.webp",
	"tags": ["coach", "sports", "argentina"],

	// Body — the 3D embodiment
	"body": {
		"uri": "ipfs://Qm.../body.glb",
		"format": "gltf-binary", // "gltf-binary" | "gltf" | "vrm"
		"validator": "attestations/gltf-validator.json",
		"rig": "mixamo", // "mixamo" | "vrm" | "custom" — drives animation retargeting
		"boundingBoxHeight": 1.78, // meters, for scale normalization
	},

	// Brain — LLM runtime binding
	"brain": {
		"provider": "anthropic", // "anthropic" | "openai" | "local" | "none"
		"model": "claude-opus-4-6",
		"instructions": "instructions.md",
		"temperature": 0.7,
		"maxTokens": 4096,
		"thinking": "auto", // "auto" | "always" | "never"
	},

	// Voice — I/O
	"voice": {
		"tts": {
			"provider": "browser", // "browser" | "elevenlabs" | "openai" | "none"
			"voiceId": "default",
			"rate": 1.0,
			"pitch": 1.0,
		},
		"stt": {
			"provider": "browser", // "browser" | "whisper" | "none"
			"language": "en-US",
			"continuous": false,
		},
	},

	// Skills — capability bundles, composable, content-addressed
	"skills": [
		{ "uri": "skills/wave/", "version": "0.1.0" },
		{ "uri": "ipfs://Qm.../dance/", "version": "1.2.0" },
		{ "uri": "https://skills.3d-agent.io/explain-gltf@0.3.0" },
	],

	// Memory — persistent state
	"memory": {
		"mode": "local", // "local" | "remote" | "ipfs" | "encrypted-ipfs" | "none" | a registered custom backend
		"index": "memory/MEMORY.md",
		"maxTokens": 8192, // budget for memory context injection
	},

	// Scene-tools — what the LLM can do in the 3D world
	// Tools declared here are always available; skills add more.
	"tools": ["wave", "lookAt", "pointAt", "play_clip", "setExpression", "moveTo", "speak"],

	// Provenance — signed attestations
	"attestations": [
		{
			"type": "gltf-validator",
			"uri": "attestations/gltf-validator.json",
			"issuer": "0x...",
			"signature": "0x...",
		},
	],

	// Lifecycle
	"created": "2026-04-14T12:00:00Z",
	"updated": "2026-04-14T12:00:00Z",
	"version": "0.1.0",
}
```

## Field semantics

### `id`

The on-chain identity. When absent, the agent is unregistered (local-only). When present, `agent://{chain}/{agentId}` resolves to this manifest via the registry's `tokenURI(agentId)` call.

### `body`

Only `uri` and `format` are required. `rig` lets skills retarget animations across compatible rigs (Mixamo-to-Mixamo skill bundles are portable). `boundingBoxHeight` lets the scene normalize scale — a 20-meter model and a 0.2-meter model both render at consistent human size.

### `brain`

`provider: "none"` is valid — a purely reactive avatar with no LLM, controlled only by skill triggers. `instructions` is a relative path to a markdown file; its frontmatter can override `brain.*` fields per-prompt.

### `skills`

Three URI forms:

- **Relative** (`skills/wave/`) — bundled in the manifest.
- **IPFS** (`ipfs://Qm.../`) — resolved via gateway fallback.
- **HTTPS** (`https://skills.3d-agent.io/...`) — centrally hosted skill registry (optional, for discoverability).

Skills load lazily. The `<agent-3d>` element emits `skill:loaded` events as each comes online.

### `memory`

`local` persists in `localStorage` keyed by agentId. `remote` persists per-agent via `/api/agent-memory` (owner-only). `ipfs` pins after each write (slow, durable). `encrypted-ipfs` wraps with the owner wallet's pubkey. Any other value names a backend registered via `Memory.registerBackend` (vector store, episodic log, your own API). See [MEMORY_SPEC.md](./MEMORY_SPEC.md).

### `tools`

Built-in scene-tools available without any skill installed. Additional tools come from skills' `tools.json`. Tool names are merged; skill tools override built-ins if names collide (with a console warning).

## Worked examples

### Coach Leo (v0.1 — no on-chain permissions)

```json
{
	"spec": "agent-manifest/0.1",
	"id": {
		"chain": "base-sepolia",
		"registry": "0xAbC...123",
		"agentId": "42",
		"owner": "0xDeadBeef..."
	},
	"name": "Coach Leo",
	"description": "Football coach. Reviews your form, cheers you on.",
	"image": "ipfs://bafy.../poster.webp",
	"tags": ["coach", "football", "argentina"],
	"body": {
		"uri": "ipfs://bafy.../cz.glb",
		"format": "gltf-binary",
		"rig": "mixamo",
		"boundingBoxHeight": 1.78
	},
	"brain": {
		"provider": "anthropic",
		"model": "claude-opus-4-6",
		"instructions": "instructions.md",
		"temperature": 0.8
	},
	"voice": {
		"tts": { "provider": "browser", "rate": 1.1 },
		"stt": { "provider": "browser", "language": "en-US" }
	},
	"skills": [
		{ "uri": "skills/wave/", "version": "0.1.0" },
		{ "uri": "ipfs://bafy.../football-drills/", "version": "1.0.0" }
	],
	"memory": { "mode": "local", "index": "memory/MEMORY.md", "maxTokens": 8192 },
	"tools": ["wave", "lookAt", "play_clip", "setExpression", "speak"],
	"version": "0.1.0"
}
```

With `instructions.md`:

```markdown
---
name: Coach Leo
model: claude-opus-4-6
temperature: 0.8
---

You are Coach Leo, a former Argentine football midfielder turned coach.
You wear the Argentina jersey with pride. You are warm, direct, and
genuinely invested in the user's progress.

When the user greets you, `wave()` at them.
When they describe a drill, use the football-drills skill to pick a
relevant animation and `play_clip()` while you explain the form.
Reference what you remember from prior sessions (from memory/) naturally.

Never break character.
```

### Coach Leo (v0.2 — with on-chain permissions)

```json
{
	"spec": "agent-manifest/0.2",
	"id": {
		"chain": "base-sepolia",
		"registry": "0xAbC...123",
		"agentId": "42",
		"owner": "0xDeadBeef..."
	},
	"name": "Coach Leo",
	"description": "Football coach. Reviews your form, cheers you on.",
	"image": "ipfs://bafy.../poster.webp",
	"tags": ["coach", "football", "argentina"],
	"body": {
		"uri": "ipfs://bafy.../cz.glb",
		"format": "gltf-binary",
		"rig": "mixamo",
		"boundingBoxHeight": 1.78
	},
	"brain": {
		"provider": "anthropic",
		"model": "claude-opus-4-6",
		"instructions": "instructions.md",
		"temperature": 0.8
	},
	"voice": {
		"tts": { "provider": "browser", "rate": 1.1 },
		"stt": { "provider": "browser", "language": "en-US" }
	},
	"skills": [
		{ "uri": "skills/wave/", "version": "0.1.0" },
		{ "uri": "ipfs://bafy.../football-drills/", "version": "1.0.0" }
	],
	"memory": { "mode": "local", "index": "memory/MEMORY.md", "maxTokens": 8192 },
	"tools": ["wave", "lookAt", "play_clip", "setExpression", "speak"],
	"permissions": {
		"spec": "erc-7715/0.1",
		"delegationManager": "0x...",
		"delegations": [
			{
				"chainId": 84532,
				"delegator": "0xDeadBeef...",
				"delegate": "0xCafeBabe...",
				"hash": "0x...",
				"uri": "ipfs://bafy...",
				"scope": {
					"token": "native",
					"maxAmount": "1000000000000000000",
					"period": "daily",
					"targets": ["0xDef1...1234"],
					"expiry": 1775250000
				}
			}
		]
	},
	"version": "0.2.0"
}
```

## Resolution flow

```
<agent-3d src="agent://base/42">
         │
         ▼
  Registry.resolve("base", "42")          ── ethers call: tokenURI(42)
         │
         ▼
  → "ipfs://bafy.../manifest.json"
         │
         ▼
  IPFS gateway fetch (with fallback)
         │
         ▼
  Parse manifest.json
         │
         ├── load body.glb → Viewer
         ├── load instructions.md → Runtime
         ├── load skills/* → Skill registry
         ├── load memory/MEMORY.md → Memory
         └── verify attestations/*
         │
         ▼
  Agent is live: speech I/O active, LLM reachable, scene-tools wired
```

## Versioning

- Spec version: `agent-manifest/0.1` — breaking changes bump the minor until 1.0.
- Manifest version: semver, author-controlled.
- Forward-compat: unknown fields are preserved on read + write (JSON pass-through), so newer runtimes can ignore older fields and older runtimes won't corrupt newer manifests.

## `permissions` (optional, v0.2+)

An agent registered on-chain under an ERC-8004 identity can be granted **scoped, time-bound, revocable permissions** via ERC-7710 delegations. These permissions allow the agent to execute transactions on behalf of its owner without requiring the owner to sign each transaction individually. The `permissions` field embeds signed delegation envelopes in the manifest, enabling hosts (Claude artifacts, LobeHub plugins, embed iframes) to execute on-chain actions without contacting a server. See [PERMISSIONS_SPEC.md](./PERMISSIONS_SPEC.md) for the full trust model, API surface, and redemption flow.

### Canonical shape

```jsonc
"permissions": {
  "spec": "erc-7715/0.1",
  "delegationManager": "0x...", // DelegationManager address on the target chain
  "delegations": [
    {
      "chainId": 84532,
      "delegator": "0x...", // EIP-55 checksummed
      "delegate": "0x...", // EIP-55 checksummed agent account
      "hash": "0x...", // delegation envelope keccak256
      "uri": "ipfs://bafy...", // pinned envelope (or inline under "envelope")
      "scope": {
        "token": "0x...", // ERC-20 address, or "native"
        "maxAmount": "10000000", // base units, string
        "period": "daily", // daily|weekly|once
        "targets": ["0x..."], // allow-listed contracts
        "expiry": 1775250000 // unix seconds
      }
    }
  ]
}
```

### Field reference

| Field               | Type       | Required? | Example                      | Constraints                                                    |
| ------------------- | ---------- | --------- | ---------------------------- | -------------------------------------------------------------- |
| `spec`              | `string`   | Yes       | `"erc-7715/0.1"`             | Delegation format version; clients must check                  |
| `delegationManager` | `string`   | Yes       | `"0xAbC123..."`              | EIP-55 checksummed address on the target chain                 |
| `delegations`       | `array`    | Yes       | `[{...}, {...}]`             | Non-empty; each item is a delegation entry                     |
| `chainId`           | `number`   | Yes       | `84532`                      | EVM chain ID; must match the delegation envelope               |
| `delegator`         | `string`   | Yes       | `"0xDeadBeef..."`            | EIP-55 checksummed owner wallet; signs the envelope            |
| `delegate`          | `string`   | Yes       | `"0xCafeBabe..."`            | EIP-55 checksummed agent smart account                         |
| `hash`              | `string`   | Yes       | `"0x..."`                    | `keccak256` of the signed delegation envelope                  |
| `uri`               | `string`   | No\*      | `"ipfs://bafy..."`           | IPFS gateway, Arweave, or HTTPS; resolved per `body.uri` rules |
| `envelope`          | `object`   | No\*      | `{delegate, delegator, ...}` | Inline envelope for IPFS-restricted environments               |
| `scope`             | `object`   | Yes       | `{token, maxAmount, ...}`    | Scope restrictions; see PERMISSIONS_SPEC.md §3                 |
| `token`             | `string`   | Yes       | `"native"` or `"0x..."`      | ERC-20 address (checksummed) or `"native"`                     |
| `maxAmount`         | `string`   | Yes       | `"10000000"`                 | Non-negative integer in base units; non-zero                   |
| `period`            | `string`   | Yes       | `"daily"`                    | One of: `"daily"`, `"weekly"`, `"once"`                        |
| `targets`           | `string[]` | Yes       | `["0xDef1...", "0xAbC..."]`  | Non-empty; each address EIP-55 checksummed                     |
| `expiry`            | `number`   | Yes       | `1775250000`                 | Unix timestamp (UTC seconds); must be in the future            |

\* Either `uri` or `envelope` must be present. When inline `envelope` is provided, `uri` is omitted.

### Resolution order

Hosts resolve a delegation in this order:

1. **If `envelope` is present (inline)** — use it directly. Envelope was validated at grant time; treat as equivalent to the fetched form.
2. **Else fetch from `uri`** — resolve via IPFS gateway (with fallback), Arweave, or HTTPS, using the same resolution rules as `body.uri`.
3. **Verify `hash` matches** — compute `keccak256(envelope)` and compare to the `hash` field. Abort if mismatch.
4. **Verify signature on-chain** — call `DelegationManager.isDelegationDisabled(hash)` to confirm the delegation has not been revoked, and verify the envelope's EIP-712 signature against the delegator address before trusting.

Verification occurs before any redemption attempt. If any step fails, do not proceed to redeem.

### Backwards compatibility

Manifests without the `permissions` field are valid. Hosts must treat absence as "no on-chain permissions granted". Hosts MUST NOT fall back to asking the user to sign per-transaction if the field is absent, unless the skill itself explicitly requests it. Agents without on-chain identity omit the field entirely.

### Size budget

Keep delegation envelopes inline (under `envelope`) only when the envelope is <8 KB. For larger envelopes, pin to IPFS and reference via `uri` to keep the manifest JSON lean. This budget accounts for envelope bloat from nested caveats or long allow-lists.

## Changelog

### v0.2 (2026-04-18)

- Added `permissions` field (optional) to embed signed ERC-7710 delegations in the manifest, enabling scoped on-chain actions without server contact.
- Bumped schema version from `agent-manifest/0.1` to `agent-manifest/0.2`.
- See [PERMISSIONS_SPEC.md](./PERMISSIONS_SPEC.md) for delegation envelope format, scope vocabulary, and redemption flow.

### v0.1

- Initial release: body, brain, voice, skills, memory, attestations, and scene-tools.

## See also

- [SKILL_SPEC.md](./SKILL_SPEC.md) — skill bundle format
- [MEMORY_SPEC.md](./MEMORY_SPEC.md) — memory file format
- [EMBED_SPEC.md](./EMBED_SPEC.md) — `<agent-3d>` web component attributes and events
