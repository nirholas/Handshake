// `three_burn` — the headline. Burn a USD-denominated amount of $THREE on-chain,
// split between the incinerator and the treasury per the live public config.
// EXECUTION ACTION: signs and broadcasts a Solana mainnet transaction.

import { z } from 'zod';

import { burnThree } from '../lib/token.js';

export const def = {
	name: 'three_burn',
	title: 'Burn $THREE on-chain (incinerator + treasury split)',
	description:
		'Burn a USD-denominated amount of the $THREE your wallet holds. Quotes USD→$THREE via Jupiter, then sends ONE Solana transaction that splits it between the incinerator (burn) and the three.ws treasury, per the live public token config. EXECUTION ACTION — signs and broadcasts on Solana mainnet, irreversible. Requires a signer (SOLANA_SECRET_KEY env or the `secret` arg) holding enough $THREE. Returns the tx signature, the burned/treasury breakdown, and a Solscan link.',
	inputSchema: {
		usd: z.number().positive().describe('USD value of $THREE to burn (priced live via Jupiter).'),
		burnBps: z
			.number()
			.min(0)
			.max(10000)
			.optional()
			.describe(
				'Share routed to the incinerator in basis points. Default 5000 (50% burn / 50% treasury). 10000 = burn everything.',
			),
		memo: z.string().max(120).optional().describe('Optional note appended to the on-chain memo.'),
		secret: z
			.string()
			.optional()
			.describe('Base58 signer override. Defaults to SOLANA_SECRET_KEY. Treat like cash.'),
	},
	async handler(args) {
		const { usd, burnBps, memo, secret } = args || {};
		return burnThree({ usd, burnBps, memo, secret });
	},
};
