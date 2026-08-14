// A broken settlement lane must be loud (api/cron/settlement-verify.js).
//
// This sweep is the only thing that resolves quarantined money rows: a stage tip
// or IRL pay whose on-chain settlement our RPC had not yet seen sits with
// verified_at null, counting for nothing, until a tick promotes or discards it.
// Both lanes are caught so one failure cannot strand the other, and that catch
// used to end the story: the error went into the 200 body, wrapCron saw a clean
// return, the heartbeat stayed ok, and nothing anywhere read the body. A schema
// change or an RPC outage could stop every promotion indefinitely while each
// tick answered 200.
//
// The properties worth pinning, all three negative or near-negative:
//   1. a lane error flips ok:false and pages ops (not a silent 200)
//   2. a table that does not exist yet reports skipped and does NOT page, so a
//      deployment that has never hosted a show is not a false alarm
//   3. one broken lane still lets the other lane run to completion
import { test, expect, vi, beforeEach } from 'vitest';

const sendOpsAlert = vi.fn(async () => {});

// The table-presence probe and the per-lane queries all come through this one
// tagged template, so a test steers a lane by what it returns for that lane's
// query text.
let sqlHandler = () => [];
vi.mock('../api/_lib/db.js', () => ({
	sql: (strings, ...values) => Promise.resolve(sqlHandler(strings.join('?'), values)),
}));
vi.mock('../api/_lib/alerts.js', () => ({
	sendOpsAlert: (...args) => sendOpsAlert(...args),
}));
vi.mock('../api/_lib/cron-auth.js', () => ({ requireCron: () => true }));
vi.mock('../api/_lib/settlement-verify.js', () => ({
	verifySettlement: async () => ({ status: 'pending', reason: 'not seen' }),
}));
vi.mock('../api/stage/tip.js', () => ({ promoteTip: async () => true }));
vi.mock('../api/_lib/stage-wallets.js', () => ({ hostPayoutWallets: async () => [] }));
vi.mock('../api/_lib/agent-payout-wallets.js', () => ({ agentPayoutWallets: async () => [] }));

const handler = (await import('../api/cron/settlement-verify.js')).default;

function makeRes() {
	return {
		statusCode: 0,
		body: null,
		headersSent: false,
		writableEnded: false,
		setHeader() {},
		getHeader() {},
		status(code) { this.statusCode = code; return this; },
		end(payload) {
			this.writableEnded = true;
			if (payload && this.body === null) {
				try { this.body = JSON.parse(payload); } catch { this.body = payload; }
			}
			return this;
		},
		json(payload) { this.body = payload; return this; },
	};
}

async function run() {
	const res = makeRes();
	await handler({ method: 'GET', url: '/api/cron/settlement-verify', headers: {} }, res);
	return res;
}

// Both lazily-created relations resolve, so neither lane is skipped.
const BOTH_PRESENT = { show_tips: 'show_tips', stages: 'stages', irl_interactions: 'irl_interactions' };

beforeEach(() => {
	sendOpsAlert.mockClear();
});

test('a failing lane reports ok:false and pages ops instead of a silent 200', async () => {
	sqlHandler = (text) => {
		if (text.includes('to_regclass')) return [BOTH_PRESENT];
		if (text.includes('FROM show_tips')) throw new Error('column t.network does not exist');
		return [];
	};

	const res = await run();

	expect(res.body.ok).toBe(false);
	expect(res.body.tips.error).toContain('t.network');
	expect(sendOpsAlert).toHaveBeenCalledTimes(1);
	const [title, detail, opts] = sendOpsAlert.mock.calls[0];
	expect(title).toMatch(/settlement sweep lane failing/i);
	expect(detail).toContain('tips');
	// Deduped per lane per hour, so a persistent fault pages once and not every
	// tick (this cron runs every 5 minutes).
	expect(opts.signature).toMatch(/^settlement-verify:tips:\d+$/);
});

test('the healthy lane still completes when the other lane is broken', async () => {
	sqlHandler = (text) => {
		if (text.includes('to_regclass')) return [BOTH_PRESENT];
		if (text.includes('FROM show_tips')) throw new Error('lane down');
		return []; // the IRL lane finds nothing to sweep, cleanly
	};

	const res = await run();

	expect(res.body.tips.error).toBeTruthy();
	expect(res.body.pays).toEqual({ scanned: 0, promoted: 0, discarded: 0, pending: 0 });
});

test('a table that does not exist yet is skipped, not paged', async () => {
	// A deployment that has never hosted a show or taken an IRL pay: both tables
	// are created lazily by their write endpoints, so absence is normal.
	sqlHandler = (text) => {
		if (text.includes('to_regclass')) return [{ show_tips: null, stages: null, irl_interactions: null }];
		throw new Error('no lane query should run when its table is absent');
	};

	const res = await run();

	expect(res.body.ok).toBe(true);
	expect(res.body.tips).toEqual({ skipped: 'table_absent' });
	expect(res.body.pays).toEqual({ skipped: 'table_absent' });
	expect(sendOpsAlert).not.toHaveBeenCalled();
});

test('a clean sweep reports ok:true and pages nobody', async () => {
	sqlHandler = (text) => (text.includes('to_regclass') ? [BOTH_PRESENT] : []);

	const res = await run();

	expect(res.body.ok).toBe(true);
	expect(res.body.tips).toEqual({ scanned: 0, promoted: 0, discarded: 0, pending: 0 });
	expect(sendOpsAlert).not.toHaveBeenCalled();
});
