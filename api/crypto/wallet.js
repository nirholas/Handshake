// GET /api/crypto/wallet: free, keyless wallet portfolio for AI agents.
//
// Agent use-case: an autonomous agent needs to inspect a wallet (its own or a
// counterparty's) before it transacts. A treasury agent checks its runway, a
// copy-trade agent mirrors a leader's holdings, a pre-trade check inspects who
// it's about to deal with. One call returns native balance, every SPL token,
// and a rough USD valuation, so the agent doesn't have to juggle an RPC + a
// price API + a metadata source itself.
//
// Free-endpoint pattern (x402-overhaul campaign convention): plain handler,
// `cors`/`wrap`/`error` from _lib/http.js, rate-limited by IP via _lib/rate-limit.js.
// No key, no account. The Solana path returns REAL balances even without a Helius
// key: it falls back to the public RPC `getTokenAccountsByOwner` walk and prices
// via Jupiter Lite + the pump.fun bonding curve (all keyless). Helius DAS is used
// only as a faster path when HELIUS_API_KEY is present.

import { cors, method, wrap, error } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { getBalances, walletUsdTotal, heliusHealth } from '../_lib/balances.js';
import { isValidAddressForChain } from '../_lib/splits.js';

// Cap the token list so a wallet holding thousands of dust airdrops can't return
// a multi-megabyte payload. Tokens are sorted by USD value desc before the cap,
// so the most meaningful holdings always survive; `truncated` flags the rest.
const MAX_TOKENS = 200;

// Chain aliases → the internal chain key `getBalances` understands. Solana is the
// keyless flagship; the EVM path resolves Ethereum mainnet and needs ALCHEMY_API_KEY
// (degrades to 503 not_configured when absent, never a fake). Aliases keep the API
// forgiving without pretending to support a chain the balance layer can't read.
const CHAIN_ALIASES = {
	solana: 'solana',
	sol: 'solana',
	ethereum: 'evm',
	eth: 'evm',
	evm: 'evm',
	mainnet: 'evm',
};

// Round a USD figure to cents-ish precision without importing a bignum lib. These
// are display valuations, not settlement amounts. Keeps 6 significant sub-dollar
// digits so sub-cent token values ($0.0000123) don't collapse to 0.
function roundUsd(n) {
	if (!(Number(n) > 0)) return 0;
	return Number(n) < 1 ? Number(n.toPrecision(6)) : Math.round(n * 100) / 100;
}

// Map the rich internal balance shape to the stable public contract. Unpriced
// tokens (price 0, meaning Jupiter/pump.fun couldn't route them) keep their amount but
// report `usd: null`, never a fake 0 valuation and never dropped from the list.
function shapeToken(t) {
	const priced = Number(t.price) > 0;
	return {
		mint: t.mint,
		symbol: t.symbol || null,
		name: t.name || null,
		amount: t.amount,
		usd: priced ? roundUsd(t.usd) : null,
		logo: t.logo || null,
	};
}

// Which real upstreams a response drew on, reported honestly so an agent can
// reason about freshness. Solana balances come from Helius DAS when a key is
// configured and its quota breaker is closed, else the public RPC; USD comes
// from Jupiter Lite (with a pump.fun bonding-curve fallback baked into the
// balance layer). EVM balances/prices come from Alchemy + CoinGecko.
function sourcesFor(chain) {
	if (chain === 'solana') {
		const h = heliusHealth();
		const balanceSource = h.configured && h.available ? 'helius-das' : 'solana-rpc';
		return [balanceSource, 'jupiter-lite'];
	}
	return ['alchemy', 'coingecko'];
}

export default wrap(async function handler(req, res) {
	if (cors(req, res, { origins: '*', methods: 'GET,OPTIONS' })) return;
	if (!method(req, res, ['GET'])) return;

	const ip = clientIp(req);
	const [ipRl, globalRl] = await Promise.all([limits.cryptoDataIp(ip), limits.cryptoDataGlobal()]);
	if (!ipRl.success || !globalRl.success) {
		return error(res, 429, 'rate_limited', 'too many requests, slow down and retry shortly', {
			retryAfter: 60,
		});
	}

	const url = new URL(req.url, 'http://x');
	const address = (url.searchParams.get('address') || '').trim();
	const rawChain = (url.searchParams.get('chain') || 'solana').trim().toLowerCase();

	if (!address) {
		return error(res, 400, 'missing_address', 'pass ?address=<wallet> (a Solana or EVM address)', {
			example: '/api/crypto/wallet?address=FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump&chain=solana',
		});
	}

	const chain = CHAIN_ALIASES[rawChain];
	if (!chain) {
		return error(res, 400, 'unsupported_chain', `chain "${rawChain}" is not supported`, {
			supported: ['solana', 'ethereum'],
		});
	}

	// Validate the address for its family BEFORE any upstream call, so a typo is a
	// fast 400 rather than a wasted RPC round-trip that 404s deep in the balance layer.
	const validationChain = chain === 'solana' ? 'solana' : 'evm';
	if (!isValidAddressForChain(address, validationChain)) {
		return error(res, 400, 'invalid_address', `not a valid ${validationChain === 'solana' ? 'Solana' : 'EVM'} address`, {
			example: '/api/crypto/wallet?address=FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump&chain=solana',
		});
	}

	let balances;
	try {
		balances = await getBalances({ chain, address });
	} catch (err) {
		// EVM without an Alchemy key: honest 503 naming the gap, never a mock.
		if (err?.code === 'not_configured') {
			return error(res, 503, 'not_configured', 'this chain requires a provider key that is not set on this deployment; Solana works keyless', {
				chain: rawChain,
			});
		}
		// Every live RPC path failed and there was no cached snapshot to fall back on.
		// Surface a retryable 503 with Retry-After, never a 500 on a well-formed request.
		res.setHeader('retry-after', '15');
		return error(res, 503, 'upstream_unavailable', 'wallet data source is temporarily unavailable, retry shortly', {
			retryAfter: 15,
		});
	}

	const allTokens = Array.isArray(balances.tokens) ? balances.tokens : [];
	const truncated = allTokens.length > MAX_TOKENS;
	const tokens = allTokens.slice(0, MAX_TOKENS).map(shapeToken);

	const nativePriced = Number(balances.native?.price) > 0;
	const body = {
		address,
		chain: chain === 'solana' ? 'solana' : 'ethereum',
		native: {
			symbol: balances.native?.symbol || (chain === 'solana' ? 'SOL' : 'ETH'),
			amount: balances.native?.amount ?? 0,
			usd: nativePriced ? roundUsd(balances.native?.usd) : (balances.native?.amount ? null : 0),
		},
		tokens,
		totalUsd: roundUsd(walletUsdTotal(balances)),
		tokenCount: allTokens.length,
		truncated,
		ts: new Date().toISOString(),
		sources: sourcesFor(chain),
	};
	// A stale flag from the balance layer means every live path failed and we served
	// the wallet's last-known-good snapshot. Pass that honesty through to the caller.
	if (balances.stale) body.stale = true;

	// Public read, safe to CDN-cache briefly: balances move, but a 30s edge cache
	// collapses a burst of agents polling the same wallet without serving stale data.
	res.setHeader('cache-control', 'public, s-maxage=30, stale-while-revalidate=60');
	res.statusCode = 200;
	res.setHeader('content-type', 'application/json; charset=utf-8');
	res.end(JSON.stringify(body));
});
