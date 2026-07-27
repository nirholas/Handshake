// api/_lib/x402/ring-tick-plan.js
//
// Pure planning + guard logic for the per-minute ring tick
// (api/cron/x402-ring-tick.js). No network, no DB, no @solana/web3.js — every
// function here is deterministic given its inputs, so the ring tick's cadence,
// cap arithmetic, back-pressure decisions, and config gating are all unit-tested
// (tests/x402-ring-tick.test.js) without touching the chain.
//
// The cron does the I/O (probe, sign, settle, log); this module decides WHAT to
// do each minute and WHETHER it is safe to do it.

// ── Config knobs ────────────────────────────────────────────────────────────────
// Read once per tick. Defaults are chosen to cohere with the stock ring-settle
// price ($1.00): the per-tick cap fits one ring-settle plus the cheap calls that
// ride alongside it, and the daily cap bounds gross throughput. See
// docs/x402-ring-economy.md "Cadence".
export function ringTickConfig(e = process.env) {
	const num = (v, d) => {
		const n = Number(v);
		return Number.isFinite(n) && n >= 0 ? n : d;
	};
	return {
		// Kill switch: default ON. Only an explicit "false" disables it (subject to
		// validateRingConfig() being clean — the cron enforces that separately).
		enabled: String(e.X402_RING_TICK_ENABLED ?? '').trim().toLowerCase() !== 'false',
		// Paid calls to attempt per minute.
		calls: Math.max(1, Math.floor(num(e.X402_RING_TICK_CALLS, 3))),
		// Fire one ring-settle every Nth tick (0 disables the settle carrier).
		settleEveryN: Math.max(0, Math.floor(num(e.X402_RING_SETTLE_EVERY_N_TICKS, 5))),
		// Spend ceiling for a single tick (atomics). Must fit a ring-settle tick:
		// ring-settle price + (calls-1) cheap calls. Default $1.10.
		tickCapAtomic: num(e.X402_RING_TICK_CAP_ATOMIC, 1_100_000),
		// Ring tick's OWN daily ceiling (atomics), summed from x402_autonomous_log
		// rows tagged pipeline='ring-tick'. Separate from the autonomous loop's
		// X402_AUTONOMOUS_DAILY_CAP_ATOMIC — the two budgets never touch. Default $50.
		// Scaling throughput up is an env change made TOGETHER with funding the
		// payer — defaults must stay affordable from the ring's real balances or
		// every tick skips on back-pressure and the ring flat-lines.
		dailyCapAtomic: num(e.X402_RING_DAILY_CAP_ATOMIC, 50_000_000),
		// Sponsor/payer SOL floor (lamports). Mirrors self-facilitator's
		// SPONSOR_SOL_FLOOR_LAMPORTS default (0.02 SOL) — below it, settlement is
		// paused, so we skip the tick rather than fire calls that will 502.
		solFloorLamports: num(e.X402_SPONSOR_SOL_FLOOR_LAMPORTS, 20_000_000),
		// Cheap calls in flight at once (ring-tick-exec.js worker lanes). The
		// settle carrier always runs alone first. 12 lanes clears ~94 calls in
		// well under the 60 s tick window at typical 1-3 s per settle; 1 restores
		// the old strictly-sequential behavior.
		concurrency: Math.max(1, Math.floor(num(e.X402_RING_TICK_CONCURRENCY, 12))),
		// Runway governor inputs. feePerCallLamports is the conservative per-call
		// fee estimate (measured 6,300-7,800 on mainnet self-pay); runwayDays is
		// how long the payer's spendable SOL must last at the governed rate. The
		// governor only ever throttles DOWN from `calls`; it never raises it.
		feePerCallLamports: Math.max(1, Math.floor(num(e.X402_RING_FEE_PER_CALL_LAMPORTS, 7_000))),
		runwayDays: Math.max(0.5, num(e.X402_RING_TARGET_RUNWAY_DAYS, 3)),
		// USDC float (atomics) the ring tick must LEAVE UNSPENT for the
		// artifact-producing pipelines (forge props, avatar rigs) that share the
		// payer. Ring-settle recirculates money in a circle and produces nothing
		// but volume; a paid forge call produces a real asset in the public
		// gallery. Without this reserve the $10 settles drain the float and every
		// $0.15 prop purchase fails verify (observed 2026-07-26: props 0/90 while
		// $0.001 health canaries still fit through at 58/72). Default $1.00 buys
		// several draft props between rebalancer sweeps.
		artifactReserveAtomic: num(e.X402_ARTIFACT_RESERVE_ATOMIC, 1_000_000),
	};
}

// ── Runway governor ─────────────────────────────────────────────────────────────
// Scale this tick's paid-call count to the SOL the payer actually holds, so the
// ring burns its fee runway over `runwayDays` instead of sprinting to the floor
// and flat-lining until the next manual funding. Spendable = balance - floor
// (the floor stays untouchable). The governed rate makes funding the throttle:
// more SOL in the payer = more calls/min, automatically, and as the balance
// drains the rate tapers instead of cliff-dying. Pure: same inputs → same
// decision. Returns { calls, callsPerDayBudget, throttled }.
export function governedCalls({
	configuredCalls, solLamports, floorLamports, feePerCallLamports, runwayDays,
}) {
	if (!Number.isFinite(solLamports)) {
		return { calls: 0, callsPerDayBudget: 0, throttled: true };
	}
	const spendable = Math.max(0, solLamports - floorLamports);
	const callsPerDayBudget = Math.floor(
		spendable / Math.max(0.5, runwayDays) / Math.max(1, feePerCallLamports),
	);
	const callsPerMin = Math.floor(callsPerDayBudget / 1440);
	const calls = Math.max(0, Math.min(configuredCalls, callsPerMin));
	return { calls, callsPerDayBudget, throttled: calls < configuredCalls };
}

// ── Cadence: which endpoints does this tick pay? ────────────────────────────────
// Weighted rotation: cheap tips/services dominate the count; every Nth tick one of
// the slots is the ring-settle carrier. `tickSeq` is a monotonic per-minute
// counter (Redis-backed in the cron, in-memory fallback), `cheapStart` is the
// reserved cheap-rotation cursor. Pure: same inputs → same plan.
//
// Returns { isSettleTick, cheapNeeded, cheapIndices } where cheapIndices index
// into the CHEAP_ENDPOINTS catalog (ring-settle excluded).
export function planTick({ tickSeq, calls, settleEveryN, cheapCount, cheapStart = 0 }) {
	const isSettleTick = settleEveryN > 0 && cheapCount >= 0
		&& Number.isFinite(tickSeq) && (tickSeq % settleEveryN === 0);
	const settleCalls = isSettleTick ? 1 : 0;
	const cheapNeeded = Math.max(0, calls - settleCalls);
	const cheapIndices = [];
	for (let i = 0; i < cheapNeeded && cheapCount > 0; i++) {
		cheapIndices.push(((cheapStart + i) % cheapCount + cheapCount) % cheapCount);
	}
	return { isSettleTick, cheapNeeded, cheapIndices };
}

// The largest single payment this tick could attempt — used to size the minimum
// payer USDC balance we require before firing (so we never start a tick we can't
// afford and trigger a settle failure). On a settle tick that is the ring-settle
// price; otherwise a small tip headroom.
export function minUsdcForTick({ isSettleTick, ringSettlePriceAtomic, tipHeadroomAtomic = 20_000 }) {
	return isSettleTick ? Math.max(ringSettlePriceAtomic, tipHeadroomAtomic) : tipHeadroomAtomic;
}

// ── Budget arithmetic ───────────────────────────────────────────────────────────
// Remaining ring-tick daily budget, and the effective cap for THIS tick (the
// smaller of the per-tick cap and what's left in the day). Never negative.
export function dailyRemaining(dailySpentAtomic, dailyCapAtomic) {
	return Math.max(0, dailyCapAtomic - dailySpentAtomic);
}
export function tickBudget(dailySpentAtomic, dailyCapAtomic, tickCapAtomic) {
	return Math.max(0, Math.min(tickCapAtomic, dailyRemaining(dailySpentAtomic, dailyCapAtomic)));
}

// ── Back-pressure ───────────────────────────────────────────────────────────────
// Decide, BEFORE paying, whether the tick is safe to run. Returns
// { ok, reason }. A false-with-reason is a clean no-op (logged + one throttled
// alert), never a retry-storm of failing settles. Order matters: RPC/context
// failure first, then SOL floor (settlement paused), then payer USDC.
export function assessBackpressure({ solLamports, usdcAtomic, floorLamports, minUsdcAtomic }) {
	if (!Number.isFinite(solLamports)) return { ok: false, reason: 'rpc_balance_unavailable' };
	if (solLamports < floorLamports) {
		return { ok: false, reason: 'sponsor_sol_floor', detail: `${solLamports}<${floorLamports}` };
	}
	if (!Number.isFinite(usdcAtomic)) return { ok: false, reason: 'rpc_balance_unavailable' };
	if (usdcAtomic < minUsdcAtomic) {
		return { ok: false, reason: 'insufficient_payer_usdc', detail: `${usdcAtomic}<${minUsdcAtomic}` };
	}
	return { ok: true, reason: null };
}

// ── Degrade: cheap-only tick when the settle is unaffordable ────────────────────
// A settle tick whose payer can't cover the ring-settle price used to skip the
// WHOLE tick — including the cheap tips/services that ride alongside it — so an
// underfunded payer flat-lined every visible ring activity until someone funded
// it. Instead: keep the hard skip for SOL-floor and RPC faults (settlement is
// genuinely unsafe there), but when the ONLY problem is that the settle price
// exceeds the payer's USDC, drop the settle carrier and re-assess as a cheap-only
// tick. The loop stays visibly alive on tips; `degraded: true` tells the caller
// to surface the funding gap (log + throttled ops alert), not hide it.
// Pure: same inputs → same decision. Returns { settleTick, backpressure, degraded,
// minUsdcAtomic } — `backpressure` is the FINAL assessment for the tick as planned.
export function planBackpressure({
	isSettleTick, solLamports, usdcAtomic, floorLamports, ringSettlePriceAtomic, tipHeadroomAtomic = 20_000,
	// Float the ring must leave for artifact-producing pipelines that share this
	// payer. Subtracted from the balance the ring is allowed to see, so a settle
	// that would eat the reserve degrades to a cheap-only tick instead of
	// starving the forge. See ringTickConfig().artifactReserveAtomic.
	artifactReserveAtomic = 0,
}) {
	const spendableUsdc = Number.isFinite(usdcAtomic)
		? Math.max(0, usdcAtomic - artifactReserveAtomic)
		: usdcAtomic;
	const minUsdc = minUsdcForTick({ isSettleTick, ringSettlePriceAtomic, tipHeadroomAtomic });
	const bp = assessBackpressure({ solLamports, usdcAtomic: spendableUsdc, floorLamports, minUsdcAtomic: minUsdc });
	if (bp.ok || !isSettleTick || bp.reason !== 'insufficient_payer_usdc') {
		return { settleTick: isSettleTick, backpressure: bp, degraded: false, minUsdcAtomic: minUsdc };
	}
	const minCheap = minUsdcForTick({ isSettleTick: false, ringSettlePriceAtomic, tipHeadroomAtomic });
	// Cheap tips are re-assessed against the SAME reserved-aside balance: the
	// artifact float is off-limits to every ring call, not just the settle.
	const cheapBp = assessBackpressure({ solLamports, usdcAtomic: spendableUsdc, floorLamports, minUsdcAtomic: minCheap });
	return { settleTick: false, backpressure: cheapBp, degraded: cheapBp.ok, minUsdcAtomic: minCheap };
}

// ── Config gate ─────────────────────────────────────────────────────────────────
// validateRingConfig() returns findings [{ code, severity, message, fix }].
// The tick runs only when there are no ERROR-severity findings — those mean
// settlement would route to a third party or can't be built at all, which is the
// one thing the ring must never do. WARN findings (sponsor mode, missing
// rebalancer) degrade economics but still settle in-house, so they are logged,
// not blocking. Returns { blocked, errors, warnings }.
export function gateOnRingConfig(findings = []) {
	const errors = findings.filter((f) => f?.severity === 'error');
	const warnings = findings.filter((f) => f?.severity !== 'error');
	return { blocked: errors.length > 0, errors, warnings };
}
