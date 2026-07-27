// GET /api/cron/x402-ring-tick
//
// Per-minute ring tick — the driver that makes three.ws's x402 endpoints get hit
// every minute, many times: tips, services, and settlements bought and sold on a
// continuous cadence, all inside hard caps and settled by the self-hosted
// facilitator so no third party ever touches ring money.
//
// The 5-minute autonomous loop (x402-autonomous-loop.js) already sweeps the
// catalog, but at 300s cooldowns and a $0.05 per-run cap the flagship ring-settle
// ($1.00) was skipped every cycle. This cron runs EVERY MINUTE with its own,
// separate budget and a weighted rotation:
//
//   • X402_RING_TICK_CALLS paid calls per minute (default 3), cheap tips/services
//     ($0.001–$0.01) dominating the count so the platform shows constant activity.
//   • one ring-settle at X402_PRICE_RING_SETTLE every X402_RING_SETTLE_EVERY_N_TICKS
//     ticks (default 5) to carry real volume cheaply (fewer, larger payments —
//     the fee-optimal lever; see docs/x402-ring-economy.md "Cadence").
//
// Budgets (both enforced, both SEPARATE from the autonomous loop's daily cap):
//   • X402_RING_TICK_CAP_ATOMIC  per-tick spend ceiling (default $1.10 — fits one
//     ring-settle plus its cheap co-riders).
//   • X402_RING_DAILY_CAP_ATOMIC ring-tick daily ceiling (default $50), summed
//     from x402_autonomous_log rows tagged pipeline='ring-tick'. The autonomous
//     loop's Redis spend accumulator is never touched.
//
// Safety:
//   • Kill switches: X402_AUTONOMOUS_ENABLED=false (global) OR
//     X402_RING_TICK_ENABLED=false (this driver) → clean skip.
//   • Config gate: runs only when validateRingConfig() reports no ERROR findings
//     (settlement routes in-house and is buildable); WARN findings are logged.
//   • Back-pressure: below the SOL floor, insufficient payer USDC, or an RPC
//     fault → skip the whole tick with a structured log row and ONE throttled
//     ops alert (max 1/hour per reason). Never a retry-storm of failing settles.
//
// Real on-chain payments only — no mocks. Shares the ONE payment + recording path
// (pipelines/volume-shared.js) with the volume loop.

import { randomUUID } from 'node:crypto';
import { PublicKey } from '@solana/web3.js';
import {
	getAssociatedTokenAddressSync, getAccount, getMint,
	TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
} from '@solana/spl-token';

import { json, wrapCron } from '../_lib/http.js';
import { env } from '../_lib/env.js';
import { constantTimeEquals } from '../_lib/crypto.js';
import { getRedis } from '../_lib/redis.js';
import { sql } from '../_lib/db.js';
import { solanaConnection } from '../_lib/solana/connection.js';
import { logger } from '../_lib/usage.js';
import { sendOpsAlert } from '../_lib/alerts.js';
import { priceFor } from '../_lib/x402-prices.js';
import { loadSeedKeypair, payX402, USDC_MINT, SOLANA_RPC } from '../_lib/x402/pay.js';
import { ringPoolEnabled, claimNextPayer } from '../_lib/x402/pool.js';
import { validateRingConfig } from '../_lib/x402/ring-config.js';
import { assertRingSpendInvariants } from '../_lib/x402/ring-allowlist.js';
import {
	ASSET,
	RING_SETTLE_ENDPOINT,
	CHEAP_ENDPOINTS,
	ensureVolumeSchema,
	settleAndRecord,
} from '../_lib/x402/pipelines/volume-shared.js';
import {
	ringTickConfig,
	planTick,
	planBackpressure,
	governedCalls,
	tickBudget,
	gateOnRingConfig,
} from '../_lib/x402/ring-tick-plan.js';
import { runTickPicks } from '../_lib/x402/ring-tick-exec.js';

const log = logger('x402-ring-tick');

const ORIGIN = () => env.APP_ORIGIN || 'https://three.ws';
const RING_SETTLE_DEFAULT_PRICE = '1000000'; // $1.00 — mirrors ring-settle.js (RING_SETTLE_DEFAULT_PRICE_ATOMICS)
// Worst-case budget reservation per cheap call (atomics). Must cover the
// priciest CHEAP_ENDPOINTS entry ($0.001–$0.01 today) — a cheap call whose 402
// challenge exceeds its reservation is refused by payX402, not overspent.
const CHEAP_RESERVATION_ATOMIC = 20_000; // $0.02

// Redis keys: a monotonic per-minute tick counter and the cheap-rotation cursor.
// Independent of the volume loop's cursor so the two drivers rotate separately.
const TICK_SEQ_KEY = 'x402:ring:tick:seq';
const CHEAP_CURSOR_KEY = 'x402:ring:tick:cheap';
let _memTickSeq = 0;
let _memCheapCursor = 0;

function requireCron(req, res) {
	const secret = process.env.CRON_SECRET || env.CRON_SECRET;
	if (!secret) { json(res, 503, { error: 'CRON_SECRET unset' }); return false; }
	const auth = req.headers['authorization'] || '';
	const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
	if (!constantTimeEquals(token, secret)) { json(res, 401, { error: 'unauthorized' }); return false; }
	return true;
}

// Advance the durable per-minute counter (Redis INCR, in-memory fallback).
async function nextTickSeq(redis) {
	if (redis) {
		try { return Number(await redis.incr(TICK_SEQ_KEY)); } catch { /* fall through */ }
	}
	return (_memTickSeq += 1);
}

// Reserve the next `count` cheap-rotation indices, returning the start cursor.
async function reserveCheapCursor(redis, count) {
	if (count <= 0) return 0;
	if (redis) {
		try {
			const end = Number(await redis.incrby(CHEAP_CURSOR_KEY, count));
			return end - count;
		} catch { /* fall through */ }
	}
	const start = _memCheapCursor;
	_memCheapCursor += count;
	return start;
}

// Sum of ring-tick spend so far this UTC day (paid amounts only — settleAndRecord
// records 0 for non-paid calls). Separate from the autonomous loop's budget by
// construction: it filters on pipeline='ring-tick'.
async function ringDailySpent() {
	// UTC calendar day, computed in SQL (the platform's day convention — mirrors
	// the autonomous loop's toISOString()-based UTC key). No JS Date param binding.
	const rows = await sql`
		SELECT COALESCE(SUM(amount_atomic), 0)::bigint AS spent
		FROM x402_autonomous_log
		WHERE pipeline = 'ring-tick' AND ts >= date_trunc('day', now())
	`;
	return Number(rows[0]?.spent || 0);
}

// One structured, queryable row for a skipped/failed tick. Every non-paying tick
// outcome leaves a trail (task 04 constraint). Wrapped — a DB fault never crashes
// the cron.
async function recordSkip(runId, origin, reason, extra = {}) {
	try {
		await sql`
			INSERT INTO x402_autonomous_log
				(run_id, endpoint_type, service_name, endpoint_url,
				 network, amount_atomic, asset, success, error_msg, pipeline, value_extracted)
			VALUES
				(${runId}, ${'self'}, ${'Ring Tick'}, ${`${origin}/api/cron/x402-ring-tick`},
				 ${'solana:mainnet'}, ${0}, ${ASSET}, ${false}, ${reason}, ${'ring-tick'},
				 ${JSON.stringify({ skipped: true, reason, ...extra })})
		`;
	} catch (err) {
		log.warn('ring_tick_skip_log_failed', { reason, message: err?.message });
	}
}

// Does a paid result carry a facilitator SOL-floor signal? (Back-pressure that
// appeared mid-tick — the pre-flight check passed but the floor was crossed.)
function isFloorSignal(result) {
	const hay = `${result?.errorMsg || ''} ${JSON.stringify(result?.responseBody || '')}`;
	return /below_floor|sol_floor|fee_wallet_below/i.test(hay);
}

export default wrapCron(async (req, res) => {
	if (req.method !== 'GET') return json(res, 405, { error: 'method_not_allowed' });
	if (!requireCron(req, res)) return;

	const origin = ORIGIN();

	// ── Kill switches ─────────────────────────────────────────────────────────
	if (process.env.X402_AUTONOMOUS_ENABLED === 'false') {
		return json(res, 200, { ok: true, skipped: true, reason: 'X402_AUTONOMOUS_ENABLED=false' });
	}
	const cfg = ringTickConfig();
	if (!cfg.enabled) {
		return json(res, 200, { ok: true, skipped: true, reason: 'X402_RING_TICK_ENABLED=false' });
	}

	// ── Config gate: only run with a clean (no-error) ring envelope ────────────
	const findings = validateRingConfig();
	const gate = gateOnRingConfig(findings);
	if (gate.warnings.length) {
		log.warn('ring_tick_config_warnings', { warnings: gate.warnings.map((w) => w.code) });
	}
	if (gate.blocked) {
		log.warn('ring_tick_config_blocked', { errors: gate.errors.map((e) => e.code) });
		return json(res, 200, {
			ok: true,
			skipped: true,
			reason: 'ring_config_invalid',
			findings: gate.errors,
		});
	}

	// ── Leak-proofing invariant — fail CLOSED before any spend ────────────────
	// external spending off, charity split zero, facilitator = self. A flipped or
	// forgotten guard no-ops the whole tick and fires one throttled CRITICAL
	// alert naming the flag — see api/_lib/x402/ring-allowlist.js.
	const invariants = await assertRingSpendInvariants({ context: 'x402-ring-tick' });
	if (!invariants.ok) {
		return json(res, 200, {
			ok: false,
			skipped: true,
			reason: 'ring_invariant_violation',
			violations: invariants.violations.map((v) => v.flag),
		});
	}

	const runId = randomUUID();
	const redis = getRedis();

	// ── Payer keypair ─────────────────────────────────────────────────────────
	let payer;
	try { payer = loadSeedKeypair(); } catch (err) {
		return json(res, 200, { ok: false, skipped: true, reason: err.message });
	}

	if (redis) {
		try { await redis.ping(); } catch (err) {
			return json(res, 200, { ok: false, skipped: true, reason: `redis_unavailable: ${err?.message}` });
		}
	}

	// ── Schema (shared ledger + log column) ────────────────────────────────────
	try {
		await ensureVolumeSchema(sql);
	} catch (err) {
		return json(res, 200, { ok: false, skipped: true, reason: `schema_failed: ${err?.message}` });
	}

	// ── Shared Solana state (one blockhash per tick) ──────────────────────────
	const conn = solanaConnection({ url: SOLANA_RPC, commitment: 'confirmed' });
	let blockhash, mintInfo;
	try {
		[{ blockhash }, mintInfo] = await Promise.all([
			conn.getLatestBlockhash('confirmed'),
			getMint(conn, new PublicKey(USDC_MINT)),
		]);
	} catch (err) {
		await recordSkip(runId, origin, 'rpc_preflight_failed', { message: err?.message });
		await sendOpsAlert('x402 ring tick paused: RPC preflight failed', String(err?.message || err), { signature: 'ring-tick:rpc' });
		return json(res, 200, { ok: false, skipped: true, reason: `rpc_preflight_failed: ${err?.message}`, run_id: runId });
	}

	// ── Cadence intent for this tick (durable counter) ─────────────────────────
	const tickSeq = await nextTickSeq(redis);
	const wantSettle = cfg.settleEveryN > 0 && (tickSeq % cfg.settleEveryN === 0) && !!RING_SETTLE_ENDPOINT;

	// ── Back-pressure pre-flight (never fire calls that will 502) ──────────────
	const ringSettlePriceAtomic = Number(priceFor('ring-settle', RING_SETTLE_DEFAULT_PRICE));
	let solLamports = Number.NaN;
	try { solLamports = await conn.getBalance(payer.publicKey); } catch { solLamports = Number.NaN; }
	// If SOL read succeeded the RPC is up, so a missing ATA means 0 USDC (not a
	// fault); only a genuine read failure leaves it NaN → rpc_balance_unavailable.
	let usdcAtomic = 0;
	try {
		const payerAta = getAssociatedTokenAddressSync(
			new PublicKey(USDC_MINT), payer.publicKey, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
		);
		usdcAtomic = Number((await getAccount(conn, payerAta)).amount);
	} catch { usdcAtomic = Number.isFinite(solLamports) ? 0 : Number.NaN; }

	// Settle-unaffordable degrades to a cheap-only tick (tips keep the ring alive);
	// SOL-floor and RPC faults still skip the whole tick — settlement is unsafe there.
	const pbp = planBackpressure({
		isSettleTick: wantSettle, solLamports, usdcAtomic,
		floorLamports: cfg.solFloorLamports, ringSettlePriceAtomic,
		artifactReserveAtomic: cfg.artifactReserveAtomic,
	});
	const bp = pbp.backpressure;
	if (!bp.ok) {
		await recordSkip(runId, origin, bp.reason, {
			detail: bp.detail, sol_lamports: Number.isFinite(solLamports) ? solLamports : null,
			usdc_atomic: Number.isFinite(usdcAtomic) ? usdcAtomic : null, min_usdc_atomic: pbp.minUsdcAtomic,
		});
		await sendOpsAlert(
			`x402 ring tick paused: ${bp.reason}`,
			`sol=${solLamports} usdc=${usdcAtomic} floor=${cfg.solFloorLamports} min_usdc=${pbp.minUsdcAtomic}`,
			{ signature: `ring-tick:${bp.reason}` },
		);
		log.warn('ring_tick_backpressure', { reason: bp.reason, detail: bp.detail });
		return json(res, 200, { ok: true, skipped: true, reason: bp.reason, run_id: runId });
	}
	if (pbp.degraded) {
		// The funding gap must stay loud even though the tick proceeds: one
		// throttled ops alert + a structured log row per degraded tick.
		await sendOpsAlert(
			'x402 ring tick degraded: settle_unaffordable',
			`ring-settle price ${ringSettlePriceAtomic} exceeds payer USDC ${usdcAtomic}; firing cheap-only ticks until the payer is funded`,
			{ signature: 'ring-tick:settle_unaffordable' },
		);
		log.warn('ring_tick_settle_unaffordable', {
			ring_settle_price_atomic: ringSettlePriceAtomic,
			usdc_atomic: Number.isFinite(usdcAtomic) ? usdcAtomic : null,
		});
	}

	// ── Runway governor: throttle this tick to the payer's funded SOL runway ──
	// Spendable SOL above the floor must last cfg.runwayDays at the governed
	// rate. Funding the payer raises the rate automatically; a draining balance
	// tapers it instead of sprinting to the floor and flat-lining the ring.
	const gov = governedCalls({
		configuredCalls: cfg.calls,
		solLamports,
		floorLamports: cfg.solFloorLamports,
		feePerCallLamports: cfg.feePerCallLamports,
		runwayDays: cfg.runwayDays,
		minCalls: cfg.minCalls,
	});
	if (gov.calls <= 0) {
		await recordSkip(runId, origin, 'runway_exhausted', {
			sol_lamports: Number.isFinite(solLamports) ? solLamports : null,
			floor_lamports: cfg.solFloorLamports,
			calls_per_day_budget: gov.callsPerDayBudget,
		});
		await sendOpsAlert(
			'x402 ring tick paused: runway_exhausted',
			`payer spendable SOL cannot sustain 1 call/min for ${cfg.runwayDays}d (sol=${solLamports}, floor=${cfg.solFloorLamports}); fund the payer to resume`,
			{ signature: 'ring-tick:runway_exhausted' },
		);
		log.warn('ring_tick_runway_exhausted', { sol_lamports: solLamports, calls_per_day_budget: gov.callsPerDayBudget });
		return json(res, 200, { ok: true, skipped: true, reason: 'runway_exhausted', run_id: runId });
	}
	if (gov.throttled) {
		log.info('ring_tick_runway_throttle', {
			configured_calls: cfg.calls, governed_calls: gov.calls,
			calls_per_day_budget: gov.callsPerDayBudget, runway_days: cfg.runwayDays,
		});
	}

	// ── Plan this tick (cursor reserved AFTER the degrade decision so the
	// reservation matches the cheap slots actually fired) ──────────────────────
	const cheapNeeded = Math.max(0, gov.calls - (pbp.settleTick ? 1 : 0));
	const cheapStart = await reserveCheapCursor(redis, cheapNeeded);
	const plan = planTick({
		tickSeq,
		calls: gov.calls,
		// Force the post-degrade decision: 1 → every tick settles, 0 → none does.
		settleEveryN: pbp.settleTick ? 1 : 0,
		cheapCount: CHEAP_ENDPOINTS.length,
		cheapStart,
	});

	// ── Daily cap ──────────────────────────────────────────────────────────────
	let dailySpent = 0;
	try { dailySpent = await ringDailySpent(); } catch (err) {
		log.warn('ring_tick_daily_query_failed', { message: err?.message });
	}
	let remaining = tickBudget(dailySpent, cfg.dailyCapAtomic, cfg.tickCapAtomic);
	if (remaining <= 0) {
		await recordSkip(runId, origin, 'ring_daily_cap_reached', {
			daily_spent_atomic: dailySpent, daily_cap_atomic: cfg.dailyCapAtomic,
		});
		log.info('ring_tick_daily_cap_reached', { spent: dailySpent, cap: cfg.dailyCapAtomic });
		return json(res, 200, {
			ok: true, skipped: true, reason: 'ring_daily_cap_reached',
			daily_spent_usdc: (dailySpent / 1e6).toFixed(4), run_id: runId,
		});
	}

	// ── Build the ordered pick list for this tick ─────────────────────────────
	const picks = [];
	if (plan.isSettleTick) picks.push(RING_SETTLE_ENDPOINT);
	for (const idx of plan.cheapIndices) picks.push(CHEAP_ENDPOINTS[idx]);

	// ── Pay each pick through the shared path ─────────────────────────────────
	// Payer pool: when enabled, each settle draws a DISTINCT least-recently-used
	// pool wallet (self-pays its own 1-sig fee, so no shared fee wallet). The seed
	// payer stays the fallback whenever the pool is empty/unavailable, so the ring
	// never stalls. Pool wallets are inside ringAllowedAddresses(), so the onAccept
	// allowlist gate and the leak scanner classify them internal.
	const usePool = ringPoolEnabled();
	const payCtx = {
		buyer: payer, conn, blockhash, mintInfo,
		...(usePool
			? { buyerFor: async () => { const c = await claimNextPayer(sql).catch(() => null); return c?.keypair || payer; } }
			: {}),
	};
	// Bounded-concurrency execution (ring-tick-exec.js): the settle carrier runs
	// alone first, then the cheap calls fan out across cfg.concurrency worker
	// lanes. Budget safety holds under concurrency because every launch reserves
	// a worst-case slice of `remaining` and passes it as that call's own
	// remainingCap — payX402 refuses any challenge above it. Mid-tick floor
	// signals stop further launches; in-flight calls drain.
	const exec = await runTickPicks({
		picks,
		remaining,
		concurrency: cfg.concurrency,
		settleFirst: plan.isSettleTick,
		ringSettlePriceAtomic,
		worstCaseCheapAtomic: CHEAP_RESERVATION_ATOMIC,
		pay: (ep, capForCall) =>
			settleAndRecord({
				sql, runId, ep, origin, remaining: capForCall, ctx: payCtx,
				pipeline: 'ring-tick', namePrefix: 'Ring', payFn: payX402, log,
			}),
		isFloorSignal,
	});
	const { results, calls, paid, errors, spent, lastTxSig, floorHit } = exec;
	if (exec.capReached) {
		log.info('ring_tick_cap_reached', { spent_atomic: spent, launched: calls, picks: picks.length });
	}

	if (floorHit) {
		await sendOpsAlert(
			'x402 ring tick paused: sponsor_sol_floor (mid-tick)',
			`fee wallet crossed the SOL floor mid-tick; stopped after ${calls} calls`,
			{ signature: 'ring-tick:sponsor_sol_floor' },
		);
		log.warn('ring_tick_floor_midtick', { run_id: runId, calls });
	}

	log.info('ring_tick_complete', {
		run_id: runId, tick_seq: tickSeq, settle_tick: plan.isSettleTick,
		degraded: pbp.degraded, calls, paid, errors, spent_usdc: (spent / 1e6).toFixed(4),
		payer: payer.publicKey.toBase58(),
	});

	return json(res, 200, {
		ok: true,
		run_id: runId,
		tick_seq: tickSeq,
		settle_tick: plan.isSettleTick,
		...(pbp.degraded ? { degraded: true, reason: 'settle_unaffordable' } : {}),
		calls,
		paid,
		errors,
		spent_usdc: (spent / 1e6).toFixed(4),
		daily_spent_usdc: ((dailySpent + spent) / 1e6).toFixed(4),
		daily_cap_usdc: (cfg.dailyCapAtomic / 1e6).toFixed(2),
		tick_cap_usdc: (cfg.tickCapAtomic / 1e6).toFixed(2),
		results,
	});
});
