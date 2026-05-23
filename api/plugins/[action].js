/**
 * Plugin Marketplace API
 * ─────────────────────
 * GET  /api/plugins/categories
 * GET  /api/plugins/list          ?category=&q=&sort=&cursor=&limit=
 * GET  /api/plugins/:id
 * POST /api/plugins/import        { manifest_url }   — fetch + validate + optionally save
 * POST /api/plugins/publish       { manifest_json }  — publish plugin to marketplace
 * POST /api/plugins/:id/install   — increment install_count (called client-side on install)
 */

import { z } from 'zod';
import { sql } from '../_lib/db.js';
import { getSessionUser, authenticateBearer, extractBearer } from '../_lib/auth.js';
import { cors, error, json, method, readJson, wrap } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const VALID_SORTS = new Set(['popular', 'new', 'az']);
const MAX_MANIFEST_BYTES = 64 * 1024; // 64 KB
const FETCH_TIMEOUT_MS = 8000;

// ── Manifest validation — LobeHub/pai-chat ToolManifest format ───────────────
// Required: identifier, meta.title, api[]
// Optional: systemRole, type, settings, version, openapi, gateway, ui

function validateManifest(json) {
	if (!json || typeof json !== 'object') throw new Error('Manifest must be a JSON object');
	if (!json.identifier || typeof json.identifier !== 'string')
		throw new Error('Missing identifier');
	if (!/^[a-z0-9._-]+$/i.test(json.identifier))
		throw new Error('identifier must be alphanumeric with dots, hyphens, or underscores');
	if (!json.meta?.title) throw new Error('Missing meta.title');
	if (!Array.isArray(json.api) || !json.api.length)
		throw new Error('api must be a non-empty array');
	for (const tool of json.api) {
		if (!tool.name || !tool.description)
			throw new Error(`Tool "${tool.name || '?'}" missing name or description`);
	}
}

// ── Auth ──────────────────────────────────────────────────────────────────────

async function resolveAuth(req) {
	const session = await getSessionUser(req);
	if (session) return { userId: session.id };
	const bearer = await authenticateBearer(extractBearer(req));
	if (bearer) return { userId: bearer.userId };
	return null;
}

// ── Row → API shape ───────────────────────────────────────────────────────────

function toPlugin(row) {
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
		identifier: row.identifier,
		manifest_url: row.manifest_url,
		manifest_json: row.manifest_json,
		name: row.name,
		description: row.description,
		category: row.category,
		tags: row.tags || [],
		install_count: row.install_count || 0,
		avg_rating: Number(row.avg_rating) || 0,
		author: row.author_id
			? { id: row.author_id, display_name: row.author_display_name }
			: null,
		created_at: row.created_at,
		price,
	};
}

// ── Route dispatcher ──────────────────────────────────────────────────────────

export default wrap(async (req, res) => {
	const url = new URL(req.url, 'http://x');
	const parts = url.pathname.split('/').filter(Boolean); // ['api','plugins',...]
	const segment = parts[2]; // 'categories' | 'list' | 'import' | 'publish' | <uuid>

	if (segment === 'categories') return handleCategories(req, res);
	if (segment === 'list' || !segment) return handleList(req, res, url);
	if (segment === 'import') return handleImport(req, res);
	if (segment === 'publish') return handlePublish(req, res);

	// /api/plugins/:id[/install]
	if (UUID_RE.test(segment)) {
		const sub = parts[3];
		if (sub === 'install') return handleInstall(req, res, segment);
		if (!sub) return handleDetail(req, res, segment);
	}

	return error(res, 404, 'not_found', 'unknown plugin action');
});

// ── Categories ────────────────────────────────────────────────────────────────

async function handleCategories(req, res) {
	if (cors(req, res, { methods: 'GET,OPTIONS' })) return;
	if (!method(req, res, ['GET'])) return;

	const rl = await limits.widgetRead(clientIp(req));
	if (!rl.success) return error(res, 429, 'rate_limited', 'too many requests');

	const rows = await sql`
		SELECT category, count(*)::int AS count
		FROM plugins
		WHERE is_public = true AND deleted_at IS NULL
		GROUP BY category
		HAVING count(*) > 0
		ORDER BY count DESC
	`;

	return json(
		res,
		200,
		{ data: { categories: rows.map((r) => ({ slug: r.category, count: r.count })) } },
		{ 'cache-control': 'public, max-age=60' },
	);
}

// ── List ──────────────────────────────────────────────────────────────────────

async function handleList(req, res, url) {
	if (cors(req, res, { methods: 'GET,OPTIONS' })) return;
	if (!method(req, res, ['GET'])) return;

	const rl = await limits.widgetRead(clientIp(req));
	if (!rl.success) return error(res, 429, 'rate_limited', 'too many requests');

	const q = (url.searchParams.get('q') || '').trim().slice(0, 80) || null;
	const category = url.searchParams.get('category') || null;
	const sortParam = url.searchParams.get('sort') || 'popular';
	const sort = VALID_SORTS.has(sortParam) ? sortParam : 'popular';
	const cursor = url.searchParams.get('cursor') || null;
	const limit = Math.min(40, Math.max(1, Number(url.searchParams.get('limit')) || 20));
	const offset = cursor ? Math.max(0, Number(cursor)) : 0;
	const qLike = q ? `%${q}%` : null;
	const fetchLimit = limit + 1;

	const rows = await sql`
		SELECT p.*, u.display_name AS author_display_name,
		       ap.amount        AS asset_price_amount,
		       ap.currency_mint AS asset_price_currency_mint,
		       ap.chain         AS asset_price_chain,
		       ap.mint_decimals AS asset_price_mint_decimals
		FROM plugins p
		LEFT JOIN users u ON u.id = p.author_id
		LEFT JOIN asset_prices ap
		       ON ap.item_type = 'plugin' AND ap.item_id = p.id AND ap.is_active = true
		WHERE p.is_public = true
		  AND p.deleted_at IS NULL
		  AND (${category}::text IS NULL OR p.category = ${category})
		  AND (${qLike}::text IS NULL OR p.name ILIKE ${qLike} OR p.description ILIKE ${qLike})
		ORDER BY
			CASE WHEN ${sort} = 'popular' THEN p.install_count END DESC NULLS LAST,
			CASE WHEN ${sort} = 'az' THEN p.name END ASC NULLS LAST,
			p.created_at DESC
		LIMIT ${fetchLimit} OFFSET ${offset}
	`;

	const hasMore = rows.length > limit;
	const items = rows.slice(0, limit).map(toPlugin);
	return json(res, 200, {
		data: {
			items,
			next_cursor: hasMore ? String(offset + limit) : null,
		},
	});
}

// ── Detail ────────────────────────────────────────────────────────────────────

async function handleDetail(req, res, id) {
	if (cors(req, res, { methods: 'GET,OPTIONS' })) return;
	if (!method(req, res, ['GET'])) return;

	const rl = await limits.widgetRead(clientIp(req));
	if (!rl.success) return error(res, 429, 'rate_limited', 'too many requests');

	const [row] = await sql`
		SELECT p.*, u.display_name AS author_display_name,
		       ap.amount        AS asset_price_amount,
		       ap.currency_mint AS asset_price_currency_mint,
		       ap.chain         AS asset_price_chain,
		       ap.mint_decimals AS asset_price_mint_decimals
		FROM plugins p
		LEFT JOIN users u ON u.id = p.author_id
		LEFT JOIN asset_prices ap
		       ON ap.item_type = 'plugin' AND ap.item_id = p.id AND ap.is_active = true
		WHERE p.id = ${id} AND p.deleted_at IS NULL
	`;
	if (!row) return error(res, 404, 'not_found', 'plugin not found');

	return json(res, 200, { data: { plugin: toPlugin(row) } });
}

// ── Import by URL ─────────────────────────────────────────────────────────────

async function handleImport(req, res) {
	if (cors(req, res, { methods: 'POST,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['POST'])) return;

	const rl = await limits.widgetRead(clientIp(req));
	if (!rl.success) return error(res, 429, 'rate_limited', 'too many requests');

	const body = await readJson(req);
	const manifestUrl = (body?.manifest_url || '').trim();
	if (!manifestUrl) return error(res, 400, 'validation_error', 'manifest_url is required');

	let parsed;
	try {
		parsed = new URL(manifestUrl);
	} catch {
		return error(res, 400, 'validation_error', 'manifest_url is not a valid URL');
	}
	if (!['https:', 'http:'].includes(parsed.protocol))
		return error(res, 400, 'validation_error', 'manifest_url must be http or https');

	// Fetch the manifest server-side to avoid CORS issues
	let manifest;
	try {
		const ac = new AbortController();
		const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
		const resp = await fetch(manifestUrl, { signal: ac.signal });
		clearTimeout(timer);
		if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
		const text = await resp.text();
		if (text.length > MAX_MANIFEST_BYTES)
			throw new Error(`Manifest exceeds ${MAX_MANIFEST_BYTES / 1024}KB limit`);
		manifest = JSON.parse(text);
	} catch (err) {
		return error(res, 422, 'fetch_failed', `Could not fetch manifest: ${err.message}`);
	}

	try {
		validateManifest(manifest);
	} catch (err) {
		return error(res, 422, 'invalid_manifest', err.message);
	}

	// Return the validated manifest — client decides whether to install locally
	return json(res, 200, {
		data: {
			manifest: { ...manifest, _manifest_url: manifestUrl },
		},
	});
}

// ── Publish ───────────────────────────────────────────────────────────────────

const publishSchema = z.object({
	manifest_json: z.record(z.any()),
	manifest_url: z.string().url().optional(),
	is_public: z.boolean().default(true),
});

async function handlePublish(req, res) {
	if (cors(req, res, { methods: 'POST,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['POST'])) return;

	const auth = await resolveAuth(req);
	if (!auth) return error(res, 401, 'unauthorized', 'authentication required');

	const rl = await limits.widgetRead(clientIp(req));
	if (!rl.success) return error(res, 429, 'rate_limited', 'too many requests');

	const raw = await readJson(req);
	let body;
	try {
		body = publishSchema.parse(raw);
	} catch (err) {
		return error(res, 400, 'validation_error', err.errors?.[0]?.message || 'invalid body');
	}

	const manifest = body.manifest_json;
	try {
		validateManifest(manifest);
	} catch (err) {
		return error(res, 422, 'invalid_manifest', err.message);
	}

	const name = String(manifest.meta?.title || manifest.identifier).slice(0, 80);
	const description = String(manifest.meta?.description || '').slice(0, 500);
	const category = String(manifest.meta?.category || 'general').slice(0, 50);
	const tags = Array.isArray(manifest.meta?.tags)
		? manifest.meta.tags.slice(0, 20).map((t) => String(t).slice(0, 40))
		: [];

	// Upsert on identifier + author so re-publishing updates the record
	const [row] = await sql`
		INSERT INTO plugins (author_id, identifier, manifest_url, manifest_json, name, description, category, tags, is_public)
		VALUES (
			${auth.userId},
			${manifest.identifier},
			${body.manifest_url ?? null},
			${JSON.stringify(manifest)},
			${name},
			${description},
			${category},
			${tags},
			${body.is_public}
		)
		ON CONFLICT (identifier, author_id) DO UPDATE SET
			manifest_url  = EXCLUDED.manifest_url,
			manifest_json = EXCLUDED.manifest_json,
			name          = EXCLUDED.name,
			description   = EXCLUDED.description,
			category      = EXCLUDED.category,
			tags          = EXCLUDED.tags,
			is_public     = EXCLUDED.is_public,
			updated_at    = now()
		RETURNING *
	`;

	return json(res, 200, { data: { plugin: toPlugin(row) } });
}

// ── Install (counter) ─────────────────────────────────────────────────────────

async function handleInstall(req, res, id) {
	if (cors(req, res, { methods: 'POST,OPTIONS' })) return;
	if (!method(req, res, ['POST'])) return;

	const rl = await limits.widgetRead(clientIp(req));
	if (!rl.success) return error(res, 429, 'rate_limited', 'too many requests');

	await sql`
		UPDATE plugins SET install_count = install_count + 1 WHERE id = ${id} AND deleted_at IS NULL
	`;
	return json(res, 200, { data: { ok: true } });
}
