// The full customization surface shared by `mint_onchain_agent` (keypair
// signing) and `prepare_agent_mint` (Phantom/Solflare signing). One place, so
// both flows accept exactly the same fields and produce exactly the same asset.

import { z } from 'zod';

const pubkey = z.string().min(32).max(44);

export const mintShape = {
	name: z.string().min(1).max(60).describe('Agent name. Becomes the Core asset name and the registration name.'),
	description: z.string().max(2000).optional().describe('What this agent is or does. Stored in the EIP-8004 registration document.'),
	image: z.string().url().optional().describe('Thumbnail/avatar image URL (PNG or similar). Shown on metaplex.com/agents, wallets, and explorers.'),
	model_url: z.string().url().optional().describe('3D model URL (GLB). Written as the asset metadata animation_url and as model.uri in the registration, Genesis style.'),
	external_url: z.string().url().optional().describe('Optional external_url in the asset metadata (e.g. the agent home page).'),
	network: z.enum(['mainnet', 'devnet']).optional().describe('Solana cluster. Defaults to the configured network (mainnet unless overridden).'),
	owner: pubkey.optional().describe('Mint the asset to this owner instead of the signing wallet.'),
	collection: pubkey.optional().describe('Mint into this Metaplex Core collection. The signer must be the collection authority.'),
	royalty_basis_points: z.number().int().min(0).max(10000).optional().describe('Royalty in basis points. Default 500 (5%), the Genesis value. 0 removes the Royalties plugin.'),
	royalty_creators: z.array(z.object({
		address: pubkey,
		percentage: z.number().int().min(0).max(100),
	})).max(8).optional().describe('Royalty split. Percentages must sum to 100. Defaults to the signing wallet at 100%.'),
	verified_creator: z.boolean().optional().describe('Attach the VerifiedCreators plugin with the signing wallet verified. Default true (Genesis style).'),
	immutable_metadata: z.boolean().optional().describe('Attach the ImmutableMetadata plugin so the metadata can never change. Default true (Genesis style).'),
	attributes: z.array(z.object({ key: z.string().min(1).max(64), value: z.string().max(256) })).max(24).optional().describe('On-chain Attributes plugin entries (real bytes in the asset account).'),
	metadata_attributes: z.array(z.object({ key: z.string().min(1).max(64), value: z.string().max(256) })).max(48).optional().describe('Off-chain attributes array inside the asset metadata JSON (trait_type/value pairs).'),
	permanent_freeze: z.boolean().optional().describe('Attach PermanentFreezeDelegate (unfrozen). Default false.'),
	permanent_transfer: z.boolean().optional().describe('Attach PermanentTransferDelegate. Default false.'),
	permanent_burn: z.boolean().optional().describe('Attach PermanentBurnDelegate. Default false.'),
	add_blocker: z.boolean().optional().describe('Attach AddBlocker so no further plugins can be added. Default false.'),
	services: z.array(z.object({
		name: z.string().min(1).max(64),
		endpoint: z.string().url(),
	})).max(16).optional().describe('Services the agent offers, listed on its Metaplex agent page ({name, endpoint}).'),
	x402_support: z.boolean().optional().describe('Advertise x402 payment support in the registration document. Default false.'),
	active: z.boolean().optional().describe('Registration active flag. Default true.'),
	supported_trust: z.array(z.string().min(1).max(64)).max(8).optional().describe("Trust models the agent supports. Default ['reputation'] (Genesis style)."),
	registrations: z.array(z.object({
		agent_id: z.string().min(1).max(128),
		agent_registry: z.string().min(1).max(256),
	})).max(8).optional().describe('External registry registrations. Defaults to the chain registry entry, or the three.ws entry when threews_agent_id is set.'),
	threews_agent_id: z.string().uuid().optional().describe('three.ws agent UUID. Adds the Genesis-exact registration entry {agentId, agentRegistry: "https://three.ws"}.'),
	metadata_uri: z.string().optional().describe('Full override for the asset metadata URI (https or data:). Skips the built-in metadata builder.'),
	registration_uri: z.string().optional().describe('Full override for the Agent Identity registration URI (https or data:). Skips the built-in registration builder.'),
};

/** Map snake_case tool args onto buildAgentMint camelCase params. */
export function mintParams(args, { network, creator }) {
	return {
		network,
		creator,
		owner: args.owner,
		collection: args.collection,
		name: args.name,
		description: args.description || '',
		image: args.image,
		modelUrl: args.model_url,
		externalUrl: args.external_url,
		metadataAttributes: args.metadata_attributes?.map((a) => ({ key: a.key, value: a.value })),
		metadataUri: args.metadata_uri,
		services: args.services,
		active: args.active,
		x402Support: args.x402_support,
		registrations: args.registrations?.map((r) => ({ agentId: r.agent_id, agentRegistry: r.agent_registry })),
		threeWsAgentId: args.threews_agent_id,
		supportedTrust: args.supported_trust,
		registrationUri: args.registration_uri,
		royaltyBasisPoints: args.royalty_basis_points,
		royaltyCreators: args.royalty_creators,
		verifiedCreator: args.verified_creator,
		immutableMetadata: args.immutable_metadata,
		attributes: args.attributes,
		permanentFreeze: args.permanent_freeze,
		permanentTransfer: args.permanent_transfer,
		permanentBurn: args.permanent_burn,
		addBlocker: args.add_blocker,
	};
}
