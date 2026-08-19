# @three-ws/metaplex-agent-mcp

Deploy AI agents on-chain into the **[Metaplex Agent Registry](https://www.metaplex.com/agents)** on Solana, from any MCP client.

One flow mints a **Metaplex Core asset** and registers its **EIP-8004 agent identity** (a single atomic transaction when it fits Solana's 1232-byte limit, create + register in sequence otherwise, exactly how the Genesis 333 landed), so the agent shows up on metaplex.com/agents with its own built-in wallet, reputation surface, and explorer pages. The default output reproduces the exact shape of the [three.ws](https://three.ws) Genesis 333 mints, verified byte-for-byte against the live assets:

- asset metadata as a self-contained `data:application/json;base64` URI (`name`, `image`, `animation_url` GLB)
- Royalties plugin (5% to the owner), VerifiedCreators (the signing wallet), ImmutableMetadata
- AgentIdentity plugin carrying the `eip-8004#registration-v1` document (`model.uri`, `active`, `x402Support`, `registrations`, `supportedTrust`)

Two signing lanes, both self-custodial:

- **Agents** sign with their own keypair (`SOLANA_SECRET_KEY`): `mint_onchain_agent`.
- **People** sign with Phantom, Solflare, Backpack, Ledger, or any Solana wallet: `prepare_agent_mint` builds the transaction, the wallet signs it, `send_signed_transaction` broadcasts it. No key ever touches the server.

Nothing is mocked: real Metaplex programs, real Solana, and devnet support for free end-to-end rehearsal.

## Install

```bash
npm install -g @three-ws/metaplex-agent-mcp
# or run ad hoc
npx -y @three-ws/metaplex-agent-mcp
```

## Setup

Claude Code:

```bash
claude mcp add metaplex-agent -e SOLANA_SECRET_KEY=<base58> -- npx -y @three-ws/metaplex-agent-mcp
```

Cursor / any MCP client (`mcp.json`):

```json
{
	"mcpServers": {
		"metaplex-agent": {
			"command": "npx",
			"args": ["-y", "@three-ws/metaplex-agent-mcp"],
			"env": { "SOLANA_SECRET_KEY": "<base58 secret key>" }
		}
	}
}
```

`SOLANA_SECRET_KEY` is optional: every read tool and the whole Phantom/Solflare flow works without it.

## Quick start

Rehearse on devnet for free, then go to mainnet:

```
1. agent_wallet {}                                → confirm the signer is funded
2. mint_onchain_agent { name: "Astra", description: "…",
     image: "https://…png", model_url: "https://…glb",
     x402_support: true, network: "devnet" }      → preview (nothing broadcast)
3. …same call with confirm: true                  → minted + registered, links returned
4. get_onchain_agent { asset: "<returned asset>", network: "devnet" }
```

The mint costs ~0.007 SOL on mainnet (Core rent + identity PDA rent + fees).

## Tools

| Tool | What it does |
|---|---|
| `mint_onchain_agent` | Mint + register, signed by your key (atomic when it fits, auto-split otherwise). `confirm:true` gates the spend; anything else returns a full preview. |
| `prepare_agent_mint` | The same mint, built for an external wallet (`wallet` param) to sign. Returns `txs_base64`, already co-signed by the new asset keypair; sign with `signTransaction` / `signAllTransactions`. |
| `send_signed_transaction` | Broadcast wallet-signed transactions in order, polling each to confirmation and absorbing the create/register propagation race. |
| `register_agent_identity` | Enrol an already-minted Core asset in the Agent Registry (idempotent; the signer must be the asset authority). |
| `get_onchain_agent` | Read any registered agent: asset, plugins, decoded metadata + registration documents, identity PDA, built-in wallet + balance. |
| `agent_wallet` | An asset's built-in wallet (mpl-core Asset Signer PDA), any address, or the configured signer, with live SOL balance. |
| `build_registration` | The EIP-8004 registration JSON + `data:` URI, fully offline. |
| `list_onchain_agents` | Latest registrations from the live three.ws `/api/deployments` feed (Solana by default, `all_chains:true` for EVM ERC-8004 too). |

## Customization

Every field the mint touches is a parameter: owner, collection, royalty basis points and splits, verified creator, immutable metadata, on-chain Attributes, permanent freeze/transfer/burn delegates, AddBlocker, off-chain metadata attributes, `external_url`, services, trust models, registration entries, and full `metadata_uri` / `registration_uri` overrides for documents you host yourself. The defaults are the Genesis 333 values, so calling with just `name`, `description`, `image`, and `model_url` produces an asset indistinguishable in shape from the originals.

## Safety

- `mint_onchain_agent` and `register_agent_identity` broadcast **only** with `confirm: true` (set `REQUIRE_CONFIRM=false` to opt out); previews cost nothing.
- Keys stay yours: `SOLANA_SECRET_KEY` or a per-call `secret`, never a custodial wallet. The wallet lane needs no key at all.
- Balances are checked before spending, RPC endpoints must be HTTPS, and devnet is a first-class target for rehearsal.

## Environment variables

| Variable | Default | Meaning |
|---|---|---|
| `SOLANA_SECRET_KEY` | unset | Base58 secret key or JSON byte array for the minting wallet. |
| `SOLANA_RPC_URL` | public endpoint | HTTPS RPC. Bring your own for production traffic. |
| `METAPLEX_AGENT_NETWORK` | `mainnet` | Default cluster (`mainnet` or `devnet`); every tool takes a per-call `network` too. |
| `REQUIRE_CONFIRM` | `true` | Gate spends behind `confirm: true`. |
| `THREE_WS_BASE` | `https://three.ws` | Host for the deployments feed. |

## Library use

The builders are exported for direct embedding (web apps, scripts):

```js
import { buildAgentMint, sendAgentMint, buildUmi, toBase58Signature } from '@three-ws/metaplex-agent-mcp/lib';

const umi = buildUmi({ network: 'devnet', secret: process.env.SOLANA_SECRET_KEY });
const mint = buildAgentMint(umi, {
	network: 'devnet',
	creator: umi.identity.publicKey.toString(),
	name: 'Astra',
	description: 'An autonomous 3D agent',
	image: 'https://example.com/astra.png',
	modelUrl: 'https://example.com/astra.glb',
	x402Support: true,
});
const { signatures, atomic } = await sendAgentMint(umi, mint, { toBase58Signature });
```

The registration and metadata builders are also importable on their own (dependency-free, browser-safe) from `@three-ws/metaplex-agent-mcp/lib/registration`, and the transaction builders from `@three-ws/metaplex-agent-mcp/lib/mint`. The three.ws `/deploy-onchain` page runs on exactly these.

## Requirements

- Node 20+
- SOL on the target network for minting (~0.007 SOL per agent on mainnet; devnet is free via faucet)

## Links

- three.ws: https://three.ws
- Live deployments feed: https://three.ws/deployments
- Metaplex Agent Registry: https://www.metaplex.com/agents
- Metaplex docs: https://www.metaplex.com/docs/agents
- Source: https://github.com/nirholas/three.ws/tree/main/packages/metaplex-agent-mcp
