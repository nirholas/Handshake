// GET /api/crypto/token: free, keyless token market snapshot for AI agents.
//
// Agent use-case: a trading/research agent holds a contract address and needs the
// token's current market state in ONE call before deciding to buy, alert, or
// ignore. Without this it juggles DexScreener + an RPC + a price API; here one
// free read returns identity, price, 24 h change, market cap, FDV, liquidity,
// volume, and the venue link, with honest nulls for anything unresolvable.
//
// Part of the free Crypto Data API (/api/crypto/*). Plain-handler pattern: no
// account, no key, generous per-IP limit. Real data only, DexScreener for the
// market read (any chain it indexes), pump.fun's public coin record as the
// keyless fallback for fresh Solana launches with no DEX pair yet, Helius DAS
// name/symbol enrichment when a key exists (else those fields stay null).
//
// Query:
//   address = <Solana mint | EVM 0x contract>   (required)
//   chain   = solana | ethereum | base | bsc | …  (optional, inferred from the
//             address shape when omitted; for multi-chain EVM deployments it
//             pins the read to one chain instead of the deepest pool overall)
//
// Response (stable schema, every key always present, unresolved = null):
//   { address, chain, name, symbol, priceUsd, change24h, marketCapUsd,
//     liquidityUsd, volume24hUsd, fdvUsd, pairCreatedAt, dexId, url, ts,
//     sources[], note? }

import { cors, method, wrap, error, json, rateLimited } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { chainOf } from '../_lib/token-market.js';
import { composeTokenSnapshot } from '../_lib/crypto-token-snapshot.js';

const EXAMPLE = '/api/crypto/token?address=FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump';

// Friendly aliases → the DexScreener chainId the pair filter understands.
const CHAIN_ALIASES = { sol: 'solana', eth: 'ethereum', mainnet: 'ethereum' };

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
	const chain = rawChain ? (CHAIN_ALIASES[rawChain] || rawChain) : null;

	if (!address) {
		return error(res, 400, 'missing_address', 'query param `address` is required. Pass a token contract address (Solana mint or EVM 0x)', {
			example: EXAMPLE,
		});
	}

	// Address-family inference BEFORE any upstream call: base58 → Solana,
	// 0x40-hex → EVM, anything else is a fast 400 instead of a wasted round-trip.
	const family = chainOf(address);
	if (!family) {
		return error(res, 400, 'invalid_address', 'not a token contract address. Expected a base58 Solana mint or a 0x EVM contract', {
			address,
			example: EXAMPLE,
		});
	}

	// A chain that contradicts the address shape can never resolve, so say so now.
	if (chain && ((chain === 'solana') !== (family === 'solana'))) {
		return error(res, 400, 'chain_mismatch', `address is a ${family === 'solana' ? 'Solana mint' : '0x EVM contract'} but \`chain=${rawChain}\` is ${family === 'solana' ? 'an EVM chain' : 'solana'}`, {
			address,
			example: EXAMPLE,
		});
	}

	const result = await composeTokenSnapshot({ address, chain });
	const ts = new Date().toISOString();

	// Valid address shape, but no live source knows it on the requested chain:
	// a client-input miss, not a fault (matches the bundle's /bonding convention).
	if (result.status === 'not_found') {
		return error(res, 400, 'token_not_found', `${address} is not a token any live source can resolve${chain ? ` on ${chain}` : ''}. Check the address${chain ? ' and chain' : ''}, or discover live tokens at /api/crypto/trending`, {
			address,
			...(chain ? { chain } : {}),
		});
	}

	// Every consulted source is unreachable: never 500; 503 + Retry-After so the
	// agent backs off and retries, per the free-API contract.
	if (result.status === 'upstream_down') {
		return json(res, 503, {
			error: 'upstream_unavailable',
			error_description: 'token data sources are temporarily unreachable, retry shortly',
			address,
			retry_after: 15,
			ts,
		}, { 'cache-control': 'no-store', 'retry-after': '15' });
	}

	const body = { ...result.snapshot, ts, sources: result.sources };
	if (result.note) body.note = result.note;

	// Market state moves fast but not sub-30s fast; a short CDN cache + SWR
	// collapses bursts of agents polling the same token without serving stale data.
	return json(res, 200, body, {
		'cache-control': 'public, s-maxage=30, stale-while-revalidate=60',
	});
});
