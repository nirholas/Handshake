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
//   /api/oracle/movers       200 "nothing is moving", cached 90s
//   /api/oracle/signal       `count: 0` to an autonomous agent, which reads it
//                            as a verdict and stands down
//   /api/oracle/social       `ok: true` with `mints_updated: 0` next to a
//                            populated `updated` array — a receipt for a write
//                            that never landed
//   /api/oracle/stats        "0 coins scored, 0 armed agents", cached 60s, on
//                            the oracle landing hero
//   /api/oracle/history      an empty series, so the sparkline drew a coin with
//                            no conviction movement
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
		oracleSocialIp: vi.fn(async () => ({ success: true })),
	},
	clientIp: () => '1.2.3.4',
}));

// The real classifier, a stubbed transport: the point of these tests is that the
// handlers route on isDbUnavailableError() correctly, so mocking that function
// would test nothing. `nextDbError` decides what the next tagged-template read
// rejects with (null = resolve empty).
// `dbQueue` overrides it per call, in order, for the handlers whose first read
// must succeed before the read under test fails (oracle/social looks the mints
// up, then writes them).
let nextDbError = null;
let dbQueue = [];
vi.mock('../../api/_lib/db.js', async () => {
	const actual = await vi.importActual('../../api/_lib/db.js');
	return {
		...actual,
		sql: () => {
			if (dbQueue.length) {
				const next = dbQueue.shift();
				return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
			}
			return nextDbError ? Promise.reject(nextDbError) : Promise.resolve([]);
		},
	};
});

// A Neon transport failure, shaped the way the driver actually throws one: the
// `name` field is load-bearing, because db.js only treats a connection-level
// message as an outage when it arrives on a NeonDbError (or a bare fetch
// TypeError). A plain Error with the same text is NOT an outage to the
// classifier, so a fixture without the name would silently test nothing.
const CONN_ERROR = Object.assign(new Error('Error connecting to database: fetch failed'), {
	name: 'NeonDbError',
});
// The other real-world outage shape: an unset or rotated DATABASE_URL, which
// makes the lazy client construction throw a plain Error.
const NO_URL_ERROR = new Error('Missing required env var: DATABASE_URL');
// A deterministic SQL bug. Never a 503: the empty-result degrade is correct here.
const STATEMENT_ERROR = new Error('column "nope" does not exist');

// The real store module on top of the mocked db.js above, so readScoreHistory's
// own guard is the thing under test rather than a stub of it. The named
// overrides after the spread keep the stubbed reads the older cases rely on.
const storeBehaviour = { readFeed: async () => [] };
vi.mock('../../api/_lib/oracle/store.js', async () => {
	const actual = await vi.importActual('../../api/_lib/oracle/store.js');
	return {
		...actual,
		readFeed: (...args) => storeBehaviour.readFeed(...args),
		convictionBacktest: async () => [],
		scoreCoin: async () => null,
		recentActions: async () => [],
		actionsSummary: async () => ({ total: 0, wins: 0, losses: 0, open: 0, win_rate: null }),
	};
});

vi.mock('../../api/_lib/oracle/sources.js', () => ({ recentMints: async () => [] }));

import { isDbUnavailableError } from '../../api/_lib/db.js';
import feed from '../../api/oracle/feed.js';
import categories from '../../api/oracle/categories.js';
import agentStats from '../../api/oracle/agent-stats.js';
import follow from '../../api/oracle/follow.js';
import movers from '../../api/oracle/movers.js';
import signal from '../../api/oracle/signal.js';
import social from '../../api/oracle/social.js';
import stats from '../../api/oracle/stats.js';
import history from '../../api/oracle/history.js';

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
	dbQueue = [];
	storeBehaviour.readFeed = async () => [];
});

describe('the classifier these handlers branch on', () => {
	it('separates a connectivity failure from a statement fault', () => {
		expect(isDbUnavailableError(CONN_ERROR)).toBe(true);
		expect(isDbUnavailableError(NO_URL_ERROR)).toBe(true);
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
		// Uses the unset-DATABASE_URL shape so both outage shapes are exercised.
		nextDbError = NO_URL_ERROR;
		const req = fakeReq('/api/oracle/follow', { method: 'DELETE', body: { agent_id: AGENT_ID, chat_id: '12345' } });
		await expect(follow(req, fakeRes())).rejects.toThrow(/DATABASE_URL/);
	});

	it('GET still answers 200 following: false when the subscription genuinely is absent', async () => {
		const res = fakeRes();
		await follow(fakeReq(`/api/oracle/follow?agent_id=${AGENT_ID}&chat_id=12345`), res);
		expect(res._json.status).toBe(200);
		expect(res._json.body.following).toBe(false);
	});
});

// The same contract, extended over the rest of the Oracle read surface. Each of
// these carried the identical blanket `.catch()` and the identical failure mode:
// a confident, CDN-cached wrong answer during a connectivity blip.
const THREE_MINT = 'FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump';

describe('GET /api/oracle/movers', () => {
	it('propagates a connectivity failure instead of CDN-caching a flat market', async () => {
		nextDbError = CONN_ERROR;
		await expect(movers(fakeReq('/api/oracle/movers'), fakeRes())).rejects.toThrow(/connecting to database/);
	});

	it('still degrades a statement fault to an empty board', async () => {
		nextDbError = STATEMENT_ERROR;
		const res = fakeRes();
		await movers(fakeReq('/api/oracle/movers'), res);
		expect(res._json.status).toBe(200);
		expect(res._json.body.items).toEqual([]);
		expect(res._json.body.count).toBe(0);
	});
});

describe('GET /api/oracle/signal', () => {
	it('propagates a connectivity failure instead of telling an agent there are no plays', async () => {
		storeBehaviour.readFeed = async () => { throw CONN_ERROR; };
		await expect(signal(fakeReq('/api/oracle/signal'), fakeRes())).rejects.toThrow(/connecting to database/);
	});

	it('still degrades a statement fault to an empty play list', async () => {
		storeBehaviour.readFeed = async () => { throw STATEMENT_ERROR; };
		const res = fakeRes();
		await signal(fakeReq('/api/oracle/signal'), res);
		expect(res._json.status).toBe(200);
		expect(res._json.body.plays).toEqual([]);
		expect(res._json.body.top).toBeNull();
	});
});

describe('POST /api/oracle/social', () => {
	const batch = { tweets: [{ text: '$THREE is live', url: 'https://x.com/i/status/1', metrics: { views: 10000, likes: 100, retweets: 20 } }] };

	it('propagates a connectivity failure on the mint lookup instead of discarding the batch', async () => {
		nextDbError = CONN_ERROR;
		const req = fakeReq('/api/oracle/social', { method: 'POST', body: batch });
		await expect(social(req, fakeRes())).rejects.toThrow(/connecting to database/);
	});

	it('propagates a failed upsert instead of receipting a write that never landed', async () => {
		dbQueue = [[{ mint: THREE_MINT, symbol: 'THREE' }], CONN_ERROR];
		const req = fakeReq('/api/oracle/social', { method: 'POST', body: batch });
		await expect(social(req, fakeRes())).rejects.toThrow(/connecting to database/);
	});

	it('receipts exactly what it wrote when the upsert lands', async () => {
		dbQueue = [[{ mint: THREE_MINT, symbol: 'THREE' }], []];
		const res = fakeRes();
		await social(fakeReq('/api/oracle/social', { method: 'POST', body: batch }), res);
		expect(res._json.status).toBe(200);
		expect(res._json.body.mints_updated).toBe(1);
		expect(res._json.body.updated).toHaveLength(1);
		expect(res._json.body.updated[0].mint).toBe(THREE_MINT);
	});

	it('still answers 200 when no known mint matches the mentioned symbols', async () => {
		const res = fakeRes();
		await social(fakeReq('/api/oracle/social', { method: 'POST', body: batch }), res);
		expect(res._json.status).toBe(200);
		expect(res._json.body.mints_updated).toBe(0);
		expect(res._json.body.symbols_found).toBe(1);
	});
});

describe('GET /api/oracle/stats', () => {
	it('propagates a connectivity failure instead of publishing "nothing was ever scored"', async () => {
		nextDbError = CONN_ERROR;
		await expect(stats(fakeReq('/api/oracle/stats'), fakeRes())).rejects.toThrow(/connecting to database/);
	});

	it('still degrades a statement fault to zeroed counters', async () => {
		nextDbError = STATEMENT_ERROR;
		const res = fakeRes();
		await stats(fakeReq('/api/oracle/stats'), res);
		expect(res._json.status).toBe(200);
		expect(res._json.body.scored_total).toBe(0);
		expect(res._json.body.win_rate).toBeNull();
	});
});

describe('GET /api/oracle/history', () => {
	it('propagates a connectivity failure instead of drawing a flat sparkline', async () => {
		nextDbError = CONN_ERROR;
		await expect(history(fakeReq(`/api/oracle/history?mint=${THREE_MINT}`), fakeRes()))
			.rejects.toThrow(/connecting to database/);
	});

	it('still degrades a statement fault to an empty series with no trend', async () => {
		nextDbError = STATEMENT_ERROR;
		const res = fakeRes();
		await history(fakeReq(`/api/oracle/history?mint=${THREE_MINT}`), res);
		expect(res._json.status).toBe(200);
		expect(res._json.body.points).toEqual([]);
		expect(res._json.body.trend).toBeNull();
	});
});
