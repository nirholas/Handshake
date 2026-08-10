// Regression guard for the payment-session sweep (api/cron/payment-session-sweep.js).
//
// 2026-08-10 audit: the sweep ran an UNBOUNDED `UPDATE payment_sessions SET
// status = 'expired' WHERE status = 'active' AND expires_at < now()` and then
// sliced the RETURNING rows to BATCH_LIMIT in JS before refunding. Postgres had
// already expired every due session, but only the first BATCH_LIMIT of them were
// refunded, and the next tick could never see the rest because it selects on
// `status = 'active'`. Every session past the limit silently kept the user's
// un-spent budget. The handler's own note ("the next tick will continue") was
// false. The bound now lives inside the statement, so the set that is expired and
// the set that is refunded are the same set.
//
// The sql double below models the one thing that matters for that bug: Postgres
// honours a LIMIT only if the statement carries one. A handler that goes back to
// slicing in JS fails `expires exactly what it refunds`.

import { describe, it, expect, beforeEach, vi } from 'vitest';

const h = vi.hoisted(() => {
	process.env.CRON_SECRET = 'test-cron-secret';
	process.env.PAYMENT_SESSION_SWEEP_BATCH = '10';
	return { sql: vi.fn(), creditAccount: vi.fn() };
});

vi.mock('../api/_lib/db.js', () => ({
	sql: (...a) => h.sql(...a),
	isDbUnavailableError: () => false,
	isDbCapacityError: () => false,
}));
vi.mock('../api/_lib/credits.js', () => ({ creditAccount: (...a) => h.creditAccount(...a) }));

const { default: handler } = await import('../api/cron/payment-session-sweep.js');

const BATCH = 10;

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
	method: 'GET',
	url: '/api/cron/payment-session-sweep',
	headers: { authorization: 'Bearer test-cron-secret' },
	...over,
});

// Sessions still 'active' and past expiry, keyed by id.
let due;
// Ids the double actually flipped to 'expired'.
let expiredIds;

function installSql() {
	h.sql.mockImplementation((strings, ...vals) => {
		const q = Array.isArray(strings) ? strings.join(' ? ') : String(strings);
		if (!/UPDATE payment_sessions/i.test(q)) return Promise.resolve([]);

		// Postgres applies a bound only when the statement asks for one.
		const bounded = /\bLIMIT\b/i.test(q);
		const limit = bounded ? Number(vals[0]) : Infinity;
		const claimed = due.slice(0, limit);
		for (const row of claimed) expiredIds.push(row.id);
		due = due.slice(claimed.length);
		return Promise.resolve(claimed.map((r) => ({ ...r })));
	});
}

function makeSessions(n) {
	return Array.from({ length: n }, (_, i) => ({
		id: `sess-${i}`,
		user_id: `user-${i}`,
		budget_usdc: '1000000',
		spent_usdc: '250000',
	}));
}

describe('payment-session-sweep', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		due = [];
		expiredIds = [];
		installSql();
		h.creditAccount.mockResolvedValue({ ok: true });
	});

	it('expires exactly the set it refunds when more sessions are due than the batch limit', async () => {
		due = makeSessions(BATCH * 3);
		const res = mockRes();
		await handler(req(), res);

		expect(res.statusCode).toBe(200);
		expect(expiredIds.length).toBe(BATCH);
		// The invariant: nothing is marked expired without its refund being issued.
		expect(h.creditAccount).toHaveBeenCalledTimes(BATCH);
		expect(h.creditAccount.mock.calls.map(([a]) => a.refId).sort()).toEqual([...expiredIds].sort());
		expect(res.body.expired).toBe(BATCH);
		expect(res.body.refunded).toBe(BATCH);
		// The remainder is still active, so the next tick genuinely reaches it.
		expect(due.length).toBe(BATCH * 2);
	});

	it('drains the backlog across ticks instead of stranding it', async () => {
		due = makeSessions(BATCH * 3);
		for (let tick = 0; tick < 3; tick++) await handler(req(), mockRes());

		expect(due.length).toBe(0);
		expect(expiredIds.length).toBe(BATCH * 3);
		expect(h.creditAccount).toHaveBeenCalledTimes(BATCH * 3);
	});

	it('refunds the un-spent remainder under a stable idempotency key', async () => {
		due = makeSessions(1);
		await handler(req(), mockRes());

		const [arg] = h.creditAccount.mock.calls[0];
		expect(arg.amountUsd).toBeCloseTo(0.75, 6);
		expect(arg.kind).toBe('refund');
		expect(arg.idempotencyKey).toBe('paysess_expire_sess-0');
	});

	it('skips the refund when the whole budget was spent', async () => {
		due = [{ id: 'sess-full', user_id: 'u', budget_usdc: '1000000', spent_usdc: '1000000' }];
		const res = mockRes();
		await handler(req(), res);

		expect(h.creditAccount).not.toHaveBeenCalled();
		expect(res.body).toMatchObject({ expired: 1, refunded: 0, refund_errors: 0 });
	});

	it('counts a failing refund without aborting the rest of the batch', async () => {
		due = makeSessions(3);
		h.creditAccount.mockRejectedValueOnce(new Error('ledger down'));
		const res = mockRes();
		await handler(req(), res);

		expect(res.statusCode).toBe(200);
		expect(res.body).toMatchObject({ ok: true, expired: 3, refunded: 2, refund_errors: 1 });
	});

	it('rejects a method it does not implement before touching the database', async () => {
		due = makeSessions(5);
		const res = mockRes();
		await handler(req({ method: 'DELETE' }), res);

		expect(res.statusCode).toBe(405);
		expect(h.sql).not.toHaveBeenCalled();
		expect(h.creditAccount).not.toHaveBeenCalled();
	});

	it('rejects an unauthenticated caller before touching the database', async () => {
		due = makeSessions(5);
		const res = mockRes();
		await handler(req({ headers: {} }), res);

		expect(res.statusCode).toBe(401);
		expect(h.sql).not.toHaveBeenCalled();
		expect(h.creditAccount).not.toHaveBeenCalled();
	});
});
