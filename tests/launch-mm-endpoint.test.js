/**
 * Launch Copilot market-maker endpoint (api/launch/mm.js).
 *
 * Covers the HTTP surface itself rather than the rulebook (tests/market-maker.js
 * owns the policy math): what each verb validates, who it lets through, which
 * status a malformed request earns, and the SSE stream's teardown. The database
 * layer is driven through a queue of rows so the real handler and the real
 * api/_lib/market-maker.js queries run end to end.
 *
 * The stream case is the load-bearing one: a client that hangs up while the seed
 * query is still in flight must leave nothing armed behind it. Before the close
 * listener was attached ahead of that await, the hang-up fired with no listener
 * registered and the poller kept querying a dead socket for the full ten-minute
 * stream budget.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const sqlMock = vi.fn();
vi.mock('../api/_lib/db.js', () => ({
	sql: (...a) => sqlMock(...a),
	isDbUnavailableError: () => false,
	isDbCapacityError: () => false,
}));

const getSessionUserMock = vi.fn();
const authenticateBearerMock = vi.fn();
vi.mock('../api/_lib/auth.js', () => ({
	getSessionUser: (...a) => getSessionUserMock(...a),
	authenticateBearer: (...a) => authenticateBearerMock(...a),
	extractBearer: () => null,
}));

const requireCsrfMock = vi.fn(async () => true);
vi.mock('../api/_lib/csrf.js', () => ({ requireCsrf: (...a) => requireCsrfMock(...a) }));

vi.mock('../api/_lib/rate-limit.js', () => ({
	clientIp: () => '203.0.113.9',
	limits: {
		publicIp: async () => ({ success: true }),
		authIp: async () => ({ success: true }),
		walletRead: async () => ({ success: true }),
		mcpIp: async () => ({ success: true }),
	},
}));

vi.mock('../api/_lib/env.js', () => ({
	env: { APP_ORIGIN: 'http://localhost:3000', ISSUER: 'http://t', MCP_RESOURCE: 'http://t' },
}));

const { default: mmHandler } = await import('../api/launch/mm.js');
const { SOL } = await import('../api/_lib/market-maker.js');

const MINT = 'THREEagentmint11111111111111111111111111111';
const AGENT = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const OWNER = 'user-owner';

function mkReq({ method = 'GET', url = '/api/launch/mm', headers = {}, body = null } = {}) {
	const hdrs = { host: 'three.ws', ...headers };
	if (body != null && !hdrs['content-type']) hdrs['content-type'] = 'application/json';
	const listeners = new Map();
	return {
		method, url, headers: hdrs, destroyed: false,
		on(event, cb) {
			listeners.set(event, cb);
			if (event === 'data' && body != null) {
				const buf = Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
				queueMicrotask(() => { cb(buf); listeners.get('end')?.(); });
			}
			return this;
		},
		emitClose() { this.destroyed = true; listeners.get('close')?.(); },
		destroy() { this.destroyed = true; },
	};
}

function mkRes() {
	return {
		statusCode: 200, headers: {}, body: undefined, chunks: [],
		headersSent: false, writableEnded: false,
		setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
		getHeader(k) { return this.headers[k.toLowerCase()]; },
		writeHead(status, headers = {}) {
			this.statusCode = status;
			for (const [k, v] of Object.entries(headers)) this.setHeader(k, v);
			this.headersSent = true;
			return this;
		},
		flushHeaders() {},
		write(chunk) { this.chunks.push(String(chunk)); return true; },
		end(b) { if (b != null) this.body = b; this.headersSent = true; this.writableEnded = true; },
	};
}

const parse = (res) => (res.body ? JSON.parse(res.body) : undefined);

function policyRow(over = {}) {
	const now = new Date('2026-08-13T00:00:00.000Z');
	return {
		id: 'policy-1', mint: MINT, network: 'mainnet', agent_id: AGENT, user_id: OWNER,
		enabled: true, mode: 'live', preset: 'balanced', status: 'active', kill_switch: false,
		floor_price_sol: 0.0001, floor_band_pct: 5, take_profit_band_pct: 25, recycle_pct: 20,
		max_inventory_tokens: 0, graduation_action: 'provide_lp', graduation_status: null,
		graduation_signature: null, slippage_bps: 500, max_price_impact_pct: 8,
		min_action_interval_seconds: 60, max_volume_pct: 15,
		dip_buy_budget_lamports: String(SOL), daily_budget_lamports: String(2 * SOL),
		seed_lamports: '0', seed_done_at: null,
		realized_pnl_lamports: '0', sol_deployed_lamports: '0', sol_recovered_lamports: '0',
		inventory_tokens: 0, inventory_value_lamports: null, last_price_sol: null,
		last_action_at: null, last_action_side: null, last_eval_at: null, last_error: null,
		created_at: now, updated_at: now,
		...over,
	};
}

const launchRow = { agent_id: AGENT, user_id: OWNER, name: 'Three', symbol: 'THREE', network: 'mainnet' };

let sqlQueue = [];
beforeEach(() => {
	sqlQueue = [];
	sqlMock.mockReset().mockImplementation(() => Promise.resolve(sqlQueue.length ? sqlQueue.shift() : []));
	getSessionUserMock.mockReset().mockResolvedValue(null);
	authenticateBearerMock.mockReset().mockResolvedValue(null);
	requireCsrfMock.mockClear().mockResolvedValue(true);
});
afterEach(() => { vi.useRealTimers(); });

describe('GET /api/launch/mm: public policy read', () => {
	it('refuses a request with no mint, before touching the database', async () => {
		const res = mkRes();
		await mmHandler(mkReq({ url: '/api/launch/mm' }), res);
		expect(res.statusCode).toBe(400);
		expect(parse(res).error).toBe('invalid_mint');
		expect(sqlMock).not.toHaveBeenCalled();
	});

	it('refuses a mint that is not base58 in the right length band', async () => {
		const res = mkRes();
		await mmHandler(mkReq({ url: '/api/launch/mm?mint=not-a-mint' }), res);
		expect(res.statusCode).toBe(400);
		expect(parse(res).error).toBe('invalid_mint');
	});

	it('answers a coin with no maker attached with the preset catalog, not a 404', async () => {
		sqlQueue = [[]];
		const res = mkRes();
		await mmHandler(mkReq({ url: `/api/launch/mm?mint=${MINT}` }), res);
		expect(res.statusCode).toBe(200);
		const { data } = parse(res);
		expect(data.policy).toBeNull();
		expect(data.owned).toBe(false);
		expect(data.presets.length).toBeGreaterThan(0);
		expect(data.guards.max_volume_pct_ceiling).toBeGreaterThan(0);
	});

	it('never exposes the owning user id on the public view', async () => {
		sqlQueue = [[policyRow()]];
		const res = mkRes();
		await mmHandler(mkReq({ url: `/api/launch/mm?mint=${MINT}` }), res);
		expect(res.statusCode).toBe(200);
		const { data } = parse(res);
		expect(data.policy.id).toBe('policy-1');
		expect(data.policy.user_id).toBeUndefined();
		expect(data.owned).toBe(false);
	});

	it('reports state=1 budgets against the 24h spend ledger and the engine heartbeat', async () => {
		const beat = new Date(Date.now() - 10_000).toISOString();
		sqlQueue = [
			[policyRow()],                          // getPolicyByMint
			[],                                     // listActions
			[{ s: String(0.5 * SOL) }],             // getDeployedLamports24h
			[{ s: String(0.25 * SOL) }],            // getDefenseLamports24h
			[{ mode: 'live', last_beat_at: beat }], // getEngineLiveness
		];
		const res = mkRes();
		await mmHandler(mkReq({ url: `/api/launch/mm?mint=${MINT}&state=1` }), res);
		expect(res.statusCode).toBe(200);
		const { data } = parse(res);
		expect(data.budget.daily_spent_sol).toBe(0.5);
		expect(data.budget.daily_remaining_sol).toBe(1.5);
		expect(data.budget.dip_spent_sol).toBe(0.25);
		expect(data.budget.dip_remaining_sol).toBe(0.75);
		expect(data.engine.live).toBe(true);
		expect(data.actions).toEqual([]);
	});

	it('marks the launch owner as owned so the dashboard can offer the controls', async () => {
		getSessionUserMock.mockResolvedValue({ id: OWNER });
		sqlQueue = [[policyRow()], [launchRow]];
		const res = mkRes();
		await mmHandler(mkReq({ url: `/api/launch/mm?mint=${MINT}` }), res);
		expect(parse(res).data.owned).toBe(true);
	});
});

describe('GET /api/launch/mm?owner=1', () => {
	it('refuses an anonymous caller', async () => {
		const res = mkRes();
		await mmHandler(mkReq({ url: '/api/launch/mm?owner=1' }), res);
		expect(res.statusCode).toBe(401);
		expect(parse(res).error).toBe('unauthorized');
	});

	it('lists only the caller’s own policies', async () => {
		getSessionUserMock.mockResolvedValue({ id: OWNER });
		sqlQueue = [[policyRow()]];
		const res = mkRes();
		await mmHandler(mkReq({ url: '/api/launch/mm?owner=1' }), res);
		expect(res.statusCode).toBe(200);
		expect(parse(res).data.policies).toHaveLength(1);
	});
});

describe('POST /api/launch/mm', () => {
	const postReq = (over = {}) => mkReq({ method: 'POST', url: `/api/launch/mm?mint=${MINT}`, body: {}, ...over });

	it('refuses an anonymous caller', async () => {
		const res = mkRes();
		await mmHandler(postReq(), res);
		expect(res.statusCode).toBe(401);
	});

	it('answers a non-JSON body with 415, not a generic 400', async () => {
		getSessionUserMock.mockResolvedValue({ id: OWNER });
		const res = mkRes();
		await mmHandler(postReq({ headers: { 'content-type': 'application/x-www-form-urlencoded' } }), res);
		expect(res.statusCode).toBe(415);
		expect(parse(res).error_description).toMatch(/application\/json/);
	});

	it('refuses a caller who did not launch the coin here', async () => {
		getSessionUserMock.mockResolvedValue({ id: 'someone-else' });
		sqlQueue = [[], []]; // no owned launch, no existing policy
		const res = mkRes();
		await mmHandler(postReq({ body: { preset: 'balanced', floor_price_sol: 0.0001 } }), res);
		expect(res.statusCode).toBe(403);
		expect(parse(res).error).toBe('forbidden');
		expect(requireCsrfMock).not.toHaveBeenCalled();
	});

	it('rejects an unknown lifecycle action', async () => {
		getSessionUserMock.mockResolvedValue({ id: OWNER });
		const res = mkRes();
		await mmHandler(postReq({ url: `/api/launch/mm?mint=${MINT}&action=frobnicate` }), res);
		expect(res.statusCode).toBe(400);
		expect(parse(res).error).toBe('invalid_action');
		expect(sqlMock).not.toHaveBeenCalled();
	});

	it('404s a pause on a coin with no maker instead of creating one', async () => {
		getSessionUserMock.mockResolvedValue({ id: OWNER });
		sqlQueue = [[launchRow], []]; // owns the launch, no policy yet
		const res = mkRes();
		await mmHandler(postReq({ url: `/api/launch/mm?mint=${MINT}&action=pause` }), res);
		expect(res.statusCode).toBe(404);
		expect(parse(res).error).toBe('no_policy');
		// The upsert must never have run: no INSERT, only the two lookups.
		expect(sqlMock).toHaveBeenCalledTimes(2);
	});

	it('creates a policy for the launch owner and answers 201', async () => {
		getSessionUserMock.mockResolvedValue({ id: OWNER });
		sqlQueue = [[launchRow], [], [], [policyRow({ enabled: false, status: 'idle', mode: 'simulate' })]];
		const res = mkRes();
		await mmHandler(postReq({ body: { preset: 'balanced', floor_price_sol: 0.0001 } }), res);
		expect(res.statusCode).toBe(201);
		expect(parse(res).data.policy.mint).toBe(MINT);
		expect(requireCsrfMock).toHaveBeenCalled();
	});

	it('surfaces a guard refusal as its own status and code, not a 500', async () => {
		getSessionUserMock.mockResolvedValue({ id: OWNER });
		sqlQueue = [[launchRow], []];
		const res = mkRes();
		await mmHandler(postReq({ body: { floor_price_sol: 0.0001, min_action_interval_seconds: 1 } }), res);
		expect(res.statusCode).toBe(422);
		expect(parse(res).error).toBe('manipulation_guard');
	});

	it('pauses an existing maker without arming anything new', async () => {
		getSessionUserMock.mockResolvedValue({ id: OWNER });
		sqlQueue = [
			[launchRow], [policyRow()],
			[policyRow()], [policyRow({ enabled: false, status: 'paused' })],
		];
		const res = mkRes();
		await mmHandler(postReq({ url: `/api/launch/mm?mint=${MINT}&action=pause` }), res);
		expect(res.statusCode).toBe(200);
		expect(parse(res).data.policy.enabled).toBe(false);
		expect(parse(res).data.policy.status).toBe('paused');
	});

	it('routes a kill to the agent wallet’s audited withdraw flow', async () => {
		getSessionUserMock.mockResolvedValue({ id: OWNER });
		sqlQueue = [
			[launchRow], [policyRow()],
			[policyRow()], [policyRow({ enabled: false, kill_switch: true, status: 'killed' })],
		];
		const res = mkRes();
		await mmHandler(postReq({ url: `/api/launch/mm?mint=${MINT}&action=kill` }), res);
		expect(res.statusCode).toBe(200);
		const { data } = parse(res);
		expect(data.policy.kill_switch).toBe(true);
		expect(data.withdraw_url).toBe(`/agent/${AGENT}/wallet#withdraw`);
	});
});

describe('DELETE /api/launch/mm', () => {
	const delReq = (over = {}) => mkReq({ method: 'DELETE', url: `/api/launch/mm?mint=${MINT}`, ...over });

	it('refuses an anonymous caller', async () => {
		const res = mkRes();
		await mmHandler(delReq(), res);
		expect(res.statusCode).toBe(401);
	});

	it('is idempotent when nothing is attached', async () => {
		getSessionUserMock.mockResolvedValue({ id: OWNER });
		sqlQueue = [[]];
		const res = mkRes();
		await mmHandler(delReq(), res);
		expect(res.statusCode).toBe(200);
		expect(parse(res).data.removed).toBe(false);
	});

	it('refuses a caller who does not own the policy', async () => {
		getSessionUserMock.mockResolvedValue({ id: 'someone-else' });
		sqlQueue = [[policyRow()]];
		const res = mkRes();
		await mmHandler(delReq(), res);
		expect(res.statusCode).toBe(403);
		expect(requireCsrfMock).not.toHaveBeenCalled();
	});

	it('removes the owner’s policy and points them at the wallet', async () => {
		getSessionUserMock.mockResolvedValue({ id: OWNER });
		sqlQueue = [[policyRow()], []];
		const res = mkRes();
		await mmHandler(delReq(), res);
		expect(res.statusCode).toBe(200);
		expect(parse(res).data.removed).toBe(true);
		expect(parse(res).data.withdraw_url).toBe(`/agent/${AGENT}/wallet#withdraw`);
	});
});

describe('GET /api/launch/mm?stream=1: SSE feed', () => {
	it('404s a stream for a coin with no maker attached', async () => {
		sqlQueue = [[]];
		const res = mkRes();
		await mmHandler(mkReq({ url: `/api/launch/mm?stream=1&mint=${MINT}` }), res);
		expect(res.statusCode).toBe(404);
		expect(parse(res).error).toBe('not_found');
	});

	it('opens with the seeded action history in chronological order', async () => {
		const now = new Date('2026-08-13T00:00:00.000Z');
		sqlQueue = [
			[policyRow()],
			[
				{ id: 2, kind: 'defend_buy', side: 'buy', status: 'executed', sol_lamports: String(SOL / 2), created_at: now },
				{ id: 1, kind: 'skip', side: null, status: 'skipped', sol_lamports: null, created_at: now },
			],
		];
		const req = mkReq({ url: `/api/launch/mm?stream=1&mint=${MINT}` });
		const res = mkRes();
		const running = mmHandler(req, res);
		for (let i = 0; i < 30 && !res.chunks.length; i++) await Promise.resolve();
		req.emitClose();
		await running;
		expect(res.statusCode).toBe(200);
		expect(res.headers['content-type']).toMatch(/text\/event-stream/);
		const open = JSON.parse(res.chunks[0].match(/^event: open\ndata: (.*)\n\n$/)[1]);
		expect(open.actions.map((a) => a.id)).toEqual([1, 2]);
		expect(open.actions[1].sol).toBe(0.5);
	});

	it('answers a HEAD probe with the stream headers and no open socket', async () => {
		sqlQueue = [[policyRow()]];
		const res = mkRes();
		await mmHandler(mkReq({ method: 'HEAD', url: `/api/launch/mm?stream=1&mint=${MINT}` }), res);
		expect(res.statusCode).toBe(200);
		expect(res.headers['content-type']).toMatch(/text\/event-stream/);
		expect(res.writableEnded).toBe(true);
		expect(res.chunks).toEqual([]);
	});

	it('leaves no timer armed when the client hangs up during the seed query', async () => {
		vi.useFakeTimers();
		let releaseSeed;
		sqlMock.mockReset()
			.mockImplementationOnce(() => Promise.resolve([policyRow()]))
			.mockImplementationOnce(() => new Promise((resolve) => { releaseSeed = () => resolve([]); }));

		const req = mkReq({ url: `/api/launch/mm?stream=1&mint=${MINT}` });
		const res = mkRes();
		const running = mmHandler(req, res);
		for (let i = 0; i < 30 && !res.headersSent; i++) await Promise.resolve();
		expect(res.headersSent).toBe(true);

		req.emitClose();   // the client gives up while the seed query is still open
		releaseSeed();     // ...and only then does the database answer
		await running;

		expect(res.writableEnded).toBe(true);
		expect(res.chunks).toEqual([]);
		// No poll, no ping, no duration timer: an abandoned stream must not keep
		// querying for the rest of its ten-minute budget.
		expect(vi.getTimerCount()).toBe(0);
	});
});

describe('method handling', () => {
	it('answers a CORS preflight without running a branch', async () => {
		const res = mkRes();
		await mmHandler(mkReq({ method: 'OPTIONS', headers: { origin: 'https://three.ws' } }), res);
		expect(res.statusCode).toBe(204);
		expect(res.headers['access-control-allow-methods']).toBe('GET,POST,DELETE,OPTIONS');
	});

	it('answers an unsupported verb with 405 and an Allow header', async () => {
		const res = mkRes();
		await mmHandler(mkReq({ method: 'PUT', url: `/api/launch/mm?mint=${MINT}` }), res);
		expect(res.statusCode).toBe(405);
		expect(String(res.headers.allow)).toContain('DELETE');
	});
});
