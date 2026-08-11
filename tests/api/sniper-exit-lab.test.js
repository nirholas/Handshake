// GET /api/sniper/exit-lab handler contract.
//
// The corpus endpoint served a hard 500 in production because both of its
// responses called json(res, body, headers) while the helper's signature is
// json(res, status, body, headers): the body object landed in res.statusCode
// and Node threw ERR_HTTP_INVALID_STATUS_CODE before a byte was written. These
// pin the status codes so a missing argument can never ship silently again. DB
// and rate limiting are mocked so the suite runs offline.

import { describe, it, expect, beforeEach, vi } from 'vitest';

const sqlState = { rows: [], error: null };
vi.mock('../../api/_lib/db.js', () => ({
	sql: vi.fn(async () => {
		if (sqlState.error) throw sqlState.error;
		return sqlState.rows;
	}),
	isDbUnavailableError: () => false,
	isDbCapacityError: () => false,
}));

const rlState = { success: true };
vi.mock('../../api/_lib/rate-limit.js', () => ({
	limits: { mcpIp: vi.fn(async () => ({ success: rlState.success, reset: Date.now() + 60_000 })) },
	clientIp: vi.fn(() => '203.0.113.7'),
}));

const handler = (await import('../../api/sniper/exit-lab.js')).default;

function mockRes() {
	return {
		statusCode: 200,
		headers: {},
		_body: '',
		writableEnded: false,
		setHeader(name, value) {
			this.headers[String(name).toLowerCase()] = value;
		},
		getHeader(name) {
			return this.headers[String(name).toLowerCase()];
		},
		end(body) {
			if (body !== undefined) this._body = body;
			this.writableEnded = true;
		},
	};
}

const mockReq = (url = '/api/sniper/exit-lab?network=mainnet&window=all&limit=500') => ({
	method: 'GET',
	url,
	headers: { host: 'three.ws' },
});

const parse = (res) => JSON.parse(res._body);

const closedPosition = {
	mint: 'THREEsynthetic1111111111111111111111111111',
	symbol: 'THREE',
	agent_id: 'agent-1',
	agent_name: 'Sniper 1',
	entry_quote_lamports: '1000000000',
	peak_value_lamports: '2500000000',
	last_value_lamports: '1800000000',
	exit_quote_lamports: '1800000000',
	realized_pnl_lamports: '800000000',
	exit_reason: 'trail',
	initials_recovered: false,
	opened_at: '2026-08-01T00:00:00.000Z',
	closed_at: '2026-08-01T00:05:00.000Z',
	buy_sig: 'buysig',
	sell_sig: 'sellsig',
};

describe('GET /api/sniper/exit-lab', () => {
	beforeEach(() => {
		sqlState.rows = [];
		sqlState.error = null;
		rlState.success = true;
	});

	it('answers 200 with an integer status the http layer can write', async () => {
		sqlState.rows = [closedPosition];
		const res = mockRes();
		await handler(mockReq(), res);
		expect(Number.isInteger(res.statusCode)).toBe(true);
		expect(res.statusCode).toBe(200);
		const body = parse(res);
		expect(body.ok).toBe(true);
		expect(body.trades).toHaveLength(1);
		expect(body.replayable).toBe(1);
		expect(body.scanned).toBe(1);
		expect(res.getHeader('cache-control')).toContain('max-age=60');
	});

	it('answers 200 with an empty corpus when nothing has closed yet', async () => {
		const res = mockRes();
		await handler(mockReq(), res);
		expect(res.statusCode).toBe(200);
		const body = parse(res);
		expect(body.ok).toBe(true);
		expect(body.trades).toEqual([]);
	});

	it('reports a read failure as 503 with the reason attached', async () => {
		sqlState.error = new Error('database read failed');
		const res = mockRes();
		await handler(mockReq(), res);
		expect(Number.isInteger(res.statusCode)).toBe(true);
		expect(res.statusCode).toBe(503);
		const body = parse(res);
		expect(body.ok).toBe(false);
		expect(body.error).toBe('corpus_unavailable');
		expect(body.trades).toEqual([]);
	});

	it('counts an unreplayable position as excluded rather than dropping it silently', async () => {
		sqlState.rows = [
			{ ...closedPosition, initials_recovered: true },
			{ ...closedPosition, entry_quote_lamports: null },
			{ ...closedPosition, peak_value_lamports: null, last_value_lamports: null, exit_quote_lamports: null },
		];
		const res = mockRes();
		await handler(mockReq(), res);
		expect(res.statusCode).toBe(200);
		const body = parse(res);
		expect(body.trades).toEqual([]);
		expect(body.scanned).toBe(3);
		expect(body.excluded.map((e) => e.key).sort()).toEqual(['laddered', 'no_basis', 'no_path']);
		for (const e of body.excluded) expect(e.reason).toBeTruthy();
	});
});
