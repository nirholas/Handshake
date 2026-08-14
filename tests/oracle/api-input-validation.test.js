// Input-validation contract for the Oracle read APIs.
//
// Every endpoint here takes caller-controlled params that flow straight into SQL
// (`::timestamptz` casts, `limit`) or into string methods. Before this suite
// each of those had a wrong answer for a plainly malformed input: a garbage
// `?before=` 500'd, a garbage `?since=` opened an SSE stream that silently never
// emitted an event, `?limit=abc` returned a 200 whose summary contradicted its
// own empty action list, and `{"agent_id": 12345}` answered internal_error.
// These tests pin the 4xx (or the safe fallback) so none of them can come back.

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
		readJson: async (req) => JSON.parse(req._rawBody),
	};
});

vi.mock('../../api/_lib/rate-limit.js', () => ({
	limits: {
		publicIp: vi.fn(async () => ({ success: true })),
		mcpIp: vi.fn(async () => ({ success: true })),
		oracleFollowIp: vi.fn(async () => ({ success: true })),
	},
	clientIp: () => '1.2.3.4',
}));

// One shared spy for every tagged-template read, so a test can assert a query
// either ran or was never reached.
const sqlCalls = [];
vi.mock('../../api/_lib/db.js', () => ({
	sql: (...args) => { sqlCalls.push(args); return Promise.resolve([]); },
	isDbUnavailableError: () => false,
	isDbCapacityError: () => false,
}));

const storeCalls = { recentActions: [], actionsSummary: [] };
vi.mock('../../api/_lib/oracle/store.js', () => ({
	recentActions: (...args) => { storeCalls.recentActions.push(args); return Promise.resolve([]); },
	actionsSummary: (...args) => {
		storeCalls.actionsSummary.push(args);
		return Promise.resolve({ total: 0, wins: 0, losses: 0, open: 0, win_rate: null });
	},
}));

import { isoTimestamp } from '../../api/_lib/validate.js';
import activity from '../../api/oracle/activity.js';
import actionStream from '../../api/oracle/action-stream.js';
import agentStats from '../../api/oracle/agent-stats.js';
import follow from '../../api/oracle/follow.js';

const AGENT_ID = '5e05f68f-eead-4ef9-b6b4-fc85ea73bbe9';

function fakeRes() {
	return {
		statusCode: 200,
		_headers: {},
		_writeHeadCalls: 0,
		setHeader(k, v) { this._headers[k.toLowerCase()] = v; },
		getHeader(k) { return this._headers[k.toLowerCase()]; },
		writeHead() { this._writeHeadCalls++; return this; },
		flushHeaders() {},
		write() { return true; },
		end() { this.writableEnded = true; },
	};
}

function fakeReq(url, { method = 'GET', body = null } = {}) {
	return {
		method,
		url,
		headers: { host: 'three.ws', 'content-type': 'application/json' },
		_rawBody: body == null ? '' : JSON.stringify(body),
		_handlers: {},
		on(event, fn) { this._handlers[event] = fn; },
	};
}

beforeEach(() => {
	sqlCalls.length = 0;
	storeCalls.recentActions.length = 0;
	storeCalls.actionsSummary.length = 0;
});

describe('isoTimestamp', () => {
	it('normalizes a parseable instant to ISO form', () => {
		expect(isoTimestamp('2026-08-01T00:00:00Z')).toBe('2026-08-01T00:00:00.000Z');
		expect(isoTimestamp('  2026-08-01T00:00:00.000Z  ')).toBe('2026-08-01T00:00:00.000Z');
	});

	it('rejects anything Postgres would refuse to cast', () => {
		expect(isoTimestamp('lolnope')).toBeNull();
		expect(isoTimestamp('')).toBeNull();
		expect(isoTimestamp('   ')).toBeNull();
		expect(isoTimestamp(null)).toBeNull();
		expect(isoTimestamp(1786673136790)).toBeNull();
		expect(isoTimestamp({})).toBeNull();
	});
});

describe('GET /api/oracle/activity', () => {
	it('400s a malformed `before` cursor instead of 500ing inside the query', async () => {
		const res = fakeRes();
		await activity(fakeReq('/api/oracle/activity?before=lolnope'), res);
		expect(res._json.status).toBe(400);
		expect(res._json.body.error).toBe('validation_error');
		// The bad cursor must never have reached the database.
		expect(sqlCalls).toHaveLength(0);
	});

	it('accepts a valid cursor and runs the feed query', async () => {
		const res = fakeRes();
		await activity(fakeReq('/api/oracle/activity?before=2026-08-01T00:00:00Z'), res);
		expect(res._json.status).toBe(200);
		expect(sqlCalls.length).toBeGreaterThan(0);
	});
});

describe('GET /api/oracle/action-stream', () => {
	it('400s a malformed `since` rather than opening a stream that never emits', async () => {
		const res = fakeRes();
		await actionStream(fakeReq('/api/oracle/action-stream?since=lolnope'), res);
		expect(res._json.status).toBe(400);
		expect(res._json.body.error).toBe('validation_error');
		// The SSE headers must not have gone out: a 200 text/event-stream here is
		// exactly the silent-stall failure this guards.
		expect(res._writeHeadCalls).toBe(0);
	});

	it('opens the stream for a valid `since`', async () => {
		const res = fakeRes();
		const req = fakeReq('/api/oracle/action-stream?since=2026-08-01T00:00:00Z');
		await actionStream(req, res);
		expect(res._writeHeadCalls).toBe(1);
		expect(res._json).toBeUndefined();
		// The handler returns while its poll/ping/rotate timers are still armed for
		// the next 90s. Fire the close handler the way a disconnecting client would
		// so this test doesn't leave them running for the rest of the suite.
		req._handlers.close();
		expect(res.writableEnded).toBe(true);
	});
});

describe('GET /api/oracle/agent-stats', () => {
	it('falls back to the default limit when `limit` is unparseable', async () => {
		const res = fakeRes();
		await agentStats(fakeReq(`/api/oracle/agent-stats?agent_id=${AGENT_ID}&limit=abc`), res);
		expect(res._json.status).toBe(200);
		// NaN used to reach `limit NaN`, whose rejection the store swallowed into [].
		expect(storeCalls.recentActions[0][2]).toBe(20);
	});

	it('honours and clamps an explicit limit', async () => {
		const res = fakeRes();
		await agentStats(fakeReq(`/api/oracle/agent-stats?agent_id=${AGENT_ID}&limit=999`), res);
		expect(storeCalls.recentActions[0][2]).toBe(50);
	});

	it('400s a malformed agent_id', async () => {
		const res = fakeRes();
		await agentStats(fakeReq('/api/oracle/agent-stats?agent_id=not-a-uuid'), res);
		expect(res._json.status).toBe(400);
		expect(storeCalls.recentActions).toHaveLength(0);
	});
});

describe('/api/oracle/follow', () => {
	it('400s a non-string agent_id on POST instead of 500ing on .trim()', async () => {
		const res = fakeRes();
		await follow(fakeReq('/api/oracle/follow', { method: 'POST', body: { agent_id: 12345, chat_id: '12345' } }), res);
		expect(res._json.status).toBe(400);
		expect(res._json.body.error_description).toMatch(/agent_id/);
	});

	it('400s a non-string chat_id on POST', async () => {
		const res = fakeRes();
		await follow(fakeReq('/api/oracle/follow', { method: 'POST', body: { agent_id: AGENT_ID, chat_id: 12345 } }), res);
		expect(res._json.status).toBe(400);
		expect(res._json.body.error_description).toMatch(/chat_id/);
	});

	it('400s a non-string agent_id on DELETE', async () => {
		const res = fakeRes();
		await follow(fakeReq('/api/oracle/follow', { method: 'DELETE', body: { agent_id: 99, chat_id: '1' } }), res);
		expect(res._json.status).toBe(400);
		expect(res._json.body.error_description).toMatch(/agent_id/);
	});

	it('405s an unsupported verb', async () => {
		const res = fakeRes();
		await follow(fakeReq('/api/oracle/follow', { method: 'PUT', body: {} }), res);
		expect(res._json.status).toBe(405);
	});
});
