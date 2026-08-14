// Summary contract for GET /api/oracle/activity.
//
// The /activity page renders its "PnL (7d)" tile and its fallback win rate from
// this summary. Both were structurally dead: every counter was windowed on
// `acted_at`, but a conviction position settles days or weeks after it is
// entered, so by the time an action had a win/loss it had already aged out of
// its own 7-day window. The endpoint reported 0 wins, 0 losses and 0.000 SOL
// forever, and the page rendered "+0.000 ◎" as if the floor had broken even.
//
// These tests pin the fix: entries count on acted_at, resolutions count on
// settled_at, and pnl_sample reports how many settled rows carry a realized
// figure so a caller can tell "flat" apart from "nothing measured".

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../api/_lib/http.js', async () => {
	const actual = await vi.importActual('../../api/_lib/http.js');
	return {
		...actual,
		wrap: (fn) => fn,
		cors: () => false,
		method: () => true,
		rateLimited: (res) => { res._rateLimited = true; },
		json: (res, status, body) => { res._json = { status, body }; return res; },
		error: (res, status, code, message) => {
			res._json = { status, body: { error: code, error_description: message } };
			return res;
		},
	};
});

vi.mock('../../api/_lib/rate-limit.js', () => ({
	limits: { publicIp: vi.fn(async () => ({ success: true })) },
	clientIp: () => '1.2.3.4',
}));

// Queries run in order: the feed rows first, then the summary aggregate. Each
// test seeds one reply per query and keeps the raw template text so the window
// each counter uses can be asserted directly.
const sqlCalls = [];
const replies = [];
vi.mock('../../api/_lib/db.js', () => ({
	sql: (strings) => {
		sqlCalls.push(strings.join(' ? '));
		const next = replies.shift();
		if (next instanceof Error) return Promise.reject(next);
		return Promise.resolve(next ?? []);
	},
	isDbUnavailableError: () => false,
	isDbCapacityError: () => false,
}));

const { default: activity } = await import('../../api/oracle/activity.js');

function fakeRes() {
	return {
		statusCode: 200,
		_headers: {},
		setHeader(k, v) { this._headers[k.toLowerCase()] = v; },
		getHeader(k) { return this._headers[k.toLowerCase()]; },
		end() { this.writableEnded = true; },
	};
}

function fakeReq(url = '/api/oracle/activity') {
	return { method: 'GET', url, headers: { host: 'three.ws' } };
}

/** Collapse whitespace so an assertion is not hostage to query indentation. */
const flat = (s) => s.replace(/\s+/g, ' ');

beforeEach(() => {
	sqlCalls.length = 0;
	replies.length = 0;
});

describe('GET /api/oracle/activity summary windows', () => {
	it('counts resolutions on settled_at, not on acted_at', async () => {
		replies.push([], [{ total: 3, live_count: 0, wins: 2, losses: 1, total_pnl_sol: 0.4, pnl_sample: 3, agent_count: 1 }]);
		await activity(fakeReq(), fakeRes());

		const summaryQuery = flat(sqlCalls[1]);
		expect(summaryQuery).toContain("count(*) filter (where outcome = 'win' and settled_at > now() - interval '7 days')");
		expect(summaryQuery).toContain("count(*) filter (where outcome = 'loss' and settled_at > now() - interval '7 days')");
		// A win that settled inside the window must survive even when the action
		// was entered long before it, so the row filter cannot be acted_at alone.
		expect(summaryQuery).toContain("(acted_at > now() - interval '7 days' or settled_at > now() - interval '7 days')");
	});

	it('counts entries on acted_at', async () => {
		replies.push([], [{ total: 3, live_count: 1, wins: 0, losses: 0, total_pnl_sol: 0, pnl_sample: 0, agent_count: 2 }]);
		await activity(fakeReq(), fakeRes());

		const summaryQuery = flat(sqlCalls[1]);
		expect(summaryQuery).toContain("count(*) filter (where acted_at > now() - interval '7 days') as total");
		expect(summaryQuery).toContain("count(*) filter (where mode = 'live' and acted_at > now() - interval '7 days')");
	});

	it('surfaces pnl_sample so a zero PnL is distinguishable from no data', async () => {
		replies.push([], [{ total: 5, live_count: 0, wins: 0, losses: 0, total_pnl_sol: 0, pnl_sample: 0, agent_count: 1 }]);
		const res = fakeRes();
		await activity(fakeReq(), res);

		expect(res._json.status).toBe(200);
		expect(res._json.body.summary.pnl_sample).toBe(0);
		expect(res._json.body.summary.total_pnl_sol).toBe(0);
	});

	it('reports the realized sample size when positions have settled', async () => {
		replies.push([], [{ total: 5, live_count: 0, wins: 3, losses: 1, total_pnl_sol: 1.25, pnl_sample: 4, agent_count: 2 }]);
		const res = fakeRes();
		await activity(fakeReq(), res);

		expect(res._json.body.summary).toEqual({
			total: 5, live_count: 0, wins: 3, losses: 1,
			total_pnl_sol: 1.25, pnl_sample: 4, agent_count: 2,
		});
	});

	it('still answers 200 with a null summary when the aggregate fails', async () => {
		replies.push([], new Error('aggregate exploded'));
		const res = fakeRes();
		await activity(fakeReq(), res);

		expect(res._json.status).toBe(200);
		expect(res._json.body.summary).toBeNull();
		expect(res._json.body.items).toEqual([]);
	});
});
