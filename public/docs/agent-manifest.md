# Agent Manifest Reference

An **agent manifest** (`manifest.json`) is the complete definition of an embodied AI agent — its 3D body, LLM brain, voice, personality, skills, memory, and on-chain identity, all in one JSON file.

Manifests are content-addressed: pin the bundle to IPFS, get a CID, optionally stamp it on-chain via ERC-8004. Any `<agent-3d>` element anywhere can mount the agent from a URI.

---

## Bundle layout

The manifest is the index of a bundle. Everything except `manifest.json` and a `body` reference is optional.

```
agent/
├── manifest.json           # this file — the index
├── instructions.md         # persona / system prompt (Markdown + frontmatter)
├── SKILL.md                # top-level capability declaration
├── body.glb                # 3D embodiment (or inline via body.uri)
├── poster.webp             # loading-state image
├── skills/
│   ├── wave/
│   └── football-drills/
├── memory/
│   ├── MEMORY.md           # memory index (always injected into context)
│   └── user_role.md
└── attestations/
    └── gltf-validator.json
```

---

## Loading a manifest

The `<agent-3d>` element accepts several source forms. Priority when multiple attributes are set: `src` > `agent-id` > `manifest` > `body`.

```html
<!-- On-chain: agent://chain/agentId -->
<agent-3d src="agent://base/42"></agent-3d>

<!-- IPFS CID -->
<agent-3d manifest="ipfs://bafy.../manifest.json"></agent-3d>

<!-- HTTPS URL -->
<agent-3d manifest="https://cdn.acme.com/aria/manifest.json"></agent-3d>

<!-- Backend agent ID (platform-hosted) -->
<agent-3d agent-id="aria-guide"></agent-3d>

<!-- Bare GLB — no manifest, viewer mode only -->
<agent-3d body="./product.glb"></agent-3d>
```

Programmatically (SDK):

```js
import { loadManifest } from '@3d-agent/sdk';

// From on-chain URI
const manifest = await loadManifest('agent://base/42');

// From IPFS
const manifest = await loadManifest('ipfs://bafy.../manifest.json');

// From HTTPS
const manifest = await loadManifest('https://cdn.acme.com/aria/manifest.json');
```

`loadManifest` returns a normalized manifest object with a `_baseURI` property set to the directory containing `manifest.json`, used for resolving all relative paths.

---

## Full manifest schema

```json
{
  "$schema": "https://3d-agent.io/schemas/manifest/0.2.json",
  "spec": "agent-manifest/0.2",

  "id": {
    "chain": "base",
    "registry": "0xAbC...123",
    "agentId": "42",
    "owner": "0xDeadBeef..."
  },

  "name": "Aria",
  "description": "A helpful product guide for Acme Corp",
  "image": "https://cdn.acme.com/aria-thumb.webp",
  "tags": ["support", "product", "acme"],

  "body": {
    "uri": "ipfs://bafy.../aria.glb",
    "format": "gltf-binary",
    "rig": "mixamo",
    "boundingBoxHeight": 1.75
  },

  "brain": {
    "provider": "anthropic",
    "model": "claude-opus-4-7",
    "instructions": "instructions.md",
    "temperature": 0.7,
    "maxTokens": 4096,
    "thinking": "auto"
  },

  "voice": {
    "tts": {
      "provider": "browser",
      "voiceId": "default",
      "rate": 1.0,
      "pitch": 1.0
    },
    "stt": {
      "provider": "browser",
      "language": "en-US",
      "continuous": false
    }
  },

  "skills": [
    { "uri": "skills/wave/", "version": "0.1.0" },
    { "uri": "ipfs://bafy.../football-drills/", "version": "1.0.0" },
    { "uri": "https://skills.3d-agent.io/explain-gltf@0.3.0" }
  ],

  "memory": {
    "mode": "ipfs",
    "index": "memory/MEMORY.md",
    "maxTokens": 8192
  },

  "tools": ["wave", "lookAt", "play_clip", "setExpression", "speak", "remember"],

  "attestations": [
    {
      "type": "gltf-validator",
      "uri": "attestations/gltf-validator.json",
      "issuer": "0x...",
      "signature": "0x..."
    }
  ],

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
          "targets": ["0xDef1..."],
          "expiry": 1775250000
        }
      }
    ]
  },

  "version": "0.1.0",
  "created": "2026-04-14T12:00:00Z",
  "updated": "2026-04-14T12:00:00Z"
}
```

---

## Field reference

### `$schema` (string, optional)

URL of the JSON Schema to validate against. Current value:
`https://3d-agent.io/schemas/manifest/0.2.json`

Validated on load; unknown fields are passed through unchanged (forward-compatible).

---

### `spec` (string, required)

Manifest format version. Must start with `agent-manifest/`. Current value: `"agent-manifest/0.2"`.

The runtime accepts any `agent-manifest/*` version string. Breaking changes bump the minor version until 1.0. Unknown fields are always preserved on read and write.

---

### `id` (object, optional)

Links the agent to its on-chain identity. When absent, the agent is local-only and cannot be loaded via `agent://`.

| Field      | Type   | Required | Description |
|------------|--------|----------|-------------|
| `chain`    | string | Yes      | Chain name or ID. Supported aliases: `"base"` (8453), `"base-sepolia"` (84532), `"ethereum"` / `"mainnet"` (1). Numeric chain IDs also accepted. |
| `registry` | string | Yes      | EIP-55 checksummed address of the deployed ERC-8004 IdentityRegistry contract. |
| `agentId`  | string | Yes      | Token ID assigned by the registry at registration. Always stored as a string even though it's numeric on-chain. |
| `owner`    | string | No       | EIP-55 checksummed wallet address that controls the agent. Used for ownership verification. |

When an agent is loaded via `agent://base/42`, the runtime calls `registry.tokenURI(42)` to get the IPFS URI, fetches the manifest, then stamps `id.chain`, `id.chainId`, `id.registry`, and `id.agentId` onto the normalized manifest object.

---

### `name` (string, required)

Display name of the agent. Shown in UI headers, identity cards, and gallery listings.

---

### `description` (string, optional)

Short description. Used in discovery listings and OG metadata. Keep it to one or two sentences.

---

### `image` (string, optional)

URL of a 2D thumbnail image (PNG, JPG, WebP). Used in marketplace / NFT preview contexts. When `body.uri` is missing, the runtime falls back to this field as the body URI.

---

### `tags` (array of strings, optional)

Free-form tags for discovery. Example: `["coach", "sports", "en-US"]`.

---

### `body` (object, required)

The 3D embodiment of the agent. Only `uri` and `format` are required.

| Field               | Type   | Required | Default        | Description |
|---------------------|--------|----------|----------------|-------------|
| `uri`               | string | Yes      | —              | URL to the GLB/glTF/VRM file. Supports `https://`, `ipfs://`, `ar://`, and relative paths resolved against `_baseURI`. |
| `format`            | string | Yes      | —              | `"gltf-binary"` (GLB), `"gltf"` (JSON glTF), or `"vrm"`. |
| `rig`               | string | No       | none           | Animation rig convention: `"mixamo"`, `"vrm"`, or `"custom"`. Skills use this to retarget animation clips. Mixamo-to-Mixamo skill bundles are portable across agents with `"rig": "mixamo"`. |
| `boundingBoxHeight` | number | No       | none           | Agent height in meters. The scene uses this to normalize scale across models of wildly different sizes. |
| `validator`         | string | No       | none           | Relative path to a signed glTF validator attestation (e.g. `"attestations/gltf-validator.json"`). |

**Relative URI resolution:** When `body.uri` is a relative path like `./aria.glb`, it is resolved against the manifest's own location. For a manifest at `https://cdn.acme.com/aria/manifest.json`, the body resolves to `https://cdn.acme.com/aria/aria.glb`. The same rule applies to IPFS: for a manifest at `ipfs://bafy.../manifest.json`, relative URIs resolve against the IPFS gateway base.

---

### `brain` (object, optional)

LLM runtime configuration. When omitted, the agent is reactive-only (skills and animations, no conversation).

| Field          | Type   | Required | Default | Description |
|----------------|--------|----------|---------|-------------|
| `provider`     | string | Yes      | `"none"` | `"anthropic"`, `"openai"`, `"local"`, or `"none"`. Use `"none"` for a purely reactive avatar. |
| `model`        | string | No       | —       | Model ID, e.g. `"claude-opus-4-7"`. |
| `instructions` | string | No       | —       | Relative path to a Markdown file (`instructions.md`) that contains the system prompt. Frontmatter in the file can override any `brain.*` field. |
| `temperature`  | number | No       | 0.7     | LLM sampling temperature (0–1). |
| `maxTokens`    | number | No       | 4096    | Max tokens per response. |
| `thinking`     | string | No       | `"auto"` | Extended thinking mode: `"auto"`, `"always"`, or `"never"`. |

**`instructions.md` frontmatter:** Fields declared in frontmatter override `brain.*` at runtime:

```markdown
---
name: Coach Leo
model: claude-opus-4-7
temperature: 0.8
---

You are Coach Leo, a former Argentine football midfielder turned coach...
```

---

### `voice` (object, optional)

Text-to-speech and speech-to-text configuration.

**`voice.tts`** — text to speech:

| Field      | Type   | Required | Default     | Description |
|------------|--------|----------|-------------|-------------|
| `provider` | string | Yes      | `"browser"` | `"browser"` (Web Speech API), `"elevenlabs"`, `"openai"`, or `"none"`. |
| `voiceId`  | string | No       | `"default"` | Provider-specific voice identifier. |
| `rate`     | number | No       | 1.0         | Speech rate multiplier (0.5–2.0). |
| `pitch`    | number | No       | 1.0         | Voice pitch multiplier (0.5–2.0). |

**`voice.stt`** — speech to text:

| Field        | Type    | Required | Default     | Description |
|--------------|---------|----------|-------------|-------------|
| `provider`   | string  | Yes      | `"browser"` | `"browser"` (Web Speech API), `"whisper"`, or `"none"`. |
| `language`   | string  | No       | `"en-US"`   | BCP 47 language tag. |
| `continuous` | boolean | No       | `false`     | Whether to keep the microphone open between utterances. |

Note: `SpeechRecognition` silently no-ops in environments where it is unavailable (e.g. Firefox without a flag, or non-browser runtimes). Check `window.SpeechRecognition || window.webkitSpeechRecognition` if your skill depends on it.

---

### `skills` (array, optional)

Each element installs one skill bundle into the agent. Skills are loaded lazily; the element emits a `skill:loaded` event as each comes online.

Each element must be an object with a `uri` field:

```json
"skills": [
  { "uri": "skills/wave/", "version": "0.1.0" },
  { "uri": "ipfs://bafy.../football-drills/", "version": "1.0.0" },
  { "uri": "https://skills.3d-agent.io/explain-gltf@0.3.0" }
]
```

Three URI forms:

- **Relative** (`skills/wave/`) — bundled in the manifest directory.
- **IPFS** (`ipfs://bafy.../`) — resolved via the IPFS gateway cascade (dweb.link → cloudflare-ipfs.com → ipfs.io).
- **HTTPS** (`https://skills.3d-agent.io/...`) — centrally hosted.

The `version` field is metadata; the runtime uses it for display and conflict detection but does not enforce semver constraints at load time.

**Skill bundle layout** (see [Skill Spec](../specs/SKILL_SPEC.md) for full detail):

```
skill-name/
├── SKILL.md       # instructions for the LLM (required)
├── tools.json     # tool schema (required if skill exposes tools)
├── handlers.js    # tool implementations (optional)
├── manifest.json  # metadata, deps, version (required)
└── clips/         # animation GLBs (optional)
```

Skill tools are merged with built-in scene tools. If names collide, the skill tool wins (with a console warning).

---

### `memory` (object, optional)

Controls how the agent's persistent memory is stored and loaded.

| Field       | Type   | Required | Default    | Description |
|-------------|--------|----------|------------|-------------|
| `mode`      | string | Yes      | `"local"`  | `"local"` (localStorage), `"ipfs"` (pin after each write), `"encrypted-ipfs"` (owner-key encrypted), or `"none"` (stateless). |
| `index`     | string | No       | `"memory/MEMORY.md"` | Relative path to the MEMORY.md index file. Always injected into the LLM context; lines beyond 200 are truncated. |
| `maxTokens` | number | No       | 8192       | Token budget for memory context injection. |

**Mode behaviours:**

- `local` — persists in `localStorage` keyed by `agent:${namespace}:memory`. Fast; ephemeral per browser.
- `ipfs` — fetches memory from the manifest bundle on load (`memory/MEMORY.md` + linked files), pins on write. Durable; slow writes.
- `encrypted-ipfs` — same as `ipfs` but wrapped with the owner wallet's public key. Requires `identity` to be set.
- `none` — no memory. The agent starts fresh every session.

Memory files use Claude-shaped frontmatter Markdown (same format as Claude Code's memory system). See [Memory Spec](../specs/MEMORY_SPEC.md).

---

### `tools` (array of strings, optional)

Declares which built-in scene tools are available to the LLM without installing any skill. Skills add additional tools on top of this list.

Default set when `tools` is omitted: `["wave", "lookAt", "play_clip", "setExpression"]`.

Full set of built-in scene tools:

| Tool            | Description |
|-----------------|-------------|
| `wave`          | Trigger a wave animation. |
| `lookAt`        | Turn the agent's head toward a target (`"model"`, `"user"`, or `"camera"`). |
| `play_clip`     | Play a named animation clip. |
| `setExpression` | Set a morph target expression blend. |
| `speak`         | Emit a speech utterance (TTS + protocol event). |
| `remember`      | Write a memory entry. |
| `moveTo`        | Move the agent to a position in the scene. |
| `pointAt`       | Point at a target in the scene. |

---

### `attestations` (array, optional)

Signed provenance records. Each attestation links to a validator report and an on-chain signature.

| Field       | Type   | Description |
|-------------|--------|-------------|
| `type`      | string | Attestation type, e.g. `"gltf-validator"`. |
| `uri`       | string | Relative or absolute path to the attestation JSON file. |
| `issuer`    | string | EIP-55 checksummed address of the signing entity. |
| `signature` | string | EIP-712 signature over the attestation hash. |

---

### `permissions` (object, optional, v0.2+)

Embeds signed ERC-7710 delegation envelopes, enabling the agent to execute on-chain transactions on behalf of its owner without per-transaction signing. Hosts (Claude Artifacts, LobeHub plugins, embedded iframes) redeem delegations at runtime.

See [Permissions Spec](../specs/PERMISSIONS_SPEC.md) for the full trust model, envelope format, and redemption flow.

```json
"permissions": {
  "spec": "erc-7715/0.1",
  "delegationManager": "0x...",
  "delegations": [
    {
      "chainId": 84532,
      "delegator": "0xOwnerAddress...",
      "delegate": "0xAgentSmartAccount...",
      "hash": "0x...",
      "uri": "ipfs://bafy...",
      "scope": {
        "token": "native",
        "maxAmount": "1000000000000000000",
        "period": "daily",
        "targets": ["0xAllowedContract..."],
        "expiry": 1775250000
      }
    }
  ]
}
```

Key `scope` fields:

| Field       | Type     | Description |
|-------------|----------|-------------|
| `token`     | string   | ERC-20 address (checksummed) or `"native"`. |
| `maxAmount` | string   | Spend cap in base units (non-negative integer as string). |
| `period`    | string   | Reset period: `"daily"`, `"weekly"`, or `"once"`. |
| `targets`   | string[] | Allow-listed contract addresses. Non-empty. |
| `expiry`    | number   | Unix timestamp (seconds) after which the delegation is invalid. |

Either `uri` (IPFS/HTTPS link to the envelope) or `envelope` (inline object) must be present for each delegation. Use inline `envelope` only when it is under 8 KB; for larger envelopes, pin to IPFS.

---

### `version` (string, optional)

Semver version of this specific agent manifest, author-controlled. Not the same as `spec`. Example: `"0.1.0"`.

---

### `created` / `updated` (string, optional)

ISO 8601 timestamps. Informational; not validated by the runtime.

---

## URI resolution

### IPFS

`ipfs://` URIs are resolved to HTTPS gateway URLs. The runtime tries three gateways in order, falling back on network failure:

1. `https://dweb.link/ipfs/<CID>`
2. `https://cloudflare-ipfs.com/ipfs/<CID>`
3. `https://ipfs.io/ipfs/<CID>`

### Arweave

`ar://` URIs resolve to `https://arweave.net/<txId>`. No fallback.

### Relative paths

All relative paths inside a manifest (`body.uri`, `skills[].uri`, `memory.index`, `brain.instructions`, `attestations[].uri`) are resolved against `_baseURI`, which is the directory portion of the manifest's own URL, including a trailing slash.

```json
{ "body": { "uri": "./aria.glb" } }
```

Manifest at `https://cdn.acme.com/aria/manifest.json` → body resolves to `https://cdn.acme.com/aria/aria.glb`.

Same rule applies on IPFS: the gateway URL of the manifest's directory is used as the base.

---

## On-chain resolution flow

```
<agent-3d src="agent://base/42">
         │
         ▼
  CHAIN_ALIASES["base"] → chainId 8453
         │
         ▼
  IdentityRegistry.tokenURI(42)    ← ethers call on Base mainnet
         │
         ▼
  → "ipfs://bafy.../manifest.json"
         │
         ▼
  resolveURI()  →  https://dweb.link/ipfs/bafy.../manifest.json
         │
         ▼
  fetchWithFallback()  (dweb.link → cloudflare-ipfs → ipfs.io)
         │
         ▼
  normalize(json, { baseURI: "https://dweb.link/ipfs/bafy.../" })
         │
         ├── load body.glb  →  Viewer
         ├── load instructions.md  →  LLM runtime
         ├── load skills/*  →  SkillRegistry
         ├── load memory/MEMORY.md  →  Memory
         └── verify attestations/*
         │
         ▼
  Agent live: speech I/O, LLM, scene-tools
```

Supported chain aliases for `agent://` URIs: `base` (8453), `base-mainnet` (8453), `base-sepolia` (84532), `ethereum` / `mainnet` (1). Pass a numeric chain ID directly for other chains.

---

## Hosting your manifest

| Option | Notes |
|--------|-------|
| **HTTPS (CDN)** | Host on any CDN — GitHub Pages, S3, Vercel, Cloudflare R2. CORS header required: `Access-Control-Allow-Origin: *`. |
| **IPFS** | Pin with Pinata, Filebase, or Web3.Storage. Use `ipfs://` URIs for all bundle-relative assets so they travel with the CID. |
| **Arweave** | Permanent storage. Use `ar://` prefix. |
| **Platform editor** | Upload via the three.ws editor; the platform pins to IPFS and hosts the manifest for you. |

Minimum CORS requirement: the manifest JSON itself (and any files fetched at runtime from the same origin) must include `Access-Control-Allow-Origin: *` or the browser will block the fetch.

---

## Worked examples

### Minimal — viewer only, no AI

```json
{
  "spec": "agent-manifest/0.1",
  "name": "Acme Product",
  "body": { "uri": "./product.glb", "format": "gltf-binary" }
}
```

Load it:

```html
<agent-3d manifest="https://cdn.acme.com/product/manifest.json"></agent-3d>
```

---

### Talking agent with local memory

```json
{
  "spec": "agent-manifest/0.1",
  "name": "Leo",
  "description": "Football coach. Reviews your form, cheers you on.",
  "image": "/avatars/cz.glb",
  "tags": ["coach", "football", "argentina"],
  "body": {
    "uri": "/avatars/cz.glb",
    "format": "gltf-binary",
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
  "voice": {
    "tts": { "provider": "browser", "rate": 1.05 },
    "stt": { "provider": "browser", "language": "en-US" }
  },
  "skills": [{ "uri": "skills/wave/", "version": "0.1.0" }],
  "memory": { "mode": "local", "index": "memory/MEMORY.md", "maxTokens": 8192 },
  "tools": ["wave", "lookAt", "play_clip", "setExpression", "speak", "remember"],
  "version": "0.1.0"
}
```

---

### Full on-chain identity with IPFS memory

```json
{
  "spec": "agent-manifest/0.2",
  "id": {
    "chain": "base-sepolia",
    "registry": "0xAbC...123",
    "agentId": "42",
    "owner": "0xDeadBeef..."
  },
  "name": "Sage",
  "description": "A blockchain-native AI agent.",
  "image": "ipfs://bafy.../poster.webp",
  "tags": ["web3", "defi"],
  "body": {
    "uri": "ipfs://bafy.../sage.glb",
    "format": "gltf-binary",
    "rig": "mixamo"
  },
  "brain": {
    "provider": "anthropic",
    "model": "claude-opus-4-7",
    "instructions": "instructions.md"
  },
  "voice": {
    "tts": { "provider": "browser" },
    "stt": { "provider": "browser", "language": "en-US" }
  },
  "skills": [
    { "uri": "skills/wave/", "version": "0.1.0" },
    { "uri": "ipfs://bafy.../defi-tools/", "version": "1.0.0" }
  ],
  "memory": {
    "mode": "encrypted-ipfs",
    "index": "memory/MEMORY.md",
    "maxTokens": 8192
  },
  "tools": ["wave", "lookAt", "play_clip", "setExpression", "speak", "remember"],
  "version": "0.2.0"
}
```

Load from on-chain:

```html
<agent-3d src="agent://base-sepolia/42"></agent-3d>
```

---

## Common errors

| Error | Cause | Fix |
|-------|-------|-----|
| `Manifest fetch failed: ... (404)` | `body.uri` or manifest URL is wrong | Verify the URL and CORS headers. |
| `Unsupported manifest source` | URI scheme not recognized | Use `agent://`, `ipfs://`, `ar://`, or `https://`. |
| `Malformed agent URI` | `agent://` does not match `chain/agentId` | Format must be `agent://base/42` not `agent://base:42`. |
| `No registry deployed on chain X` | Chain has no known IdentityRegistry | Pass `registry=` override or use a supported chain. |
| `Agent X on chain Y has no URI` | Token exists but `tokenURI` returned empty | Agent was registered without a manifest URI — re-register or update the token URI. |
| `All IPFS gateways failed` | CID is not propagated or pinned | Re-pin with your IPFS provider; wait for propagation. |

---

## Versioning

The `spec` field identifies the manifest format version. Current stable: `agent-manifest/0.2`.

- Minor bumps (`0.1` → `0.2`) add new optional fields; existing manifests remain valid.
- Breaking changes will bump the major version (future `1.0`).
- Unknown fields are always preserved on read and write — newer runtimes ignore unknown fields, older runtimes won't corrupt newer manifests.

## See also

- [Skill Spec](../specs/SKILL_SPEC.md) — skill bundle format and tool schema
- [Memory Spec](../specs/MEMORY_SPEC.md) — memory file format and MEMORY.md index
- [Embed Spec](../specs/EMBED_SPEC.md) — `<agent-3d>` element attributes and events
- [Permissions Spec](../specs/PERMISSIONS_SPEC.md) — ERC-7710 delegation format and redemption
