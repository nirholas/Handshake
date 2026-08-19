// `register_agent_identity`: enrol an EXISTING Metaplex Core asset in the
// Agent Registry. This is the back-fill path: the asset was minted earlier
// (any Core mint qualifies) and only the Agent Identity is missing. The signer
// must hold the asset's update authority (for collection-bound assets, the
// collection authority).

import { z } from 'zod';

import { NETWORK, REQUIRE_CONFIRM } from '../config.js';
import { publicKey as umiPublicKey } from '@metaplex-foundation/umi';
import { registerIdentityV1, findAgentIdentityV1Pda } from '@metaplex-foundation/mpl-agent-registry';

import {
	buildRegistrationDoc,
	chainRegistration,
	threeWsRegistration,
	jsonDataUri,
} from '../lib/registration.js';
import {
	buildUmi,
	agentLinks,
	txLink,
	toBase58Signature,
	EST_REGISTER_LAMPORTS,
	LAMPORTS_PER_SOL,
} from '../lib/solana.js';

export const def = {
	name: 'register_agent_identity',
	title: 'Register an existing Core asset in the Metaplex Agent Registry',
	annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
	description:
		'Give an ALREADY-MINTED Metaplex Core asset its Agent Identity: writes the EIP-8004 registration document ' +
		'(as a self-contained data: URI) onto the asset and creates its identity PDA, after which it appears on ' +
		'metaplex.com/agents. The signing wallet must be the asset authority (or the collection authority for ' +
		'collection-bound assets). Registration is one-time per asset and costs ~0.003 SOL; an already-registered ' +
		'asset returns already_registered without spending. Without confirm:true it returns a spend-nothing preview. ' +
		'To mint a NEW agent, use mint_onchain_agent or prepare_agent_mint instead.',
	inputSchema: {
		asset: z.string().min(32).max(44).describe('The Core asset address to register.'),
		collection: z.string().min(32).max(44).optional().describe('The collection address, required for collection-bound assets.'),
		name: z.string().min(1).max(60).describe('Agent name for the registration document.'),
		description: z.string().max(2000).optional().describe('Agent description.'),
		image: z.string().url().optional().describe('Thumbnail image URL.'),
		model_url: z.string().url().optional().describe('3D model URL (GLB), written as model.uri.'),
		services: z.array(z.object({ name: z.string().min(1).max(64), endpoint: z.string().url() })).max(16).optional()
			.describe('Services the agent offers.'),
		x402_support: z.boolean().optional().describe('Advertise x402 payment support. Default false.'),
		active: z.boolean().optional().describe('Registration active flag. Default true.'),
		supported_trust: z.array(z.string().min(1).max(64)).max(8).optional().describe("Default ['reputation']."),
		registrations: z.array(z.object({
			agent_id: z.string().min(1).max(128),
			agent_registry: z.string().min(1).max(256),
		})).max(8).optional().describe('External registry entries. Defaults to the chain registry entry.'),
		threews_agent_id: z.string().uuid().optional().describe('three.ws agent UUID for the Genesis-exact three.ws registration entry.'),
		registration_uri: z.string().optional().describe('Full override for the registration URI (https or data:).'),
		network: z.enum(['mainnet', 'devnet']).optional().describe('Cluster. Defaults to the configured network.'),
		secret: z.string().optional().describe('Per-call signing key. Overrides SOLANA_SECRET_KEY.'),
		confirm: z.boolean().optional().describe('Must be true to broadcast. Anything else returns a preview.'),
	},
	async handler(args) {
		const network = args.network || NETWORK;
		const umi = buildUmi({ network, secret: args.secret, requireSigner: true });
		const assetPk = umiPublicKey(args.asset);
		const [identityPda] = findAgentIdentityV1Pda(umi, { asset: assetPk });

		const existing = await umi.rpc.getAccount(identityPda).catch(() => null);
		if (existing?.exists && existing.data?.length) {
			return {
				ok: true,
				already_registered: true,
				asset: args.asset,
				identity_pda: identityPda.toString(),
				links: agentLinks(args.asset, network),
			};
		}

		const registrations = args.registrations?.length
			? args.registrations.map((r) => ({ agentId: r.agent_id, agentRegistry: r.agent_registry }))
			: args.threews_agent_id
				? [threeWsRegistration(args.threews_agent_id)]
				: [chainRegistration(args.asset, network)];
		const registration = args.registration_uri
			? null
			: buildRegistrationDoc({
					name: args.name,
					description: args.description || '',
					image: args.image,
					modelUrl: args.model_url,
					services: args.services,
					active: args.active,
					x402Support: args.x402_support,
					registrations,
					supportedTrust: args.supported_trust,
				});
		const agentRegistrationUri = args.registration_uri || jsonDataUri(registration);

		if (REQUIRE_CONFIRM && args.confirm !== true) {
			return {
				ok: true,
				confirm_required: true,
				message: `Preview only. Re-issue with confirm:true to register on ${network} for ~${EST_REGISTER_LAMPORTS / LAMPORTS_PER_SOL} SOL.`,
				network,
				asset: args.asset,
				identity_pda: identityPda.toString(),
				paying_wallet: umi.identity.publicKey.toString(),
				registration,
			};
		}

		const registerArgs = { asset: assetPk, agentRegistrationUri };
		if (args.collection) registerArgs.collection = umiPublicKey(args.collection);
		const result = await registerIdentityV1(umi, registerArgs).sendAndConfirm(umi, {
			confirm: { commitment: 'confirmed' },
		});
		const signature = toBase58Signature(result.signature);

		return {
			ok: true,
			network,
			asset: args.asset,
			identity_pda: identityPda.toString(),
			signature,
			tx: txLink(signature, network),
			registration,
			links: agentLinks(args.asset, network),
		};
	},
};
