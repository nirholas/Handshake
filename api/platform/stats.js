// GET /api/platform/stats
// ────────────────────────────────────────────────────────────────────────────
// Returns aggregate public-safe platform metrics for the marketing homepage
// and any unauthenticated surface that wants to display traction figures.
//
// All figures are counts that don't expose individual user data.
// Cache: 5 minutes CDN + 5 minutes server-side to avoid hammering the DB on
// every homepage hit.

import { sql } from '../_lib/db.js';
import { cors, json, method, wrap } from '../_lib/http.js';

export const config = { runtime: 'nodejs' };

const CACHE_TTL_MS = 5 * 60_000;
let _cache = { value: null, expiresAt: 0 };

export function _resetStatsCache() {
	_cache = { value: null, expiresAt: 0 };
}

async function computeStats() {
	const now = Date.now();
	if (_cache.value && _cache.expiresAt > now) return _cache.value;

	const [agents, views, chats, avatars, countries, widgets] = await Promise.allSettled([
		// Total published agents with wallets or 3D avatars
		sql`
			select count(*)::int as n
			from agent_identities
			where deleted_at is null
		`,
		// All-time widget view count
		sql`
			select coalesce(count(*)::bigint, 0) as n
			from widget_views
		`,
		// All-time chat conversation count
		sql`
			select coalesce(count(*)::bigint, 0) as n
			from widget_chat_threads
		`,
		// Total avatars uploaded (GLBs)
		sql`
			select count(*)::int as n
			from avatars
			where deleted_at is null
		`,
		// Countries reached via widget views
		sql`
			select count(distinct country)::int as n
			from widget_views
			where country is not null and country <> ''
		`,
		// Active widgets (published + visible)
		sql`
			select count(*)::int as n
			from widgets
			where deleted_at is null
		`,
	]);

	const safe = (res, fallback = 0) => {
		if (res.status === 'rejected') return fallback;
		return Number(res.value?.[0]?.n ?? fallback);
	};

	const stats = {
		agents:    safe(agents),
		views:     safe(views),
		chats:     safe(chats),
		avatars:   safe(avatars),
		countries: safe(countries),
		widgets:   safe(widgets),
		chains:    6,   // Solana + EVM + Base + Polygon + Arbitrum + Optimism
		generated: new Date().toISOString(),
	};

	_cache = { value: stats, expiresAt: now + CACHE_TTL_MS };
	return stats;
}

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS', origins: '*' })) return;
	if (!method(req, res, ['GET'])) return;

	const stats = await computeStats();
	return json(res, 200, stats, {
		'cache-control': 'public, max-age=300, s-maxage=300, stale-while-revalidate=60',
	});
});
