/**
 * Oracle: category intelligence summary.
 *
 *   GET /api/oracle/categories?network=mainnet&hours=24
 *
 * Aggregates oracle_conviction rows from the last `hours` window by category,
 * returning per-category stats sorted by average conviction score:
 *
 *   category        : the narrative label
 *   total           : total coins scored in this category in the window
 *   avg_score       : mean conviction score
 *   prime_count     : coins at prime tier (score >= 86)
 *   strong_count    : coins at strong tier (72 to 85)
 *   best_score      : highest single score in this category
 *   best_mint       : mint address of the best coin
 *   best_symbol     : symbol of the best coin
 *   best_image_uri  : image of the best coin
 *
 * Use this endpoint to render a "hot sectors" panel that tells users which
 * narrative categories are generating the highest conviction right now.
 *
 * Public, IP rate-limited, 5-minute CDN cache.
 */

import { cors, json, method, wrap, rateLimited } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { sql, isDbUnavailableError } from '../_lib/db.js';
import { QUOTE_MINT_LIST } from '../_lib/quote-mints.js';

const NETWORKS = new Set(['mainnet', 'devnet']);

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS', origins: '*' })) return;
	if (!method(req, res, ['GET'])) return;

	const rl = await limits.publicIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const p       = new URL(req.url, `http://${req.headers.host || 'x'}`).searchParams;
	const network = NETWORKS.has(p.get('network')) ? p.get('network') : 'mainnet';
	const hours   = Math.min(72, Math.max(1, Number(p.get('hours')) || 24));

	const rows = await sql`
		with base as (
			select
				coalesce(category, 'unknown') as category,
				score, tier, mint, symbol, image_uri
			from oracle_conviction
			where network = ${network}
			  and scored_at > now() - (${hours} || ' hours')::interval
			  and category is not null
			  and mint <> all(${QUOTE_MINT_LIST}::text[])
		),
		agg as (
			select
				category,
				count(*)                                              as total,
				round(avg(score)::numeric, 1)                         as avg_score,
				count(*) filter (where tier = 'prime')                as prime_count,
				count(*) filter (where tier = 'strong')               as strong_count,
				max(score)                                            as best_score
			from base
			group by category
			having count(*) >= 2
		),
		best_coin as (
			select distinct on (b.category)
				b.category, b.mint as best_mint, b.symbol as best_symbol, b.image_uri as best_image_uri
			from base b
			join agg a on a.category = b.category
			where b.score = a.best_score
			order by b.category, b.mint
		)
		select a.*, bc.best_mint, bc.best_symbol, bc.best_image_uri
		from agg a
		join best_coin bc on bc.category = a.category
		order by a.avg_score desc, a.prime_count desc, a.total desc
		limit 12
	`.catch((err) => {
		// A connectivity failure is not "no hot sectors right now". Returning [] for
		// it served a confident empty panel with a 5-minute CDN cache, so a blip
		// lasting seconds showed users a dead market for the next five minutes.
		// Rethrow so wrap() answers 503 + Retry-After and nothing caches the lie;
		// a statement-level fault still degrades to the empty panel.
		if (isDbUnavailableError(err)) throw err;
		return [];
	});

	const items = rows.map((r) => ({
		category:       r.category,
		total:          Number(r.total),
		avg_score:      Number(r.avg_score),
		prime_count:    Number(r.prime_count),
		strong_count:   Number(r.strong_count),
		best_score:     r.best_score,
		best_mint:      r.best_mint,
		best_symbol:    r.best_symbol,
		best_image_uri: r.best_image_uri || null,
	}));

	return json(res, 200, {
		network,
		hours,
		count: items.length,
		items,
		generated_at: new Date().toISOString(),
	}, { 'Cache-Control': 'public, max-age=300, stale-while-revalidate=600' });
});
