// /api/club/leaderboard — window whitelist + shape of returned rows.
//
// The endpoint runs one of four hard-coded tagged-template queries depending
// on `window`; user input never reaches the SQL string. We assert that:
//   - each valid window invokes exactly one sql call
//   - the SQL string carries the matching interval literal
//   - rejects unknown windows with 400 bad_window
//   - default window (no query param) is 'all'

import { describe, it, expect, beforeEach, vi } from 'vitest';

const sqlMock = vi.fn();
vi.mock('../../api/_lib/db.js', () => ({ sql: sqlMock }));

vi.mock('../../api/_lib/env.js', () => ({
	env: { APP_ORIGIN: 'http://localhost:3000' },
}));

vi.mock('../../api/_lib/sentry.js', () => ({
	captureException: vi.fn(),
}));

vi.mock('../../api/_lib/zauth.js', () => ({
	instrument: () => null,
	drain: async () => {},
}));

const { default: handler } = await import('../../api/club/leaderboard.js');

function mkReq({ method = 'GET', query = {}, headers = {} } = {}) {
	const url = `/api/club/leaderboard?${new URLSearchParams(query).toString()}`;
	return { method, url, query, headers, on() {}, destroy() {} };
}

function mkRes() {
	return {
		statusCode: 200,
		headers: {},
		body: undefined,
		writableEnded: false,
		setHeader(k, v) {
			this.headers[k.toLowerCase()] = v;
		},
		end(b) {
			this.body = b;
			this.writableEnded = true;
		},
	};
}

async function invoke(opts = {}) {
	const req = mkReq(opts);
	const res = mkRes();
	await handler(req, res);
	return { res, status: res.statusCode, body: res.body ? JSON.parse(res.body) : undefined };
}

const sampleRows = [
	{ dancer: '1', display_name: 'Nyx',    total_atomics: '5000', tip_count: 2, unpaid_atomics: '5000' },
	{ dancer: '2', display_name: 'Ari',    total_atomics: '0',    tip_count: 0, unpaid_atomics: '0' },
	{ dancer: '3', display_name: 'Sable',  total_atomics: '0',    tip_count: 0, unpaid_atomics: '0' },
	{ dancer: '4', display_name: 'Vesper', total_atomics: '0',    tip_count: 0, unpaid_atomics: '0' },
];

beforeEach(() => {
	sqlMock.mockReset();
	sqlMock.mockResolvedValue(sampleRows);
});

describe('GET /api/club/leaderboard', () => {
	it('rejects an unknown window with 400 bad_window', async () => {
		const { status, body } = await invoke({ query: { window: 'forever' } });
		expect(status).toBe(400);
		expect(body.error).toBe('bad_window');
		expect(sqlMock).not.toHaveBeenCalled();
	});

	it('defaults to "all" when window is omitted', async () => {
		const { status, body } = await invoke();
		expect(status).toBe(200);
		expect(body.window).toBe('all');
		expect(body.rows).toEqual(sampleRows);
		expect(sqlMock).toHaveBeenCalledOnce();
	});

	it.each([
		['hour', "interval '1 hour'"],
		['day',  "interval '24 hours'"],
		['week', "interval '7 days'"],
	])('window=%s uses %s in the SQL string', async (window, intervalLiteral) => {
		await invoke({ query: { window } });
		expect(sqlMock).toHaveBeenCalledOnce();
		// Neon tagged templates pass the strings array as the first arg.
		const callArgs = sqlMock.mock.calls[0];
		const strings = callArgs[0];
		const fullSql = strings.join('?');
		expect(fullSql).toContain(intervalLiteral);
	});

	it('window=all does not include any "interval" clause', async () => {
		await invoke({ query: { window: 'all' } });
		const strings = sqlMock.mock.calls[0][0];
		const fullSql = strings.join('?');
		expect(fullSql).not.toContain('interval ');
	});

	it('rejects non-GET methods with 405', async () => {
		const { status } = await invoke({ method: 'POST' });
		expect(status).toBe(405);
	});

	it('echoes the window back in the response', async () => {
		const { body } = await invoke({ query: { window: 'day' } });
		expect(body.window).toBe('day');
	});

	it('returns 500 db_error and logs the Postgres code when the query throws', async () => {
		const pgErr = Object.assign(new Error('column t.paid_at does not exist'), {
			code: '42703',
			detail: 'relation club_tips',
		});
		sqlMock.mockRejectedValueOnce(pgErr);
		const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

		const { status, body } = await invoke({ query: { window: 'all' } });

		expect(status).toBe(500);
		expect(body.error).toBe('db_error');
		// The whole point of the fix: the Postgres code must reach the logs so
		// schema drift (42703 column / 42P01 table) is diagnosable.
		const logged = errSpy.mock.calls[0].join(' ');
		expect(logged).toContain('42703');
		errSpy.mockRestore();
	});
});
