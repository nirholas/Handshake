/**
 * GET /api/characters — paginated feed of published agent characters.
 *
 * Query params:
 *   limit=<int>    — page size, default 24, max 60
 *   cursor=<iso>   — created_at ISO for keyset pagination
 *   q=<text>       — name/description substring search
 *   sort=<field>   — "chats" | "new" (default "new")
 */

import { sql } from './_lib/db.js';
import { cors, json, method, wrap, error } from './_lib/http.js';
import { limits, clientIp } from './_lib/rate-limit.js';
import { publicUrl } from './_lib/r2.js';

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS', origins: '*' })) return;
	if (!method(req, res, ['GET'])) return;

	const rl = await limits.publicIp(clientIp(req));
	if (!rl.success) return error(res, 429, 'rate_limited', 'too many requests');

	const url = new URL(req.url, 'http://x');
	const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') || '24', 10), 1), 60);
	const cursor = url.searchParams.get('cursor') || null;
	const q = (url.searchParams.get('q') || '').trim().slice(0, 80);
	const sort = url.searchParams.get('sort') === 'chats' ? 'chats' : 'new';

	const cursorDate = cursor ? new Date(cursor) : null;

	const qLike = q ? '%' + q + '%' : null;
	const cursorIso = cursorDate ? cursorDate.toISOString() : null;
	const sortByChats = sort === 'chats';

	// The CASE-based sort references the derived `chat_count`. Postgres only
	// resolves a bare output alias as a standalone ORDER BY key — used inside a
	// CASE expression it looks for a real column and 42703s. A CTE makes
	// chat_count a real column of the outer query, so the conditional sort works.
	const rows = await sql`
		WITH feed AS (
			SELECT
				i.id,
				i.name,
				i.description,
				i.meta,
				i.created_at,
				i.avatar_id,
				u.display_name  AS author_name,
				u.username      AS author_username,
				u.avatar_url    AS author_avatar,
				a.thumbnail_key AS avatar_thumbnail_key,
				a.visibility    AS avatar_visibility,
				COALESCE((
					SELECT COUNT(*)::int
					FROM usage_events ue
					WHERE ue.agent_id = i.id AND ue.kind = 'llm'
				), 0) AS chat_count
			FROM agent_identities i
			LEFT JOIN users u   ON i.user_id = u.id
			LEFT JOIN avatars a ON a.id = i.avatar_id AND a.deleted_at IS NULL
			WHERE i.deleted_at IS NULL
			  AND i.is_published = true
			  AND i.description IS NOT NULL
			  AND length(trim(i.name)) > 0
			  AND (${qLike}::text IS NULL OR (i.name ILIKE ${qLike} OR i.description ILIKE ${qLike}))
			  AND (${cursorIso}::timestamptz IS NULL OR i.created_at < ${cursorIso}::timestamptz)
		)
		SELECT * FROM feed
		ORDER BY
			CASE WHEN ${sortByChats}::boolean THEN chat_count ELSE 0 END DESC,
			created_at DESC
		LIMIT ${limit + 1}
	`;

	const hasMore = rows.length > limit;
	const items = rows.slice(0, limit).map(row => {
		const meta = row.meta || {};
		const avatarThumbnail =
			row.avatar_thumbnail_key && (row.avatar_visibility === 'public' || row.avatar_visibility === 'unlisted')
				? publicUrl(row.avatar_thumbnail_key)
				: null;

		const imageUrl =
			meta.profile_image_url ||
			meta.thumbnail_url ||
			meta.avatar_url ||
			avatarThumbnail ||
			null;

		const token = meta.token || null;

		return {
			id: row.id,
			name: row.name,
			description: row.description,
			image_url: imageUrl,
			author_name: row.author_name || null,
			author_username: row.author_username || null,
			author_avatar: row.author_avatar || null,
			chat_count: row.chat_count,
			token: token
				? {
					symbol: token.symbol || null,
					mint: token.mint || null,
					market_cap_usd: token.market_cap_usd ?? token.usd_market_cap ?? null,
					price_usd: token.price_usd ?? null,
					change_24h_percent: token.change_24h_percent ?? null,
					holders: token.holders ?? 0,
				  }
				: null,
			created_at: row.created_at,
		};
	});

	const nextCursor = hasMore ? items[items.length - 1].created_at : null;

	return json(res, 200, { characters: items, next_cursor: nextCursor });
});
