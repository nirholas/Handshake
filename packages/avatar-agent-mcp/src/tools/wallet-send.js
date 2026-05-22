// `wallet_send` — send SOL from a signer to a destination pubkey. The
// signer comes from the `secret` arg (preferred) or from SOLANA_SECRET_KEY
// in the MCP server environment. Returns the on-chain signature and a
// Solscan link once confirmed.

import { z } from 'zod';

import { sendSol } from '../lib/solana.js';

export const def = {
	name: 'wallet_send',
	title: 'Send SOL on Solana mainnet',
	description:
		'Send SOL from the configured signer to a destination pubkey. The signer is supplied via the `secret` arg (base58) or via SOLANA_SECRET_KEY env on the MCP server. Returns the confirmed signature and a Solscan link. EXECUTION ACTION — funds move on mainnet.',
	inputSchema: {
		to: z.string().min(32).max(64).describe('Destination Solana pubkey.'),
		sol: z.number().positive().describe('Amount of SOL to send.'),
		secret: z.string().optional().describe('Base58 secret of the sender. Falls back to SOLANA_SECRET_KEY env.'),
		priorityMicroLamports: z.number().int().min(0).max(10_000_000).optional()
			.describe('Compute-unit price (default 100000).'),
	},
	async handler(args) {
		try {
			const out = await sendSol({
				secret: args.secret,
				to: args.to,
				sol: args.sol,
				priorityMicroLamports: args.priorityMicroLamports,
			});
			return { ok: true, ...out };
		} catch (err) {
			return { ok: false, error: err.code || 'send_failed', message: err.message, signature: err.signature || null };
		}
	},
};
