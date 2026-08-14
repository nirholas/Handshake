// The three ops boards: /api/ops/health, /api/ops/money-health,
// /api/ops/payment-outcomes.
//
// Three regression fences live here, one per defect these tests were written
// against:
//
//  1. health's cron staleness windows were hand-set integers that drifted away
//     from the schedules in vercel.json. Three daily crons carried windows of 15
//     to 70 minutes, so they read as failing ~23 hours of every day and the board
//     could never answer ok:true. The windows are derived now, and the invariant
//     test below fails the moment a schedule changes without one.
//  2. money-health ran its own auth gate accepting CRON_SECRET (the credential
//     the fund-moving crons carry) and a never-set ADMIN_TOKEN. It shares
//     authorizeOps with its neighbours now.
//  3. money-health's activity probe swallowed every error, so a wrong column
//     name rendered as "no activity" forever. Only a missing table is silence.
//  4. payment-outcomes answered a literal ok:true even when all three panels
//     threw, so a blind board reported success. It names the failed panels in
//     `degraded` and answers 207 now.
//  5. all three boards spent the strict `authIp` credential budget, so polling
//     a dashboard could 429 the operator's login from the same IP. They use the
//     `authedReadIp` polled-read bucket.

import { describe, it, expect, vi, beforeEach } from 'vitest';

let authOk = true;
vi.mock('../../api/_lib/ops-auth.js', () => ({
	authorizeOps: vi.fn(async () => (authOk ? { ok: true, actor: 'ops-secret' } : { ok: false, actor: '' })),
}));

let rateLimitOk = true;
vi.mock('../../api/_lib/rate-limit.js', () => ({
	limits: {
		authedReadIp: vi.fn(async () => ({ success: rateLimitOk, limit: 300, remaining: 0, reset: Date.now() + 1000 })),
	},
	clientIp: () => '127.0.0.1',
}));

vi.mock('../../api/_lib/cache.js', () => ({
	cacheGet: vi.fn(async () => null),
	cacheSet: vi.fn(async () => {}),
}));

let sqlImpl = async () => [];
vi.mock('../../api/_lib/db.js', () => ({
	sql: (...args) => sqlImpl(...args),
}));

let settleHealthImpl = async () => ({ name: 'x402_settle', status: 'ok' });
vi.mock('../../api/_lib/ops/x402-settle-health.js', () => ({
	gatherX402SettleHealth: () => settleHealthImpl(),
}));

let ringWalletsImpl = async () => ({ wallets: [], sponsorRunway: null });
vi.mock('../../api/_lib/x402/wallet-balance-monitor.js', () => ({
	checkRingWallets: () => ringWalletsImpl(),
}));

const health = await import('../../api/ops/health.js');
const { default: moneyHealthHandler, lastActivity } = await import('../../api/ops/money-health.js');
const { default: paymentOutcomesHandler } = await import('../../api/ops/payment-outcomes.js');

function makeRes() {
	return {
		statusCode: 200,
		_h: {},
		writableEnded: false,
		setHeader(k, v) { this._h[k.toLowerCase()] = v; },
		getHeader(k) { return this._h[k.toLowerCase()]; },
		end(body) { this.writableEnded = true; this._body = body; },
	};
}

async function call(handler, url, { method = 'GET', headers = {} } = {}) {
	const res = makeRes();
	await handler({ url, method, headers: { host: 'three.ws', ...headers }, query: {} }, res);
	let body = null;
	try { body = JSON.parse(res._body); } catch { /* non-JSON body */ }
	return { res, body };
}

const MIN = 60 * 1000;

beforeEach(() => {
	authOk = true;
	rateLimitOk = true;
	sqlImpl = async () => [];
	settleHealthImpl = async () => ({ name: 'x402_settle', status: 'ok' });
	ringWalletsImpl = async () => ({ wallets: [], sponsorRunway: null });
});

describe('cron staleness windows derived from vercel.json', () => {
	it('measures a fixed-interval schedule at its interval', () => {
		expect(health.cadenceMs('*/5 * * * *')).toBe(5 * MIN);
		expect(health.deriveStaleAfterMs('*/5 * * * *')).toBe(5 * MIN * 1.5 + 30 * MIN);
	});

	it('measures an uneven schedule by its widest quiet stretch', () => {
		// 09:00 and 17:00 daily: 8h apart one way, 16h the other. The window must
		// clear the 16h gap or the cron reads as stale every single night.
		expect(health.cadenceMs('0 9,17 * * *')).toBe(16 * 60 * MIN);
	});

	it('gives a daily cron a window longer than a day', () => {
		// The exact defect: oracle-digest (0 8 * * *) and gmgn-seed (0 3 * * *)
		// carried 70 minutes, dead-man-switch (0 5 * * *) carried 15.
		const daily = health.deriveStaleAfterMs('0 8 * * *');
		expect(daily).toBeGreaterThan(24 * 60 * MIN);
	});

	it('falls back to a documented default when a schedule cannot be parsed', () => {
		expect(health.cadenceMs('every other tuesday')).toBeNull();
		expect(health.deriveStaleAfterMs('every other tuesday')).toBe(70 * MIN);
		expect(health.deriveStaleAfterMs(null)).toBe(70 * MIN);
	});

	it('resolves a real schedule and a window wider than the cadence for every cron watched', () => {
		for (const cron of health.CRONS) {
			// A null schedule means the cron was renamed or dropped from
			// vercel.json and this board is now watching a heartbeat nobody writes.
			expect(cron.schedule, `${cron.id} has no schedule in vercel.json`).toBeTruthy();
			expect(
				cron.stale_after_ms,
				`${cron.id} would read stale before its next run`,
			).toBeGreaterThan(health.cadenceMs(cron.schedule));
		}
	});
});

describe('GET /api/ops/health', () => {
	it('rejects a non-GET method with an Allow header', async () => {
		const { res } = await call(health.default, '/api/ops/health', { method: 'POST' });
		expect(res.statusCode).toBe(405);
		expect(String(res.getHeader('allow'))).toContain('GET');
	});

	it('refuses an unauthorized caller before running any probe', async () => {
		authOk = false;
		const { res, body } = await call(health.default, '/api/ops/health');
		expect(res.statusCode).toBe(401);
		expect(body.error).toBe('unauthorized');
	});
});

describe('GET /api/ops/money-health', () => {
	it('refuses an unauthorized caller', async () => {
		authOk = false;
		const { res, body } = await call(moneyHealthHandler, '/api/ops/money-health');
		expect(res.statusCode).toBe(401);
		expect(body.error).toBe('unauthorized');
	});

	it('reports per-subsystem verdicts and real last-activity', async () => {
		const activityMs = Date.now() - 3 * MIN;
		sqlImpl = async (first) => {
			// Tagged-template call: the grouped verdict query.
			if (Array.isArray(first)) {
				return [{ source: 'ring_facilitator_settle', critical: 2, open_total: 5, last_checked: '2026-08-14T00:00:00.000Z' }];
			}
			// Plain-string call: an activity probe.
			return [{ ms: activityMs }];
		};
		const { res, body } = await call(moneyHealthHandler, '/api/ops/money-health');
		expect(res.statusCode).toBe(200);
		expect(body.overall).toBe('critical');
		const ring = body.subsystems.find((s) => s.key === 'x402_ring');
		expect(ring.status).toBe('critical');
		expect(ring.open_critical).toBe(2);
		expect(ring.open_warn).toBe(3);
		expect(ring.minutes_since_activity).toBe(3);
	});

	it('reads ok when nothing is open', async () => {
		const { body } = await call(moneyHealthHandler, '/api/ops/money-health');
		expect(body.overall).toBe('ok');
		expect(body.subsystems.every((s) => s.status === 'ok')).toBe(true);
	});
});

describe('money-health activity probe', () => {
	it('returns the newest timestamp in the log', async () => {
		sqlImpl = async () => [{ ms: 1786673438240 }];
		expect(await lastActivity('x402_self_facilitator_log', 'ts')).toBe(1786673438240);
	});

	it('treats a table this deployment has not created as silence', async () => {
		sqlImpl = async () => { throw new Error('relation "x402_self_facilitator_log" does not exist'); };
		expect(await lastActivity('x402_self_facilitator_log', 'ts')).toBeNull();
	});

	it('rethrows a wrong column instead of reporting no activity', async () => {
		// The defect: `created_at` on a table stamped `ts` threw, was swallowed,
		// and a ring settling thousands of payments a day rendered as idle.
		sqlImpl = async () => { throw new Error('column "created_at" does not exist'); };
		await expect(lastActivity('x402_self_facilitator_log', 'created_at')).rejects.toThrow(/column "created_at"/);
	});
});

describe('GET /api/ops/payment-outcomes', () => {
	it('refuses an unauthorized caller', async () => {
		authOk = false;
		const { res, body } = await call(paymentOutcomesHandler, '/api/ops/payment-outcomes');
		expect(res.statusCode).toBe(401);
		expect(body.error).toBe('unauthorized');
	});

	it('keeps the surviving panels when one panel fails, and says which is blind', async () => {
		// An RPC outage is exactly when the settle panels matter most, so a dead
		// sponsor read must not blank the inbound ledger. It must also not be
		// reported as a healthy board: the failure is named and the status is 207.
		ringWalletsImpl = async () => { throw new Error('rpc unreachable'); };
		sqlImpl = async () => [{ event_type: 'payment_settled', h1: 1, h3: 2, h24: 9 }];
		const { res, body } = await call(paymentOutcomesHandler, '/api/ops/payment-outcomes');
		expect(res.statusCode).toBe(207);
		expect(body.ok).toBe(false);
		expect(body.degraded).toEqual(['sponsor']);
		expect(body.sponsor.error).toBe('rpc unreachable');
		expect(body.inbound.windows['24h'].settled).toBe(9);
		expect(body.ring_settle.status).toBe('ok');
	});

	it('reports ok with an empty degraded list when every panel renders', async () => {
		const { res, body } = await call(paymentOutcomesHandler, '/api/ops/payment-outcomes');
		expect(res.statusCode).toBe(200);
		expect(body.ok).toBe(true);
		expect(body.degraded).toEqual([]);
	});
});

describe('the ops boards share the polled-read bucket, not the credential bucket', () => {
	// A dashboard poll used to spend the same 50/10m `authIp` budget that gates
	// logins from that IP, so watching the board could 429 the operator's sign-in.
	const boards = [
		['health', () => health.default],
		['money-health', () => moneyHealthHandler],
		['payment-outcomes', () => paymentOutcomesHandler],
	];

	for (const [name, handler] of boards) {
		it(`answers 429 on /api/ops/${name} when the read bucket is exhausted`, async () => {
			rateLimitOk = false;
			const { res, body } = await call(handler(), `/api/ops/${name}`);
			expect(res.statusCode).toBe(429);
			expect(body.error).toBe('rate_limited');
		});
	}
});
