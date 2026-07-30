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
