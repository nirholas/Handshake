// Pure aggregation layer for the public wallet portfolio overview
// (/api/crypto/portfolio). Takes the balance shape produced by
// api/_lib/balances.js getBalances() plus per-token 24h changes and derives
// everything the /portfolio page renders: classification summary, top-asset
// allocation, per-row shares, and an honest aggregate 24h move.
//
// Coin-agnostic plumbing: the wallet address is supplied at runtime by the
// caller, and classification works on token symbols, never on a curated list
// of promoted projects. Keeping this file pure (no fetch, no env) is what lets
// tests/portfolio-overview.test.js pin the arithmetic with hand-computed
// fixtures, mirroring the tests/portfolio.test.js pattern.
//
// Honesty rules (same contract as api/_lib/portfolio.js):
// - A token with no known price keeps usd 0 in totals but is counted in
//   `unpricedCount` and never invents a valuation.
// - The aggregate 24h change is computed ONLY over rows whose 24h change is
//   known; `coveragePct` states how much of the portfolio that covers, so the
//   UI can say "based on N% of value" instead of implying full coverage.

// Symbol-level classification. Symbols are how every balance provider labels
// holdings across both chain families, and the same symbol means the same
// class on either chain. Uppercase-compared.
export const STABLE_SYMBOLS = new Set([
	'USDC', 'USDT', 'DAI', 'USDS', 'USDE', 'FDUSD', 'PYUSD', 'TUSD', 'USDP',
	'GUSD', 'FRAX', 'LUSD', 'USDD', 'BUSD', 'EURC', 'USDY', 'USD1', 'USDG',
	'SUSD', 'CUSD', 'USDL', 'AUSD',
]);

// Majors: the chain-native reserve assets and their liquid wrappers/stakes.
// Holding these is treated as reserve exposure, not memecoin risk, matching
// the reserve framing in api/_lib/portfolio.js computeRisk().
export const MAJOR_SYMBOLS = new Set([
	'SOL', 'WSOL', 'JITOSOL', 'MSOL', 'BSOL', 'JUPSOL', 'BNSOL', 'INF', 'HSOL',
	'ETH', 'WETH', 'STETH', 'WSTETH', 'RETH', 'CBETH', 'WEETH', 'EETH',
	'BTC', 'WBTC', 'TBTC', 'CBBTC', 'ZBTC',
]);

/**
 * Classify a holding by its symbol.
 * @param {string|null|undefined} symbol
 * @returns {'stable'|'major'|'other'}
 */
export function classifyToken(symbol) {
	const s = String(symbol || '').toUpperCase();
	if (STABLE_SYMBOLS.has(s)) return 'stable';
	if (MAJOR_SYMBOLS.has(s)) return 'major';
	return 'other';
}

// How many named segments the allocation donut carries. Everything past the
// cap folds into an "Other" bucket: the dataviz palette validates its
// categorical slots as a set, and more segments than slots would force hue
// cycling, which is banned.
export const TOP_ASSET_SLOTS = 5;

// Display rounding for USD figures: cents above $1, six significant digits
// below so sub-cent token values survive. Same convention as api/crypto/wallet.js.
function roundUsd(n) {
	if (!(Number(n) > 0)) return 0;
	return Number(n) < 1 ? Number(n.toPrecision(6)) : Math.round(n * 100) / 100;
}

function round2(n) {
	return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
}

/**
 * Build the full overview from a getBalances() result.
 *
 * @param {object} balances getBalances() shape: { chain, address, native, tokens }
 * @param {Map<string, number>|null} [changes] per-identifier 24h change in
 *   percent, keyed by mint/contract (and 'native' for the native asset).
 *   Entries here override any change24h already present on a token row, so a
 *   fresher enrichment pass always wins over a null baked into the snapshot.
 * @param {{ maxRows?: number }} [opts]
 * @returns {{
 *   totalUsd: number, unpricedCount: number,
 *   change24h: { usd: number, pct: number, coveragePct: number } | null,
 *   summary: Record<'stable'|'major'|'other', { usd: number, pct: number, count: number }>,
 *   topAssets: Array<{ symbol: string, name: string|null, usd: number, pct: number,
 *                      slot: number, logo: string|null, id: string|null, count?: number }>,
 *   rows: Array<object>, tokenCount: number, truncated: boolean,
 * }}
 */
export function buildOverview(balances, changes = null, opts = {}) {
	const maxRows = opts.maxRows ?? 200;
	const native = balances?.native || null;
	const tokens = Array.isArray(balances?.tokens) ? balances.tokens : [];

	const rows = [];
	if (native && Number(native.amount) > 0) {
		rows.push(shapeRow({
			id: 'native',
			symbol: native.symbol || (balances.chain === 'solana' ? 'SOL' : 'ETH'),
			name: native.name || null,
			kind: 'native',
			amount: Number(native.amount) || 0,
			price: Number(native.price) || 0,
			usd: Number(native.usd) || 0,
			change24h: pickChange(changes, 'native', native.change24h),
			logo: native.logo || null,
		}));
	}
	for (const t of tokens) {
		const id = t.mint || t.contract || null;
		rows.push(shapeRow({
			id,
			symbol: t.symbol || null,
			name: t.name || null,
			kind: 'token',
			amount: Number(t.amount) || 0,
			price: Number(t.price) || 0,
			usd: Number(t.usd) || 0,
			change24h: pickChange(changes, id, t.change24h),
			logo: t.logo || null,
		}));
	}

	rows.sort((a, b) => (b.usd || 0) - (a.usd || 0));

	const totalUsd = rows.reduce((s, r) => s + (r.usd || 0), 0);
	const unpricedCount = rows.filter((r) => r.amount > 0 && !(r.price > 0)).length;

	for (const r of rows) {
		r.sharePct = totalUsd > 0 ? round2(((r.usd || 0) / totalUsd) * 100) : 0;
	}

	const summary = {
		stable: { usd: 0, pct: 0, count: 0 },
		major: { usd: 0, pct: 0, count: 0 },
		other: { usd: 0, pct: 0, count: 0 },
	};
	for (const r of rows) {
		const bucket = summary[r.class];
		bucket.usd += r.usd || 0;
		if (r.amount > 0) bucket.count += 1;
	}
	for (const k of Object.keys(summary)) {
		summary[k].pct = totalUsd > 0 ? round2((summary[k].usd / totalUsd) * 100) : 0;
		summary[k].usd = roundUsd(summary[k].usd);
	}

	// Aggregate 24h move, exact per row: a token up c% today was worth
	// usd / (1 + c/100) a day ago. Summed only over rows with a known change;
	// coveragePct is the share of portfolio value those rows represent.
	let deltaUsd = 0;
	let coveredUsd = 0;
	for (const r of rows) {
		if (r.change24h == null || !(r.usd > 0)) continue;
		const factor = 1 + r.change24h / 100;
		if (!(factor > 0)) continue;
		deltaUsd += r.usd - r.usd / factor;
		coveredUsd += r.usd;
	}
	const prevCovered = coveredUsd - deltaUsd;
	const change24h = coveredUsd > 0 && prevCovered > 0
		? {
			usd: round2(deltaUsd),
			pct: round2((deltaUsd / prevCovered) * 100),
			coveragePct: totalUsd > 0 ? round2((coveredUsd / totalUsd) * 100) : 0,
		}
		: null;

	// Allocation: merge rows by symbol (the same asset can appear as native +
	// wrapped, or on several accounts), take the top slots, fold the rest.
	const bySymbol = new Map();
	for (const r of rows) {
		if (!(r.usd > 0)) continue;
		const key = (r.symbol || r.id || '?').toUpperCase();
		const agg = bySymbol.get(key);
		if (agg) {
			agg.usd += r.usd;
		} else {
			bySymbol.set(key, { symbol: r.symbol || key, name: r.name, usd: r.usd, logo: r.logo, id: r.id });
		}
	}
	const ranked = [...bySymbol.values()].sort((a, b) => b.usd - a.usd);
	const topAssets = ranked.slice(0, TOP_ASSET_SLOTS).map((a, i) => ({
		symbol: a.symbol,
		name: a.name || null,
		usd: roundUsd(a.usd),
		pct: totalUsd > 0 ? round2((a.usd / totalUsd) * 100) : 0,
		slot: i + 1,
		logo: a.logo || null,
		id: a.id || null,
	}));
	const rest = ranked.slice(TOP_ASSET_SLOTS);
	if (rest.length > 0) {
		const restUsd = rest.reduce((s, a) => s + a.usd, 0);
		topAssets.push({
			symbol: 'Other',
			name: null,
			usd: roundUsd(restUsd),
			pct: totalUsd > 0 ? round2((restUsd / totalUsd) * 100) : 0,
			slot: 0,
			logo: null,
			id: null,
			count: rest.length,
		});
	}

	const truncated = rows.length > maxRows;
	return {
		totalUsd: roundUsd(totalUsd),
		unpricedCount,
		change24h,
		summary,
		topAssets,
		rows: rows.slice(0, maxRows).map((r) => ({ ...r, usd: r.price > 0 ? roundUsd(r.usd) : null })),
		tokenCount: rows.length,
		truncated,
	};
}

function pickChange(changes, id, baked) {
	if (changes && id != null && changes.has(id)) {
		const v = changes.get(id);
		return Number.isFinite(v) ? round2(v) : null;
	}
	return Number.isFinite(baked) ? round2(baked) : null;
}

function shapeRow({ id, symbol, name, kind, amount, price, usd, change24h, logo }) {
	return {
		id,
		symbol,
		name,
		kind,
		class: classifyToken(symbol),
		amount,
		price: price > 0 ? price : null,
		usd,
		change24h,
		logo,
		sharePct: 0,
	};
}
