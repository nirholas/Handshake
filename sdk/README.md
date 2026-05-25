# @three-ws/sdk

Ship an **ERC-8004 agent** with on-chain identity, a chat panel, and discoverable `.well-known` endpoints — in minutes.

## Install

```bash
npm install @three-ws/sdk ethers
```

`ethers@^6` is a peer dependency (only needed if you call `register()`).

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

Needs MetaMask (or any injected wallet) and a [web3.storage](https://web3.storage) API token. Requires a deployed ERC-8004 Identity Registry — set the address in `REGISTRY_DEPLOYMENTS` before calling.

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

Before calling `register()`, set your Identity Registry address in `sdk/src/erc8004/abi.js`:

```js
export const REGISTRY_DEPLOYMENTS = {
	8453: { identityRegistry: '0xYourBaseMainnetAddress' },
	84532: { identityRegistry: '0xYourBaseSepoliaAddress' },
};
```

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

## License

MIT
