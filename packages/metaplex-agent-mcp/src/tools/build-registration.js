// `build_registration`: pure document builder. Produces the EIP-8004
// registration JSON and its data: URI without touching the chain, so an agent
// can preview, host, or hand-tune its identity before minting.

import { z } from 'zod';

import { NETWORK } from '../config.js';
import { buildRegistrationDoc, chainRegistration, threeWsRegistration, jsonDataUri } from '../lib/registration.js';

export const def = {
	name: 'build_registration',
	title: 'Build an EIP-8004 registration document (no chain access)',
	annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
	description:
		'Build the Genesis-style EIP-8004 registration-v1 JSON document and its self-contained ' +
		'data:application/json;base64 URI, without touching Solana. Use it to preview exactly what ' +
		'mint_onchain_agent / register_agent_identity will write on-chain, or to host the document yourself and ' +
		'pass it back as registration_uri.',
	inputSchema: {
		name: z.string().min(1).max(60).describe('Agent name.'),
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
		})).max(8).optional().describe('External registry entries.'),
		threews_agent_id: z.string().uuid().optional().describe('three.ws agent UUID for the Genesis-exact three.ws entry.'),
		asset: z.string().min(32).max(44).optional().describe('Asset address for the default chain-registry entry when no registrations are given.'),
		network: z.enum(['mainnet', 'devnet']).optional().describe('Network for the default chain-registry entry. Defaults to the configured network.'),
	},
	async handler(args) {
		const network = args.network || NETWORK;
		const registrations = args.registrations?.length
			? args.registrations.map((r) => ({ agentId: r.agent_id, agentRegistry: r.agent_registry }))
			: args.threews_agent_id
				? [threeWsRegistration(args.threews_agent_id)]
				: args.asset
					? [chainRegistration(args.asset, network)]
					: [];
		const registration = buildRegistrationDoc({
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
		const uri = jsonDataUri(registration);
		return {
			ok: true,
			registration,
			registration_uri: uri,
			registration_uri_bytes: uri.length,
		};
	},
};
