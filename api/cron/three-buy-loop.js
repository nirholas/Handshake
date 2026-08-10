// GET /api/cron/three-buy-loop
//
// The per-minute $THREE micro-buy driver: many tiny, real x402-settled buys per
// minute so the platform shows continuous, verifiable buy pressure on $THREE.
//
// Each call pays the small x402 toll to /api/x402/three-buy (ring treasury,
// X402_PAY_TO_SOLANA) exactly like the ring tick; the endpoint delivers the paid
// good by executing ONE small, real USDC→$THREE market buy on Jupiter (buy-only)
// funded by the micro-buy wallet. So this loop is "buy $THREE, paid through the
// x402 loop": the x402 payment is the trigger, the on-chain buy is the good.
//
// CADENCE. Fires THREE_MICROBUY_PER_TICK buys per minute (default 10, hard-capped
// at 60) across THREE_MICROBUY_CONCURRENCY concurrent workers (default 8), so a
// full tick finishes inside the economy-tick 60s call budget. Set PER_TICK=60 for
// the "~60 buys/min" target.
//
// SAFETY (defense in depth — the endpoint self-guards too):
//   • Kill switches: X402_AUTONOMOUS_ENABLED=false (global) OR THREE_MICROBUY_ENABLED
//     not truthy OR THREE_MICROBUY_LOOP_ENABLED=false → clean skip.
//   • The real market spend is bounded by the endpoint's UTC-daily ceiling
//     (THREE_MICROBUY_DAILY_CAP_USD, atomic reserve-before-buy). This loop pre-checks
//     it and stops firing once the day's budget is exhausted.
//   • The tolls (internal recirculation) are bounded per tick by
//     X402_THREE_BUY_TOLL_CAP_ATOMIC.
//   • A buy that can't happen never charges a toll — the endpoint re-emits 402.
//
// BUY-ONLY. Nothing here sells $THREE. Accrued tokens are swept to the treasury
// every THREE_MICROBUY_SWEEP_EVERY_N_TICKS ticks.
//
// Real on-chain payments only — no mocks. Shares the ONE payment + recording path
// (pipelines/volume-shared.js) with the ring drivers, tagged pipeline='three-buy'.

import { randomUUID } from 'node:crypto';
import { PublicKey } from '@solana/web3.js';
import { getMint } from '@solana/spl-token';

import { json, method, wrapCron } from '../_lib/http.js';
import { env } from '../_lib/env.js';
import { sql } from '../_lib/db.js';
import { getRedis } from '../_lib/redis.js';
import { solanaConnection } from '../_lib/solana/connection.js';
import { logger } from '../_lib/usage.js';
import { priceFor } from '../_lib/x402-prices.js';
import { loadSeedKeypair, payX402, USDC_MINT, SOLANA_RPC } from '../_lib/x402/pay.js';
import { ensureVolumeSchema, settleAndRecord } from '../_lib/x402/pipelines/volume-shared.js';
import {
	isEnabled as microbuyEnabled,
	ensureMicrobuySchema,
	dailyCapUsd,
	dailySpentAtomics,
	loadMicrobuySigner,
	sweepMicrobuyThree,
	SPENT_STATUSES,
} from '../_lib/token/microbuy.js';
import { usdToUsdcAtomics } from '../_lib/token/buyback-math.js';
import { requireCron } from '../_lib/cron-auth.js';

const log = logger('three-buy-loop');
const ORIGIN = () => (env.APP_ORIGIN || 'https://three.ws').replace(/\/+$/, '');

const THREE_BUY_EP = {
	key: 'three-buy',
	name: 'Three Buy',
	path: '/api/x402/three-buy',
	method: 'POST',
	body: { note: 'microbuy' },
};

// Loop knobs (env, safe defaults).
const perTick = () => {
	const n = Number(process.env.THREE_MICROBUY_PER_TICK);
	if (!Number.isFinite(n) || n <= 0) return 10;
	return Math.min(Math.floor(n), 60); // hard cap the per-minute burst
};
// Concurrent buy workers per tick. When unset, auto-size to the per-tick target
// (capped at 15) so a 60-buy tick runs ~15-wide and finishes well inside the 60s
// economy-tick budget on the broadcast-and-go path (~1-2s/buy). Explicit override
// wins, clamped to [1, 30].
const concurrency = (want) => {
	const raw = Number(process.env.THREE_MICROBUY_CONCURRENCY);
	if (Number.isFinite(raw) && raw >= 1) return Math.min(Math.floor(raw), 30);
	return Math.min(Math.max(1, want || 10), 15);
};
const tollCapAtomic = () => {
	const n = Number(process.env.X402_THREE_BUY_TOLL_CAP_ATOMIC);
	return Number.isFinite(n) && n > 0 ? Math.floor(n) : 1_000_000; // $1.00 of tolls/tick
};
const sweepEveryN = () => {
	const n = Number(process.env.THREE_MICROBUY_SWEEP_EVERY_N_TICKS);
	return Number.isFinite(n) && n > 0 ? Math.floor(n) : 30; // ~ every 30 min
};

// A monotonic tick counter so the periodic sweep fires on a stable cadence across
// warm instances (Redis INCR, in-memory fallback — mirrors the ring tick).
const TICK_SEQ_KEY = 'three:microbuy:tick:seq';
let _memTickSeq = 0;
async function nextTickSeq() {
	const redis = getRedis();
	if (redis) {
		try { return Number(await redis.incr(TICK_SEQ_KEY)); } catch { /* fall through */ }
	}
	return (_memTickSeq += 1);
}

export default wrapCron(async (req, res) => {
	if (!method(req, res, ['GET'])) return;
	if (!requireCron(req, res)) return;

	// ── Kill switches ───────────────────────────────────────────────────────
	if (process.env.X402_AUTONOMOUS_ENABLED === 'false') {
		return json(res, 200, { ok: true, skipped: true, reason: 'X402_AUTONOMOUS_ENABLED=false' });
	}
	if (String(process.env.THREE_MICROBUY_LOOP_ENABLED || '').toLowerCase() === 'false') {
		return json(res, 200, { ok: true, skipped: true, reason: 'THREE_MICROBUY_LOOP_ENABLED=false' });
	}
	if (!microbuyEnabled()) {
		return json(res, 200, { ok: true, skipped: true, reason: 'THREE_MICROBUY_ENABLED not set' });
	}

	const origin = ORIGIN();
	const runId = randomUUID();

	// ── Toll payer ──────────────────────────────────────────────────────────
	let payer;
	try { payer = loadSeedKeypair(); } catch (err) {
		return json(res, 200, { ok: false, skipped: true, reason: err.message });
	}

	try { await ensureVolumeSchema(sql); } catch (err) {
		return json(res, 200, { ok: false, skipped: true, reason: `schema_failed: ${err?.message}` });
	}
	// Self-heal the micro-buy ledger too, so the endpoint's daily-cap DB fallback and
	// its records always have a table (best-effort — the migration owns it in prod).
	try { await ensureMicrobuySchema(); } catch (err) {
		log.warn('three_buy_ledger_schema_failed', { message: err?.message });
	}

	// ── Daily market-spend cap pre-check (the endpoint enforces it atomically;
	// this stops the loop from firing tolls once the day's buys are exhausted) ──
	let dailySpent = 0n;
	try { dailySpent = await dailySpentAtomics(); } catch { dailySpent = 0n; }
	const capAtomic = usdToUsdcAtomics(dailyCapUsd());
	if (dailySpent >= capAtomic) {
		return json(res, 200, {
			ok: true, skipped: true, reason: 'daily_cap_reached', run_id: runId,
			daily_spent_usd: Number(dailySpent) / 1e6, daily_cap_usd: dailyCapUsd(),
		});
	}

	// ── Shared Solana state for the tolls ─────────────────────────────────────
	const conn = solanaConnection({ url: SOLANA_RPC, commitment: 'confirmed' });
	let mintInfo;
	try {
		mintInfo = await getMint(conn, new PublicKey(USDC_MINT));
	} catch (err) {
		return json(res, 200, { ok: false, skipped: true, reason: `rpc_preflight_failed: ${err?.message}`, run_id: runId });
	}

	const want = perTick();
	const conc = concurrency(want);
	const tollCap = tollCapAtomic();
	const tollPriceAtomic = Number(priceFor('three-buy', 1_000));

	let fired = 0, paid = 0, buys = 0, pending = 0, errors = 0, tollSpent = 0;
	let stopReason = null;

	// Fire the buys in waves of `conc`, refetching a blockhash per wave so a long
	// tick never signs tolls against an expired blockhash.
	let idx = 0;
	while (idx < want && !stopReason) {
		if (tollSpent + tollPriceAtomic > tollCap) { stopReason = 'toll_cap'; break; }

		let blockhash;
		try {
			({ blockhash } = await conn.getLatestBlockhash('confirmed'));
		} catch (err) {
			log.warn('three_buy_blockhash_failed', { message: err?.message });
			stopReason = 'blockhash_failed';
			break;
		}

		const waveSize = Math.min(conc, want - idx);
		const wave = await Promise.all(
			Array.from({ length: waveSize }, async () => {
				const remaining = Math.max(0, tollCap - tollSpent);
				const { result, paidAmount } = await settleAndRecord({
					sql, runId, ep: THREE_BUY_EP, origin, remaining,
					ctx: { buyer: payer, conn, blockhash, mintInfo },
					pipeline: 'three-buy', namePrefix: 'MicroBuy', payFn: payX402, log,
				});
				return { result, paidAmount };
			}),
		);

		let wavePaid = 0;
		let capSignal = false;
		for (const { result, paidAmount } of wave) {
			fired += 1;
			if (result.paid) { paid += 1; wavePaid += 1; tollSpent += paidAmount; }
			if (!result.success) {
				errors += 1;
				// The endpoint re-emits 402 with a reason when it won't buy (cap reached,
				// unverifiable, disabled, unfunded). Surface a cap signal for a precise
				// stop reason; the whole-wave guard below catches every systemic case.
				const hay = `${result.errorMsg || ''} ${JSON.stringify(result.responseBody || '')}`;
				if (/cap_reached|cap_unverifiable/i.test(hay)) capSignal = true;
			}
			// A settled toll means the endpoint delivered a broadcast buy. On the
			// throughput path it returns 'submitted' (broadcast, not yet confirmed);
			// with THREE_MICROBUY_AWAIT_CONFIRM it may be 'confirmed'. Count any spend
			// status as a buy; track the not-yet-confirmed ones separately.
			const status = result?.responseBody?.status;
			if (result.paid && SPENT_STATUSES.includes(status)) {
				buys += 1;
				if (status !== 'confirmed') pending += 1;
			}
		}
		idx += waveSize;

		// Whole-wave failure is a systemic signal (cap exhausted, engine disabled,
		// unfunded wallet, or an RPC/DB outage) — stop the tick instead of hammering
		// the endpoint `want` times for nothing. A partial wave (some paid) is the
		// healthy path and the cap-boundary transition, so it continues.
		if (wavePaid === 0 && waveSize > 0) {
			stopReason = capSignal ? 'daily_cap_reached' : 'wave_all_failed';
			break;
		}
	}

	// ── Periodic treasury sweep of accrued $THREE (buy-only lane) ─────────────
	let sweepSig = null;
	const seq = await nextTickSeq();
	if (seq > 0 && seq % sweepEveryN() === 0) {
		try {
			const signer = await loadMicrobuySigner();
			if (signer) sweepSig = await sweepMicrobuyThree(signer);
		} catch (err) {
			log.warn('three_buy_sweep_failed', { message: err?.message });
		}
	}

	log.info('three_buy_loop_complete', {
		run_id: runId, fired, paid, buys, pending, errors,
		toll_spent_usd: (tollSpent / 1e6).toFixed(4),
		daily_spent_usd: (Number(dailySpent) / 1e6).toFixed(4),
		stop_reason: stopReason, sweep: sweepSig ? sweepSig.slice(0, 12) : null,
	});

	return json(res, 200, {
		ok: true,
		run_id: runId,
		fired,
		paid,
		buys,
		pending,
		errors,
		toll_spent_usd: (tollSpent / 1e6).toFixed(4),
		daily_spent_usd: (Number(dailySpent) / 1e6).toFixed(4),
		daily_cap_usd: dailyCapUsd(),
		...(stopReason ? { stop_reason: stopReason } : {}),
		...(sweepSig ? { sweep_signature: sweepSig } : {}),
	});
});
