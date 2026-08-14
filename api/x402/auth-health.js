// /api/x402/auth-health — Auth Session Lifecycle Health Check
//
// POST { "mode": "session_lifecycle" }
// Paid $0.001 USDC. Exercises the auth session lifecycle end-to-end:
//
//   1. create   — mint a canary JWT access token (proves JWT_SECRET + signing)
//   2. validate — verify that token with the full verifier (proves ISSUER + key)
//   3. refresh  — issue a replacement token and re-verify it (proves rotation path)
//   4. expire   — craft an already-expired token and confirm it is rejected
//
// Returns { all_pass: bool, failed_step: string|null, latency_ms: int, steps }.
// A failed_step that is non-null means that step of the auth pipeline is broken.
// Used by the autonomous loop as a security-critical 30-minute canary.

import { SignJWT } from 'jose';
import { paidEndpoint } from '../_lib/x402-paid-endpoint.js';
import { readBody as readRawBody } from '../_lib/http.js';
import { buildBazaarSchema } from '../_lib/x402-spec.js';
import { withService } from '../_lib/x402/bazaar-helpers.js';
import { installAccessControl } from '../_lib/x402/access-control.js';
import { priceFor } from '../_lib/x402-prices.js';
import { mintAccessToken, verifyAccessToken } from '../_lib/auth.js';
import { env } from '../_lib/env.js';

const ROUTE = '/api/x402/auth-health';

// Synthetic canary identity — never maps to a real user.
const CANARY_USER_ID = '00000000-0000-0000-0000-000000000000';
const CANARY_CLIENT  = 'x402-auth-health-canary';
const CANARY_SCOPE   = 'health:read';
const SUPPORTED_MODE = 'session_lifecycle';

// Read the JSON body through the shared reader. The local hand-rolled version
// this replaces drained the raw stream with no size cap and no stalled-stream
// timeout, so an oversized or never-finished body pinned a Cloud Run
// concurrency slot; _lib/http.js readBody enforces both and also handles the
// bodies Express already parsed ahead of the handler. 1 MB matches every
// neighbouring POST endpoint in this directory.
async function readJsonBody(req) {
	if (req.body && typeof req.body === 'object') return req.body;
	try {
		const raw = (await readRawBody(req, 1_000_000)).toString('utf8').trim();
		return raw ? JSON.parse(raw) : {};
	} catch {
		return {};
	}
}

// Resolve and validate the requested mode, throwing rather than returning on a
// bad one. paidEndpoint delivers before it settles, so a returned value is the
// buyer's receipt: returning an error object here billed $0.001 for a 200
// carrying no health check at all. A throw lands before settlement, so an
// unsupported mode costs the caller nothing.
function resolveMode(body) {
	const mode = typeof body?.mode === 'string' ? body.mode.trim() : SUPPORTED_MODE;
	if (mode !== SUPPORTED_MODE) {
		throw Object.assign(
			new Error(`unsupported mode "${mode}"; the only supported mode is "${SUPPORTED_MODE}"`),
			{ status: 400, code: 'unsupported_mode' },
		);
	}
	return mode;
}

export const __test__ = { resolveMode };

async function runSessionLifecycle() {
	const t0 = Date.now();
	const steps = {};
	const audience = env.MCP_RESOURCE || env.APP_ORIGIN || 'https://three.ws';

	// ── Step 1: create ────────────────────────────────────────────────────────
	let accessToken;
	{
		const ts = Date.now();
		try {
			accessToken = await mintAccessToken({
				userId: CANARY_USER_ID,
				clientId: CANARY_CLIENT,
				scope: CANARY_SCOPE,
				resource: audience,
			});
			steps.create = { pass: true, latency_ms: Date.now() - ts };
		} catch (err) {
			steps.create = { pass: false, latency_ms: Date.now() - ts, error: err?.message ?? String(err) };
			return { all_pass: false, failed_step: 'create', latency_ms: Date.now() - t0, steps, ts: new Date().toISOString() };
		}
	}

	// ── Step 2: validate ──────────────────────────────────────────────────────
	{
		const ts = Date.now();
		try {
			const payload = await verifyAccessToken(accessToken, { audience });
			if (payload.sub !== CANARY_USER_ID) throw new Error(`sub mismatch: ${payload.sub}`);
			steps.validate = { pass: true, latency_ms: Date.now() - ts };
		} catch (err) {
			steps.validate = { pass: false, latency_ms: Date.now() - ts, error: err?.message ?? String(err) };
			return { all_pass: false, failed_step: 'validate', latency_ms: Date.now() - t0, steps, ts: new Date().toISOString() };
		}
	}

	// ── Step 3: refresh ───────────────────────────────────────────────────────
	// Simulates the token-rotation path: issue a new access token and verify it.
	// The autonomous loop's canary runs as a machine user, so we exercise the
	// in-process rotation rather than the DB-backed refresh-grant exchange.
	{
		const ts = Date.now();
		try {
			const refreshed = await mintAccessToken({
				userId: CANARY_USER_ID,
				clientId: CANARY_CLIENT,
				scope: CANARY_SCOPE,
				resource: audience,
			});
			const payload = await verifyAccessToken(refreshed, { audience });
			if (payload.sub !== CANARY_USER_ID) throw new Error(`sub mismatch on refreshed token: ${payload.sub}`);
			steps.refresh = { pass: true, latency_ms: Date.now() - ts };
		} catch (err) {
			steps.refresh = { pass: false, latency_ms: Date.now() - ts, error: err?.message ?? String(err) };
			return { all_pass: false, failed_step: 'refresh', latency_ms: Date.now() - t0, steps, ts: new Date().toISOString() };
		}
	}

	// ── Step 4: expire ────────────────────────────────────────────────────────
	// Craft a structurally-valid JWT with a past expiration and confirm that
	// verifyAccessToken rejects it. This proves the verifier enforces `exp` — a
	// verifier that accepts expired tokens is a security hole, not a health pass.
	{
		const ts = Date.now();
		try {
			const secret = env.JWT_SECRET;
			if (!secret) throw new Error('JWT_SECRET not configured — cannot craft canary expired token');

			const key      = new TextEncoder().encode(secret);
			const nowSec   = Math.floor(Date.now() / 1000);
			const issuer   = env.ISSUER || env.APP_ORIGIN || 'https://three.ws';

			const expiredToken = await new SignJWT({
				scope: CANARY_SCOPE,
				client_id: CANARY_CLIENT,
				token_use: 'access',
			})
				.setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
				.setSubject(CANARY_USER_ID)
				.setIssuer(issuer)
				.setAudience(audience)
				.setIssuedAt(nowSec - 7200)
				.setExpirationTime(nowSec - 3600) // expired 1 hour ago
				.sign(key);

			let rejected = false;
			try {
				await verifyAccessToken(expiredToken, { audience });
			} catch (err) {
				// jose throws with code ERR_JWT_EXPIRED for past-exp tokens.
				rejected = err?.code === 'ERR_JWT_EXPIRED' || /expired/i.test(err?.message ?? '');
			}

			if (!rejected) {
				steps.expire = { pass: false, latency_ms: Date.now() - ts, error: 'expired_token_was_accepted' };
				return { all_pass: false, failed_step: 'expire', latency_ms: Date.now() - t0, steps, ts: new Date().toISOString() };
			}
			steps.expire = { pass: true, latency_ms: Date.now() - ts };
		} catch (err) {
			steps.expire = { pass: false, latency_ms: Date.now() - ts, error: err?.message ?? String(err) };
			return { all_pass: false, failed_step: 'expire', latency_ms: Date.now() - t0, steps, ts: new Date().toISOString() };
		}
	}

	return {
		all_pass: true,
		failed_step: null,
		latency_ms: Date.now() - t0,
		steps,
		ts: new Date().toISOString(),
	};
}

// ── Bazaar / endpoint metadata ────────────────────────────────────────────────

const DESCRIPTION =
	'Auth Session Lifecycle Health — pay $0.001 USDC to exercise the full JWT ' +
	'auth session lifecycle: create, validate, refresh, and expiry-rejection. ' +
	'Returns { all_pass, failed_step, latency_ms } so a monitoring loop can ' +
	'detect a broken auth subsystem before users do.';

const INPUT_SCHEMA = {
	$schema: 'https://json-schema.org/draft/2020-12/schema',
	type: 'object',
	properties: {
		mode: {
			type: 'string',
			enum: ['session_lifecycle'],
			description: 'Health-check mode. Only "session_lifecycle" is supported.',
			default: 'session_lifecycle',
		},
	},
};

const OUTPUT_SCHEMA = {
	$schema: 'https://json-schema.org/draft/2020-12/schema',
	type: 'object',
	required: ['all_pass', 'failed_step', 'latency_ms', 'ts'],
	properties: {
		all_pass:    { type: 'boolean', description: 'True when all four lifecycle steps passed.' },
		failed_step: { type: ['string', 'null'], description: 'Name of the first step that failed, or null.' },
		latency_ms:  { type: 'integer', description: 'Total wall-clock time for all steps in milliseconds.' },
		steps: {
			type: 'object',
			description: 'Per-step { pass, latency_ms, error? } breakdown.',
			properties: {
				create:   { type: 'object' },
				validate: { type: 'object' },
				refresh:  { type: 'object' },
				expire:   { type: 'object' },
			},
		},
		ts: { type: 'string', format: 'date-time' },
	},
};

const BAZAAR = {
	description: DESCRIPTION,
	useCases: ['auth health', 'session lifecycle canary', 'JWT verification probe', 'security monitoring'],
	input: {
		type: 'json',
		example: { mode: 'session_lifecycle' },
		schema: INPUT_SCHEMA,
	},
	output: {
		type: 'json',
		example: {
			all_pass: true,
			failed_step: null,
			latency_ms: 38,
			steps: {
				create:   { pass: true, latency_ms: 8  },
				validate: { pass: true, latency_ms: 3  },
				refresh:  { pass: true, latency_ms: 11 },
				expire:   { pass: true, latency_ms: 2  },
			},
			ts: '2026-06-28T00:00:00Z',
		},
	},
	schema: buildBazaarSchema({ method: 'POST', bodySchema: INPUT_SCHEMA, outputSchema: OUTPUT_SCHEMA }),
};

const authHealthEndpoint = paidEndpoint({
	route: ROUTE,
	method: 'POST',
	priceAtomics: priceFor('auth_health', '1000'), // $0.001 USDC
	networks: ['solana', 'base'],
	description: DESCRIPTION,
	bazaar: BAZAAR,
	service: withService({
		serviceName: 'three.ws Auth Session Health',
		tags: ['auth', 'session', 'jwt', 'health', 'security', 'x402'],
	}),
	accessControl: installAccessControl({ requiredScope: 'x402:bypass' }),

	async handler({ req }) {
		resolveMode(await readJsonBody(req));
		return runSessionLifecycle();
	},
});

export default authHealthEndpoint;
