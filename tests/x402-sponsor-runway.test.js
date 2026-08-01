// Sponsor fee-wallet runway: the verdict thresholds and the ALERT COPY.
//
// The copy is tested as hard as the arithmetic on purpose. The bridge-down alert
// shipped a template that interpolated its own source text, so the page that
// reached the operator read `${detail}` where the numbers should have been. An
// alert whose only job is to carry four measurements is worthless if it carries
// none of them, and nothing but a test over the rendered string catches that:
// the code compiles, the alert sends, the dashboard shows a row.
//
// computeSponsorRunway and formatSponsorRunwayAlert are pure, so all of this runs
// with no chain, no database, and no clock.
import { describe, it, expect } from 'vitest';
import {
	computeSponsorRunway,
	formatSponsorRunwayAlert,
	SPONSOR_BURN_WINDOW_DAYS,
	SPONSOR_RUNWAY_ALERT_DAYS,
} from '../api/_lib/x402/sponsor-runway.js';

// The measurement that opened this work order: 0.0318 SOL against a 0.03 floor
// with a measured burn of 0.060 SOL/day. Roughly half a day of runway, and the
// board rendered it while nothing acted on it.
const MEASURED = {
	address: 'WwwuGbqHrwF5RG89KhUbmRWEvjnRH9k5kVM5p7T3WwW',
	sol: 0.0318,
	floorSol: 0.03,
	burnSolPerDay: 0.06,
	settles: 4151,
	windowDays: 7,
	alertDays: 3,
};

describe('computeSponsorRunway', () => {
	it('warns on the measured sponsor state and reports both runway figures', () => {
		const r = computeSponsorRunway(MEASURED);
		expect(r.status).toBe('warn');
		expect(r.should_alert).toBe(true);
		// To the floor: (0.0318 - 0.03) / 0.06 = 0.03 days. To empty: 0.53 days.
		expect(r.runway_days_to_floor).toBeCloseTo(0.03, 2);
		expect(r.runway_days).toBeCloseTo(0.53, 2);
		expect(r.spendable_sol).toBeCloseTo(0.0018, 6);
	});

	it('a wallet at or under the floor is critical without needing a burn rate', () => {
		// The live-outage case. Refusing to judge without a burn rate is exactly how
		// a dead rail reads as `unknown` on the board.
		const r = computeSponsorRunway({ ...MEASURED, sol: 0.02, burnSolPerDay: null });
		expect(r.status).toBe('critical');
		expect(r.should_alert).toBe(true);
		expect(r.runway_days_to_floor).toBe(0);
		expect(r.reason).toMatch(/at or below the settle floor/);
	});

	it('an idle rail is unknown, never an alert', () => {
		// No settles in the window means no measurable burn. Dividing by zero would
		// page every quiet night; a healthy wallet with nothing to pay for is fine.
		const r = computeSponsorRunway({ ...MEASURED, sol: 2, burnSolPerDay: null, settles: 0 });
		expect(r.status).toBe('unknown');
		expect(r.should_alert).toBe(false);
		expect(r.runway_days).toBeNull();
		expect(r.reason).toMatch(/no settle fees recorded in the last 7 day/);
	});

	it('an unreadable balance is unknown, never an alert', () => {
		const r = computeSponsorRunway({ ...MEASURED, sol: null });
		expect(r.status).toBe('unknown');
		expect(r.should_alert).toBe(false);
		expect(r.reason).toMatch(/unreadable/);
	});

	it('a funded wallet above the threshold is ok', () => {
		// 1 SOL at the measured burn is ~16 days, which is the figure the work order
		// sizes an owner top-up against.
		const r = computeSponsorRunway({ ...MEASURED, sol: 1 });
		expect(r.status).toBe('ok');
		expect(r.should_alert).toBe(false);
		expect(r.runway_days_to_floor).toBeCloseTo(16.17, 1);
	});

	it('the threshold is the boundary: at alertDays ok, just under warns', () => {
		// floor 0 keeps the two runway figures identical so the boundary is exact.
		const at = computeSponsorRunway({ ...MEASURED, sol: 0.18, floorSol: 0 });
		expect(at.runway_days_to_floor).toBe(3);
		expect(at.status).toBe('ok');
		const under = computeSponsorRunway({ ...MEASURED, sol: 0.17, floorSol: 0 });
		expect(under.status).toBe('warn');
	});

	it('carries the burn window so the rate can never be read without it', () => {
		// A burn rate quoted without its window is how the 10x-wrong folklore figure
		// survived in triage notes for months.
		const r = computeSponsorRunway({ ...MEASURED, windowDays: 14 });
		expect(r.burn_window_days).toBe(14);
		expect(r.settles_in_window).toBe(4151);
	});

	it('defaults are the documented ones', () => {
		expect(SPONSOR_BURN_WINDOW_DAYS).toBe(7);
		expect(SPONSOR_RUNWAY_ALERT_DAYS).toBe(3);
		const r = computeSponsorRunway({ sol: 0.05, floorSol: 0.03, burnSolPerDay: 0.06 });
		expect(r.alert_days).toBe(3);
		expect(r.burn_window_days).toBe(7);
	});
});

describe('formatSponsorRunwayAlert', () => {
	it('renders every measurement as a real number, not a template', () => {
		const a = formatSponsorRunwayAlert(computeSponsorRunway(MEASURED));
		// The failure mode this test exists for: no unexpanded interpolation, and no
		// field name leaking into the copy in place of its value.
		expect(a.detail).not.toMatch(/\$\{/);
		expect(a.title).not.toMatch(/\$\{/);
		expect(a.detail).not.toMatch(/undefined|NaN|\[object Object\]/);

		expect(a.detail).toContain('WwwuGbqHrwF5RG89KhUbmRWEvjnRH9k5kVM5p7T3WwW');
		expect(a.detail).toContain('0.0318 SOL');   // balance
		expect(a.detail).toContain('0.0300 SOL');   // floor
		expect(a.detail).toContain('0.0600 SOL/day'); // measured burn
		expect(a.detail).toContain('4151 successful settle(s)'); // the sample size
		expect(a.detail).toContain('over the last 7 day(s)');    // the window
		expect(a.detail).toContain('0.0 day(s) above the floor');
		expect(a.detail).toContain('0.5 day(s) to empty');
		expect(a.detail).toContain('Alert threshold 3 day(s)');
		expect(a.severity).toBe('warn');
	});

	it('sizes the top-up from the measured burn, and sends it to the right wallet', () => {
		const a = formatSponsorRunwayAlert(computeSponsorRunway(MEASURED));
		// 0.06/day * 14 + 0.03 floor - 0.0318 held = 0.838 SOL.
		expect(a.detail).toContain('0.838 SOL buys 14 days');
		// The rule that has broken the rail before, restated where it will be read.
		expect(a.detail).toMatch(/NEVER to per-agent wallets/);
	});

	it('names the withdrawn-accept symptom so it is not chased as a rail fault', () => {
		const a = formatSponsorRunwayAlert(computeSponsorRunway(MEASURED));
		expect(a.detail).toMatch(/Solana accept is withdrawn/);
		expect(a.detail).toMatch(/rail faults stay flat/);
		// And it points at the free self-heal before any funding ask.
		expect(a.detail).toMatch(/treasury-topup\?dry=1/);
	});

	it('escalates to critical below the floor and says settlement is refused now', () => {
		const a = formatSponsorRunwayAlert(computeSponsorRunway({ ...MEASURED, sol: 0.02 }));
		expect(a.severity).toBe('critical');
		expect(a.title).toMatch(/UNDER its settle floor/);
		expect(a.title).toContain('0.0200 SOL');
		expect(a.detail).toMatch(/being REFUSED right now/);
	});

	it('coalesces on the wallet, not on the balance', () => {
		// A signature that moved with the balance would post a fresh alert on every
		// ten-minute monitor tick instead of one row with a growing count.
		const a = formatSponsorRunwayAlert(computeSponsorRunway(MEASURED));
		const b = formatSponsorRunwayAlert(computeSponsorRunway({ ...MEASURED, sol: 0.0311 }));
		expect(a.signature).toBe(b.signature);
		expect(a.signature).toContain(MEASURED.address);
	});

	it('never claims a number it does not have', () => {
		const a = formatSponsorRunwayAlert(computeSponsorRunway({ ...MEASURED, sol: 0.05, burnSolPerDay: null }));
		expect(a.detail).toContain('not measurable');
		expect(a.detail).not.toMatch(/NaN|undefined/);
	});
});
