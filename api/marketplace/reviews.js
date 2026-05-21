/**
 * Agent reviews API.
 * ──────────────────
 *   GET  /api/marketplace/agents/:id/reviews            — list reviews + summary
 *   POST /api/marketplace/agents/:id/reviews            — upsert caller's review
 *     body: { rating: 1..5, body?: string<=2000 }
 *   DELETE /api/marketplace/agents/:id/reviews          — delete caller's review
 *
 * Routed via vercel.json — see top of file path patterns.
 *
 * Schema lives in api/_lib/migrations/2026-05-21-agent-reviews.sql.
 * One review per (agent_id, user_id); POST upserts in place.
 */

import { z } from 'zod';

import { sql } from '../_lib/db.js';
import { authenticateBearer, extractBearer, getSessionUser } from '../_lib/auth.js';
import { cors, error, json, method, readJson, wrap } from '../_lib/http.js';
import { clientIp, limits } from '../_lib/rate-limit.js';
import { requireCsrf } from '../_lib/csrf.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const reviewSchema = z.object({
	rating: z.number().int().min(1).max(5),
	body: z.string().trim().max(2000).optional().nullable(),
});

async function resolveAuth(req) {
	const session = await getSessionUser(req);
	if (session) return { userId: session.id };
	const bearer = await authenticateBearer(extractBearer(req));
	if (bearer) return { userId: bearer.userId };
	return null;
}

export default wrap(async (req, res) => {
	const url = new URL(req.url, 'http://x');
	const parts = url.pathname.split('/').filter(Boolean); // [api, marketplace, agents, :id, reviews]
	const agentId = url.searchParams.get('agent_id') || parts[3];

	if (!agentId || !UUID_RE.test(agentId)) {
		return error(res, 400, 'validation_error', 'agent_id required');
	}

	if (req.method === 'GET' || (req.method === 'OPTIONS' && req.headers['access-control-request-method'] === 'GET')) {
		return handleList(req, res, agentId);
	}
	if (req.method === 'POST' || (req.method === 'OPTIONS' && req.headers['access-control-request-method'] === 'POST')) {
		return handleUpsert(req, res, agentId);
	}
	if (req.method === 'DELETE' || (req.method === 'OPTIONS' && req.headers['access-control-request-method'] === 'DELETE')) {
		return handleDelete(req, res, agentId);
	}
	return error(res, 405, 'method_not_allowed', 'GET/POST/DELETE only');
});

// ── list + summary ───────────────────────────────────────────────────────────

async function handleList(req, res, agentId) {
	if (cors(req, res, { methods: 'GET,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['GET'])) return;

	const rl = await limits.widgetRead(clientIp(req));
	if (!rl.success) return error(res, 429, 'rate_limited', 'too many requests');

	const [agent] = await sql`
		SELECT id FROM agent_identities WHERE id = ${agentId} AND deleted_at IS NULL
	`;
	if (!agent) return error(res, 404, 'not_found', 'agent not found');

	const auth = await resolveAuth(req).catch(() => null);

	const [summary] = await sql`
		SELECT
			COALESCE(AVG(rating)::numeric(3,2), 0) AS rating_avg,
			COUNT(*)::int                          AS rating_count,
			SUM(CASE WHEN rating = 5 THEN 1 ELSE 0 END)::int AS r5,
			SUM(CASE WHEN rating = 4 THEN 1 ELSE 0 END)::int AS r4,
			SUM(CASE WHEN rating = 3 THEN 1 ELSE 0 END)::int AS r3,
			SUM(CASE WHEN rating = 2 THEN 1 ELSE 0 END)::int AS r2,
			SUM(CASE WHEN rating = 1 THEN 1 ELSE 0 END)::int AS r1
		FROM agent_reviews
		WHERE agent_id = ${agentId}
	`;

	const rows = await sql`
		SELECT r.id, r.rating, r.body, r.created_at, r.updated_at,
		       r.user_id, u.display_name, u.avatar_url
		FROM agent_reviews r
		LEFT JOIN users u ON u.id = r.user_id
		WHERE r.agent_id = ${agentId}
		ORDER BY r.created_at DESC
		LIMIT 50
	`;

	let myReview = null;
	if (auth) {
		const [mine] = await sql`
			SELECT id, rating, body, created_at, updated_at
			FROM agent_reviews
			WHERE agent_id = ${agentId} AND user_id = ${auth.userId}
		`;
		if (mine) myReview = mine;
	}

	const reviews = rows.map((r) => ({
		id: r.id,
		rating: r.rating,
		body: r.body,
		created_at: r.created_at,
		updated_at: r.updated_at,
		author_name: r.display_name || 'Anonymous',
		author_avatar: r.avatar_url || null,
		is_mine: auth && r.user_id === auth.userId,
	}));

	return json(
		res,
		200,
		{
			data: {
				summary: {
					rating_avg: Number(summary.rating_avg || 0),
					rating_count: summary.rating_count || 0,
					breakdown: { 5: summary.r5 || 0, 4: summary.r4 || 0, 3: summary.r3 || 0, 2: summary.r2 || 0, 1: summary.r1 || 0 },
				},
				reviews,
				my_review: myReview,
			},
		},
		{ 'cache-control': 'no-store' },
	);
}

// ── upsert ───────────────────────────────────────────────────────────────────

async function handleUpsert(req, res, agentId) {
	if (cors(req, res, { methods: 'POST,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['POST'])) return;

	const auth = await resolveAuth(req);
	if (!auth) return error(res, 401, 'unauthorized', 'sign in required');

	if (!(await requireCsrf(req, res, auth.userId))) return;

	const rl = await limits.authIp(clientIp(req));
	if (!rl.success) return error(res, 429, 'rate_limited', 'too many requests');

	const [agent] = await sql`
		SELECT id, user_id FROM agent_identities
		WHERE id = ${agentId} AND deleted_at IS NULL AND is_published = true
	`;
	if (!agent) return error(res, 404, 'not_found', 'agent not found');
	if (agent.user_id === auth.userId) {
		return error(res, 422, 'self_review_forbidden', 'you cannot review your own agent');
	}

	const body = await readJson(req).catch(() => null);
	const parsed = reviewSchema.safeParse(body);
	if (!parsed.success) {
		return error(res, 400, 'validation_error', parsed.error.issues[0]?.message || 'invalid review');
	}
	const reviewBody = (parsed.data.body || '').trim() || null;

	const [row] = await sql`
		INSERT INTO agent_reviews (agent_id, user_id, rating, body)
		VALUES (${agentId}, ${auth.userId}, ${parsed.data.rating}, ${reviewBody})
		ON CONFLICT (agent_id, user_id)
		DO UPDATE SET rating = EXCLUDED.rating, body = EXCLUDED.body, updated_at = now()
		RETURNING id, rating, body, created_at, updated_at
	`;

	const [summary] = await sql`
		SELECT
			COALESCE(AVG(rating)::numeric(3,2), 0) AS rating_avg,
			COUNT(*)::int                          AS rating_count
		FROM agent_reviews WHERE agent_id = ${agentId}
	`;

	return json(res, 200, {
		data: {
			review: row,
			summary: {
				rating_avg: Number(summary.rating_avg || 0),
				rating_count: summary.rating_count || 0,
			},
		},
	});
}

// ── delete ───────────────────────────────────────────────────────────────────

async function handleDelete(req, res, agentId) {
	if (cors(req, res, { methods: 'DELETE,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['DELETE'])) return;

	const auth = await resolveAuth(req);
	if (!auth) return error(res, 401, 'unauthorized', 'sign in required');

	if (!(await requireCsrf(req, res, auth.userId))) return;

	const rl = await limits.authIp(clientIp(req));
	if (!rl.success) return error(res, 429, 'rate_limited', 'too many requests');

	await sql`DELETE FROM agent_reviews WHERE agent_id = ${agentId} AND user_id = ${auth.userId}`;
	return json(res, 200, { data: { deleted: true } });
}
