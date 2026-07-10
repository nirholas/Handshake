// GET /api/crypto/launches — free, keyless live feed of the freshest pump.fun
// launches.
//
// Agent use-case: a sniper/discovery agent polls for brand-new pump.fun mints
// with enough signal to filter — name, symbol, age, market cap, bonding-curve
// progress, dev wallet — then hands the interesting ones to /api/crypto/bonding
// (watch the curve) and /api/crypto/whales (watch the money). A free live feed
// is exactly what agents poll.
//
// Part of the free Crypto Data API (/api/crypto/*). Plain-handler pattern: no
// account, no key, generous per-IP limit. Real data only — the pump.fun public
// frontend feed via api/_lib/pump-launch-feed.js; curve math shared with
// /api/crypto/bonding via api/_lib/pump-bonding.js.

import { cors, method, wrap, error, json, rateLimited } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { fetchRecentPumpCoins } from '../_lib/pump-launch-feed.js';
import { mapBondingStatus } from '../_lib/pump-bonding.js';

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

// Parse an optional numeric query param. Returns null when absent, the number
// when valid, or NaN when present-but-malformed (caller answers 400).
function numParam(params, name) {
	const raw = params.get(name);
	if (raw == null || raw.trim() === '') return null;
	const n = Number(raw);
	return Number.isFinite(n) ? n : NaN;
}

// Raw pump.fun coin → the launch shape agents filter on. Curve math and market
// cap come from the SAME mapBondingStatus the bonding endpoint uses, so a coin's
// bondingProgressPct can never disagree between /launches and /bonding.
export function toLaunch(coin, nowMs) {
	const s = mapBondingStatus(coin);
	const createdMs = Number(coin.created_timestamp) || null;
	return {
		mint: coin.mint,
		name: coin.name || null,
		symbol: coin.symbol || null,
		createdAt: createdMs ? new Date(createdMs).toISOString() : null,
		// One decimal so a 30-second-old launch reads 0.5, not a misleading 0 or 1.
		ageMinutes: createdMs ? Math.max(0, Math.round(((nowMs - createdMs) / 60_000) * 10) / 10) : null,
		marketCapUsd: s.marketCapUsd,
		bondingProgressPct: s.bondingProgressPct,
		graduated: s.graduated,
		dev: coin.creator || null,
		url: `https://pump.fun/coin/${coin.mint}`,
		imageUrl: coin.image_uri || null,
	};
}

export default wrap(async (req, res) => {
	if (cors(req, res, { origins: '*' })) return;
	if (!method(req, res, ['GET'])) return;

	const rl = await limits.marketDataIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const url = new URL(req.url, 'http://localhost');
	const p = url.searchParams;

	const limitRaw = numParam(p, 'limit');
	if (Number.isNaN(limitRaw) || (limitRaw != null && (!Number.isInteger(limitRaw) || limitRaw < 1))) {
		return error(res, 400, 'invalid_limit', `\`limit\` must be an integer between 1 and ${MAX_LIMIT} (default ${DEFAULT_LIMIT})`);
	}
	const limit = Math.min(MAX_LIMIT, limitRaw ?? DEFAULT_LIMIT);

	const minMarketCap = numParam(p, 'minMarketCap');
	if (Number.isNaN(minMarketCap) || (minMarketCap != null && minMarketCap < 0)) {
		return error(res, 400, 'invalid_min_market_cap', '`minMarketCap` must be a non-negative number (USD)');
	}

	const maxAgeMin = numParam(p, 'maxAgeMin');
	if (Number.isNaN(maxAgeMin) || (maxAgeMin != null && maxAgeMin <= 0)) {
		return error(res, 400, 'invalid_max_age_min', '`maxAgeMin` must be a positive number of minutes');
	}

	// Always pull the full window upstream (one call either way) so filters can
	// drop coins without under-filling `limit`.
	const feed = await fetchRecentPumpCoins({ limit: MAX_LIMIT });
	const ts = new Date().toISOString();

	// Feed momentarily unreachable → an empty 200 with an honest source note,
	// never a 500: a polling agent treats it as "nothing this sweep" and retries.
	if (feed.kind === 'upstream_down') {
		return json(
			res,
			200,
			{
				launches: [],
				count: 0,
				ts,
				source: 'pumpfun:unavailable',
				note: 'pump.fun feed is temporarily unreachable — empty sweep, retry shortly',
			},
			{ 'cache-control': 'no-store' },
		);
	}

	const now = Date.now();
	let launches = feed.coins
		.filter((c) => c && c.mint)
		.map((c) => toLaunch(c, now))
		.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));

	// A coin whose cap/age is unknown can't prove it clears the bar — filters drop
	// it rather than guess.
	if (minMarketCap != null) {
		launches = launches.filter((l) => l.marketCapUsd != null && l.marketCapUsd >= minMarketCap);
	}
	if (maxAgeMin != null) {
		launches = launches.filter((l) => l.ageMinutes != null && l.ageMinutes <= maxAgeMin);
	}
	launches = launches.slice(0, limit);

	const body = { launches, count: launches.length, ts, source: 'pumpfun' };
	if (!launches.length) {
		body.note = 'no launches match the current filters — relax minMarketCap / maxAgeMin or retry';
	}
	return json(
		res,
		200,
		body,
		// Fresh launches appear every few seconds; a short CDN window keeps polling
		// agents current without hammering the pump.fun feed.
		{ 'cache-control': 'public, s-maxage=10, stale-while-revalidate=20' },
	);
});
