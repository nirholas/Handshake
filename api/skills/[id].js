import { z } from 'zod';
import { sql } from '../_lib/db.js';
import { getSessionUser, authenticateBearer, extractBearer } from '../_lib/auth.js';
import { cors, json, error, method, readJson, wrap, rateLimited } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { parse, isUuid } from '../_lib/validate.js';
import skillReviewHandler from './review.js';

const SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,59}$/;

const updateSchema = z.object({
	name: z.string().trim().min(2).max(80).optional(),
	description: z.string().trim().max(500).optional(),
	tags: z.array(z.string().trim().min(1).max(40)).max(20).optional(),
	is_public: z.boolean().optional(),
	schema_json: z
		.array(
			z
				.object({
					function: z
						.object({ name: z.string(), parameters: z.record(z.any()) })
						.passthrough(),
				})
				.passthrough(),
		)
		.min(1)
		.optional(),
	content: z.string().trim().max(200000).optional(),
});

export default wrap(async (req, res) => {
	// vercel.json routes /api/skills/review → /api/skills/[id]?id=review. Hand the
	// per-skill ratings & reviews path off to its own handler before the UUID gate.
	if (req.query?.id === 'review') return skillReviewHandler(req, res);

	if (cors(req, res, { methods: 'GET,PUT,DELETE,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['GET', 'PUT', 'DELETE'])) return;

	const id = req.query?.id;
	if (!id) return error(res, 404, 'not_found', 'skill not found');

	const isId = isUuid(id);
	const isSlug = SLUG_RE.test(id);
	// GET supports both UUID and slug for deep-linking; mutations require UUID
	if (req.method === 'GET') {
		if (!isId && !isSlug) return error(res, 404, 'not_found', 'skill not found');
		return handleGet(req, res, id, isId);
	}
	if (!isId) return error(res, 404, 'not_found', 'skill not found');
	if (req.method === 'PUT') return handleUpdate(req, res, id);
	return handleDelete(req, res, id);
});

async function resolveOptionalAuth(req) {
	const session = await getSessionUser(req);
	if (session) return { userId: session.id, plan: session.plan };
	const bearer = await authenticateBearer(extractBearer(req));
	if (bearer) return { userId: bearer.userId, plan: null };
	return null;
}

function toSkill(row, { includeInstalled = false } = {}) {
	const skill = {
		id: row.id,
		name: row.name,
		slug: row.slug,
		description: row.description,
		category: row.category,
		tags: row.tags || [],
		install_count: row.install_count || 0,
		avg_rating: Number(row.avg_rating) || 0,
		rating_count: row.rating_count || 0,
		schema_json: row.schema_json,
		content: row.content ?? null,
		author: row.author_id
			? { id: row.author_id, display_name: row.author_display_name }
			: null,
		created_at: row.created_at,
	};
	if (includeInstalled) skill.installed = !!row.installed;
	return skill;
}

async function handleGet(req, res, id, isId = true) {
	const rl = await limits.publicIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const auth = await resolveOptionalAuth(req);
	const userId = auth?.userId ?? null;

	const [row] = isId
		? await sql`
			SELECT
				ms.*,
				u.display_name AS author_display_name,
				ROUND(COALESCE(AVG(sr.rating), 0)::numeric, 1)::float AS avg_rating,
				COUNT(sr.rating)::int AS rating_count,
				CASE WHEN ${userId}::uuid IS NOT NULL
					THEN EXISTS(
						SELECT 1 FROM skill_installs si
						WHERE si.skill_id = ms.id AND si.user_id = ${userId}::uuid
					)
					ELSE NULL END AS installed
			FROM marketplace_skills ms
			LEFT JOIN users u ON u.id = ms.author_id AND u.deleted_at IS NULL
			LEFT JOIN skill_ratings sr ON sr.skill_id = ms.id
			WHERE ms.id = ${id} AND ms.is_public = true
			GROUP BY ms.id, ms.author_id, u.display_name
		`
		: await sql`
			SELECT
				ms.*,
				u.display_name AS author_display_name,
				ROUND(COALESCE(AVG(sr.rating), 0)::numeric, 1)::float AS avg_rating,
				COUNT(sr.rating)::int AS rating_count,
				CASE WHEN ${userId}::uuid IS NOT NULL
					THEN EXISTS(
						SELECT 1 FROM skill_installs si
						WHERE si.skill_id = ms.id AND si.user_id = ${userId}::uuid
					)
					ELSE NULL END AS installed
			FROM marketplace_skills ms
			LEFT JOIN users u ON u.id = ms.author_id AND u.deleted_at IS NULL
			LEFT JOIN skill_ratings sr ON sr.skill_id = ms.id
			WHERE ms.slug = ${id} AND ms.is_public = true
			GROUP BY ms.id, ms.author_id, u.display_name
		`;

	if (!row) return error(res, 404, 'not_found', 'skill not found');

	return json(res, 200, { skill: toSkill(row, { includeInstalled: userId != null }) });
}

async function handleUpdate(req, res, id) {
	const auth = await resolveOptionalAuth(req);
	if (!auth) return error(res, 401, 'unauthorized', 'sign in required');

	const rl = await limits.chatUser(auth.userId);
	if (!rl.success) return rateLimited(res, rl);

	const [skill] = await sql`
		SELECT id, author_id FROM marketplace_skills WHERE id = ${id}
	`;
	if (!skill) return error(res, 404, 'not_found', 'skill not found');

	if (skill.author_id !== auth.userId) {
		// Fallback: check admin status via DB (handles bearer auth where plan isn't cached)
		const [u] = await sql`SELECT plan FROM users WHERE id = ${auth.userId} AND deleted_at IS NULL`;
		if (u?.plan !== 'admin') return error(res, 403, 'forbidden', 'not your skill');
	}

	const body = parse(updateSchema, await readJson(req));
	if (Object.keys(body).length === 0) {
		return error(res, 400, 'validation_error', 'no fields to update');
	}

	const setFrags = [];
	const params = [];
	if (body.name !== undefined) {
		params.push(body.name);
		setFrags.push(`name = $${params.length}`);
	}
	if (body.description !== undefined) {
		params.push(body.description);
		setFrags.push(`description = $${params.length}`);
	}
	if (body.tags !== undefined) {
		params.push(body.tags);
		setFrags.push(`tags = $${params.length}`);
	}
	if (body.is_public !== undefined) {
		params.push(body.is_public);
		setFrags.push(`is_public = $${params.length}`);
	}
	if (body.schema_json !== undefined) {
		params.push(JSON.stringify(body.schema_json));
		setFrags.push(`schema_json = $${params.length}::jsonb`);
	}
	if (body.content !== undefined) {
		params.push(body.content);
		setFrags.push(`content = $${params.length}`);
	}
	setFrags.push(`updated_at = now()`);

	params.push(id);
	const idIdx = params.length;

	const [updated] = await sql(
		`UPDATE marketplace_skills SET ${setFrags.join(', ')} WHERE id = $${idIdx} RETURNING *`,
		params,
	);

	const [author] = updated.author_id
		? await sql`SELECT id, display_name FROM users WHERE id = ${updated.author_id}`
		: [null];
	updated.author_display_name = author?.display_name ?? null;

	// Re-read the live aggregate. Hardcoding zeros here reported a freshly
	// edited skill as unrated, and the marketplace detail view re-renders from
	// this response, so an author editing a description watched their rating
	// disappear until the next reload.
	const [stats] = await sql`
		SELECT
			ROUND(COALESCE(AVG(rating), 0)::numeric, 1)::float AS avg_rating,
			COUNT(rating)::int AS rating_count
		FROM skill_ratings
		WHERE skill_id = ${id}
	`;
	updated.avg_rating = stats?.avg_rating ?? 0;
	updated.rating_count = stats?.rating_count ?? 0;

	return json(res, 200, { skill: toSkill(updated) });
}

async function handleDelete(req, res, id) {
	const auth = await resolveOptionalAuth(req);
	if (!auth) return error(res, 401, 'unauthorized', 'sign in required');

	const rl = await limits.chatUser(auth.userId);
	if (!rl.success) return rateLimited(res, rl);

	const [skill] = await sql`
		SELECT id, author_id FROM marketplace_skills WHERE id = ${id}
	`;
	if (!skill) return error(res, 404, 'not_found', 'skill not found');
	if (skill.author_id !== auth.userId) return error(res, 403, 'forbidden', 'not your skill');

	// skill_installs and skill_ratings cascade-delete on marketplace_skills delete
	await sql`DELETE FROM marketplace_skills WHERE id = ${id}`;

	res.statusCode = 204;
	res.end();
}
