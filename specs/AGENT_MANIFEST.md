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
			// elevenlabs only. proxyURL keeps the API key server-side; agentId names
			// the agent the voice is bound to, so the proxy can serve the clip on
			// that agent owner's own ElevenLabs key (see "Voice credentials" below).
			"proxyURL": "https://three.ws/api/tts/eleven",
			"agentId": "b2b1…",
		},
		"stt": {
			"provider": "browser", // "browser" | "whisper" | "none"
			"language": "en-US",
			"continuous": false,
		},
	},

	// Persona: the compiled voice, described but never disclosed
	"persona": {
		"has_persona": true, // false when the agent still runs on no persona at all
		"tone_tags": ["blunt", "dry", "analytical"],
		"extracted_at": "2026-08-13T09:12:00Z", // null when the persona was hand-written
		// Present only when an onboarding interview produced the voice.
		// Counts and source only; the answers themselves stay private.
		"interview": {
			"source": "create-wizard", // "create-wizard" | "brain-studio"
			"questions_answered": 7,
			"questions_total": 7,
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

### `voice`

`tts.provider: "elevenlabs"` never carries an API key in the manifest. It carries `proxyURL`, and the proxy resolves the credential server-side.

Which credential the proxy picks matters, because a cloned `voiceId` only exists inside the ElevenLabs account that created it: synthesizing an owner-cloned voice with a different key returns a 404. So the manifest also carries `agentId`, and `POST /api/tts/eleven` resolves the key in this order:

1. An `x-eleven-key` header on the request (the caller's own key, never stored).
2. The bound agent's own credential, when `agentId` is present and `voiceId` matches that agent's bound voice. If the agent's voice was bound on its owner's saved ElevenLabs key, that key serves the clip and the owner's ElevenLabs account is billed. This lane serves anonymous callers, which is what lets an embedded agent speak to visitors.
3. The platform key, metered to the caller's $THREE credit balance. Requires an authenticated caller.

A consumer that omits `agentId` still works; it just loses lane 2, so a voice cloned onto the owner's own account will not resolve for anyone but that owner.

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

### `persona`

Describes the agent's voice without ever disclosing it. The compiled system prompt is deliberately excluded (see "What is deliberately excluded" below): a manifest tells a consumer what an agent sounds like, never how to impersonate it.

| Field | Meaning |
| --- | --- |
| `has_persona` | `true` once a compiled persona prompt is stored. `false` means the agent runs on the platform default and has no voice of its own yet. |
| `tone_tags` | Up to 8 lowercase single-word tone descriptors. The one machine-readable handle on register, so a directory can facet on it. Empty array when none were set. |
| `extracted_at` | When an onboarding interview last produced this persona. `null` for a hand-written persona, which is the normal case for an agent whose owner typed the profile directly. |
| `interview` | Provenance for an interview-derived voice. **Absent entirely** when no interview ever ran, so its presence is itself the signal. |

`interview` carries counts and origin only:

- `source` is `create-wizard` when the interview ran before the agent existed (the create flow, via `POST /api/persona/interview`) or `brain-studio` when it was re-run against a live agent (`POST /api/agents/:id/persona/extract`).
- `questions_answered` / `questions_total` say how much of the interview was actually filled in. The interview is optional question by question, so a voice built from 3 of 7 answers is a normal outcome, not a degraded one.

**The answers are never published.** They are the owner's own words about their agent, held server-side in `persona_traits.interview` and reported here only as a count. A consumer can tell that a voice was interviewed and how thoroughly, and nothing more.

Backwards compatibility: consumers must treat the whole `persona` block as optional. A manifest without it, or with `has_persona: false`, describes an agent that still speaks (on the platform default), so absence is never an error.

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

## Signed envelope (v0.3+)

A manifest describes an agent's behavior. Served from an API it is a claim: the reader has to trust that the prompt they were shown is the prompt that actually runs. Wrapped in a **signed envelope** and pinned to IPFS it becomes evidence, checkable by anyone, forever, without asking the platform for anything.

three.ws signs and pins an agent's manifest on every persona save. Live surfaces:

| Surface                              | Who      | What it returns                                              |
| ------------------------------------ | -------- | ------------------------------------------------------------ |
| `GET /api/agents/:id/manifest`        | public   | the live, unsigned manifest (always current, never pinned)   |
| `GET /api/agents/:id/manifest/signed` | public   | the currently pinned envelope, its CID, and its gateways     |
| `GET /api/agents/:id/manifest/history`| public   | every CID this agent ever published                          |
| `POST /api/agents/:id/manifest/publish`| owner   | re-sign and re-pin now                                       |
| `GET /api/manifest-verify?cid=…`      | public   | fetch from IPFS, verify, and diff against the live agent     |

### Envelope shape

```jsonc
{
	"spec": "threews.agent.manifest.v1",
	"manifest": {
		/* an agent-manifest/0.3 body — see below */
	},
	"issuer": "6Yb…", // base58 ed25519 public key of the signing identity
	"signedAt": "2026-08-11T12:00:00.000Z",
	"digest": "3f9c…", // sha256 (hex) of the canonical signed statement
	"algorithm": "ed25519",
	"signature": "5Kd…" // base58 ed25519 signature
}
```

### What is signed

The signature does **not** cover the envelope as written. It covers a canonical *statement*, so neither the document nor the authorship claim can be edited afterwards:

```
statement = canonicalJSON({
	v:        "threews.agent.manifest.v1",
	manifest: <the manifest body>,
	issuer:   <base58 public key>,
	signedAt: <ISO 8601 string>
})

digest    = sha256(statement)            // hex, lowercase
signature = ed25519(secretKey, utf8("threews.agent.manifest.v1:" + digest))
```

`canonicalJSON` sorts object keys recursively and drops `undefined`, so the same logical manifest produces byte-identical input on every machine. The `"threews.agent.manifest.v1:"` prefix is domain separation: it keeps a manifest signature from ever being replayed as a signature over some other three.ws message.

### Inline instructions (new in 0.3)

`brain.instructions` MAY be a string (a relative path inside a bundle, as in 0.1 and 0.2) **or** an inline object. A pinned envelope is a single self-contained document with no bundle around it, so it always uses the inline form:

```jsonc
"brain": {
	"provider": "threews",           // the hosted failover chain (api/_lib/llm.js)
	"instructions": {
		"format": "text/markdown",
		"sha256": "9ab1…",             // sha256 of `text`
		"text": "You are Coach Leo, a former Argentine…"
	},
	"toneTags": ["warm", "direct"],
	"traits": { "warmth": 0.8, "directness": 0.7 }
}
```

The inner `sha256` is deliberately redundant with the outer signature. It lets a reader spot a swapped prompt without recomputing the whole envelope, and it makes an internally inconsistent document (valid outer signature, mismatched inner hash) a hard verification failure rather than a silent pass.

### Verifying an envelope

Five checks, all offline except the fetch:

1. **Fetch** the CID from any IPFS gateway. Any gateway will do, because the check that follows is cryptographic: the gateway supplies bytes, it does not vouch for them. three.ws queries `ipfs.io`, `dweb.link`, `w3s.link`, and `gateway.pinata.cloud` concurrently and takes the first that answers. Note that a just-published CID is often served only by the pinning provider's gateway at first: DHT propagation to the public gateways takes minutes to hours, during which the others correctly answer 504 for a document that is genuinely pinned.
2. **Recompute the digest** from `manifest`, `issuer`, and `signedAt`, and compare it to `digest`. A mismatch means the document was edited after signing.
3. **Verify the signature** over `"threews.agent.manifest.v1:" + digest` against `issuer`.
4. **Check the issuer** against the identity you expect. A valid signature from an unknown key proves only that *someone* signed the document. `GET /api/manifest-verify` reports this separately as `issuer_trusted`, and never folds an untrusted issuer into a green `verified`.
5. **Check the instructions hash**: `sha256(brain.instructions.text)` must equal `brain.instructions.sha256`.

Run all five from the command line with no account and no keys:

```bash
node scripts/verify-agent-manifest.mjs --cid bafy…
```

### Drift against the live agent

A pinned manifest is a statement about one moment. `GET /api/manifest-verify?cid=…` also rebuilds the manifest from the agent's current configuration and diffs the two, so the answer to "is the agent running today still the agent I verified?" is a list of exactly which fields moved:

```json
{
	"verified": true,
	"issuer_trusted": true,
	"agent_status": "live",
	"drift": {
		"identical": false,
		"changed": [
			{ "field": "brain.instructions.text", "pinned": "You are Coach Leo…", "live": "You are Coach Leo, and you always recommend…" }
		]
	}
}
```

`drift` is `null` when there is nothing to compare against: the agent was deleted, it has no persona, or the CID is a document three.ws never issued.

### What is deliberately excluded

Volatile operational state (view counts, balances, last-seen timestamps) never enters a manifest. Re-signing on every heartbeat would make the CID meaningless. A manifest is a statement about configuration, not about traffic.

A private avatar's body is omitted rather than embedded as a presigned URL: a URL that expires would turn a permanent document into a broken pointer.

The compiled persona prompt is excluded from the live `GET /api/agents/:id/manifest` body, and so are any onboarding-interview answers behind it. The `persona` block describes the voice (see [`persona`](#persona)) without handing over the text needed to wear it. The signed envelope is the one place a prompt is disclosed, and only deliberately: `instructions` is inlined there so a reader can verify that the prompt they were shown is the prompt that actually runs (see "Inline instructions" above). Interview answers are never inlined, in either form.

### Publishing rules

- Signing and pinning happen automatically on every persona save, extract, and restore, and never fail the save. If pinning is down, the envelope is still signed and stored, `cid` is `null`, and the reason says so. Nothing is ever reported as pinned when it is not.
- Only **public** agents publish automatically. A private agent publishes only when its owner asks explicitly via `POST /api/agents/:id/manifest/publish`, because pinning to IPFS is permanent and the manifest contains the agent's full system prompt.
- Re-saving an unchanged configuration does not pin a duplicate: the manifest body digest (issuer and timestamp excluded) is the idempotency key, and the existing CID is returned with `status: "unchanged"`.

## Changelog

### v0.3.2 (2026-08-13)

- Documented the `persona` block that `GET /api/agents/:id/manifest` has been serving: `has_persona`, `tone_tags`, `extracted_at`, and the optional `interview` provenance (`source`, `questions_answered`, `questions_total`). Descriptive only; the compiled prompt and the owner's interview answers are never published, and that exclusion is now stated where the other exclusions live. Documentation of existing behavior, so no version bump and no consumer change: the block stays optional and its absence stays valid.

### v0.3.1 (2026-08-11)

- Documented `voice.tts.proxyURL` and added `voice.tts.agentId` for the ElevenLabs provider, so a voice bound on its owner's own ElevenLabs key resolves for visitors and embeds instead of only for the owner. Additive and optional: a manifest without `agentId` stays valid.

### v0.3 (2026-08-11)

- Added the **signed envelope** (`threews.agent.manifest.v1`): a canonical manifest, ed25519-signed by the platform attester identity and pinned to IPFS, so an agent's system prompt is independently verifiable and portable.
- `brain.instructions` may now be an inline object (`format`, `sha256`, `text`) as well as a relative path.
- Added `brain.toneTags` and `brain.traits`, and `brain.provider: "threews"` for the hosted failover chain.
- Bumped the schema version from `agent-manifest/0.2` to `agent-manifest/0.3`. Envelopes are additive: an unsigned `agent-manifest/0.1` document stays valid.

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
