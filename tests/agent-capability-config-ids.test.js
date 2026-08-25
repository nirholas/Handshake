// The launcher and market-maker config endpoints take agent and config ids
// straight from the query string or body into uuid columns. Before these
// guards a caller who typed a bad id got a 500 plus an ops page, when the
// truthful answer is a 400 they can act on. These tests pin the boundary:
// a malformed id never reaches a query, and the happy paths still work.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const sqlMock = vi.fn();
vi.mock('../api/_lib/db.js', () => ({
	sql: sqlMock,
	isDbUnavailableError: () => false,
	isDbCapacityError: () => false,
}));

const getSessionUserMock = vi.fn();
vi.mock('../api/_lib/auth.js', () => ({
	getSessionUser: (...a) => getSessionUserMock(...a),
	authenticateBearer: vi.fn(async () => null),
	extractBearer: vi.fn(() => null),
}));

// Mirror the real `limits` surface these handlers touch: GETs use the generous
// authed-read bucket and writes the strict credential bucket (376929cb1). A
// mock that only knows authIp makes every GET throw on `undefined()` inside
// wrap(), which reports as a 500 and hides the 400/200 this file exists to pin.
vi.mock('../api/_lib/rate-limit.js', () => ({
	limits: {
		authIp: vi.fn(async () => ({ success: true, reset: 1_000 })),
		authedReadIp: vi.fn(async () => ({ success: true, reset: 1_000 })),
	},
	clientIp: () => '203.0.113.8',
}));

vi.mock('../api/_lib/env.js', () => ({
	env: { APP_ORIGIN: 'http://localhost:3000', ISSUER: 'http://t', MCP_RESOURCE: 'http://t' },
}));

const { default: launcher } = await import('../api/agent/launcher.js');
const { default: marketMaker } = await import('../api/agent/market-maker.js');

const AGENT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CONFIG = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
// $THREE, the platform's own coin, as a real-shaped mint for the upsert path.
const THREE_MINT = 'FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump';

function mkReq({ method = 'GET', url = '/', headers = {}, body = null } = {}) {
	const hdrs = { ...headers };
	if (body != null && !hdrs['content-type']) hdrs['content-type'] = 'application/json';
	return {
		method, url, headers: hdrs,
		on(event, cb) {
			if (event === 'data' && body != null) {
				const buf = Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
				queueMicrotask(() => { cb(buf); this._endCb?.(); });
			} else if (event === 'end') this._endCb = cb;
		},
		destroy() {},
	};
}
function mkRes() {
	return {
		statusCode: 200, headers: {}, body: undefined, writableEnded: false,
		setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
		end(b) { this.body = b; this.writableEnded = true; },
	};
}
const parse = (res) => (res.body ? JSON.parse(res.body) : undefined);

let sqlQueue = [];
beforeEach(() => {
	sqlQueue = [];
	sqlMock.mockReset().mockImplementation(() => Promise.resolve(sqlQueue.length ? sqlQueue.shift() : []));
	getSessionUserMock.mockReset().mockResolvedValue({ id: 'user-1' });
});

describe('/api/agent/launcher id validation', () => {
	it('answers 400 for a non-uuid agentId on GET and never queries', async () => {
		const res = mkRes();
		await launcher(mkReq({ url: '/api/agent/launcher?agentId=not-a-uuid' }), res);
		expect(res.statusCode).toBe(400);
		expect(parse(res).error).toBe('invalid_agent_id');
		expect(sqlMock).not.toHaveBeenCalled();
	});

	it('answers 400 for a non-uuid config id on DELETE', async () => {
		const res = mkRes();
		await launcher(mkReq({ method: 'DELETE', url: '/api/agent/launcher?id=nope' }), res);
		expect(res.statusCode).toBe(400);
		expect(parse(res).error).toBe('invalid_id');
		expect(sqlMock).not.toHaveBeenCalled();
	});

	it('answers 400 for a non-uuid configId on the trigger action', async () => {
		const res = mkRes();
		await launcher(mkReq({
			method: 'POST',
			url: '/api/agent/launcher',
			body: { action: 'trigger', agentId: AGENT, configId: 'nope' },
		}), res);
		expect(res.statusCode).toBe(400);
		expect(parse(res).error).toBe('invalid_config_id');
		expect(sqlMock).not.toHaveBeenCalled();
	});

	it('still returns configs and launched coins for a well-formed owned agent', async () => {
		sqlQueue = [
			[{ id: AGENT }],                                   // ownership
			[{ id: CONFIG, agent_id: AGENT, enabled: true }],  // configs
			[{ id: 'coin-1', agent_id: AGENT }],               // coins
		];
		const res = mkRes();
		await launcher(mkReq({ url: `/api/agent/launcher?agentId=${AGENT}` }), res);
		expect(res.statusCode).toBe(200);
		const out = parse(res);
		expect(out.configs).toHaveLength(1);
		expect(out.coins).toHaveLength(1);
	});
});

describe('/api/agent/market-maker id validation', () => {
	it('answers 400 for a non-uuid agentId on GET and never queries', async () => {
		const res = mkRes();
		await marketMaker(mkReq({ url: '/api/agent/market-maker?agentId=not-a-uuid' }), res);
		expect(res.statusCode).toBe(400);
		expect(parse(res).error).toBe('validation_error');
		expect(sqlMock).not.toHaveBeenCalled();
	});

	it('answers 400 for a non-uuid config id on DELETE', async () => {
		const res = mkRes();
		await marketMaker(mkReq({ method: 'DELETE', url: '/api/agent/market-maker?id=nope' }), res);
		expect(res.statusCode).toBe(400);
		expect(sqlMock).not.toHaveBeenCalled();
	});

	it('answers 400 for a non-uuid agentId on POST before touching the database', async () => {
		const res = mkRes();
		await marketMaker(mkReq({
			method: 'POST',
			url: '/api/agent/market-maker',
			body: { agentId: 'nope', mint: THREE_MINT },
		}), res);
		expect(res.statusCode).toBe(400);
		expect(sqlMock).not.toHaveBeenCalled();
	});

	it('rejects a mint that is not a base-58 Solana address', async () => {
		const res = mkRes();
		await marketMaker(mkReq({
			method: 'POST',
			url: '/api/agent/market-maker',
			body: { agentId: AGENT, mint: 'not-a-mint' },
		}), res);
		expect(res.statusCode).toBe(400);
		expect(sqlMock).not.toHaveBeenCalled();
	});

	it('upserts a config for a well-formed owned agent and pins the network to a real cluster', async () => {
		sqlQueue = [
			[{ id: AGENT }],                                  // ownership
			[{ id: CONFIG, agent_id: AGENT, network: 'mainnet' }], // upsert
		];
		const res = mkRes();
		await marketMaker(mkReq({
			method: 'POST',
			url: '/api/agent/market-maker',
			body: { agentId: AGENT, mint: THREE_MINT, network: 'not-a-cluster' },
		}), res);
		expect(res.statusCode).toBe(200);
		expect(parse(res).config.id).toBe(CONFIG);
		// An unknown cluster name falls back to mainnet rather than writing a
		// config no worker would ever pick up.
		expect(sqlMock.mock.calls[1].slice(1)).toContain('mainnet');
		expect(sqlMock.mock.calls[1].slice(1)).not.toContain('not-a-cluster');
	});
});
