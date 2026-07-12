// GET /api/premium/plans — every premium tier, priced live in every accepted asset.
//
// Public and cacheable (60 s): the dashboard's pricing cards render from this.
// Three self-serve tiers (developer / pro / enterprise) differ on the enforced
// per-key rate limit and licensing; every tier is payable in $THREE (at the
// platform discount), SOL, or USDC on Solana. Each asset is priced
// independently and a down oracle marks only that asset unavailable — USDC is
// parity and can never fail, so there is always at least one payable rail.

import { cors, json, method, wrap } from '../_lib/http.js';
import { listPlans, priceAsset, PREMIUM_RESOURCES } from '../_lib/premium.js';
import { env } from '../_lib/env.js';

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS', origins: '*' })) return;
	if (!method(req, res, ['GET'])) return;

	const plans = await Promise.all(
		listPlans().map(async (plan) => {
			const assets = await Promise.all(
				['THREE', 'SOL', 'USDC'].map(async (asset) => {
					try {
						const p = await priceAsset(asset, plan);
						return {
							asset,
							available: true,
							usd: p.usd,
							amount_atomics: p.atomics.toString(),
							decimals: asset === 'SOL' ? 9 : 6,
							...(asset === 'THREE'
								? { mint: env.THREE_TOKEN_MINT, discount: plan.threeDiscount }
								: asset === 'USDC'
									? { mint: env.X402_ASSET_MINT_SOLANA }
									: {}),
						};
					} catch (e) {
						return { asset, available: false, reason: e.message };
					}
				}),
			);
			return {
				id: plan.id,
				tier: plan.tier,
				name: plan.name,
				usd: plan.usd,
				days: plan.days,
				rate_limit_per_minute: plan.rateLimitPerMinute,
				commercial: plan.commercial,
				blurb: plan.blurb,
				network: 'solana',
				assets,
			};
		}),
	);

	return json(
		res, 200,
		{
			plans,
			includes: {
				resources: PREMIUM_RESOURCES,
				summary:
					'Unmetered news-archive search at your tier’s rate limit via an x402_live_ API key ' +
					'or a wallet signature (SIWX) — no per-call payments while the pass is active. ' +
					'Pro and Enterprise include commercial use; Enterprise includes priority support ' +
					'and bulk corpus arrangements.',
			},
		},
		{ 'cache-control': 'public, max-age=60, s-maxage=60' },
	);
});
