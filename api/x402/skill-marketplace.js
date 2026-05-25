// GET /api/x402/skill-marketplace?skill=<name>&limit=<n>
//
// Paid endpoint cataloged by the CDP x402 Bazaar. For $0.001 USDC the server
// returns the live marketplace of three.ws agent skills with pricing and the
// agents that provide them. Supports a `skill` filter to find the cheapest
// provider for a given capability.
//
// Why this is defensible: the agent_skill_prices table is the canonical
// pricing index for everything three.ws agents charge for via the pump.fun
// agent-payments protocol. AI agents pay to shop the market and route work
// to the cheapest competent provider — saving real USDC vs. picking blindly.

import { paidEndpoint } from '../_lib/x402-paid-endpoint.js';
import { buildBazaarSchema } from '../_lib/x402-spec.js';
import { installAccessControl } from '../_lib/x402/access-control.js';
import { withService } from '../_lib/x402/bazaar-helpers.js';
import { sql } from '../_lib/db.js';
import { priceFor } from '../_lib/x402-prices.js';

const ROUTE = '/api/x402/skill-marketplace';

const DESCRIPTION =
	'three.ws Skill Marketplace — list active skill listings with pricing across ' +
	'all three.ws agents. Optionally filter by skill name to find the cheapest ' +
	'provider for a specific capability (e.g. inspect_model, render_avatar). ' +
	'Returns price atomics, chain, currency, trial offer, and time-pass terms ' +
	'when set by the agent owner. Use to route paid work to the cheapest agent.';

const INPUT_EXAMPLE = { skill: 'inspect_model', limit: 20 };

const INPUT_SCHEMA = {
	$schema: 'https://json-schema.org/draft/2020-12/schema',
	type: 'object',
	properties: {
		skill: {
			type: 'string',
			description: 'Filter to a specific skill name (e.g. "inspect_model"). Case-sensitive.',
		},
		limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
	},
};

const OUTPUT_EXAMPLE = {
	skill_filter: 'inspect_model',
	count: 2,
	cheapest: {
		agent_id: '7b9a4f30-2d11-4e2d-9d12-1cdb1f6a3a55',
		agent_name: 'Helios',
		skill: 'inspect_model',
		amount_atomics: '10000',
		mint_decimals: 6,
		currency_mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
		chain: 'solana',
	},
	listings: [
		{
			agent_id: '7b9a4f30-2d11-4e2d-9d12-1cdb1f6a3a55',
			agent_name: 'Helios',
			skill: 'inspect_model',
			amount_atomics: '10000',
			mint_decimals: 6,
			currency_mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
			chain: 'solana',
			trial_uses: 1,
			time_pass_hours: 24,
			time_pass_amount: '100000',
			updated_at: '2026-05-12T08:00:00Z',
		},
	],
	indexed_at: '2026-05-14T17:00:00Z',
};

const OUTPUT_SCHEMA = {
	$schema: 'https://json-schema.org/draft/2020-12/schema',
	type: 'object',
	required: ['count', 'listings'],
	properties: {
		skill_filter: { type: ['string', 'null'] },
		count: { type: 'integer' },
		cheapest: { type: ['object', 'null'] },
		listings: { type: 'array', items: { type: 'object' } },
		indexed_at: { type: 'string', format: 'date-time' },
	},
};

const BAZAAR = {
	discoverable: true,
	info: {
		input: {
			type: 'http',
			method: 'GET',
			queryParams: INPUT_EXAMPLE,
		},
		output: { type: 'json', example: OUTPUT_EXAMPLE },
	},
	schema: buildBazaarSchema({
		method: 'GET',
		queryParamsSchema: INPUT_SCHEMA,
		outputSchema: OUTPUT_SCHEMA,
	}),
};

function rowToListing(r) {
	return {
		agent_id: r.agent_id,
		agent_name: r.agent_name,
		skill: r.skill,
		amount_atomics: String(r.amount),
		mint_decimals: r.mint_decimals,
		currency_mint: r.currency_mint,
		chain: r.chain,
		trial_uses: r.trial_uses,
		time_pass_hours: r.time_pass_hours,
		time_pass_amount: r.time_pass_amount != null ? String(r.time_pass_amount) : null,
		updated_at: new Date(r.updated_at).toISOString(),
	};
}

async function loadListings({ skill, limit }) {
	const rows = skill
		? await sql`
			select
				p.agent_id,
				a.name as agent_name,
				p.skill,
				p.amount,
				p.mint_decimals,
				p.currency_mint,
				p.chain,
				p.trial_uses,
				p.time_pass_hours,
				p.time_pass_amount,
				p.updated_at
			  from agent_skill_prices p
			  join agent_identities a on a.id = p.agent_id
			 where p.is_active = true
			   and a.deleted_at is null
			   and p.skill = ${skill}
			 order by p.amount asc, p.updated_at desc
			 limit ${limit}
		`
		: await sql`
			select
				p.agent_id,
				a.name as agent_name,
				p.skill,
				p.amount,
				p.mint_decimals,
				p.currency_mint,
				p.chain,
				p.trial_uses,
				p.time_pass_hours,
				p.time_pass_amount,
				p.updated_at
			  from agent_skill_prices p
			  join agent_identities a on a.id = p.agent_id
			 where p.is_active = true
			   and a.deleted_at is null
			 order by p.updated_at desc
			 limit ${limit}
		`;

	const listings = rows.map(rowToListing);
	let cheapest = null;
	if (skill && listings.length) {
		cheapest = listings.reduce((best, cur) =>
			BigInt(cur.amount_atomics) < BigInt(best.amount_atomics) ? cur : best,
		);
	}
	return {
		skill_filter: skill || null,
		count: listings.length,
		cheapest,
		listings,
		indexed_at: new Date().toISOString(),
	};
}

export default paidEndpoint({
	route: ROUTE,
	method: 'GET',
	priceAtomics: priceFor('skill-marketplace', '1000'),
	networks: ['base', 'solana'],
	description: DESCRIPTION,
	bazaar: BAZAAR,
	service: withService({
		serviceName: 'three.ws Skill Market',
		tags: ['marketplace', 'agent', 'skills', 'pricing', 'discovery'],
	}),
	siwx: {
		statement: 'Sign in to refresh the three.ws skill marketplace without re-paying.',
		// 24h grant so a returning agent can re-poll without paying; after the
		// window expires they pay once more to keep the catalog "paid-fresh".
		ttlSeconds: 24 * 3600,
		expirationSeconds: 300,
	},
	requiredScope: 'x402:bypass',
	accessControl: installAccessControl({ requiredScope: 'x402:bypass' }),
	async handler({ req }) {
		const skill = req.query?.skill ? String(req.query.skill).trim() : null;
		const limitRaw = parseInt(req.query?.limit, 10);
		const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 200) : 50;
		return loadListings({ skill, limit });
	},
});
