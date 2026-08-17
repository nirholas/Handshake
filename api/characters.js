/**
 * GET /api/characters — paginated feed of published agent characters.
 *
 * Query params:
 *   limit=<int>    — page size, default 24, max 60
 *   cursor=<opaque>— echoed back from a previous response's `next_cursor`
 *   q=<text>       — name/description substring search
 *   sort=<field>   — "chats" | "new" (default "new")
 *
 * The cursor is keyset state and its shape follows the sort, because a keyset
 * cursor has to carry every column the ORDER BY uses:
 *   sort=new    → "<created_at ISO>"
 *   sort=chats  → "<chat_count>:<created_at ISO>"
 * Treat it as opaque; the client only ever echoes `next_cursor` back.
 */

import { sql } from './_lib/db.js';
import { cors, error, json, method, wrap, rateLimited } from './_lib/http.js';
import { clampInt } from './_lib/http-params.js';
import { limits, clientIp } from './_lib/rate-limit.js';
import { thumbnailUrl } from './_lib/r2.js';

// Decode the keyset cursor for the requested sort. Returns null for a cursor
// that does not parse: it is only ever produced by us and echoed back, so an
// unparseable one is a hand-edited URL and earns a 400 rather than a 500
// (`new Date('junk').toISOString()` throws a RangeError, which is how a caller
// mistake used to surface as a server error).
function parseCursor(raw, sortByChats) {
	if (!raw) return { chats: null, iso: null };
	if (!sortByChats) {
		return Number.isNaN(Date.parse(raw)) ? null : { chats: null, iso: new Date(raw).toISOString() };
	}
	const split = raw.indexOf(':');
	if (split < 1) return null;
	const chats = Number(raw.slice(0, split));
	const stamp = raw.slice(split + 1);
	if (!Number.isInteger(chats) || chats < 0) return null;
	if (Number.isNaN(Date.parse(stamp))) return null;
	return { chats, iso: new Date(stamp).toISOString() };
}

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS', origins: '*' })) return;
	if (!method(req, res, ['GET'])) return;

	const rl = await limits.publicIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const url = new URL(req.url, 'http://x');
	const limit = clampInt(url.searchParams.get('limit'), { max: 60, fallback: 24 });
	const cursor = url.searchParams.get('cursor') || null;
	const q = (url.searchParams.get('q') || '').trim().slice(0, 80);
	const sort = url.searchParams.get('sort') === 'chats' ? 'chats' : 'new';

	const sortByChats = sort === 'chats';
	const keyset = parseCursor(cursor, sortByChats);
	if (!keyset) return error(res, 400, 'bad_request', 'cursor is not a cursor this endpoint issued');

	const qLike = q ? '%' + q + '%' : null;
	const cursorIso = keyset.iso;

	const columns = sql`
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
		a.visibility    AS avatar_visibility
	`;
	const joins = sql`
		FROM agent_identities i
		LEFT JOIN users u   ON i.user_id = u.id
		LEFT JOIN avatars a ON a.id = i.avatar_id AND a.deleted_at IS NULL
	`;
	const filters = sql`
		i.deleted_at IS NULL
		AND i.is_published = true
		AND i.description IS NOT NULL
		AND length(trim(i.name)) > 0
		AND (${qLike}::text IS NULL OR (i.name ILIKE ${qLike} OR i.description ILIKE ${qLike}))
	`;

	// Two query shapes rather than one conditional query, because the sorts have
	// genuinely different costs and different keyset keys.
	//
	// sort=new never needs chat_count to ORDER BY, so page first and count only
	// the rows that survive the LIMIT. Counting inside the pre-LIMIT set instead
	// ran the correlated aggregate once per published agent (2k+ index scans over
	// 260k usage_events), which is what made a cold request take seconds.
	//
	// sort=chats does need every candidate's count to rank them, so aggregate the
	// whole llm slice once with a GROUP BY (a single pass over the kind='llm'
	// partial index) instead of re-scanning per row.
	const rows = sortByChats
		? await sql`
			WITH counts AS (
				SELECT agent_id, COUNT(*)::int AS chat_count
				FROM usage_events
				WHERE kind = 'llm' AND agent_id IS NOT NULL
				GROUP BY agent_id
			)
			SELECT ${columns}, COALESCE(c.chat_count, 0) AS chat_count
			${joins}
			LEFT JOIN counts c ON c.agent_id = i.id
			WHERE ${filters}
			  AND (
				${keyset.chats}::int IS NULL
				OR (COALESCE(c.chat_count, 0), i.created_at)
				   < (${keyset.chats}::int, ${cursorIso}::timestamptz)
			  )
			ORDER BY COALESCE(c.chat_count, 0) DESC, i.created_at DESC
			LIMIT ${limit + 1}
		`
		: await sql`
			WITH page AS (
				SELECT ${columns}
				${joins}
				WHERE ${filters}
				  AND (${cursorIso}::timestamptz IS NULL OR i.created_at < ${cursorIso}::timestamptz)
				ORDER BY i.created_at DESC
				LIMIT ${limit + 1}
			)
			SELECT p.*, COALESCE((
				SELECT COUNT(*)::int
				FROM usage_events ue
				WHERE ue.agent_id = p.id AND ue.kind = 'llm'
			), 0) AS chat_count
			FROM page p
			ORDER BY p.created_at DESC
		`;

	const hasMore = rows.length > limit;
	const items = rows.slice(0, limit).map(row => {
		const meta = row.meta || {};
		const avatarThumbnail =
			row.avatar_thumbnail_key && (row.avatar_visibility === 'public' || row.avatar_visibility === 'unlisted')
				? thumbnailUrl(row.avatar_thumbnail_key)
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
			// Public custodial wallet address (same value GET /api/agents/:id/solana
			// serves anonymously) + its vanity pattern, so the shared wallet chip can
			// render on character cards. The signing secret never leaves the server.
			solana_address: typeof meta.solana_address === 'string' ? meta.solana_address : null,
			solana_vanity_prefix: meta.solana_vanity_prefix || null,
			solana_vanity_suffix: meta.solana_vanity_suffix || null,
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

	// The cursor has to name every ORDER BY column, or the next page restarts the
	// sort inside a shrunken window. Handing back a bare created_at under
	// sort=chats did exactly that: page 2 kept only agents older than the last row
	// and re-ranked those by chats, so "Top" silently ended after 8 of 2000+
	// characters instead of paging through them.
	const last = hasMore ? items[items.length - 1] : null;
	const lastIso = last ? new Date(last.created_at).toISOString() : null;
	const nextCursor = last ? (sortByChats ? `${last.chat_count}:${lastIso}` : lastIso) : null;

	// Public, non-personalized published-agents feed. CDN-cache so a traffic surge
	// is absorbed at the edge instead of re-running the chat_count aggregate on
	// every request; stale-while-revalidate keeps it warm across refreshes.
	return json(
		res,
		200,
		{ characters: items, next_cursor: nextCursor },
		{ 'cache-control': 'public, s-maxage=60, stale-while-revalidate=300' },
	);
});
