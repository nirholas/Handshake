import { sql } from '../_lib/db.js';
import { getSessionUser } from '../_lib/auth.js';
import { json, error, wrap } from '../_lib/http.js';

const BIRDEYE_API_KEY = process.env.BIRDEYE_API_KEY;

// Process-local Birdeye response cache. Keeps the function instance from
// hammering Birdeye when many tabs poll the same mint within a few seconds.
// Vercel functions warm-start across requests, so this is meaningful even
// without Redis. Cross-instance dedup would still need an external cache.
const _birdeyeCache = new Map();

async function fetchWithCache(url, options, ttlMs = 60_000) {
	const key = url;
	const now = Date.now();
	const hit = _birdeyeCache.get(key);
	if (hit && hit.expires > now) return hit.value;

	const resp = await fetch(url, options);
	if (!resp.ok) {
		const text = await resp.text();
		throw new Error(`API error (${resp.status}): ${text.slice(0, 200)}`);
	}
	const value = await resp.json();
	// Only cache successful non-null responses so an empty/error body from
	// Birdeye doesn't poison the cache for 60s.
	if (value?.data != null) {
		_birdeyeCache.set(key, { value, expires: now + ttlMs });
		if (_birdeyeCache.size > 256) {
			const oldest = _birdeyeCache.keys().next().value;
			_birdeyeCache.delete(oldest);
		}
	}
	return value;
}

export default wrap(async (req, res) => {
	const user = await getSessionUser(req);
	if (!user) return error(res, 401, 'unauthorized');

	const agentId = new URL(req.url, 'http://x').searchParams.get('agent_id');
	if (!agentId) return error(res, 400, 'missing agent_id');

	const [agent] = await sql`
		SELECT meta FROM agent_identities
		WHERE id = ${agentId} AND user_id = ${user.id} AND deleted_at IS NULL
	`;

	if (!agent) return error(res, 404, 'agent not found');

	const tokenMint = agent.meta?.token?.mint;
	if (!tokenMint) return error(res, 404, 'token not launched for this agent');

	const headers = { 'X-API-KEY': BIRDEYE_API_KEY };

	try {
		const [price, history] = await Promise.all([
			fetchWithCache(`https://public-api.birdeye.so/defi/price?address=${tokenMint}`, { headers }),
			fetchWithCache(`https://public-api.birdeye.so/defi/txs/latest?address=${tokenMint}`, { headers })
		]);

		return json(res, 200, {
			price: price.data,
			history: history.data.items,
		});

	} catch (e) {
		console.error(`[pump-dashboard] Error fetching token data for ${tokenMint}:`, e);
		return error(res, 502, 'bad_gateway', 'Failed to fetch on-chain data');
	}
});
