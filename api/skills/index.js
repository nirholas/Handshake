import { z } from 'zod';
import { sql } from '../_lib/db.js';
import { getSessionUser, authenticateBearer, extractBearer } from '../_lib/auth.js';
import { cors, json, error, method, readJson, wrap, rateLimited } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { parse, isUuid } from '../_lib/validate.js';

const CATEGORY_RE = /^[a-z0-9-]{1,50}$/;
const VALID_SORTS = new Set(['popular', 'new', 'az']);
const DEFAULT_SORT = 'popular';

const skillSlug = z
	.string()
	.trim()
	.min(1)
	.max(60)
	.regex(/^[a-z0-9-]+$/, 'slug must be lowercase alphanumeric with hyphens');

const publishSchema = z.object({
	name: z.string().trim().min(2).max(80),
	slug: skillSlug,
	description: z.string().trim().max(500),
	category: z.string().trim().min(1).max(50).default('general'),
	tags: z.array(z.string().trim().min(1).max(40)).max(20).default([]),
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
	content: z.string().trim().min(1).max(200000).optional(),
	is_public: z.boolean().default(true),
	price_per_call_usd: z.number().min(0).max(10).default(0),
});

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,POST,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['GET', 'POST'])) return;

	if (req.method === 'GET') return handleList(req, res);
	return handlePublish(req, res);
});

async function resolveOptionalAuth(req) {
	const session = await getSessionUser(req);
	if (session) return { userId: session.id, plan: session.plan };
	const bearer = await authenticateBearer(extractBearer(req));
	if (bearer) return { userId: bearer.userId, plan: null };
	return null;
}

function toSkill(row, { includeInstalled = false, includeSchema = false, includeContent = false } = {}) {
	const hasContent = typeof row.content === 'string' && row.content.length > 0;
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
		price_per_call_usd: Number(row.price_per_call_usd) || 0,
		author: row.author_id
			? { id: row.author_id, display_name: row.author_display_name }
			: null,
		created_at: row.created_at,
		has_content: hasContent,
		content_preview: hasContent ? row.content.slice(0, 280) : null,
	};
	if (includeInstalled) skill.installed = !!row.installed;
	if (includeSchema) skill.schema_json = row.schema_json ?? null;
	if (includeContent) skill.content = hasContent ? row.content : null;
	return skill;
}

async function handleList(req, res) {
	const url = new URL(req.url, 'http://x');
	const q = (url.searchParams.get('q') || '').trim().slice(0, 80) || null;
	const categoryRaw = url.searchParams.get('category');
	const sortParam = url.searchParams.get('sort') || '';
	const cursor = url.searchParams.get('cursor') || null;
	const limit = Math.min(50, Math.max(1, Number(url.searchParams.get('limit')) || 20));
	const installedOnly = url.searchParams.get('installed') === 'true';

	let category = null;
	if (categoryRaw != null && categoryRaw !== '') {
		if (!CATEGORY_RE.test(categoryRaw)) {
			return error(
				res,
				400,
				'validation_error',
				'category must be a slug (lowercase letters, digits, hyphens)',
			);
		}
		category = categoryRaw;
	}

	let sort = DEFAULT_SORT;
	if (sortParam) {
		if (VALID_SORTS.has(sortParam)) {
			sort = sortParam;
		} else {
			console.warn('[api/skills] unknown sort, falling back to default', {
				sort: sortParam,
				url: req.url,
			});
		}
	}

	const rl = await limits.skillsBrowse(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const auth = await resolveOptionalAuth(req);
	const userId = auth?.userId ?? null;

	if (installedOnly && !userId) {
		return error(res, 401, 'unauthorized', 'sign in required to filter by installed');
	}

	if (cursor && !isUuid(cursor)) {
		return error(res, 400, 'validation_error', 'invalid cursor');
	}

	const qLike = q ? `%${q}%` : null;

	// Fetch cursor pivot values for keyset pagination
	let cursorInstallCount = null;
	let cursorCreatedAt = null;
	let cursorName = null;
	if (cursor) {
		const [cr] = await sql`
			SELECT install_count, created_at, name
			FROM marketplace_skills
			WHERE id = ${cursor} AND is_public = true
		`;
		if (cr) {
			cursorInstallCount = cr.install_count;
			cursorCreatedAt = cr.created_at;
			cursorName = cr.name;
		}
	}

	// Neon's tagged-template `sql` does not compose nested fragments — each
	// interpolation becomes a positional `$N` parameter. So we branch the full
	// query per sort instead of building it from sql`...` fragments.
	const rows = await runListQuery({
		sort,
		userId,
		category,
		qLike,
		installedOnly,
		cursor,
		cursorInstallCount,
		cursorCreatedAt,
		cursorName,
		limit,
	});

	const hasMore = rows.length > limit;
	// The caller's own installed set (`?installed=true`) returns the full
	// payload (content + schema_json) so clients can hydrate an agent from one
	// request. Public browse lists stay slim: preview + has_content only.
	const skills = rows.slice(0, limit).map((r) =>
		toSkill(r, {
			includeInstalled: userId != null,
			includeSchema: installedOnly,
			includeContent: installedOnly,
		}),
	);

	const cacheHeaders = userId
		? {}
		: { 'cache-control': 'public, s-maxage=15, stale-while-revalidate=30' };

	return json(res, 200, { skills, next_cursor: hasMore ? rows[limit - 1].id : null }, cacheHeaders);
}

function runListQuery(p) {
	const {
		sort,
		userId,
		category,
		qLike,
		installedOnly,
		cursor,
		cursorInstallCount,
		cursorCreatedAt,
		cursorName,
		limit,
	} = p;

	const limitPlus = limit + 1;

	if (sort === 'new') {
		const cursorActive = Boolean(cursor && cursorCreatedAt != null);
		return sql`
			SELECT
				ms.id, ms.name, ms.slug, ms.description, ms.category, ms.tags,
				ms.install_count, ms.created_at, ms.author_id, ms.price_per_call_usd, ms.content,
				CASE WHEN ${installedOnly} THEN ms.schema_json END AS schema_json,
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
			WHERE ms.is_public = true
				AND (
					NOT ${cursorActive}
					OR ms.created_at < ${cursorCreatedAt}::timestamptz
					OR (ms.created_at = ${cursorCreatedAt}::timestamptz AND ms.id::text < ${cursor}::text)
				)
				AND (${category}::text IS NULL OR ms.category = ${category})
				AND (
					${qLike}::text IS NULL
					OR ms.name ILIKE ${qLike}
					OR ms.description ILIKE ${qLike}
					OR EXISTS (SELECT 1 FROM unnest(ms.tags) t WHERE t ILIKE ${qLike})
				)
				AND (
					NOT ${installedOnly}
					OR EXISTS(
						SELECT 1 FROM skill_installs
						WHERE skill_id = ms.id AND user_id = ${userId}::uuid
					)
				)
			GROUP BY ms.id, ms.author_id, u.display_name
			ORDER BY ms.created_at DESC, ms.id DESC
			LIMIT ${limitPlus}
		`;
	}

	if (sort === 'az') {
		const cursorActive = Boolean(cursor && cursorName != null);
		return sql`
			SELECT
				ms.id, ms.name, ms.slug, ms.description, ms.category, ms.tags,
				ms.install_count, ms.created_at, ms.author_id, ms.price_per_call_usd, ms.content,
				CASE WHEN ${installedOnly} THEN ms.schema_json END AS schema_json,
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
			WHERE ms.is_public = true
				AND (
					NOT ${cursorActive}
					OR ms.name > ${cursorName}::text
					OR (ms.name = ${cursorName}::text AND ms.id::text > ${cursor}::text)
				)
				AND (${category}::text IS NULL OR ms.category = ${category})
				AND (
					${qLike}::text IS NULL
					OR ms.name ILIKE ${qLike}
					OR ms.description ILIKE ${qLike}
					OR EXISTS (SELECT 1 FROM unnest(ms.tags) t WHERE t ILIKE ${qLike})
				)
				AND (
					NOT ${installedOnly}
					OR EXISTS(
						SELECT 1 FROM skill_installs
						WHERE skill_id = ms.id AND user_id = ${userId}::uuid
					)
				)
			GROUP BY ms.id, ms.author_id, u.display_name
			ORDER BY ms.name ASC, ms.id ASC
			LIMIT ${limitPlus}
		`;
	}

	// popular (default)
	const cursorActive = Boolean(cursor && cursorInstallCount != null);
	return sql`
		SELECT
			ms.id, ms.name, ms.slug, ms.description, ms.category, ms.tags,
			ms.install_count, ms.created_at, ms.author_id, ms.price_per_call_usd, ms.content,
			CASE WHEN ${installedOnly} THEN ms.schema_json END AS schema_json,
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
		WHERE ms.is_public = true
			AND (
				NOT ${cursorActive}
				OR ms.install_count < ${cursorInstallCount}::integer
				OR (ms.install_count = ${cursorInstallCount}::integer AND ms.id::text < ${cursor}::text)
			)
			AND (${category}::text IS NULL OR ms.category = ${category})
			AND (
				${qLike}::text IS NULL
				OR ms.name ILIKE ${qLike}
				OR ms.description ILIKE ${qLike}
				OR EXISTS (SELECT 1 FROM unnest(ms.tags) t WHERE t ILIKE ${qLike})
			)
			AND (
				NOT ${installedOnly}
				OR EXISTS(
					SELECT 1 FROM skill_installs
					WHERE skill_id = ms.id AND user_id = ${userId}::uuid
				)
			)
		GROUP BY ms.id, ms.author_id, u.display_name
		ORDER BY ms.install_count DESC, ms.id DESC
		LIMIT ${limitPlus}
	`;
}

async function handlePublish(req, res) {
	const auth = await resolveOptionalAuth(req);
	if (!auth) return error(res, 401, 'unauthorized', 'sign in required');

	const rl = await limits.chatUser(auth.userId);
	if (!rl.success) return rateLimited(res, rl);

	const body = parse(publishSchema, await readJson(req));

	if (!body.schema_json && !body.content) {
		return error(res, 400, 'validation_error', 'skill must have schema_json or content');
	}

	let row;
	try {
		[row] = await sql`
			INSERT INTO marketplace_skills (author_id, name, slug, description, category, tags, schema_json, content, is_public, price_per_call_usd)
			VALUES (
				${auth.userId},
				${body.name},
				${body.slug},
				${body.description},
				${body.category},
				${body.tags},
				${body.schema_json ? JSON.stringify(body.schema_json) : null}::jsonb,
				${body.content ?? null},
				${body.is_public},
				${body.price_per_call_usd}
			)
			RETURNING *
		`;
	} catch (err) {
		if (err.code === '23505') return error(res, 409, 'conflict', 'slug already taken');
		throw err;
	}

	const [author] = await sql`SELECT id, display_name FROM users WHERE id = ${auth.userId}`;
	row.author_id = author.id;
	row.author_display_name = author.display_name;
	row.avg_rating = 0;
	row.rating_count = 0;

	return json(res, 201, { skill: toSkill(row, { includeInstalled: true, includeSchema: true }) });
}
