// `three_balance` — read the $THREE and SOL balance of a wallet. Defaults to
// the configured signer's address when no pubkey is supplied. Read-only.

import { z } from 'zod';

import { getSolBalance, getSplBalance, isValidPubkey, loadSigner } from '../lib/solana.js';
import { fetchTokenConfig } from '../lib/token.js';

export const def = {
	name: 'three_balance',
	title: "Read a wallet's $THREE + SOL balance",
	description:
		'Return the $THREE and SOL balance for a Solana pubkey. If no pubkey is given, uses the configured signer (SOLANA_SECRET_KEY). Read-only — no payment.',
	inputSchema: {
		pubkey: z
			.string()
			.min(32)
			.max(64)
			.optional()
			.describe("Base58 pubkey to read. Defaults to the configured signer's address."),
	},
	async handler(args) {
		const { pubkey } = args || {};
		// loadSigner() throws a clear `no_signer` error if neither a pubkey nor a
		// configured secret is available.
		const owner = pubkey || loadSigner().publicKey.toBase58();
		if (!isValidPubkey(owner)) {
			return { ok: false, error: 'invalid_pubkey' };
		}
		const config = await fetchTokenConfig();
		const [sol, three] = await Promise.all([
			getSolBalance(owner),
			getSplBalance(owner, config.mint),
		]);
		return {
			ok: true,
			pubkey: owner,
			symbol: config.symbol,
			three: {
				mint: config.mint,
				amount: three.uiAmount,
				atomics: three.atomics,
				decimals: three.decimals || config.decimals,
			},
			sol: sol.sol,
			lamports: sol.lamports,
			explorer: `https://solscan.io/account/${owner}`,
			fetchedAt: new Date().toISOString(),
		};
	},
};
