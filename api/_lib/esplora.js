// Blockstream Esplora layer: https://blockstream.info/api (keyless Bitcoin
// mainnet chain data: addresses, transactions, fee estimates, tip height).
//
// Esplora is the same API family mempool.space serves, so this doubles as the
// keyless fallback lane for anything Bitcoin-facing (the /forever inscription
// status path uses it to report real on-chain confirmation of reveal/commit
// txs). Same conventions as the DeFiLlama layer (api/_lib/market-data.js):
// per-instance LRU cache as a burst shield, jittered retry on 429/5xx via the
// shared resilience helper, camelCase normalized shapes. Esplora returns plain
// text for a few endpoints (tip height), so the fetch helper handles both.

import { createCache } from './mem-cache.js';
import { withRetry } from './resilience.js';

export const ESPLORA_BASE = 'https://blockstream.info/api';

export const ESPLORA_CACHE_TTL = {
	tip: 30_000, // a new block roughly every 10 min; 30 s keeps confirmations fresh
	fees: 60_000,
	address: 60_000,
	txUnconfirmed: 30_000,
	txConfirmed: 600_000, // a confirmed tx's content is immutable; only depth changes
};

const _cache = createCache({ max: 256 });

/** Drop every cached entry. Exposed for tests; not used in product code. */
export function clearEsploraCache() {
	_cache.clear();
}

const TXID_RE = /^[0-9a-f]{64}$/i;
// Mainnet address classes: base58 P2PKH/P2SH (1…, 3…) and bech32/bech32m
// segwit (bc1…). Format-level check only; Esplora is the validity authority.
const ADDRESS_RE = /^(bc1[02-9ac-hj-np-z]{11,87}|[13][a-km-zA-HJ-NP-Z1-9]{25,34})$/;

/** True when `s` looks like a Bitcoin mainnet address. */
export function isPlausibleBitcoinAddress(s) {
	return typeof s === 'string' && ADDRESS_RE.test(s);
}

/** True when `s` looks like a transaction id. */
export function isPlausibleTxid(s) {
	return typeof s === 'string' && TXID_RE.test(s);
}

/** Retry only on 429/5xx or errors with no HTTP status (network/timeout). */
function shouldRetryFetch(err) {
	const status = err?.status;
	if (typeof status !== 'number') return true;
	return status === 429 || status >= 500;
}

/**
 * GET an Esplora path, retrying with jittered exponential backoff on 429/5xx.
 * Esplora serves JSON for most endpoints but plain text for a few (tip
 * height, error bodies), so this parses by content. Throws an Error carrying
 * `.status` on a non-retryable failure (404 = unknown address/tx).
 *
 * @param {string} path  must start with '/'
 * @param {{ maxRetries?: number, timeoutMs?: number }} [options]
 */
export function esploraFetch(path, options = {}) {
	const { maxRetries = 2, timeoutMs = 10_000 } = options;
	return withRetry(
		async () => {
			const res = await fetch(`${ESPLORA_BASE}${path}`, {
				headers: { accept: 'application/json, text/plain', 'user-agent': 'three.ws/1.0' },
				signal: AbortSignal.timeout(timeoutMs),
			});
			const text = await res.text();
			if (!res.ok) {
				// Esplora error bodies are short plain-text reasons ("Transaction not found").
				const reason = text.trim().slice(0, 200);
				const err = new Error(`Esplora HTTP ${res.status} for ${path}${reason ? `: ${reason}` : ''}`);
				err.status = res.status;
				throw err;
			}
			try {
				return JSON.parse(text);
			} catch {
				return text.trim();
			}
		},
		{
			attempts: maxRetries + 1,
			initialDelayMs: 1_000,
			maxDelayMs: 30_000,
			shouldRetry: shouldRetryFetch,
		},
	);
}

const toNum = (v) => {
	const n = Number(v);
	return Number.isFinite(n) ? n : null;
};

/**
 * Current chain tip height.
 * @returns {Promise<number>}
 */
export async function getTipHeight() {
	const cacheKey = 'esplora:tip';
	const cached = _cache.get(cacheKey);
	if (cached !== undefined) return cached;

	const raw = await esploraFetch('/blocks/tip/height');
	const height = toNum(raw);
	if (height === null) throw new Error(`unexpected Esplora tip height payload: ${String(raw).slice(0, 80)}`);

	_cache.set(cacheKey, height, { ttl: ESPLORA_CACHE_TTL.tip });
	return height;
}

/**
 * @typedef {Object} FeeEstimates
 * @property {Object<string, number>} estimates  confirmation target (blocks) → sat/vB
 * @property {number|null} fastest   next-block target (1)
 * @property {number|null} halfHour  3-block target
 * @property {number|null} hour      6-block target
 * @property {number|null} economy   144-block (about a day) target
 */

/**
 * Pick the fee for a confirmation target: exact target when present,
 * otherwise the nearest available target at or above it (a slightly slower
 * target only ever quotes an equal-or-lower fee, so this never underquotes).
 */
function feeAt(estimates, target) {
	if (estimates[target] !== undefined) return estimates[target];
	const targets = Object.keys(estimates)
		.map(Number)
		.filter((t) => Number.isFinite(t))
		.sort((a, b) => a - b);
	for (const t of targets) {
		if (t >= target) return estimates[String(t)] ?? estimates[t];
	}
	return null;
}

/**
 * Fee estimates in sat/vB keyed by confirmation target, plus the familiar
 * fastest/halfHour/hour/economy tiers.
 * @returns {Promise<FeeEstimates>}
 */
export async function getFeeEstimates() {
	const cacheKey = 'esplora:fees';
	const cached = _cache.get(cacheKey);
	if (cached) return cached;

	const raw = await esploraFetch('/fee-estimates');
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
		throw new Error('unexpected Esplora fee-estimates payload');
	}
	const estimates = {};
	for (const [target, rate] of Object.entries(raw)) {
		const n = toNum(rate);
		if (n !== null) estimates[target] = n;
	}

	const result = {
		estimates,
		fastest: feeAt(estimates, 1),
		halfHour: feeAt(estimates, 3),
		hour: feeAt(estimates, 6),
		economy: feeAt(estimates, 144),
	};

	_cache.set(cacheKey, result, { ttl: ESPLORA_CACHE_TTL.fees });
	return result;
}

/**
 * @typedef {Object} AddressInfo
 * @property {string} address
 * @property {number} balanceSats         confirmed funded minus spent
 * @property {number} pendingBalanceSats  net of mempool txos (can be negative)
 * @property {number} txCount             confirmed transactions
 * @property {number} mempoolTxCount
 * @property {{fundedTxoCount: number, fundedTxoSum: number, spentTxoCount: number, spentTxoSum: number, txCount: number}} chainStats
 * @property {{fundedTxoCount: number, fundedTxoSum: number, spentTxoCount: number, spentTxoSum: number, txCount: number}} mempoolStats
 */

function mapStats(s) {
	return {
		fundedTxoCount: toNum(s?.funded_txo_count) ?? 0,
		fundedTxoSum: toNum(s?.funded_txo_sum) ?? 0,
		spentTxoCount: toNum(s?.spent_txo_count) ?? 0,
		spentTxoSum: toNum(s?.spent_txo_sum) ?? 0,
		txCount: toNum(s?.tx_count) ?? 0,
	};
}

/**
 * Confirmed + mempool stats for a Bitcoin address.
 * @param {string} address
 * @returns {Promise<AddressInfo>}
 */
export async function getAddress(address) {
	if (!isPlausibleBitcoinAddress(address)) {
		throw Object.assign(new Error('a Bitcoin mainnet address is required'), { status: 400 });
	}
	const cacheKey = `esplora:addr:${address}`;
	const cached = _cache.get(cacheKey);
	if (cached) return cached;

	const raw = await esploraFetch(`/address/${encodeURIComponent(address)}`);
	const chainStats = mapStats(raw?.chain_stats);
	const mempoolStats = mapStats(raw?.mempool_stats);

	const result = {
		address: raw?.address ?? address,
		balanceSats: chainStats.fundedTxoSum - chainStats.spentTxoSum,
		pendingBalanceSats: mempoolStats.fundedTxoSum - mempoolStats.spentTxoSum,
		txCount: chainStats.txCount,
		mempoolTxCount: mempoolStats.txCount,
		chainStats,
		mempoolStats,
	};

	_cache.set(cacheKey, result, { ttl: ESPLORA_CACHE_TTL.address });
	return result;
}

/**
 * @typedef {Object} TxStatus
 * @property {boolean} confirmed
 * @property {number|null} blockHeight
 * @property {string|null} blockHash
 * @property {number|null} blockTime  unix seconds
 */

function mapStatus(status) {
	return {
		confirmed: Boolean(status?.confirmed),
		blockHeight: toNum(status?.block_height),
		blockHash: typeof status?.block_hash === 'string' ? status.block_hash : null,
		blockTime: toNum(status?.block_time),
	};
}

/**
 * Confirmation status of a transaction (small dedicated endpoint; use this
 * over getTransaction when only depth matters). Throws with .status = 404
 * for a txid the chain and mempool have never seen.
 *
 * @param {string} txid
 * @returns {Promise<TxStatus>}
 */
export async function getTransactionStatus(txid) {
	if (!isPlausibleTxid(txid)) {
		throw Object.assign(new Error('a 64-hex-char txid is required'), { status: 400 });
	}
	const id = txid.toLowerCase();
	const cacheKey = `esplora:txstatus:${id}`;
	const cached = _cache.get(cacheKey);
	if (cached) return cached;

	const raw = await esploraFetch(`/tx/${id}/status`);
	const result = mapStatus(raw);

	_cache.set(cacheKey, result, {
		ttl: result.confirmed ? ESPLORA_CACHE_TTL.txConfirmed : ESPLORA_CACHE_TTL.txUnconfirmed,
	});
	return result;
}

/**
 * @typedef {Object} TransactionInfo
 * @property {string} txid
 * @property {TxStatus} status
 * @property {number|null} fee        sats
 * @property {number|null} size       bytes
 * @property {number|null} weight     weight units
 * @property {number|null} vsize      ceil(weight / 4)
 * @property {number|null} feeRate    sat/vB
 * @property {number} inputCount
 * @property {number} outputCount
 * @property {number} outputValueSats
 */

/**
 * Full transaction detail, lightly normalized.
 * @param {string} txid
 * @returns {Promise<TransactionInfo>}
 */
export async function getTransaction(txid) {
	if (!isPlausibleTxid(txid)) {
		throw Object.assign(new Error('a 64-hex-char txid is required'), { status: 400 });
	}
	const id = txid.toLowerCase();
	const cacheKey = `esplora:tx:${id}`;
	const cached = _cache.get(cacheKey);
	if (cached) return cached;

	const raw = await esploraFetch(`/tx/${id}`);
	const status = mapStatus(raw?.status);
	const weight = toNum(raw?.weight);
	const fee = toNum(raw?.fee);
	const vsize = weight !== null ? Math.ceil(weight / 4) : null;
	const vout = Array.isArray(raw?.vout) ? raw.vout : [];

	const result = {
		txid: raw?.txid ?? id,
		status,
		fee,
		size: toNum(raw?.size),
		weight,
		vsize,
		feeRate: fee !== null && vsize ? fee / vsize : null,
		inputCount: Array.isArray(raw?.vin) ? raw.vin.length : 0,
		outputCount: vout.length,
		outputValueSats: vout.reduce((sum, o) => sum + (toNum(o?.value) ?? 0), 0),
	};

	_cache.set(cacheKey, result, {
		ttl: status.confirmed ? ESPLORA_CACHE_TTL.txConfirmed : ESPLORA_CACHE_TTL.txUnconfirmed,
	});
	return result;
}
