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

import { sql } from '../db.js';
import { sendOpsAlert } from '../alerts.js';
import { ringAllowedAddresses } from './ring-allowlist.js';
import { SPONSOR_SOL_FLOOR_LAMPORTS } from './self-facilitator.js';
import {
	walletFeeGovernorConfig,
	walletDailyFeeBudgetLamports,
	assessWalletFeeBudget,
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
		const budget = walletDailyFeeBudgetLamports({
			solLamports,
			floorLamports: SPONSOR_SOL_FLOOR_LAMPORTS,
			runwayDays: cfg.runwayDays,
			minBudgetLamports: cfg.minBudgetLamports,
		});
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
