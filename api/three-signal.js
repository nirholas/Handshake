// GET /api/three-signal
//
// Public, free read of the $THREE Signal Feed — the latest market snapshot plus
// a short sparkline history. This is NOT the paid oracle (/api/x402/three-intel);
// it serves the data the x402 autonomous loop already paid to fetch and stored in
// the three_market_signals time series (writer: the `three-intel` registry entry,
// every 15 min). The $THREE price widget reads this so it can render a live price
// without charging the viewer per glance.
//
// Query:
//   history  optional int (1..500) — sparkline points to return (default 48)
//
// Response:
//   {
//     latest: { mint, symbol, price_usd, change_24h, market_cap_usd,
//               liquidity_usd, volume_24h_usd, signal, headline, confidence, ts } | null,
//     history: [{ ts, price_usd, change_24h, signal }],   // oldest → newest
//     stale: boolean,        // true when the latest point is older than 45 min
//     age_seconds: number|null
//   }

import { cors, json, method, error, wrap } from './_lib/http.js';
import { sql, isDbUnavailableError } from './_lib/db.js';
import { getLatestThreeSignal, getThreeSignalHistory } from './_lib/x402/three-signal-store.js';

// The feed writes every 15 min; flag anything older than 3 missed ticks as stale
// so the widget can show a "last updated" hint instead of a misleadingly live price.
const STALE_AFTER_MS = 45 * 60 * 1000;

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS', origins: '*' })) return;
	if (!method(req, res, ['GET'])) return;

	const rawHistory = parseInt(req.query?.history ?? '48', 10);
	const historyLimit = Number.isFinite(rawHistory) ? Math.max(1, Math.min(500, rawHistory)) : 48;

	let latest = null;
	let history = [];
	try {
		[latest, history] = await Promise.all([
			getLatestThreeSignal(sql),
			getThreeSignalHistory(sql, historyLimit),
		]);
	} catch (err) {
		// During a DB outage the feed simply has nothing to serve yet — degrade to a
		// 503 the widget can retry, rather than a hard 500. Unknown errors rethrow to
		// wrap()'s alerting path.
		if (isDbUnavailableError(err)) {
			return error(res, 503, 'feed_unavailable', 'the $THREE signal feed is temporarily unavailable');
		}
		throw err;
	}

	let ageSeconds = null;
	let stale = true;
	if (latest?.ts) {
		const ageMs = Date.now() - new Date(latest.ts).getTime();
		ageSeconds = Math.max(0, Math.round(ageMs / 1000));
		stale = ageMs > STALE_AFTER_MS;
	}

	return json(res, 200, { latest, history, stale, age_seconds: ageSeconds }, {
		// Cache for a fraction of the 15-min write cadence — fresh enough, but the CDN
		// absorbs widget traffic so the DB isn't hit on every page load.
		'Cache-Control': 'public, max-age=60, s-maxage=60',
	});
});
