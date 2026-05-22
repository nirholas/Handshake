// `ens_sns_resolve` — resolve human-readable names to on-chain addresses
// across ENS (Ethereum) and SNS (Solana, Bonfida). Useful for naming
// avatar wallets ("alice.sol") or sending to ENS addresses without
// pasting raw hex.

import { z } from 'zod';

import { resolveName } from '../lib/ens-sns.js';

export const def = {
	name: 'ens_sns_resolve',
	title: 'Resolve ENS + SNS names to addresses',
	description:
		'Resolve a human-readable name to addresses across ENS (Ethereum) and SNS (Solana, Bonfida). For .eth: returns Ethereum address + reverse lookup. For .sol: returns Solana owner wallet + the wallet\'s other owned .sol domains + favorite domain. Names without a suffix are tried against both registries.',
	inputSchema: {
		name: z.string().min(1).max(253).describe('Name to resolve, e.g. "vitalik.eth", "bonfida.sol", or bare "vitalik" (tried in both registries).'),
	},
	async handler(args) {
		return await resolveName(args.name);
	},
};
