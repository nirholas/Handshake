// POST /api/x402/spend-session
//
// Spend Session endpoint — two modes, one $0.01 USDC x402 payment.
//
// mode:"audit" — aggregate snapshot of all agent payment-session health:
//   active count, remaining budget, spent totals, expired in last 24h.
//   The autonomous loop uses this to detect session cleanup failures.
//
// mode:"canary" — governance-layer health check (USE-065). Creates a canary
//   row in spend_session_health_log, immediately marks it consumed, and
//   returns { created, consumed, latency_ms }. The x402 payment proves the
//   settlement path; the create+consume cycle proves the session DB path.
//   A created:false or consumed:false is a governance-layer alert.
//
// Body: { "mode": "audit" | "canary", "budget": <number> }
// Response 200: see mode-specific output below.

import { randomUUID } from 'node:crypto';
import { readBody } from '../_lib/http.js';
import { paidEndpoint } from '../_lib/x402-paid-endpoint.js';
import { buildBazaarSchema } from '../_lib/x402-spec.js';
import { installAccessControl } from '../_lib/x402/access-control.js';
import { withService } from '../_lib/x402/bazaar-helpers.js';
import { priceFor } from '../_lib/x402-prices.js';
import { sql } from '../_lib/db.js';

const ROUTE = '/api/x402/spend-session';

const DESCRIPTION =
	'three.ws Spend Session Health — pay $0.01 USDC to probe the Agent Payment ' +
	'Sessions governance layer. mode:"canary" creates a canary session row and ' +
	'immediately consumes it, returning { created, consumed, latency_ms } — the ' +
	'most important health check for the x402 governance layer. mode:"audit" returns ' +
	'a live aggregate snapshot of all payment sessions (active count, remaining ' +
	'budget, expired_count_24h). Pay-per-call in USDC on Solana mainnet.';

const INPUT_EXAMPLE = { mode: 'canary', budget: 0.01 };

const INPUT_SCHEMA = {
	$schema: 'https://json-schema.org/draft/2020-12/schema',
	type: 'object',
	properties: {
		mode: {
			type: 'string',
			enum: ['canary', 'audit'],
			default: 'canary',
			description:
				'"canary" — create+consume cycle health check. ' +
				'"audit" — aggregate session health snapshot.',
		},
		budget: {
			type: 'number',
			minimum: 0,
			description: 'Requested session budget in USD (informational in canary mode).',
		},
	},
};

const OUTPUT_EXAMPLE = {
	ok: true,
	mode: 'canary',
	created: true,
	consumed: true,
	reason: null,
	latency_ms: 12,
	session_id: 'a3f3d6c2-1f1b-4f10-9b6c-1b1f5e0c9c34',
	budget: 0.01,
	payer: 'wwwPqsM4N7T9J69tB82nLyzxqsH159j4orftLTQfUGV',
	network: 'solana',
	amountAtomics: '10000',
	asset: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
};

const OUTPUT_SCHEMA = {
	$schema: 'https://json-schema.org/draft/2020-12/schema',
	type: 'object',
	required: ['ok', 'mode'],
	properties: {
		ok: { type: 'boolean', const: true },
		mode: { type: 'string', enum: ['canary', 'audit'] },
		// canary fields
		created: { type: 'boolean', description: 'Canary: DB INSERT succeeded.' },
		consumed: { type: 'boolean', description: 'Canary: DB UPDATE (consume) succeeded.' },
		reason: { type: ['string', 'null'], description: 'Canary: why created/consumed is false; null when the cycle succeeded.' },
		latency_ms: { type: 'integer', minimum: 0, description: 'Canary: create+consume round-trip ms.' },
		session_id: { type: 'string', format: 'uuid' },
		budget: { type: ['number', 'null'] },
		// audit fields
		active_count: { type: 'integer', description: 'Audit: sessions currently active.' },
		exhausted_count: { type: 'integer', description: 'Audit: sessions with status exhausted.' },
		expired_count_24h: { type: 'integer', description: 'Audit: sessions that expired in the last 24h.' },
		total_budget_remaining_usdc: { type: 'number', description: 'Audit: sum of remaining USDC across active sessions.' },
		avg_budget_remaining_usd: { type: ['number', 'null'], description: 'Audit: average remaining per active session.' },
		total_spent_usdc: { type: 'number', description: 'Audit: total USDC spent across active sessions.' },
		ts: { type: 'string', format: 'date-time' },
		// common payment meta
		payer: { type: ['string', 'null'] },
		network: { type: ['string', 'null'] },
		amountAtomics: { type: ['string', 'null'] },
		asset: { type: ['string', 'null'] },
	},
};

const BAZAAR = {
	discoverable: true,
	info: {
		input: { type: 'json', method: 'POST', example: INPUT_EXAMPLE },
		output: { type: 'json', example: OUTPUT_EXAMPLE },
	},
	schema: buildBazaarSchema({
		method: 'POST',
		bodySchema: INPUT_SCHEMA,
		outputSchema: OUTPUT_SCHEMA,
	}),
};

export const BAZAAR_SCHEMA = BAZAAR;

// ── Canary schema guard ────────────────────────────────────────────────────────
// Dedicated table — independent of payment_sessions.user_id FK so the canary
// can exercise the DB write path without needing a real user account. Both
// INSERT and UPDATE are exercised per call so a table or index corruption
// surfaces immediately.
let _schemaReady = false;
async function ensureCanarySchema() {
	if (_schemaReady) return;
	await sql`
		CREATE TABLE IF NOT EXISTS spend_session_health_log (
			id          bigserial PRIMARY KEY,
			session_id  uuid NOT NULL DEFAULT gen_random_uuid(),
			ts          timestamptz DEFAULT now(),
			mode        text NOT NULL DEFAULT 'canary',
			budget      numeric,
			created     boolean NOT NULL DEFAULT false,
			consumed    boolean NOT NULL DEFAULT false,
			latency_ms  int,
			payer       text,
			network     text
		)
	`;
	await sql`
		CREATE INDEX IF NOT EXISTS spend_session_health_log_ts_desc
		ON spend_session_health_log (ts DESC)
	`;
	_schemaReady = true;
}

// ── mode:"canary" ─────────────────────────────────────────────────────────────
// Creates a canary session row in spend_session_health_log, immediately marks
// it consumed, and measures the round-trip DB latency. Returns
// { created, consumed, latency_ms }.
async function handleCanary({ meta, mode, budget }) {
	const sessionId = randomUUID();
	let created = false;
	let consumed = false;
	let reason = null;
	const t0 = Date.now();

	try {
		await ensureCanarySchema();

		await sql`
			INSERT INTO spend_session_health_log
				(session_id, mode, budget, created, consumed, payer, network)
			VALUES
				(${sessionId}, ${mode}, ${budget}, false, false,
				 ${meta.payer}, ${meta.network})
		`;
		created = true;

		await sql`
			UPDATE spend_session_health_log
			SET created = true, consumed = true, latency_ms = ${Date.now() - t0}
			WHERE session_id = ${sessionId}
		`;
		consumed = true;
	} catch (err) {
		// A DB failure IS the canary's verdict, not an endpoint error: created and
		// consumed stay false and the cause is reported so the alert is actionable
		// instead of an unexplained false.
		reason = err?.message ? String(err.message).slice(0, 300) : 'session_db_unavailable';
	}

	return {
		ok: true,
		mode: 'canary',
		created,
		consumed,
		reason,
		latency_ms: Date.now() - t0,
		session_id: sessionId,
		budget,
		...meta,
	};
}

// ── mode:"audit" ──────────────────────────────────────────────────────────────
// Reads aggregate stats from payment_sessions — active count, remaining budget,
// expired sessions in the last 24h.
async function handleAudit({ meta }) {
	const [activeSummary] = await sql`
		SELECT
			count(*)                                      AS active_count,
			coalesce(sum(budget_usdc - spent_usdc), 0)   AS remaining_atomics,
			coalesce(sum(spent_usdc), 0)                 AS spent_atomics,
			coalesce(avg(budget_usdc - spent_usdc), null) AS avg_remaining_atomics
		FROM payment_sessions
		WHERE status = 'active'
		  AND expires_at > now()
	`;

	const [exhaustedSummary] = await sql`
		SELECT count(*) AS exhausted_count
		FROM payment_sessions
		WHERE status = 'exhausted'
	`;

	const [expiredSummary] = await sql`
		SELECT count(*) AS expired_count_24h
		FROM payment_sessions
		WHERE status = 'expired'
		  AND updated_at >= now() - interval '24 hours'
	`;

	const activeCount = Number(activeSummary?.active_count ?? 0);
	const exhaustedCount = Number(exhaustedSummary?.exhausted_count ?? 0);
	const expiredCount24h = Number(expiredSummary?.expired_count_24h ?? 0);
	const remainingAtomics = BigInt(activeSummary?.remaining_atomics ?? 0);
	const spentAtomics = BigInt(activeSummary?.spent_atomics ?? 0);
	const avgRemainingAtomics = activeSummary?.avg_remaining_atomics != null
		? Number(activeSummary.avg_remaining_atomics)
		: null;

	return {
		ok: true,
		mode: 'audit',
		active_count: activeCount,
		exhausted_count: exhaustedCount,
		expired_count_24h: expiredCount24h,
		total_budget_remaining_usdc: Number(remainingAtomics) / 1e6,
		avg_budget_remaining_usd: avgRemainingAtomics != null ? avgRemainingAtomics / 1e6 : null,
		total_spent_usdc: Number(spentAtomics) / 1e6,
		ts: new Date().toISOString(),
		...meta,
	};
}

export default paidEndpoint({
	route: ROUTE,
	method: 'POST',
	priceAtomics: priceFor('spend-session', '10000'), // $0.01 USDC
	networks: ['solana'],
	description: DESCRIPTION,
	bazaar: BAZAAR,
	service: withService({
		serviceName: 'three.ws Spend Session Health',
		tags: ['health', 'governance', 'payment-session', 'canary', 'x402'],
	}),
	requiredScope: 'x402:bypass',
	accessControl: installAccessControl({ requiredScope: 'x402:bypass' }),
	async handler({ req, requirement, payer, bypass }) {
		let mode = 'canary';
		let budget = 0.01;
		try {
			const chunks = [await readBody(req, 1_000_000)];
			const raw = Buffer.concat(chunks).toString('utf8');
			if (raw) {
				const body = JSON.parse(raw);
				if (body && typeof body.mode === 'string') {
					mode = body.mode.trim().toLowerCase().slice(0, 32);
				}
				if (body && typeof body.budget === 'number' && body.budget > 0) {
					budget = body.budget;
				}
			}
		} catch {
			// default mode/budget
		}

		const meta = {
			payer: payer ?? (bypass ? bypass.callerId : null),
			network: requirement?.network ?? null,
			amountAtomics: requirement?.amount ?? null,
			asset: requirement?.asset ?? null,
			...(bypass ? { bypass: bypass.reason } : {}),
		};

		if (mode === 'audit') return handleAudit({ meta });
		return handleCanary({ meta, mode: 'canary', budget });
	},
});
