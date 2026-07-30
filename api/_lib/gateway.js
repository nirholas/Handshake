// Unified API gateway — the single entry contract for the versioned three.ws
// API (/api/v1/*).
//
// three.ws exposes 700+ capability endpoints under /api. This module bundles
// them into ONE coherent product API: every /api/v1 route is a thin handler
// that declares its auth requirement, OAuth scope, and a capability function —
// the gateway provides everything else exactly once, so the surface stays
// consistent no matter which capability sits behind it:
//
//   • Auth      — three.ws API key (`Authorization: Bearer sk_live_…`), OAuth
//                 access token, or browser session. One contract, three rails.
//   • Scopes    — declared per endpoint, enforced for key/OAuth callers.
//   • Limits    — per-principal rate limiting (key › user › IP) with standard
//                 RateLimit-* headers, via api/_lib/rate-limit.js `apiV1`.
//   • Metering  — every call recorded to usage_events (api/_lib/usage.js), so a
//                 single dashboard/billing view spans the whole API.
//   • Envelope  — success → { data }, failure → { error, error_description }
//                 (the same shape the rest of the API already uses), with 5xx
//                 sanitized via api/_lib/http.js `wrap`.
//
// A handler returns its payload (wrapped in `{ data }` with 200) or writes the
// response itself (e.g. a redirect / binary) and returns nothing. To fail a
// request, throw an Error with `.status` and `.code` — `wrap` formats it.

import {
	cors,
	json,
	error,
	method as methodGuard,
	readJson,
	rateLimited,
	setRateLimitHeaders,
	wrap,
} from './http.js';
import {
	authenticateBearer,
	extractBearer,
	getSessionUser,
	hasScope,
} from './auth.js';
import { limits, clientIp } from './rate-limit.js';
import { recordEvent } from './usage.js';

/**
 * Throw a client-facing error the gateway will render as
 * `{ error: <code>, error_description: <message> }` at the given status.
 * @param {number} status
 * @param {string} code
 * @param {string} message
 */
export function fail(status, code, message) {
	// `expose` marks this as an author-written contract error, so wrap() may echo
	// the code and message even on a 5xx. Errors that merely bubble up (a Postgres
	// SQLSTATE, an ECONNREFUSED) carry no such marker and stay redacted.
	throw Object.assign(new Error(message), { status, code, expose: true });
}

/**
 * Define a versioned API endpoint.
 *
 * @param {object} spec
 * @param {string} spec.name                  Stable usage/billing identifier, e.g. "v1.sentiment".
 * @param {string|string[]} spec.method       Allowed HTTP method(s).
 * @param {'public'|'optional'|'required'} spec.auth  Auth requirement.
 * @param {string} [spec.scope]               OAuth scope required for key/OAuth callers (auth: required|optional).
 * @param {(ctx: GatewayCtx) => Promise<any>|any} spec.handler
 * @returns {(req: import('http').IncomingMessage, res: import('http').ServerResponse) => Promise<void>}
 *
 * @typedef {object} GatewayCtx
 * @property {import('http').IncomingMessage} req
 * @property {import('http').ServerResponse} res
 * @property {Principal|null} principal  Resolved caller (null for anonymous public calls).
 * @property {Record<string, any>} body  Parsed JSON body (POST/PUT/PATCH), else {}.
 * @property {Record<string, string>} query  Parsed query-string params.
 * @property {string} ip
 *
 * @typedef {object} Principal
 * @property {string} userId
 * @property {'session'|'apikey'|'oauth'} source
 * @property {string} scope
 * @property {string} [apiKeyId]
 * @property {string} [clientId]
 */
export function defineEndpoint(spec) {
	const methods = Array.isArray(spec.method) ? spec.method : [spec.method];
	const writeMethods = methods.some((m) => ['POST', 'PUT', 'PATCH'].includes(m));

	return wrap(async (req, res) => {
		if (cors(req, res, { methods: [...methods, 'OPTIONS'].join(','), origins: '*' })) return;
		if (!methodGuard(req, res, methods)) return;

		const started = Date.now();
		const ip = clientIp(req);

		// ── auth ──────────────────────────────────────────────────────────────
		let principal = null;
		if (spec.auth === 'required' || spec.auth === 'optional') {
			const session = await getSessionUser(req);
			if (session) {
				// A signed-in owner acting on their own account holds every scope.
				principal = { userId: session.id, source: 'session', scope: 'all' };
			} else {
				const bearer = await authenticateBearer(extractBearer(req));
				if (bearer) {
					principal = {
						userId: bearer.userId,
						source: bearer.source,
						scope: bearer.scope || '',
						apiKeyId: bearer.apiKeyId,
						clientId: bearer.clientId,
					};
				}
			}

			if (spec.auth === 'required' && !principal) {
				return error(
					res,
					401,
					'unauthorized',
					'authenticate with a three.ws API key (`Authorization: Bearer sk_live_…`) or sign in — create a key at /dashboard/developers',
				);
			}
			if (
				principal &&
				principal.source !== 'session' &&
				spec.scope &&
				!hasScope(principal.scope, spec.scope)
			) {
				return error(
					res,
					403,
					'insufficient_scope',
					`this endpoint requires the "${spec.scope}" scope`,
				);
			}
		}

		// ── rate limit (per principal › IP) ────────────────────────────────────
		const rlKey = principal?.apiKeyId
			? `key:${principal.apiKeyId}`
			: principal?.userId
				? `user:${principal.userId}`
				: `ip:${ip}`;
		const rl = await limits.apiV1(rlKey);
		setRateLimitHeaders(res, rl);
		if (!rl.success) return rateLimited(res, rl);

		// ── body + query ───────────────────────────────────────────────────────
		const body = writeMethods && req.method !== 'GET' ? await readJson(req) : {};
		const query = Object.fromEntries(new URL(req.url, 'http://internal').searchParams);

		const ctx = { req, res, principal, body, query, ip };

		// ── dispatch + meter ─────────────────────────────────────────────────────
		const meter = (status) =>
			recordEvent({
				kind: 'api',
				tool: spec.name,
				userId: principal?.userId,
				apiKeyId: principal?.apiKeyId,
				clientId: principal?.clientId,
				status,
				latencyMs: Date.now() - started,
			});

		let payload;
		try {
			payload = await spec.handler(ctx);
		} catch (err) {
			meter('error');
			throw err; // wrap() renders the envelope (4xx descriptive, 5xx sanitized)
		}
		meter('ok');

		// Handler may have already responded (redirect / streamed / binary).
		if (res.writableEnded || res.headersSent) return;
		return json(res, 200, { data: payload });
	});
}
