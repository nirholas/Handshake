import { describe, it, expect } from 'vitest';
import {
	isRailFault,
	classifySettleBuckets,
} from '../../api/_lib/ops/x402-settle-health.js';

// The sensor that would have caught the 2026-07 502 wave on day one. The bucket
// shapes here are the real `x402_autonomous_log` aggregation observed in prod
// (GROUP BY success, amount>0 AS paid, first `:`-token of error_msg).

describe('isRailFault — only payment-rail faults count against the settle rate', () => {
	it('counts facilitator/settle 5xx and payment-rejected 402', () => {
		for (const r of ['http_500', 'http_502', 'http_503', 'http_504', 'http_402']) {
			expect(isRailFault(r)).toBe(true);
		}
	});

	it('counts RPC / broadcast / confirm / simulation / timeout signatures', () => {
		for (const r of [
			'broadcast_failed', 'settle_failed', 'not_confirmed', 'rpc_preflight_failed',
			'insufficient_source', 'This operation was aborted',
		]) {
			expect(isRailFault(r)).toBe(true);
		}
	});

	it('does NOT count caller/endpoint errors — these are not settle failures', () => {
		// The ring POSTing to a GET-only endpoint or passing rejected args. ~800/6h
		// in prod; counting them would peg the sensor red and bury real regressions.
		for (const r of ['http_400', 'http_404', 'http_405', 'http_409']) {
			expect(isRailFault(r)).toBe(false);
		}
	});

	it('does NOT count benign guards or downstream notes', () => {
		for (const r of [
			'cap_would_exceed', 'insufficient_payer_usdc', 'wallet_unconfigured',
			'breaker_tripped', 'config_missing', 'sniper_intel_calls_failed', 'none', '',
		]) {
			expect(isRailFault(r)).toBe(false);
		}
	});

	it('classifies the fix\'s own precise error format (broadcast_failed:already_processed:sig)', () => {
		// gatherX402SettleHealth splits on ':' → first token 'broadcast_failed'.
		expect(isRailFault('broadcast_failed')).toBe(true);
	});
});

describe('classifySettleBuckets — verdict from real bucket shapes', () => {
	// The live 3h window during the 502 wave: 344 settled, 121 http_502 + 7 http_402
	// rail faults, plus noise that must be excluded.
	const liveOutageBuckets = [
		{ success: true, paid: true, reason: 'none', n: 344 },
		{ success: false, paid: true, reason: 'http_502', n: 100 },
		{ success: false, paid: false, reason: 'http_502', n: 21 },
		{ success: false, paid: false, reason: 'http_402', n: 7 },
		// Excluded noise:
		{ success: false, paid: true, reason: 'http_400', n: 260 },
		{ success: false, paid: true, reason: 'http_405', n: 190 },
		{ success: false, paid: false, reason: 'cap_would_exceed', n: 52 },
		{ success: false, paid: false, reason: 'insufficient_payer_usdc', n: 39 },
		{ success: true, paid: false, reason: 'none', n: 93 }, // free/ok calls
	];

	it('reads the live 502 wave as DEGRADED with http_502 as the top fault', () => {
		const v = classifySettleBuckets(liveOutageBuckets);
		expect(v.status).toBe('degraded');
		expect(v.settled).toBe(344);
		expect(v.faults).toBe(128); // 100 + 21 + 7 — client errors and guards excluded
		expect(v.attempts).toBe(472);
		expect(v.rate).toBeCloseTo(0.729, 2);
		expect(v.faultClasses[0]).toEqual({ reason: 'http_502', n: 121 });
		expect(v.detail).toMatch(/http_502×121/);
		expect(v.hint).toMatch(/settle_failed/);
	});

	it('a clean rail reads OK — successes only, no rail faults', () => {
		const v = classifySettleBuckets([
			{ success: true, paid: true, reason: 'none', n: 400 },
			{ success: false, paid: false, reason: 'cap_would_exceed', n: 30 },
			{ success: false, paid: true, reason: 'http_405', n: 50 }, // caller error, excluded
		]);
		expect(v.status).toBe('ok');
		expect(v.rate).toBe(1);
		expect(v.faults).toBe(0);
	});

	it('a rail collapse (<50% settling) reads DOWN', () => {
		const v = classifySettleBuckets([
			{ success: true, paid: true, reason: 'none', n: 30 },
			{ success: false, paid: true, reason: 'http_502', n: 80 },
		]);
		expect(v.status).toBe('down');
		expect(v.rate).toBeCloseTo(0.273, 2);
	});

	it('too few attempts reads UNKNOWN and never pages', () => {
		const v = classifySettleBuckets([
			{ success: true, paid: true, reason: 'none', n: 5 },
			{ success: false, paid: true, reason: 'http_502', n: 3 },
		]);
		expect(v.status).toBe('unknown');
		expect(v.rate).toBeNull();
		expect(v.detail).toMatch(/too few to judge/);
	});

	it('an idle window (all guards, nothing settled) is UNKNOWN, not an outage', () => {
		// The exact quiet-hour shape: ring low on USDC, choosing not to pay.
		const v = classifySettleBuckets([
			{ success: false, paid: false, reason: 'insufficient_payer_usdc', n: 15 },
			{ success: false, paid: false, reason: 'cap_would_exceed', n: 21 },
			{ success: true, paid: false, reason: 'none', n: 12 },
		]);
		expect(v.status).toBe('unknown');
		expect(v.attempts).toBe(0);
	});

	it('empty / malformed input is UNKNOWN, never a throw', () => {
		expect(classifySettleBuckets([]).status).toBe('unknown');
		expect(classifySettleBuckets(null).status).toBe('unknown');
		expect(classifySettleBuckets(undefined).status).toBe('unknown');
	});

	// The 2026-07-29 outage. Rail faults sat at their normal level all day while
	// settlements fell 750/h → 25/h, because the sponsor dropped under its SOL
	// floor and buildRequirements() withdrew the Solana accept from every
	// challenge. The rate alone reads identically to a facilitator rejection, and
	// the old hint sent an operator to the facilitator, where the 503s look flat
	// and nothing explains the drop.
	const acceptWithdrawnBuckets = [
		{ success: true, paid: true, reason: 'none', n: 87 },
		{ success: false, paid: false, reason: 'http_503', n: 154 },
		{ success: false, paid: false, reason: 'http_402', n: 133 },
		{ success: false, paid: false, reason: 'rpc_error', n: 12 },
		{ success: false, paid: false, reason: 'This operation was aborted', n: 8 },
		// The mechanism, which the rate deliberately does not count:
		{ success: false, paid: false, reason: 'no_solana_accept', n: 1059 },
		{ success: false, paid: false, reason: 'settlement temporarily unavailable', n: 26 },
		// Excluded noise, same as any window:
		{ success: false, paid: false, reason: 'datapoint_sweep_calls_failed', n: 24 },
		{ success: false, paid: false, reason: 'cap_would_exceed', n: 8 },
	];

	it('blames the sponsor floor, not the facilitator, when the Solana accept is withdrawn', () => {
		const v = classifySettleBuckets(acceptWithdrawnBuckets);
		expect(v.status).toBe('down');
		expect(v.cause).toBe('sponsor_floor');
		expect(v.noSolanaAccept).toBe(1059);
		expect(v.floorSignals).toBe(26);
		// The rate itself is unchanged: no_solana_accept and the 503-prose floor
		// refusals must not become rail faults, or the percentage stops meaning
		// "of the settles we attempted, how many landed".
		expect(v.settled).toBe(87);
		expect(v.faults).toBe(307);
		expect(v.detail).toMatch(/Solana accept withdrawn \(1059 no_solana_accept/);
		expect(v.hint).toMatch(/WITHDRAWN, not rejected/);
		expect(v.hint).toMatch(/treasury-topup/);
		// And it must NOT send the operator down the facilitator path.
		expect(v.hint).not.toMatch(/Payments are being rejected at settle/);
	});

	it('the sponsor-floor hint refuses to promise a self-heal that sealed wallets cannot deliver', () => {
		// The hint used to end at "Owner SOL is needed only when every reclaim
		// source reports at_or_below_floor". On this platform most of the
		// reclaimable SOL sits in wallets encrypted under a key retired in the
		// 2026-07 host migration: they report `secret_undecryptable`, never
		// `at_or_below_floor`, so that sentence read as "the cron will fix it" for
		// a condition no cron can fix. Two sessions lost time to it.
		const v = classifySettleBuckets([
			{ success: true, paid: true, reason: 'none', n: 40 },
			{ success: false, paid: false, reason: 'http_502', n: 60 },
			{ success: false, paid: false, reason: 'fee_wallet_below_floor', n: 1 },
		]);
		expect(v.cause).toBe('sponsor_floor');
		expect(v.hint).toMatch(/secret_undecryptable/);
		expect(v.hint).toMatch(/agent_reclaim\.failed/);
		expect(v.hint).toMatch(/WALLET_ENCRYPTION_KEY/);
		// "only when ... at_or_below_floor" was the exact false promise. It must
		// not come back.
		expect(v.hint).not.toMatch(/only when every reclaim source reports at_or_below_floor\./);
	});

	it('still blames the rail when faults rose and Solana is payable', () => {
		const v = classifySettleBuckets(liveOutageBuckets);
		expect(v.cause).toBe('rail');
		expect(v.noSolanaAccept).toBe(0);
		expect(v.floorSignals).toBe(0);
		expect(v.hint).toMatch(/Payments are being rejected at settle/);
		expect(v.detail).not.toMatch(/withdrawn/i);
	});

	it('a single floor refusal is enough to name the cause, even under heavy rail noise', () => {
		// The flapping case: sponsorKnownBelowFloor() is cache-backed and fail-open,
		// so some settles still land and no_solana_accept can be lower than settled.
		// One 503-prose floor refusal is still proof of what is happening.
		const v = classifySettleBuckets([
			{ success: true, paid: true, reason: 'none', n: 40 },
			{ success: false, paid: false, reason: 'http_502', n: 60 },
			{ success: false, paid: false, reason: 'no_solana_accept', n: 3 },
			{ success: false, paid: false, reason: 'fee_wallet_below_floor', n: 1 },
		]);
		expect(v.cause).toBe('sponsor_floor');
		expect(v.floorSignals).toBe(1);
	});

	it('no_solana_accept below the settled count alone does not cry sponsor floor', () => {
		// A handful of third-party endpoints that only advertise Base is normal and
		// is genuinely the ring choosing not to pay. Do not hijack the diagnosis.
		const v = classifySettleBuckets([
			{ success: true, paid: true, reason: 'none', n: 60 },
			{ success: false, paid: false, reason: 'http_502', n: 40 },
			{ success: false, paid: false, reason: 'no_solana_accept', n: 5 },
		]);
		expect(v.cause).toBe('rail');
		expect(v.noSolanaAccept).toBe(5);
	});

	it('boundary: exactly 90% is OK, just under is DEGRADED', () => {
		const ok = classifySettleBuckets([
			{ success: true, paid: true, reason: 'none', n: 90 },
			{ success: false, paid: true, reason: 'http_502', n: 10 },
		]);
		expect(ok.status).toBe('ok');
		const degraded = classifySettleBuckets([
			{ success: true, paid: true, reason: 'none', n: 89 },
			{ success: false, paid: true, reason: 'http_502', n: 11 },
		]);
		expect(degraded.status).toBe('degraded');
	});
});

// ── The 2026-08-01 fee_runway_exhausted wave ────────────────────────────────
// The shape: the wallet fee governor spends the fee wallet's daily SOL budget,
// then refuses every remaining settle of the day. Measured on production that
// morning: 85,265 governed refusals against 562 rail-shaped failures, a settle
// rate of 25.9%, and a `rail` verdict whose hint sent the reader to the
// facilitator to debug duplicate signatures. The money answer (fund the fee
// wallet) was nowhere in the output.
//
// Both regimes below are the SAME condition and want the SAME action, so both
// must name it. Before the caller-side admission check the refusal came back as
// an http_502 and inflated the fault count; after it, the ring skips the call
// and the counts collapse toward zero instead. A sensor that only understood the
// first regime would go quiet exactly when the fix landed.
describe('classifySettleBuckets: a governed throttle is not a rail fault', () => {
	it('names the fee governor when its skips outnumber the rail faults', () => {
		const v = classifySettleBuckets([
			{ success: true, paid: true, reason: 'none', n: 60 },
			{ success: false, paid: false, reason: 'fee_runway_exhausted', n: 900 },
			{ success: false, paid: true, reason: 'http_502', n: 40 },
		]);
		expect(v.cause).toBe('fee_governor');
		expect(v.governorSkips).toBe(900);
		// The skips stay out of the rate: they are not attempts that failed, they
		// are calls we chose not to make.
		expect(v.settled).toBe(60);
		expect(v.faults).toBe(40);
		expect(v.detail).toMatch(/900 call\(s\) paced by the fee governor/);
		expect(v.hint).toMatch(/GOVERNED THROTTLE/);
		expect(v.hint).toMatch(/runway-lab/);
		// It must not send anyone at the facilitator or at the sponsor floor knob.
		expect(v.hint).not.toMatch(/Payments are being rejected at settle/);
		expect(v.hint).toMatch(/do NOT lower the sponsor floor/i);
	});

	it('reports DEGRADED, not UNKNOWN, when pacing is why there is nothing to judge', () => {
		// The post-fix regime: the caller-side admission check skips the calls, so
		// attempts fall under MIN_ATTEMPTS. `unknown` here would hide a rail that
		// is 100% paced shut behind the same verdict a sleeping ring gets.
		const v = classifySettleBuckets([
			{ success: true, paid: true, reason: 'none', n: 4 },
			{ success: false, paid: false, reason: 'fee_runway_exhausted', n: 1200 },
		]);
		expect(v.status).toBe('degraded');
		expect(v.cause).toBe('fee_governor');
		expect(v.rate).toBeNull();
		expect(v.detail).toMatch(/1200 call\(s\) skipped by the wallet fee governor/);
	});

	it('a genuinely idle ring still reads UNKNOWN, a few skips are the governor working', () => {
		const v = classifySettleBuckets([
			{ success: true, paid: true, reason: 'none', n: 3 },
			{ success: false, paid: false, reason: 'fee_runway_exhausted', n: 6 },
		]);
		expect(v.status).toBe('unknown');
		expect(v.governorSkips).toBe(6);
	});

	it('the hard SOL floor outranks the governor when both are lit', () => {
		// Both want SOL in the same wallet, but under the floor every settle fails
		// closed while a spent budget still settles at the paced rate. Report the
		// harder stop.
		const v = classifySettleBuckets([
			{ success: true, paid: true, reason: 'none', n: 20 },
			{ success: false, paid: false, reason: 'http_502', n: 40 },
			{ success: false, paid: false, reason: 'fee_wallet_below_floor', n: 2 },
			{ success: false, paid: false, reason: 'fee_runway_exhausted', n: 500 },
		]);
		expect(v.cause).toBe('sponsor_floor');
		expect(v.governorSkips).toBe(500);
	});

	it('pacing under a healthy rate stays OK and still reports the skip count', () => {
		// The steady state this fix is aiming for: a small, funded budget paced
		// across the day, everything it admits settling cleanly.
		const v = classifySettleBuckets([
			{ success: true, paid: true, reason: 'none', n: 248 },
			{ success: false, paid: true, reason: 'http_502', n: 6 },
			{ success: false, paid: false, reason: 'fee_runway_exhausted', n: 3100 },
		]);
		expect(v.status).toBe('ok');
		expect(v.rate).toBeGreaterThan(0.9);
		expect(v.governorSkips).toBe(3100);
		expect(v.detail).toMatch(/3100 paced by the fee governor/);
	});

	it('the governor reason is never counted as a rail fault, in any variant', () => {
		// pay.js records the reason with its arithmetic appended; the SQL bucket
		// splits on ':' so the sensor sees the bare token. Cover both.
		expect(isRailFault('fee_runway_exhausted')).toBe(false);
		expect(isRailFault('fee_runway_exhausted:10022298+10000>10000000')).toBe(false);
	});
});

// The ring log is reason-blind for refusals that arrive over HTTP: a settle the
// governor refused reaches x402_autonomous_log as a bare http_503 (pre
// 2026-08-06: http_502) and used to read as a rail fault. On 2026-08-05
// production this showed `cause: "rail"` at settle 26.1% while the facilitator
// book held 75k+ fee_runway_exhausted rejects: the operator was sent to debug
// a healthy rail. `facilitatorRejects` carries that book into the classifier.
describe('classifySettleBuckets: facilitator-book reconciliation of status-only faults', () => {
	// The live 2026-08-05 shape, scaled: settles landing, a 502/503 wall, and the
	// facilitator book attributing nearly all of it to the governor.
	const reasonBlindOutage = [
		{ success: true, paid: true, reason: 'none', n: 443 },
		{ success: false, paid: true, reason: 'http_502', n: 1172 },
		{ success: false, paid: true, reason: 'http_503', n: 24 },
		{ success: false, paid: true, reason: 'settle_failed', n: 29 },
	];

	it('re-attributes governor-refused 5xx rows so the rate judges the rail alone', () => {
		const v = classifySettleBuckets(reasonBlindOutage, {
			facilitatorRejects: { governor: 1180 },
		});
		// 503 drains first, then 502: 24 + 1156 attributed, 16 http_502 + 29
		// settle_failed remain genuine rail faults.
		expect(v.governorSkips).toBe(1180);
		expect(v.faults).toBe(45);
		// The rate now judges the rail alone (443/488, not 443/1668), and per the
		// established pacing semantics a healthy residual rail reads OK with the
		// governed volume named in the detail, instead of yesterday's down/rail.
		expect(v.rate).toBeGreaterThan(0.9);
		expect(v.status).toBe('ok');
		expect(v.detail).toMatch(/1180 paced by the fee governor/);
	});

	it('clamps attribution at the observed status faults, never inventing negatives', () => {
		// Window skew between the two logs can put more rejects in the book than
		// 5xx rows in the ring log. min() caps the drain; faults never go below the
		// non-status rail signatures.
		const v = classifySettleBuckets(reasonBlindOutage, {
			facilitatorRejects: { governor: 50_000, floor: 10_000 },
		});
		expect(v.faults).toBe(29);
		expect(v.governorSkips).toBe(1196);
		expect(v.floorSignals).toBe(0);
		expect(v.faultClasses).toEqual([{ reason: 'settle_failed', n: 29 }]);
	});

	it('floor rejects drain what the governor left and outrank it in the verdict', () => {
		const v = classifySettleBuckets(reasonBlindOutage, {
			facilitatorRejects: { governor: 1000, floor: 150 },
		});
		// governor drains 24 http_503 + 976 http_502; floor drains 150 more 502s.
		expect(v.governorSkips).toBe(1000);
		expect(v.floorSignals).toBe(150);
		expect(v.faults).toBe(75);
		expect(v.cause).toBe('sponsor_floor');
	});

	it('a genuine rail outage with an empty facilitator book still blames the rail', () => {
		const v = classifySettleBuckets(reasonBlindOutage, { facilitatorRejects: { governor: 0, floor: 0 } });
		expect(v.cause).toBe('rail');
		expect(v.faults).toBe(1225);
		expect(v.status).toBe('down');
	});

	it('omitting facilitatorRejects behaves exactly as before', () => {
		const withOpt = classifySettleBuckets(reasonBlindOutage, {});
		const without = classifySettleBuckets(reasonBlindOutage);
		expect(withOpt).toEqual(without);
		expect(without.cause).toBe('rail');
	});
});

describe('classifySettleBuckets: a dry sponsor is not a rail fault', () => {
	// The 2026-08-28 outage, reproduced from the real aggregation. The sponsor
	// held 0.000899107 SOL against a 0.02 floor, so every transaction it fee-paid
	// died on InsufficientFundsForRent at account index 0. The reason TOKEN those
	// rows carry is rail-shaped (`sweep_broadcast_failed`, `simulation_failed`)
	// because the rent detail lives past the first `:`, so the sensor counted 95
	// rail faults and answered `cause: rail`. The hint then sent the operator to
	// hunt duplicate signatures and RPC preflight faults instead of funding a
	// wallet that had 0.0000082 SOL of spendable headroom.
	const rentWave = [
		{ success: false, paid: false, reason: 'sweep_broadcast_failed', rent: true, n: 86 },
		{ success: false, paid: false, reason: 'simulation_failed', rent: true, n: 5 },
		{ success: false, paid: false, reason: 'rpc_preflight_failed', rent: false, n: 4 },
	];

	it('names the sponsor floor, not the rail, when the fee payer cannot afford rent', () => {
		const v = classifySettleBuckets(rentWave);
		expect(v.cause).toBe('sponsor_floor');
		expect(v.floorSignals).toBe(91);
		// The 4 genuine preflight faults stay on the rail where they belong.
		expect(v.faults).toBe(4);
		expect(v.hint).toMatch(/sponsor/i);
	});

	it('reports DOWN, never UNKNOWN, when the floor is why there is nothing to judge', () => {
		// Moving rent rows out of `faults` is correct (they never reached the rail)
		// but it drops `attempts` under MIN_ATTEMPTS. Without the floor branch the
		// sensor would answer "too few attempts to judge" for a three-hour outage.
		const v = classifySettleBuckets([
			{ success: false, paid: false, reason: 'sweep_broadcast_failed', rent: true, n: 95 },
		]);
		expect(v.status).toBe('down');
		expect(v.cause).toBe('sponsor_floor');
		expect(v.detail).toMatch(/sponsor under its SOL floor/);
	});

	it('a handful of rent rows on an otherwise idle ring still reads UNKNOWN', () => {
		// The floor branch keys off the same MIN_ATTEMPTS as every other verdict, so
		// a couple of stray rows cannot declare an outage on a quiet ring.
		const v = classifySettleBuckets([
			{ success: false, paid: false, reason: 'simulation_failed', rent: true, n: 3 },
		]);
		expect(v.status).toBe('unknown');
	});

	it('a bucket with no rent flag behaves exactly as it always did', () => {
		const withFlag = classifySettleBuckets([
			{ success: true, paid: true, n: 90 },
			{ success: false, paid: false, reason: 'http_502', rent: false, n: 10 },
		]);
		const without = classifySettleBuckets([
			{ success: true, paid: true, n: 90 },
			{ success: false, paid: false, reason: 'http_502', n: 10 },
		]);
		expect(withFlag.status).toBe(without.status);
		expect(withFlag.faults).toBe(without.faults);
		expect(withFlag.rate).toBe(without.rate);
	});
});
