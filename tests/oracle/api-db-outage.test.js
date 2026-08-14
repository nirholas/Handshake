// Outage-honesty contract for the Oracle read APIs.
//
// These endpoints all wrapped their reads in a blanket `.catch()` that returned
// an empty result. That is right for a statement-level fault, but during a
// database CONNECTIVITY failure it turned "we cannot tell right now" into a
// confident wrong answer, and the CDN then cached it:
//
//   /api/oracle/feed         200 with an empty market, plus eight pointless
//                            scoreCoin() warm attempts per request
//   /api/oracle/categories   200 "no hot sectors", cached for 5 minutes
//   /api/oracle/agent-stats  200 "this agent has never traded", cached 60s,
//                            which is the public evidence copy-traders judge on
//   /api/oracle/follow GET   `following: false` to an actual subscriber
//   /api/oracle/follow POST  404 "agent not found" for an agent that exists
//   /api/oracle/follow DEL   `{ ok: true }` while the row survived, so the
//                            caller believed they had opted out and kept
//                            receiving alerts
//
// Each test below pins both halves of the contract: a connectivity failure
// propagates (wrap() turns it into the shared 503 + Retry-After), and an
// ordinary statement fault still degrades to the documented empty answer.

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../api/_lib/http.js', async () => {
	const actual = await vi.importActual('../../api/_lib/http.js');
	return {
		...actual,
		// wrap() is the layer under test's counterpart: it is what converts a
		// propagated connectivity failure into 503. Reduce it to identity here so
		// the assertion can be "the handler rejected" without pulling in the ops
		// alerting and Sentry side effects the real wrap() fires.
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

// The real classifier, a stubbed transport: the point of these tests is that the
// handlers route on isDbUnavailableError() correctly, so mocking that function
// would test nothing. `nextDbError` decides what the next tagged-template read
// rejects with (null = resolve empty).
let nextDbError = null;
vi.mock('../../api/_lib/db.js', async () => {
	const actual = await vi.importActual('../../api/_lib/db.js');
	return {
		...actual,
		sql: () => (nextDbError ? Promise.reject(nextDbError) : Promise.resolve([])),
	};
});

// A Neon transport failure, exactly as db.js classifies one.
const CONN_ERROR = new Error('Error connecting to database: fetch failed');
// A deterministic SQL bug. Never a 503: the empty-result degrade is correct here.
const STATEMENT_ERROR = new Error('column "nope" does not exist');

const storeBehaviour = { readFeed: async () => [] };
vi.mock('../../api/_lib/oracle/store.js', () => ({
	readFeed: (...args) => storeBehaviour.readFeed(...args),
	convictionBacktest: async () => [],
	scoreCoin: async () => null,
	recentActions: async () => [],
	actionsSummary: async () => ({ total: 0, wins: 0, losses: 0, open: 0, win_rate: null }),
}));

vi.mock('../../api/_lib/oracle/sources.js', () => ({ recentMints: async () => [] }));

import { isDbUnavailableError } from '../../api/_lib/db.js';
import feed from '../../api/oracle/feed.js';
import categories from '../../api/oracle/categories.js';
import agentStats from '../../api/oracle/agent-stats.js';
import follow from '../../api/oracle/follow.js';

const AGENT_ID = '5e05f68f-eead-4ef9-b6b4-fc85ea73bbe9';

function fakeRes() {
	return {
		statusCode: 200,
		_headers: {},
		setHeader(k, v) { this._headers[k.toLowerCase()] = v; },
		getHeader(k) { return this._headers[k.toLowerCase()]; },
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
	nextDbError = null;
	storeBehaviour.readFeed = async () => [];
});

describe('the classifier these handlers branch on', () => {
	it('separates a connectivity failure from a statement fault', () => {
		expect(isDbUnavailableError(CONN_ERROR)).toBe(true);
		expect(isDbUnavailableError(new Error('Missing required env var: DATABASE_URL'))).toBe(true);
		expect(isDbUnavailableError(STATEMENT_ERROR)).toBe(false);
	});
});

describe('GET /api/oracle/feed', () => {
	it('propagates a connectivity failure instead of serving an empty market', async () => {
		storeBehaviour.readFeed = async () => { throw CONN_ERROR; };
		await expect(feed(fakeReq('/api/oracle/feed'), fakeRes())).rejects.toThrow(/connecting to database/);
	});

	it('still degrades a statement fault to an empty feed', async () => {
		storeBehaviour.readFeed = async () => { throw STATEMENT_ERROR; };
		const res = fakeRes();
		await feed(fakeReq('/api/oracle/feed'), res);
		expect(res._json.status).toBe(200);
		expect(res._json.body.items).toEqual([]);
	});
});

describe('GET /api/oracle/categories', () => {
	it('propagates a connectivity failure rather than CDN-caching a dead market', async () => {
		nextDbError = CONN_ERROR;
		await expect(categories(fakeReq('/api/oracle/categories'), fakeRes())).rejects.toThrow(/connecting to database/);
	});

	it('still degrades a statement fault to an empty panel', async () => {
		nextDbError = STATEMENT_ERROR;
		const res = fakeRes();
		await categories(fakeReq('/api/oracle/categories'), res);
		expect(res._json.status).toBe(200);
		expect(res._json.body.items).toEqual([]);
	});
});

describe('GET /api/oracle/agent-stats', () => {
	it('propagates a connectivity failure instead of publishing "never traded"', async () => {
		nextDbError = CONN_ERROR;
		await expect(agentStats(fakeReq(`/api/oracle/agent-stats?agent_id=${AGENT_ID}`), fakeRes()))
			.rejects.toThrow(/connecting to database/);
	});

	it('still answers 200 with an empty record when only the identity row is missing', async () => {
		const res = fakeRes();
		await agentStats(fakeReq(`/api/oracle/agent-stats?agent_id=${AGENT_ID}`), res);
		expect(res._json.status).toBe(200);
		expect(res._json.body.agent.name).toBeNull();
		expect(res._json.body.summary.total).toBe(0);
	});
});

describe('/api/oracle/follow', () => {
	it('GET propagates a connectivity failure instead of reporting following: false', async () => {
		nextDbError = CONN_ERROR;
		await expect(follow(fakeReq(`/api/oracle/follow?agent_id=${AGENT_ID}&chat_id=12345`), fakeRes()))
			.rejects.toThrow(/connecting to database/);
	});

	it('POST propagates a connectivity failure instead of answering "agent not found"', async () => {
		nextDbError = CONN_ERROR;
		const req = fakeReq('/api/oracle/follow', { method: 'POST', body: { agent_id: AGENT_ID, chat_id: '12345' } });
		await expect(follow(req, fakeRes())).rejects.toThrow(/connecting to database/);
	});

	it('DELETE propagates a failed delete instead of confirming an unsubscribe that never ran', async () => {
		nextDbError = CONN_ERROR;
		const req = fakeReq('/api/oracle/follow', { method: 'DELETE', body: { agent_id: AGENT_ID, chat_id: '12345' } });
		await expect(follow(req, fakeRes())).rejects.toThrow(/connecting to database/);
	});

	it('GET still answers 200 following: false when the subscription genuinely is absent', async () => {
		const res = fakeRes();
		await follow(fakeReq(`/api/oracle/follow?agent_id=${AGENT_ID}&chat_id=12345`), res);
		expect(res._json.status).toBe(200);
		expect(res._json.body.following).toBe(false);
	});
});
