# SDK & Library

This document covers programmatic use of three.ws beyond simple embedding. There are two distributable artifacts you can import into your own project:

| Artifact | Package | Use case |
|---|---|---|
| **Web component bundle** | `agent-3d.js` (CDN or `TARGET=lib` build) | Drop-in `<agent-3d>` element + programmatic viewer/runtime APIs |
| **AgentKit SDK** | `@three-ws/sdk` | Ship an ERC-8004 agent: chat panel, on-chain registration, `.well-known` manifests |

Both are Apache-2.0 licensed. Neither requires the other.

---

## Web component bundle

### Installation

**CDN (recommended for most projects):**

```html
<script type="module" src="https://three.ws/agent-3d/latest/agent-3d.js"></script>
<agent-3d model="./avatar.glb"></agent-3d>
```

**UMD (legacy bundlers or `<script>` without `type="module"`):**

```html
<script src="https://three.ws/agent-3d/latest/agent-3d.umd.cjs"></script>
```

**npm (if you want to import programmatic APIs and bundle yourself):**

```bash
# The main repo — build TARGET=lib yourself, or import src/lib.js directly
git clone https://github.com/nirholas/three.ws
npm install
npm run build:lib   # → dist-lib/agent-3d.js + dist-lib/agent-3d.umd.cjs
```

The CDN build is the `TARGET=lib` Vite build. It bundles three.js, GLTFLoader, and all runtime dependencies into a single ~600–900 KB gzipped file. No other imports are needed.

### Programmatic API (lib.js)

The library entry (`src/lib.js`) exports these classes and utilities for advanced use:

```js
import {
  Agent3DElement,
  AgentStageElement,
  Viewer,
  Runtime,
  SceneController,
  SkillRegistry,
  Skill,
  Memory,
  loadManifest,
  normalize,
  fetchRelative,
  resolveURI,
  fetchWithFallback,
  defineElement,
} from './src/lib.js';
```

**Custom element tag name:**

```js
import { defineElement } from './src/lib.js';

// Ship under your own brand
defineElement('my-avatar');
// <my-avatar model="./agent.glb"></my-avatar>
```

The element self-registers as `<agent-3d>` on import. `defineElement()` lets you override the tag before registration happens.

### Viewer

Direct three.js viewer — loads GLB/glTF, manages camera, lighting, and animation. Used internally by `<agent-3d>` but available standalone:

```js
import { Viewer } from './src/lib.js';

const viewer = new Viewer(document.getElementById('canvas-container'));
viewer.load('./avatar.glb');
```

Full attribute and event API is documented in [Web Component reference](web-component.md).

### loadManifest and normalize

Load an agent manifest from any supported URI scheme:

```js
import { loadManifest, normalize } from './src/lib.js';

// Load from https, ipfs://, ar://, or agent://{chain}/{id}
const manifest = await loadManifest('ipfs://QmXyz...');

// Load from on-chain ERC-8004 registry
const manifest = await loadManifest('agent://base/42');

// Normalize a raw JSON object into the manifest shape the runtime expects
const normalized = normalize(rawJson, { baseURI: 'https://example.com/agents/aria/' });
```

`normalize` handles both the `agent-manifest/0.1` spec format and bare ERC-8004 registration JSON — it adapts either into the uniform object the runtime consumes.

**Load a relative file referenced by the manifest** (instructions, skill bundles, etc.):

```js
import { fetchRelative } from './src/lib.js';

const instructions = await fetchRelative(manifest, 'instructions.md');
```

### IPFS/Arweave resolution

```js
import { resolveURI, fetchWithFallback } from './src/lib.js';

// Resolve ipfs:// or ar:// to an HTTPS gateway URL
const url = resolveURI('ipfs://QmXyz...');
// → "https://dweb.link/ipfs/QmXyz..."

const url = resolveURI('ar://txId123');
// → "https://arweave.net/txId123"

// Fetch with automatic gateway fallback (dweb.link → cloudflare-ipfs → ipfs.io)
const res = await fetchWithFallback('ipfs://QmXyz...');
const json = await res.json();
```

`fetchWithFallback` cycles through the three public IPFS gateways and returns the first successful response, making it resilient to individual gateway outages.

---

## @three-ws/sdk

A separate package for shipping ERC-8004 agents. It does not depend on the viewer — it's backend-friendly and works in any JS environment (Node, browser, edge functions).

### Installation

```bash
npm install @three-ws/sdk
```

`ethers@^6` is a peer dependency — only needed for on-chain operations (`register`, `connectWallet`).

### Quick start

```js
import { AgentKit } from '@three-ws/sdk';
import '@three-ws/sdk/styles';

const agent = new AgentKit({
  name: 'Aria',
  description: 'Product guide',
  endpoint: 'https://yourapp.com',
  onMessage: async (text) => `You asked: ${text}`,
});

agent.mount(document.body);
```

This renders a floating chat panel in the bottom-left corner with voice I/O enabled by default.

### AgentKit options

| Option | Type | Required | Description |
|---|---|---|---|
| `name` | `string` | Yes | Agent display name |
| `endpoint` | `string` | Yes | Your agent's public HTTPS URL |
| `description` | `string` | | What the agent does |
| `image` | `string` | | Public URL to logo or avatar |
| `version` | `string` | | Semver version (default: `1.0.0`) |
| `org` | `string` | | Organization name for `agent-card.json` |
| `skills` | `Array` | | A2A skill definitions |
| `services` | `Array` | | Extra service entries (A2A, MCP endpoints) |
| `onMessage` | `async (text) => string` | | Your message handler |
| `welcome` | `string` | | Panel welcome message |
| `voice` | `boolean` | | Enable TTS on replies (default: `true`) |

### AgentKit methods

```js
agent.mount(element?)     // attach panel to DOM (default: document.body)
agent.open()              // show the chat panel
agent.close()             // hide the chat panel
agent.addMessage(role, text)  // role: 'ak-agent' or 'ak-user'
agent.dispose()           // remove panel from DOM
```

### On-chain registration

Register your agent on the ERC-8004 Identity Registry. Requires MetaMask (or any injected EIP-1193 wallet) and an IPFS API token:

```js
const result = await agent.register({
  imageFile: avatarFile,          // optional — auto-pins to IPFS
  ipfsToken: 'your-w3s-token',    // web3.storage API token
  onStatus: (msg) => console.log(msg),
});

// result: { agentId: 42, registrationCID: 'Qm...', txHash: '0x...' }
```

Registration flow:
1. Connects wallet via `window.ethereum`
2. Pins image to IPFS (if provided)
3. Calls `register()` on the Identity Registry contract
4. Builds and pins the full ERC-8004 registration JSON
5. Calls `setAgentURI()` with the final IPFS CID

### .well-known manifest generation

Generate the three discovery documents to serve from your server:

```js
const { agentRegistration, agentCard, aiPlugin } = agent.manifests({
  openapiUrl: 'https://yourapp.com/.well-known/openapi.yaml',
});
```

Serve them at:
- `/.well-known/agent-registration.json` — ERC-8004 discovery
- `/.well-known/agent-card.json` — A2A protocol
- `/.well-known/ai-plugin.json` — OpenAI plugin manifest

### Low-level exports

For direct control without the `AgentKit` wrapper:

```js
import {
  AgentPanel,
  agentRegistration,
  agentCard,
  aiPlugin,
  connectWallet,
  registerAgent,
  pinToIPFS,
  buildRegistrationJSON,
  getIdentityRegistry,
  IDENTITY_REGISTRY_ABI,
  REGISTRY_DEPLOYMENTS,
  agentRegistryId,
} from '@three-ws/sdk';
```

**Connect a wallet:**

```js
const { signer, address, chainId } = await connectWallet();
```

**Pin a file to IPFS:**

```js
const cid = await pinToIPFS(fileBlob, 'your-w3s-api-token');
// Returns a bare CID string: "QmXyz..."
```

**Full registration flow (without AgentKit wrapper):**

```js
const { agentId, registrationCID, txHash } = await registerAgent({
  name: 'Aria',
  description: 'Product guide',
  endpoint: 'https://yourapp.com',
  imageFile: avatarFile,
  services: [{ name: 'MCP', endpoint: 'https://yourapp.com/mcp', version: '2025-06-18' }],
  apiToken: process.env.W3S_TOKEN,
  onStatus: console.log,
});
```

### Permissions (ERC-7710)

Grant, verify, and revoke scoped spending delegations:

```js
import { PermissionsClient } from '@three-ws/sdk/permissions';

const client = new PermissionsClient({ baseUrl: 'https://three.ws/' });

// List active delegations for an agent
const { spec, delegations } = await client.getMetadata(agentId);

// Grant a delegation (browser only — needs MetaMask)
const { id, delegationHash } = await client.grant({
  agentId,
  chainId: 84532,
  preset: {
    token: 'native',
    maxAmount: '1000000',
    period: 'daily',
    targets: ['0xTargetAddress'],
    expiryDays: 30,
  },
  delegate: agentSmartAccountAddress,
  signer,  // ethers v6 Signer from connectWallet()
});

// Verify on-chain
const { valid, reason } = await client.verify(delegationHash, 84532);

// Revoke
await client.revoke({ id, delegationHash, signer });
```

For tree-shaking and direct toolkit access:

```js
import {
  encodeScopedDelegation,
  isDelegationValid,
} from '@three-ws/sdk/permissions/advanced';
```

### TypeScript support

The SDK ships full TypeScript declarations at `src/index.d.ts` and `src/permissions.d.ts`:

```ts
import type {
  AgentKitOptions,
  RegisterOptions,
  RegistrationResult,
  ManifestsResult,
  ServiceEntry,
  SkillDefinition,
  AgentRegistrationDocument,
  AgentCardDocument,
  AiPluginDocument,
  PermissionsClient,
  DelegationScope,
  ScopePreset,
} from '@three-ws/sdk';

const options: AgentKitOptions = {
  name: 'Aria',
  endpoint: 'https://yourapp.com',
  description: 'Product guide',
};

const result: RegistrationResult = await agent.register();
// { agentId: number, registrationCID: string, txHash: string }
```

---

## Building from source

```bash
git clone https://github.com/nirholas/three.ws
npm install

# Build the web component library (agent-3d.js + agent-3d.umd.cjs)
npm run build:lib
# Output: dist-lib/

# Build the full platform app
npm run build
# Output: dist/

# Build the artifact bundle
npm run build:artifact

# Build everything and publish the library to dist/agent-3d/<version>/
npm run build:all
```

The `build:lib` step runs Vite with `TARGET=lib`. The output is a self-contained bundle — no import map or module resolution needed by the consumer.

### Publishing the versioned CDN bundle

```bash
node scripts/publish-lib.mjs
```

This copies `dist-lib/agent-3d.js` and `dist-lib/agent-3d.umd.cjs` into `dist/agent-3d/<version>/` and creates channel aliases (`<major>`, `<major>.<minor>`, `latest`). It also emits SRI hashes and a `versions.json` manifest so embedders can pin with `integrity` attributes.

Requires `npm run build:lib` to have completed first. Runs automatically as part of `npm run build:all`.

### Versioning

The platform follows semantic versioning. The web component version tracks `package.json` (currently `1.5.1`). The AgentKit SDK is independently versioned in `sdk/package.json` (currently `0.1.0`). Breaking changes only ship in major releases. See `sdk/CHANGELOG.md` for the AgentKit release history.

---

## LobeChat plugin

A pre-built integration that embeds a live 3D avatar in the LobeChat sidebar. The avatar reacts to the LLM's tool calls — speaking, gesturing, and emoting in real time.

### One-click install

1. In LobeChat, open **Plugins → Plugin Store → Custom plugins**.
2. Paste the manifest URL: `https://three.ws/.well-known/chat-plugin.json`
3. Click **Install** and enter your Agent ID from the dashboard.

The plugin exposes four LLM-callable tools:

| Tool | Payload | Effect |
|---|---|---|
| `render_agent` | `{ agentId }` | Swap the avatar in the sidebar |
| `speak` | `{ text, sentiment? }` | Avatar speaks with emotional valence (−1 to 1) |
| `gesture` | `{ name }` | Trigger `wave`, `nod`, `point`, or `shrug` |
| `emote` | `{ trigger, weight? }` | Inject emotion into the Empathy Layer |

Source is in `/chat-plugin/`. Build and dev docs are in `/chat-plugin/README.md`. React and react-dom are external (provided by LobeChat at runtime) — the output is a single `dist/bundle.js`.

```bash
# Dev harness (no LobeChat needed)
npm run build:lib
npm --prefix chat-plugin install
npm --prefix chat-plugin run build
python3 -m http.server 8080
# Open http://localhost:8080/chat-plugin/dev/?agent=<your-agent-id>
```
