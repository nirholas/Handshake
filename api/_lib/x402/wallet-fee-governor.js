// api/_lib/x402/wallet-fee-governor.js
//
// Pure decision logic for the WALLET-level fee governor — the shared-wallet
// counterpart of the ring tick's governedCalls() (ring-tick-plan.js).
//
// Why this exists: governedCalls() throttles the ring tick, but the fee-paying
// wallets are shared by roughly a dozen other paid pipelines (health, volume,
// oracle, sniper, datapoint, 3d, ring-agents, …) that spend ungoverned.
// Measured 2026-07-27: in one 20-minute window the ring tick was throttled to
// 2 paid calls while co-tenant pipelines completed ~200 through the same
// wallet. A governor that throttles one tenant while others drain the same
// runway protects nothing under real scarcity — it just decides WHICH pipeline
// gets starved.
//
// This module meters the WALLET instead: every settle that a given wallet pays
// the SOL fee for — regardless of which pipeline initiated it — draws from one
// daily fee budget derived from that wallet's live spendable SOL. Enforcement
// happens at the one choke point every platform payment passes through, the
// self-hosted facilitator's settle path (self-facilitator.js `feeMeter` hook,
// wired by api/x402-facilitator/[action].js via wallet-fee-meter.js). That also
// answers the "watch the wallet that actually pays" gap: the metered wallet is
// the transaction's real fee payer (decoded.feePayer), so sponsor-mode settles
// debit the sponsor's budget and self-pay settles debit the payer's.
//
// No network, no DB — every function is deterministic given its inputs
// (tests/x402-wallet-fee-governor.test.js). The I/O (spent-today ledger read,
// controlled-wallet scoping, caching) lives in wallet-fee-meter.js.

// ── Config knobs ────────────────────────────────────────────────────────────────
export function walletFeeGovernorConfig(e = process.env) {
	const num = (v, d) => {
		const n = Number(v);
		return Number.isFinite(n) && n >= 0 ? n : d;
	};
	return {
		// Kill switch: default ON. Only an explicit "false" disables the meter.
		enabled: String(e.X402_WALLET_FEE_GOVERNOR_ENABLED ?? '').trim().toLowerCase() !== 'false',
		// How long the wallet's spendable SOL must last at the governed burn rate.
		// Mirrors the ring tick's X402_RING_TARGET_RUNWAY_DAYS default.
		runwayDays: Math.max(0.5, num(e.X402_WALLET_FEE_RUNWAY_DAYS, 3)),
		// Heartbeat floor: the daily fee budget never drops below this, so the
		// economy keeps a minimum pulse while the wallet is above its hard SOL
		// floor. Same rationale as the ring heartbeat (X402_RING_MIN_CALLS): the
		// hard floor is the real protection, and a wallet that does nothing cannot
		// restart the economy from its own balances. Default 0.01 SOL/day ≈ ~2,000
		// self-pay settles.
		minBudgetLamports: Math.floor(num(e.X402_WALLET_FEE_MIN_BUDGET_LAMPORTS, 10_000_000)),
		// How long wallet-fee-meter.js may serve a cached spent-today read before
		// re-summing the facilitator log. Bounds multi-instance undercount to one
		// cache window of settles per instance.
		spentCacheMs: Math.max(1_000, Math.floor(num(e.X402_WALLET_FEE_SPENT_CACHE_MS, 20_000))),
	};
}

// ── Daily budget ────────────────────────────────────────────────────────────────
// The lamports of fee burn this wallet may spend per UTC day: its spendable SOL
// (balance minus the untouchable floor) spread over `runwayDays`, never below
// the heartbeat floor. Funding IS the throttle: top the wallet up and every
// tenant speeds up together; let it drain and they all taper together instead
// of racing each other to the floor.
export function walletDailyFeeBudgetLamports({
	solLamports, floorLamports, runwayDays, minBudgetLamports = 0,
}) {
	if (!Number.isFinite(solLamports)) return 0;
	const spendable = Math.max(0, solLamports - Math.max(0, floorLamports || 0));
	const runwayBudget = Math.floor(spendable / Math.max(0.5, runwayDays));
	return Math.max(Math.max(0, Math.floor(minBudgetLamports)), runwayBudget);
}

// ── Admission decision ──────────────────────────────────────────────────────────
// Admit the next settle only if its estimated fee still fits in today's budget.
// An unknown spend (ledger unreadable) fails OPEN — the SOL floor in the settle
// path remains the hard protection; the meter is pacing, not the last line of
// defense. Pure: same inputs → same verdict.
export function assessWalletFeeBudget({ spentTodayLamports, budgetLamports, nextFeeLamports = 0 }) {
	if (!Number.isFinite(spentTodayLamports)) return { ok: true, reason: null };
	const next = Math.max(0, Number(nextFeeLamports) || 0);
	if (spentTodayLamports + next > budgetLamports) {
		return {
			ok: false,
			reason: `fee_runway_exhausted:${spentTodayLamports}+${next}>${budgetLamports}`,
		};
	}
	return { ok: true, reason: null };
}
