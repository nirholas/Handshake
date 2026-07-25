// GET /api/x402/agent-reputation?subject=<any identifier>
//
// Cross-chain agent trust primitive, cataloged by the CDP x402 Bazaar. For $0.01
// USDC the server returns a deterministic 0–100 trust score for ANY counterparty
// an agent is about to transact with — regardless of which platform it was minted
// on. Pass a Solana wallet, an EVM wallet, a pump.fun mint, an ERC-8004 agent id,
// or a three.ws agent_id; the type is auto-detected and scored from the real
// on-chain evidence available for it.
//
// The use-case (a genuine pre-transaction primitive): before Agent A pays, trades,
// or delegates to Agent B, it calls this once to get B's trust score, tier, and
// the underlying evidence. Score is built from settled on-chain signals —
// transaction history, account age, distinct counterparties, holdings, settlement
// reliability, prior settled agent payments, and ERC-8004 feedback — never a
// subjective rating. Unknown/unscannable subjects return score:null, tier:'unknown'
// with an explicit caveat rather than a fabricated number.
//
// Why this is defensible: three.ws indexes every pump.fun agent-payments
// acceptPayment call (pump_agent_payments), every distributePayments cron run
// (pump_distribute_runs), and every signed Solana memo attestation
// (solana_attestations), and reads the ERC-8004 reputation registry and live
// Solana/EVM chain state on demand — one endpoint that scores across all of them.

import { paidEndpoint } from '../_lib/x402-paid-endpoint.js';
import { readBody } from '../_lib/http.js';
import { buildBazaarSchema } from '../_lib/x402-spec.js';
import { installAccessControl } from '../_lib/x402/access-control.js';
import { withService } from '../_lib/x402/bazaar-helpers.js';
import { priceFor } from '../_lib/x402-prices.js';
// The generalized any-subject engine — auto-detect + deterministic scoring.
import {
	loadSubjectReputation,
	scoreSubjectBatch,
	SUBJECT_TYPES,
} from '../_lib/trust/subject-reputation.js';
// Sweep / leaderboard / decay operate over the three.ws indexed active-agent set —
// the only globally-sweepable subject universe we maintain.
import {
	sweepAgentReputation,
	leaderboardAgentReputation,
	decayReportAgentReputation,
	REPUTATION_FLAG_THRESHOLD,
} from '../_lib/trust/solana-bouncer.js';
import agentReputationListing from '../_lib/service-catalog/services/agent-reputation.js';

const ROUTE = '/api/x402/agent-reputation';

// Single source of truth: api/_lib/service-catalog/services/agent-reputation.js
// is the storefront listing copy — importing it here keeps the live 402
// challenge from drifting from what /.well-known/x402.json and the OKX
// projection advertise (same pattern as forge.js → forge-listing.js).
const DESCRIPTION = agentReputationListing.description;

const INPUT_EXAMPLE = { subject: 'FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump' };

const INPUT_SCHEMA = {
	$schema: 'https://json-schema.org/draft/2020-12/schema',
	type: 'object',
	required: ['subject'],
	properties: {
		subject: {
			type: 'string',
			description:
				'Any counterparty identifier: a Solana wallet or mint, an EVM 0x address, ' +
				'an ERC-8004 agent id (bare integer or erc8004:<chainId>:<id>), or a ' +
				'three.ws agent_id (UUID). Type is auto-detected.',
		},
		chain: {
			type: ['integer', 'string'],
			description: 'EVM chain id for a bare EVM address or ERC-8004 agent id (default 8453 / Base).',
		},
	},
};

const OUTPUT_EXAMPLE = {
	subject: 'FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump',
	subjectType: 'solana_mint',
	score: 71,
	tier: 'high',
	signals: {
		dimensions: {
			activity: { available: true, weight: 25, norm: 0.62, points: 16, value: 124 },
			age: { available: true, weight: 15, norm: 0.48, points: 7, days: 176 },
			counterparties: { available: true, weight: 15, norm: 0.72, points: 11, value: 18 },
			holdings: { available: true, weight: 10, norm: 1, points: 10, usd: 412000 },
			reliability: { available: true, weight: 15, norm: 0.98, points: 15, failure_rate: 0.02 },
			attestations: { available: true, weight: 20, norm: 0.6, points: 12, count: 6, avg_feedback: null },
		},
		weight_considered: 100,
	},
	evidence: [
		{ kind: 'solana_token', ref: 'https://solscan.io/token/FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump' },
		{ kind: 'threews_agent', ref: '/agent/7b9a4f30-2d11-4e2d-9d12-1cdb1f6a3a55' },
	],
	caveats: [],
	ts: '2026-07-07T00:00:00Z',
};

const DIMENSION_SCHEMA = {
	type: 'object',
	properties: {
		available: { type: 'boolean' },
		weight: { type: 'number' },
		norm: { type: ['number', 'null'] },
		points: { type: 'number' },
	},
};

const OUTPUT_SCHEMA = {
	$schema: 'https://json-schema.org/draft/2020-12/schema',
	type: 'object',
	required: ['subject', 'subjectType', 'score', 'tier', 'signals', 'evidence', 'caveats', 'ts'],
	properties: {
		subject: { type: 'string' },
		subjectType: { type: 'string', enum: SUBJECT_TYPES },
		score: { type: ['integer', 'null'], minimum: 0, maximum: 100 },
		tier: { type: 'string', enum: ['unknown', 'low', 'medium', 'high', 'elite'] },
		signals: {
			type: 'object',
			properties: {
				dimensions: {
					type: 'object',
					properties: {
						activity: DIMENSION_SCHEMA,
						age: DIMENSION_SCHEMA,
						counterparties: DIMENSION_SCHEMA,
						holdings: DIMENSION_SCHEMA,
						reliability: DIMENSION_SCHEMA,
						attestations: DIMENSION_SCHEMA,
					},
				},
				weight_considered: { type: 'number' },
			},
		},
		evidence: {
			type: 'array',
			items: {
				type: 'object',
				properties: { kind: { type: 'string' }, ref: { type: 'string' } },
			},
		},
		caveats: { type: 'array', items: { type: 'string' } },
		ts: { type: 'string', format: 'date-time' },
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

const singleEndpoint = paidEndpoint({
	route: ROUTE,
	method: 'GET',
	priceAtomics: priceFor('agent-reputation', '10000'),
	networks: ['base', 'solana'],
	description: DESCRIPTION,
	bazaar: BAZAAR,
	service: withService({
		serviceName: 'Cross-chain Agent Reputation',
		tags: ['reputation', 'trust', 'cross-chain', 'agent', 'x402'],
	}),
	requiredScope: 'x402:bypass',
	accessControl: installAccessControl({ requiredScope: 'x402:bypass' }),
	// USE-21: declare auth-hints. Buyers with an OAuth2 access token granted
	// scope `read:agent-reputation` skip payment, as do wallets that present
	// a fresh CAIP-122 SIGN-IN-WITH-X proof for this resource. Without either,
	// the regular USDC accepts entries apply.
	authHints: {
		oauth2: { requiredScope: 'read:agent-reputation', tokenType: 'Bearer' },
		siwx: true,
	},
	async handler({ req }) {
		// Accept any counterparty identifier. `subject` is canonical; `agent_id` is
		// kept as an alias so existing three.ws-agent callers don't break.
		const subject = String(req.query?.subject || req.query?.agent_id || '').trim();
		if (!subject) {
			const err = new Error('query param "subject" is required');
			err.status = 400;
			err.code = 'missing_subject';
			throw err;
		}
		return loadSubjectReputation(subject, { chain: req.query?.chain });
	},
});

// ── Sweep mode (POST) ────────────────────────────────────────────────────────
// A single $0.01 call returns scored reputation for the N most recently active
// three.ws agents instead of one. Built for fleet-level trust monitoring: a
// vetting agent (or our own autonomous loop) gets the live average trust score
// and the set of low-reputation agents (score < REPUTATION_FLAG_THRESHOLD)
// flagged for review, without paying per agent.

const SWEEP_DEFAULT_LIMIT = 20;
const SWEEP_MAX_LIMIT = 50;
const LEADERBOARD_DEFAULT_LIMIT = 10;

const BATCH_MAX_SUBJECTS = 25;

const SWEEP_DESCRIPTION =
	'Cross-chain Agent Reputation (Batch / Sweep / Leaderboard / Decay) — ' +
	'POST {"mode":"batch","subjects":[...]} to score up to 25 arbitrary counterparties ' +
	'(any wallet / mint / agent id, any chain) in one paid call. ' +
	'POST {"mode":"sweep","limit":N} to score the N most recently active three.ws agents. ' +
	'POST {"mode":"leaderboard","limit":N} to get the top N agents ranked by trust score (highest first). ' +
	'POST {"mode":"decay_report"} to get agents whose score dropped >10 points since the last snapshot. ' +
	`Sweep: fleet avg score + flagged agents (score < ${REPUTATION_FLAG_THRESHOLD}). ` +
	'Leaderboard: ranked list with { agent_id, score, rank }. ' +
	'Decay report: decayed_count, fastest_decline_agent, avg_decay. ' +
	'All scores are derived from real on-chain evidence — not subjective ratings.';

const SWEEP_INPUT_EXAMPLE = { mode: 'sweep', limit: 20 };

const SWEEP_INPUT_SCHEMA = {
	$schema: 'https://json-schema.org/draft/2020-12/schema',
	type: 'object',
	properties: {
		mode: {
			type: 'string',
			enum: ['batch', 'sweep', 'leaderboard', 'decay_report'],
			description:
				'"batch" scores an arbitrary subjects[] list; "sweep" scores recent three.ws agents; ' +
				'"leaderboard" ranks by score desc; "decay_report" finds score declines >10 pts.',
		},
		limit: {
			type: 'integer',
			minimum: 1,
			maximum: SWEEP_MAX_LIMIT,
			description: `Agents to sweep/rank (sweep mode default ${SWEEP_DEFAULT_LIMIT}, leaderboard default ${LEADERBOARD_DEFAULT_LIMIT}, max ${SWEEP_MAX_LIMIT}).`,
		},
		subjects: {
			type: 'array',
			items: { type: 'string' },
			maxItems: BATCH_MAX_SUBJECTS,
			description: `batch mode: up to ${BATCH_MAX_SUBJECTS} counterparty identifiers to score (any chain, auto-detected).`,
		},
		chain: {
			type: ['integer', 'string'],
			description: 'batch mode: default EVM chain id for bare EVM / ERC-8004 subjects (default 8453).',
		},
	},
};

const SWEEP_OUTPUT_EXAMPLE = {
	mode: 'sweep',
	count: 20,
	avg_score: 64,
	flagged_count: 3,
	flagged: [
		{
			agent_id: '7b9a4f30-2d11-4e2d-9d12-1cdb1f6a3a55',
			name: 'Newcomer',
			score: 12,
			reasons: ['no confirmed payments on record', 'no signed attestations'],
		},
	],
	agents: [
		{
			agent_id: '7b9a4f30-2d11-4e2d-9d12-1cdb1f6a3a55',
			name: 'Helios',
			wallet_address: 'THREEsynthetic1111111111111111111111111PayTo',
			deployed_mints: 2,
			score: 88,
			flagged: false,
			reasons: [],
			breakdown: { payments: 40, distributions: 14, buybacks: 15, attestations: 19 },
			last_active_at: '2026-06-26T17:00:00Z',
		},
	],
	swept_at: '2026-06-27T17:00:00Z',
};

const SWEEP_OUTPUT_SCHEMA = {
	$schema: 'https://json-schema.org/draft/2020-12/schema',
	type: 'object',
	required: ['mode', 'count', 'avg_score', 'flagged_count', 'agents'],
	properties: {
		mode: { type: 'string', enum: ['sweep'] },
		count: { type: 'integer', minimum: 0 },
		avg_score: { type: 'integer', minimum: 0, maximum: 100 },
		flagged_count: { type: 'integer', minimum: 0 },
		flagged: {
			type: 'array',
			items: {
				type: 'object',
				properties: {
					agent_id: { type: 'string', format: 'uuid' },
					name: { type: ['string', 'null'] },
					score: { type: 'integer', minimum: 0, maximum: 100 },
					reasons: { type: 'array', items: { type: 'string' } },
				},
			},
		},
		agents: {
			type: 'array',
			items: {
				type: 'object',
				properties: {
					agent_id: { type: 'string', format: 'uuid' },
					name: { type: ['string', 'null'] },
					wallet_address: { type: ['string', 'null'] },
					deployed_mints: { type: 'integer', minimum: 0 },
					score: { type: 'integer', minimum: 0, maximum: 100 },
					flagged: { type: 'boolean' },
					reasons: { type: 'array', items: { type: 'string' } },
					breakdown: { type: 'object' },
					last_active_at: { type: ['string', 'null'] },
				},
			},
		},
		swept_at: { type: 'string', format: 'date-time' },
	},
};

const SWEEP_BAZAAR = {
	discoverable: true,
	info: {
		input: {
			type: 'http',
			method: 'POST',
			bodyType: 'json',
			body: SWEEP_INPUT_EXAMPLE,
		},
		output: { type: 'json', example: SWEEP_OUTPUT_EXAMPLE },
	},
	schema: buildBazaarSchema({
		method: 'POST',
		bodySchema: SWEEP_INPUT_SCHEMA,
		outputSchema: SWEEP_OUTPUT_SCHEMA,
	}),
};

// Read + parse the JSON body off the raw request stream (same idiom as the
// other POST x402 endpoints — req.body is not pre-parsed in this runtime).
async function readJsonBody(req) {
	const chunks = [await readBody(req, 1_000_000)];
	if (!chunks.length) return {};
	return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

const sweepEndpoint = paidEndpoint({
	route: ROUTE,
	method: 'POST',
	priceAtomics: priceFor('agent-reputation', '10000'),
	networks: ['base', 'solana'],
	description: SWEEP_DESCRIPTION,
	bazaar: SWEEP_BAZAAR,
	service: withService({
		serviceName: 'Agent Reputation (Batch / Sweep)',
		tags: ['reputation', 'trust', 'cross-chain', 'agent', 'monitoring'],
	}),
	requiredScope: 'x402:bypass',
	accessControl: installAccessControl({ requiredScope: 'x402:bypass' }),
	authHints: {
		oauth2: { requiredScope: 'read:agent-reputation', tokenType: 'Bearer' },
		siwx: true,
	},
	async handler({ req }) {
		let body;
		try {
			body = await readJsonBody(req);
		} catch {
			const err = new Error('request body must be valid JSON');
			err.status = 400;
			err.code = 'invalid_json';
			throw err;
		}
		if (body.mode === 'batch') {
			if (!Array.isArray(body.subjects) || body.subjects.length === 0) {
				const err = new Error('batch mode requires a non-empty subjects[] array');
				err.status = 400;
				err.code = 'invalid_subjects';
				throw err;
			}
			if (body.subjects.length > BATCH_MAX_SUBJECTS) {
				const err = new Error(`subjects[] is limited to ${BATCH_MAX_SUBJECTS} per call`);
				err.status = 400;
				err.code = 'too_many_subjects';
				throw err;
			}
			const results = await scoreSubjectBatch(body.subjects, { chain: body.chain });
			const scored = results.filter((r) => r.score != null);
			const avg = scored.length
				? Math.round(scored.reduce((s, r) => s + r.score, 0) / scored.length)
				: null;
			return {
				mode: 'batch',
				count: results.length,
				scored_count: scored.length,
				unknown_count: results.length - scored.length,
				avg_score: avg,
				subjects: results,
				generated_at: new Date().toISOString(),
			};
		}
		if (body.mode === 'decay_report') {
			return decayReportAgentReputation();
		}
		if (body.mode === 'leaderboard') {
			const limit = body.limit == null ? LEADERBOARD_DEFAULT_LIMIT : Number(body.limit);
			if (!Number.isFinite(limit) || limit < 1) {
				const err = new Error('limit must be a positive integer');
				err.status = 400;
				err.code = 'invalid_limit';
				throw err;
			}
			return leaderboardAgentReputation({ limit: Math.min(SWEEP_MAX_LIMIT, Math.floor(limit)) });
		}
		if (body.mode !== 'sweep') {
			const err = new Error('mode must be "batch", "sweep", "leaderboard", or "decay_report"');
			err.status = 400;
			err.code = 'invalid_mode';
			throw err;
		}
		const limit = body.limit == null ? SWEEP_DEFAULT_LIMIT : Number(body.limit);
		if (!Number.isFinite(limit) || limit < 1) {
			const err = new Error('limit must be a positive integer');
			err.status = 400;
			err.code = 'invalid_limit';
			throw err;
		}
		return sweepAgentReputation({ limit: Math.min(SWEEP_MAX_LIMIT, Math.floor(limit)) });
	},
});

// Route by method so one path serves both the single-agent lookup (GET) and the
// active-agent sweep (POST). OPTIONS preflight is dispatched by the requested
// method so each mode advertises the correct Access-Control-Allow-Methods.
export default function agentReputationRouter(req, res) {
	const method = String(req.method || 'GET').toUpperCase();
	if (method === 'POST') return sweepEndpoint(req, res);
	if (method === 'OPTIONS') {
		const requested = String(req.headers['access-control-request-method'] || '').toUpperCase();
		return requested === 'POST' ? sweepEndpoint(req, res) : singleEndpoint(req, res);
	}
	return singleEndpoint(req, res);
}
