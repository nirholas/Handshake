/**
 * Oracle: batch conviction scores for multiple mints.
 *
 *   GET /api/oracle/batch?mints=<m1>,<m2>,...&network=mainnet
 *
 * Accepts up to 20 base58 mints (comma-separated). Returns a map of
 *   { mint → { score, tier, pillars: { pedigree, structure, narrative, momentum } } }
 * for every mint that exists in the oracle_conviction cache. Mints with no
 * cached score are omitted (not an error: it means unscored).
 *
 * Used by the watchlist page and any surface that needs conviction badges for
 * a known set of coins without issuing N individual /api/oracle/coin requests.
 *
 * Public, IP rate-limited, 30-second CDN cache.
 */

import { cors, json, method, wrap, error, rateLimited } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { sql } from '../_lib/db.js';
import { QUOTE_MINT_LIST } from '../_lib/quote-mints.js';

const NETWORKS = new Set(['mainnet', 'devnet']);
const MINT_RE  = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const MAX_MINTS = 20;

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS', origins: '*' })) return;
	if (!method(req, res, ['GET'])) return;

	const rl = await limits.publicIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const params  = new URL(req.url, `http://${req.headers.host || 'x'}`).searchParams;
	const network = NETWORKS.has(params.get('network')) ? params.get('network') : 'mainnet';
	const raw     = (params.get('mints') || '').trim();

	if (!raw) return error(res, 400, 'validation_error', '`mints` query param is required');

	const mints = [...new Set(
		raw.split(',')
			.map((m) => m.trim())
			.filter((m) => MINT_RE.test(m))
	)].slice(0, MAX_MINTS);

	if (mints.length === 0) return error(res, 400, 'validation_error', 'no valid base58 mints provided');

	const rows = await sql`
		select mint, score, tier, pedigree, structure, narrative, momentum
		from oracle_conviction
		where network = ${network}
		  and mint = any(${mints})
		  and mint <> all(${QUOTE_MINT_LIST}::text[])
	`.catch((e) => {
		throw new Error(`batch query failed: ${e.message}`);
	});

	const results = {};
	for (const r of rows) {
		results[r.mint] = {
			score: r.score != null ? Number(r.score) : null,
			tier:  r.tier || null,
			pillars: {
				pedigree:  r.pedigree  != null ? Number(r.pedigree)  : null,
				structure: r.structure != null ? Number(r.structure) : null,
				narrative: r.narrative != null ? Number(r.narrative) : null,
				momentum:  r.momentum  != null ? Number(r.momentum)  : null,
			},
		};
	}

	return json(res, 200, { network, results, queried: mints.length, found: rows.length }, {
		'cache-control': 'public, max-age=30, s-maxage=60, stale-while-revalidate=120',
	});
});
