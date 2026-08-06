// Shared Jupiter (lite-api) swap client for the $THREE token lanes.
//
// The programmatic buyback (buyback.js) and the x402 micro-buy loop (microbuy.js)
// both market-buy $THREE on Jupiter. This module is the ONE place that talks to
// the Jupiter quote + swap API so the two lanes can never drift on endpoint, error
// handling, or transaction-build options. It builds nothing on-chain and holds no
// keys — callers own signing, broadcasting, and confirmation.
//
// BUY-ONLY by construction: nothing here sells $THREE. Every helper is a generic
// (inputMint → outputMint) swap primitive; the $THREE lanes only ever call it with
// outputMint = $THREE, and there is no sell path anywhere in the token/ tree.
//
// Beyond the swap lane, this module also wraps the rest of Jupiter's keyless
// lite tier (read-only token intelligence, verified live 2026-08-06):
// - /tokens/v2/search: rich per-mint info (price, mcap, liquidity, holderCount,
//   audit flags, launchpad). Jupiter serves no dedicated holders endpoint
//   (/ultra/v1/holders 404s); holderCount here is the keyless holder signal.
// - /tokens/v2/{toptrending|toptraded|toporganicscore}/{interval}: ranked
//   discovery lists.
// - /tokens/v2/recent: latest mints seen by Jupiter (fixed 30-row page;
//   upstream ignores a limit param, so trimming happens client-side).
// - /ultra/v1/shield: per-mint safety warnings.

const JUP_QUOTE_URL = 'https://lite-api.jup.ag/swap/v1/quote';
const JUP_SWAP_URL = 'https://lite-api.jup.ag/swap/v1/swap';
const JUP_TOKENS_URL = 'https://lite-api.jup.ag/tokens/v2';
const JUP_SHIELD_URL = 'https://lite-api.jup.ag/ultra/v1/shield';

// The category lists /tokens/v2 actually serves. A wrong category is not a
// 404 upstream (it 200s with junk), so it is validated here instead.
export const JUP_TOKEN_CATEGORIES = ['toporganicscore', 'toptraded', 'toptrending'];
export const JUP_TOKEN_INTERVALS = ['5m', '1h', '6h', '24h'];

/**
 * GET a Jupiter route + throw a coded error on a non-2xx / unparseable response,
 * so a caller records the precise reason instead of an opaque failure.
 */
export async function fetchJson(url, opts) {
	const r = await fetch(url, opts);
	const body = await r.json().catch(() => ({}));
	if (!r.ok) {
		throw Object.assign(new Error(`jupiter ${r.status}: ${JSON.stringify(body).slice(0, 200)}`), {
			code: 'jupiter_error',
			status: r.status,
		});
	}
	return body;
}

/**
 * ExactIn quote: how much `outputMint` a given `amount` of `inputMint` buys.
 * @param {{ inputMint: string, outputMint: string, amount: bigint|number|string, slippageBps: number }} args
 * @returns {Promise<object>} the raw Jupiter quoteResponse
 */
export async function jupiterQuote({ inputMint, outputMint, amount, slippageBps }) {
	const u = new URL(JUP_QUOTE_URL);
	u.searchParams.set('inputMint', inputMint);
	u.searchParams.set('outputMint', outputMint);
	u.searchParams.set('amount', String(amount));
	u.searchParams.set('slippageBps', String(slippageBps));
	u.searchParams.set('swapMode', 'ExactIn');
	return fetchJson(u.toString(), { headers: { accept: 'application/json' } });
}

/**
 * Build the (unsigned) swap transaction (base64) for a quote. The caller
 * deserializes, signs, broadcasts, and confirms it.
 * @param {{ quote: object, userPublicKey: string, wrapAndUnwrapSol?: boolean, maxPriorityLamports?: number, priorityLevel?: string }} args
 * @returns {Promise<string>} base64 VersionedTransaction bytes
 */
export async function jupiterSwapTx({
	quote,
	userPublicKey,
	wrapAndUnwrapSol = false,
	maxPriorityLamports = 1_000_000,
	priorityLevel = 'medium',
}) {
	const data = await fetchJson(JUP_SWAP_URL, {
		method: 'POST',
		headers: { 'content-type': 'application/json', accept: 'application/json' },
		body: JSON.stringify({
			quoteResponse: quote,
			userPublicKey,
			// USDC→$THREE never touches wrapped SOL; let Jupiter manage the $THREE ATA.
			wrapAndUnwrapSol,
			dynamicComputeUnitLimit: true,
			prioritizationFeeLamports: {
				priorityLevelWithMaxLamports: { maxLamports: maxPriorityLamports, priorityLevel },
			},
		}),
	});
	if (!data.swapTransaction) {
		throw Object.assign(new Error('jupiter returned no swapTransaction'), { code: 'no_swap_tx' });
	}
	return data.swapTransaction;
}

/**
 * Search tokens by symbol, name, or mint address. A mint query returns that
 * token's full record: usdPrice, mcap, liquidity, holderCount, launchpad,
 * audit flags, and per-window stats.
 * @param {string} query               symbol, name, or mint address
 * @param {{ limit?: number }} [opts]  upstream caps at 100
 * @returns {Promise<Array<object>>} raw Jupiter token records
 */
export async function jupiterTokenSearch(query, { limit } = {}) {
	if (!query) {
		throw Object.assign(new Error('jupiterTokenSearch requires a query'), { code: 'bad_query' });
	}
	const u = new URL(`${JUP_TOKENS_URL}/search`);
	u.searchParams.set('query', String(query));
	if (limit) u.searchParams.set('limit', String(limit));
	const data = await fetchJson(u.toString(), { headers: { accept: 'application/json' } });
	return Array.isArray(data) ? data : [];
}

/**
 * Ranked token discovery list: top trending, top traded, or top organic-score
 * tokens over an interval.
 * @param {string} category            one of JUP_TOKEN_CATEGORIES
 * @param {string} [interval]          one of JUP_TOKEN_INTERVALS (default '24h')
 * @param {{ limit?: number }} [opts]  upstream caps at 100
 * @returns {Promise<Array<object>>} raw Jupiter token records
 */
export async function jupiterTokenList(category, interval = '24h', { limit } = {}) {
	if (!JUP_TOKEN_CATEGORIES.includes(category)) {
		throw Object.assign(
			new Error(`jupiterTokenList category must be one of ${JUP_TOKEN_CATEGORIES.join(', ')}`),
			{ code: 'bad_category' },
		);
	}
	if (!JUP_TOKEN_INTERVALS.includes(interval)) {
		throw Object.assign(
			new Error(`jupiterTokenList interval must be one of ${JUP_TOKEN_INTERVALS.join(', ')}`),
			{ code: 'bad_interval' },
		);
	}
	const u = new URL(`${JUP_TOKENS_URL}/${category}/${interval}`);
	if (limit) u.searchParams.set('limit', String(limit));
	const data = await fetchJson(u.toString(), { headers: { accept: 'application/json' } });
	return Array.isArray(data) ? data : [];
}

/**
 * The most recent mints Jupiter has seen. Upstream ignores a limit param and
 * always returns its fixed page, so the cap is applied client-side.
 * @param {{ limit?: number }} [opts]
 * @returns {Promise<Array<object>>} raw Jupiter token records, newest first
 */
export async function jupiterRecentTokens({ limit } = {}) {
	const data = await fetchJson(`${JUP_TOKENS_URL}/recent`, {
		headers: { accept: 'application/json' },
	});
	const rows = Array.isArray(data) ? data : [];
	return limit > 0 ? rows.slice(0, limit) : rows;
}

// Shield answers at most 30 mints per request and silently drops the rest
// (verified live 2026-08-06: 60 unique mints in, warnings for exactly the
// first 30 out), so jupiterShield chunks larger lists itself.
const JUP_SHIELD_BATCH = 30;

/**
 * Jupiter Shield safety warnings per mint (freeze/mint authority, unverified
 * status, rug signals, ...). An empty array for a mint means Shield has
 * nothing to flag. Mints are deduped and fetched in batches of 30 so callers
 * never hit the upstream truncation.
 * @param {Array<string>|string} mints
 * @returns {Promise<Record<string, Array<object>>>} mint -> warnings
 */
export async function jupiterShield(mints) {
	const list = [...new Set((Array.isArray(mints) ? mints : [mints]).filter(Boolean).map(String))];
	if (!list.length) {
		throw Object.assign(new Error('jupiterShield requires at least one mint'), {
			code: 'bad_mints',
		});
	}
	const batches = [];
	for (let i = 0; i < list.length; i += JUP_SHIELD_BATCH) {
		batches.push(list.slice(i, i + JUP_SHIELD_BATCH));
	}
	const results = await Promise.all(
		batches.map((batch) => {
			const u = new URL(JUP_SHIELD_URL);
			u.searchParams.set('mints', batch.join(','));
			return fetchJson(u.toString(), { headers: { accept: 'application/json' } });
		}),
	);
	const warnings = {};
	for (const data of results) {
		if (data && typeof data.warnings === 'object' && data.warnings !== null) {
			Object.assign(warnings, data.warnings);
		}
	}
	return warnings;
}
