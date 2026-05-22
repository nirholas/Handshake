// `pump_buy` — buy any Solana SPL or pump.fun token via Jupiter.
//
// Two modes:
//   - direct (default): the buyer wallet pays its own fee + spends SOL.
//   - bundled (set jitoBundle=true with a funderSecret): two-tx Jito
//     bundle where the funder transfers SOL to the buyer + Jito tip in
//     Tx1 and the buyer signs the swap in Tx2. Use this if the buyer
//     wallet is shared/leaked and you must beat sweeper bots.
//
// EXECUTION ACTION — real swaps on Solana mainnet.

import { z } from 'zod';

import { isValidPubkey } from '../lib/solana.js';
import { jupiterBuyBundled, jupiterBuyDirect } from '../lib/jupiter-buy.js';
import { THREE_MINT } from '../config.js';

export const def = {
	name: 'pump_buy',
	title: 'Buy a Solana token via Jupiter (direct or Jito-bundled)',
	description:
		'Swap SOL → target mint via Jupiter aggregator. Direct mode = one tx signed by the buyer. Bundled mode (jitoBundle=true) = two-tx Jito bundle where funderSecret transfers SOL + tip to the buyer atomically with the swap (sweeper-resistant). Pass target="three" to use the $three reference mint. EXECUTION ACTION.',
	inputSchema: {
		target: z.string().describe('Target mint (base58) or "three" to use the THREE_MINT env.'),
		buySol: z.number().positive().describe('Amount of SOL to spend.'),
		buyerSecret: z.string().describe('Base58 secret of the buyer wallet (signs the swap).'),
		funderSecret: z.string().optional().describe('Base58 secret of the funder. Required when jitoBundle=true.'),
		jitoBundle: z.boolean().optional().describe('Use a Jito bundle (atomic funder→buyer transfer + swap). Default false.'),
		slippageBps: z.number().int().min(1).max(10_000).optional().describe('Slippage in basis points (default 500 = 5%).'),
		jitoTipSol: z.number().min(0).optional().describe('Jito tip in SOL (default 0.005). Only used when jitoBundle=true.'),
		priorityMicroLamports: z.number().int().min(0).max(20_000_000).optional()
			.describe('Compute-unit price (default 2_000_000).'),
	},
	async handler(args) {
		let target = args.target;
		if (target === 'three' || target === '$three') {
			if (!THREE_MINT) return { ok: false, error: 'three_mint_not_configured' };
			target = THREE_MINT;
		}
		if (!isValidPubkey(target)) return { ok: false, error: 'invalid_target' };
		try {
			if (args.jitoBundle) {
				if (!args.funderSecret) {
					return { ok: false, error: 'invalid_input', message: 'jitoBundle=true requires funderSecret.' };
				}
				const out = await jupiterBuyBundled({
					funderSecret: args.funderSecret,
					buyerSecret: args.buyerSecret,
					targetMint: target,
					buySol: args.buySol,
					slippageBps: args.slippageBps,
					jitoTipSol: args.jitoTipSol,
					priorityMicroLamports: args.priorityMicroLamports,
				});
				return out;
			}
			const out = await jupiterBuyDirect({
				buyerSecret: args.buyerSecret,
				targetMint: target,
				buySol: args.buySol,
				slippageBps: args.slippageBps,
				priorityMicroLamports: args.priorityMicroLamports,
			});
			return out;
		} catch (err) {
			return { ok: false, error: err.code || 'buy_failed', message: err.message };
		}
	},
};
