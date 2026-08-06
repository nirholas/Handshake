// Deribit public API (keyless): options + futures market data from the largest
// crypto options venue. Every read here is a GET against
// www.deribit.com/api/v2/public/* with no key and no account, wrapped into the
// summary /api/coin/derivatives attaches next to its perp table: index prices,
// perpetual tickers (mark, funding, open interest, 24h volume), and a per-asset
// options aggregate (contract count, USD open interest, USD volume, put/call
// ratio) that no other source on that endpoint provides.
//
// Verified reachable from US datacenter IPs (unlike Binance/Bybit/OKX, which
// geo-block them; see the note in api/_lib/sol-price.js).
//
// Instrument map, pinned by the fixtures in tests/api/deribit.test.js:
// - BTC and ETH trade as coin-settled (inverse) instruments under their own
//   currency: BTC-PERPETUAL, ETH-PERPETUAL, and BTC-*/ETH-* options.
// - SOL trades USDC-settled (linear): SOL_USDC-PERPETUAL, and SOL_USDC-*
//   options listed under currency=USDC (currency=SOL returns nothing).

const DERIBIT_BASE = 'https://www.deribit.com/api/v2/public';

const num = (v) => {
	const n = Number(v);
	return Number.isFinite(n) ? n : null;
};

// One entry per perp we track: the venue instrument, the index asset it rides,
// and whether it is linear (USDC-settled, open_interest in base units) or
// inverse (coin-settled, open_interest already in USD).
export const DERIBIT_PERPS = [
	{ instrument: 'BTC-PERPETUAL', asset: 'BTC', linear: false },
	{ instrument: 'ETH-PERPETUAL', asset: 'ETH', linear: false },
	{ instrument: 'SOL_USDC-PERPETUAL', asset: 'SOL', linear: true },
];

// Where each asset's options book lives: BTC/ETH under their own currency,
// SOL under the shared USDC (linear) listing.
export const DERIBIT_OPTION_BOOKS = [
	{ currency: 'BTC', asset: 'BTC' },
	{ currency: 'ETH', asset: 'ETH' },
	{ currency: 'USDC', asset: 'SOL' },
];

/**
 * GET a public Deribit JSON-RPC method and unwrap the envelope.
 * Deribit signals bad params with HTTP 200 + an `error` object, so both the
 * HTTP status and the RPC envelope are checked.
 * @param {string} rpcMethod   e.g. 'ticker'
 * @param {Record<string, string|number>} [params]
 * @param {{ timeoutMs?: number }} [opts]
 * @returns {Promise<any>} the envelope's `result`
 */
export async function deribitGet(rpcMethod, params = {}, { timeoutMs = 8000 } = {}) {
	const u = new URL(`${DERIBIT_BASE}/${rpcMethod}`);
	for (const [k, v] of Object.entries(params)) u.searchParams.set(k, String(v));
	const res = await fetch(u, {
		headers: { accept: 'application/json' },
		signal: AbortSignal.timeout(timeoutMs),
	});
	if (!res.ok) {
		const err = new Error(`deribit ${res.status}`);
		err.status = res.status;
		throw err;
	}
	const body = await res.json();
	if (body?.error) {
		throw new Error(`deribit rpc ${body.error.code}: ${body.error.message || 'error'}`);
	}
	return body?.result;
}

/**
 * Map one `public/ticker` result onto the /api/coin/derivatives ticker row
 * shape: { market, symbol, index_id, price, change_24h, funding_rate,
 * open_interest, volume_24h }.
 *
 * Unit notes, pinned by tests:
 * - `funding_8h` is a decimal 8h rate; rows quote 8h funding as a percentage,
 *   so it is multiplied by 100.
 * - `stats.price_change` is already a 24h percentage.
 * - Inverse perps report `open_interest` in USD; linear (USDC-settled) perps
 *   report base units, converted to USD via the mark price.
 * - A ticker without a positive mark price yields null (instrument halted or
 *   payload malformed).
 *
 * @param {object} ticker  raw `public/ticker` result
 * @param {{ instrument: string, asset: string, linear: boolean }} cfg
 * @returns {object|null}
 */
export function normalizeDeribitPerp(ticker, { instrument, asset, linear }) {
	const price = num(ticker?.mark_price);
	if (!(price > 0)) return null;
	const funding = num(ticker?.funding_8h);
	const oi = num(ticker?.open_interest);
	return {
		market: 'Deribit',
		symbol: instrument,
		index_id: asset,
		price,
		change_24h: num(ticker?.stats?.price_change),
		funding_rate: funding != null ? funding * 100 : null,
		open_interest: oi != null ? (linear ? oi * price : oi) : null,
		volume_24h: num(ticker?.stats?.volume_usd),
	};
}

/**
 * Aggregate a `get_book_summary_by_currency?kind=option` payload into one
 * options summary for `asset`: contract count, USD open interest, USD 24h
 * volume, and the open-interest put/call ratio.
 *
 * Rows are filtered by `base_currency` so the shared USDC book yields a clean
 * SOL aggregate. Option `open_interest` is in base-asset units and converted
 * to USD via each row's `underlying_price`; `volume_usd` is summed as-is. The
 * put/call split keys off the instrument-name suffix (-C / -P).
 *
 * @param {Array<object>} rows  raw book-summary rows
 * @param {string} asset        base currency to keep, e.g. 'BTC'
 * @returns {{ asset: string, contracts: number, open_interest: number,
 *             volume_24h: number, put_call_ratio: number|null }}
 */
export function summarizeDeribitOptions(rows, asset) {
	let contracts = 0;
	let oiUsd = 0;
	let volUsd = 0;
	let callOi = 0;
	let putOi = 0;
	for (const row of Array.isArray(rows) ? rows : []) {
		if (row?.base_currency !== asset || typeof row?.instrument_name !== 'string') continue;
		contracts += 1;
		const oi = num(row.open_interest);
		const underlying = num(row.underlying_price);
		if (oi != null && underlying != null) {
			oiUsd += oi * underlying;
			if (row.instrument_name.endsWith('-C')) callOi += oi;
			else if (row.instrument_name.endsWith('-P')) putOi += oi;
		}
		volUsd += num(row.volume_usd) ?? 0;
	}
	return {
		asset,
		contracts,
		open_interest: oiUsd,
		volume_24h: volUsd,
		put_call_ratio: callOi > 0 ? putOi / callOi : null,
	};
}

/**
 * Live perp rows for every tracked instrument, volume-sorted. One dead
 * instrument does not sink the rest (allSettled), but an empty result throws
 * so callers can fail over.
 * @returns {Promise<Array<object>>}
 */
export async function fetchDeribitPerps() {
	const settled = await Promise.allSettled(
		DERIBIT_PERPS.map((cfg) => deribitGet('ticker', { instrument_name: cfg.instrument })),
	);
	const rows = [];
	for (let i = 0; i < settled.length; i++) {
		if (settled[i].status !== 'fulfilled') continue;
		const row = normalizeDeribitPerp(settled[i].value, DERIBIT_PERPS[i]);
		if (row) rows.push(row);
	}
	if (!rows.length) throw new Error('deribit returned no perps');
	return rows.sort((a, b) => (b.volume_24h ?? 0) - (a.volume_24h ?? 0));
}

/**
 * USD index prices for the tracked assets: { BTC, ETH, SOL }, null for any
 * index Deribit could not serve.
 * @returns {Promise<Record<string, number|null>>}
 */
export async function fetchDeribitIndexes() {
	const assets = ['BTC', 'ETH', 'SOL'];
	const settled = await Promise.allSettled(
		assets.map((a) => deribitGet('get_index_price', { index_name: `${a.toLowerCase()}_usd` })),
	);
	const out = {};
	for (let i = 0; i < assets.length; i++) {
		out[assets[i]] =
			settled[i].status === 'fulfilled' ? num(settled[i].value?.index_price) : null;
	}
	return out;
}

/**
 * Per-asset options aggregates for every tracked book. Books that fail or
 * come back empty are dropped rather than reported as zeros.
 * @returns {Promise<Array<object>>}
 */
export async function fetchDeribitOptionsSummaries() {
	const settled = await Promise.allSettled(
		DERIBIT_OPTION_BOOKS.map(({ currency }) =>
			deribitGet('get_book_summary_by_currency', { currency, kind: 'option' }),
		),
	);
	const summaries = [];
	for (let i = 0; i < settled.length; i++) {
		if (settled[i].status !== 'fulfilled') continue;
		const summary = summarizeDeribitOptions(settled[i].value, DERIBIT_OPTION_BOOKS[i].asset);
		if (summary.contracts > 0) summaries.push(summary);
	}
	return summaries;
}

/**
 * The full Deribit block /api/coin/derivatives attaches to its response:
 * { indexes, perps, options }. Throws when the venue served nothing usable so
 * the endpoint's soft-fail path can drop the block cleanly.
 * @returns {Promise<{ indexes: Record<string, number|null>, perps: Array<object>, options: Array<object> }>}
 */
export async function fetchDeribitSummary() {
	const [indexes, perps, options] = await Promise.all([
		fetchDeribitIndexes(),
		fetchDeribitPerps(),
		fetchDeribitOptionsSummaries(),
	]);
	return { indexes, perps, options };
}
