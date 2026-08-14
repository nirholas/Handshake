// Agent Payment Session API: create, inspect, and cancel payment sessions.
//
// A PaymentSession is a platform-managed spend envelope: developer funds a
// budget from their credits, receives a bearer token, and hands it to an agent.
// The agent spends against the session budget by calling /api/pay/execute, with
// no private key required. The platform's wallet signs the x402 transactions.
//
// POST   /api/pay/session                     create a new session
// GET    /api/pay/session/:id                 inspect a session (owner only)
// PATCH  /api/pay/session/:id                 update label / allowlist / per-tx cap
// DELETE /api/pay/session/:id                 cancel + refund un-spent budget
// GET    /api/pay/session/:id/executions      list payments made in a session
// GET    /api/pay/session                     list all sessions for the caller

import { getSessionUser, authenticateBearer, extractBearer } from '../_lib/auth.js';
import { cors, error, json, method, readJson, wrap, rateLimited } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import {
	createPaymentSession,
	getPaymentSession,
	listPaymentSessions,
	cancelPaymentSession,
	updatePaymentSession,
	listSessionExecutions,
	getPaymentStats,
} from '../_lib/pay/payment-session.js';
import { isSessionId } from '../_lib/pay/spend-governor.js';

async function resolveUser(req, res) {
	const session = await getSessionUser(req, res);
	if (session) return session;
	const bearer = await authenticateBearer(extractBearer(req));
	if (bearer) return { id: bearer.userId };
	return null;
}

// Extract :id and :sub from URL path
function parsePath(req) {
	const path = new URL(req.url, 'http://x').pathname;
	// /api/pay/session/:id or /api/pay/session/:id/executions
	const m = path.match(/\/api\/pay\/session\/([^/]+)(?:\/([^/]+))?/);
	return m ? { id: m[1], sub: m[2] ?? null } : { id: null, sub: null };
}

/**
 * Read `limit` and `cursor` off the query string, clamped to values the SQL can
 * actually take. Both reach Postgres verbatim otherwise: a negative limit
 * becomes `LIMIT -4` and a non-date cursor becomes a timestamptz cast error, and
 * either one turns a caller's typo into a 500.
 */
function parsePagination(req) {
	const url = new URL(req.url, 'http://x');
	const rawLimit = Number(url.searchParams.get('limit'));
	const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(Math.floor(rawLimit), 100) : 20;

	const rawCursor = url.searchParams.get('cursor');
	const cursor = rawCursor && Number.isFinite(Date.parse(rawCursor)) ? rawCursor : null;
	return { limit, cursor, cursorRejected: Boolean(rawCursor) && cursor === null };
}

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,POST,PATCH,DELETE,OPTIONS', credentials: true })) return;

	const rl = await limits.authIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const user = await resolveUser(req, res);
	if (!user) return error(res, 401, 'unauthorized', 'authentication required');

	const { id, sub } = parsePath(req);
	const httpMethod = req.method?.toUpperCase();

	// POST /api/pay/session: create
	if (!id && httpMethod === 'POST') {
		if (!method(req, res, ['POST'])) return;
		const body = await readJson(req, res);
		if (!body) return;

		let result;
		try {
			result = await createPaymentSession({
				userId: user.id,
				agentId: body.agent_id ?? null,
				label: body.label,
				budgetUsd: body.budget_usd,
				maxPerTxUsd: body.max_per_tx_usd ?? null,
				allowedHosts: body.allowed_hosts ?? [],
				network: body.network ?? 'solana',
				expirySeconds: body.expiry_seconds ?? 3600,
				metadata: body.metadata ?? {},
			});
		} catch (err) {
			if (err.code === 'insufficient_credits') {
				return error(res, 402, 'insufficient_credits',
					`Insufficient credits: need $${err.required_usd?.toFixed(4)}, have $${err.available_usd?.toFixed(4)}`
				);
			}
			if (err.status === 400 || err.code?.startsWith('invalid_')) {
				return error(res, 400, err.code ?? 'bad_request', err.message);
			}
			throw err;
		}

		return json(res, 201, {
			session: result.session,
			token: result.token,
			note: 'Store this token securely. It is shown once and cannot be recovered.',
		});
	}

	// GET /api/pay/session: list all sessions
	if (!id && httpMethod === 'GET') {
		const url = new URL(req.url, 'http://x');
		const status = url.searchParams.get('status') || null;
		const { limit, cursor, cursorRejected } = parsePagination(req);
		if (cursorRejected) {
			return error(res, 400, 'invalid_cursor', 'cursor must be an ISO 8601 timestamp');
		}

		const [sessions, stats] = await Promise.all([
			listPaymentSessions(user.id, { status, limit, cursor }),
			getPaymentStats(user.id),
		]);

		return json(res, 200, { ...sessions, stats });
	}

	// The collection route only answers POST (create) and GET (list). Anything
	// else is a method problem, not a missing-id problem, so say which.
	if (!id) {
		return error(
			res,
			405,
			'method_not_allowed',
			`${httpMethod} on the session collection is not supported. Use POST to create or GET to list.`,
		);
	}

	// Every id lands in a `uuid` column comparison, where Postgres answers a
	// malformed value with a cast error rather than "no rows". Rejecting the
	// shape here is what keeps /api/pay/session/not-a-uuid a 404 and not a 500.
	if (!isSessionId(id)) {
		return error(res, 404, 'not_found', 'session not found');
	}

	// GET /api/pay/session/:id/executions
	if (sub === 'executions' && httpMethod === 'GET') {
		const session = await getPaymentSession(id, user.id);
		if (!session) return error(res, 404, 'not_found', 'session not found');

		const { limit, cursor, cursorRejected } = parsePagination(req);
		if (cursorRejected) {
			return error(res, 400, 'invalid_cursor', 'cursor must be an ISO 8601 timestamp');
		}
		const result = await listSessionExecutions(id, user.id, { limit, cursor });
		return json(res, 200, result);
	}

	// GET /api/pay/session/:id
	if (httpMethod === 'GET') {
		const session = await getPaymentSession(id, user.id);
		if (!session) return error(res, 404, 'not_found', 'session not found');
		return json(res, 200, { session });
	}

	// PATCH /api/pay/session/:id: update mutable fields on an active session
	if (httpMethod === 'PATCH') {
		const body = await readJson(req, res);
		if (!body) return;

		const updates = {};
		if (typeof body.label === 'string') updates.label = body.label.trim();
		if (Array.isArray(body.allowed_hosts)) updates.allowedHosts = body.allowed_hosts;
		if (body.max_per_tx_usd !== undefined) updates.maxPerTxUsd = body.max_per_tx_usd;
		if (Object.keys(updates).length === 0) {
			return error(res, 400, 'nothing_to_update', 'Provide at least one of: label, allowed_hosts, max_per_tx_usd');
		}

		const result = await updatePaymentSession(id, user.id, updates);
		if (!result) return error(res, 404, 'not_found', 'session not found, not active, or not owned by you');
		return json(res, 200, { session: result });
	}

	// DELETE /api/pay/session/:id
	if (httpMethod === 'DELETE') {
		const result = await cancelPaymentSession(id, user.id);
		if (!result) return error(res, 404, 'not_found', 'session not found or already closed');
		return json(res, 200, {
			cancelled: true,
			session_id: id,
			refunded_usd: result.refunded_usd,
		});
	}

	return error(res, 405, 'method_not_allowed', `${httpMethod} not supported`);
});
