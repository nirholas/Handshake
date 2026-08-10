// GET /api/bnb/latency
// ---------------------------------------------------------------------------
// Live multi-chain block-time race for the /bnb-latency page. Probes BNB
// Chain, Base, Ethereum, and Solana in parallel on every cache miss — see
// api/_lib/bnb/latency-lanes.js for the measurement technique (BNB reuses
// `probeBlockTime` from api/_lib/bnb/chains.js; the others sample two real
// blocks/slots off public RPCs the same way). No mock, no hardcoded numbers:
// every `avgBlockTimeMs` in the response was measured fresh.
//
// A single dead chain never fails the whole request — its lane comes back
// `{ ok:false }` so the client can show "reconnecting" for that lane while
// the others keep racing (00-CONTEXT honesty doctrine: never fabricate a
// number for an unreachable chain).

import { cors, json, method, wrap, rateLimited } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { probeAllLanes } from '../_lib/bnb/latency-lanes.js';

const TTL_MS = 4000;
let _cache = null; // { value, expiresAt }

async function build() {
	const now = Date.now();
	if (_cache && _cache.expiresAt > now) return _cache.value;
	const lanes = await probeAllLanes();
	const value = { lanes, measuredAt: new Date().toISOString() };
	_cache = { value, expiresAt: now + TTL_MS };
	return value;
}

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS', origins: '*' })) return;
	if (!method(req, res, ['GET'])) return;

	// The /bnb-latency page polls this on a timer, so a 429 has to carry
	// retry-after (and the limiter's `reason`, which distinguishes a real quota
	// hit from a degraded limiter failing closed). rateLimited() sets both; the
	// hand-rolled 429 this replaces set neither, leaving the poller to guess.
	const rl = await limits.publicIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const payload = await build();
	return json(res, 200, payload, {
		'cache-control': 'public, max-age=2, s-maxage=4, stale-while-revalidate=15',
	});
});
