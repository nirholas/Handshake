<p align="center">
  <a href="https://three.ws"><img src="https://three.ws/three-ws-mcp-icon.svg" width="72" height="72" alt="three.ws" /></a>
</p>

<h1 align="center">@three-ws/sdk</h1>

<p align="center"><strong>Ship a cross-chain 3D AI agent: ERC-8004 + Solana identity, a chat panel, an embeddable avatar, and <code>.well-known</code> manifests.</strong></p>

<p align="center">
  <a href="https://www.npmjs.com/package/@three-ws/sdk"><img alt="npm" src="https://img.shields.io/npm/v/@three-ws/sdk?logo=npm&color=cb3837"></a>
  <a href="https://www.npmjs.com/package/@three-ws/sdk"><img alt="downloads" src="https://img.shields.io/npm/dm/@three-ws/sdk?color=cb3837"></a>
  <img alt="license" src="https://img.shields.io/npm/l/@three-ws/sdk?color=3b82f6">
  <img alt="node" src="https://img.shields.io/node/v/@three-ws/sdk?color=339933&logo=node.js">
</p>

<p align="center">
  <a href="#install">Install</a> ·
  <a href="#quick-start">Quick start</a> ·
  <a href="#embed-a-3d-avatar">Avatar</a> ·
  <a href="#register-on-chain">Register</a> ·
  <a href="#api">API</a> ·
  <a href="#permissions">Permissions</a> ·
  <a href="https://three.ws">three.ws</a>
</p>

---

> A browser SDK for shipping a 3D AI agent that's discoverable on-chain. Mount a
> floating chat panel with voice I/O, embed any three.ws agent's 3D avatar, register
> the agent via ERC-8004 (EVM) or Metaplex (Solana), generate the standard
> `.well-known` manifests, and run x402 paid agent-to-agent calls — all from one
> package. Vanilla JS, no framework required.

## Install

```bash
npm install @three-ws/sdk ethers
```

`ethers@^6` and `@solana/web3.js@^1` are optional peer dependencies — install
`ethers` only if you call `register()` (EVM), `@solana/web3.js` only for the
Solana helpers.

## Quick start

```js
import { AgentKit } from '@three-ws/sdk';
import '@three-ws/sdk/styles';

const agent = new AgentKit({
	name: 'My Agent',
	description: 'Does cool stuff',
	endpoint: 'https://myapp.com',
	onMessage: async (text) => `You said: ${text}`,
});

agent.mount(document.body);
```

That's it — you now have a floating chat panel with voice I/O in the bottom-left corner.

## Embed a 3D avatar

Drop the avatar of any three.ws agent onto your page in two lines. Works in any
framework or plain HTML — the helper lazy-loads the published
[`<agent-3d>`](https://three.ws/agent-3d/latest/agent-3d.js) custom element
from the three.ws CDN.

```js
import { loadAvatar } from '@three-ws/sdk';

const handle = await loadAvatar({
	agentId: 'agt_abc123',
	container: document.getElementById('hero'),
	controls: 'orbit',
});

handle.playAnimation('wave');
// handle.dispose() when you're done
```

| Option      | Type                    | Description                                                     |
| ----------- | ----------------------- | --------------------------------------------------------------- |
| `agentId`   | `string` **(req)**      | three.ws agent id                                               |
| `container` | `HTMLElement` **(req)** | Mount target                                                    |
| `controls`  | `'orbit' \| 'none'`     | Camera controls (default: `'orbit'`)                            |
| `cdnUrl`    | `string`                | Override the agent-3d script URL                                |
| `integrity` | `string`                | Optional SRI hash for the script tag                            |
| `width`     | `string`                | CSS width (default: `'100%'`)                                   |
| `height`    | `string`                | CSS height (default: `'100%'`)                                  |
| `attrs`     | `Record<string,string>` | Extra attributes forwarded to `<agent-3d>` (e.g. `bg`, `theme`) |

Prefer plain HTML? Drop the script tag and element directly:

```html
<script type="module" src="https://three.ws/agent-3d/latest/agent-3d.js"></script>
<agent-3d agent-id="agt_abc123" controls="orbit"></agent-3d>
```

## Register on-chain

```js
await agent.register({
	ipfsToken: 'your-web3storage-token',
	imageFile: someFile, // optional
	onStatus: (msg) => console.log(msg),
});
```

Needs MetaMask (or any injected wallet) and a [web3.storage](https://web3.storage) API token. The canonical ERC-8004 registry addresses ship built in for 15 mainnets and 7 testnets (see `REGISTRY_DEPLOYMENTS`); registration runs on whichever chain the connected wallet is on. For any other chain, set an env override (see "Configuring registry addresses" below).

## Generate `.well-known` manifests

```js
const { agentRegistration, agentCard, aiPlugin } = agent.manifests({
	openapiUrl: 'https://myapp.com/.well-known/openapi.yaml',
});
```

Serve these JSON documents from:

- `/.well-known/agent-registration.json` — ERC-8004 discovery
- `/.well-known/agent-card.json` — A2A protocol
- `/.well-known/ai-plugin.json` — OpenAI plugin manifest

## API

### `new AgentKit(options)`

| Option        | Type                     | Description                                |
| ------------- | ------------------------ | ------------------------------------------ |
| `name`        | `string` **(required)**  | Agent display name                         |
| `endpoint`    | `string` **(required)**  | Your agent's public URL                    |
| `description` | `string`                 | What the agent does                        |
| `image`       | `string`                 | Public URL to logo/avatar                  |
| `version`     | `string`                 | Semver version (default: `1.0.0`)          |
| `org`         | `string`                 | Organization name for `agent-card.json`    |
| `skills`      | `Array`                  | A2A skill definitions                      |
| `services`    | `Array`                  | Extra service entries (A2A, MCP endpoints) |
| `onMessage`   | `async (text) => string` | Your response handler                      |
| `welcome`     | `string`                 | Panel welcome message                      |
| `voice`       | `boolean`                | Enable TTS on replies (default: `true`)    |

### Methods

- `agent.mount(element?)` — attach panel to DOM (default: `document.body`)
- `agent.open()` / `agent.close()` — show/hide the panel
- `agent.addMessage(role, text)` — programmatically add a message (`role`: `'ak-agent'` or `'ak-user'`)
- `agent.register(options)` — ERC-8004 on-chain registration
- `agent.manifests(options)` — generate `.well-known` JSON documents
- `agent.dispose()` — remove panel from DOM

### Low-level exports

For direct control:

```js
import {
	AgentPanel,
	connectWallet,
	registerAgent,
	pinToIPFS,
	buildRegistrationJSON,
	agentRegistration,
	agentCard,
	aiPlugin,
	IDENTITY_REGISTRY_ABI,
	REGISTRY_DEPLOYMENTS,
} from '@three-ws/sdk';
```

## Configuring registry addresses

The SDK ships the canonical ERC-8004 reference deployments (same CREATE2
address on every chain) for Ethereum, Base, Arbitrum, Optimism, Polygon, BSC,
Avalanche and the other chains listed in `REGISTRY_DEPLOYMENTS`, plus the
matching testnets. On those chains `register()` works with no configuration.

To point a chain at a different deployment (or add a chain the table does not
cover), set an env override before calling; it wins over the built-in table:

```bash
THREE_WS_REGISTRY_IDENTITY_<chainId>=0xYourIdentityRegistry
THREE_WS_REGISTRY_REPUTATION_<chainId>=0xYourReputationRegistry
THREE_WS_REGISTRY_VALIDATION_<chainId>=0xYourValidationRegistry
```

A chain with neither a built-in entry nor an override throws a clear error
instead of sending a transaction to the zero address.

## Permissions

Grant, list, redeem, and revoke ERC-7710 scoped delegations via the `PermissionsClient`.
`grant` and `revoke` require a browser wallet (MetaMask / any injected ethers v6 Signer).

```ts
import { AgentKit } from '@three-ws/sdk';
import { PermissionsClient } from '@three-ws/sdk/permissions';

const client = new PermissionsClient({ baseUrl: 'https://three.ws/' });

// Fetch active delegations for an agent
const { spec, delegations } = await client.getMetadata(agentId);

// Grant a new delegation (browser only — needs MetaMask)
const { id, delegationHash } = await client.grant({
	agentId,
	chainId: 84532,
	preset: {
		token: 'native',
		maxAmount: '1000000',
		period: 'daily',
		targets: ['0xTarget'],
		expiryDays: 30,
	},
	delegate: agentSmartAccountAddress,
	signer, // ethers v6 Signer from connectWallet()
});

// Verify on-chain that a delegation is still active
const { valid, reason } = await client.verify(delegationHash, 84532);

// Revoke (browser only)
await client.revoke({ id, delegationHash, signer });
```

For advanced use (direct toolkit access with tree-shaking):

```ts
import {
	encodeScopedDelegation,
	isDelegationValid,
} from '@three-ws/sdk/permissions/advanced';
```

## Solana identity & payments

Sign in with Solana (SIWS), register an agent's identity via Metaplex, and run a
Solana Pay checkout. Imported from `@three-ws/sdk/solana` (or the root). Needs an
injected Solana wallet (`@solana/web3.js@^1` is an optional peer dependency).

```js
import {
	detectSolanaProvider,
	signInWithSolana,
	registerSolanaAgent,
	startSolanaCheckout,
	confirmSolanaPayment,
} from '@three-ws/sdk/solana';

const provider = detectSolanaProvider();
const { publicKey } = await signInWithSolana({ provider });

const { intentId, reference } = await startSolanaCheckout({ plan: 'pro', network: 'mainnet' });
const ok = await confirmSolanaPayment({ intentId, txSignature, network: 'mainnet' });
```

On-chain attestations and reputation (feedback, validation, tasks, disputes) are
exported from `@three-ws/sdk/solana-attestations`: `attestFeedback`,
`attestValidation`, `createTask`, `acceptTask`, `attestRevoke`, `attestDispute`,
`listAttestations`, `fetchAttestations`, `fetchReputation`.

## Paid agent-to-agent calls (x402)

`AgentClient` calls another agent's paid skills, handling the x402 `402 Payment
Required` flow for you.

```js
import { AgentClient, PaymentRequiredError } from '@three-ws/sdk';

const client = new AgentClient({ baseUrl: 'https://three.ws/', apiKey: process.env.THREE_WS_KEY });

const prices = await client.getSkillPrices(agentId);
try {
	const result = await client.invokeSkill(agentId, 'summarize', { url: 'https://example.com' });
} catch (err) {
	if (err instanceof PaymentRequiredError) {
		// surface the payment requirements to the user / wallet
	}
}
```

## Requirements

- **Node** `>= 18`; runs in modern browsers (the panel and avatar are browser-only).
- **Optional peers:** `ethers@^6` (for `register()` and `PermissionsClient`),
  `@solana/web3.js@^1` (for the Solana helpers).
- **Credentials:** a [web3.storage](https://web3.storage) token for IPFS pinning on
  `register()`; an injected EVM wallet (MetaMask) or Solana wallet for signing.

## Links

- Homepage: https://three.ws
- Changelog: https://three.ws/changelog
- Sibling SDK: [`@three-ws/solana-agent`](https://www.npmjs.com/package/@three-ws/solana-agent)
- Issues: https://github.com/nirholas/three.ws/issues
- License: proprietary, see [LICENSE](./LICENSE)

---

<p align="center">
  <sub>
    Part of the <a href="https://three.ws">three.ws</a> SDK suite — 3D AI agents, on-chain identity, and agent payments.<br/>
    <a href="https://three.ws">Website</a> · <a href="https://three.ws/changelog">Changelog</a> · <a href="https://github.com/nirholas/three.ws">GitHub</a>
  </sub>
</p>
