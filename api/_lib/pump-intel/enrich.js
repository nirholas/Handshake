// Coin Intelligence — wallet funder-graph enrichment (the bubble-map engine).
//
// The intel watcher records every wallet that traded a new coin, but it has no
// chain access on the hot path, so pump_coin_wallets.funder is left null and the
// bubble-map / "is this a bundle?" signal (bubblemap_connectivity, the `bundled`
// wallet label, the funder clusters the /coin-intel API renders) stays dark.
//
// This module fills it. For a coin's top buyers it resolves each wallet's FUNDER
// — the address that sent it its first SOL — directly from chain history, then:
//   • writes pump_coin_wallets.funder (a column nothing else writes — no clobber)
//   • recomputes bubblemap_connectivity (largest shared-funder cluster share) and
//     fresh_wallet_ratio, and merges a structured `bundle` block into the coin's
//     signals, persisting to pump_coin_intel.
//
// Wallets funded from a common source shortly before buying are the classic
// sybil/bundle signature (Bubblemaps' "funding chains"). Wallets with almost no
// prior history are fresh — a bundler/sniper tell. Both become real signals here.
//
// Real chain calls (Helius if configured, else the platform Solana RPC), bounded
// and graceful: it never throws to the caller and degrades to "resolved fewer"
// under rate limits rather than failing the request (Rule 9).

import { env } from '../env.js';
import { sql } from '../db.js';
import { mapPoolSettled } from '../pool.js';

const LAMPORTS_PER_SOL = 1_000_000_000;
// A wallet with at most this many lifetime transactions is "fresh" — a brand-new
// wallet funded once and pointed at a launch is the bundler/sniper fingerprint.
const FRESH_TX_MAX = 12;
// Pagination cap when hunting a wallet's earliest tx. Fresh wallets resolve in
// one page; this bounds the work for old wallets we'll mark not-fresh anyway.
const MAX_SIG_PAGES = 3;
const SIG_PAGE = 1000;
const RPC_TIMEOUT_MS = 8_000;
// System program + common no-signal sources we never treat as a "funder".
const NON_FUNDERS = new Set([
	'11111111111111111111111111111111',                 // System Program
	'So11111111111111111111111111111111111111112',      // Wrapped SOL
]);

/** Best RPC endpoint for the cluster: Helius when keyed (high rate limits), else the platform RPC. */
export function rpcEndpoint(network = 'mainnet') {
	if (network === 'devnet') return env.SOLANA_RPC_URL_DEVNET;
	const key = env.HELIUS_API_KEY;
	if (key) return `https://mainnet.helius-rpc.com/?api-key=${key}`;
	return env.SOLANA_RPC_URL;
}

async function rpc(endpoint, method, params) {
	const r = await fetch(endpoint, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
		signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
	});
	if (!r.ok) {
		const e = new Error(`rpc ${method} ${r.status}`);
		e.status = r.status;
		throw e;
	}
	const body = await r.json();
	if (body.error) throw new Error(`rpc ${method}: ${body.error.message || body.error.code}`);
	return body.result;
}

/**
 * Parse the funder of `address` from its earliest transaction. Pure — given a
 * jsonParsed getTransaction result, find who sent SOL into the wallet.
 *
 * Two layers: (1) an explicit system `transfer`/`transferChecked` whose
 * destination is the wallet → its source is the funder (the precise case);
 * (2) fallback — the wallet's balance rose in this tx and the fee payer (first
 * signer) is someone else → the fee payer funded it (covers CEX/program routes).
 * Returns the funder address or null. Exported for unit testing.
 */
export function parseFunderFromTransaction(tx, address) {
	if (!tx?.transaction?.message) return null;
	const msg = tx.transaction.message;

	const scanIxList = (list) => {
		for (const ix of list || []) {
			const p = ix?.parsed;
			if (!p || (ix.program !== 'system' && ix.programId !== '11111111111111111111111111111111')) continue;
			const t = p.type;
			if (t !== 'transfer' && t !== 'transferChecked' && t !== 'createAccount' && t !== 'createAccountWithSeed') continue;
			const info = p.info || {};
			const dest = info.destination || info.newAccount;
			const src = info.source || info.lamports?.source || info.from;
			if (dest === address && src && src !== address && !NON_FUNDERS.has(src)) {
				return { funder: src, lamports: Number(info.lamports) || null };
			}
		}
		return null;
	};

	// (1) outer instructions, then inner instructions (CEX withdrawals nest).
	const outer = scanIxList(msg.instructions);
	if (outer) return outer;
	for (const inner of tx.meta?.innerInstructions || []) {
		const hit = scanIxList(inner.instructions);
		if (hit) return hit;
	}

	// (2) balance-delta fallback: did this wallet receive SOL, and who paid?
	const keys = msg.accountKeys || [];
	const idx = keys.findIndex((k) => (typeof k === 'string' ? k : k.pubkey) === address);
	const pre = tx.meta?.preBalances;
	const post = tx.meta?.postBalances;
	if (idx >= 0 && Array.isArray(pre) && Array.isArray(post) && post[idx] > pre[idx]) {
		const feePayer = typeof keys[0] === 'string' ? keys[0] : keys[0]?.pubkey;
		if (feePayer && feePayer !== address && !NON_FUNDERS.has(feePayer)) {
			return { funder: feePayer, lamports: post[idx] - pre[idx] };
		}
	}
	return null;
}

/**
 * Resolve one wallet's funder + freshness from chain history.
 * @returns {Promise<{ funder: string|null, fundedLamports: number|null, priorTxCount: number, fresh: boolean }|null>}
 */
export async function resolveFunder(address, { endpoint }) {
	if (!address) return null;
	// Page back to the wallet's earliest signature (and count its history).
	let page = await rpc(endpoint, 'getSignaturesForAddress', [address, { limit: SIG_PAGE }]);
	if (!Array.isArray(page) || !page.length) return null;
	let earliest = page[page.length - 1];
	let total = page.length;
	let pages = 1;
	while (page.length === SIG_PAGE && pages < MAX_SIG_PAGES) {
		page = await rpc(endpoint, 'getSignaturesForAddress', [address, { limit: SIG_PAGE, before: earliest.signature }]);
		if (!Array.isArray(page) || !page.length) break;
		earliest = page[page.length - 1];
		total += page.length;
		pages++;
	}
	const fresh = page.length < SIG_PAGE && total <= FRESH_TX_MAX;

	const tx = await rpc(endpoint, 'getTransaction', [
		earliest.signature,
		{ encoding: 'jsonParsed', maxSupportedTransactionVersion: 0, commitment: 'confirmed' },
	]);
	const parsed = parseFunderFromTransaction(tx, address);
	return {
		funder: parsed?.funder || null,
		fundedLamports: parsed?.lamports ?? null,
		priorTxCount: total,
		fresh,
	};
}

// Bounded-concurrency map — keeps RPC pressure (and 429s) in check. A failing
// wallet yields an `{ error }` entry so one bad read never aborts the enrich.
function mapPool(items, concurrency, fn) {
	return mapPoolSettled(items, concurrency, fn).then((rows) =>
		rows.map((r) => (r.ok ? r.value : { error: r.error?.message || 'failed' })),
	);
}

/**
 * bubblemap_connectivity = share of known-funder wallets that sit in the single
 * largest shared-funder cluster. Mirrors signals.js bubblemapConnectivity so the
 * worker's and the enricher's numbers mean exactly the same thing. 0..1, or null
 * when fewer than 3 wallets have a known funder (not enough to claim a cluster).
 */
export function connectivityFromFunders(funderByWallet) {
	const counts = new Map();
	let known = 0;
	for (const f of Object.values(funderByWallet)) {
		if (!f) continue;
		known++;
		counts.set(f, (counts.get(f) || 0) + 1);
	}
	if (known < 3) return { connectivity: null, known, largest_cluster: 0, clusters: 0 };
	const sizes = [...counts.values()];
	const largest = Math.max(...sizes);
	const clusters = sizes.filter((n) => n >= 2).length;
	return { connectivity: Math.round((largest / known) * 1e4) / 1e4, known, largest_cluster: largest, clusters };
}

/**
 * Resolve funders for a coin's top buyers and write them to pump_coin_wallets.
 * Only touches wallets without a funder already (idempotent, no clobber).
 * @returns {Promise<{ funders: Record<string,string>, resolved: number, attempted: number, fresh: number, source: string }>}
 */
export async function enrichCoinFunders({ mint, wallets, network = 'mainnet', max = 16, concurrency = 3 }) {
	const endpoint = rpcEndpoint(network);
	const source = env.HELIUS_API_KEY ? 'helius' : 'rpc';
	// Rank by buy size; the biggest early buyers are what bundle detection cares about.
	const targets = (wallets || [])
		.filter((w) => w.wallet && !w.funder)
		.sort((a, b) => (Number(b.buy_lamports) || 0) - (Number(a.buy_lamports) || 0))
		.slice(0, max);

	const funders = {};
	let fresh = 0;
	if (!targets.length) return { funders, resolved: 0, attempted: 0, fresh: 0, source };

	const results = await mapPool(targets, concurrency, (w) => resolveFunder(w.wallet, { endpoint }));

	const updates = [];
	results.forEach((res, i) => {
		if (!res || res.error) return;
		if (res.fresh) fresh++;
		if (res.funder) {
			funders[targets[i].wallet] = res.funder;
			updates.push({ wallet: targets[i].wallet, funder: res.funder });
		}
	});

	// Persist funders (only where still null — never overwrite the worker or a prior pass).
	for (const u of updates) {
		try {
			await sql`
				update pump_coin_wallets set funder = ${u.funder}
				where mint = ${mint} and wallet = ${u.wallet} and funder is null
			`;
		} catch (err) {
			console.warn('[coin-intel-enrich] funder write failed:', err?.message);
		}
	}

	return { funders, resolved: updates.length, attempted: targets.length, fresh, source };
}

/**
 * Recompute the funder-dependent signals for a coin from whatever funders are now
 * known, and persist them: bubblemap_connectivity, fresh_wallet_ratio, a bundle
 * block merged into signals, and the bundle_launch risk flag when warranted.
 * @returns {Promise<{ bubblemap_connectivity:number|null, bundle:object }>}
 */
export async function recomputeAndPersist({ mint, network = 'mainnet', freshCount = null, attempted = null }) {
	const rows = await sql`
		select wallet, buy_lamports, sell_lamports, is_creator, funder
		from pump_coin_wallets where mint = ${mint}
	`;
	const funderByWallet = {};
	let buyVolume = 0;
	const buyByWallet = new Map();
	for (const w of rows) {
		const b = Number(w.buy_lamports) || 0;
		buyVolume += b;
		buyByWallet.set(w.wallet, b);
		if (w.funder) funderByWallet[w.wallet] = w.funder;
	}
	const conn = connectivityFromFunders(funderByWallet);

	// Share of buy volume that flowed through multi-wallet shared-funder clusters.
	const clusterMembers = new Map(); // funder -> [wallets]
	for (const [wallet, funder] of Object.entries(funderByWallet)) {
		if (!clusterMembers.has(funder)) clusterMembers.set(funder, []);
		clusterMembers.get(funder).push(wallet);
	}
	let bundledVol = 0;
	let bundleWallets = 0;
	for (const members of clusterMembers.values()) {
		if (members.length < 2) continue;
		bundleWallets += members.length;
		for (const w of members) bundledVol += buyByWallet.get(w) || 0;
	}
	const bundleBuyPct = buyVolume > 0 ? Math.round((bundledVol / buyVolume) * 1000) / 10 : 0;

	const bundle = {
		bundle_detected: bundleWallets >= 2,
		bundle_wallet_count: bundleWallets,
		bundle_buy_pct: bundleBuyPct,
		cluster_count: conn.clusters,
		funders_known: conn.known,
		funder_source: env.HELIUS_API_KEY ? 'helius' : 'rpc',
		...(attempted != null ? { wallets_probed: attempted } : {}),
	};
	// fresh_wallet_ratio over the probed set, when we measured it.
	const freshRatio = (freshCount != null && attempted)
		? Math.round((freshCount / attempted) * 1e4) / 1e4
		: null;

	try {
		await sql`
			update pump_coin_intel set
				bubblemap_connectivity = ${conn.connectivity}::numeric,
				fresh_wallet_ratio = coalesce(${freshRatio}::numeric, fresh_wallet_ratio),
				signals = coalesce(signals, '{}'::jsonb) || ${JSON.stringify({ bundle, bubblemap_connectivity: conn.connectivity, ...(freshRatio != null ? { fresh_wallet_ratio: freshRatio } : {}) })}::jsonb,
				risk_flags = (
					select array(
						select distinct unnest(
							coalesce(risk_flags, '{}') || case when ${bundle.bundle_detected && bundleBuyPct >= 25} then array['bundle_launch'] else '{}'::text[] end
						)
					)
				),
				updated_at = now()
			where mint = ${mint} and network = ${network}
		`;
	} catch (err) {
		console.warn('[coin-intel-enrich] signal persist failed:', err?.message);
	}

	return { bubblemap_connectivity: conn.connectivity, fresh_wallet_ratio: freshRatio, bundle };
}

/**
 * Full enrichment for one coin: resolve funders for its top buyers, then
 * recompute + persist the funder-dependent signals. The orchestrator the API
 * endpoint and any backfill job calls. Never throws — returns a result envelope.
 */
export async function enrichCoin({ mint, network = 'mainnet', max = 16, concurrency = 3 }) {
	try {
		const rows = await sql`
			select wallet, buy_lamports, sell_lamports, is_creator, funder
			from pump_coin_wallets where mint = ${mint}
			order by buy_lamports desc limit 200
		`;
		if (!rows.length) return { ok: false, reason: 'no_wallets', mint };
		const already = rows.every((w) => w.funder) ? rows.length : 0;

		const { funders, resolved, attempted, fresh, source } =
			await enrichCoinFunders({ mint, wallets: rows, network, max, concurrency });

		const signals = await recomputeAndPersist({ mint, network, freshCount: fresh, attempted });

		return {
			ok: true, mint, network, source,
			resolved, attempted, fresh,
			already_known: already,
			...signals,
		};
	} catch (err) {
		console.warn('[coin-intel-enrich] enrichCoin failed:', err?.message);
		return { ok: false, reason: 'enrich_failed', error: err?.message, mint };
	}
}
