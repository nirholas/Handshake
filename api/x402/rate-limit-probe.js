// POST /api/x402/rate-limit-probe
//
// Paid capacity probe ($0.001 USDC) that returns current rate-limit status for
// any x402 autonomous-loop target endpoint. The autonomous loop pays this canary
// before scheduling high-frequency oracle calls — if remaining_calls is low,
// lower-priority entries yield their slot so oracle throughput is preserved.
//
// Body: { endpoint: "/api/x402/crypto-intel" }, a metered route (/api/x402*,
// /api/mcp*, /api/ibm-mcp); any other path is rejected 400 before the probe runs.
//
// Response:
//   endpoint                   — echoed from body
//   remaining_calls            — floor(remaining_capacity_atomic / price_atomic)
//   reset_at                   — next UTC midnight (daily-cap reset)
//   limit                      — floor(daily_cap_atomic / price_atomic)
//   daily_cap_atomic           — autonomous loop daily USDC budget (atomics)
//   daily_spent_atomic         — spend so far today (atomics)
//   remaining_capacity_atomic  — cap - spent
//   price_atomic               — 402 challenge price for the target endpoint
//   cooldown_active            — true if any matching registry entry is in cooldown
//   cooldown_ttl_seconds       — longest cooldown TTL remaining (seconds); null if none

import { paidEndpoint } from '../_lib/x402-paid-endpoint.js';
import { readBody } from '../_lib/http.js';
import { buildBazaarSchema } from '../_lib/x402-spec.js';
import { withService } from '../_lib/x402/bazaar-helpers.js';
import { installAccessControl } from '../_lib/x402/access-control.js';
import { priceFor } from '../_lib/x402-prices.js';
import { getRedis } from '../_lib/redis.js';
import { env } from '../_lib/env.js';
import { getSelfRegistry, DAILY_CAP_ATOMIC } from '../_lib/x402/autonomous-registry.js';

const ROUTE = '/api/x402/rate-limit-probe';
const COOLDOWN_PREFIX = 'x402:auto:last:';
const DAILY_SPEND_PREFIX = 'x402:auto:daily:';

// Default price for the target endpoint when the live 402 probe fails.
// $0.01 USDC = 10 000 atomics — correct for crypto-intel, a reasonable fallback
// for any comparably priced oracle endpoint.
const DEFAULT_PRICE_ATOMIC = 10_000;

const DESCRIPTION =
	'Rate-Limit Capacity Probe — pay $0.001 USDC to learn how many more calls the ' +
	'x402 autonomous loop can make to a target endpoint today before hitting its daily ' +
	'USDC spend cap. Returns remaining_calls, reset_at, and cooldown_active so agents ' +
	'can throttle dynamically instead of discovering the cap by failure.';

export const INPUT_SCHEMA = {
	$schema: 'https://json-schema.org/draft/2020-12/schema',
	type: 'object',
	required: ['endpoint'],
	properties: {
		endpoint: {
			type: 'string',
			description:
				'Relative path of the target x402 endpoint, e.g. "/api/x402/crypto-intel". Must be a ' +
				'metered route: /api/x402*, /api/mcp* or /api/ibm-mcp. Anything else is rejected 400.',
			pattern: '^/api/(x402|mcp|ibm-mcp)([/?-]|$)',
		},
	},
};

const OUTPUT_SCHEMA = {
	$schema: 'https://json-schema.org/draft/2020-12/schema',
	type: 'object',
	required: ['endpoint', 'remaining_calls', 'reset_at', 'limit'],
	properties: {
		endpoint:                  { type: 'string' },
		remaining_calls:           { type: 'integer', minimum: 0 },
		reset_at:                  { type: 'string', format: 'date-time' },
		limit:                     { type: 'integer', minimum: 0 },
		daily_cap_atomic:          { type: 'integer' },
		daily_spent_atomic:        { type: 'integer' },
		remaining_capacity_atomic: { type: 'integer' },
		price_atomic:              { type: 'integer' },
		cooldown_active:           { type: 'boolean' },
		cooldown_ttl_seconds:      { type: ['integer', 'null'] },
	},
};

const BAZAAR = {
	discoverable: true,
	info: {
		input: { type: 'json', example: { endpoint: '/api/x402/crypto-intel' } },
		output: {
			type: 'json',
			example: {
				endpoint: '/api/x402/crypto-intel',
				remaining_calls: 42,
				reset_at: '2026-06-29T00:00:00.000Z',
				limit: 500,
				daily_cap_atomic: 5000000,
				daily_spent_atomic: 4580000,
				remaining_capacity_atomic: 420000,
				price_atomic: 10000,
				cooldown_active: false,
				cooldown_ttl_seconds: null,
			},
		},
	},
	schema: buildBazaarSchema({
		method: 'POST',
		bodySchema: INPUT_SCHEMA,
		outputSchema: OUTPUT_SCHEMA,
	}),
};

// Compute the next UTC midnight (the moment the daily cap resets).
function nextUtcMidnight() {
	const now = new Date();
	const midnight = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
	return midnight.toISOString();
}

// Today's daily spend key used by the autonomous loop.
function dailySpendKey() {
	return `${DAILY_SPEND_PREFIX}${new Date().toISOString().slice(0, 10)}`;
}

// The probe below makes the server POST to `origin + endpoint` with no auth, so
// a caller must not be able to aim it at an arbitrary internal route. Every HTTP
// path the autonomous registry actually meters sits under one of these prefixes
// (verified against getSelfRegistry()), which is also exactly the set of routes
// that answer a 402 challenge, so this costs the product nothing.
const PROBEABLE_PREFIXES = ['/api/x402', '/api/mcp', '/api/ibm-mcp'];

function isProbeableEndpoint(endpoint) {
	if (endpoint.includes('..')) return false;
	return PROBEABLE_PREFIXES.some(
		(prefix) =>
			endpoint === prefix ||
			endpoint.startsWith(`${prefix}/`) ||
			endpoint.startsWith(`${prefix}?`) ||
			endpoint.startsWith(`${prefix}-`),
	);
}

// Probe the target endpoint (no payment header) to learn its 402 challenge price.
// Returns the smallest price_atomic across all offered accepts, or null on failure.
async function probeEndpointPrice(origin, endpoint) {
	try {
		const url = `${origin}${endpoint}`;
		const res = await fetch(url, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({}),
			signal: AbortSignal.timeout(5000),
		});
		if (res.status !== 402) return null;
		const body = await res.json();
		// x402 v2 wire format: { accepts: [{ amount, ... }] }
		// Also handle legacy { requirements: [...] }
		const accepts = body?.accepts || body?.requirements;
		if (!Array.isArray(accepts) || !accepts.length) return null;
		const prices = accepts
			.map((a) => parseInt(a.amount, 10))
			.filter((n) => Number.isFinite(n) && n > 0);
		if (!prices.length) return null;
		return Math.min(...prices);
	} catch {
		return null;
	}
}

// Read the current daily spend for the autonomous loop from Redis.
async function readDailySpent(redis) {
	if (!redis) return 0;
	try {
		const val = await redis.get(dailySpendKey());
		return val ? Number(val) : 0;
	} catch {
		return 0;
	}
}

// Find all registry entries whose `path` matches the target endpoint (prefix match
// so /api/x402/crypto-intel matches both exact entries and ?query-param variants).
function matchingEntries(endpoint) {
	const registry = getSelfRegistry();
	return registry.filter((e) => {
		if (!e.path) return false;
		const base = e.path.split('?')[0];
		return base === endpoint;
	});
}

// Read the maximum cooldown TTL (in seconds) across matching registry entries.
// Returns { active: boolean, ttl_seconds: number|null }.
async function readCooldownState(redis, entries) {
	if (!redis || !entries.length) return { active: false, ttl_seconds: null };
	try {
		const ttls = await Promise.all(
			entries.map((e) => redis.ttl(`${COOLDOWN_PREFIX}${e.id}`)),
		);
		// ttl() returns: -2 = key absent, -1 = no expiry, N = seconds remaining
		const active = ttls.filter((t) => t > 0);
		if (!active.length) return { active: false, ttl_seconds: null };
		return { active: true, ttl_seconds: Math.max(...active) };
	} catch {
		return { active: false, ttl_seconds: null };
	}
}

export default paidEndpoint({
	route: ROUTE,
	method: 'POST',
	priceAtomics: priceFor('rate-limit-probe', '1000'),
	networks: ['base', 'solana'],
	description: DESCRIPTION,
	bazaar: BAZAAR,
	service: withService({
		serviceName: 'three.ws Rate-Limit Probe',
		tags: ['rate-limit', 'capacity', 'autonomous-loop', 'health', 'oracle'],
	}),
	requiredScope: 'x402:bypass',
	accessControl: installAccessControl({ requiredScope: 'x402:bypass' }),

	async handler({ req }) {
		// Drain the stream — Vercel does not reliably pre-parse req.body for this
		// POST route, and `endpoint` is required, so trusting req.body would 400
		// every paid call. Fall back to a pre-parsed body when the runtime supplies
		// one.
		let body = {};
		if (req.body && typeof req.body === 'object') {
			body = req.body;
		} else {
			try {
				const chunks = [await readBody(req, 1_000_000)];
				const raw = Buffer.concat(chunks).toString('utf8');
				if (raw) body = JSON.parse(raw);
			} catch { /* tolerate an empty/unparseable body → missing_endpoint below */ }
		}
		const endpoint = typeof body.endpoint === 'string' ? body.endpoint.trim() : '';

		if (!endpoint) {
			const err = new Error('"endpoint" is required');
			err.status = 400;
			err.code = 'missing_endpoint';
			throw err;
		}
		if (!endpoint.startsWith('/api/')) {
			const err = new Error('"endpoint" must be a relative /api/ path');
			err.status = 400;
			err.code = 'invalid_endpoint';
			throw err;
		}
		if (!isProbeableEndpoint(endpoint)) {
			const err = new Error(
				`"endpoint" must be a metered x402 route (${PROBEABLE_PREFIXES.join(', ')})`,
			);
			err.status = 400;
			err.code = 'endpoint_not_metered';
			throw err;
		}

		const origin = env.APP_ORIGIN || 'https://three.ws';
		const redis = getRedis();

		// Run the live 402 price probe and Redis reads in parallel.
		const [livePrice, dailySpentAtomic, matchEntries] = await Promise.all([
			probeEndpointPrice(origin, endpoint),
			readDailySpent(redis),
			Promise.resolve(matchingEntries(endpoint)),
		]);

		const priceAtomic = livePrice ?? DEFAULT_PRICE_ATOMIC;
		const { active: cooldownActive, ttl_seconds: cooldownTtlSeconds } =
			await readCooldownState(redis, matchEntries);

		const capAtomic = DAILY_CAP_ATOMIC;
		const remainingCapacityAtomic = Math.max(0, capAtomic - dailySpentAtomic);
		const remainingCalls = priceAtomic > 0
			? Math.floor(remainingCapacityAtomic / priceAtomic)
			: 0;
		const limit = priceAtomic > 0
			? Math.floor(capAtomic / priceAtomic)
			: 0;

		return {
			endpoint,
			remaining_calls: remainingCalls,
			reset_at: nextUtcMidnight(),
			limit,
			daily_cap_atomic: capAtomic,
			daily_spent_atomic: dailySpentAtomic,
			remaining_capacity_atomic: remainingCapacityAtomic,
			price_atomic: priceAtomic,
			cooldown_active: cooldownActive,
			cooldown_ttl_seconds: cooldownTtlSeconds,
		};
	},
});
