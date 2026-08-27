// GET /api/crypto/holders: free holder distribution / concentration for a
// Solana token.
//
// Agent use-case: an agent sizing a position needs holder distribution before
// it commits: how many holders exist, what share the top wallets control, and
// whether the dev/insiders still dominate. High concentration = exit risk. One
// keyless call answers it with real on-chain data.
//
// Part of the free Crypto Data API (/api/crypto/*). Plain-handler pattern: no
// account, no key, generous per-IP limit. Two real paths (never a mock): a
// Helius owner-aggregated walk when the deployment has a key (exact holder
// count within its cap), else the keyless RPC truth, the chain's 20 largest
// token accounts with owners resolved, marked as such in `sources`/`note`.
//
// Query:
//   address = <Solana mint>   (required)
//   chain   = solana          (optional; only 'solana'/'sol' accepted)
//   limit   = 1..50           (default 10), how many top holders to return
//
// Response: { address, chain, holderCount, top: [{ owner, amount, pct }],
//   top10Pct, concentration: low|medium|high|unknown, ts, sources[], note? }
// `concentration` is a documented threshold on top10Pct (>80 high, >50 medium).

import { cors, method, wrap, error, json, rateLimited } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { isValidSolanaAddress, isValidEvmAddress } from '../_lib/validate.js';
import { composeTokenHolders, DEFAULT_LIMIT, MAX_LIMIT } from '../_lib/crypto-token-holders.js';
import { cacheGet, cacheSet } from '../_lib/cache.js';
import { staleEnvelope } from '../_lib/rpc-degrade.js';

// Last-good tier: the previous successful report for this mint+limit, served
// marked stale during an RPC/indexer outage. Concentration moves slowly, so a
// day-old distribution is still a real position-sizing answer; a 503 is not.
const HOLDERS_LKG_TTL_S = 24 * 3600;
const holdersLkgKey = (address, limit) => `crypto:holders:lkg:${address}:${limit}`;

const EXAMPLE = '/api/crypto/holders?address=FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump';

export default wrap(async (req, res) => {
	if (cors(req, res, { origins: '*', methods: 'GET,OPTIONS' })) return;
	if (!method(req, res, ['GET'])) return;

	const ip = clientIp(req);
	const [ipRl, globalRl] = await Promise.all([limits.cryptoDataIp(ip), limits.cryptoDataGlobal()]);
	if (!ipRl.success) return rateLimited(res, ipRl);
	if (!globalRl.success) return rateLimited(res, globalRl);

	const url = new URL(req.url, 'http://localhost');
	const address = (url.searchParams.get('address') || '').trim();
	const rawChain = (url.searchParams.get('chain') || '').trim().toLowerCase();
	const rawLimit = Number(url.searchParams.get('limit'));
	const limit = Math.min(MAX_LIMIT, Math.max(1, Number.isFinite(rawLimit) ? Math.floor(rawLimit) : DEFAULT_LIMIT));

	if (!address) {
		return error(res, 400, 'missing_address', 'query param `address` is required. Pass a Solana token mint', {
			example: EXAMPLE,
		});
	}
	// Solana-only, honestly: SPL token accounts have no EVM equivalent here.
	if (isValidEvmAddress(address) || (rawChain && rawChain !== 'solana' && rawChain !== 'sol')) {
		return error(res, 400, 'unsupported_chain', 'this endpoint reads Solana holder distribution only. Pass a base58 Solana mint address', {
			example: EXAMPLE,
		});
	}
	if (!isValidSolanaAddress(address)) {
		return error(res, 400, 'invalid_address', '`address` must be a base58 Solana mint address (32-44 chars)', {
			address,
			example: EXAMPLE,
		});
	}

	const result = await composeTokenHolders({ address, limit });
	const ts = new Date().toISOString();

	if (result.status === 'not_found') {
		return error(res, 400, 'token_not_found', `${address} is not an on-chain token mint. Check the address, or discover live tokens at /api/crypto/trending`, {
			address,
		});
	}
	if (result.status === 'upstream_down') {
		const lkg = await cacheGet(holdersLkgKey(address, limit));
		if (lkg && lkg.body && typeof lkg.at === 'number') {
			return json(res, 200, staleEnvelope(lkg.body, lkg.at), {
				'cache-control': 'public, s-maxage=30, stale-while-revalidate=60',
				'x-holders-stale': '1',
			});
		}
		return json(res, 503, {
			error: 'upstream_unavailable',
			error_description: 'holder data sources are temporarily unreachable, retry shortly',
			address,
			retry_after: 15,
			ts,
		}, { 'cache-control': 'no-store', 'retry-after': '15' });
	}

	const body = {
		address,
		chain: 'solana',
		holderCount: result.holderCount,
		top: result.top,
		top10Pct: result.top10Pct,
		concentration: result.concentration,
		ts,
		sources: result.sources,
	};
	if (result.note) body.note = result.note;
	cacheSet(holdersLkgKey(address, limit), { body, at: Date.now() }, HOLDERS_LKG_TTL_S).catch(() => {});

	// Distribution shifts trade by trade but a position-sizing read tolerates a
	// minute of cache; this absorbs polling bursts without hammering the RPC.
	return json(res, 200, body, {
		'cache-control': 'public, s-maxage=60, stale-while-revalidate=60',
	});
});
