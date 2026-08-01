// api/_lib/x402/wallet-fee-meter.js
//
// I/O side of the wallet fee governor (wallet-fee-governor.js holds the pure
// math). Builds the `feeMeter` hook the facilitator handler passes into
// settleRingPayment(): before co-signing/broadcasting, the settle path asks
// this meter whether the fee-paying wallet still has daily fee budget left.
//
// Scope: ONLY platform-controlled wallets (ringAllowedAddresses) are governed.
// An external organic buyer self-paying through our facilitator spends its own
// SOL — refusing its settle would be refusing revenue, so unknown wallets are
// always admitted. Every failure mode in here fails OPEN: the settle path's
// hard SOL floor remains the real protection; the meter is pacing.
//
// Spent-today reads sum `x402_self_facilitator_log.fee_lamports` per fee_payer
// (migration 20260728120000) with a short in-process cache, and each settled
// fee is debited into the cache optimistically so a burst inside one cache
// window still counts against the budget on this instance.

import { PublicKey } from '@solana/web3.js';
import { sql } from '../db.js';
import { env } from '../env.js';
import { solanaConnection } from '../solana/connection.js';
import { sendOpsAlert } from '../alerts.js';
import { ringAllowedAddresses } from './ring-allowlist.js';
import { SPONSOR_SOL_FLOOR_LAMPORTS, sponsorSolLamports } from './self-facilitator.js';
import {
	walletFeeGovernorConfig,
	walletDailyFeeBudgetLamports,
	assessWalletFeeBudget,
	pacedFeeBudgetLamports,
	utcDayElapsedFraction,
} from './wallet-fee-governor.js';

// Controlled-wallet set, cached. ringAllowedAddresses() walks env + DB + the
// signer registry; once a minute is plenty for a membership check.
const ALLOWLIST_TTL_MS = 60_000;
let _allowCache = { set: null, at: 0 };

async function governedWallets(now = Date.now()) {
	if (_allowCache.set && now - _allowCache.at < ALLOWLIST_TTL_MS) return _allowCache.set;
	try {
		const set = await ringAllowedAddresses();
		_allowCache = { set, at: now };
		return set;
	} catch {
		// Unreachable set → govern nothing this window (fail open), but keep any
		// previous set so a DB blip does not un-govern a hot wallet mid-storm.
		return _allowCache.set;
	}
}

// Per-wallet spent-today cache: pubkeyB58 → { lamports, day, at }.
const _spentCache = new Map();

function utcDay(now = Date.now()) {
	return new Date(now).toISOString().slice(0, 10);
}

async function spentTodayLamports(pubkeyB58, cacheMs, now = Date.now()) {
	const hit = _spentCache.get(pubkeyB58);
	if (hit && hit.day === utcDay(now) && now - hit.at < cacheMs) return hit.lamports;
	try {
		const rows = await sql`
			SELECT COALESCE(SUM(fee_lamports), 0)::bigint AS spent
			FROM x402_self_facilitator_log
			WHERE action = 'settle' AND ok = true
			  AND fee_payer = ${pubkeyB58}
			  AND ts >= date_trunc('day', now())
		`;
		const spent = Number(rows?.[0]?.spent ?? 0);
		_spentCache.set(pubkeyB58, { lamports: spent, day: utcDay(now), at: now });
		return spent;
	} catch {
		// Ledger unreadable (or migration not applied yet) → unknown spend.
		// assessWalletFeeBudget treats non-finite as fail-open.
		return NaN;
	}
}

// Debit the cache right after a successful settle so concurrent settles inside
// one cache window see the budget shrinking without another DB round-trip.
export function recordSettledFee(pubkeyB58, feeLamports, now = Date.now()) {
	const lamports = Number(feeLamports);
	if (!pubkeyB58 || !Number.isFinite(lamports) || lamports <= 0) return;
	const hit = _spentCache.get(pubkeyB58);
	if (hit && hit.day === utcDay(now)) hit.lamports += lamports;
}

// Test seam: drop all cached state.
export function resetWalletFeeMeterCaches() {
	_allowCache = { set: null, at: 0 };
	_spentCache.clear();
	_admissionCache.clear();
}

// ── Caller-side admission ───────────────────────────────────────────────────────
// The settle-path meter below runs at the LAST step of the x402 handshake. By the
// time it refuses, the caller has already probed the endpoint for its challenge,
// read the receiver ATA, built and signed a Solana transfer, and paid for a
// facilitator `verify`: which SIMULATES the transaction against an RPC node.
// Every one of those steps is wasted when the wallet's daily fee budget is
// already spent, because the settle is refused at the end regardless.
//
// Measured 2026-08-01: 85,264 of 90,041 daily settle attempts were refused with
// `fee_runway_exhausted`, each having already burned a simulation. That is the
// bulk of ~170k wasted RPC round-trips a day, and it is why the Solana lanes read
// 1/3 serving while the settle rate read 26%.
//
// assessFeeAdmission() answers the same question with the SAME pure math, before
// the caller spends anything, so an exhausted budget short-circuits one call
// instead of paying for a full handshake to be told no at the end. It changes no
// money: the settles it skips were never going to land. Total settled volume is
// still capped by the wallet's funded budget: this removes the waste around that
// cap, it does not raise it.
//
// Fails OPEN everywhere, exactly like the settle-path meter: an ungoverned
// wallet, an unreadable balance, or an unreadable ledger all admit. The settle
// path's meter and its hard SOL floor remain the real protection; a gate that
// refused calls it could not price would be a worse outage than the waste it
// prevents.

// A refusal is stable until a top-up or the UTC-midnight budget reset, so it may
// be cached far longer than an admission (which decays as settles land and spend
// the budget down). One minute collapses a storm while still letting a top-up
// reopen the rail promptly.
const ADMISSION_REFUSED_TTL_MS = 60_000;
const _admissionCache = new Map(); // pubkeyB58 → { ok, reason, at, day, ttl }

const ADMIT = { ok: true, reason: null };

export async function assessFeeAdmission({
	feeWalletB58, estFeeLamports = 0, connection = null, config, now = Date.now(),
} = {}) {
	const cfg = config || walletFeeGovernorConfig();
	if (!cfg.enabled || !feeWalletB58) return ADMIT;

	// Never serve a verdict across a UTC day boundary: the budget resets at
	// midnight and a stale refusal would hold the rail shut into the new day.
	const day = utcDay(now);
	const hit = _admissionCache.get(feeWalletB58);
	if (hit && hit.day === day && now - hit.at < hit.ttl) {
		return { ok: hit.ok, reason: hit.reason, cached: true };
	}

	// Only platform-controlled wallets are governed. An external buyer self-paying
	// through our facilitator spends its own SOL; refusing it would refuse revenue.
	let allowed;
	try {
		allowed = await governedWallets(now);
	} catch {
		return ADMIT;
	}
	if (!allowed || !allowed.has(feeWalletB58)) return ADMIT;

	let solLamports;
	try {
		const conn = connection || solanaConnection({ url: env.SOLANA_RPC_URL, commitment: 'confirmed' });
		// Shares self-facilitator.js's balance cache, so this adds no RPC traffic of
		// its own beyond what the settle path already reads for the same wallet.
		solLamports = await sponsorSolLamports(conn, new PublicKey(feeWalletB58), now);
	} catch {
		return ADMIT;
	}

	const spent = await spentTodayLamports(feeWalletB58, cfg.spentCacheMs, now);
	const budget = effectiveBudgetLamports(solLamports, cfg, now);
	const verdict = assessWalletFeeBudget({
		spentTodayLamports: spent,
		budgetLamports: budget,
		nextFeeLamports: estFeeLamports,
	});

	_admissionCache.set(feeWalletB58, {
		ok: verdict.ok,
		reason: verdict.reason,
		at: now,
		day,
		ttl: verdict.ok ? cfg.spentCacheMs : ADMISSION_REFUSED_TTL_MS,
	});
	return {
		ok: verdict.ok,
		reason: verdict.reason,
		budgetLamports: budget,
		spentTodayLamports: spent,
		cached: false,
	};
}

// Single source of truth for "what fee budget applies to this wallet right now".
// The caller-side admission gate and the settle-path meter MUST answer that
// question identically: a laxer admission re-creates the wasted handshakes the
// gate exists to remove, and a stricter one skips settles the rail could fund.
// Routing both through one function makes divergence impossible rather than
// merely unlikely.
//
// `daily` is what the wallet may burn across the whole UTC day. Pacing returns
// how much of that has been unlocked so far, so the allowance is spread over the
// day instead of being drainable in a morning burst. Same total per day, steadier
// rail, and no wallet gets one extra lamport out of it.
function effectiveBudgetLamports(solLamports, cfg, now = Date.now()) {
	const daily = walletDailyFeeBudgetLamports({
		solLamports,
		floorLamports: SPONSOR_SOL_FLOOR_LAMPORTS,
		runwayDays: cfg.runwayDays,
		minBudgetLamports: cfg.minBudgetLamports,
	});
	if (!cfg.paceDay) return daily;
	return pacedFeeBudgetLamports({
		budgetLamports: daily,
		dayElapsedFraction: utcDayElapsedFraction(now),
		minSliceLamports: cfg.paceMinSliceLamports,
	});
}

// Build the settle-path hook. Returns null when the governor is disabled so
// settleRingPayment skips the metering branch entirely.
export function facilitatorFeeMeter({ config } = {}) {
	const cfg = config || walletFeeGovernorConfig();
	if (!cfg.enabled) return null;
	return async ({ feeWalletB58, solLamports, estFeeLamports }) => {
		const allowed = await governedWallets();
		if (!allowed || !allowed.has(feeWalletB58)) return { ok: true, reason: null };

		const spent = await spentTodayLamports(feeWalletB58, cfg.spentCacheMs);
		const budget = effectiveBudgetLamports(solLamports, cfg);
		const verdict = assessWalletFeeBudget({
			spentTodayLamports: spent,
			budgetLamports: budget,
			nextFeeLamports: estFeeLamports,
		});
		if (!verdict.ok) {
			// One throttled alert per wallet per dedup window — the refusal itself
			// recurs every settle attempt until midnight UTC or a top-up, and that
			// is by design (governed throttle, not an outage).
			await sendOpsAlert(
				'x402 wallet fee governor throttling settles',
				`wallet ${feeWalletB58} spent ${spent} of ${budget} lamports today; `
					+ 'paced until UTC midnight or a SOL top-up. Governed throttle, not an outage — '
					+ 'see docs/x402-ring-economy.md "The wallet fee governor".',
				{ signature: `wallet-fee-governor:${feeWalletB58}`, severity: 'warn' },
			).catch(() => {});
		}
		return verdict;
	};
}
