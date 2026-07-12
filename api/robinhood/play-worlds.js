// GET /api/robinhood/play-worlds?limit=40
// ----------------------------------------
// Robinhood Chain coin-world list for the /worlds lobby's "Robinhood Chain" tab
// — the chain analogue of GET /api/community/worlds. Each entry uses the same
// card contract worlds-lobby.js already renders: { token, symbol, image,
// members, posts }. `token` is the coin's EVM contract address (the world seed
// — see src/game/world-env.js seedFromString), so a card click drops straight
// into /temporary?coin=<address> unmodified.
//
// Sourced from the robinhood-feed firehose worker's real launch backlog (NOXA +
// The Odyssey). `members`/`posts` are the CoinCommunities social-layer counters,
// which start at 0 for a brand-new chain — never fabricated to look populated.
// If the firehose worker isn't running, this returns an empty, clearly-flagged
// list (the lobby's existing designed-empty state), not fake cards.

import { cors, json, method, wrap, rateLimited } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';

const FEED_URL = process.env.ROBINHOOD_FEED_URL || 'http://localhost:8788';
const UPSTREAM_TIMEOUT_MS = 3000;

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS', origins: '*' })) return;
	if (!method(req, res, ['GET'])) return;

	const rl = await limits.marketFeedIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const params = new URL(req.url, 'http://x').searchParams;
	const rawLimit = Number(params.get('limit') || '40');
	const limit = Math.min(100, Math.max(1, Number.isFinite(rawLimit) ? Math.floor(rawLimit) : 40));

	let upstream;
	try {
		upstream = await fetch(
			`${FEED_URL}/recent?kind=launch&limit=${limit}`,
			{ headers: { accept: 'application/json' }, signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) },
		);
	} catch {
		return json(res, 200, { data: { worlds: [] }, configured: false }, { 'cache-control': 'no-store' });
	}
	if (!upstream.ok) {
		return json(res, 200, { data: { worlds: [] }, configured: false }, { 'cache-control': 'no-store' });
	}
	const body = await upstream.json().catch(() => null);
	const events = Array.isArray(body?.events) ? body.events : [];
	const worlds = events
		.filter((ev) => ev.kind === 'launch')
		.map((ev) => ({
			token: ev.data.mint,
			symbol: ev.data.symbol || null,
			image: null, // no off-chain metadata service on Robinhood Chain yet
			members: 0,
			posts: 0,
			chain: 'robinhood-chain',
			launchpad: ev.data.launchpad,
			explorer_url: ev.data.explorer_url,
		}));

	return json(res, 200, { data: { worlds }, configured: true }, { 'cache-control': 'public, max-age=15, s-maxage=30' });
});
