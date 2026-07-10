/**
 * Agent Marketplace API
 * ---------------------
 * GET    /api/marketplace/categories
 * GET    /api/marketplace/agents              ?category=&q=&sort=&cursor=&pricing=
 * POST   /api/marketplace/agents              — create a new agent
 * GET    /api/marketplace/agents/mine         — caller's own agents (auth required)
 * GET    /api/marketplace/agents/:id
 * GET    /api/marketplace/agents/:id/versions
 * GET    /api/marketplace/agents/:id/similar
 * POST   /api/marketplace/agents/:id/fork
 * POST   /api/marketplace/agents/:id/bookmark
 * DELETE /api/marketplace/agents/:id/bookmark
 * POST   /api/marketplace/agents/:id/publish
 * POST   /api/marketplace/agents/:id/view
 *
 * Routed via vercel.json — see top of file path patterns.
 */

import { sql, isDbUnavailableError } from '../_lib/db.js';
import { authenticateBearer, extractBearer, getSessionUser } from '../_lib/auth.js';
import { cors, error, json, method, readJson, wrap, rateLimited } from '../_lib/http.js';
import { publicUrl, thumbnailUrl } from '../_lib/r2.js';
import { pedigreeScore } from '../_lib/genome.js';
import { clientIp, limits } from '../_lib/rate-limit.js';
import { markProviderCooldown, AUTH_COOLDOWN_SECONDS } from '../_lib/provider-health.js';
import { getSkillPrices, skillPriceMap } from '../_lib/skill-price-cache.js';
import { viewerNftGatedSkills } from '../_lib/nft-gate.js';
import { z } from 'zod';
import { isUuid } from '../_lib/validate.js';
import { getRedis } from '../_lib/redis.js';

const CATEGORIES = [
	'academic',
	'career',
	'copywriting',
	'design',
	'education',
	'emotions',
	'entertainment',
	'games',
	'general',
	'life',
	'marketing',
	'office',
	'programming',
	'translation',
];

const SORTS = new Set(['recommended', 'recent', 'popular', 'top_rated']);

// Auto-named / stub agent names that should never appear in the public
// marketplace. Sources: api/agents.js default ('Agent'), seed-default-agent.js
// ('My First Agent'), src/create.js + src/app.js ('My Agent'), avatar imports
// ('Avatar #abcdef' or '<avatar> agent'), and obvious test/placeholder strings.
// Postgres POSIX regex — anchored explicitly because `~*` is unanchored.
const AGENT_AUTONAMED_RE_SQL =
	'^(Agent|My Agent|My First Agent|Demo Agent|Untitled.*|TEST|Test|test|mo[a-z0-9]{4,}|draft-[a-z0-9]+|new_project_[0-9]+|Avatar[ ]*#[0-9a-f]{4,}([ ]*agent)?|https?://.+)$';

const createAgentSchema = z.object({
	name: z.string().trim().min(1, 'name required').max(100),
	description: z.string().trim().min(1, 'description required').max(500),
	system_prompt: z.string().trim().min(1, 'system prompt required').max(16000),
	greeting: z.string().trim().max(1000).nullable().optional(),
	category: z.enum(CATEGORIES).default('general'),
	tags: z
		.array(z.string().trim().toLowerCase().min(1).max(40))
		.max(12)
		.default([]),
	capabilities: z
		.object({
			bullets: z.array(z.string().max(200)).max(20).default([]),
			skills: z.array(z.any()).max(50).default([]),
			library: z.array(z.any()).max(50).default([]),
		})
		.default({}),
	avatar_id: z.string().uuid().optional().nullable(),
	publish: z.boolean().default(true),
});

export default wrap(async (req, res) => {
	const url = new URL(req.url, 'http://x');
	const parts = url.pathname.split('/').filter(Boolean); // ['api','marketplace',...]
	const head = parts[2]; // 'categories' | 'agents'
	const id = parts[3];
	const sub = parts[4];

	if (head === 'categories') return handleCategories(req, res);
	if (head === 'theme') return handleTheme(req, res);

	if (head === 'agents') {
		if (!id) {
			if (req.method === 'POST' || (req.method === 'OPTIONS' && req.headers['access-control-request-method'] === 'POST'))
				return handleCreate(req, res);
			return handleList(req, res, url);
		}
		if (id === 'mine') return handleMine(req, res);
		if (!isUuid(id)) return error(res, 404, 'not_found', 'agent not found');
		if (!sub) return handleDetail(req, res, id);
		if (sub === 'versions') return handleVersions(req, res, id);
		if (sub === 'similar') return handleSimilar(req, res, id);
		if (sub === 'fork') return handleFork(req, res, id);
		if (sub === 'bookmark') return handleBookmark(req, res, id);
		if (sub === 'publish') return handlePublish(req, res, id);
		if (sub === 'view') return handleView(req, res, id);
		if (sub === 'preview') return handlePreview(req, res, id);
		if (sub === 'reviews') {
			const mod = await import('./reviews.js');
			req.url = req.url.includes('?')
				? `${req.url}&agent_id=${id}`
				: `${req.url}?agent_id=${id}`;
			return mod.default(req, res);
		}
		return error(res, 404, 'not_found', 'unknown marketplace action');
	}

	return error(res, 404, 'not_found', 'unknown marketplace action');
});

// ── Auth ───────────────────────────────────────────────────────────────────

async function resolveAuth(req) {
	const session = await getSessionUser(req);
	if (session) return { userId: session.id };
	const bearer = await authenticateBearer(extractBearer(req));
	if (bearer) return { userId: bearer.userId };
	return null;
}

// ── Categories ─────────────────────────────────────────────────────────────

async function handleCategories(req, res) {
	if (cors(req, res, { methods: 'GET,OPTIONS' })) return;
	if (!method(req, res, ['GET'])) return;

	const rl = await limits.widgetRead(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const rows = await sql`
		SELECT category, count(*)::int AS count
		FROM agent_identities
		WHERE is_published = true AND deleted_at IS NULL
		GROUP BY category
	`;
	const counts = Object.fromEntries(
		rows.filter((r) => r.category).map((r) => [r.category, r.count]),
	);
	const total = rows.reduce((s, r) => s + r.count, 0);
	return json(
		res,
		200,
		{
			data: {
				total,
				categories: CATEGORIES.map((slug) => ({ slug, count: counts[slug] || 0 })),
			},
		},
		{ 'cache-control': 'public, max-age=60' },
	);
}

// ── Weekly theme strip ──────────────────────────────────────────────────────

// Rotate through categories by week number so the strip feels curated without
// requiring manual editor input. Deterministic: same week = same category.
const THEME_CATEGORIES = [
	{ slug: 'programming', title: 'Code & Dev Tools', blurb: 'Agents that write, review, and debug code.' },
	{ slug: 'marketing', title: 'Marketing & Growth', blurb: 'AI that crafts copy, campaigns, and SEO.' },
	{ slug: 'education', title: 'Learn Anything', blurb: 'Tutors, explainers, and knowledge companions.' },
	{ slug: 'design', title: 'Creative Design', blurb: 'Image concepts, design briefs, and visual direction.' },
	{ slug: 'general', title: 'Top Picks This Week', blurb: 'The community\'s most-viewed agents right now.' },
	{ slug: 'entertainment', title: 'Fun & Games', blurb: 'Storytellers, role-players, and game companions.' },
	{ slug: 'career', title: 'Career & Productivity', blurb: 'Résumés, interview prep, and workplace tools.' },
];

async function handleTheme(req, res) {
	if (cors(req, res, { methods: 'GET,OPTIONS' })) return;
	if (!method(req, res, ['GET'])) return;

	const rl = await limits.widgetRead(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const weekNum = Math.floor(Date.now() / (7 * 24 * 3600 * 1000));
	const cat = THEME_CATEGORIES[weekNum % THEME_CATEGORIES.length];

	// Top Picks pulls a randomized lineup of the community's most-viewed agents
	// that actually carry a public 3D avatar — every pick renders a real GLB,
	// and the order reshuffles per request so the strip always feels alive.
	// We INNER JOIN avatars (not LEFT) so agents without a 3D asset never appear.
	// Strategy: take the top-by-views pool, then `random()` within it. Themed
	// weeks scope to their category but fall back to the global pool when that
	// category has too few 3D-backed agents to fill the strip.
	const PICKS_LIMIT = 12;
	const POOL_SIZE = 60;

	// Two literal variants instead of composed `sql` fragments: the Neon HTTP
	// driver binds interpolations as parameters and doesn't support nested
	// tagged-template fragments. The no-ratings variant is the fallback for
	// databases without the agent_reviews table/columns yet.
	function queryWithRatings(scopeToCategory) {
		return sql`
			WITH pool AS (
				SELECT a.id, a.name, a.description, a.category, a.tags, a.skills,
				       a.views_count, a.forks_count,
				       COALESCE((SELECT AVG(rating)::numeric(3,2) FROM agent_reviews r WHERE r.agent_id = a.id), 0) AS rating_avg,
				       COALESCE((SELECT COUNT(*) FROM agent_reviews r WHERE r.agent_id = a.id), 0) AS rating_count,
				       a.published_at, a.created_at,
				       v.storage_key AS avatar_storage_key,
				       v.thumbnail_key
				FROM agent_identities a
				JOIN avatars v ON v.id = a.avatar_id AND v.deleted_at IS NULL
				WHERE a.is_published = true AND a.deleted_at IS NULL
				  AND v.storage_key IS NOT NULL
				  AND (v.visibility IS NULL OR v.visibility IN ('public', 'unlisted'))
				  AND (${!scopeToCategory} OR a.category = ${cat.slug})
				ORDER BY a.views_count DESC NULLS LAST
				LIMIT ${POOL_SIZE}
			)
			SELECT * FROM pool ORDER BY random() LIMIT ${PICKS_LIMIT}
		`;
	}
	function queryNoRatings(scopeToCategory) {
		return sql`
			WITH pool AS (
				SELECT a.id, a.name, a.description, a.category, a.tags, a.skills,
				       a.views_count, a.forks_count,
				       0::numeric AS rating_avg, 0::int AS rating_count,
				       a.published_at, a.created_at,
				       v.storage_key AS avatar_storage_key,
				       v.thumbnail_key
				FROM agent_identities a
				JOIN avatars v ON v.id = a.avatar_id AND v.deleted_at IS NULL
				WHERE a.is_published = true AND a.deleted_at IS NULL
				  AND v.storage_key IS NOT NULL
				  AND (v.visibility IS NULL OR v.visibility IN ('public', 'unlisted'))
				  AND (${!scopeToCategory} OR a.category = ${cat.slug})
				ORDER BY a.views_count DESC NULLS LAST
				LIMIT ${POOL_SIZE}
			)
			SELECT * FROM pool ORDER BY random() LIMIT ${PICKS_LIMIT}
		`;
	}

	const scopeToCategory = cat.slug !== 'general';
	let rows;
	try {
		rows = await queryWithRatings(scopeToCategory);
		// A themed category with a thin 3D lineup falls back to the global pool
		// so the strip is never half-empty.
		if (scopeToCategory && rows.length < 4) rows = await queryWithRatings(false);
	} catch (err) {
		// 42P01 = table does not exist, 42703 = column does not exist (e.g. no
		// reviews table yet). Retry without the rating subqueries.
		if (err.code === '42P01' || err.code === '42703') {
			rows = await queryNoRatings(scopeToCategory);
			if (scopeToCategory && rows.length < 4) rows = await queryNoRatings(false);
		} else {
			throw err;
		}
	}

	const agents = rows.map((row) => ({
		id: row.id,
		name: row.name,
		description: row.description,
		category: row.category,
		tags: row.tags || [],
		skills: row.skills || [],
		views_count: row.views_count || 0,
		forks_count: row.forks_count || 0,
		rating_avg: Number(row.rating_avg || 0),
		rating_count: row.rating_count || 0,
		thumbnail_url: thumbnailUrl(row.thumbnail_key),
		avatar_glb_url: row.avatar_storage_key ? publicUrl(row.avatar_storage_key) : null,
		published_at: row.published_at,
	}));

	return json(
		res,
		200,
		{ data: { theme: { title: cat.title, blurb: cat.blurb, category: cat.slug, agents } } },
		// Short cache: the lineup is randomized per request, so a long freeze would
		// defeat the shuffle. The client reshuffles on top of this for per-load variety.
		{ 'cache-control': 'public, max-age=120, stale-while-revalidate=600' },
	);
}

// ── Create ─────────────────────────────────────────────────────────────────

async function handleCreate(req, res) {
	if (cors(req, res, { methods: 'POST,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['POST'])) return;

	const auth = await resolveAuth(req);
	if (!auth) return error(res, 401, 'unauthorized', 'sign in required');

	const rl = await limits.authIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	let body = await readJson(req).catch(() => null);
	if (!body) return error(res, 400, 'validation_error', 'request body required');

	// Accept LobeHub-compatible JSON import: { json: { config, meta } }
	if (body.json && typeof body.json === 'object') {
		const j = body.json;
		body = {
			name: j.meta?.title || j.meta?.name || '',
			description: j.meta?.description || '',
			system_prompt: j.config?.systemRole || '',
			greeting: j.config?.greeting || null,
			category: j.meta?.category || 'general',
			tags: j.meta?.tags || [],
			capabilities: j.meta?.capabilities || {},
		};
	}

	const parsed = createAgentSchema.safeParse(body);
	if (!parsed.success) {
		const msg = parsed.error.issues[0]?.message || 'validation error';
		return error(res, 400, 'validation_error', msg);
	}

	const { name, description, system_prompt, greeting, category, tags, capabilities, avatar_id, publish } =
		parsed.data;
	const publishedAt = publish ? new Date().toISOString() : null;

	// avatar_id: only attach if the avatar exists, is owned by the caller OR is
	// a public/unlisted community avatar. Demo IDs (avatar_demo_*) are not real
	// DB rows — silently drop them; the caller can still upload their own.
	let resolvedAvatarId = null;
	if (avatar_id && !avatar_id.startsWith('avatar_demo_')) {
		const rows = await sql`
			SELECT id FROM avatars
			WHERE id = ${avatar_id}
			  AND deleted_at IS NULL
			  AND (owner_id = ${auth.userId} OR visibility IN ('public', 'unlisted'))
			LIMIT 1
		`;
		if (rows[0]) resolvedAvatarId = rows[0].id;
	}

	const [agent] = await sql`
		INSERT INTO agent_identities (
			user_id, name, description, system_prompt, greeting,
			category, tags, capabilities, avatar_id, is_published, published_at
		)
		VALUES (
			${auth.userId}, ${name}, ${description}, ${system_prompt}, ${greeting ?? null},
			${category}, ${tags}, ${JSON.stringify(capabilities)}::jsonb,
			${resolvedAvatarId}, ${publish}, ${publishedAt}
		)
		RETURNING *
	`;

	if (publish) {
		await sql`
			INSERT INTO agent_versions (
				agent_id, version, system_prompt, greeting, category, tags, capabilities, changelog, created_by
			)
			VALUES (
				${agent.id}, 1, ${system_prompt}, ${greeting ?? null}, ${category}, ${tags},
				${JSON.stringify(capabilities)}::jsonb, 'Initial release', ${auth.userId}
			)
		`;
	}

	return json(res, 201, {
		data: { agent: toDetail({ ...agent, author_name: null, author_avatar: null }, {}, auth.userId) },
	});
}

// ── Mine ───────────────────────────────────────────────────────────────────

async function handleMine(req, res) {
	if (cors(req, res, { methods: 'GET,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['GET'])) return;

	const auth = await resolveAuth(req);
	if (!auth) return error(res, 401, 'unauthorized', 'sign in required');

	const rl = await limits.widgetRead(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const rows = await sql`
		SELECT ai.id, ai.name, ai.description, ai.category, ai.tags, ai.avatar_id, ai.user_id,
		       ai.forks_count, ai.views_count, ai.published_at, ai.created_at, ai.skills,
		       ai.is_published, av.thumbnail_key,
		       av.storage_key AS avatar_storage_key,
		       av.visibility AS avatar_visibility,
		       ap.amount        AS asset_price_amount,
		       ap.currency_mint AS asset_price_currency_mint,
		       ap.chain         AS asset_price_chain,
		       ap.mint_decimals AS asset_price_mint_decimals
		FROM agent_identities ai
		LEFT JOIN avatars av ON av.id = ai.avatar_id AND av.deleted_at IS NULL
		LEFT JOIN asset_prices ap
		       ON ap.item_type = 'agent' AND ap.item_id = ai.id AND ap.is_active = true
		WHERE ai.user_id = ${auth.userId} AND ai.deleted_at IS NULL
		ORDER BY ai.created_at DESC
		LIMIT 100
	`;

	return json(res, 200, {
		data: {
			// The "mine" listing is always the caller's own agents — owner everywhere.
			items: rows.map((r) => ({ ...toCard(r), is_published: r.is_published, is_owner: true })),
		},
	});
}

// ── List ───────────────────────────────────────────────────────────────────

async function handleList(req, res, url) {
	if (cors(req, res, { methods: 'GET,OPTIONS' })) return;
	if (!method(req, res, ['GET'])) return;

	const rl = await limits.widgetRead(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const category = url.searchParams.get('category') || null;
	const q = (url.searchParams.get('q') || '').trim().slice(0, 80);
	const sort = SORTS.has(url.searchParams.get('sort')) ? url.searchParams.get('sort') : 'recommended';
	const limit = Math.min(48, Math.max(1, Number(url.searchParams.get('limit')) || 24));
	const cursor = url.searchParams.get('cursor');
	const offset = cursor ? Math.max(0, Number(cursor) || 0) : 0;

	// Monetization filter. An agent counts as "paid" when it sells access in any
	// form: a one-time asset price (asset_prices) OR per-call skill pricing
	// (agent_skill_prices). "free" requires neither. Filtering server-side keeps
	// pagination honest — a client-side pass would show 3-of-24 fetched rows and
	// hide the rest of the matching agents on later pages.
	const pricingRaw = url.searchParams.get('pricing');
	const pricing = pricingRaw === 'paid' || pricingRaw === 'free' ? pricingRaw : null;

	const orderBy =
		sort === 'recent'
			? sql`published_at DESC NULLS LAST, created_at DESC`
			: sort === 'popular'
				? sql`(forks_count + views_count) DESC, published_at DESC NULLS LAST`
				: sort === 'top_rated'
					? sql`rating_avg DESC NULLS LAST, rating_count DESC, published_at DESC NULLS LAST`
					: sql`(forks_count * 5 + views_count) DESC, published_at DESC NULLS LAST`;

	const cat = category && CATEGORIES.includes(category) ? category : null;
	const qLike = q ? `%${q}%` : null;

	let rows;
	try {
		[, rows] = await sql.transaction([
		sql`SET LOCAL statement_timeout = '8000'`,
		sql`
			SELECT ai.id, ai.name, ai.description, ai.category, ai.tags, ai.avatar_id, ai.user_id,
			       ai.forks_count, ai.views_count, ai.published_at, ai.created_at, ai.skills,
			       av.thumbnail_key,
			       av.storage_key AS avatar_storage_key,
			       av.visibility AS avatar_visibility,
			       ai.meta->'onchain' AS onchain,
			       ai.meta->'token'   AS token,
			       ai.meta->>'solana_address'       AS solana_address,
			       ai.meta->>'solana_vanity_prefix' AS solana_vanity_prefix,
			       ai.meta->>'solana_vanity_suffix' AS solana_vanity_suffix,
			       ai.meta->'genome' AS genome,
			       (ai.meta ? 'bred_from') AS bred,
				   u.display_name AS author_name,
			       EXISTS (
			         SELECT 1 FROM agent_skill_prices asp
			         WHERE asp.agent_id = ai.id AND asp.is_active = true
			       ) AS has_paid_skills,
			       COALESCE((SELECT count(*)::int FROM skill_purchases sp
			        WHERE sp.agent_id = ai.id AND sp.status = 'confirmed'), 0) AS buyers_total,
			       COALESCE((SELECT count(*)::int FROM skill_purchases sp
			        WHERE sp.agent_id = ai.id AND sp.status = 'confirmed'
			          AND sp.created_at > now() - interval '24 hours'), 0) AS buyers_24h,
			       COALESCE((SELECT AVG(rating)::numeric(3,2) FROM agent_reviews r WHERE r.agent_id = ai.id), 0) AS rating_avg,
			       COALESCE((SELECT count(*)::int FROM agent_reviews r WHERE r.agent_id = ai.id), 0) AS rating_count,
			       ap.amount        AS asset_price_amount,
			       ap.currency_mint AS asset_price_currency_mint,
			       ap.chain         AS asset_price_chain,
			       ap.mint_decimals AS asset_price_mint_decimals,
			       os.oracle_total, os.oracle_wins, os.oracle_win_rate, os.oracle_pnl_sol
			FROM agent_identities ai
			LEFT JOIN avatars av ON av.id = ai.avatar_id AND av.deleted_at IS NULL
			LEFT JOIN users u ON u.id = ai.user_id
			LEFT JOIN asset_prices ap
			       ON ap.item_type = 'agent' AND ap.item_id = ai.id AND ap.is_active = true
			LEFT JOIN (
			       SELECT agent_id,
			              COUNT(*)::int AS oracle_total,
			              COUNT(*) FILTER (WHERE outcome = 'win')::int AS oracle_wins,
			              ROUND(100.0 * COUNT(*) FILTER (WHERE outcome = 'win')
			                    / NULLIF(COUNT(*) FILTER (WHERE outcome IN ('win','loss')), 0), 1) AS oracle_win_rate,
			              ROUND(COALESCE(SUM(realized_pnl_sol), 0)::numeric, 4) AS oracle_pnl_sol
			       FROM oracle_watch_actions
			       WHERE outcome IS NOT NULL
			       GROUP BY agent_id
			) os ON os.agent_id = ai.id
			WHERE ai.is_published = true
			  AND ai.deleted_at IS NULL
			  AND ai.name !~* ${AGENT_AUTONAMED_RE_SQL}
			  AND (${cat}::text IS NULL OR ai.category = ${cat})
			  AND (
			    ${qLike}::text IS NULL
			    OR ai.name ILIKE ${qLike}
			    OR ai.description ILIKE ${qLike}
			    OR EXISTS (SELECT 1 FROM unnest(ai.tags) t WHERE t ILIKE ${qLike})
			  )
			  AND (
			    ${pricing}::text IS NULL
			    OR (${pricing} = 'paid' AND (
			          ap.amount IS NOT NULL
			          OR EXISTS (SELECT 1 FROM agent_skill_prices asp2
			                     WHERE asp2.agent_id = ai.id AND asp2.is_active = true)))
			    OR (${pricing} = 'free' AND (
			          ap.amount IS NULL
			          AND NOT EXISTS (SELECT 1 FROM agent_skill_prices asp2
			                          WHERE asp2.agent_id = ai.id AND asp2.is_active = true)))
			  )
			ORDER BY ${orderBy}
			LIMIT ${limit + 1}::int OFFSET ${offset}::int
		`,
		]);
	} catch (err) {
		if (err.code === '42P01' || err.code === '42703') {
			[, rows] = await sql.transaction([
				sql`SET LOCAL statement_timeout = '8000'`,
				sql`
					SELECT ai.id, ai.name, ai.description, ai.category, ai.tags, ai.avatar_id, ai.user_id,
					       ai.forks_count, ai.views_count, ai.published_at, ai.created_at, ai.skills,
					       av.thumbnail_key,
					       av.storage_key AS avatar_storage_key,
					       av.visibility AS avatar_visibility,
					       ai.meta->'onchain' AS onchain,
					       ai.meta->'token'   AS token,
					       ai.meta->>'solana_address'       AS solana_address,
					       ai.meta->>'solana_vanity_prefix' AS solana_vanity_prefix,
					       ai.meta->>'solana_vanity_suffix' AS solana_vanity_suffix,
					       ai.meta->'genome' AS genome,
					       (ai.meta ? 'bred_from') AS bred,
					       u.display_name AS author_name,
					       EXISTS (
					         SELECT 1 FROM agent_skill_prices asp
					         WHERE asp.agent_id = ai.id AND asp.is_active = true
					       ) AS has_paid_skills,
					       COALESCE((SELECT count(*)::int FROM skill_purchases sp
					        WHERE sp.agent_id = ai.id AND sp.status = 'confirmed'), 0) AS buyers_total,
					       COALESCE((SELECT count(*)::int FROM skill_purchases sp
					        WHERE sp.agent_id = ai.id AND sp.status = 'confirmed'
					          AND sp.created_at > now() - interval '24 hours'), 0) AS buyers_24h,
					       0::numeric AS rating_avg,
					       0::int AS rating_count,
					       ap.amount        AS asset_price_amount,
					       ap.currency_mint AS asset_price_currency_mint,
					       ap.chain         AS asset_price_chain,
					       ap.mint_decimals AS asset_price_mint_decimals
					FROM agent_identities ai
					LEFT JOIN avatars av ON av.id = ai.avatar_id AND av.deleted_at IS NULL
					LEFT JOIN users u ON u.id = ai.user_id
					LEFT JOIN asset_prices ap
					       ON ap.item_type = 'agent' AND ap.item_id = ai.id AND ap.is_active = true
					WHERE ai.is_published = true
					  AND ai.deleted_at IS NULL
					  AND ai.name !~* ${AGENT_AUTONAMED_RE_SQL}
					  AND (${cat}::text IS NULL OR ai.category = ${cat})
					  AND (
					    ${qLike}::text IS NULL
					    OR ai.name ILIKE ${qLike}
					    OR ai.description ILIKE ${qLike}
					    OR EXISTS (SELECT 1 FROM unnest(ai.tags) t WHERE t ILIKE ${qLike})
					  )
					  AND (
					    ${pricing}::text IS NULL
					    OR (${pricing} = 'paid' AND (
					          ap.amount IS NOT NULL
					          OR EXISTS (SELECT 1 FROM agent_skill_prices asp2
					                     WHERE asp2.agent_id = ai.id AND asp2.is_active = true)))
					    OR (${pricing} = 'free' AND (
					          ap.amount IS NULL
					          AND NOT EXISTS (SELECT 1 FROM agent_skill_prices asp2
					                          WHERE asp2.agent_id = ai.id AND asp2.is_active = true)))
					  )
					ORDER BY ${orderBy}
					LIMIT ${limit + 1}::int OFFSET ${offset}::int
				`,
			]);
		} else if (isDbUnavailableError(err)) {
			console.warn('[marketplace/list] db unavailable:', err?.message);
			return error(res, 503, 'service_unavailable', 'Database temporarily unavailable — retry shortly');
		} else {
			console.error('[marketplace/list]', err?.code, err?.message || err);
			return error(res, 500, 'db_error', 'Failed to load marketplace listing');
		}
	}

	const hasMore = rows.length > limit;
	const items = rows.slice(0, limit).map(toCard);
	await decorateActivated(items);
	await decorateRepFeatured(items, sort, offset);

	return json(
		res,
		200,
		{
			data: {
				items,
				next_cursor: hasMore ? String(offset + limit) : null,
			},
		},
		{ 'cache-control': 'public, max-age=15' },
	);
}

// Flag which of these cards are "rep_featured" (in the latest autonomous x402
// reputation leaderboard snapshot). Top agent IDs are written to Redis by the
// agent-reputation-leaderboard autonomous loop entry every 30 min. On the first
// page of a recommended sort those agents are floated to the top so visitors see
// the highest-trust agents first. Mutates each card in place; never throws.
async function decorateRepFeatured(items, sort, offset) {
	if (!items.length) return;
	try {
		const redis = await getRedis();
		if (!redis) return;
		const raw = await redis.get('x402:rep-leaderboard:top-agent-ids');
		if (!raw) return;
		const topIds = JSON.parse(typeof raw === 'string' ? raw : JSON.stringify(raw));
		if (!Array.isArray(topIds) || topIds.length === 0) return;
		const topSet = new Set(topIds);
		for (const card of items) {
			if (topSet.has(card.id)) card.rep_featured = true;
		}
		// Float rep-featured agents to the top on the first page of recommended.
		if (sort === 'recommended' && offset === 0) {
			items.sort((a, b) => (b.rep_featured ? 1 : 0) - (a.rep_featured ? 1 : 0));
		}
	} catch {
		// Redis miss or parse error — degrade gracefully, never block the listing.
	}
}

// Flag which of these cards are "live" (claimed their activation grant — funded +
// on the Money Pulse) in one batched, indexed lookup. Kept OUT of the main browse
// query on purpose: referencing agent_activations there would force the whole list
// onto its degraded fallback on any deploy where the table isn't migrated yet. As
// a standalone, fully table-tolerant step it can only ever add a badge, never
// break the listing. Mutates each card in place.
async function decorateActivated(items) {
	if (!items.length) return;
	try {
		const ids = items.map((c) => c.id);
		const rows = await sql`
			SELECT agent_id FROM agent_activations
			WHERE agent_id = ANY(${ids}) AND status = 'confirmed'
		`;
		const live = new Set(rows.map((r) => r.agent_id));
		for (const card of items) card.activated = live.has(card.id);
	} catch (e) {
		if (e?.code !== '42P01') console.warn('[marketplace/list] activation flags skipped', e?.message);
	}
}

// ── Detail ─────────────────────────────────────────────────────────────────

async function handleDetail(req, res, id) {
	if (cors(req, res, { methods: 'GET,OPTIONS' })) return;
	if (!method(req, res, ['GET'])) return;

	const rl = await limits.widgetRead(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	let row;
	try {
		[row] = await sql`
			SELECT a.*, u.display_name AS author_name, u.avatar_url AS author_avatar,
			       av.storage_key AS avatar_storage_key,
			       av.thumbnail_key AS avatar_thumbnail_key,
			       av.visibility AS avatar_visibility,
			       a.meta->>'sol_mint_address' AS sol_mint_address,
			       a.meta->>'pumpfun_network'  AS pumpfun_network,
			       a.meta->>'solana_address'       AS solana_address,
			       a.meta->>'solana_vanity_prefix' AS solana_vanity_prefix,
			       a.meta->>'solana_vanity_suffix' AS solana_vanity_suffix,
			       COALESCE((SELECT count(*)::int FROM skill_purchases sp
			        WHERE sp.agent_id = a.id AND sp.status = 'confirmed'), 0) AS buyers_total,
			       COALESCE((SELECT count(*)::int FROM skill_purchases sp
			        WHERE sp.agent_id = a.id AND sp.status = 'confirmed'
			          AND sp.created_at > now() - interval '24 hours'), 0) AS buyers_24h,
			       COALESCE((SELECT AVG(rating)::numeric(3,2) FROM agent_reviews r WHERE r.agent_id = a.id), 0) AS rating_avg,
			       COALESCE((SELECT count(*)::int FROM agent_reviews r WHERE r.agent_id = a.id), 0) AS rating_count,
			       ap.amount        AS asset_price_amount,
			       ap.currency_mint AS asset_price_currency_mint,
			       ap.chain         AS asset_price_chain,
			       ap.mint_decimals AS asset_price_mint_decimals
			FROM agent_identities a
			LEFT JOIN users u ON u.id = a.user_id
			LEFT JOIN avatars av ON av.id = a.avatar_id AND av.deleted_at IS NULL
			LEFT JOIN asset_prices ap
			       ON ap.item_type = 'agent' AND ap.item_id = a.id AND ap.is_active = true
			WHERE a.id = ${id} AND a.deleted_at IS NULL
		`;
	} catch (err) {
		if (err.code === '42P01') {
			// agent_reviews table not yet created — fall back without review aggregates
			[row] = await sql`
				SELECT a.*, u.display_name AS author_name, u.avatar_url AS author_avatar,
				       av.storage_key AS avatar_storage_key,
				       av.thumbnail_key AS avatar_thumbnail_key,
				       av.visibility AS avatar_visibility,
				       a.meta->>'sol_mint_address' AS sol_mint_address,
				       a.meta->>'pumpfun_network'  AS pumpfun_network,
				       COALESCE((SELECT count(*)::int FROM skill_purchases sp
				        WHERE sp.agent_id = a.id AND sp.status = 'confirmed'), 0) AS buyers_total,
				       COALESCE((SELECT count(*)::int FROM skill_purchases sp
				        WHERE sp.agent_id = a.id AND sp.status = 'confirmed'
				          AND sp.created_at > now() - interval '24 hours'), 0) AS buyers_24h,
				       0::numeric AS rating_avg, 0::int AS rating_count,
				       ap.amount        AS asset_price_amount,
				       ap.currency_mint AS asset_price_currency_mint,
				       ap.chain         AS asset_price_chain,
				       ap.mint_decimals AS asset_price_mint_decimals
				FROM agent_identities a
				LEFT JOIN users u ON u.id = a.user_id
				LEFT JOIN avatars av ON av.id = a.avatar_id AND av.deleted_at IS NULL
				LEFT JOIN asset_prices ap
				       ON ap.item_type = 'agent' AND ap.item_id = a.id AND ap.is_active = true
				WHERE a.id = ${id} AND a.deleted_at IS NULL
			`;
		} else if (isDbUnavailableError(err)) {
			console.warn('[marketplace/detail] db unavailable:', err?.message);
			res.setHeader('retry-after', '30');
			return error(res, 503, 'service_unavailable', 'database temporarily unavailable — retry shortly');
		} else {
			console.error('[marketplace/detail]', err?.message || err);
			return error(res, 500, 'db_error', 'Failed to load agent');
		}
	}
	if (!row) return error(res, 404, 'not_found', 'agent not found');

	const auth = await resolveAuth(req).catch(() => null);
	if (!row.is_published && row.user_id !== auth?.userId) {
		return error(res, 404, 'not_found', 'agent not found');
	}

	// Skill prices via the shared cache (1h TTL, invalidated on price edits) so
	// the marketplace detail page — the highest-traffic priced read — serves
	// warm agents without re-querying agent_skill_prices on every view.
	// Missing-table tolerance: subscription_plans / creator_subscriptions ship
	// behind a migration. If a deploy hasn't applied them yet, treat them as
	// "no tiers" rather than 500-ing the whole agent detail.
	const tolerateMissing = async (run) => {
		try {
			return await run();
		} catch (err) {
			if (err.code === '42P01') return [];
			throw err;
		}
	};

	const [priceRows, purchasedRows, tierRows, subRows] = await Promise.all([
		getSkillPrices(id),
		auth
			? sql`
				SELECT skill FROM skill_purchases
				WHERE user_id = ${auth.userId} AND agent_id = ${id} AND status = 'confirmed'
			`
			: Promise.resolve([]),
		// Active subscription tiers configured for this agent, cheapest first.
		tolerateMissing(() => sql`
			SELECT id, name, price_usd, interval, perks, included_skills
			FROM subscription_plans
			WHERE agent_id = ${id} AND active = true
			ORDER BY price_usd ASC
		`),
		// The signed-in viewer's active subscription to this agent (if any), so
		// the UI can mark the current tier and offer management instead of a
		// duplicate sign-up.
		auth
			? tolerateMissing(() => sql`
				SELECT cs.id, cs.plan_id, cs.status, cs.current_period_end
				FROM creator_subscriptions cs
				JOIN subscription_plans sp ON sp.id = cs.plan_id
				WHERE cs.subscriber_user_id = ${auth.userId}
				  AND sp.agent_id = ${id}
				  AND cs.status = 'active'
				ORDER BY cs.current_period_end DESC
				LIMIT 1
			`)
			: Promise.resolve([]),
	]);

	let bookmarked = false;
	if (auth) {
		const [b] =
			await sql`SELECT 1 AS x FROM agent_bookmarks WHERE user_id = ${auth.userId} AND agent_id = ${id}`;
		bookmarked = !!b;
	}

	const skill_prices = skillPriceMap(priceRows);
	const purchased_skills = purchasedRows.map((r) => r.skill);

	// NFT-gated skills the viewer holds access to are "owned" for display (no
	// purchase row exists for them). Fail-soft — the gate, not an error, shows if
	// the on-chain check can't resolve. Enforcement stays in hasSkillAccess.
	if (auth) {
		const nftSkills = await viewerNftGatedSkills(priceRows, auth.userId).catch(() => []);
		for (const s of nftSkills) if (!purchased_skills.includes(s)) purchased_skills.push(s);
	}

	const subscription_tiers = tierRows.map((t) => ({
		id: t.id,
		name: t.name,
		// numeric(8,2) comes back as a string from postgres — normalise to a
		// number so the client doesn't have to guess the shape.
		price_usd: Number(t.price_usd),
		interval: t.interval,
		perks: Array.isArray(t.perks) ? t.perks : [],
		included_skills: Array.isArray(t.included_skills) ? t.included_skills : [],
	}));
	const user_subscription = subRows[0]
		? {
				id: subRows[0].id,
				plan_id: subRows[0].plan_id,
				status: subRows[0].status,
				current_period_end: subRows[0].current_period_end,
			}
		: null;

	// The payload carries viewer-specific state (bookmarked, purchased_skills,
	// user_subscription). Only the anonymous shape is safe for a shared cache —
	// authenticated reads must stay private so one viewer's state never lands
	// in another's response.
	const cacheControl = auth
		? 'private, max-age=0, must-revalidate'
		: 'public, max-age=15';

	return json(
		res,
		200,
		{
			data: {
				agent: {
					...toDetail(row, skill_prices, auth?.userId || null),
					skill_prices,
					bookmarked,
					purchased_skills,
					subscription_tiers,
					user_subscription,
				},
			},
		},
		{ 'cache-control': cacheControl },
	);
}

// ── Preview chat ───────────────────────────────────────────────────────────
//
// Anonymous-friendly "try before you fork" — POST a single user message, get
// back an SSE stream of token chunks that come straight from the LLM provider.
// Two rate-limit buckets in series:
//   1. Per-IP: prevents one visitor from draining credits.
//   2. Per-agent: prevents one popular agent from starving the global pool.
//
// History is capped at 8 turns; only the agent's published system_prompt is
// used (no viewer tools, no admin context). Provider is whichever is
// configured via env, free providers first: groq → openrouter → nvidia →
// anthropic → openai (see buildPreviewRoutes).

const PREVIEW_PROVIDERS = {
	anthropic: {
		envKey: 'ANTHROPIC_API_KEY',
		url: 'https://api.anthropic.com/v1/messages',
		defaultModel: 'claude-haiku-4-5-20251001',
		style: 'anthropic',
		extraHeaders: { 'anthropic-version': '2023-06-01' },
	},
	openrouter: {
		envKey: 'OPENROUTER_API_KEY',
		url: 'https://openrouter.ai/api/v1/chat/completions',
		defaultModel: 'meta-llama/llama-3.3-70b-instruct:free',
		style: 'openai',
		extraHeaders: {
			'HTTP-Referer': 'https://three.ws',
			'X-Title': 'three.ws marketplace',
		},
	},
	groq: {
		envKey: 'GROQ_API_KEY',
		url: 'https://api.groq.com/openai/v1/chat/completions',
		defaultModel: 'llama-3.3-70b-versatile',
		style: 'openai',
	},
	// NVIDIA NIM free tier — third independent free lane (see api/_lib/llm.js).
	nvidia: {
		envKey: 'NVIDIA_API_KEY',
		url: 'https://integrate.api.nvidia.com/v1/chat/completions',
		defaultModel: 'meta/llama-3.3-70b-instruct',
		style: 'openai',
	},
	openai: {
		envKey: 'OPENAI_API_KEY',
		url: 'https://api.openai.com/v1/chat/completions',
		defaultModel: 'gpt-4o-mini',
		style: 'openai',
	},
};

const previewBody = z.object({
	message: z.string().trim().min(1).max(2000),
	history: z
		.array(
			z.object({
				role: z.enum(['user', 'assistant']),
				content: z.string().min(1).max(2000),
			}),
		)
		.max(8)
		.default([]),
});

async function handlePreview(req, res, id) {
	if (cors(req, res, { methods: 'POST,OPTIONS' })) return;
	if (!method(req, res, ['POST'])) return;

	const ip = clientIp(req);
	const ipRl = await limits.previewIp(ip);
	if (!ipRl.success) return rateLimited(res, ipRl, 'too many preview messages — try again later');
	const agentRl = await limits.previewAgent(id);
	if (!agentRl.success) return rateLimited(res, agentRl, 'this agent is at capacity right now');

	const raw = await readJson(req).catch(() => null);
	if (!raw) return error(res, 400, 'validation_error', 'request body required');
	let body;
	try {
		body = previewBody.parse(raw);
	} catch (err) {
		return error(res, 400, 'validation_error', err.errors?.[0]?.message || 'invalid body');
	}

	const [agent] = await sql`
		SELECT id, name, greeting, system_prompt, persona_prompt, is_published, deleted_at
		FROM agent_identities
		WHERE id = ${id}
		LIMIT 1
	`;
	if (!agent || agent.deleted_at || !agent.is_published) {
		return error(res, 404, 'not_found', 'agent not found or not published');
	}

	const routes = buildPreviewRoutes();
	if (!routes.length) return error(res, 503, 'preview_unavailable', 'no preview provider configured');

	const baseSystem = (agent.system_prompt || agent.persona_prompt || '').trim();
	const systemPrompt = baseSystem
		? `${baseSystem}\n\nReply concisely. Keep responses to 1–4 sentences. No markdown formatting, no headers, no lists. Stay in character as ${agent.name || 'this agent'}.`
		: `You are ${agent.name || 'a community agent'}. Reply concisely in 1–4 sentences in plain text. No markdown.`;

	const history = body.history.map((m) => ({ role: m.role, content: m.content }));
	history.push({ role: 'user', content: body.message });

	// Bound the entire handler — failover attempts AND the token stream — to a
	// budget safely under Vercel's 30s function timeout. Without this, a slow
	// failover (one upstream times out, the next starts) or a slow-streaming
	// model pushes the request past 30s and Vercel kills it with a "Task timed
	// out" error instead of us flushing a clean `done`.
	const HANDLER_DEADLINE = Date.now() + 27_000;
	const budgetLeft = () => HANDLER_DEADLINE - Date.now();

	// Try each configured provider in order; fail over on rate-limit (429) or
	// provider errors (5xx). Each attempt is capped at 22s OR the remaining
	// handler budget, whichever is smaller.
	let upstream;
	let route;
	for (let i = 0; i < routes.length; i++) {
		route = routes[i];
		if (budgetLeft() <= 2_000) {
			if (!upstream) return error(res, 504, 'preview_timeout', 'preview timed out — try again');
			break;
		}
		try {
			upstream = await fetch(route.url, {
				method: 'POST',
				headers: route.headers,
				body: JSON.stringify(route.buildPayload({ systemPrompt, history })),
				signal: AbortSignal.timeout(Math.min(22_000, budgetLeft())),
			});
		} catch (fetchErr) {
			const reason = fetchErr?.name === 'TimeoutError' ? 'timed out' : fetchErr.message;
			console.warn(`[preview:${route.name}] fetch failed: ${reason}`);
			// Unreachable upstream is a transient capacity/health problem — cool the
			// provider down so the shared breaker steers other requests away from it.
			void markProviderCooldown(route.name);
			if (i + 1 < routes.length) continue;
			// Chain exhausted on an unreachable backend: 503 + Retry-After so the
			// client backs off and retries, never a hard 502 (matches /api/chat).
			res.setHeader('Retry-After', '20');
			return error(res, 503, 'rate_limited', 'Agent preview is briefly at capacity. Please try again in a few seconds.');
		}

		if (upstream.ok) break;

		const text = await upstream.text().catch(() => '');
		console.warn(`[preview:${route.name}] ${upstream.status} — ${text.slice(0, 200)}`);
		// Fail over on rate-limit (429), transient upstream errors (5xx), AND
		// auth/billing failures (401 bad/expired key, 403 forbidden, 402 out of
		// credits). The auth/billing group is what used to hard-fail this endpoint:
		// a bad server ANTHROPIC_API_KEY returned 502 to every preview without ever
		// trying the healthy free tiers. These are provider-down conditions for the
		// whole deploy, so cool the provider down — a long window for auth/billing
		// (the key won't recover in 45s), the default window for a transient blip —
		// and move to the next provider.
		const authBilling = upstream.status === 401 || upstream.status === 403 || upstream.status === 402;
		const transient = upstream.status === 429 || upstream.status >= 500;
		const failable = transient || authBilling;
		if (authBilling) void markProviderCooldown(route.name, AUTH_COOLDOWN_SECONDS, 'auth');
		else if (transient) void markProviderCooldown(route.name);
		const canFailOver = i + 1 < routes.length && failable;
		if (canFailOver) continue;
		// Chain exhausted. A capacity/transient/auth terminal failure degrades to
		// 503 + Retry-After (client backs off); only a genuine non-failable bad
		// status stays a 502.
		if (failable) {
			res.setHeader('Retry-After', '20');
			return error(res, 503, 'rate_limited', 'Agent preview is briefly at capacity. Please try again in a few seconds.');
		}
		return error(res, 502, 'upstream_error', `preview backend returned ${upstream.status}`);
	}

	res.writeHead(200, {
		'Content-Type': 'text/event-stream; charset=utf-8',
		'Cache-Control': 'no-cache, no-transform',
		'X-Accel-Buffering': 'no',
		'Connection': 'keep-alive',
	});
	const sendSSE = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
	sendSSE({ type: 'open', model: route.model, provider: route.name });

	const started = Date.now();
	const out = route.style === 'anthropic'
		? await streamAnthropicPreview(upstream, sendSSE, HANDLER_DEADLINE)
		: await streamOpenAIPreview(upstream, sendSSE, HANDLER_DEADLINE);

	if (out.error) {
		sendSSE({ type: 'error', code: 'stream_error', message: 'stream interrupted' });
		res.end();
		return;
	}

	sendSSE({
		type: 'done',
		reply: out.reply.trim(),
		model: route.model,
		provider: route.name,
		latencyMs: Date.now() - started,
	});
	res.end();
}

// Build an ordered list of all configured preview routes. Priority mirrors the
// chat ladder (api/_lib/chat-models.js → DEFAULT_PROVIDER_ORDER): free
// providers ALWAYS lead, paid keys are last-resort backstops — the prod paid
// keys are routinely invalid (Anthropic 401) or over quota (OpenAI), so
// leading with them burned a doomed attempt on every preview.
//   1. groq       — free, fast, first-attempt reliable (per-minute caps only)
//   2. openrouter — free Llama fallback
//   3. nvidia     — NVIDIA NIM free tier, independent third lane
//   4. anthropic  — paid backstop
//   5. openai     — paid backstop (account may be over quota)
function buildPreviewRoutes() {
	const order = ['groq', 'openrouter', 'nvidia', 'anthropic', 'openai'];
	const routes = [];
	for (const name of order) {
		const cfg = PREVIEW_PROVIDERS[name];
		const key = process.env[cfg.envKey];
		if (!key) continue;
		const model = process.env.PREVIEW_MODEL || cfg.defaultModel;
		if (cfg.style === 'anthropic') {
			routes.push({
				name,
				model,
				url: cfg.url,
				style: 'anthropic',
				headers: {
					'x-api-key': key,
					'content-type': 'application/json',
					...(cfg.extraHeaders || {}),
				},
				buildPayload: ({ systemPrompt, history }) => ({
					model,
					max_tokens: 512,
					system: systemPrompt,
					messages: history,
					stream: true,
				}),
			});
		} else {
			routes.push({
				name,
				model,
				url: cfg.url,
				style: 'openai',
				headers: {
					Authorization: `Bearer ${key}`,
					'Content-Type': 'application/json',
					...(cfg.extraHeaders || {}),
				},
				buildPayload: ({ systemPrompt, history }) => ({
					model,
					max_tokens: 512,
					messages: [{ role: 'system', content: systemPrompt }, ...history],
					stream: true,
				}),
			});
		}
	}
	return routes;
}

async function streamAnthropicPreview(upstream, sendSSE, deadline = Infinity) {
	const reader = upstream.body.getReader();
	const decoder = new TextDecoder();
	let buf = '';
	let reply = '';
	try {
		while (true) {
			// Stop reading before the handler's deadline so we can flush a clean
			// `done` instead of being hard-killed at the Vercel function timeout.
			if (Date.now() >= deadline) {
				reader.cancel().catch(() => {});
				break;
			}
			const { value, done } = await reader.read();
			if (done) break;
			buf += decoder.decode(value, { stream: true });
			const lines = buf.split('\n');
			buf = lines.pop();
			for (const line of lines) {
				if (!line.startsWith('data: ')) continue;
				const raw = line.slice(6).trim();
				if (!raw) continue;
				let evt;
				try { evt = JSON.parse(raw); } catch { continue; }
				if (evt.type === 'content_block_delta' && evt.delta?.type === 'text_delta') {
					reply += evt.delta.text;
					sendSSE({ type: 'chunk', text: evt.delta.text });
				}
			}
		}
	} catch (err) {
		return { error: err, reply };
	}
	return { reply };
}

async function streamOpenAIPreview(upstream, sendSSE, deadline = Infinity) {
	const reader = upstream.body.getReader();
	const decoder = new TextDecoder();
	let buf = '';
	let reply = '';
	try {
		while (true) {
			// Stop reading before the handler's deadline so we can flush a clean
			// `done` instead of being hard-killed at the Vercel function timeout.
			if (Date.now() >= deadline) {
				reader.cancel().catch(() => {});
				break;
			}
			const { value, done } = await reader.read();
			if (done) break;
			buf += decoder.decode(value, { stream: true });
			const lines = buf.split('\n');
			buf = lines.pop();
			for (const line of lines) {
				if (!line.startsWith('data: ')) continue;
				const raw = line.slice(6).trim();
				if (!raw || raw === '[DONE]') continue;
				let evt;
				try { evt = JSON.parse(raw); } catch { continue; }
				const text = evt.choices?.[0]?.delta?.content;
				if (text) {
					reply += text;
					sendSSE({ type: 'chunk', text });
				}
			}
		}
	} catch (err) {
		return { error: err, reply };
	}
	return { reply };
}

// ── Versions ───────────────────────────────────────────────────────────────

async function handleVersions(req, res, id) {
	if (cors(req, res, { methods: 'GET,OPTIONS' })) return;
	if (!method(req, res, ['GET'])) return;

	const rl = await limits.widgetRead(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const rows = await sql`
		SELECT id, version, changelog, category, tags, created_at
		FROM agent_versions
		WHERE agent_id = ${id}
		ORDER BY version DESC
		LIMIT 50
	`;
	return json(res, 200, { data: { versions: rows } });
}

// ── Similar ────────────────────────────────────────────────────────────────

async function handleSimilar(req, res, id) {
	if (cors(req, res, { methods: 'GET,OPTIONS' })) return;
	if (!method(req, res, ['GET'])) return;

	const rl = await limits.widgetRead(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const [base] = await sql`
		SELECT id, name, description, category, tags FROM agent_identities
		WHERE id = ${id} AND deleted_at IS NULL
	`;
	if (!base) return error(res, 404, 'not_found', 'agent not found');

	const rows = await sql`
		SELECT ai.id, ai.name, ai.description, ai.category, ai.tags, ai.avatar_id, ai.user_id,
		       ai.forks_count, ai.views_count, ai.published_at, ai.created_at, ai.skills,
		       av.thumbnail_key,
		       av.storage_key AS avatar_storage_key,
		       av.visibility AS avatar_visibility,
		       (
		         (CASE WHEN ai.category = ${base.category} THEN 3 ELSE 0 END)
		         + cardinality(ARRAY(SELECT unnest(ai.tags) INTERSECT SELECT unnest(${base.tags}::text[])))
		         + similarity(ai.name, ${base.name})
		         + similarity(coalesce(ai.description,''), ${base.description || ''}) * 0.5
		       ) AS score
		FROM agent_identities ai
		LEFT JOIN avatars av ON av.id = ai.avatar_id AND av.deleted_at IS NULL
		WHERE ai.is_published = true
		  AND ai.deleted_at IS NULL
		  AND ai.id <> ${id}
		ORDER BY score DESC
		LIMIT 8
	`;
	return json(res, 200, { data: { items: rows.map(toCard) } });
}

// ── Fork ───────────────────────────────────────────────────────────────────

async function handleFork(req, res, id) {
	if (cors(req, res, { methods: 'POST,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['POST'])) return;

	const auth = await resolveAuth(req);
	if (!auth) return error(res, 401, 'unauthorized', 'sign in required');

	const rl = await limits.authIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const [src] = await sql`
		SELECT * FROM agent_identities
		WHERE id = ${id} AND deleted_at IS NULL AND is_published = true
	`;
	if (!src) return error(res, 404, 'not_found', 'agent not found');

	const [createdRows] = await sql.transaction([
		sql`
			INSERT INTO agent_identities (
				user_id, name, description, avatar_id, skills, meta,
				category, tags, system_prompt, greeting, capabilities, fork_of
			)
			VALUES (
				${auth.userId},
				${src.name},
				${src.description},
				${src.avatar_id},
				${src.skills},
				'{}'::jsonb,
				${src.category},
				${src.tags},
				${src.system_prompt},
				${src.greeting},
				${src.capabilities}::jsonb,
				${src.id}
			)
			RETURNING id, name, description, category, tags, fork_of, created_at
		`,
		sql`UPDATE agent_identities SET forks_count = forks_count + 1 WHERE id = ${id}`,
	]);

	const created = createdRows[0];
	if (!created) return error(res, 500, 'db_error', 'Fork failed');
	return json(res, 201, { data: { agent: created } });
}

// ── Bookmark ───────────────────────────────────────────────────────────────

async function handleBookmark(req, res, id) {
	if (cors(req, res, { methods: 'POST,DELETE,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['POST', 'DELETE'])) return;

	const auth = await resolveAuth(req);
	if (!auth) return error(res, 401, 'unauthorized', 'sign in required');

	const rl = await limits.authIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	if (req.method === 'DELETE') {
		await sql`DELETE FROM agent_bookmarks WHERE user_id = ${auth.userId} AND agent_id = ${id}`;
		return json(res, 200, { data: { bookmarked: false } });
	}

	await sql`
		INSERT INTO agent_bookmarks (user_id, agent_id)
		VALUES (${auth.userId}, ${id})
		ON CONFLICT DO NOTHING
	`;
	return json(res, 200, { data: { bookmarked: true } });
}

// ── Publish ────────────────────────────────────────────────────────────────

async function handlePublish(req, res, id) {
	if (cors(req, res, { methods: 'POST,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['POST'])) return;

	const auth = await resolveAuth(req);
	if (!auth) return error(res, 401, 'unauthorized', 'sign in required');

	const rl = await limits.authIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const body = await readJson(req).catch(() => ({}));

	const [existing] = await sql`
		SELECT id, user_id, system_prompt, greeting, category, tags, capabilities
		FROM agent_identities WHERE id = ${id} AND deleted_at IS NULL
	`;
	if (!existing) return error(res, 404, 'not_found', 'agent not found');
	if (existing.user_id !== auth.userId) return error(res, 403, 'forbidden', 'not your agent');

	const category =
		body.category && CATEGORIES.includes(body.category) ? body.category : existing.category;
	if (!category) return error(res, 400, 'validation_error', 'category required');

	const tags = Array.isArray(body.tags)
		? body.tags
				.filter((t) => typeof t === 'string')
				.map((t) => t.trim().toLowerCase())
				.filter(Boolean)
				.slice(0, 12)
		: existing.tags;

	const systemPrompt =
		typeof body.system_prompt === 'string' ? body.system_prompt.slice(0, 16000) : existing.system_prompt;
	const greeting = typeof body.greeting === 'string' ? body.greeting.slice(0, 1000) : existing.greeting;
	const capabilities = body.capabilities && typeof body.capabilities === 'object' ? body.capabilities : existing.capabilities;
	const changelog = typeof body.changelog === 'string' ? body.changelog.slice(0, 1000) : null;

	const [{ next_version }] = await sql`
		SELECT COALESCE(MAX(version), 0) + 1 AS next_version
		FROM agent_versions WHERE agent_id = ${id}
	`;

	const [updatedRows] = await sql.transaction([
		sql`
			UPDATE agent_identities
			SET is_published  = true,
			    published_at  = COALESCE(published_at, now()),
			    category      = ${category},
			    tags          = ${tags},
			    system_prompt = ${systemPrompt},
			    greeting      = ${greeting},
			    capabilities  = ${JSON.stringify(capabilities || {})}::jsonb
			WHERE id = ${id}
			RETURNING *
		`,
		sql`
			INSERT INTO agent_versions (
				agent_id, version, system_prompt, greeting, category, tags, capabilities, changelog, created_by
			)
			VALUES (
				${id}, ${next_version}, ${systemPrompt}, ${greeting},
				${category}, ${tags}, ${JSON.stringify(capabilities || {})}::jsonb,
				${changelog}, ${auth.userId}
			)
		`,
	]);

	const updated = updatedRows[0];
	if (!updated) return error(res, 404, 'not_found', 'agent not found');
	return json(res, 200, { data: { agent: toDetail(updated, {}, auth.userId), version: next_version } });
}

// ── View counter ───────────────────────────────────────────────────────────

async function handleView(req, res, id) {
	if (cors(req, res, { methods: 'POST,OPTIONS' })) return;
	if (!method(req, res, ['POST'])) return;

	const rl = await limits.widgetRead(clientIp(req));
	if (!rl.success) return json(res, 200, { data: { ok: true } });

	queueMicrotask(() => {
		sql`UPDATE agent_identities SET views_count = views_count + 1 WHERE id = ${id} AND is_published = true`.catch(
			(err) => console.error('[marketplace/view]', err),
		);
	});
	return json(res, 200, { data: { ok: true } });
}

// ── Shaping ────────────────────────────────────────────────────────────────

function toCard(row) {
	const avatarPublic = !row.avatar_visibility || row.avatar_visibility === 'public' || row.avatar_visibility === 'unlisted';
	const price = row.asset_price_amount != null
		? {
			amount: String(row.asset_price_amount),
			currency_mint: row.asset_price_currency_mint,
			chain: row.asset_price_chain,
			mint_decimals: row.asset_price_mint_decimals ?? 6,
		}
		: null;
	return {
		id: row.id,
		name: row.name,
		description: row.description,
		category: row.category,
		tags: row.tags || [],
		avatar_id: row.avatar_id,
		thumbnail_url: thumbnailUrl(row.thumbnail_key),
		avatar_glb_url: row.avatar_storage_key && avatarPublic ? publicUrl(row.avatar_storage_key) : null,
		author_id: row.user_id,
		skills: row.skills || [],
		forks_count: row.forks_count || 0,
		views_count: row.views_count || 0,
		buyers_total: row.buyers_total || 0,
		buyers_24h: row.buyers_24h || 0,
		published_at: row.published_at,
		created_at: row.created_at,
		has_paid_skills: row.has_paid_skills || false,
		rating_avg: Number(row.rating_avg || 0),
		rating_count: row.rating_count || 0,
		price,
		// Canonical on-chain blocks (mirror of api/agents decorate) so the shared
		// badge can light up a deployed agent's marketplace card. Null when absent.
		onchain: row.onchain || null,
		token: row.token || null,
		// Public custodial wallet + vanity pattern for the shared wallet chip. The
		// address is public (GET /api/agents/:id/solana serves it anonymously); the
		// signing secret never leaves the server.
		solana_address: row.solana_address || null,
		solana_vanity_prefix: row.solana_vanity_prefix || null,
		solana_vanity_suffix: row.solana_vanity_suffix || null,
		// Agent Genome pedigree — drives the rare-pedigree badge on the card.
		genome: genomeCardField(row),
		// Oracle trading track record — null when agent has no oracle history.
		oracle: row.oracle_total > 0
			? {
				total: row.oracle_total,
				wins: row.oracle_wins,
				win_rate: Number(row.oracle_win_rate ?? 0),
				pnl_sol: Number(row.oracle_pnl_sol ?? 0),
			}
			: null,
	};
}

// Public-safe pedigree summary for a marketplace card. Null for unbred agents
// (so the badge only ever marks a real lineage). Never throws on bad data.
function genomeCardField(row) {
	if (!row.genome || !row.genome.version) return null;
	try {
		const ped = pedigreeScore(row.genome);
		return {
			generation: ped.generation,
			pedigree_tier: ped.tier,
			pedigree_score: ped.score,
			emergent: ped.emergent,
			bred: !!row.bred,
		};
	} catch {
		return null;
	}
}

function toDetail(row, skill_prices = {}, viewerId = null) {
	return {
		...toCard(row),
		// Server-authoritative ownership: true only for the signed-in owner. Drives
		// which wallet affordance the client renders (owner hub vs visitor tip/pay).
		// Visitors and anonymous reads always get false. The owner-only API routes
		// (withdraw, vanity, limits) re-check ownership regardless of this flag.
		is_owner: !!viewerId && row.user_id === viewerId,
		system_prompt: row.system_prompt,
		greeting: row.greeting,
		capabilities: row.capabilities || {},
		fork_of: row.fork_of || null,
		author_name: row.author_name || null,
		author_avatar: row.author_avatar || null,
		sol_mint_address: row.sol_mint_address || null,
		pumpfun_network: row.pumpfun_network || 'mainnet',
		skill_prices,
	};
}
