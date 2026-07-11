// GET /api/coin/category?id=<category-slug>
// ---------------------------------------------------------------------------
// Rich profile for one crypto sector — powers the /category/:id detail page.
// One cached fetch of CoinGecko /coins/categories?order=market_cap_desc serves
// every category: the entry is found by id, its ordinal in the mcap-ordered
// list becomes the rank, and the 8 nearest neighbours by rank become the
// related-categories strip. `share_of_total` is this category's market cap as
// a percentage of the SUM of all category market caps — categories overlap (a
// coin sits in many), so it is a share of the categorized market, not of total
// crypto market cap. The description comes from the upstream `content` field,
// stripped to plain text server-side like api/coin/detail.js.

import { cors, json, method, wrap, error, rateLimited } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { geckoFetch, htmlToText } from '../_lib/coingecko.js';

const CATEGORY_ID_RE = /^[a-z0-9-]{1,80}$/;

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

// The 8 rank-nearest categories around `index`, excluding the category itself.
// A window of 9 slots centred on the entry, clamped to the list edges, always
// yields 8 neighbours whenever the list has at least 9 categories.
function relatedByRank(ranked, index, want = 8) {
	const start = Math.max(0, Math.min(index - Math.floor(want / 2), ranked.length - (want + 1)));
	const out = [];
	for (let i = start; i < ranked.length && out.length < want; i++) {
		if (i === index) continue;
		const c = ranked[i];
		out.push({
			id: c.id,
			name: c.name || c.id,
			market_cap: num(c.market_cap),
			market_cap_change_24h: num(c.market_cap_change_24h),
		});
	}
	return out;
}

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS', origins: '*' })) return;
	if (!method(req, res, ['GET'])) return;

	const rl = await limits.marketDataIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const params = new URL(req.url, 'http://x').searchParams;
	const id = (params.get('id') || '').trim().toLowerCase();
	if (!CATEGORY_ID_RE.test(id)) {
		return error(
			res,
			400,
			'bad_id',
			'id must be a CoinGecko category slug (lowercase letters, digits, hyphens)',
		);
	}

	let raw;
	try {
		raw = await geckoFetch('/coins/categories?order=market_cap_desc', {
			ttlMs: 600_000,
			timeoutMs: 10_000,
		});
		if (!Array.isArray(raw)) throw new Error('unexpected upstream payload');
	} catch {
		return error(
			res,
			502,
			'upstream_error',
			'category data is unavailable right now — retry shortly',
		);
	}

	const ranked = raw.filter((c) => c && typeof c.id === 'string');
	const index = ranked.findIndex((c) => c.id === id);
	if (index < 0) return error(res, 404, 'not_found', `no category found for "${id}"`);

	const c = ranked[index];
	const marketCap = num(c.market_cap);
	let categorizedTotal = 0;
	for (const r of ranked) {
		const mc = num(r.market_cap);
		if (mc != null) categorizedTotal += mc;
	}

	return json(
		res,
		200,
		{
			category: {
				id: c.id,
				name: c.name || c.id,
				description: htmlToText(c.content || '').slice(0, 2000) || null,
				market_cap: marketCap,
				market_cap_change_24h: num(c.market_cap_change_24h),
				volume_24h: num(c.volume_24h),
				top_3_coins: Array.isArray(c.top_3_coins)
					? c.top_3_coins.filter((u) => typeof u === 'string' && u).slice(0, 3)
					: [],
				rank: index + 1,
				share_of_total: marketCap != null && categorizedTotal > 0 ? (marketCap / categorizedTotal) * 100 : null,
			},
			related: relatedByRank(ranked, index),
		},
		{
			'cache-control': 'public, max-age=300, s-maxage=600, stale-while-revalidate=1800',
		},
	);
});
