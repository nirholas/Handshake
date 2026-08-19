// `three_status`: what a deploy costs, why, and where the fee goes.
//
// One read that answers three questions at once:
//   • what will MY next deploy cost (live $THREE balance -> tier -> SOL)
//   • what is the fee schedule and which wallet receives it
//   • what has the $THREE buyback lane actually done (public ledger, real numbers)
//
// Everything here is live: the balance from Solana, the market and buyback
// figures from the public three.ws endpoint. Nothing is cached or synthesized;
// if the endpoint is unreachable the tool says so rather than inventing a number.

import { z } from 'zod';

import { NETWORK, SOLANA_DEFAULT_SECRET, THREE_MINT, THREE_WS_BASE } from '../config.js';
import { buildUmi } from '../lib/solana.js';
import { feeSchedule, resolveDeployFee, threeStats, THREE_STATS_URL } from '../lib/three.js';

export const def = {
	name: 'three_status',
	title: 'Deploy fee, $THREE holder tier, and the live buyback ledger',
	annotations: { readOnlyHint: true, idempotentHint: false, openWorldHint: true },
	description:
		'What the next on-chain deploy costs and why. Returns the deploy-fee schedule (a flat SOL fee on mainnet, ' +
		'free on devnet), the live $THREE balance of a wallet and the tier it earns (half price, then free), the ' +
		'wallet the fee is paid to, and the live $THREE market + buyback figures from the public three.ws ledger. ' +
		'Pass `wallet` to price a specific payer, or omit it to price the configured signer. Read-only: it moves ' +
		'nothing and needs no key.',
	inputSchema: {
		wallet: z.string().min(32).max(44).optional().describe('Price the deploy fee for this wallet. Defaults to the configured signer.'),
		network: z.enum(['mainnet', 'devnet']).optional().describe('Cluster. Defaults to the configured network. Devnet deploys are always free.'),
	},
	async handler(args) {
		const network = args.network || NETWORK;
		const umi = buildUmi({ network });

		let payer = args.wallet ? String(args.wallet).trim() : null;
		if (!payer && SOLANA_DEFAULT_SECRET) {
			payer = buildUmi({ network, requireSigner: true }).identity.publicKey.toString();
		}

		const [fee, stats] = await Promise.all([
			resolveDeployFee(umi, { network, payer }),
			threeStats().catch((err) => ({ error: err?.message || String(err) })),
		]);

		const schedule = feeSchedule();
		const priced = fee.three_tokens !== null && fee.three_tokens !== undefined;

		return {
			ok: true,
			network,
			mint: THREE_MINT,
			your_deploy: {
				wallet: payer,
				fee_sol: fee.sol,
				tier: fee.tier,
				three_balance: fee.three_tokens,
				note: fee.reason,
				...(fee.next_tier ? { next_tier: fee.next_tier } : {}),
				...(fee.three_balance_error ? { balance_error: fee.three_balance_error } : {}),
			},
			fee_schedule: {
				mainnet_sol: schedule.standard_sol,
				devnet_sol: 0,
				half_price_at_three: schedule.half_price_at_three,
				free_at_three: schedule.free_at_three,
				paid_to: schedule.fee_wallet,
				funds: schedule.funds,
				rides_on: 'the same transaction that creates the asset, so a failed mint pays nothing',
			},
			three: stats?.error ? { error: stats.error, source: THREE_STATS_URL } : stats?.token || null,
			buyback: stats?.error ? null : stats?.buyback || null,
			links: {
				ledger: THREE_STATS_URL,
				token_page: `${THREE_WS_BASE}/three`,
				chart: `https://dexscreener.com/solana/${THREE_MINT}`,
			},
			...(priced
				? {}
				: { hint: 'Pass `wallet` (or set SOLANA_SECRET_KEY) to price the fee against a real $THREE balance.' }),
		};
	},
};
