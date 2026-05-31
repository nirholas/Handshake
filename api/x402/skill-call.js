// GET /api/x402/skill-call?skill=<slug>
//
// Per-call x402 gate for marketplace skills. Each priced skill in the
// marketplace_skills catalog charges `price_per_call_usd` per invocation. This
// endpoint meters that: a caller pays the skill's per-call price in USDC (Base
// or Solana) and receives the skill's executable payload — its tool schema and
// content — so the calling agent can run it. Settlement routes straight to the
// skill author's wallet, so authors earn per call.
//
// Unlike /api/x402/asset-download (buy-once, re-download free via SIWX), this
// is genuinely per-call: there is no SIWX re-access grant, so every invocation
// is a fresh payment. That matches the per-call pricing model the catalog
// advertises and the royalty semantics in api/_lib/skill-runtime.js.
//
// Built per-request like asset-download: the slug selects the row, which
// dictates price + author payout; everything else is shared. Free skills
// (price_per_call_usd = 0) are rejected with 409 — fetch those for free via
// /api/skills/:id.

import { paidEndpoint } from '../_lib/x402-paid-endpoint.js';
import { buildBazaarSchema } from '../_lib/x402-spec.js';
import { withService } from '../_lib/x402/bazaar-helpers.js';
import { priceFor } from '../_lib/x402-prices.js';
import { sql } from '../_lib/db.js';
import { error } from '../_lib/http.js';
import { env } from '../_lib/env.js';

const ROUTE = '/api/x402/skill-call';

const DESCRIPTION =
	'three.ws Skill Call — pay the per-call price of a marketplace skill in USDC ' +
	'(Base or Solana) and receive its executable payload: the tool schema and ' +
	'content the calling agent runs. Payment settles straight to the skill ' +
	"author's wallet, so authors earn on every call. Per-call pricing — every " +
	'invocation is a fresh payment (no free re-access).';

const INPUT_EXAMPLE = { skill: 'wallet-balance' };

const INPUT_SCHEMA = {
	$schema: 'https://json-schema.org/draft/2020-12/schema',
	type: 'object',
	required: ['skill'],
	properties: {
		skill: {
			type: 'string',
			description: 'Unique skill slug from the marketplace_skills catalog.',
			minLength: 1,
			maxLength: 128,
		},
	},
};

const OUTPUT_EXAMPLE = {
	ok: true,
	skill: {
		id: 'fc504e4a-6667-4757-9157-2bcc35434e6c',
		slug: 'wallet-balance',
		name: 'Wallet Balance',
		description: 'Check ETH and ERC-20 token balances for any Ethereum address.',
		category: 'crypto',
	},
	tools: [{ type: 'function', function: { name: 'get_balance', description: 'Fetch balances.' } }],
	content: '# Wallet Balance\n\nUse get_balance to fetch ...',
	calledAt: '2026-05-31T18:48:09.000Z',
};

const OUTPUT_SCHEMA = {
	$schema: 'https://json-schema.org/draft/2020-12/schema',
	type: 'object',
	required: ['ok', 'skill', 'calledAt'],
	properties: {
		ok: { type: 'boolean', const: true },
		skill: {
			type: 'object',
			required: ['id', 'slug', 'name'],
			properties: {
				id: { type: 'string' },
				slug: { type: 'string' },
				name: { type: 'string' },
				description: { type: 'string' },
				category: { type: 'string' },
			},
		},
		tools: { type: 'array', items: { type: 'object' } },
		content: { type: 'string' },
		calledAt: { type: 'string', format: 'date-time' },
	},
};

const BAZAAR = {
	discoverable: true,
	info: {
		input: { type: 'http', method: 'GET', queryParams: INPUT_EXAMPLE },
		output: { type: 'json', example: OUTPUT_EXAMPLE },
	},
	schema: buildBazaarSchema({
		method: 'GET',
		queryParamsSchema: INPUT_SCHEMA,
		outputSchema: OUTPUT_SCHEMA,
	}),
};

// Load the priced skill row plus the author's primary payout wallets. A skill
// with no author (system seed) or no linked wallet falls back to the platform
// receiver via env — the call still works, the platform collects.
async function loadSkill(slug) {
	const rows = await sql`
		SELECT ms.id, ms.slug, ms.name, ms.description, ms.category,
		       ms.schema_json, ms.content, ms.price_per_call_usd, ms.author_id,
		       evm.address  AS author_payto_base,
		       sol.address  AS author_payto_solana
		  FROM marketplace_skills ms
		  LEFT JOIN user_wallets evm
		         ON evm.user_id = ms.author_id
		        AND evm.chain_type = 'evm' AND evm.is_primary = true
		  LEFT JOIN user_wallets sol
		         ON sol.user_id = ms.author_id
		        AND sol.chain_type = 'solana' AND sol.is_primary = true
		 WHERE ms.slug = ${slug} AND ms.is_public = true
		 LIMIT 1
	`;
	return rows[0] || null;
}

// USD (price_per_call_usd) → USDC atomics (6 decimals). Floor at 1 atomic so a
// priced skill can never be free; the no-payment 0-price case is handled before
// we ever reach this.
function usdToAtomics(usd) {
	return String(Math.max(1, Math.round(Number(usd) * 1_000_000)));
}

export default async function handler(req, res) {
	const slug = req.query?.skill ? String(req.query.skill).trim() : '';
	if (!slug) {
		return error(res, 400, 'skill_required', 'query parameter "skill" is required');
	}

	let skill;
	try {
		skill = await loadSkill(slug);
	} catch (err) {
		return error(res, 502, 'skill_lookup_failed', err.message);
	}
	if (!skill) {
		return error(res, 404, 'skill_not_found', `no public skill with slug "${slug}"`);
	}
	if (!(Number(skill.price_per_call_usd) > 0)) {
		return error(
			res,
			409,
			'skill_not_priced',
			`skill "${slug}" is free — fetch it without payment via /api/skills/${skill.id}`,
		);
	}

	// Author payout overrides. Only set a network when the author has a wallet
	// for it; missing networks fall back to the platform receiver in env so the
	// endpoint still settles. Advertise only the networks we can actually route.
	const payTo = {};
	if (skill.author_payto_base) payTo.base = skill.author_payto_base;
	if (skill.author_payto_solana) payTo.solana = skill.author_payto_solana;
	const networks = [];
	if (payTo.base) networks.push('base');
	if (payTo.solana) networks.push('solana');
	if (!networks.length) networks.push('base', 'solana'); // platform fallback

	const priceAtomics = priceFor(`skill-call-${slug}`, usdToAtomics(skill.price_per_call_usd));

	const inner = paidEndpoint({
		route: ROUTE,
		method: 'GET',
		priceAtomics,
		networks,
		description: `${DESCRIPTION} — currently metering: ${skill.name}.`,
		mimeType: 'application/json',
		bazaar: BAZAAR,
		service: withService({
			serviceName: 'three.ws Skill Call',
			tags: ['skill', 'agent', 'tool', 'pay-per-call'],
		}),
		payTo: Object.keys(payTo).length ? payTo : undefined,
		// Per-call resource key so payment-identifier idempotency and audit logs
		// attribute to the specific skill being called.
		resourceUrlBuilder: () => `${env.APP_ORIGIN}${ROUTE}?skill=${encodeURIComponent(skill.slug)}`,
		async handler() {
			return {
				ok: true,
				skill: {
					id: skill.id,
					slug: skill.slug,
					name: skill.name,
					description: skill.description ?? '',
					category: skill.category ?? 'general',
				},
				tools: Array.isArray(skill.schema_json) ? skill.schema_json : [],
				content: skill.content ?? '',
				calledAt: new Date().toISOString(),
			};
		},
	});

	return inner(req, res);
}
