// POST /api/x402/api-key-health
//
// API Key Validity Health Check — paid x402 endpoint that verifies the platform
// has a valid key covering the requested access scope (default: "autonomous_loop").
//
// Body: { scope?: string }  — scope to check (defaults to "autonomous_loop")
//
// Response:
//   { valid, scopes, expires_at, key_type, source, checked_at }
//
// Key resolution order:
//   1. x402_subscriptions where meta.scope = <scope> or meta.scopes ∋ <scope>
//      → a dedicated subscription key for this scope; reports actual expiry.
//   2. INTERNAL_API_KEY env var — internal service bypass; always valid, no expiry.
//   3. Neither found → valid: false, scopes: []
//
// Downstream consumer:
//   autonomous-registry.js `api-key-validity-check` — the autonomous loop pays
//   this endpoint hourly to confirm its access lane is healthy and surfaces
//   hours_until_expiry in x402_autonomous_log.signal_data; storeValue raises a
//   Redis alert (x402:api-key-health:expiry-alert) when expiry < 24 h.

import { paidEndpoint } from '../_lib/x402-paid-endpoint.js';
import { readBody } from '../_lib/http.js';
import { buildBazaarSchema } from '../_lib/x402-spec.js';
import { withService } from '../_lib/x402/bazaar-helpers.js';
import { priceFor } from '../_lib/x402-prices.js';
import { sql } from '../_lib/db.js';
import { env } from '../_lib/env.js';
import { logger } from '../_lib/usage.js';

const ROUTE = '/api/x402/api-key-health';
const log = logger('x402-api-key-health');

const DESCRIPTION =
	'API Key Validity Health Check — verifies that the platform has a valid, ' +
	'non-expired access key covering a given scope. Checks x402 subscription keys ' +
	'and the internal service key. Returns valid, scopes, expires_at, and key_type. ' +
	'Used by the autonomous loop to confirm its access lane is healthy before each tick. ' +
	'Pay-per-call in USDC on Solana or Base mainnet.';

const INPUT_SCHEMA = {
	$schema: 'https://json-schema.org/draft/2020-12/schema',
	type: 'object',
	properties: {
		scope: {
			type: 'string',
			description: 'Access scope to verify (e.g. "autonomous_loop", "internal")',
			default: 'autonomous_loop',
		},
	},
};

const OUTPUT_SCHEMA = {
	$schema: 'https://json-schema.org/draft/2020-12/schema',
	type: 'object',
	required: ['valid', 'scopes', 'checked_at'],
	properties: {
		valid:       { type: 'boolean' },
		scopes:      { type: 'array', items: { type: 'string' } },
		expires_at:  { type: ['string', 'null'] },
		key_type:    { type: ['string', 'null'] },
		source:      { type: ['string', 'null'] },
		key_prefix:  { type: ['string', 'null'] },
		rate_limit_per_minute: { type: ['integer', 'null'] },
		checked_at:  { type: 'string', format: 'date-time' },
	},
};

const BAZAAR = {
	description: DESCRIPTION,
	useCases: ['health check', 'api key validation', 'autonomous loop', 'access control'],
	input: {
		type: 'json',
		example: { scope: 'autonomous_loop' },
		schema: INPUT_SCHEMA,
	},
	output: {
		type: 'json',
		example: {
			valid: true,
			scopes: ['internal', 'autonomous_loop', 'bypass_x402'],
			expires_at: null,
			key_type: 'internal',
			source: 'env',
			key_prefix: null,
			rate_limit_per_minute: null,
			checked_at: '2026-06-28T12:00:00Z',
		},
	},
	schema: buildBazaarSchema({
		method: 'POST',
		bodySchema: INPUT_SCHEMA,
		outputSchema: OUTPUT_SCHEMA,
	}),
};

// Extract the scopes array from a subscription meta object.
function extractScopes(meta) {
	if (!meta || typeof meta !== 'object') return [];
	if (Array.isArray(meta.scopes)) return meta.scopes.filter((s) => typeof s === 'string');
	if (typeof meta.scope === 'string' && meta.scope) return [meta.scope];
	return [];
}

// Look up the best active subscription for the requested scope.
// Prefers non-expiring keys; among expiring ones, prefers the latest expires_at.
async function resolveSubscription(scope) {
	try {
		const scopeJson = JSON.stringify([scope]);
		const rows = await sql`
			SELECT id, name, key_prefix, rate_limit_per_minute, expires_at, revoked_at, meta
			FROM x402_subscriptions
			WHERE revoked_at IS NULL
			  AND (expires_at IS NULL OR expires_at > now())
			  AND (
			    meta->>'scope' = ${scope}
			    OR meta->'scopes' @> ${scopeJson}::jsonb
			  )
			ORDER BY
			  CASE WHEN expires_at IS NULL THEN 1 ELSE 0 END DESC,
			  expires_at DESC NULLS LAST
			LIMIT 1
		`;
		return rows[0] || null;
	} catch (err) {
		log.warn('subscription_lookup_failed', { scope, message: err?.message });
		return null;
	}
}

export default paidEndpoint({
	route: ROUTE,
	method: 'POST',
	// $0.001 USDC = 1000 atomics. Override via X402_PRICE_API_KEY_HEALTH.
	priceAtomics: priceFor('api-key-health', '1000'),
	networks: ['solana', 'base'],
	description: DESCRIPTION,
	bazaar: BAZAAR,
	services: ['api-key-health'],
	service: withService({
		serviceName: 'three.ws API Key Health Check',
		tags: ['health', 'api-key', 'autonomous', 'access-control'],
	}),
	async handler({ req }) {
		const checkedAt = new Date().toISOString();
		// paidEndpoint invokes handler({ req, res, ... }); read the client body off
		// the real request. Vercel does not reliably pre-parse it for these POST
		// routes, so drain the stream (falling back to a pre-parsed req.body when
		// present) rather than trusting req.body — which was always undefined here
		// and silently pinned scope to the default.
		let body = {};
		if (req.body && typeof req.body === 'object') {
			body = req.body;
		} else {
			try {
				const chunks = [await readBody(req, 1_000_000)];
				const raw = Buffer.concat(chunks).toString('utf8');
				if (raw) body = JSON.parse(raw);
			} catch { /* tolerate an empty/unparseable body → default scope */ }
		}
		const scope = (typeof body?.scope === 'string' && body.scope.trim()) || 'autonomous_loop';

		// 1. Check for a dedicated subscription key covering this scope.
		const sub = await resolveSubscription(scope);
		if (sub) {
			const scopes = extractScopes(sub.meta);
			if (!scopes.includes(scope)) scopes.unshift(scope);
			return {
				valid: true,
				scopes,
				expires_at: sub.expires_at ? new Date(sub.expires_at).toISOString() : null,
				key_type: 'subscription',
				source: 'x402_subscriptions',
				key_prefix: sub.key_prefix || null,
				rate_limit_per_minute: sub.rate_limit_per_minute ?? null,
				checked_at: checkedAt,
			};
		}

		// 2. Fall back to INTERNAL_API_KEY — always valid when configured, no expiry.
		const internalKey = env.INTERNAL_API_KEY || process.env.INTERNAL_API_KEY;
		if (internalKey && internalKey.length > 8) {
			return {
				valid: true,
				scopes: ['internal', 'autonomous_loop', 'bypass_x402'],
				expires_at: null,
				key_type: 'internal',
				source: 'env',
				key_prefix: null,
				rate_limit_per_minute: null,
				checked_at: checkedAt,
			};
		}

		// 3. No key found for this scope.
		log.warn('api_key_health_no_key', { scope });
		return {
			valid: false,
			scopes: [],
			expires_at: null,
			key_type: null,
			source: null,
			key_prefix: null,
			rate_limit_per_minute: null,
			checked_at: checkedAt,
		};
	},
});
