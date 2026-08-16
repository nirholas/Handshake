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
const EVM_ADDR_RE = /^0x[a-fA-F0-9]{40}$/;

// The firehose is a network boundary. An event that lost its `data` payload
// used to throw a TypeError out of this map and 500 the endpoint, and the
// lobby swallows a non-ok response (src/worlds-lobby.js), so the whole tab
// vanished with no error anywhere the user could see. A launch with no usable
// contract address is dropped for the same reason: its card would seed a world
// from `undefined` and land the visitor nowhere.
function launchAddress(ev) {
	if (!ev || ev.kind !== 'launch' || !ev.data || typeof ev.data !== 'object') return null;
	const mint = typeof ev.data.mint === 'string' ? ev.data.mint.trim() : '';
	return EVM_ADDR_RE.test(mint) ? mint : null;
}

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
		.map((ev) => ({ ev, token: launchAddress(ev) }))
		.filter((row) => row.token !== null)
		.slice(0, limit)
		.map(({ ev, token }) => ({
			token,
			symbol: ev.data.symbol || null,
			image: null, // no off-chain metadata service on Robinhood Chain yet
			members: 0,
			posts: 0,
			chain: 'robinhood-chain',
			launchpad: ev.data.launchpad ?? null,
			explorer_url: ev.data.explorer_url ?? null,
		}));

	return json(res, 200, { data: { worlds }, configured: true }, { 'cache-control': 'public, max-age=15, s-maxage=30' });
});
