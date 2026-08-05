/**
 * Model comments API: the comment thread on a model detail page (/m/:id).
 *
 *   GET    /api/forge-comments?creation_id=<uuid>&limit=&before=   (list, public)
 *   POST   /api/forge-comments   body { creation_id, body }        (session)
 *   DELETE /api/forge-comments   body { comment_id }               (author only)
 *
 * Schema: forge_comments (api/_lib/migrations/20260805120000_model_page.sql),
 * modeled on agent_reviews but many-per-user (no UNIQUE constraint) and
 * body-only (no rating; likes live on forge_votes).
 *
 * Reads are anonymous. Writes require a signed-in session (cookie or Bearer),
 * CSRF on mutations, a cheap deterministic slur pre-filter on the body, and a
 * 'comment' bell notification to the model's creator when one is attached.
 */

import { randomUUID } from 'node:crypto';
import { z } from 'zod';

import { sql } from './_lib/db.js';
import { authenticateBearer, extractBearer, getSessionUser } from './_lib/auth.js';
import { cors, error, json, method, readJson, wrap, rateLimited } from './_lib/http.js';
import { clientIp, limits } from './_lib/rate-limit.js';
import { requireCsrf } from './_lib/csrf.js';
import { isUuid } from './_lib/validate.js';
import { publishUserEvent } from './_lib/feed.js';
import { containsHateSlur } from './_lib/display-name-safety.js';

const commentSchema = z.object({
	creation_id: z.string().uuid(),
	body: z.string().trim().min(1, 'comment cannot be empty').max(2000, 'comment too long (2000 max)'),
});

async function resolveAuth(req) {
	const session = await getSessionUser(req);
	if (session) return { userId: session.id };
	const bearer = await authenticateBearer(extractBearer(req));
	if (bearer) return { userId: bearer.userId };
	return null;
}

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,POST,DELETE,OPTIONS', credentials: true })) return;
	if (req.method === 'GET') return handleList(req, res);
	if (req.method === 'POST') return handleCreate(req, res);
	if (req.method === 'DELETE') return handleDelete(req, res);
	return error(res, 405, 'method_not_allowed', 'GET/POST/DELETE only');
});

// ── list ─────────────────────────────────────────────────────────────────────

async function handleList(req, res) {
	const rl = await limits.publicIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const url = new URL(req.url, 'http://localhost');
	const creationId = url.searchParams.get('creation_id');
	if (!creationId || !isUuid(creationId)) {
		return error(res, 400, 'validation_error', 'creation_id required');
	}
	const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 30, 1), 100);
	const before = url.searchParams.get('before');
	const beforeTs = before && !Number.isNaN(Date.parse(before)) ? new Date(before) : null;

	const auth = await resolveAuth(req).catch(() => null);

	const rows = beforeTs
		? await sql`
			SELECT c.id, c.body, c.created_at, c.user_id, u.username, u.display_name, u.avatar_url
			FROM forge_comments c
			LEFT JOIN users u ON u.id = c.user_id AND u.deleted_at IS NULL
			WHERE c.creation_id = ${creationId} AND c.created_at < ${beforeTs}
			ORDER BY c.created_at DESC
			LIMIT ${limit}
		`
		: await sql`
			SELECT c.id, c.body, c.created_at, c.user_id, u.username, u.display_name, u.avatar_url
			FROM forge_comments c
			LEFT JOIN users u ON u.id = c.user_id AND u.deleted_at IS NULL
			WHERE c.creation_id = ${creationId}
			ORDER BY c.created_at DESC
			LIMIT ${limit}
		`;

	const [{ total } = { total: 0 }] = await sql`
		SELECT COUNT(*)::int AS total FROM forge_comments WHERE creation_id = ${creationId}
	`;

	return json(
		res,
		200,
		{
			comments: rows.map((r) => ({
				id: r.id,
				body: r.body,
				created_at: r.created_at,
				author_username: r.username || null,
				author_name: r.display_name || r.username || 'Deleted account',
				author_avatar: r.avatar_url || null,
				is_mine: !!auth && r.user_id === auth.userId,
			})),
			total,
			next: rows.length === limit ? rows[rows.length - 1].created_at : null,
		},
		{ 'cache-control': 'no-store' },
	);
}

// ── create ───────────────────────────────────────────────────────────────────

async function handleCreate(req, res) {
	const auth = await resolveAuth(req);
	if (!auth) return error(res, 401, 'unauthorized', 'sign in to comment');
	if (!(await requireCsrf(req, res, auth.userId))) return;

	const rl = await limits.authIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const body = await readJson(req).catch(() => null);
	const parsed = commentSchema.safeParse(body);
	if (!parsed.success) {
		return error(res, 400, 'validation_error', parsed.error.issues[0]?.message || 'invalid comment');
	}
	if (containsHateSlur(parsed.data.body)) {
		return error(res, 422, 'rejected', 'this comment cannot be posted');
	}

	const [creation] = await sql`
		SELECT id, user_id, prompt FROM forge_creations
		WHERE id = ${parsed.data.creation_id} AND status = 'done' AND glb_url IS NOT NULL
	`;
	if (!creation) return error(res, 404, 'not_found', 'model not found');

	const [author] = await sql`
		SELECT username, display_name, avatar_url FROM users
		WHERE id = ${auth.userId} AND deleted_at IS NULL
	`;
	if (!author) return error(res, 401, 'unauthorized', 'sign in to comment');

	const [row] = await sql`
		INSERT INTO forge_comments (id, creation_id, user_id, body)
		VALUES (${randomUUID()}, ${creation.id}, ${auth.userId}, ${parsed.data.body})
		RETURNING id, body, created_at
	`;

	// Tell the model's creator, when the model has one and it isn't a self-comment.
	if (creation.user_id && creation.user_id !== auth.userId) {
		publishUserEvent(creation.user_id, {
			type: 'comment',
			actor: author.display_name || author.username || 'Someone',
			creation_id: creation.id,
			preview: parsed.data.body.slice(0, 120),
			link: `/m/${creation.id}`,
		});
	}

	return json(res, 200, {
		ok: true,
		comment: {
			id: row.id,
			body: row.body,
			created_at: row.created_at,
			author_username: author.username || null,
			author_name: author.display_name || author.username || 'You',
			author_avatar: author.avatar_url || null,
			is_mine: true,
		},
	});
}

// ── delete ───────────────────────────────────────────────────────────────────

async function handleDelete(req, res) {
	const auth = await resolveAuth(req);
	if (!auth) return error(res, 401, 'unauthorized', 'sign in required');
	if (!(await requireCsrf(req, res, auth.userId))) return;

	const rl = await limits.authIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const body = await readJson(req).catch(() => null);
	const commentId = body?.comment_id;
	if (!commentId || !isUuid(commentId)) {
		return error(res, 400, 'validation_error', 'comment_id required');
	}

	const rows = await sql`
		DELETE FROM forge_comments WHERE id = ${commentId} AND user_id = ${auth.userId}
		RETURNING id
	`;
	if (!rows.length) return error(res, 404, 'not_found', 'comment not found');
	return json(res, 200, { ok: true, deleted: true });
}
