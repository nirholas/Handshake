// api/_lib/x402/pipelines/datapoint-volume-sweep.js
//
// Datapoint Fabric Volume Sweep — autonomous pipeline.
//
// The datapoint fabric (api/x402/d/[...path].js + api/_lib/market-data/
// datapoints.js) serves 1,000,000+ standalone paid endpoints through ONE dynamic
// route — every (family, id, metric) triple its own $0.0005 USDC endpoint. The
// ring's main volume loop pays the ~60 NAMED catalog endpoints; nothing settled
// against the datapoint route, so those million endpoints rendered 402s with no
// on-chain settlement history of their own for x402scan to attribute.
//
// This sweep closes that gap on Solana. Each run it advances a Redis-backed
// cursor over a live-resolved pool of concrete datapoint URLs and pays the next
// window of them with real on-chain USDC — the SAME payment + recording path
// (pipelines/volume-shared.js settleAndRecord) the main loop uses, so there is
// one settlement code path, not two that drift. Because a datapoint is the
// cheapest call in the whole catalog ($0.0005), this is the most tx-per-dollar
// efficient volume generator we have — and tx count + distinct resources settled
// to our seller is exactly what x402scan ranks.
//
// The URL pool is resolved at RUNTIME from the same cached feeds the paid route
// itself reads (allProtocols/allDexes/allFees/allStablecoins/allChains/
// allCategories/allDerivativeExchanges/loadYieldPools/buildExchanges + the coin
// markets table + the $THREE mint for the per-contract token families). No
// third-party id is hardcoded here — only family names — mirroring how the
// discovery doc (api/wk.js) enumerates the fabric. Over successive runs the
// cursor sweeps the whole pool, so thousands of distinct datapoint URLs each
// accrue their own real Solana settlement history.
//
// Budget: draws from the SAME daily cap the main loop respects (ctx.remainingCap)
// plus a self-imposed per-run cap, so it can never blow total ring spend — it
// simply routes a slice of the capped budget at the cheapest, highest-count
// endpoints. No-op (graceful skip, no spend) when the wallet/RPC is unconfigured.
//
// Wiring: a run()-style entry in autonomous-registry.js
// (`datapoint-volume-sweep`), fired by the autonomous loop on its cooldown.

import { randomUUID } from 'node:crypto';

import { sql as defaultSql } from '../../db.js';
import { env } from '../../env.js';
import { logger } from '../../usage.js';
import { payX402, bootstrapSolanaContext } from '../pay.js';
import {
	ensureVolumeSchema,
	reserveWindow,
	settleAndRecord,
} from './volume-shared.js';
import {
	DATAPOINT_FAMILIES,
	allProtocols,
	allChains,
	allStablecoins,
	allCategories,
	allDexes,
	allFees,
	allDerivativeExchanges,
} from '../../market-data/datapoints.js';
import { loadYieldPools } from '../../../defi/yields.js';
import { buildExchanges } from '../../../coin/exchanges.js';
import { fetchMarketsTable } from '../../market-fallbacks.js';

const log = logger('x402-datapoint-sweep');

const CURSOR_KEY = 'x402:auto:datapoint:cursor';

// $THREE — the platform coin, the worked example for the per-contract token
// families (which resolve any address at runtime; a fixed, reliably-resolvable
// mint is what a settling canary needs).
const THREE_MINT = 'FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump';

// How many distinct datapoint URLs to settle per run. 12 loop ticks/hour × 6 =
// 72 datapoint settles/hour ≈ $0.036/hour at the $0.0005 unit price, all drawn
// from the shared daily cap. Env-tunable.
const SWEEP_BATCH = Math.max(1, Number(env.X402_DATAPOINT_SWEEP_BATCH ?? process.env.X402_DATAPOINT_SWEEP_BATCH ?? 6) || 6);

// Per-run spend ceiling (atomics) so one tick can't drain the day even if the
// pool or price is misconfigured. 6 calls × $0.0005 = 3_000; leave headroom.
const PER_RUN_CAP_ATOMIC = Math.max(0, Number(env.X402_DATAPOINT_SWEEP_CAP_ATOMIC ?? process.env.X402_DATAPOINT_SWEEP_CAP_ATOMIC ?? 50_000) || 50_000);

// Per-family id caps for the sweep pool — keeps the pool bounded and the build
// cheap while covering real breadth. Every metric of each family is swept.
const POOL_ID_CAPS = {
	coin: 60,
	protocol: 120,
	chain: 120,
	pool: 120,
	stablecoin: 80,
	exchange: 60,
	category: 80,
	dex: 60,
	fees: 80,
	'derivative-exchange': 40,
};

const POOL_TTL_MS = 900_000; // 15 min — matches the discovery-doc slice cadence
let _pool = null; // { urls: string[], at }

const metricsOf = (family) => Object.keys(DATAPOINT_FAMILIES[family].metrics);

function pushUrls(out, family, ids) {
	const metrics = metricsOf(family);
	for (const id of ids) {
		if (id == null || id === '') continue;
		for (const metric of metrics) {
			out.push(`/api/x402/d/${family}/${encodeURIComponent(String(id))}/${metric}`);
		}
	}
}

// Build the concrete datapoint URL pool from the live cached feeds. Every id is
// resolved at runtime (never committed); a family whose feed is momentarily down
// is simply skipped this build — the rest still sweep.
async function buildPool() {
	const now = Date.now();
	if (_pool && now - _pool.at < POOL_TTL_MS && _pool.urls.length) return _pool.urls;

	const urls = [];

	// No-id families: every metric, always present.
	for (const family of ['global', 'fear-greed', 'gas']) {
		for (const metric of metricsOf(family)) urls.push(`/api/x402/d/${family}/${metric}`);
	}

	// Per-contract token families — advertised/settled via the $THREE example.
	pushUrls(urls, 'token', [THREE_MINT]);
	pushUrls(urls, 'token-security', [THREE_MINT]);

	const tries = [
		['coin', async () => {
			const { rows } = await fetchMarketsTable({ page: 1, perPage: Math.min(POOL_ID_CAPS.coin, 100), category: '' });
			return rows.map((r) => r.id).filter(Boolean).slice(0, POOL_ID_CAPS.coin);
		}],
		['protocol', async () => [...(await allProtocols()).keys()].slice(0, POOL_ID_CAPS.protocol)],
		['chain', async () => [...(await allChains()).values()].map((c) => c?.name).filter(Boolean).slice(0, POOL_ID_CAPS.chain)],
		['pool', async () => {
			const { pools } = await loadYieldPools();
			return pools.slice(0, POOL_ID_CAPS.pool).map((p) => p.pool).filter(Boolean);
		}],
		['stablecoin', async () => {
			const seen = new Set();
			const ids = [];
			for (const [key, row] of (await allStablecoins()).entries()) {
				if (seen.has(row)) continue;
				seen.add(row);
				ids.push(/^\d+$/.test(key) ? key : row.symbol || key);
				if (ids.length >= POOL_ID_CAPS.stablecoin) break;
			}
			return ids;
		}],
		['exchange', async () => {
			const { exchanges } = await buildExchanges();
			return exchanges.slice(0, POOL_ID_CAPS.exchange).map((e) => e.id).filter(Boolean);
		}],
		['category', async () => [...(await allCategories()).keys()].slice(0, POOL_ID_CAPS.category)],
		['dex', async () => [...(await allDexes()).keys()].slice(0, POOL_ID_CAPS.dex)],
		['fees', async () => [...(await allFees()).keys()].slice(0, POOL_ID_CAPS.fees)],
		['derivative-exchange', async () => [...(await allDerivativeExchanges()).keys()].slice(0, POOL_ID_CAPS['derivative-exchange'])],
	];

	for (const [family, resolve] of tries) {
		try {
			pushUrls(urls, family, await resolve());
		} catch (err) {
			log.info('datapoint_pool_family_skipped', { family, message: err?.message });
		}
	}

	_pool = { urls, at: now };
	log.info('datapoint_pool_built', { size: urls.length });
	return urls;
}

/**
 * Run one datapoint sweep window. Conforms to the run()-style registry contract:
 * the loop hands { origin, buyer, conn, blockhash, mintInfo, remainingCap, runId,
 * sql, redis }; standalone callers get a bootstrapped Solana context.
 *
 * Returns the aggregate outcome the loop records as one summary row.
 */
export async function run(ctx = {}) {
	const sql = ctx.sql || defaultSql;
	const runId = ctx.runId || randomUUID();
	const origin = ctx.origin || env.APP_ORIGIN || 'https://three.ws';
	const redis = ctx.redis || null;

	try {
		await ensureVolumeSchema(sql);
	} catch (err) {
		log.warn('datapoint_sweep_schema_failed', { message: err?.message });
		return { success: false, skipped: true, amountAtomic: 0, errorMsg: `schema_failed: ${err?.message}` };
	}

	let pool;
	try {
		pool = await buildPool();
	} catch (err) {
		log.warn('datapoint_sweep_pool_failed', { message: err?.message });
		return { success: false, skipped: true, amountAtomic: 0, errorMsg: `pool_failed: ${err?.message}` };
	}
	if (!pool.length) {
		return { success: false, skipped: true, amountAtomic: 0, note: 'empty_pool' };
	}

	let { buyer, conn, blockhash, mintInfo } = ctx;
	if (!buyer || !conn || !blockhash || !mintInfo) {
		try {
			({ buyer, conn, blockhash, mintInfo } = await bootstrapSolanaContext({ buyer }));
		} catch (err) {
			log.info('datapoint_sweep_skipped', { reason: err.message });
			return { success: false, skipped: true, amountAtomic: 0, errorMsg: err.message, note: 'wallet_or_rpc_unconfigured' };
		}
	}

	const loopCap = ctx.remainingCap ?? Number.POSITIVE_INFINITY;
	let remaining = PER_RUN_CAP_ATOMIC > 0 ? Math.min(loopCap, PER_RUN_CAP_ATOMIC) : loopCap;

	const indices = await reserveWindow(redis, SWEEP_BATCH, pool.length, CURSOR_KEY);

	let spentAtomic = 0;
	let paid = 0;
	let calls = 0;
	let errors = 0;
	let lastTxSig = null;
	const swept = [];

	for (const idx of indices) {
		if (remaining <= 0) break;
		const path = pool[idx];
		// A stable per-URL ledger key: the path minus the /api/x402/d/ prefix, so
		// x402_volume_metrics accrues one row per datapoint URL swept.
		const ep = { key: `dp:${path.slice('/api/x402/d/'.length)}`, name: `Datapoint ${path}`, path, method: 'GET', body: null };

		const { result, paidAmount } = await settleAndRecord({
			sql, runId, ep, origin, remaining,
			ctx: { buyer, conn, blockhash, mintInfo },
			pipeline: 'datapoint', namePrefix: 'Datapoint', payFn: payX402, log,
		});

		calls += 1;
		if (!result.success) errors += 1;
		if (result.paid) {
			spentAtomic += paidAmount;
			remaining -= paidAmount;
			paid += 1;
			if (result.txSig) lastTxSig = result.txSig;
		}
		swept.push({ path, paid: result.paid === true, success: result.success, status: result.status });
	}

	log.info('datapoint_sweep_complete', {
		run_id: runId, pool_size: pool.length, window: indices.length,
		calls, paid, errors, spent_usdc: (spentAtomic / 1e6).toFixed(4),
	});

	return {
		success: paid > 0 || (calls > 0 && errors < calls),
		amountAtomic: spentAtomic,
		txSig: lastTxSig,
		errorMsg: paid === 0 && errors > 0 ? `datapoint_sweep_calls_failed:${errors}/${calls}` : null,
		skipped: calls === 0,
		responseData: { pool_size: pool.length, window: indices.length, calls, paid, errors, swept },
		signalData: { calls, paid, errors, spent_atomic: spentAtomic },
		note: `datapoint_sweep pool=${pool.length} calls=${calls} paid=${paid} errors=${errors}`,
	};
}
