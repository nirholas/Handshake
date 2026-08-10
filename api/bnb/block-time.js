// GET /api/bnb/block-time
// ---------------------------------------------------------------------------
// Live BNB Smart Chain block-time proof for the /bnb hub page. Wraps
// `probeBlockTime` from api/_lib/bnb/chains.js (prompt 01) — samples two real
// blocks off a public RPC (with failover) and returns the observed average
// interval. No mock, no hardcoded "0.45s" — the number is measured on every
// cache miss. `target` is the marketing reference (450ms on mainnet, Fermi
// hardfork BEP-619/590) so the client can show "measured vs target" honestly;
// it is null on testnet, which has no published target.
//
// Defaults to bscMainnet because that's the network the 0.45s claim is about
// (00-CONTEXT.md verified fact #3) — pass ?network=bscTestnet to probe the
// write network instead.

import { cors, json, method, wrap, error, rateLimited } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { probeBlockTime, BnbRpcError } from '../_lib/bnb/chains.js';

const TTL_MS = 10_000;
const _cache = new Map(); // network -> { value, expiresAt }

// Same alias set api/bnb/babt-check.js and api/bnb/world-config.js accept, and
// the same refusal to guess: an unrecognized `network` is a caller bug, so say
// so instead of silently answering about a different chain than the one asked
// about. Returns null for "unknown"; the empty value means "use the default".
function normalizeNetworkParam(raw) {
	const v = String(raw ?? '').trim().toLowerCase();
	if (v === 'testnet' || v === '97' || v === 'bsctestnet') return 'bscTestnet';
	if (v === '' || v === 'mainnet' || v === '56' || v === 'bscmainnet') return 'bscMainnet';
	return null;
}

async function build(network) {
	const now = Date.now();
	const hit = _cache.get(network);
	if (hit && hit.expiresAt > now) return hit.value;

	const value = await probeBlockTime(network, 200);
	_cache.set(network, { value, expiresAt: now + TTL_MS });
	return value;
}

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS', origins: '*' })) return;
	if (!method(req, res, ['GET'])) return;

	const rl = await limits.publicIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const p = new URL(req.url, `http://${req.headers.host || 'x'}`).searchParams;
	const requested = p.get('network');
	const network = normalizeNetworkParam(requested);
	if (network === null) {
		return error(res, 400, 'bad_request', `unknown network "${String(requested).slice(0, 64)}", use "mainnet" or "testnet"`);
	}

	try {
		const payload = await build(network);
		return json(res, 200, payload, {
			'cache-control': 'public, max-age=5, s-maxage=10, stale-while-revalidate=30',
		});
	} catch (err) {
		const tried = err instanceof BnbRpcError ? err.tried : undefined;
		return error(
			res,
			502,
			'upstream_error',
			'BNB Chain RPC is unavailable right now — retry shortly',
			tried ? { tried } : {},
		);
	}
});
