/**
 * GET /api/copy/smart-wallets — the Smart Money directory for /dashboard/copy.
 *
 *   ?chain=sol|bsc        filter by chain        (default: all)
 *   ?category=smart_money|launchpad|kol|sniper   (default: all)
 *   ?sort=profit|pnl|winrate|followers|score     (default: score)
 *   ?q=<text>             match address / name / twitter handle
 *   ?limit=1..100         page size              (default: 30)
 *   ?offset=0..           page offset            (default: 0)
 *
 * Serves the curated, deduplicated wallet directory distilled from gmgn.ai's
 * smart-money taxonomy (scripts/build-smart-wallets.mjs). Wallet identity +
 * 30-day performance only — never token mints. Public, IP rate-limited, cached
 * at the edge: the ranking shifts daily, not by the second.
 */

import { readFileSync } from 'node:fs';
import { cors, json, method, wrap, rateLimited } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';

let DIR = { meta: { total: 0, counts: {} }, wallets: [] };
try {
	DIR = JSON.parse(readFileSync(new URL('../_lib/copy/smart-wallets.json', import.meta.url), 'utf8'));
} catch { /* directory absent — endpoint returns empty, never throws */ }

const WALLETS = Array.isArray(DIR.wallets) ? DIR.wallets : [];
const CHAINS = new Set(['sol', 'bsc']);
const CATEGORIES = new Set(['smart_money', 'launchpad', 'kol', 'sniper']);

const SORTERS = {
	score: (a, b) => b.score - a.score,
	profit: (a, b) => b.realized_profit_30d_usd - a.realized_profit_30d_usd,
	pnl: (a, b) => (b.pnl_30d ?? -Infinity) - (a.pnl_30d ?? -Infinity),
	winrate: (a, b) => (b.win_rate_30d ?? -Infinity) - (a.win_rate_30d ?? -Infinity),
	followers: (a, b) => (b.follow_count ?? 0) - (a.follow_count ?? 0),
};

function clampInt(value, min, max, fallback) {
	const n = Number.parseInt(value, 10);
	if (!Number.isFinite(n)) return fallback;
	return Math.min(Math.max(n, min), max);
}

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS' })) return;
	if (!method(req, res, ['GET'])) return;

	const rl = await limits.mcpIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const params = new URL(req.url, `http://${req.headers.host || 'x'}`).searchParams;
	const chain = CHAINS.has(params.get('chain')) ? params.get('chain') : null;
	const category = CATEGORIES.has(params.get('category')) ? params.get('category') : null;
	const sort = SORTERS[params.get('sort')] ? params.get('sort') : 'score';
	const q = (params.get('q') || '').trim().toLowerCase();
	const limit = clampInt(params.get('limit'), 1, 100, 30);
	const offset = clampInt(params.get('offset'), 0, 100000, 0);

	let rows = WALLETS;
	if (chain) rows = rows.filter((w) => w.chain === chain);
	if (category) rows = rows.filter((w) => w.categories.includes(category));
	if (q) {
		rows = rows.filter((w) =>
			w.address.toLowerCase().includes(q) ||
			(w.name && w.name.toLowerCase().includes(q)) ||
			(w.twitter_username && w.twitter_username.toLowerCase().includes(q)));
	}

	const total = rows.length;
	const page = [...rows].sort(SORTERS[sort]).slice(offset, offset + limit);

	return json(res, 200, {
		wallets: page,
		total,
		offset,
		limit,
		has_more: offset + page.length < total,
		facets: DIR.meta?.counts || { byChain: {}, byCategory: {} },
		source: DIR.meta?.source || null,
		generated_at: DIR.meta?.generated_at || null,
	}, { 'cache-control': 'public, s-maxage=3600, stale-while-revalidate=86400' });
});
