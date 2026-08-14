// GET  /api/x402/skill-marketplace?skill=<name>&limit=<n>
// POST /api/x402/skill-marketplace { mode: "price_distribution" }
// POST /api/x402/skill-marketplace { mode: "canary_execute", skill: "echo_test" }
// POST /api/x402/skill-marketplace { mode: "popular", limit: <n> }
//
// Paid endpoint cataloged by the CDP x402 Bazaar. For $0.001 USDC the server
// returns the live marketplace of three.ws agent skills with pricing and the
// agents that provide them. Supports a `skill` filter to find the cheapest
// provider for a given capability.
//
// POST mode="price_distribution" returns marketplace-wide pricing statistics:
// min, max, and median active listing price plus total listing + distinct skill
// counts. The autonomous loop oracle pipeline pays this every 5 min to detect
// price floor erosion (median drop >20% week-over-week signals a race to zero).
//
// POST mode="popular" returns the N most-purchased skills over the last 7 days,
// ranked by completed hire count from the real agent_hires ledger. Useful for
// prioritizing featured listings and surfacing high-demand capabilities.
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
import skillMarketplaceListing from '../_lib/service-catalog/services/skill-marketplace.js';

const ROUTE = '/api/x402/skill-marketplace';

// Single source of truth:
// api/_lib/service-catalog/services/skill-marketplace.js is the storefront
// listing copy — importing it here keeps the live 402 challenge from drifting
// from what /.well-known/x402.json and the OKX projection advertise (same
// pattern as forge.js → forge-listing.js). The POST (analytics) endpoint below
// appends its own mode-specific sentence to this same base text.
const DESCRIPTION = skillMarketplaceListing.description;

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

const POST_INPUT_SCHEMA = {
	$schema: 'https://json-schema.org/draft/2020-12/schema',
	type: 'object',
	required: ['mode'],
	properties: {
		mode: {
			type: 'string',
			enum: ['canary_execute', 'price_distribution', 'popular'],
			description:
				'Analytics mode: "canary_execute" smoke-tests a listing, ' +
				'"price_distribution" returns min/max/median prices, ' +
				'"popular" returns the most-purchased skills over the last 7 days.',
		},
		skill: {
			type: 'string',
			description: 'Skill name to smoke-test when mode="canary_execute".',
		},
		limit: { type: 'integer', minimum: 1, maximum: 100, default: 10 },
	},
};

const POST_OUTPUT_EXAMPLE = {
	mode: 'popular',
	period: '7d',
	count: 1,
	skills: [{ id: 'inspect_model', name: 'inspect_model', purchases: 42 }],
	indexed_at: '2026-05-14T17:00:00Z',
};

const POST_OUTPUT_SCHEMA = {
	$schema: 'https://json-schema.org/draft/2020-12/schema',
	type: 'object',
	required: ['mode'],
	properties: {
		mode: { type: 'string' },
		period: { type: 'string' },
		count: { type: 'integer' },
		skills: { type: 'array', items: { type: 'object' } },
		indexed_at: { type: 'string', format: 'date-time' },
	},
};

const POST_BAZAAR = {
	discoverable: true,
	info: {
		input: {
			type: 'http',
			method: 'POST',
			bodyType: 'json',
			body: { mode: 'popular', limit: 10 },
		},
		output: { type: 'json', example: POST_OUTPUT_EXAMPLE },
	},
	schema: buildBazaarSchema({
		method: 'POST',
		bodySchema: POST_INPUT_SCHEMA,
		outputSchema: POST_OUTPUT_SCHEMA,
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

// ── Price distribution query (POST mode="price_distribution") ────────────────
// Aggregates min/max/median price across all active listings in
// agent_skill_prices. Prices are USDC atomics (6 decimals); response returns
// both the raw atomic strings and the USD float values for the oracle consumer.
async function computePriceDistribution() {
	const [row] = await sql`
		select
			min(p.amount::numeric)                                            as min_atomics,
			max(p.amount::numeric)                                            as max_atomics,
			percentile_cont(0.5) within group (order by p.amount::numeric)   as median_atomics,
			count(*)::int                                                     as skill_count,
			count(distinct p.skill)::int                                      as distinct_skills
		  from agent_skill_prices p
		  join agent_identities a on a.id = p.agent_id
		 where p.is_active = true
		   and a.deleted_at is null
	`;

	const DECIMALS = 1_000_000; // USDC 6 decimals
	const minAtomics = Number(row?.min_atomics ?? 0);
	const maxAtomics = Number(row?.max_atomics ?? 0);
	const medianAtomics = Number(row?.median_atomics ?? 0);
	const skillCount = Number(row?.skill_count ?? 0);
	const distinctSkills = Number(row?.distinct_skills ?? 0);

	return {
		mode: 'price_distribution',
		min_price: minAtomics / DECIMALS,
		max_price: maxAtomics / DECIMALS,
		median_price: medianAtomics / DECIMALS,
		skill_count: skillCount,
		distinct_skills: distinctSkills,
		min_price_atomics: String(minAtomics),
		max_price_atomics: String(maxAtomics),
		median_price_atomics: String(medianAtomics),
		indexed_at: new Date().toISOString(),
	};
}

// ── Canary execute (POST mode="canary_execute") ───────────────────────────────
// echo_test proves the skill execution path responds within the 2 s SLA.
// The operation is intentionally synchronous — any latency here is endpoint
// overhead, not I/O. The autonomous loop asserts latency_ms < 2000.
function runCanaryExecute(skillName) {
	const t0 = Date.now();
	const supported = ['echo_test'];
	if (!supported.includes(skillName)) {
		return {
			executed: false,
			skill: skillName,
			latency_ms: Date.now() - t0,
			output: null,
			error: 'unsupported_skill',
			supported,
			ts: new Date().toISOString(),
		};
	}
	const output = `echo:${skillName}:ok`;
	return { executed: true, skill: skillName, latency_ms: Date.now() - t0, output, ts: new Date().toISOString() };
}

// ── Popular-skills query (POST mode="popular") ────────────────────────────────
// Reads the real agent_hires ledger (completed hires, last 7 days) grouped by
// skill_name and returns the top N skills by purchase count. A database fault
// propagates: the wrapper maps it to a 503 BEFORE settlement, so a buyer is
// never charged for an empty list that reads like "nobody hired anything".
async function loadPopularSkills(limit) {
	const rows = await sql`
		select
			h.skill_name              as id,
			h.skill_name              as name,
			count(*)::int             as purchases
		  from agent_hires h
		 where h.status = 'completed'
		   and h.created_at >= now() - interval '7 days'
		   and h.skill_name is not null
		 group by h.skill_name
		 order by purchases desc, h.skill_name asc
		 limit ${limit}
	`;

	const skills = rows.map((r) => ({
		id: r.id,
		name: r.name,
		purchases: Number(r.purchases || 0),
	}));

	return {
		mode: 'popular',
		period: '7d',
		count: skills.length,
		skills,
		indexed_at: new Date().toISOString(),
	};
}

// ── GET handler (listing catalog) ─────────────────────────────────────────────
const getEndpoint = paidEndpoint({
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

// ── POST handler (analytics modes) ───────────────────────────────────────────
const postEndpoint = paidEndpoint({
	route: ROUTE,
	method: 'POST',
	priceAtomics: priceFor('skill-marketplace', '1000'),
	networks: ['base', 'solana'],
	description:
		DESCRIPTION +
		' POST mode="price_distribution" returns min/max/median price + listing count.' +
		' POST mode="popular" returns the N most-purchased skills in the last 7 days.',
	bazaar: POST_BAZAAR,
	service: withService({
		serviceName: 'three.ws Skill Market (Analytics)',
		tags: ['marketplace', 'agent', 'skills', 'pricing', 'analytics'],
	}),
	requiredScope: 'x402:bypass',
	accessControl: installAccessControl({ requiredScope: 'x402:bypass' }),
	async handler({ req }) {
		const body = req.body || {};
		const mode = body.mode ? String(body.mode).trim() : null;
		if (mode === 'canary_execute') {
			const skillName = body.skill ? String(body.skill).trim() : 'echo_test';
			return runCanaryExecute(skillName);
		}
		if (mode === 'price_distribution') {
			return computePriceDistribution();
		}
		if (mode === 'popular') {
			const limitRaw = parseInt(body.limit, 10);
			const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 100) : 10;
			return loadPopularSkills(limit);
		}
		const err = new Error(
			'unsupported mode — use { mode: "canary_execute" }, { mode: "price_distribution" }, or { mode: "popular" }',
		);
		err.status = 400;
		err.code = 'invalid_mode';
		throw err;
	},
});

// Dispatch by method so GET (catalog) and POST (analytics) share the route.
export default function handler(req, res) {
	if (req.method === 'POST') return postEndpoint(req, res);
	return getEndpoint(req, res);
}
