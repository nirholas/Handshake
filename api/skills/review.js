/**
 * Per-skill ratings and reviews for paid skills sold on an agent.
 * ──────────────────────────────────────────────────────────
 *   GET  /api/skills/review?agent_id=<uuid>&skill=<name>&page=<n>&page_size=<n>
 *        → { data: { summary: { rating_avg, rating_count, breakdown }, reviews, page,
 *                    page_size, total, has_more, my_review } }
 *
 *   POST /api/skills/review
 *        body: { agent_id: <uuid>, skill: <name>, rating: 1..5, body?: string<=2000 }
 *        → { data: { review, summary: { rating_avg, rating_count } } }
 *        201 on first review, 200 on edit. 403 if the caller has not obtained
 *        access to the skill (must own a confirmed purchase / time-pass / sub /
 *        active trial); 422 on reviewing your own agent's skill.
 *
 * Reachability: vercel.json routes `/api/skills/<x>` → `/api/skills/[id]?id=<x>`,
 * so `[id].js` delegates `id === 'review'` here (see the early hand-off there).
 * One review per (agent_id, skill, reviewer); POST upserts in place.
 *
 * Schema: api/_lib/migrations/20260621180000_skill_reviews.sql.
 * Ownership is verified with the canonical hasSkillAccess() helper, the same
 * gate the paid-skill execution path uses, so a review can only follow real,
 * on-chain-confirmed access.
 */

import { z } from 'zod';

import { sql } from '../_lib/db.js';
import { authenticateBearer, extractBearer, getSessionUser } from '../_lib/auth.js';
import { cors, error, json, method, readJson, wrap, rateLimited } from '../_lib/http.js';
import { clientIp, limits } from '../_lib/rate-limit.js';
import { requireCsrf } from '../_lib/csrf.js';
import { isUuid } from '../_lib/validate.js';
import { hasSkillAccess } from '../_lib/skill-access.js';
import { publishUserEvent } from '../_lib/feed.js';
import { attestReview } from '../_lib/review-attest.js';

const SKILL_MAX = 200;

const reviewSchema = z.object({
	agent_id: z.string().trim().uuid(),
	skill: z.string().trim().min(1).max(SKILL_MAX),
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
	if (req.method === 'GET' || (req.method === 'OPTIONS' && req.headers['access-control-request-method'] === 'GET')) {
		return handleList(req, res);
	}
	if (req.method === 'POST' || (req.method === 'OPTIONS' && req.headers['access-control-request-method'] === 'POST')) {
		return handleUpsert(req, res);
	}
	return error(res, 405, 'method_not_allowed', 'GET/POST only');
});

// ── list + aggregate (paginated) ──────────────────────────────────────────────

async function handleList(req, res) {
	if (cors(req, res, { methods: 'GET,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['GET'])) return;

	const rl = await limits.widgetRead(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const url = new URL(req.url, 'http://x');
	const agentId = url.searchParams.get('agent_id');
	const skill = (url.searchParams.get('skill') || '').trim();

	if (!agentId || !isUuid(agentId)) return error(res, 400, 'validation_error', 'agent_id required');
	if (!skill || skill.length > SKILL_MAX) return error(res, 400, 'validation_error', 'skill required');

	const page = Math.max(1, Number.parseInt(url.searchParams.get('page') || '1', 10) || 1);
	const pageSize = Math.min(50, Math.max(1, Number.parseInt(url.searchParams.get('page_size') || '10', 10) || 10));
	const offset = (page - 1) * pageSize;

	const [agent] = await sql`
		SELECT id FROM agent_identities WHERE id = ${agentId} AND deleted_at IS NULL
	`;
	if (!agent) return error(res, 404, 'not_found', 'agent not found');

	const auth = await resolveAuth(req).catch(() => null);

	const [summary] = await sql`
		SELECT
			COALESCE(AVG(rating)::numeric(3,2), 0)          AS rating_avg,
			COUNT(*)::int                                   AS rating_count,
			SUM(CASE WHEN rating = 5 THEN 1 ELSE 0 END)::int AS r5,
			SUM(CASE WHEN rating = 4 THEN 1 ELSE 0 END)::int AS r4,
			SUM(CASE WHEN rating = 3 THEN 1 ELSE 0 END)::int AS r3,
			SUM(CASE WHEN rating = 2 THEN 1 ELSE 0 END)::int AS r2,
			SUM(CASE WHEN rating = 1 THEN 1 ELSE 0 END)::int AS r1
		FROM skill_reviews
		WHERE agent_id = ${agentId} AND skill = ${skill}
	`;

	const rows = await sql`
		SELECT r.id, r.rating, r.body, r.created_at, r.updated_at,
		       r.reviewer_id, u.display_name, u.username, u.avatar_url
		FROM skill_reviews r
		LEFT JOIN users u ON u.id = r.reviewer_id AND u.deleted_at IS NULL
		WHERE r.agent_id = ${agentId} AND r.skill = ${skill}
		ORDER BY r.created_at DESC
		LIMIT ${pageSize} OFFSET ${offset}
	`;

	let myReview = null;
	if (auth) {
		const [mine] = await sql`
			SELECT id, rating, body, created_at, updated_at
			FROM skill_reviews
			WHERE agent_id = ${agentId} AND skill = ${skill} AND reviewer_id = ${auth.userId}
		`;
		if (mine) myReview = mine;
	}

	const total = summary?.rating_count || 0;
	const reviews = rows.map((r) => ({
		id: r.id,
		rating: r.rating,
		body: r.body,
		created_at: r.created_at,
		updated_at: r.updated_at,
		author_name: r.display_name || r.username || 'Anonymous',
		author_avatar: r.avatar_url || null,
		is_mine: !!(auth && r.reviewer_id === auth.userId),
	}));

	return json(
		res,
		200,
		{
			data: {
				summary: {
					rating_avg: Number(summary?.rating_avg || 0),
					rating_count: total,
					breakdown: {
						5: summary?.r5 || 0,
						4: summary?.r4 || 0,
						3: summary?.r3 || 0,
						2: summary?.r2 || 0,
						1: summary?.r1 || 0,
					},
				},
				reviews,
				page,
				page_size: pageSize,
				total,
				has_more: offset + reviews.length < total,
				my_review: myReview,
			},
		},
		{ 'cache-control': 'no-store' },
	);
}

// ── upsert (create/update) ────────────────────────────────────────────────────

async function handleUpsert(req, res) {
	if (cors(req, res, { methods: 'POST,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['POST'])) return;

	const auth = await resolveAuth(req);
	if (!auth) return error(res, 401, 'unauthorized', 'sign in required');

	if (!(await requireCsrf(req, res, auth.userId))) return;

	const rl = await limits.authIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const parsed = reviewSchema.safeParse(await readJson(req).catch(() => null));
	if (!parsed.success) {
		return error(res, 400, 'validation_error', parsed.error.issues[0]?.message || 'invalid review');
	}
	const { agent_id: agentId, skill, rating } = parsed.data;
	const reviewBody = (parsed.data.body || '').trim() || null;

	const [agent] = await sql`
		SELECT id, user_id, name, erc8004_agent_id, chain_id FROM agent_identities
		WHERE id = ${agentId} AND deleted_at IS NULL
	`;
	if (!agent) return error(res, 404, 'not_found', 'agent not found');
	if (agent.user_id === auth.userId) {
		return error(res, 422, 'self_review_forbidden', 'you cannot review your own skill');
	}

	// Ownership gate: the reviewer must have real access to this paid skill:
	// a confirmed purchase, time-pass, agent/creator subscription, or active
	// trial. hasSkillAccess is the canonical gate used by the execution path.
	const access = await hasSkillAccess(auth.userId, agentId, skill);
	if (!access.paid) {
		// Free skills aren't sold, so there's no purchase to anchor a review to.
		return error(res, 403, 'not_purchasable', 'only paid skills can be reviewed');
	}
	if (!access.owned) {
		return error(res, 403, 'not_purchased', 'purchase this skill before reviewing it');
	}

	const [row] = await sql`
		INSERT INTO skill_reviews (agent_id, skill, reviewer_id, rating, body)
		VALUES (${agentId}, ${skill}, ${auth.userId}, ${rating}, ${reviewBody})
		ON CONFLICT (agent_id, skill, reviewer_id)
		DO UPDATE SET rating = EXCLUDED.rating, body = EXCLUDED.body, updated_at = now()
		RETURNING id, rating, body, created_at, updated_at
	`;

	const [summary] = await sql`
		SELECT
			COALESCE(AVG(rating)::numeric(3,2), 0) AS rating_avg,
			COUNT(*)::int                          AS rating_count
		FROM skill_reviews WHERE agent_id = ${agentId} AND skill = ${skill}
	`;

	// Notify the agent owner of a genuinely NEW review (not an edit). On a fresh
	// insert created_at === updated_at; an upsert-update bumps updated_at via the
	// trigger, so this gates out edit spam. Fire-and-forget.
	const isNew = +new Date(row.created_at) === +new Date(row.updated_at);
	if (isNew) {
		const [reviewer] = await sql`
			SELECT display_name, username FROM users WHERE id = ${auth.userId} AND deleted_at IS NULL
		`;
		publishUserEvent(agent.user_id, {
			type: 'skill_review',
			actor: reviewer?.display_name || reviewer?.username || 'Someone',
			agent_id: agentId,
			agent_name: agent.name || null,
			skill,
			rating,
			link: `/agent/${agentId}`,
		});
	}

	// Anchor the review on Solana. Fire-and-forget, never blocks the response.
	attestReview({
		reviewId: row.id,
		updatedAt: row.updated_at,
		agentId,
		rating,
		body: reviewBody,
		reviewType: 'skill',
		skill,
	}).catch((err) => {
		console.error('[review-attest] skill review anchor failed:', err.message);
	});

	return json(res, isNew ? 201 : 200, {
		data: {
			review: row,
			summary: {
				rating_avg: Number(summary?.rating_avg || 0),
				rating_count: summary?.rating_count || 0,
			},
			// Returned so the client can offer ERC-8004 user-signed anchoring.
			erc8004: agent.erc8004_agent_id
				? { agent_id: String(agent.erc8004_agent_id), chain_id: agent.chain_id }
				: null,
		},
	});
}
