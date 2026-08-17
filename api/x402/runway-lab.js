// GET /api/x402/runway-lab
//
// The live seed for /economy-lab: everything the settle path's admission
// control depends on, read from the systems that actually enforce it.
//
// Nothing here is modelled or estimated where a real reading exists:
//
//   • fee wallet + hard floor  → ring-allowlist.js ringRoleWallets() and
//                                self-facilitator.js SPONSOR_SOL_FLOOR_LAMPORTS,
//                                the same constants the settle path enforces.
//   • live SOL balance         → Solana RPC through the platform's lane-failover
//                                connection, not a cached number.
//   • governor config          → wallet-fee-governor.js walletFeeGovernorConfig()
//                                over the running process env, so the lab shows
//                                what THIS deploy is configured with.
//   • spent today              → x402_self_facilitator_log, the exact SUM the
//                                meter itself runs (wallet-fee-meter.js).
//   • fee per settle + demand  → observed from the same log over 24h, so the
//                                projection starts from measured behaviour
//                                rather than a guessed arrival rate.
//   • refusal mix              → reject_reason histogram, bucketed by cause, so
//                                the page can show what the rail is ACTUALLY
//                                refusing next to what the model predicts.
//
// Read-only and unauthenticated by design: every field is already public
// through /api/x402-ring and /api/x402-status (balances of platform wallets,
// config thresholds, aggregate settle counts). No secret, no key material, and
// no per-user data is reachable from here.

import { cors, json, method, wrap } from '../_lib/http.js';
import { sql, isDbUnavailableError } from '../_lib/db.js';
import { PublicKey } from '@solana/web3.js';
import { solanaConnection } from '../_lib/solana/connection.js';
import { ringRoleWallets } from '../_lib/x402/ring-allowlist.js';
import { SPONSOR_SOL_FLOOR_LAMPORTS, SELF_FACILITATOR_ENABLED } from '../_lib/x402/self-facilitator.js';
import { walletFeeGovernorConfig } from '../_lib/x402/wallet-fee-governor.js';
import {
	MIN_FEE_LAMPORTS,
	LAMPORTS_PER_SOL,
	equilibriumSettlesPerDay,
} from '../_lib/x402/runway-sim.js';

const WINDOW_HOURS = 24;

// Map a raw reject_reason to the cause an operator can act on. The reasons are
// prefixed strings with lamport detail appended (`fee_runway_exhausted:12+5>10`),
// so bucket on the prefix and keep one verbatim example per bucket.
function bucketReason(reason) {
	const r = String(reason || '');
	if (r.startsWith('fee_runway_exhausted')) return 'governor';
	if (r.startsWith('fee_wallet_below_floor')) return 'floor';
	if (r.startsWith('insufficient_lamports_for_fee')) return 'floor';
	if (r.startsWith('amount_below_min_settle')) return 'dust_guard';
	// Idempotency, not scarcity: the payment already landed and a retry hit the
	// unique-signature guard (migration 20260729000000). Counted separately
	// because folding it into the refusal total makes a healthy rail read as a
	// starved one — on 2026-07-31 it was 3,470 of 9,504 "refusals".
	if (r.startsWith('signature_already_settled')) return 'duplicate';
	if (!r) return 'unspecified';
	return 'other';
}

// Which buckets mean "the rail could not afford this settle". Duplicates and the
// dust guard are working-as-intended rejections, so the capacity view must not
// count them against admission.
const CAPACITY_CAUSES = new Set(['governor', 'floor']);

// Live SOL for one pubkey. A null result means "not read", never "zero" — the
// page must not draw a starvation conclusion from an RPC failure.
async function solLamportsOf(address) {
	if (!address) return null;
	try {
		const connection = solanaConnection('mainnet');
		return await connection.getBalance(new PublicKey(address), 'confirmed');
	} catch {
		return null;
	}
}

// The meter's own query, verbatim in intent: today's summed fee burn for the
// fee wallet over successful settles.
async function spentTodayLamports(feeWallet) {
	if (!feeWallet) return null;
	const rows = await sql`
		SELECT COALESCE(SUM(fee_lamports), 0)::bigint AS spent
		FROM x402_self_facilitator_log
		WHERE action = 'settle' AND ok = true
		  AND fee_payer = ${feeWallet}
		  AND ts >= date_trunc('day', now() at time zone 'utc')
	`;
	return Number(rows?.[0]?.spent ?? 0);
}

// Observed behaviour over the window: how often settles are attempted, how many
// land, what a landed settle costs, and why the rest were refused.
async function observeWindow() {
	const since = new Date(Date.now() - WINDOW_HOURS * 3600_000).toISOString();

	const [totals] = await sql`
		SELECT
			COUNT(*)::int                                              AS attempts,
			COUNT(*) FILTER (WHERE ok)::int                            AS settled,
			COALESCE(SUM(fee_lamports) FILTER (WHERE ok), 0)::bigint   AS fee_total,
			COALESCE(
				PERCENTILE_DISC(0.5) WITHIN GROUP (ORDER BY fee_lamports)
					FILTER (WHERE ok AND fee_lamports > 0), 0)::bigint     AS fee_median
		FROM x402_self_facilitator_log
		WHERE action = 'settle' AND ts >= ${since}
	`;

	const reasons = await sql`
		SELECT reject_reason, COUNT(*)::int AS n
		FROM x402_self_facilitator_log
		WHERE action = 'settle' AND ok = false AND ts >= ${since}
		GROUP BY reject_reason
		ORDER BY n DESC
		LIMIT 40
	`;

	const buckets = new Map();
	for (const row of reasons) {
		const key = bucketReason(row.reject_reason);
		const hit = buckets.get(key) || { cause: key, count: 0, example: null };
		hit.count += Number(row.n) || 0;
		if (!hit.example) hit.example = row.reject_reason || null;
		buckets.set(key, hit);
	}

	const attempts = Number(totals?.attempts ?? 0);
	const settled = Number(totals?.settled ?? 0);
	const feeMedian = Number(totals?.fee_median ?? 0);
	const refusalList = [...buckets.values()].sort((a, b) => b.count - a.count);
	// Capacity refusals only: what the rail could not AFFORD, as opposed to what
	// it correctly declined. This is the number the projection is comparable to.
	const capacityRefused = refusalList
		.filter((b) => CAPACITY_CAUSES.has(b.cause))
		.reduce((n, b) => n + b.count, 0);
	const capacityAttempts = settled + capacityRefused;

	return {
		window_hours: WINDOW_HOURS,
		attempts,
		settled,
		refused: attempts - settled,
		capacity_refused: capacityRefused,
		// Share of settles the rail could afford, excluding duplicates and the
		// dust guard. Compare THIS against the simulated admission rate.
		capacity_admission_rate: capacityAttempts > 0 ? settled / capacityAttempts : null,
		admission_rate: attempts > 0 ? settled / attempts : null,
		fee_total_lamports: Number(totals?.fee_total ?? 0),
		// Median over landed settles is the honest per-settle cost: the mean is
		// dragged by the occasional multi-signature transaction.
		fee_lamports_observed: feeMedian > 0 ? feeMedian : MIN_FEE_LAMPORTS,
		fee_source: feeMedian > 0 ? 'observed_median_24h' : 'base_fee_default',
		// Real arrival rate, so the projection starts from measured demand rather
		// than a guess. Duplicates are excluded: they are retries of a settle that
		// already landed, not new demand on the rail.
		//
		// A rail that took fewer than 12 settles in 24 hours still took traffic, so
		// the rate is clamped to 1 rather than rounded to 0. Reporting zero demand
		// for a live-but-quiet rail is not a rounding artefact the caller can
		// recover from: it reads as "nobody is paying", which is a different
		// diagnosis entirely.
		demand_per_hour: capacityAttempts > 0
			? Math.max(1, Math.round(capacityAttempts / WINDOW_HOURS))
			: 0,
		refusals: refusalList,
	};
}

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS' })) return;
	if (!method(req, res, ['GET'])) return;

	const roles = await ringRoleWallets();
	// The wallet the governor actually meters is whichever one pays the fee. In
	// sponsor mode that is the sponsor; the payer only pays its own fee when
	// X402_RING_SELF_PAY is on, and the sponsor is still the shared-tenant wallet
	// the starvation math is about.
	const feeWallet = roles.sponsor || roles.payer || null;
	const cfg = walletFeeGovernorConfig();

	const [sponsorLamports, payerLamports] = await Promise.all([
		solLamportsOf(feeWallet),
		roles.payer && roles.payer !== feeWallet ? solLamportsOf(roles.payer) : Promise.resolve(null),
	]);

	let spent_today_lamports = null;
	let observed = null;
	let db_error = null;
	try {
		[spent_today_lamports, observed] = await Promise.all([
			spentTodayLamports(feeWallet),
			observeWindow(),
		]);
	} catch (err) {
		// A DB outage must not blank the page: the config and the live balance are
		// still enough to seed a projection, and the page says what is missing.
		db_error = isDbUnavailableError(err) ? 'database_unavailable' : 'ledger_read_failed';
	}

	const spendable =
		sponsorLamports != null ? Math.max(0, sponsorLamports - SPONSOR_SOL_FLOOR_LAMPORTS) : null;

	json(res, 200, {
		ok: true,
		generated_at: new Date().toISOString(),
		self_facilitator_enabled: SELF_FACILITATOR_ENABLED,
		fee_wallet: {
			role: roles.sponsor ? 'sponsor' : roles.payer ? 'payer' : null,
			address: feeWallet,
			sol_lamports: sponsorLamports,
			sol: sponsorLamports != null ? sponsorLamports / LAMPORTS_PER_SOL : null,
			spendable_lamports: spendable,
			balance_read: sponsorLamports != null,
		},
		payer_wallet: roles.payer && roles.payer !== feeWallet
			? { address: roles.payer, sol_lamports: payerLamports }
			: null,
		treasury: roles.treasury || null,
		config: {
			// The exact env names the lab emits a change command for.
			floor_lamports: SPONSOR_SOL_FLOOR_LAMPORTS,          // X402_SPONSOR_SOL_FLOOR_LAMPORTS
			runway_days: cfg.runwayDays,                          // X402_WALLET_FEE_RUNWAY_DAYS
			min_budget_lamports: cfg.minBudgetLamports,           // X402_WALLET_FEE_MIN_BUDGET_LAMPORTS
			governor_enabled: cfg.enabled,                        // X402_WALLET_FEE_GOVERNOR_ENABLED
			spent_cache_ms: cfg.spentCacheMs,
		},
		meter: {
			spent_today_lamports,
			utc_hour: new Date().getUTCHours(),
		},
		// The closed-form throughput this configuration delivers at the live
		// balance, so the headline number is available even before the browser
		// runs a projection.
		projected_settles_per_day:
			spendable != null
				? equilibriumSettlesPerDay({
					spendableLamports: spendable,
					feeLamports: observed?.fee_lamports_observed ?? MIN_FEE_LAMPORTS,
					runwayDays: cfg.runwayDays,
					minBudgetLamports: cfg.enabled ? cfg.minBudgetLamports : Number.MAX_SAFE_INTEGER,
				})
				: null,
		observed,
		db_error,
	}, { 'Cache-Control': 'public, max-age=20, s-maxage=20' });
});
