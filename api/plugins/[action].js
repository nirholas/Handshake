/**
 * Plugin Marketplace API
 * ─────────────────────
 * GET  /api/plugins/categories
 * GET  /api/plugins/list          ?category=&q=&sort=&cursor=&limit=
 * GET  /api/plugins/:id
 * POST /api/plugins/import { manifest_url }   — fetch + validate + optionally save
 * POST /api/plugins/publish       { manifest_json }  — publish plugin to marketplace
 * POST /api/plugins/:id/install   — increment install_count (called client-side on install)
 */

import { z } from 'zod';
import { sql } from '../_lib/db.js';
import { getSessionUser, authenticateBearer, extractBearer } from '../_lib/auth.js';
import { cors, error, json, method, readJson, wrap, rateLimited } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import {
	fetchSafePublicUrlPinned,
	MaxBytesExceededError,
	SsrfBlockedError,
} from '../_lib/ssrf-guard.js';
import { requireCsrf } from '../_lib/csrf.js';
import { isUuid } from '../_lib/validate.js';

const VALID_SORTS = new Set(['popular', 'new', 'az']);
const MAX_MANIFEST_BYTES = 64 * 1024; // 64 KB
const FETCH_TIMEOUT_MS = 8000;
// identifier is half of the (identifier, author_id) unique key and is echoed
// back in every listing, so it gets a length ceiling rather than inheriting the
// unbounded `text` column. api[] is capped for the same reason: the manifest is
// stored whole and re-served on every detail read.
const MAX_IDENTIFIER_LENGTH = 128;
const MAX_TOOLS = 100;
// Every tool declared here is handed straight to the model provider as a tool
// definition by the installer (src/plugins/index.js `toClaudeTools`), and both
// Anthropic and OpenAI reject a name outside this charset. Validating it at the
// publish boundary keeps a malformed manifest from breaking chat for everyone
// who installs it from the marketplace.
const TOOL_NAME_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;
const MAX_TOOL_DESCRIPTION_LENGTH = 1024;

// ── Manifest validation — LobeHub/pai-chat ToolManifest format ───────────────
// Required: identifier, meta.title, api[]
// Optional: systemRole, type, settings, version, openapi, gateway, ui

function validateManifest(json) {
	if (!json || typeof json !== 'object') throw new Error('Manifest must be a JSON object');
	if (!json.identifier || typeof json.identifier !== 'string')
		throw new Error('Missing identifier');
	if (!/^[a-z0-9._-]+$/i.test(json.identifier))
		throw new Error('identifier must be alphanumeric with dots, hyphens, or underscores');
	if (json.identifier.length > MAX_IDENTIFIER_LENGTH)
		throw new Error(`identifier must be ${MAX_IDENTIFIER_LENGTH} characters or fewer`);
	if (!json.meta?.title) throw new Error('Missing meta.title');
	if (!Array.isArray(json.api) || !json.api.length)
		throw new Error('api must be a non-empty array');
	if (json.api.length > MAX_TOOLS) throw new Error(`api must declare at most ${MAX_TOOLS} tools`);
	for (const tool of json.api) {
		if (!tool || typeof tool !== 'object' || Array.isArray(tool))
			throw new Error('every api entry must be a JSON object');
		if (typeof tool.name !== 'string' || !tool.name)
			throw new Error('every api entry needs a name, given as a string');
		// The name is echoed back in the message, so it is truncated: the manifest
		// ceiling still allows a 64KB one, and a rejection is not a reason to hand
		// the caller their own payload back in full.
		if (!TOOL_NAME_PATTERN.test(tool.name))
			throw new Error(
				`Tool "${tool.name.slice(0, 64)}" name must be 1-64 characters of letters, digits, underscores, or hyphens`,
			);
		if (typeof tool.description !== 'string' || !tool.description.trim())
			throw new Error(`Tool "${tool.name}" needs a non-empty description`);
		if (tool.description.length > MAX_TOOL_DESCRIPTION_LENGTH)
			throw new Error(
				`Tool "${tool.name}" description must be ${MAX_TOOL_DESCRIPTION_LENGTH} characters or fewer`,
			);
	}
	// The manifest is stored whole and re-served on every list and detail read, so
	// the same ceiling the import fetch enforces applies to a directly published
	// one. Without it /publish accepted a body up to readJson's generic limit.
	if (Buffer.byteLength(JSON.stringify(json), 'utf8') > MAX_MANIFEST_BYTES)
		throw new Error(`manifest must be ${MAX_MANIFEST_BYTES / 1024}KB or smaller`);
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
	const price =
		row.asset_price_amount != null
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
		author: row.author_id ? { id: row.author_id, display_name: row.author_display_name } : null,
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
	if (isUuid(segment)) {
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
	if (!rl.success) return rateLimited(res, rl);

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
	if (!rl.success) return rateLimited(res, rl);

	const q = (url.searchParams.get('q') || '').trim().slice(0, 80) || null;
	const category = url.searchParams.get('category') || null;
	const sortParam = url.searchParams.get('sort') || 'popular';
	const sort = VALID_SORTS.has(sortParam) ? sortParam : 'popular';
	const cursor = url.searchParams.get('cursor') || null;
	const limit = Math.min(40, Math.max(1, Number(url.searchParams.get('limit')) || 20));
	// The cursor is this endpoint's own opaque offset, handed back as next_cursor.
	// A hand-typed one still has to be a non-negative integer: Number('abc') is
	// NaN, and NaN reaching OFFSET made Postgres throw, which surfaced as a 500
	// for what is plainly a client fault.
	const offset = cursor === null ? 0 : Number(cursor);
	if (!Number.isInteger(offset) || offset < 0)
		return error(res, 400, 'validation_error', 'cursor must be a non-negative integer');
	// `%` and `_` are LIKE wildcards, so an unescaped search for "50%" matched
	// every row and "a_b" matched "axb". Escape them (and the escape character
	// itself) so the query text is taken literally, which is what the search box
	// promises.
	const qLike = q ? `%${q.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%` : null;
	const fetchLimit = limit + 1;

	// p.id closes the ORDER BY. Every seeded plugin shares one created_at and an
	// install_count of 0, so the sort key was not unique and Postgres was free to
	// order the ties differently per query: paging the marketplace at limit=2
	// returned one plugin twice and never showed another at all.
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
			p.created_at DESC,
			p.id DESC
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
	if (!rl.success) return rateLimited(res, rl);

	// `is_public: false` is a real publish option, and list/categories both honor
	// it. Detail used to read by id alone, so anyone holding the UUID could pull
	// an unpublished plugin's full manifest. Gate it the same way: public to
	// everyone, private to its author only. An anonymous reader has a null viewer
	// id, and `author_id = NULL` is never true, so the row simply 404s for them.
	const auth = await resolveAuth(req);
	const viewerId = auth?.userId ?? null;

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
		WHERE p.id = ${id}
		  AND p.deleted_at IS NULL
		  AND (p.is_public = true OR p.author_id = ${viewerId}::uuid)
	`;
	if (!row) return error(res, 404, 'not_found', 'plugin not found');

	return json(res, 200, { data: { plugin: toPlugin(row) } });
}

// ── Import by URL ─────────────────────────────────────────────────────────────

async function handleImport(req, res) {
	if (cors(req, res, { methods: 'POST,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['POST'])) return;

	const rl = await limits.pluginImportIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

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

	// Fetch the manifest server-side to avoid CORS issues. The pinned variant
	// DNS-resolves the host (and every redirect hop), rejects private, loopback,
	// link-local, and cloud-metadata ranges, and connects straight to the address
	// it validated so a hostile resolver cannot rebind between the check and the
	// socket. It is the right variant here because the fetched body is handed
	// back to the caller rather than merely rendered.
	//
	// maxBytes aborts the transfer the instant it crosses the manifest ceiling,
	// from the advertised content-length up front and from the streamed bytes
	// after that. Reading the body first and measuring it afterwards, as this
	// used to, let a hostile host stream gigabytes into the instance before the
	// size check ever ran.
	let manifest;
	try {
		const ac = new AbortController();
		const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
		let resp;
		try {
			resp = await fetchSafePublicUrlPinned(
				manifestUrl,
				{ signal: ac.signal },
				{ allowHttp: true, maxBytes: MAX_MANIFEST_BYTES },
			);
		} finally {
			clearTimeout(timer);
		}
		if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
		const text = await resp.text();
		try {
			manifest = JSON.parse(text);
		} catch {
			// Linking a repository page instead of the raw file is the common way to
			// land here, and a bare parse message ("Unexpected token '<'") does not
			// tell the caller that.
			return error(
				res,
				422,
				'invalid_manifest',
				'manifest_url did not return JSON. Link directly to the manifest file, not to a web page.',
			);
		}
	} catch (err) {
		if (err instanceof SsrfBlockedError)
			return error(res, 400, 'validation_error', `manifest_url rejected: ${err.message}`);
		if (err instanceof MaxBytesExceededError)
			return error(
				res,
				422,
				'fetch_failed',
				`Manifest exceeds the ${MAX_MANIFEST_BYTES / 1024}KB limit`,
			);
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
	// Cookie sessions are attached by the browser on any cross-site POST, so the
	// only thing separating a real publish from one a hostile page triggered is
	// the double-submit token. Bearer callers are exempt inside requireCsrf.
	if (!(await requireCsrf(req, res, auth.userId))) return;

	const rl = await limits.pluginPublishUser(auth.userId);
	if (!rl.success) return rateLimited(res, rl);

	// Bounded at the manifest ceiling plus room for the envelope's other fields, so
	// an oversized publish is refused (413) at the boundary instead of being parsed
	// into memory first and rejected by validateManifest afterwards.
	const raw = await readJson(req, MAX_MANIFEST_BYTES + 4096);
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

	// Upsert on identifier + author so re-publishing updates the record.
	// The RETURNING row carries author_id but no author_display_name, so the
	// author's name is joined back on afterwards: without it this endpoint answered
	// with a half-populated `author` object that list and detail both fill in.
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

	const [author] = await sql`SELECT display_name FROM users WHERE id = ${auth.userId}`;
	return json(res, 200, {
		data: { plugin: toPlugin({ ...row, author_display_name: author?.display_name ?? null }) },
	});
}

// ── Install (counter) ─────────────────────────────────────────────────────────

async function handleInstall(req, res, id) {
	if (cors(req, res, { methods: 'POST,OPTIONS' })) return;
	if (!method(req, res, ['POST'])) return;

	const ip = clientIp(req);
	const rl = await limits.widgetRead(ip);
	if (!rl.success) return rateLimited(res, rl);

	// Same visibility rule as detail: a private plugin's counter is its author's
	// business. Without this the endpoint confirmed a private plugin's existence
	// and let anyone holding the UUID drive its install_count.
	const auth = await resolveAuth(req);
	const viewerId = auth?.userId ?? null;
	const [target] = await sql`
		SELECT id, install_count FROM plugins
		WHERE id = ${id}
		  AND deleted_at IS NULL
		  AND (is_public = true OR author_id = ${viewerId}::uuid)
	`;
	if (!target) return error(res, 404, 'not_found', 'plugin not found');

	// One counted install per (IP, plugin) per 30 minutes. A repeat inside the
	// window is not an error the client should surface (the marketplace fires this
	// as fire-and-forget), so it answers 200 with counted:false and the unchanged
	// total rather than a 429 the caller would have to special-case.
	const dedupe = await limits.pluginInstallDedupe(`${ip}:${id}`);
	if (!dedupe.success)
		return json(res, 200, { data: { ok: true, counted: false, install_count: target.install_count } });

	const [row] = await sql`
		UPDATE plugins SET install_count = install_count + 1
		WHERE id = ${id} AND deleted_at IS NULL
		RETURNING install_count
	`;
	return json(res, 200, {
		data: { ok: true, counted: true, install_count: row?.install_count ?? target.install_count + 1 },
	});
}
