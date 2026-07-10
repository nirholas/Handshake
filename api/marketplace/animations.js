// GET /api/marketplace/animations — the marketplace feed of creator-listed
// avatar animations.
//
// Surfaces animation_clips where listed = true: clips a creator priced + staged
// an animated GLB for, via api/animations/sell.js. Each row carries its price,
// thumbnail, creator, and the x402 download route the buyer pays against
// (api/x402/animation-download.js). Read-only + public — no auth required.
//
//   ?q=          full-text-ish match on name / description
//   ?tag=        single tag filter
//   ?kind=       animation | loop | sequence
//   ?price=      free | paid
//   ?sort=       recent (default) | popular | price_low | price_high
//   ?limit=      1..60 (default 24)
//   ?cursor=     opaque pagination cursor

import { sql } from '../_lib/db.js';
import { cors, error, json, method, wrap } from '../_lib/http.js';
import { thumbnailUrl } from '../_lib/r2.js';
import { isUuid } from '../_lib/validate.js';

const SORTS = {
	recent: 'created_at desc',
	popular: 'purchase_count desc, created_at desc',
	price_low: 'price_amount asc nulls first, created_at desc',
	price_high: 'price_amount desc nulls last, created_at desc',
};

const DOWNLOAD_ROUTE = '/api/x402/animation-download';

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS' })) return;
	if (!method(req, res, ['GET'])) return;

	const url = new URL(req.url, 'http://x');

	// Single-listing lookup (?id=) — public metadata + poster for the purchase
	// modal / deep link. Never returns the baked clip JSON (that's the product).
	const idParam = (url.searchParams.get('id') || '').trim();
	if (idParam) return handleOne(res, idParam);

	const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 24, 1), 60);
	const q = (url.searchParams.get('q') || '').trim().slice(0, 80);
	const tag = (url.searchParams.get('tag') || '').trim().slice(0, 40);
	const kind = url.searchParams.get('kind');
	const price = url.searchParams.get('price');
	const sort = SORTS[url.searchParams.get('sort')] || SORTS.recent;
	const cursor = url.searchParams.get('cursor');

	// Positional-parameter WHERE — the Neon client doesn't interpolate nested
	// sql`` fragments (same pattern as api/animations/clips.js).
	const params = [];
	const conds = ['c.listed = true', 'c.deleted_at is null', 'c.artifact_key is not null'];

	if (q) {
		params.push(`%${q}%`);
		conds.push(`(c.name ilike $${params.length} or c.description ilike $${params.length})`);
	}
	if (tag) {
		params.push(tag);
		conds.push(`$${params.length} = any(c.tags)`);
	}
	if (kind && /^[a-z]+$/.test(kind)) {
		params.push(kind);
		conds.push(`c.kind = $${params.length}`);
	}
	if (price === 'free') conds.push('(c.price_amount is null or c.price_amount <= 0)');
	if (price === 'paid') conds.push('c.price_amount > 0');
	if (cursor) {
		const decoded = decodeCursor(cursor);
		if (decoded) {
			params.push(decoded.createdAt);
			conds.push(`c.created_at < $${params.length}`);
		}
	}
	params.push(limit + 1);

	let rows;
	try {
		rows = await sql(
			`select c.id, c.slug, c.name, c.description, c.kind, c.duration_ms,
			        c.frame_count, c.fps, c.loop, c.tags, c.thumbnail_key,
			        c.price_amount, c.price_currency, c.artifact_bytes,
			        c.play_count, c.purchase_count, c.created_at,
			        u.display_name as creator_name, u.username as creator_username,
			        u.avatar_url as creator_avatar
			 from animation_clips c
			 left join users u on u.id = c.owner_id
			 where ${conds.join(' and ')}
			 order by ${sort}
			 limit $${params.length}`,
			params,
		);
	} catch (err) {
		console.error('[marketplace/animations]', err?.message || err);
		return error(res, 500, 'db_error', 'Failed to load animations');
	}

	const hasMore = rows.length > limit;
	const page = hasMore ? rows.slice(0, limit) : rows;
	const items = page.map(shape);
	const nextCursor = hasMore ? encodeCursor({ createdAt: rows[limit - 1].created_at }) : null;

	res.setHeader('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=300');
	return json(res, 200, { items, next_cursor: nextCursor });
});

async function handleOne(res, id) {
	if (!isUuid(id)) return error(res, 400, 'invalid_request', 'id must be a uuid');
	let row;
	try {
		[row] = await sql`
			select c.id, c.slug, c.name, c.description, c.kind, c.duration_ms,
			       c.frame_count, c.fps, c.loop, c.tags, c.thumbnail_key,
			       c.price_amount, c.price_currency, c.artifact_bytes,
			       c.play_count, c.purchase_count, c.created_at,
			       u.display_name as creator_name, u.username as creator_username,
			       u.avatar_url as creator_avatar
			from animation_clips c
			left join users u on u.id = c.owner_id
			where c.id = ${id} and c.listed = true and c.deleted_at is null
			      and c.artifact_key is not null
			limit 1
		`;
	} catch (err) {
		console.error('[marketplace/animations/one]', err?.message || err);
		return error(res, 500, 'db_error', 'Failed to load animation');
	}
	if (!row) return error(res, 404, 'not_found', 'animation listing not found');
	res.setHeader('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=300');
	return json(res, 200, { item: shape(row) });
}

function shape(row) {
	const paid = row.price_amount != null && Number(row.price_amount) > 0;
	return {
		id: row.id,
		slug: row.slug,
		name: row.name,
		description: row.description,
		kind: row.kind,
		duration_ms: row.duration_ms,
		duration: row.duration_ms / 1000,
		frame_count: row.frame_count,
		fps: row.fps,
		loop: row.loop,
		tags: row.tags || [],
		thumbnail_url: thumbnailUrl(row.thumbnail_key),
		price: paid ? { amount: String(row.price_amount), currency: row.price_currency || 'USDC' } : null,
		free: !paid,
		size_bytes: row.artifact_bytes != null ? Number(row.artifact_bytes) : null,
		play_count: Number(row.play_count || 0),
		purchase_count: Number(row.purchase_count || 0),
		download_url: `${DOWNLOAD_ROUTE}?id=${row.id}`,
		creator: {
			name: row.creator_name || row.creator_username || 'Anonymous',
			username: row.creator_username || null,
			avatar_url: row.creator_avatar || null,
		},
		created_at: row.created_at,
	};
}

function encodeCursor({ createdAt }) {
	return Buffer.from(JSON.stringify({ c: createdAt })).toString('base64url');
}
function decodeCursor(cursor) {
	try {
		const obj = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
		return { createdAt: new Date(obj.c) };
	} catch {
		return null;
	}
}

export const __test__ = { shape, encodeCursor, decodeCursor, SORTS };
