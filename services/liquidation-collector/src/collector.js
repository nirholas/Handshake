// Pure collector logic: symbol lists, size buckets, per-exchange message
// parsing, the rolling in-memory store, and the aggregate snapshot.
//
// Everything here is side-effect free and synchronous so it can be tested
// without opening a socket (see tests/liquidation-collector.test.js at the repo
// root). `src/index.js` owns the WebSocket + HTTP wiring and calls into this.

export const TRACKED = [
	'BTC', 'ETH', 'SOL', 'DOGE', 'XRP', 'ARB', 'OP', 'AVAX', 'LINK',
	'BNB', 'SUI', 'WIF', 'PEPE', 'BONK', 'INJ', 'TIA', 'APT', 'NEAR',
];

export const MAX_CACHE = 10_000;
export const MAX_AGE_MS = 4 * 60 * 60 * 1000; // 4 hours

/** @typedef {{ exchange: string, price: number, qty: number, severity: string, side: 'LONG'|'SHORT', symbol: string, time: number, value: number }} LiquidationEntry */

// ---------------------------------------------------------------------------
// Size buckets
// ---------------------------------------------------------------------------

export function classify(value) {
	if (value >= 1_000_000) return 'MEGA';
	if (value >= 100_000) return 'LARGE';
	if (value >= 10_000) return 'MEDIUM';
	return 'SMALL';
}

/**
 * Rolling, capped in-memory store of liquidation entries.
 * @param {{ max?: number }} [opts]
 */
export function createStore({ max = MAX_CACHE } = {}) {
	/** @type {LiquidationEntry[]} */
	const entries = [];
	return {
		entries,
		get size() {
			return entries.length;
		},
		push(entry) {
			entries.push({ ...entry, severity: classify(entry.value) });
			if (entries.length > max) entries.shift();
		},
	};
}

function isFinitePositive(n) {
	return Number.isFinite(n) && n > 0;
}

// ---------------------------------------------------------------------------
// Binance: wss://fstream.binance.com/ws/!forceOrder@arr
// Frame: { e: 'forceOrder', E, o: { s, S, q, p, ap, T, ... } }
// `S` is the side of the forced ORDER, so a forced SELL closed a long.
// ---------------------------------------------------------------------------

export function parseBinanceMessage(raw, tracked = TRACKED) {
	let msg;
	try {
		msg = JSON.parse(raw);
	} catch {
		return [];
	}
	const o = msg?.o;
	if (!o || !o.s) return [];
	const base = String(o.s).replace(/(USDT|USDC|BUSD)$/, '');
	if (!tracked.includes(base)) return [];
	const price = parseFloat(o.ap || o.p);
	const qty = parseFloat(o.q);
	if (!isFinitePositive(price) || !isFinitePositive(qty)) return [];
	return [{
		exchange: 'Binance',
		price,
		qty,
		side: o.S === 'BUY' ? 'SHORT' : 'LONG',
		symbol: base,
		time: Number(o.T) || Date.now(),
		value: price * qty,
	}];
}

// ---------------------------------------------------------------------------
// Bybit: wss://stream.bybit.com/v5/public/linear
// Topic: allLiquidation.{INSTRUMENT}. The older `liquidation.{INSTRUMENT}`
// topic was retired by Bybit and now answers
// `{"success":false,"ret_msg":"error:handler not found,..."}`, which is why
// every subscribe frame carries a req_id and the ack is inspected.
//
// Bybit lists the small-denomination memecoins in 1000x lots (1000PEPEUSDT),
// where price is quoted per 1000 tokens. We normalize back to single-token
// price/qty so `price` is comparable to the spot price the UI shows; the USD
// value is identical either way.
// ---------------------------------------------------------------------------

const BYBIT_LOT_1000 = ['PEPE', 'BONK'];

/** Instrument name Bybit lists a tracked base coin under. */
export function bybitInstrument(base) {
	return BYBIT_LOT_1000.includes(base) ? `1000${base}USDT` : `${base}USDT`;
}

/** Base coin + lot size behind a Bybit instrument name. */
export function bybitBase(instrument) {
	const name = String(instrument ?? '');
	const lotted = name.match(/^1000([A-Z0-9]+)USDT$/);
	if (lotted) return { base: lotted[1], lot: 1000 };
	return { base: name.replace(/USDT$/, ''), lot: 1 };
}

export function bybitTopics(tracked = TRACKED) {
	return tracked.map((base) => `allLiquidation.${bybitInstrument(base)}`);
}

/**
 * Reads a Bybit `op` frame. Returns null for anything that is not an
 * operation ack, so the caller can fall through to data parsing.
 * @returns {{ op: string, ok: boolean, topic: string, message: string }|null}
 */
export function readBybitAck(raw) {
	let msg;
	try {
		msg = JSON.parse(raw);
	} catch {
		return null;
	}
	if (!msg || typeof msg.op !== 'string') return null;
	return {
		op: msg.op,
		ok: msg.success !== false,
		topic: String(msg.req_id ?? ''),
		message: String(msg.ret_msg ?? ''),
	};
}

export function parseBybitMessage(raw, tracked = TRACKED) {
	let msg;
	try {
		msg = JSON.parse(raw);
	} catch {
		return [];
	}
	if (!msg || msg.op || !Array.isArray(msg.data)) return [];
	const out = [];
	for (const d of msg.data) {
		const { base, lot } = bybitBase(d.s);
		if (!tracked.includes(base)) continue;
		const lotPrice = parseFloat(d.p);
		const lotQty = parseFloat(d.v);
		if (!isFinitePositive(lotPrice) || !isFinitePositive(lotQty)) continue;
		out.push({
			exchange: 'Bybit',
			price: lotPrice / lot,
			qty: lotQty * lot,
			// Bybit documents `S` on allLiquidation as the POSITION side: a Buy
			// update means a long position was liquidated. That is inverted
			// versus the order-side convention Binance and OKX use.
			side: d.S === 'Buy' ? 'LONG' : 'SHORT',
			symbol: base,
			time: Number(d.T ?? msg.ts) || Date.now(),
			value: lotPrice * lotQty,
		});
	}
	return out;
}

// ---------------------------------------------------------------------------
// OKX: wss://ws.okx.com:8443/ws/v5/public, channel liquidation-orders
// Frame: { arg, data: [ { instId, instType, details: [ { bkPx, sz, side, ts } ] } ] }
//
// `sz` is a CONTRACT count, not a base-coin quantity: one BTC-USDT-SWAP
// contract is 0.01 BTC and one BONK-USDT-SWAP contract is 100000 BONK. Taking
// sz at face value overstated BTC liquidations 100x and understated BONK
// 100000x, so an unknown instrument is dropped rather than guessed
// (see src/okx-contracts.js for how the multipliers are fetched).
// ---------------------------------------------------------------------------

/**
 * Base quantity + USD value of an OKX liquidation, using the instrument's
 * contract specification. Returns null when the contract is unknown or the
 * numbers are unusable, so callers never publish a fabricated size.
 */
export function okxSize({ contract, sz, price }) {
	if (!contract) return null;
	const contracts = parseFloat(sz);
	const px = parseFloat(price);
	if (!isFinitePositive(contracts) || !isFinitePositive(px)) return null;
	const perContract = contract.ctVal * contract.ctMult;
	if (!isFinitePositive(perContract)) return null;
	const units = contracts * perContract;
	// Inverse (coin-margined) contracts denominate ctVal in the quote currency:
	// one BTC-USD-SWAP contract is 100 USD of notional, not 100 BTC.
	if (contract.quoteDenominated) return { qty: units / px, value: units };
	return { qty: units, value: units * px };
}

/**
 * @param {string} raw
 * @param {{ get: (instId: string) => ({ ctVal: number, ctMult: number, quoteDenominated: boolean }|undefined) }} contracts
 */
export function parseOkxMessage(raw, contracts, tracked = TRACKED) {
	if (raw === 'pong') return [];
	let msg;
	try {
		msg = JSON.parse(raw);
	} catch {
		return [];
	}
	if (!msg || msg.event || !Array.isArray(msg.data)) return [];
	const out = [];
	for (const item of msg.data) {
		const instId = String(item.instId ?? '');
		const base = instId.split('-')[0];
		if (!tracked.includes(base)) continue;
		const contract = contracts.get(instId);
		if (!contract) continue;
		for (const d of item.details ?? []) {
			const sized = okxSize({ contract, sz: d.sz, price: d.bkPx });
			if (!sized) continue;
			out.push({
				exchange: 'OKX',
				price: parseFloat(d.bkPx),
				qty: sized.qty,
				side: d.side === 'buy' ? 'SHORT' : 'LONG',
				symbol: base,
				time: Number(d.ts) || Date.now(),
				value: sized.value,
			});
		}
	}
	return out;
}

// ---------------------------------------------------------------------------
// Aggregate snapshot (the /liquidations response body)
// ---------------------------------------------------------------------------

export function buildSnapshot(entries, now = Date.now()) {
	const cutoff = now - MAX_AGE_MS;
	const recent = entries
		.filter((l) => l.time > cutoff)
		.sort((a, b) => b.time - a.time);

	const longLiqs = recent.filter((l) => l.side === 'LONG');
	const shortLiqs = recent.filter((l) => l.side === 'SHORT');
	const longValue = longLiqs.reduce((s, l) => s + l.value, 0);
	const shortValue = shortLiqs.reduce((s, l) => s + l.value, 0);

	const bySymbol = {};
	for (const l of recent) {
		if (!bySymbol[l.symbol]) {
			bySymbol[l.symbol] = { count: 0, longValue: 0, shortValue: 0, symbol: l.symbol };
		}
		bySymbol[l.symbol].count++;
		if (l.side === 'LONG') bySymbol[l.symbol].longValue += l.value;
		else bySymbol[l.symbol].shortValue += l.value;
	}

	return {
		liquidations: recent.slice(0, 50),
		summary: {
			dominantSide:
				longValue > shortValue * 1.5
					? 'LONG PAIN'
					: shortValue > longValue * 1.5
						? 'SHORT SQUEEZE'
						: 'BALANCED',
			largeCount: recent.filter((l) => l.severity === 'LARGE').length,
			longCount: longLiqs.length,
			longValue,
			megaCount: recent.filter((l) => l.severity === 'MEGA').length,
			shortCount: shortLiqs.length,
			shortValue,
			totalCount: recent.length,
			totalValue: longValue + shortValue,
		},
		symbolStats: Object.values(bySymbol).sort(
			(a, b) => b.longValue + b.shortValue - (a.longValue + a.shortValue),
		),
		timestamp: new Date(now).toISOString(),
	};
}
