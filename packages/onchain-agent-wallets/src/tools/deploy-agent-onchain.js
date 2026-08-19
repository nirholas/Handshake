// `deploy_agent_onchain`: publish the agent's identity where other agents can
// find it, with its payment address attached.
//
// A wallet nobody can discover cannot be paid. This mints a Metaplex Core asset
// carrying the agent's EIP-8004 registration document, flags x402 support, and
// writes the agent's payment address, vault, and asset mint into the on-chain
// Attributes plugin, so a counterparty can read where to pay this agent
// straight off the chain.
//
// The mint itself is the sibling package's job (@three-ws/metaplex-agent-mcp),
// reused as a library rather than reimplemented.

import { z } from 'zod';

import {
	buildUmi,
	buildAgentMint,
	sendAgentMint,
	agentLinks,
	txLink,
	toBase58Signature,
} from '@three-ws/metaplex-agent-mcp/lib';

import { NETWORK, REQUIRE_CONFIRM, OWNER_SECRET } from '../config.js';
import { agentContext } from '../lib/agent.js';
import { updateState } from '../lib/store.js';
import { summarize } from '../lib/execute.js';

export const def = {
	name: 'deploy_agent_onchain',
	title: 'Publish the agent on-chain with its payment address',
	annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
	description:
		'Mint the agent an on-chain identity in the Metaplex Agent Registry on Solana, carrying its EIP-8004 ' +
		'registration document, an x402Support flag, and on-chain attributes naming its payment address, its vault, ' +
		'and the token it accepts. After this the agent is discoverable on metaplex.com/agents and any counterparty ' +
		'can read where to pay it. Costs about 0.007 SOL and needs an owner signing key (set OWNER_SECRET_KEY or pass ' +
		'`secret`); to mint from Phantom or a Ledger instead, use prepare_agent_mint in @three-ws/metaplex-agent-mcp. ' +
		'Requires confirm:true to broadcast.',
	inputSchema: {
		id: z.string().describe('The agent wallet to publish.'),
		name: z.string().max(32).optional().describe('On-chain name. Defaults to the agent label or id.'),
		description: z.string().max(500).optional().describe('What this agent does.'),
		image: z.string().url().optional().describe('Image URL for the asset.'),
		model_url: z.string().url().optional().describe('GLB avatar URL, rendered on metaplex.com/agents.'),
		services: z
			.array(z.object({ name: z.string(), endpoint: z.string() }))
			.optional()
			.describe('Endpoints this agent serves, e.g. its own x402 API.'),
		secret: z.string().optional().describe('Owner secret key for this call only.'),
		confirm: z.boolean().optional().describe('Set true to broadcast.'),
	},
	async handler(args) {
		const ctx = await agentContext(args.id);
		const { record } = ctx;

		if (record.deployment?.asset) {
			throw Object.assign(
				new Error(
					`"${record.id}" is already deployed as ${record.deployment.asset}. ` +
						'Use the Metaplex registry tools to update its identity document.',
				),
				{ code: 'already_deployed' },
			);
		}

		const secret = args.secret || OWNER_SECRET;
		if (!secret) {
			throw Object.assign(
				new Error(
					'deploying mints an asset, which needs a signing key. Set OWNER_SECRET_KEY, pass `secret`, or mint ' +
						'from your browser wallet with prepare_agent_mint in @three-ws/metaplex-agent-mcp.',
				),
				{ code: 'no_signer' },
			);
		}

		const name = args.name || record.label || record.id;
		const attributes = [
			{ key: 'agent_wallet', value: record.agent_pubkey },
			{ key: 'payment_vault', value: record.vault },
			{ key: 'payment_mint', value: record.mint },
			{ key: 'payment_network', value: `solana:${NETWORK}` },
			{ key: 'custody', value: 'delegated:spl-token-approve' },
		];

		const summary = summarize({
			action: `Publish "${record.id}" to the Metaplex Agent Registry`,
			network: NETWORK,
			extra: {
				name,
				agent_wallet: record.agent_pubkey,
				vault: record.vault,
				accepts: record.mint,
				x402: true,
				estimated_cost: '~0.007 SOL (rent and fees)',
				attributes,
			},
		});

		if (REQUIRE_CONFIRM && args.confirm !== true) {
			return {
				ok: false,
				action: 'confirm_required',
				summary,
				message: 'Nothing has been minted. Re-issue with confirm:true to publish.',
			};
		}

		const umi = buildUmi({ network: NETWORK, secret, requireSigner: true });
		const creator = umi.identity.publicKey.toString();
		const mint = buildAgentMint(umi, {
			network: NETWORK,
			creator,
			name,
			description: args.description || `Agent wallet with an on-chain spending allowance. Pays with x402 on Solana.`,
			image: args.image,
			modelUrl: args.model_url,
			services: args.services,
			x402Support: true,
			attributes,
			metadataAttributes: attributes,
		});

		const asset = mint.assetSigner.publicKey.toString();
		const sent = await sendAgentMint(umi, mint, { toBase58Signature });

		const deployment = {
			asset,
			signatures: sent.signatures,
			atomic: sent.atomic,
			registry: 'metaplex-agent-registry',
			deployed_at: new Date().toISOString(),
		};
		updateState((state) => {
			state.agents[record.id].deployment = deployment;
		});

		return {
			ok: true,
			action: 'deployed',
			summary,
			agent: record.id,
			asset,
			signatures: sent.signatures.map((sig) => ({ signature: sig, link: txLink(sig, NETWORK) })),
			links: agentLinks(asset, NETWORK),
			registration: mint.registration,
			attributes,
			message: `"${record.id}" is live on-chain. Its payment address is published in the asset attributes.`,
		};
	},
};
