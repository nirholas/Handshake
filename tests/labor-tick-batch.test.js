// Regression guard for the Agent Labor Market cron driver (api/labor/tick.js).
//
// 2026-08-13 audit found three defects in the batch loops, all of which look like
// an idle market from the outside:
//
// 1. HEAD-OF-LINE STARVATION. Both scans are `ORDER BY created_at ASC LIMIT 10`,
//    so a row the driver can never advance holds a slot on every tick forever.
//    The job scan selected any 'working' job, but runAutopilot returns
//    immediately unless the worker opted into autonomy — so ten jobs held by
//    manual workers (who deliver through /deliver, on their own time) consumed
//    the whole batch and no autonomous job was ever driven again. The bounty scan
//    admitted any open bounty with >= 1 pending bid, but autoAwardIfReady
//    declines until the poster's min_bids is met, so under-bid bounties could
//    block award-ready ones out of the batch.
// 2. IDEMPOTENT SETTLES COUNTED AS WORK. runSettlement returns
//    `{ idempotent: true, status: 'settled' }` when another caller already won the
//    claim. The tick counted that as a settlement it performed, inflating the
//    number the economy heartbeat reports.
// 3. NO ERROR ISOLATION OR REPORTING. Row reads inside the loop were unguarded,
//    so one transient failure aborted the rest of the batch, and every driver
//    failure was swallowed by `.catch(() => null)` — a fully stalled lane
//    reported `{ ok: true, settled: 0 }`, indistinguishable from a quiet minute.
//
// The sql double models only what those bugs turn on: which rows each scan asks
// for. A handler that drops the worker_enabled requirement, the min_bids
// priority, or the per-row guards fails here.

import { describe, it, expect, beforeEach, vi } from 'vitest';

const h = vi.hoisted(() => {
	process.env.CRON_SECRET = 'test-cron-secret';
	return {
		sql: vi.fn(),
		runAutopilot: vi.fn(),
		runSettlement: vi.fn(),
		getBounty: vi.fn(),
		getJob: vi.fn(),
	};
});

vi.mock('../api/_lib/db.js', () => ({
	sql: (...a) => h.sql(...a),
	isDbUnavailableError: () => false,
	isDbCapacityError: () => false,
}));
vi.mock('../api/_lib/agent-labor.js', () => ({
	ensureLaborTables: vi.fn(async () => true),
	getBounty: (...a) => h.getBounty(...a),
	getJob: (...a) => h.getJob(...a),
}));
vi.mock('../api/_lib/labor-settle.js', () => ({
	runAutopilot: (...a) => h.runAutopilot(...a),
	runSettlement: (...a) => h.runSettlement(...a),
}));

const { default: handler } = await import('../api/labor/tick.js');

function mockRes() {
	return {
		statusCode: 0,
		headersSent: false,
		writableEnded: false,
		headers: {},
		body: null,
		setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
		getHeader(k) { return this.headers[k.toLowerCase()]; },
		end(payload) {
			this.writableEnded = true;
			this.body = payload ? JSON.parse(payload) : null;
		},
	};
}

const req = (over = {}) => ({
	method: 'POST',
	url: '/api/labor/tick',
	headers: { authorization: 'Bearer test-cron-secret' },
	...over,
});

// The rows each scan would return, and the query text the handler asked with.
let bountyRows;
let jobRows;
let queries;

function installSql() {
	queries = { bounties: null, jobs: null };
	h.sql.mockImplementation((strings) => {
		const q = Array.isArray(strings) ? strings.join(' ? ') : String(strings);
		if (/FROM agent_bounties/i.test(q)) {
			queries.bounties = q;
			return Promise.resolve(bountyRows);
		}
		if (/FROM agent_jobs/i.test(q)) {
			queries.jobs = q;
			return Promise.resolve(jobRows);
		}
		return Promise.resolve([]);
	});
}

async function tick(over) {
	const res = mockRes();
	await handler(req(over), res);
	return res;
}

beforeEach(() => {
	vi.clearAllMocks();
	bountyRows = [];
	jobRows = [];
	installSql();
	h.runAutopilot.mockResolvedValue({ bids: 0, awarded: false, settled: null, settledNow: false });
	h.runSettlement.mockResolvedValue({ settled: true, status: 'settled' });
	h.getBounty.mockResolvedValue({ id: 'b1', title: 'T', poster_agent_id: 'p' });
	h.getJob.mockImplementation(async (id) => ({ id, status: 'delivered', worker_agent_id: 'w' }));
});

describe('labor tick — auth and method gates', () => {
	it('rejects a caller without the cron secret', async () => {
		const res = await tick({ headers: {} });
		expect(res.statusCode).toBe(401);
		expect(h.sql).not.toHaveBeenCalled();
	});

	it('rejects a method the handler does not serve', async () => {
		const res = await tick({ method: 'DELETE' });
		expect(res.statusCode).toBe(405);
		expect(h.sql).not.toHaveBeenCalled();
	});
});

describe('labor tick — scans only rows it can advance', () => {
	it('requires an autonomous worker before scanning a working job', async () => {
		await tick();
		// A 'working' job is only admitted alongside an enabled worker policy: that
		// is the whole fix for the manual-worker head-of-line block.
		expect(queries.jobs).toMatch(/agent_labor_policies/);
		expect(queries.jobs).toMatch(/worker_enabled/);
		expect(queries.jobs).toMatch(/delivered/);
		expect(queries.jobs).toMatch(/verifying/);
	});

	it('sorts award-ready bounties ahead of ones still gathering bids', async () => {
		await tick();
		expect(queries.bounties).toMatch(/min_bids/);
		expect(queries.bounties).toMatch(/pending_bids >= min_bids\) DESC/);
	});

	it('bounds both scans inside the statement', async () => {
		await tick();
		expect(queries.bounties).toMatch(/LIMIT/i);
		expect(queries.jobs).toMatch(/LIMIT/i);
	});
});

describe('labor tick — counting', () => {
	it('reports real progress across both lanes', async () => {
		bountyRows = [{ id: 'b1' }, { id: 'b2' }];
		jobRows = [{ id: 'j1', bounty_id: 'b9', status: 'delivered' }];
		h.runAutopilot
			.mockResolvedValueOnce({ bids: 2, awarded: true, settled: 'settled', settledNow: true })
			.mockResolvedValueOnce({ bids: 1, awarded: false, settled: null, settledNow: false });

		const res = await tick();
		expect(res.statusCode).toBe(200);
		expect(res.body).toMatchObject({
			ok: true, scanned: 3, bids: 3, awarded: 1, settled: 2, failed: 0,
		});
		expect(res.body.errors).toBeUndefined();
	});

	it('does not count a settle another caller already claimed', async () => {
		jobRows = [{ id: 'j1', bounty_id: 'b1', status: 'verifying' }];
		h.runSettlement.mockResolvedValue({ idempotent: true, status: 'settled' });

		const res = await tick();
		expect(res.body).toMatchObject({ ok: true, scanned: 1, settled: 0, failed: 0 });
	});

	it('does not count an autopilot settle that only observed a prior payout', async () => {
		bountyRows = [{ id: 'b1' }];
		h.runAutopilot.mockResolvedValue({ bids: 0, awarded: false, settled: 'settled', settledNow: false });

		const res = await tick();
		expect(res.body).toMatchObject({ scanned: 1, settled: 0 });
	});

	it('drives a working job without re-fetching its bounty', async () => {
		jobRows = [{ id: 'j1', bounty_id: 'b1', status: 'working' }];
		await tick();
		expect(h.runAutopilot).toHaveBeenCalledWith('b1');
		expect(h.getBounty).not.toHaveBeenCalled();
	});
});

describe('labor tick — failure isolation', () => {
	it('finishes the batch when one row fails, and says which', async () => {
		jobRows = [
			{ id: 'j1', bounty_id: 'b1', status: 'delivered' },
			{ id: 'j2', bounty_id: 'b2', status: 'delivered' },
		];
		h.getJob.mockImplementationOnce(async () => { throw new Error('connection reset'); });

		const res = await tick();
		expect(res.statusCode).toBe(200);
		expect(res.body).toMatchObject({ ok: true, scanned: 2, settled: 1, failed: 1 });
		expect(res.body.errors).toHaveLength(1);
		expect(res.body.errors[0]).toContain('j1');
		expect(res.body.errors[0]).toContain('connection reset');
		expect(res.body.reason).toBe('1/2 items failed');
		// The second job still settled: the throw did not abort the loop.
		expect(h.runSettlement).toHaveBeenCalledTimes(1);
	});

	it('reports a lane where every row failed as an outage, not an idle tick', async () => {
		jobRows = [{ id: 'j1', bounty_id: 'b1', status: 'delivered' }];
		h.runSettlement.mockRejectedValue(new Error('escrow unreachable'));

		const res = await tick();
		expect(res.statusCode).toBe(502);
		expect(res.body).toMatchObject({ ok: false, scanned: 1, settled: 0, failed: 1 });
	});

	it('caps the reported errors so a batch-wide failure cannot bloat the response', async () => {
		jobRows = Array.from({ length: 8 }, (_, i) => ({ id: `j${i}`, bounty_id: 'b1', status: 'delivered' }));
		h.runSettlement.mockRejectedValue(new Error('escrow unreachable'));

		const res = await tick();
		expect(res.body.failed).toBe(8);
		expect(res.body.errors).toHaveLength(5);
	});

	it('stays quiet and healthy when there is nothing to do', async () => {
		const res = await tick();
		expect(res.statusCode).toBe(200);
		expect(res.body).toMatchObject({ ok: true, scanned: 0, settled: 0, failed: 0 });
		expect(res.body.reason).toBeUndefined();
	});
});
