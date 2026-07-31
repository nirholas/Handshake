// GET /api/play/solver[?level=1..99][&curves=0]
//
// The solved economy of the /play coin worlds: for a given skill level, the exact
// expected cash, XP and yield per hour of every gatherable node in the world, the
// optimal fish-and-cook time split, the store's payback in minutes and swings, the
// wheel's expected value in store prices, per-kill combat value, and the conclusions
// that arithmetic reaches on its own.
//
// This is the companion to /api/play/economy. That endpoint publishes WHAT the world
// charges; this one publishes what those numbers MEAN. Both import the authoritative
// game modules rather than restating them, so neither can drift from the server.
//
// Nothing here is measured, sampled or estimated. Every yield rule in the game is a
// pure function of level and node tuning and every cadence is a constant, so the
// rates are solved in closed form (multiplayer/src/rate-model.js). The one place the
// naive expectation would be wrong (Math.round wrapped around a uniform XP roll) is
// summed over the roll's real support instead.
//
// Static config only: no database, no wallet, no per-player state, no secrets, which
// is why it caches hard at the edge and needs no session.

import { cors, json, method, wrap, rateLimited } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { solveAt, allCurves } from '../../multiplayer/src/rate-model.js';
import { LEVEL_CAP } from '../../multiplayer/src/economy.js';

// The per-level curves are the same for every request (they are a pure function of
// static tables), so they are built once per process rather than per request. At
// roughly 20 KB serialized this is the difference between a page that redraws its
// whole chart on a slider drag and one that has to round-trip for every level.
let curvesCache = null;
function curves() {
	if (!curvesCache) curvesCache = allCurves();
	return curvesCache;
}

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS', origins: '*' })) return;
	if (!method(req, res, ['GET'])) return;

	const rl = await limits.publicIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const url = new URL(req.url, 'http://localhost');
	const raw = url.searchParams.get('level');

	// An out-of-range or non-numeric level is clamped rather than rejected: this is a
	// public reference, and a 400 for `?level=200` would be a worse answer than the
	// level-99 table plus a note saying that is what happened.
	const parsed = Number.parseInt(raw ?? '1', 10);
	const level = Number.isFinite(parsed) ? Math.max(1, Math.min(LEVEL_CAP, parsed)) : 1;
	const clamped = raw !== null && String(level) !== String(raw).trim();

	const model = solveAt(level);

	// `curves=0` drops the 99-level sweep for callers that only want one level. The
	// default includes it, because the page that motivated this endpoint needs the
	// whole sweep up front to make its level control instant.
	const withCurves = url.searchParams.get('curves') !== '0';

	const body = {
		...model,
		requestedLevel: raw === null ? null : String(raw),
		levelClamped: clamped,
		method: {
			summary:
				'Closed-form expectation over the authoritative game tables. No simulation, no sampling, no measurement.',
			source: [
				'multiplayer/src/items.js: yield, double, coal-bonus, burn and catch curves',
				'multiplayer/src/activities.js: the per-swing cadence every rate divides by',
				'multiplayer/src/shop.js: the sell prices every item is valued at',
				'multiplayer/src/world-features.js: per-node difficulty, coal weight and water quality',
				'multiplayer/src/spin-wheel.js: the wedge table the wheel expectation sums',
				'multiplayer/src/economy.js: the XP curve and the pack size',
			],
			exactness:
				'XP awards wrap Math.round around a uniform integer roll, and rounding is not linear, so those expectations sum over the roll’s real support rather than substituting its mean.',
		},
		...(withCurves ? { curves: curves() } : {}),
	};

	// Pure config: it only changes when the game's own tables change, which ships as a
	// deploy, so it caches as hard as /api/play/economy does. `level` and `curves` are
	// part of the cache key by virtue of being query parameters.
	return json(res, 200, body, {
		'cache-control': 'public, max-age=300, s-maxage=3600, stale-while-revalidate=86400',
	});
});
