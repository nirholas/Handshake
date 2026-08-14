// api/cron/run-subscriptions: what a failed charge actually does to the schedule.
//
// The cron is the only thing that ever moves money on a recurring payment, and
// before this it had exactly one response to every failure: pause the row and
// overwrite `last_error`. That meant a five-second RPC outage ended a
// subscription as permanently as a revoked delegation, no charge history
// existed for a creator to read, and nothing could set the row back to active.
//
// These tests drive the real dispatcher against an in-memory Postgres double
// and a stubbed skill, and assert the three things a payer depends on:
//   1. every attempt lands in the subscription_charges ledger, success or not
//   2. a recoverable failure leaves the schedule active and releases the period
//      claim, so the next tick genuinely retries it
//   3. a revoked permission stops the schedule at once, with the reason on it

import { describe, it, expect, beforeEach, vi } from 'vitest';

const h = vi.hoisted(() => ({
	sql: vi.fn(),
	onPeriod: vi.fn(),
}));

vi.mock('../../api/_lib/db.js', () => ({
	sql: (...a) => h.sql(...a),
	isDbUnavailableError: () => false,
	isDbCapacityError: () => false,
}));
vi.mock('../../api/_lib/env.js', () => ({
	env: { APP_ORIGIN: 'http://test', CRON_SECRET: 'test-secret', ISSUER: 'http://test', MCP_RESOURCE: 'http://test' },
}));
vi.mock('../../api/_lib/cron-auth.js', () => ({ requireCron: () => true }));
// The cron dynamically imports the subscription skill's onPeriod; stub it so the
// test controls the charge outcome without touching a relayer.
vi.mock('../../public/skills/subscription/skill.js', () => ({
	onPeriod: (...a) => h.onPeriod(...a),
}));

const { default: dispatcher } = await import('../../api/cron/[name].js');

const run = async () => {
	const res = {
		statusCode: 200,
		headers: {},
		body: '',
		writableEnded: false,
		setHeader(k, v) {
			this.headers[k.toLowerCase()] = v;
		},
		getHeader(k) {
			return this.headers[k.toLowerCase()];
		},
		end(chunk) {
			if (chunk !== undefined) this.body += chunk;
			this.writableEnded = true;
		},
	};
	await dispatcher({ method: 'GET', url: '/api/cron/run-subscriptions', headers: {}, query: { name: 'run-subscriptions' } }, res);
	return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
};

// ── in-memory Postgres double ───────────────────────────────────────────────
// Routes by query text so call order never matters, and records every write so
// the assertions can read what the cron actually persisted.
let row;
let charges;
let updates;

function installSql() {
	h.sql.mockImplementation((strings, ...vals) => {
		const q = Array.isArray(strings) ? strings.join(' ? ') : String(strings);

		if (/FROM agent_subscriptions s/i.test(q)) return Promise.resolve(row ? [row] : []);
		if (/INSERT INTO subscription_charges/i.test(q)) {
			const [, , , , , txHash, status, code, outcome, error] = vals;
			charges.push({ txHash, status, code, outcome, error });
			return Promise.resolve([]);
		}
		if (/INSERT INTO usage_events/i.test(q)) return Promise.resolve([]);
		if (/UPDATE agent_subscriptions/i.test(q)) {
			updates.push({ q: q.replace(/\s+/g, ' ').trim(), vals });
			// The period claim: only the first tick in a period wins it.
			if (/SET last_charge_at = NOW\(\)/i.test(q)) return Promise.resolve([{ id: row.id }]);
			return Promise.resolve([{ id: row.id }]);
		}
		return Promise.resolve([]);
	});
}

const updateMatching = (re) => updates.filter((u) => re.test(u.q));

beforeEach(() => {
	vi.clearAllMocks();
	charges = [];
	updates = [];
	row = {
		id: 'sub-1',
		user_id: 'user-1',
		agent_id: 'agent-1',
		delegation_id: 'del-1',
		period_seconds: 604800,
		amount_per_period: '5000000',
		next_charge_at: new Date(Date.now() - 60_000).toISOString(),
		last_charge_at: null,
		consecutive_failures: 0,
		delegation_status: 'active',
		delegation_expires_at: new Date(Date.now() + 864e5).toISOString(),
		chain_id: 84532,
		owner_address: '0x3333333333333333333333333333333333333333',
	};
	installSql();
});

describe('run-subscriptions: a charge that lands', () => {
	it('records the transaction and advances the schedule by exactly one period', async () => {
		h.onPeriod.mockResolvedValue({ ok: true, txHash: '0xdeadbeef' });

		const { status, body } = await run();
		expect(status).toBe(200);
		expect(body).toMatchObject({ processed: 1, charged: 1, paused: 0, retrying: 0 });

		expect(charges).toEqual([
			expect.objectContaining({ status: 'success', outcome: 'charged', txHash: '0xdeadbeef' }),
		]);

		// The advance is one period from the DUE time, not from now, so a late
		// tick can never drift a weekly schedule later and later.
		const advance = updateMatching(/SET next_charge_at/i)[0];
		const expected = new Date(Date.parse(row.next_charge_at) + 604800 * 1000).toISOString();
		expect(advance.vals).toContain(expected);
		expect(advance.q).toMatch(/consecutive_failures\s*=/);
	});
});

describe('run-subscriptions: a recoverable failure', () => {
	it('keeps the schedule active, releases the period claim and counts the failure', async () => {
		h.onPeriod.mockResolvedValue({ ok: false, code: 'rpc_error', message: 'socket hang up' });

		const { body } = await run();
		expect(body).toMatchObject({ processed: 1, charged: 0, paused: 0, retrying: 1 });

		expect(charges).toEqual([
			expect.objectContaining({ status: 'failed', outcome: 'retryable', code: 'rpc_error' }),
		]);

		// Releasing the claim means writing last_charge_at BACK to what it was,
		// so the next tick's `last_charge_at < next_charge_at` guard passes and
		// the row is genuinely picked up again. Without this the schedule looks
		// active but can never charge.
		const release = updateMatching(/SET last_charge_at\s*=\s*\?/i)[0];
		expect(release).toBeTruthy();
		expect(release.vals[0]).toBe(null);
		expect(release.q).not.toMatch(/status\s*=\s*'paused'/);
		expect(release.vals).toContain(1); // consecutive_failures
	});

	it('pauses once the retry budget is spent', async () => {
		row.consecutive_failures = 2; // MAX_CONSECUTIVE_FAILURES - 1
		h.onPeriod.mockResolvedValue({ ok: false, code: 'rpc_error', message: 'socket hang up' });

		const { body } = await run();
		expect(body).toMatchObject({ paused: 1, retrying: 0 });
		expect(updateMatching(/status\s*=\s*'paused'/i)).toHaveLength(1);
	});

	it('names an underfunded wallet instead of a raw revert string', async () => {
		h.onPeriod.mockResolvedValue({
			ok: false,
			code: 'rpc_error',
			message: 'execution reverted: ERC20: transfer amount exceeds balance',
		});

		const { body } = await run();
		expect(body.errors[0].code).toBe('insufficient_balance');
		expect(body.errors[0].reason).toMatch(/top it up/i);
		expect(charges[0]).toMatchObject({ code: 'insufficient_balance', outcome: 'retryable' });
		// Still recoverable: a top-up between ticks fixes it on its own.
		expect(body.retrying).toBe(1);
	});
});

describe('run-subscriptions: a platform outage', () => {
	it('never counts our own relayer being switched off against the schedule', async () => {
		row.consecutive_failures = 9;
		h.onPeriod.mockResolvedValue({
			ok: false,
			code: 'feature_disabled',
			message: 'relayer not enabled on this deployment',
		});

		const { body } = await run();
		expect(body).toMatchObject({ paused: 0, retrying: 1 });
		expect(updateMatching(/status\s*=\s*'paused'/i)).toHaveLength(0);
		// The counter stays where it was: nine platform outages must not consume
		// a budget meant for problems the owner can actually fix.
		expect(updateMatching(/SET last_charge_at\s*=\s*\?/i)[0].vals).toContain(9);
	});
});

describe('run-subscriptions: a timeout', () => {
	it('pauses without retrying, because a retry here can charge twice', async () => {
		h.onPeriod.mockRejectedValue(Object.assign(new Error('onPeriod exceeded 25000ms'), { code: 'timeout' }));

		const { body } = await run();
		expect(body).toMatchObject({ paused: 1, retrying: 0 });
		expect(charges[0]).toMatchObject({ status: 'unknown', outcome: 'ambiguous', code: 'timeout' });
		expect(updateMatching(/SET last_charge_at\s*=\s*\?/i)).toHaveLength(0);
	});
});

describe('run-subscriptions: revoked authority', () => {
	it('stops before attempting a charge and records why', async () => {
		row.delegation_status = 'revoked';

		const { body } = await run();
		expect(h.onPeriod).not.toHaveBeenCalled();
		expect(body).toMatchObject({ paused: 1, charged: 0 });
		expect(body.errors[0]).toMatchObject({ code: 'delegation_revoked' });
		// The creator's ledger has to show the period that produced no money,
		// not just a gap between charges.
		expect(charges[0]).toMatchObject({
			status: 'aborted',
			outcome: 'fatal',
			code: 'delegation_revoked',
		});
		expect(updateMatching(/status\s*=\s*'paused'/i)).toHaveLength(1);
	});

	it('stops on an expired permission too', async () => {
		row.delegation_expires_at = new Date(Date.now() - 1000).toISOString();

		const { body } = await run();
		expect(h.onPeriod).not.toHaveBeenCalled();
		expect(body.errors[0].code).toBe('delegation_expired');
		expect(charges[0].outcome).toBe('fatal');
	});
});
