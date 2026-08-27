// KOL / smart-money trade feed.
//
// Returns recent pump.fun buys/sells made by the tracked KOL_WALLETS for a given
// mint. Source of truth is Helius' enhanced transactions REST API, parsed with
// the exact same parser the realtime webhook path uses (parsePumpTrades), so the
// historical feed and the live webhook stream agree on shape. USD values come
// from the shared SOL/USD price feed; results are cached briefly because this is
// a hot, fast-moving panel.
//
// Shape per trade (superset — the widget reads time/side/wallet/usd/source):
//   { wallet, side:'buy'|'sell', amountSol, amountToken, price, signature, ts,
//     time, usd, source, label }
//   - ts     : unix seconds (provider timestamp)
//   - time   : ISO 8601 string
//   - price  : SOL per token for the trade (0 when token amount is unknown)
//   - usd    : USD value of the SOL leg (null when the price feed is unavailable)
//   - source : 'kol' | 'whale' | 'smart-money' (derived from the wallet's tags)

import { KOL_WALLETS, getWalletMeta } from './wallets.js';
import { parsePumpTrades } from '../../api/_lib/helius.js';
import { solToUsd } from '../shared/usd-price.js';
import { cacheGet, cacheSet } from '../../api/_lib/cache.js';

const HELIUS_TX_API = 'https://api.helius.xyz/v0/addresses';
const PER_WALLET_LIMIT = 100; // enhanced txns scanned per wallet
const FETCH_TIMEOUT_MS = 8_000;
const CACHE_TTL_S = 5; // trades move fast — a few seconds of memo is plenty
// Last-good tier: the most recent feed a healthy fan-out produced, held long
// enough to ride out a whole Helius outage. Served marked stale, never silently.
const LKG_TTL_S = 24 * 3600;

function sourceFromTags(tags = []) {
	if (tags.includes('whale')) return 'whale';
	if (tags.includes('smart-money')) return 'smart-money';
	return 'kol';
}

// Sum the |token amount| of `mint` that moved in/out of `owner` in this txn.
// Helius decodes ui amounts in `tokenTransfers[].tokenAmount`.
function tokenAmountFor(tx, mint, owner) {
	let amt = 0;
	for (const t of tx.tokenTransfers || []) {
		if (t.mint !== mint) continue;
		if (t.fromUserAccount === owner || t.toUserAccount === owner) {
			amt += Math.abs(Number(t.tokenAmount) || 0);
		}
	}
	return amt;
}

async function fetchWalletTxns(wallet, apiKey) {
	const url = `${HELIUS_TX_API}/${wallet}/transactions?api-key=${apiKey}&limit=${PER_WALLET_LIMIT}`;
	const ctrl = new AbortController();
	const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
	try {
		const res = await fetch(url, { signal: ctrl.signal });
		if (!res.ok) throw new Error(`helius ${res.status}`);
		const json = await res.json();
		return Array.isArray(json) ? json : [];
	} finally {
		clearTimeout(timer);
	}
}

/**
 * Fetch recent KOL-wallet trades for a mint.
 *
 * @param {{ mint: string, limit?: number }} opts
 * @returns {Promise<{ trades: Array<object>, source: 'helius'|null, stale?: true, as_of?: string }>}
 *   `stale: true` + `as_of` (ISO) mark a last-good feed served because every
 *   provider lane failed just now; the rows are real, only older.
 *   `source: null` means the feed is unconfigured (no provider key) — an empty
 *   list there is "source off", distinct from a configured source that simply
 *   returned no matching trades. A configured source that *fails* throws (so the
 *   caller emits an error envelope rather than a misleading empty list).
 * @throws {Error & { status: number, code: string }} on bad input / provider failure.
 */
export async function fetchKolTrades({ mint, limit = 20 } = {}) {
	if (!mint) {
		throw Object.assign(new Error('mint is required'), {
			status: 400,
			code: 'validation_error',
		});
	}
	const cap = Math.min(100, Math.max(1, Number(limit) || 20));

	const apiKey = process.env.HELIUS_API_KEY;
	if (!apiKey) {
		console.warn(
			'[kol/trades] HELIUS_API_KEY not set — trade feed unconfigured, returning no trades',
		);
		return { trades: [], source: null };
	}

	const cacheKey = `kol:trades:${mint}:${cap}`;
	const lkgKey = `kol:trades:lkg:${mint}:${cap}`;
	const cached = await cacheGet(cacheKey);
	if (cached) return cached;

	// Fan out across wallets. One wallet's provider hiccup must not blank the
	// whole panel, but a total provider outage must surface as an error.
	const results = await Promise.allSettled(
		KOL_WALLETS.map((w) => fetchWalletTxns(w.address, apiKey)),
	);
	if (results.length > 0 && results.every((r) => r.status === 'rejected')) {
		const reason = results[0]?.reason;
		const lkg = await cacheGet(lkgKey);
		if (lkg && Array.isArray(lkg.trades) && typeof lkg.at === 'number') {
			console.warn(`[kol/trades] every Helius lane failed (${reason?.message || 'unknown'}); serving last-good for ${mint}`);
			return { trades: lkg.trades, source: 'helius', stale: true, as_of: new Date(lkg.at).toISOString() };
		}
		throw Object.assign(
			new Error(`KOL trade provider unavailable: ${reason?.message || 'unknown'}`),
			{ status: 502, code: 'provider_unavailable' },
		);
	}

	const raw = [];
	results.forEach((r, i) => {
		if (r.status !== 'fulfilled') return;
		const walletAddr = KOL_WALLETS[i].address;
		for (const tx of r.value) {
			for (const t of parsePumpTrades(tx)) {
				if (t.mint !== mint) continue;
				const owner = t.wallet || walletAddr;
				const amountToken = tokenAmountFor(tx, mint, owner);
				raw.push({
					wallet: owner,
					side: t.side,
					amountSol: t.sol,
					amountToken,
					price: amountToken > 0 ? t.sol / amountToken : 0,
					signature: t.signature,
					ts: t.ts,
				});
			}
		}
	});

	raw.sort((a, b) => b.ts - a.ts);
	const top = raw.slice(0, cap);

	// One shared SOL price for the whole batch (null if the feed is down — the
	// SOL amount still renders, just without a USD equivalent).
	const solUsd = top.length ? await solToUsd(1) : null;
	const trades = top.map((t) => {
		const meta = getWalletMeta(t.wallet);
		return {
			...t,
			time: new Date(t.ts * 1000).toISOString(),
			usd: solUsd != null ? t.amountSol * solUsd : null,
			source: sourceFromTags(meta?.tags),
			label: meta?.label ?? null,
		};
	});

	const payload = { trades, source: 'helius' };
	await cacheSet(cacheKey, payload, CACHE_TTL_S);
	cacheSet(lkgKey, { trades, at: Date.now() }, LKG_TTL_S).catch(() => {});
	return payload;
}
