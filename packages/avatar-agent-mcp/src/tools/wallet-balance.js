// `wallet_balance` — read SOL balance and all SPL token balances (both
// classic SPL + Token-2022) for any Solana pubkey. Read-only, no signer.

import { z } from 'zod';

import { getBalanceSol, getTokenBalances, isValidPubkey } from '../lib/solana.js';
import { SOLANA_RPC_URL } from '../config.js';

export const def = {
	name: 'wallet_balance',
	title: 'Read Solana wallet balances (SOL + SPL tokens)',
	description:
		'Return SOL balance and all SPL token balances (including Token-2022) for a Solana pubkey. Uses the configured SOLANA_RPC_URL. Read-only — no signer required.',
	inputSchema: {
		pubkey: z.string().min(32).max(64).describe('Base58 Solana pubkey to read.'),
		includeTokens: z.boolean().optional().describe('Include SPL token accounts (default true).'),
	},
	async handler(args) {
		const { pubkey, includeTokens = true } = args || {};
		if (!isValidPubkey(pubkey)) {
			return { ok: false, error: 'invalid_pubkey' };
		}
		const sol = await getBalanceSol(pubkey);
		const tokens = includeTokens ? await getTokenBalances(pubkey) : null;
		return {
			ok: true,
			pubkey,
			sol: sol.sol,
			lamports: sol.lamports,
			tokens,
			rpc: SOLANA_RPC_URL,
			explorer: `https://solscan.io/account/${pubkey}`,
			fetchedAt: new Date().toISOString(),
		};
	},
};
