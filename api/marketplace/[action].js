/**
 * Agent Marketplace API
 * ---------------------
 * GET    /api/marketplace/categories
 * GET    /api/marketplace/agents              ?category=&q=&sort=&cursor=
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

import { sql } from '../_lib/db.js';
import { authenticateBearer, extractBearer, getSessionUser } from '../_lib/auth.js';
import { cors, error, json, method, readJson, wrap } from '../_lib/http.js';
import { publicUrl } from '../_lib/r2.js';
import { clientIp, limits } from '../_lib/rate-limit.js';
import { z } from 'zod';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

const SORTS = new Set(['recommended', 'recent', 'popular']);

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
		if (!UUID_RE.test(id)) return error(res, 404, 'not_found', 'agent not found');
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
	if (!rl.success) return error(res, 429, 'rate_limited', 'too many requests');

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
	if (!rl.success) return error(res, 429, 'rate_limited', 'too many requests');

	const weekNum = Math.floor(Date.now() / (7 * 24 * 3600 * 1000));
	const cat = THEME_CATEGORIES[weekNum % THEME_CATEGORIES.length];

	const rows = await sql`
		SELECT a.id, a.name, a.description, a.category, a.tags, a.skills,
		       a.views_count, a.forks_count, a.rating_avg, a.rating_count,
		       a.published_at, a.created_at,
		       v.storage_key AS avatar_storage_key, v.is_public AS avatar_public,
		       v.thumbnail_key
		FROM agent_identities a
		LEFT JOIN avatars v ON v.id = a.avatar_id AND v.deleted_at IS NULL
		WHERE a.is_published = true AND a.deleted_at IS NULL
		  AND (${cat.slug === 'general'} OR a.category = ${cat.slug})
		ORDER BY a.views_count DESC, a.rating_avg DESC
		LIMIT 8
	`;

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
		thumbnail_url: row.thumbnail_key ? publicUrl(row.thumbnail_key) : null,
		avatar_glb_url: row.avatar_public && row.avatar_storage_key ? publicUrl(row.avatar_storage_key) : null,
		published_at: row.published_at,
	}));

	return json(
		res,
		200,
		{ data: { theme: { title: cat.title, blurb: cat.blurb, category: cat.slug, agents } } },
		{ 'cache-control': 'public, max-age=3600, stale-while-revalidate=7200' },
	);
}

// ── Create ─────────────────────────────────────────────────────────────────

async function handleCreate(req, res) {
	if (cors(req, res, { methods: 'POST,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['POST'])) return;

	const auth = await resolveAuth(req);
	if (!auth) return error(res, 401, 'unauthorized', 'sign in required');

	const rl = await limits.authIp(clientIp(req));
	if (!rl.success) return error(res, 429, 'rate_limited', 'too many requests');

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
		data: { agent: toDetail({ ...agent, author_name: null, author_avatar: null }) },
	});
}

// ── Mine ───────────────────────────────────────────────────────────────────

async function handleMine(req, res) {
	if (cors(req, res, { methods: 'GET,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['GET'])) return;

	const auth = await resolveAuth(req);
	if (!auth) return error(res, 401, 'unauthorized', 'sign in required');

	const rl = await limits.widgetRead(clientIp(req));
	if (!rl.success) return error(res, 429, 'rate_limited', 'too many requests');

	const rows = await sql`
		SELECT ai.id, ai.name, ai.description, ai.category, ai.tags, ai.avatar_id, ai.user_id,
		       ai.forks_count, ai.views_count, ai.published_at, ai.created_at, ai.skills,
		       ai.is_published, av.thumbnail_key,
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
			items: rows.map((r) => ({ ...toCard(r), is_published: r.is_published })),
		},
	});
}

// ── List ───────────────────────────────────────────────────────────────────

async function handleList(req, res, url) {
	if (cors(req, res, { methods: 'GET,OPTIONS' })) return;
	if (!method(req, res, ['GET'])) return;

	const rl = await limits.widgetRead(clientIp(req));
	if (!rl.success) return error(res, 429, 'rate_limited', 'too many requests');

	const category = url.searchParams.get('category') || null;
	const q = (url.searchParams.get('q') || '').trim().slice(0, 80);
	const sort = SORTS.has(url.searchParams.get('sort')) ? url.searchParams.get('sort') : 'recommended';
	const limit = Math.min(48, Math.max(1, Number(url.searchParams.get('limit')) || 24));
	const cursor = url.searchParams.get('cursor');
	const offset = cursor ? Math.max(0, Number(cursor) || 0) : 0;

	const orderBy =
		sort === 'recent'
			? sql`published_at DESC NULLS LAST, created_at DESC`
			: sort === 'popular'
				? sql`(forks_count + views_count) DESC, published_at DESC NULLS LAST`
				: sql`(forks_count * 5 + views_count) DESC, published_at DESC NULLS LAST`;

	const cat = category && CATEGORIES.includes(category) ? category : null;
	const qLike = q ? `%${q}%` : null;

	let rows;
	try {
		rows = await sql`
			SELECT ai.id, ai.name, ai.description, ai.category, ai.tags, ai.avatar_id, ai.user_id,
			       ai.forks_count, ai.views_count, ai.published_at, ai.created_at, ai.skills,
			       av.thumbnail_key,
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
			ORDER BY ${orderBy}
			LIMIT ${limit + 1} OFFSET ${offset}
		`;
	} catch (err) {
		console.error('[marketplace/list]', err?.message || err);
		return error(res, 500, 'db_error', 'Failed to load marketplace listing');
	}

	const hasMore = rows.length > limit;
	const items = rows.slice(0, limit).map(toCard);

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

// ── Detail ─────────────────────────────────────────────────────────────────

async function handleDetail(req, res, id) {
	if (cors(req, res, { methods: 'GET,OPTIONS' })) return;
	if (!method(req, res, ['GET'])) return;

	const rl = await limits.widgetRead(clientIp(req));
	if (!rl.success) return error(res, 429, 'rate_limited', 'too many requests');

	let row;
	try {
		[row] = await sql`
			SELECT a.*, u.display_name AS author_name, u.avatar_url AS author_avatar,
			       av.storage_key AS avatar_storage_key,
			       av.thumbnail_key AS avatar_thumbnail_key,
			       av.visibility AS avatar_visibility,
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
		console.error('[marketplace/detail]', err?.message || err);
		return error(res, 500, 'db_error', 'Failed to load agent');
	}
	if (!row) return error(res, 404, 'not_found', 'agent not found');

	const auth = await resolveAuth(req).catch(() => null);
	if (!row.is_published && row.user_id !== auth?.userId) {
		return error(res, 404, 'not_found', 'agent not found');
	}

	const [priceRows, purchasedRows] = await Promise.all([
		sql`
			SELECT skill, currency_mint, chain, amount, mint_decimals, trial_uses, time_pass_hours, time_pass_amount
			FROM agent_skill_prices
			WHERE agent_id = ${id} AND is_active = true
		`,
		auth
			? sql`
				SELECT skill FROM skill_purchases
				WHERE user_id = ${auth.userId} AND agent_id = ${id} AND status = 'confirmed'
			`
			: Promise.resolve([]),
	]);

	let bookmarked = false;
	if (auth) {
		const [b] =
			await sql`SELECT 1 AS x FROM agent_bookmarks WHERE user_id = ${auth.userId} AND agent_id = ${id}`;
		bookmarked = !!b;
	}

	const skill_prices = Object.fromEntries(
		priceRows.map((p) => [
			p.skill,
			{
				amount: p.amount,
				currency_mint: p.currency_mint,
				chain: p.chain,
				mint_decimals: p.mint_decimals ?? 6,
				trial_uses: p.trial_uses ?? 0,
				time_pass_hours: p.time_pass_hours ?? null,
				time_pass_amount: p.time_pass_amount ?? null,
			},
		]),
	);
	const purchased_skills = purchasedRows.map((r) => r.skill);

	return json(
		res,
		200,
		{ data: { agent: { ...toDetail(row), skill_prices, bookmarked, purchased_skills } } },
		{ 'cache-control': 'public, max-age=15' },
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
// configured via env, in fallback order: anthropic → openrouter → groq → openai.

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
	if (!ipRl.success) return error(res, 429, 'rate_limited', 'too many preview messages — try again later');
	const agentRl = await limits.previewAgent(id);
	if (!agentRl.success) return error(res, 429, 'rate_limited', 'this agent is at capacity right now');

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

	const route = pickPreviewProvider();
	if (!route) return error(res, 503, 'preview_unavailable', 'no preview provider configured');

	const baseSystem = (agent.system_prompt || agent.persona_prompt || '').trim();
	const systemPrompt = baseSystem
		? `${baseSystem}\n\nReply concisely. Keep responses to 1–4 sentences. No markdown formatting, no headers, no lists. Stay in character as ${agent.name || 'this agent'}.`
		: `You are ${agent.name || 'a community agent'}. Reply concisely in 1–4 sentences in plain text. No markdown.`;

	const history = body.history.map((m) => ({ role: m.role, content: m.content }));
	history.push({ role: 'user', content: body.message });

	let upstream;
	try {
		upstream = await fetch(route.url, {
			method: 'POST',
			headers: route.headers,
			body: JSON.stringify(route.buildPayload({ systemPrompt, history })),
		});
	} catch {
		return error(res, 502, 'upstream_unavailable', 'preview backend unreachable');
	}

	if (!upstream.ok) {
		const text = await upstream.text().catch(() => '');
		if (process.env.DEBUG === 'true') {
			console.warn(`[preview:${route.name}]`, upstream.status, text.slice(0, 400));
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
		? await streamAnthropicPreview(upstream, sendSSE)
		: await streamOpenAIPreview(upstream, sendSSE);

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

function pickPreviewProvider() {
	const order = ['anthropic', 'openrouter', 'groq', 'openai'];
	for (const name of order) {
		const cfg = PREVIEW_PROVIDERS[name];
		const key = process.env[cfg.envKey];
		if (!key) continue;
		const model = process.env.PREVIEW_MODEL || cfg.defaultModel;
		if (cfg.style === 'anthropic') {
			return {
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
			};
		}
		return {
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
		};
	}
	return null;
}

async function streamAnthropicPreview(upstream, sendSSE) {
	const reader = upstream.body.getReader();
	const decoder = new TextDecoder();
	let buf = '';
	let reply = '';
	try {
		while (true) {
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

async function streamOpenAIPreview(upstream, sendSSE) {
	const reader = upstream.body.getReader();
	const decoder = new TextDecoder();
	let buf = '';
	let reply = '';
	try {
		while (true) {
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
	if (!rl.success) return error(res, 429, 'rate_limited', 'too many requests');

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
	if (!rl.success) return error(res, 429, 'rate_limited', 'too many requests');

	const [base] = await sql`
		SELECT id, name, description, category, tags FROM agent_identities
		WHERE id = ${id} AND deleted_at IS NULL
	`;
	if (!base) return error(res, 404, 'not_found', 'agent not found');

	const rows = await sql`
		SELECT ai.id, ai.name, ai.description, ai.category, ai.tags, ai.avatar_id, ai.user_id,
		       ai.forks_count, ai.views_count, ai.published_at, ai.created_at, ai.skills,
		       av.thumbnail_key,
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
	if (!rl.success) return error(res, 429, 'rate_limited', 'too many requests');

	const [src] = await sql`
		SELECT * FROM agent_identities
		WHERE id = ${id} AND deleted_at IS NULL AND is_published = true
	`;
	if (!src) return error(res, 404, 'not_found', 'agent not found');

	const [created] = await sql.transaction([
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

	return json(res, 201, { data: { agent: created } });
}

// ── Bookmark ───────────────────────────────────────────────────────────────

async function handleBookmark(req, res, id) {
	if (cors(req, res, { methods: 'POST,DELETE,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['POST', 'DELETE'])) return;

	const auth = await resolveAuth(req);
	if (!auth) return error(res, 401, 'unauthorized', 'sign in required');

	const rl = await limits.authIp(clientIp(req));
	if (!rl.success) return error(res, 429, 'rate_limited', 'too many requests');

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
	if (!rl.success) return error(res, 429, 'rate_limited', 'too many requests');

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

	const [updated] = await sql.transaction([
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

	return json(res, 200, { data: { agent: toDetail(updated), version: next_version } });
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
		thumbnail_url: row.thumbnail_key ? publicUrl(row.thumbnail_key) : null,
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
	};
}

function toDetail(row, skill_prices = {}) {
	return {
		...toCard(row),
		system_prompt: row.system_prompt,
		greeting: row.greeting,
		capabilities: row.capabilities || {},
		fork_of: row.fork_of || null,
		author_name: row.author_name || null,
		author_avatar: row.author_avatar || null,
		skill_prices,
	};
}
