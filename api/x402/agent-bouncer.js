// GET /api/x402/agent-bouncer?agent_id=<uuid>&min_payments=&min_distinct_payers=&max_failure_rate=
//
// The Pole Club's door bouncer, opened up to the whole platform's Solana
// reputation.
//
// The Club's door (/api/x402/club-cover) decides admission from a wallet's club
// history alone — so it only knows what happened at our venue. This endpoint
// answers the SAME question — "should I engage this agent?" — from every Solana
// signal three.ws indexes about a three.ws agent: confirmed on-chain payments
// and distinct payers (pump_agent_payments), distribute/buyback follow-through,
// signed Solana memo attestations (solana_attestations), and the Club's own
// ban/tip ledger. It returns an admit/refuse verdict with a door tier
// (newcomer / regular / trusted / vip).
//
// This is the DECISION, not the data: /api/x402/agent-reputation returns the raw
// snapshot; this returns a policy verdict over it. "x402 handles how agents pay;
// reputation handles whether they should" — this is the second half, as a
// service any agent can call before paying, hiring, or delegating to a peer.

import { paidEndpoint } from '../_lib/x402-paid-endpoint.js';
import { buildBazaarSchema } from '../_lib/x402-spec.js';
import { installAccessControl } from '../_lib/x402/access-control.js';
import { withService } from '../_lib/x402/bazaar-helpers.js';
import { priceFor } from '../_lib/x402-prices.js';
import { isUuid } from '../_lib/validate.js';
import { vetSolanaAgent } from '../_lib/trust/solana-bouncer.js';
import agentBouncerListing from '../_lib/service-catalog/services/agent-bouncer.js';

const ROUTE = '/api/x402/agent-bouncer';

// Single source of truth: api/_lib/service-catalog/services/agent-bouncer.js is
// the storefront listing copy — importing it here keeps the live 402 challenge
// from drifting from what /.well-known/x402.json and the OKX projection
// advertise (same pattern as forge.js → forge-listing.js).
const DESCRIPTION = agentBouncerListing.description;

const INPUT_EXAMPLE = {
	agent_id: '7b9a4f30-2d11-4e2d-9d12-1cdb1f6a3a55',
	min_payments: 10,
	min_distinct_payers: 3,
	max_failure_rate: 0.2,
};

const INPUT_SCHEMA = {
	$schema: 'https://json-schema.org/draft/2020-12/schema',
	type: 'object',
	required: ['agent_id'],
	properties: {
		agent_id: {
			type: 'string',
			format: 'uuid',
			description: 'three.ws agent_id (UUID). Returned by /api/agents and /api/agent-page.',
		},
		min_payments: {
			type: 'integer',
			minimum: 0,
			description: 'Required confirmed on-chain payments to admit (default 0).',
		},
		min_distinct_payers: {
			type: 'integer',
			minimum: 0,
			description: 'Required distinct paying wallets (default 0).',
		},
		max_failure_rate: {
			type: 'number',
			minimum: 0,
			maximum: 1,
			description: 'Maximum tolerated payment failure rate, 0–1 (default 1 = no cap).',
		},
		min_attestations: {
			type: 'integer',
			minimum: 0,
			description: 'Required signed Solana attestations (feedback + validation; default 0).',
		},
		allow_newcomers: {
			type: 'boolean',
			description: 'Admit agents with no Solana track record (default true).',
		},
	},
};

const OUTPUT_EXAMPLE = {
	ok: true,
	admitted: true,
	banned: false,
	tier: 'trusted',
	reason: null,
	newcomer: false,
	agent_id: '7b9a4f30-2d11-4e2d-9d12-1cdb1f6a3a55',
	name: 'Helios',
	wallet_address: 'THREEsynthetic1111111111111111111111111PayTo',
	visits: 4,
	reputation: {
		deployed_mints: 2,
		payments: {
			confirmed_count: 142,
			confirmed_amount_atomics: '142000000',
			distinct_payers: 87,
			failed_count: 3,
			failure_rate: 0.021,
		},
		distributions: { confirmed: 12, failed: 1, success_rate: 0.923 },
		buybacks: { confirmed: 5, failed: 0, total_burn_atomics: '500000000' },
		attestations: { feedback_count: 14, validation_count: 8, latest_attested_at: '2026-05-12T08:21:00Z' },
	},
	policy: {
		minPayments: 10,
		minDistinctPayers: 3,
		maxFailureRate: 0.2,
		minAttestations: 0,
		allowNewcomers: true,
	},
	fetchedAt: '2026-06-22T17:00:00.000Z',
};

const OUTPUT_SCHEMA = {
	$schema: 'https://json-schema.org/draft/2020-12/schema',
	type: 'object',
	required: ['ok', 'exists', 'admitted', 'banned', 'tier', 'agent_id', 'reputation'],
	properties: {
		ok: { type: 'boolean', const: true },
		exists: {
			type: 'boolean',
			description:
				'false when no agent is registered under this id. The call still returns a verdict (never admitted, tier "unknown", reputation null) rather than an error, so a buyer vetting an unknown counterparty gets the answer they paid for.',
		},
		admitted: { type: 'boolean', description: 'true when the agent clears the policy and is not banned.' },
		banned: { type: 'boolean', description: 'true when the agent’s wallet is on the Club ban list.' },
		tier: {
			type: 'string',
			enum: ['unknown', 'newcomer', 'regular', 'trusted', 'vip', 'banned'],
			description:
				'Door tier earned from the agent’s Solana track record. "unknown" means no agent is registered under this id.',
		},
		reason: { type: ['string', 'null'], description: 'Primary reason when refused; null when admitted.' },
		reasons: { type: 'array', items: { type: 'string' } },
		newcomer: { type: 'boolean', description: 'true when the agent has no Solana history yet.' },
		agent_id: { type: 'string', format: 'uuid' },
		name: { type: ['string', 'null'] },
		wallet_address: { type: ['string', 'null'] },
		visits: { type: 'integer', minimum: 0, description: 'Prior settled club tips by this agent’s wallet.' },
		reputation: { type: ['object', 'null'], description: 'null when exists is false.' },
		policy: { type: 'object' },
		fetchedAt: { type: 'string', format: 'date-time' },
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

export const BAZAAR_SCHEMA = BAZAAR;

function badRequest(message, code) {
	const err = new Error(message);
	err.status = 400;
	err.code = code;
	return err;
}

function parseRate(raw, field) {
	if (raw === undefined || raw === null || raw === '') return null;
	const n = Number(raw);
	if (!Number.isFinite(n) || n < 0 || n > 1) {
		throw badRequest(`${field} must be a number between 0 and 1`, 'invalid_policy');
	}
	return n;
}

function parseCount(raw, field) {
	if (raw === undefined || raw === null || raw === '') return 0;
	const n = Number(raw);
	if (!Number.isInteger(n) || n < 0) throw badRequest(`${field} must be a non-negative integer`, 'invalid_policy');
	return n;
}

export default paidEndpoint({
	route: ROUTE,
	method: 'GET',
	priceAtomics: priceFor('agent-bouncer', '10000'), // $0.01 USDC
	networks: ['solana', 'base'],
	description: DESCRIPTION,
	bazaar: BAZAAR,
	service: withService({
		serviceName: 'three.ws Agent Bouncer',
		tags: ['reputation', 'trust', 'gate', 'agent', 'solana'],
	}),
	requiredScope: 'x402:bypass',
	accessControl: installAccessControl({ requiredScope: 'x402:bypass' }),
	// Buyers with a granted OAuth scope or a fresh SIWX proof skip payment; the
	// USDC accepts apply otherwise — same posture as agent-reputation.
	authHints: {
		oauth2: { requiredScope: 'read:agent-reputation', tokenType: 'Bearer' },
		siwx: true,
	},
	async handler({ req }) {
		const q = req.query || {};
		const agentId = String(q.agent_id || '').trim().toLowerCase();
		if (!agentId) throw badRequest('query param "agent_id" is required', 'missing_agent_id');
		if (!isUuid(agentId)) throw badRequest('agent_id must be a UUID', 'invalid_agent_id');

		const maxFailureRate = parseRate(q.max_failure_rate, 'max_failure_rate');
		const policy = {
			minPayments: parseCount(q.min_payments, 'min_payments'),
			minDistinctPayers: parseCount(q.min_distinct_payers, 'min_distinct_payers'),
			maxFailureRate: maxFailureRate === null ? 1 : maxFailureRate,
			minAttestations: parseCount(q.min_attestations, 'min_attestations'),
			allowNewcomers: q.allow_newcomers === undefined ? true : q.allow_newcomers !== 'false',
		};

		// An identifier with no registered agent behind it is a real, useful
		// answer for a door check ("no record, do not admit"), not an error. It
		// used to 404, which meant a buyer who had already paid $0.01 to vet an
		// unknown counterparty got an error instead of the verdict they bought,
		// and the ring canary (RING_CANARY_UUID, documented in ring-catalog.js as
		// returning "a truthful newcomer / not verified verdict rather than 404")
		// failed 31 times a day. Nothing is fabricated: every reputation field is
		// null/zero and `exists: false` says plainly that we hold no record.
		let verdict;
		try {
			verdict = await vetSolanaAgent({ agentId, policy });
		} catch (err) {
			if (err?.code !== 'agent_not_found') throw err;
			return {
				ok: true,
				exists: false,
				// Never admitted: allow_newcomers covers a REGISTERED agent with no
				// track record, not an id we cannot resolve at all.
				admitted: false,
				banned: false,
				tier: 'unknown',
				reason: 'no agent registered under this id',
				reasons: ['no agent registered under this id'],
				newcomer: true,
				agent_id: agentId,
				name: null,
				wallet_address: null,
				visits: 0,
				reputation: null,
				policy,
				fetchedAt: new Date().toISOString(),
			};
		}

		return {
			exists: true,
			ok: true,
			admitted: verdict.admitted,
			banned: verdict.banned,
			tier: verdict.tier,
			reason: verdict.reason,
			reasons: verdict.reasons,
			newcomer: verdict.newcomer,
			agent_id: verdict.agent_id,
			name: verdict.name,
			wallet_address: verdict.wallet_address,
			visits: verdict.visits,
			reputation: verdict.reputation,
			policy,
			fetchedAt: new Date().toISOString(),
		};
	},
});
