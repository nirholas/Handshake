// `pump_snapshot` — live market snapshot for a Solana SPL or pump.fun
// token. Free, read-only. Aggregates Jupiter price, Dexscreener volume,
// pump.fun metadata, top holders from Solana RPC, and (optionally)
// Helius DAS supply info when HELIUS_API_KEY is set.

import { z } from 'zod';

import { snapshot } from '../lib/pumpfun.js';
import { isValidPubkey } from '../lib/solana.js';
import { THREE_MINT } from '../config.js';

export const def = {
	name: 'pump_snapshot',
	title: 'Live pump.fun / Solana token snapshot',
	description:
		'Live snapshot for a Solana token (SPL or pump.fun): USD price (Jupiter), 24h volume + primary DEX (Dexscreener), pump.fun metadata (name/symbol/image/socials/mcap), and top-holder distribution from Solana RPC. Optional Helius DAS supply when HELIUS_API_KEY is configured. Free — no signer.',
	inputSchema: {
		token: z.string().min(32).max(64).describe('Base58 Solana mint address. Pass "three" or omit to use the $three reference mint (THREE_MINT env).').optional(),
	},
	async handler(args) {
		let mint = args?.token;
		if (!mint || mint === 'three' || mint === '$three') {
			if (!THREE_MINT) {
				return {
					ok: false,
					error: 'three_mint_not_configured',
					message: 'No token argument and THREE_MINT env is unset. Pass token=<mint> or set THREE_MINT.',
				};
			}
			mint = THREE_MINT;
		}
		if (!isValidPubkey(mint)) {
			return { ok: false, error: 'invalid_mint', token: mint };
		}
		const result = await snapshot(mint);
		return { ok: true, ...result };
	},
};
