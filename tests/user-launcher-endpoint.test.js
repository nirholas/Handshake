// Endpoint tests for /api/launcher/me: the request/response contract around the
// per-user Memetic Launcher config (the pure patch logic is covered separately in
// tests/user-launcher.test.js).
//
// http.js is the REAL module here: body reading, content-type negotiation, status
// codes, and JSON error shaping are exactly what these tests are pinning. Only the
// modules with real side effects (auth, rate limiter, DB, trend providers, LLM coin
// synthesis, Solana RPC) are mocked.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const sqlCalls = [];
let configRow;

vi.mock('../api/_lib/db.js', () => ({
	sql: (strings, ...values) => {
		const q = strings.join('?').replace(/\s+/g, ' ').trim();
		sqlCalls.push({ q, values });
		if (/^insert into launcher_config/i.test(q)) return Promise.resolve([]);
		if (/^select \* from launcher_config/i.test(q)) return Promise.resolve([configRow]);
		if (/^update launcher_config set paused/i.test(q)) {
			configRow = { ...configRow, paused: false, pause_reason: null };
			return Promise.resolve([configRow]);
		}
		if (/^update launcher_config set/i.test(q)) {
			const [enabled, dry_run, mode, sources, categories, cadence, maxPerHour, devBuy, cap, network] = values;
			configRow = {
				...configRow,
				enabled, dry_run, mode,
				sources: JSON.parse(sources), categories: JSON.parse(categories),
				target_cadence_seconds: cadence, max_per_hour: maxPerHour,
				dev_buy_sol: devBuy, daily_sol_cap: cap, network,
			};
			return Promise.resolve([configRow]);
		}
		if (/from launcher_runs where scope = 'user' and user_id = \? and created_at/i.test(q)) {
			return Promise.resolve([{ runs_today: 3, dry_runs_today: 2, launched_today: 1, skipped_today: 0, failed_today: 0 }]);
		}
		if (/from launcher_runs/i.test(q)) {
			return Promise.resolve([{ id: 'run1', agent_id: 'a1', kind: 'trend', name: 'Foam Party', symbol: 'FOAM', mint: null, status: 'dry_run', dry_run: true }]);
		}
		if (/from launcher_queue/i.test(q)) return Promise.resolve([{ enabled: 2 }]);
		if (/count\(\*\)::int as n from agent_identities/i.test(q)) return Promise.resolve([{ n: 4 }]);
		if (/from agent_identities/i.test(q)) {
			return Promise.resolve([
				{ id: 'a1', name: 'Scout', solana_address: 'THREEsynthetic1111111111111111111111111111' },
				{ id: 'a2', name: 'Drifter', solana_address: 'THREEsynthetic2222222222222222222222222222' },
			]);
		}
		throw new Error(`unexpected query: ${q}`);
	},
	isDbUnavailableError: () => false,
	isDbCapacityError: () => false,
}));

let sessionUser = null;
vi.mock('../api/_lib/auth.js', () => ({
	getSessionUser: vi.fn(async () => sessionUser),
	extractBearer: () => null,
	authenticateBearer: vi.fn(async () => null),
}));

vi.mock('../api/_lib/rate-limit.js', () => ({
	limits: { authIp: vi.fn(async () => ({ success: true })) },
	clientIp: () => '1.2.3.4',
}));

vi.mock('../api/_lib/launcher-trends.js', () => ({
	rankNarratives: vi.fn(async () => ({
		terms: [{ term: 'foam party girl', score: 2, sources: ['knowyourmeme'], kind: 'meme' }],
		top: { term: 'foam party girl', score: 2 },
		providers: ['knowyourmeme'],
	})),
}));

let previewCoin = { name: 'Foam Party Girl', symbol: 'FOAM', description: 'rides the wave', kind: 'meme', trigger_source: 'knowyourmeme', trigger_detail: { top_narrative: 'foam party girl' } };
vi.mock('../api/_lib/launcher-sources.js', () => ({
	pickSource: vi.fn(async () => previewCoin),
}));

vi.mock('../api/_lib/launcher-engine.js', () => ({
	LAUNCH_BASE_SOL: 0.02,
	SELF_FUND_FEE_BUFFER_SOL: 0.005,
}));

let balances = { THREEsynthetic1111111111111111111111111111: { sol: 0.5, usdc: 0 } };
vi.mock('../api/_lib/agent-wallet.js', () => ({
	getSolanaAddressBalances: vi.fn(async (address) => balances[address] || { sol: null, usdc: null }),
}));

const { default: handler } = await import('../api/launcher/me.js');

function fakeRes() {
	const res = {
		statusCode: 200,
		headers: {},
		headersSent: false,
		writableEnded: false,
		setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
		end(payload) { this.writableEnded = true; this.headersSent = true; this.raw = payload; },
	};
	Object.defineProperty(res, 'body', { get() { return this.raw ? JSON.parse(this.raw) : null; } });
	return res;
}

// Mirrors production: server/index.mjs's express body-parser stashes the exact
// bytes on req.rawBody before any handler runs, so readJson never touches the
// stream. Passing raw:null models a request that carries no body at all.
function fakeReq({ method = 'GET', contentType = null, raw = null, body } = {}) {
	const headers = {};
	if (contentType) headers['content-type'] = contentType;
	const buf = raw == null ? null : Buffer.from(raw, 'utf8');
	if (buf) headers['content-length'] = String(buf.length);
	const req = { method, url: '/api/launcher/me', headers };
	if (buf) req.rawBody = buf;
	if (body !== undefined) req.body = body;
	return req;
}

const jsonPost = (value) => fakeReq({ method: 'POST', contentType: 'application/json', raw: JSON.stringify(value) });

beforeEach(() => {
	sqlCalls.length = 0;
	sessionUser = { id: 'user-1' };
	previewCoin = { name: 'Foam Party Girl', symbol: 'FOAM', description: 'rides the wave', kind: 'meme', trigger_source: 'knowyourmeme', trigger_detail: { top_narrative: 'foam party girl' } };
	configRow = {
		scope: 'user', user_id: 'user-1', enabled: true, dry_run: false, paused: false, mode: 'hybrid',
		sources: ['coin_intel'], categories: [], target_cadence_seconds: 300, max_per_hour: 4,
		dev_buy_sol: 0.01, daily_sol_cap: 1, network: 'mainnet',
	};
});

describe('GET /api/launcher/me', () => {
	it('requires authentication', async () => {
		sessionUser = null;
		const res = fakeRes();
		await handler(fakeReq(), res);
		expect(res.statusCode).toBe(401);
		expect(res.body.error).toBe('unauthorized');
		expect(sqlCalls).toHaveLength(0);
	});

	it('returns the config, console, stats and live narratives', async () => {
		const res = fakeRes();
		await handler(fakeReq(), res);
		expect(res.statusCode).toBe(200);
		const b = res.body;
		expect(b.config).toMatchObject({ mode: 'hybrid', armed: true });
		expect(b.console[0]).toMatchObject({ symbol: 'FOAM' });
		expect(b.stats.runs_today).toBe(3);
		expect(b.queue_enabled).toBe(2);
		expect(b.eligible_agents).toBe(4);
		expect(b.per_launch_est_sol).toBeCloseTo(0.035, 6);
		expect(b.launch_overhead_sol).toBeCloseTo(0.025, 6);
		expect(b.narratives.terms[0].term).toBe('foam party girl');
	});

	it('still answers when the trend providers fail, with narratives null', async () => {
		const { rankNarratives } = await import('../api/_lib/launcher-trends.js');
		rankNarratives.mockRejectedValueOnce(new Error('all providers down'));
		const res = fakeRes();
		await handler(fakeReq(), res);
		expect(res.statusCode).toBe(200);
		expect(res.body.narratives).toBe(null);
		expect(res.body.config.armed).toBe(true);
	});
});

// A body this endpoint cannot read must never be swallowed into an empty patch:
// that answers 200 {ok:true} to a caller whose settings were dropped, and this
// config arms live SOL spend.
describe('POST /api/launcher/me: unreadable bodies', () => {
	it('rejects a patch sent under a non-JSON content-type instead of silently ignoring it', async () => {
		const res = fakeRes();
		await handler(fakeReq({ method: 'POST', contentType: 'text/plain', raw: '{"enabled":false}', body: '{"enabled":false}' }), res);
		expect(res.statusCode).toBe(415);
		expect(res.body.error).toBe('unsupported_media_type');
		expect(sqlCalls.some((c) => /^update launcher_config/i.test(c.q))).toBe(false);
	});

	it('rejects an unparseable JSON body with a 400', async () => {
		const res = fakeRes();
		await handler(fakeReq({ method: 'POST', contentType: 'application/json', raw: '{broken' }), res);
		expect(res.statusCode).toBe(400);
		expect(res.body.error).toBe('invalid_json');
		expect(sqlCalls.some((c) => /^update launcher_config/i.test(c.q))).toBe(false);
	});

	it('rejects a JSON body that is not an object', async () => {
		const res = fakeRes();
		await handler(jsonPost(['enabled']), res);
		expect(res.statusCode).toBe(400);
		expect(res.body.error).toBe('invalid_body');
	});

	it('accepts a bodiless POST as an empty patch that keeps the current config', async () => {
		const res = fakeRes();
		await handler(fakeReq({ method: 'POST' }), res);
		expect(res.statusCode).toBe(200);
		expect(res.body.config).toMatchObject({ mode: 'hybrid', enabled: true, dev_buy_sol: 0.01 });
	});
});

describe('POST /api/launcher/me: config patch', () => {
	it('persists a valid patch and echoes the shaped config', async () => {
		const res = fakeRes();
		await handler(jsonPost({ mode: 'trend', dry_run: true, dev_buy_sol: 0.05, sources: ['x', 'reddit'] }), res);
		expect(res.statusCode).toBe(200);
		expect(res.body.config).toMatchObject({ mode: 'trend', dry_run: true, dev_buy_sol: 0.05, armed: false });
		expect(res.body.config.sources).toEqual(['x', 'reddit']);
	});

	it('rejects an out-of-range live-spend field before writing', async () => {
		const res = fakeRes();
		await handler(jsonPost({ daily_sol_cap: 999 }), res);
		expect(res.statusCode).toBe(400);
		expect(res.body.error).toBe('invalid_daily_sol_cap');
		expect(sqlCalls.some((c) => /^update launcher_config/i.test(c.q))).toBe(false);
	});
});

describe('POST /api/launcher/me: actions', () => {
	it('previews a coin the launcher would mint right now', async () => {
		const res = fakeRes();
		await handler(jsonPost({ action: 'preview' }), res);
		expect(res.statusCode).toBe(200);
		expect(res.body.sample).toMatchObject({ symbol: 'FOAM', top_narrative: 'foam party girl' });
	});

	it('rejects a preview under an unknown mode rather than substituting one', async () => {
		const res = fakeRes();
		await handler(jsonPost({ action: 'preview', mode: 'nuke' }), res);
		expect(res.statusCode).toBe(400);
		expect(res.body.error).toBe('invalid_mode');
	});

	it('returns 503 when no sample can be synthesized', async () => {
		previewCoin = null;
		const res = fakeRes();
		await handler(jsonPost({ action: 'preview' }), res);
		expect(res.statusCode).toBe(503);
		expect(res.body.error).toBe('preview_unavailable');
	});

	it('reports funding per agent, leaving an unreadable balance null rather than a fake zero', async () => {
		const res = fakeRes();
		await handler(jsonPost({ action: 'funding' }), res);
		expect(res.statusCode).toBe(200);
		expect(res.body.per_launch_est_sol).toBeCloseTo(0.035, 6);
		expect(res.body.agents[0]).toMatchObject({ name: 'Scout', sol: 0.5, funded: true });
		expect(res.body.agents[1]).toMatchObject({ name: 'Drifter', sol: null, funded: false });
	});

	it('clears a tripped circuit breaker on resume', async () => {
		configRow = { ...configRow, paused: true, pause_reason: 'daily cap hit' };
		const res = fakeRes();
		await handler(jsonPost({ action: 'resume' }), res);
		expect(res.statusCode).toBe(200);
		expect(res.body.config).toMatchObject({ paused: false, pause_reason: null, armed: true });
	});
});
