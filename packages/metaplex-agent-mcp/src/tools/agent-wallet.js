// `agent_wallet`: resolve a wallet and its SOL balance. Three modes:
//   asset   → the asset's built-in wallet (mpl-core Asset Signer PDA)
//   address → any wallet, verbatim
//   neither → the configured signer (the wallet that pays for mints)

import { z } from 'zod';

import { NETWORK, SOLANA_DEFAULT_SECRET } from '../config.js';
import { buildUmi, solBalance, assetSignerAddress } from '../lib/solana.js';

export const def = {
	name: 'agent_wallet',
	title: "An agent's built-in wallet, or the signer wallet, with balance",
	annotations: { readOnlyHint: true, idempotentHint: false, openWorldHint: true },
	description:
		"Show a wallet address and its live SOL balance. Pass `asset` to derive an on-chain agent's built-in wallet " +
		'(the Metaplex Core Asset Signer PDA, the wallet shown on metaplex.com/agents). Pass `address` to inspect ' +
		'any wallet. Pass neither to see the configured signing wallet, e.g. to confirm it is funded before ' +
		'mint_onchain_agent. Read-only; never moves funds.',
	inputSchema: {
		asset: z.string().min(32).max(44).optional().describe("A Core asset address: derives that agent's built-in wallet."),
		address: z.string().min(32).max(44).optional().describe('A wallet address to inspect verbatim.'),
		network: z.enum(['mainnet', 'devnet']).optional().describe('Cluster. Defaults to the configured network.'),
	},
	async handler(args) {
		const network = args.network || NETWORK;
		if (args.asset && args.address) {
			throw Object.assign(new Error('pass either `asset` or `address`, not both'), { code: 'validation_error' });
		}
		const umi = buildUmi({ network });

		let address;
		let kind;
		if (args.asset) {
			address = assetSignerAddress(umi, args.asset);
			kind = 'asset_signer';
		} else if (args.address) {
			address = String(args.address).trim();
			kind = 'address';
		} else {
			if (!SOLANA_DEFAULT_SECRET) {
				throw Object.assign(
					new Error('No `asset` or `address` given and no SOLANA_SECRET_KEY configured. Pass one, or set a signer.'),
					{ code: 'no_signer' },
				);
			}
			const signerUmi = buildUmi({ network, requireSigner: true });
			address = signerUmi.identity.publicKey.toString();
			kind = 'signer';
		}

		const sol = await solBalance(umi, address);
		return {
			ok: true,
			network,
			kind,
			address,
			sol,
			...(args.asset ? { asset: args.asset } : {}),
		};
	},
};
