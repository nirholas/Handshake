// The WIRING, not the arithmetic (that is tests/x402-sponsor-runway.test.js).
//
// The runway number was already computed and already rendered on /admin/ops
// before this change. Nothing acted on it, so a wallet with half a day left
// looked exactly like a wallet with a month left to anyone not staring at the
// dashboard. These tests pin the part that closes that gap: checkRingWallets()
// measures the burn, computes the verdict, and SENDS an alert when the runway
// falls under the threshold.
//
// Balance reads and the burn measurement are both injected, so nothing here
// touches a chain or a database.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

const SPONSOR = 'WwwuGbqHrwF5RG89KhUbmRWEvjnRH9k5kVM5p7T3WwW';
const TREASURY = 'TreasuryTreasuryTreasuryTreasuryTreasury111';

let saved;
beforeEach(() => {
	saved = {
		fee: process.env.X402_FEE_PAYER_SOLANA,
		payTo: process.env.X402_PAY_TO_SOLANA,
		floor: process.env.X402_SPONSOR_SOL_FLOOR_LAMPORTS,
	};
	process.env.X402_FEE_PAYER_SOLANA = SPONSOR;
	process.env.X402_PAY_TO_SOLANA = TREASURY;
});
afterEach(() => {
	for (const [k, v] of Object.entries({
		X402_FEE_PAYER_SOLANA: saved.fee,
		X402_PAY_TO_SOLANA: saved.payTo,
		X402_SPONSOR_SOL_FLOOR_LAMPORTS: saved.floor,
	})) {
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
});

// Balance reader stub: sponsor holds `sol`, everything else is comfortably full
// so only the sponsor's own verdict is under test.
function reader(sol) {
	return async (address) => ({
		lamports: address === SPONSOR ? Math.round(sol * 1e9) : 5e9,
		usdcAtomic: 50_000_000,
	});
}

async function runMonitor({ sol, burn }) {
	const { checkRingWallets } = await import('../api/_lib/x402/wallet-balance-monitor.js');
	const alerts = [];
	const ring = await checkRingWallets({
		readBalance: reader(sol),
		measureBurn: async ({ windowDays }) => ({
			measured: true,
			settles: 4151,
			lamports: Math.round(burn * windowDays * 1e9),
			window_days: windowDays,
			burn_sol_per_day: burn,
		}),
		sendAlert: async (title, detail, opts) => { alerts.push({ title, detail, opts }); },
	});
	return { ring, alerts };
}

describe('checkRingWallets: sponsor runway', () => {
	it('alerts when the runway falls under the threshold, with the measured numbers in it', async () => {
		// The state this work order opened on: 0.0318 SOL, 0.03 floor, 0.06/day.
		const { ring, alerts } = await runMonitor({ sol: 0.0318, burn: 0.06 });
		expect(ring.sponsorRunway.status).toBe('warn');
		expect(ring.sponsorRunway.burn_window_days).toBe(7);

		const runway = alerts.find((a) => a.opts?.signature?.startsWith('x402-sponsor-runway'));
		expect(runway).toBeTruthy();
		expect(runway.detail).toContain('0.0600 SOL/day');
		expect(runway.detail).toContain('over the last 7 day(s)');
		expect(runway.detail).toContain(SPONSOR);
		expect(runway.detail).not.toMatch(/\$\{|undefined|NaN/);
	});

	it('stays silent while the runway is long', async () => {
		const { ring, alerts } = await runMonitor({ sol: 1, burn: 0.06 });
		expect(ring.sponsorRunway.status).toBe('ok');
		expect(alerts.filter((a) => a.opts?.signature?.startsWith('x402-sponsor-runway'))).toHaveLength(0);
	});

	it('stays silent on an idle rail rather than dividing by zero', async () => {
		const { ring, alerts } = await runMonitor({ sol: 1, burn: 0 });
		expect(ring.sponsorRunway.status).toBe('unknown');
		expect(alerts.filter((a) => a.opts?.signature?.startsWith('x402-sponsor-runway'))).toHaveLength(0);
	});

	it('measures the runway against the SETTLE floor, not the ring watch floor', async () => {
		// The ring watches at 1.5x the facilitator's hard floor so it can warn early.
		// The runway must use the hard floor, because that is where settling actually
		// stops: taking the watch floor would report zero runway on a wallet that is
		// still settling fine, and a sensor that cries wolf gets muted.
		const { ring } = await runMonitor({ sol: 0.0318, burn: 0.06 });
		expect(ring.sponsorRunway.floor_sol).toBeCloseTo(0.02, 6);
		const sponsorEntry = ring.wallets.find((w) => w.role === 'sponsor');
		expect(sponsorEntry.sol_floor).toBeCloseTo(0.03, 6);
	});

	it('escalates to critical severity once the wallet is under the settle floor', async () => {
		const { ring, alerts } = await runMonitor({ sol: 0.01, burn: 0.06 });
		expect(ring.sponsorRunway.status).toBe('critical');
		const runway = alerts.find((a) => a.opts?.signature?.startsWith('x402-sponsor-runway'));
		expect(runway.opts.severity).toBe('critical');
		expect(runway.detail).toMatch(/being REFUSED right now/);
	});

	it('an unreadable sponsor balance never fabricates an alert', async () => {
		// Number(null) is 0, and a coerced zero here would page on an RPC hiccup.
		const { checkRingWallets } = await import('../api/_lib/x402/wallet-balance-monitor.js');
		const alerts = [];
		const ring = await checkRingWallets({
			readBalance: async () => ({ lamports: null, usdcAtomic: null }),
			measureBurn: async ({ windowDays }) => ({
				measured: true, settles: 10, lamports: 1e9, window_days: windowDays, burn_sol_per_day: 0.06,
			}),
			sendAlert: async (title, detail, opts) => { alerts.push({ title, detail, opts }); },
		});
		expect(ring.sponsorRunway.status).toBe('unknown');
		expect(alerts.filter((a) => a.opts?.signature?.startsWith('x402-sponsor-runway'))).toHaveLength(0);
	});
});
