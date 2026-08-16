// GET /api/robinhood/coin-trades?mint=<address>&limit=100
// --------------------------------------------------------
// The Robinhood Chain analogue of /api/pump/coin-trades — the in-world 3D
// trading terminal (src/game/chart-screen.js) polls this every 5s to animate
// the market reactor (buy/sell ripples, whale spectacle). Same response
// contract as the pump.fun endpoint so the SAME chart-screen.js code drives
// both chains unmodified:
//   { trades: [{ tx, timestamp, price_usd, is_buy, sol_amount, usd_amount, user }] }
// (`sol_amount` here carries the trade's native-ETH magnitude — see the
// robinhood-feed worker README for the full field-naming divergence.)
//
// Backed by the robinhood-feed firehose worker's /recent snapshot (real
// NOXA + Odyssey + Uniswap v3 events, no mocks). If the worker isn't running
// (ROBINHOOD_FEED_URL unset or unreachable), this responds with an EMPTY,
// clearly-flagged payload rather than fabricating trades — the in-world HUD
// renders its designed empty state instead of a fake feed.

import { cors, error, json, method, wrap, rateLimited } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';

const FEED_URL = process.env.ROBINHOOD_FEED_URL || 'http://localhost:8788';
const EVM_ADDR_RE = /^0x[a-fA-F0-9]{40}$/;
const UPSTREAM_TIMEOUT_MS = 3000;

// The firehose is a network boundary, so nothing it returns is trusted. One
// event that lost its `data` payload used to throw a TypeError out of the
// filter and 500 the whole poll, which the in-world terminal reads as a dead
// feed every 5 seconds; a timestamp the upstream wrote as a string threw a
// RangeError out of `toISOString()` the same way. Both are coerced now: a
// malformed event is dropped or nulled, the rest of the tape still renders.
function isTradeEvent(ev) {
	return !!ev && ev.kind === 'trade' && !!ev.data && typeof ev.data === 'object';
}

function isoTimestamp(seconds) {
	const n = Number(seconds);
	if (!Number.isFinite(n) || n <= 0) return null;
	const at = new Date(n * 1000);
	return Number.isNaN(at.getTime()) ? null : at.toISOString();
}

// `Number(null) === 0`, so a missing price would otherwise render as a real $0
// print on the chart. Only a genuinely finite value survives.
function finiteOr(value, fallback) {
	if (value === null || value === undefined || value === '') return fallback;
	const n = Number(value);
	return Number.isFinite(n) ? n : fallback;
}

function toChartTrade(ev) {
	const d = ev.data;
	return {
		tx: d.tx || d.tx_signature || d.signature || '',
		timestamp: isoTimestamp(d.timestamp),
		price_usd: finiteOr(d.price_usd, null),
		is_buy: d.is_buy === true,
		sol_amount: finiteOr(d.sol_amount ?? d.amount, 0),
		usd_amount: finiteOr(d.usd_amount ?? d.value_usd, null),
		user: d.user || d.trader || '',
	};
}

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS', origins: '*' })) return;
	if (!method(req, res, ['GET'])) return;

	// Same dedicated lobby/world-feed bucket as the pump.fun coin-trades path —
	// this is the identical "polled every 5s from inside a live world" shape the
	// 429-starvation lesson (play-lobby-429-starvation) already carved a bucket
	// out for. Reusing it, not the shared publicIp pool.
	const rl = await limits.marketFeedIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const params = new URL(req.url, 'http://x').searchParams;
	const mint = (params.get('mint') || '').trim();
	const rawLimit = Number(params.get('limit') || '100');
	const limit = Math.min(200, Math.max(1, Number.isFinite(rawLimit) ? Math.floor(rawLimit) : 100));

	// A caller-supplied address that is not an EVM address is a client bug, not
	// a quiet market: say so with a 4xx the way the pump.fun coin-trades path
	// does, rather than an empty 200 that reads as "this coin has no trades".
	// The in-world terminal only routes here for addresses that already match
	// this shape (src/game/chart-screen.js), so no live caller sees it.
	if (!EVM_ADDR_RE.test(mint)) {
		return error(res, 400, 'invalid_mint', 'mint must be a 0x-prefixed EVM contract address');
	}

	let upstream;
	try {
		upstream = await fetch(
			`${FEED_URL}/recent?kind=trade&limit=200`,
			{ headers: { accept: 'application/json' }, signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) },
		);
	} catch {
		// Worker not running locally / not deployed yet — designed empty state,
		// not a fabricated trade list.
		return json(res, 200, { trades: [], configured: false }, { 'cache-control': 'no-store' });
	}
	if (!upstream.ok) {
		return json(res, 200, { trades: [], configured: false }, { 'cache-control': 'no-store' });
	}
	const body = await upstream.json().catch(() => null);
	const events = Array.isArray(body?.events) ? body.events : [];
	const mintLower = mint.toLowerCase();
	const trades = events
		.filter((ev) => isTradeEvent(ev) && String(ev.data.mint || '').toLowerCase() === mintLower)
		.slice(0, limit)
		.map(toChartTrade);

	return json(res, 200, { trades, configured: true }, { 'cache-control': 'no-store' });
});
