// Unit tests for GET /api/leaderboard/daily-match, the agents' Daily Match
// board. Every column is a COUNT/SUM over a real activity table for one UTC
// day; the handler's own job is the contract around that: clamping `limit`,
// scoring with the published weights, ranking, the yesterday winner, the live
// feed, CORS/caching, and refusing anything that is not a GET.
//
// Mocks: sql (the three queries the handler fires) and rate-limit. Offline.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const sqlQueue = [];
const sqlCalls = [];
vi.mock('../../api/_lib/db.js', () => ({
	sql: Object.assign(
		vi.fn((strings, ...vals) => {
			sqlCalls.push({ text: strings.join('?'), vals });
			return Promise.resolve(sqlQueue.length ? sqlQueue.shift() : []);
		}),
		{ transaction: vi.fn(async (fns) => { for (const f of fns) await f; }) },
	),
	isDbUnavailableError: () => false,
	isDbCapacityError: () => false,
}));

const rlState = { success: true, limit: 60, remaining: 0, reset: 0 };
vi.mock('../../api/_lib/rate-limit.js', () => ({
	limits: { publicIp: vi.fn(async () => rlState) },
	clientIp: vi.fn(() => '127.0.0.1'),
}));

const { default: handler } = await import('../../api/leaderboard/daily-match.js');

function makeRes() {
	return {
		statusCode: 200,
		_h: {},
		setHeader(k, v) { this._h[k.toLowerCase()] = v; },
		getHeader(k) { return this._h[k.toLowerCase()]; },
		end(body) { this._body = body; },
	};
}

async function call(query = {}, { method = 'GET', headers = {} } = {}) {
	const qs = new URLSearchParams(query).toString();
	const res = makeRes();
	await handler({ method, headers, query, url: `/api/leaderboard/daily-match${qs ? `?${qs}` : ''}` }, res);
	let body = null;
	try { body = JSON.parse(res._body); } catch { /* non-JSON bodies are asserted via statusCode */ }
	return { res, body };
}

const A1 = '00000000-0000-0000-0000-0000000000b1';
const A2 = '00000000-0000-0000-0000-0000000000b2';

// Shape of one standings row as the aggregate query returns it (pg gives the
// bigint sum back as a string, which is exactly what mapRow has to survive).
function row(agentId, over = {}) {
	return {
		agent_id: agentId,
		name: 'Agent ' + agentId.slice(-2),
		avatar_url: null,
		profile_image_url: null,
		actions: 0,
		launches: 0,
		trades: 0,
		sales: 0,
		pnl_lamports: '0',
		score: 0,
		...over,
	};
}

beforeEach(() => {
	sqlQueue.length = 0;
	sqlCalls.length = 0;
	rlState.success = true;
	delete rlState.reason;
});

describe('GET /api/leaderboard/daily-match: contract', () => {
	it('serves an empty board with the day window, weights, and CDN caching', async () => {
		const { res, body } = await call();
		expect(res.statusCode).toBe(200);
		expect(body.data.standings).toEqual([]);
		expect(body.data.yesterday_winner).toBeNull();
		expect(body.data.recent).toEqual([]);
		expect(body.data.weights).toEqual({ actions: 1, trades: 5, sales: 15, launches: 25 });
		// The window is a real UTC day that resets exactly 24h after it opened.
		const start = new Date(body.data.day_start);
		const end = new Date(body.data.resets_at);
		expect(start.getUTCHours()).toBe(0);
		expect(start.getUTCMinutes()).toBe(0);
		expect(end.getTime() - start.getTime()).toBe(86_400_000);
		expect(res.getHeader('cache-control')).toContain('s-maxage=30');
	});

	it('allows any origin, so the public board is fetchable cross-origin', async () => {
		await call({}, { headers: { origin: 'https://example.com' } });
		const { res } = await call({}, { headers: { origin: 'https://example.com' } });
		expect(res.getHeader('access-control-allow-origin')).toBe('*');
		expect(res.getHeader('access-control-allow-methods')).toBe('GET,OPTIONS');
	});

	it('refuses a non-GET method instead of running the aggregate', async () => {
		const { res, body } = await call({}, { method: 'POST' });
		expect(res.statusCode).toBe(405);
		expect(body.error).toBe('method_not_allowed');
		expect(sqlCalls).toHaveLength(0);
	});

	it('returns 429 with a retry hint when the public IP bucket is exhausted', async () => {
		rlState.success = false;
		const { res, body } = await call();
		expect(res.statusCode).toBe(429);
		expect(body.error).toBe('rate_limited');
		expect(sqlCalls).toHaveLength(0);
	});
});

describe('GET /api/leaderboard/daily-match: standings', () => {
	it('ranks in query order and maps every real output column', async () => {
		sqlQueue.push([
			row(A1, { actions: 4, launches: 1, trades: 2, sales: 1, pnl_lamports: '-2669993', score: 54 }),
			row(A2, { actions: 1, profile_image_url: 'https://cdn.example/a2.png', score: 1 }),
		]);
		sqlQueue.push([]); // yesterday
		sqlQueue.push([]); // recent feed

		const { body } = await call();
		expect(body.data.standings.map((r) => [r.rank, r.agent_id, r.score])).toEqual([
			[1, A1, 54],
			[2, A2, 1],
		]);
		expect(body.data.standings[0]).toMatchObject({
			actions: 4, launches: 1, trades: 2, sales: 1,
		});
		// Lamport P&L stays a string so a bigint never loses precision in JSON.
		expect(body.data.standings[0].pnl_lamports).toBe('-2669993');
		// The uploaded profile image wins over the generated avatar, and a row
		// with neither reports null rather than undefined.
		expect(body.data.standings[1].avatar_url).toBe('https://cdn.example/a2.png');
		expect(body.data.standings[0].avatar_url).toBeNull();
	});

	it('clamps limit into 1..50 and defaults a junk value to 20', async () => {
		const limitOf = async (q) => {
			sqlQueue.length = 0; sqlCalls.length = 0;
			await call(q);
			// Call 0 is today's standings; its last bound value is the LIMIT.
			return sqlCalls[0].vals[sqlCalls[0].vals.length - 1];
		};
		expect(await limitOf({})).toBe(20);
		expect(await limitOf({ limit: 'abc' })).toBe(20);
		expect(await limitOf({ limit: '0' })).toBe(20);
		expect(await limitOf({ limit: '-5' })).toBe(1);
		expect(await limitOf({ limit: '9999' })).toBe(50);
		expect(await limitOf({ limit: '7' })).toBe(7);
	});

	it('reads yesterday from the previous UTC day and returns its winner at rank 1', async () => {
		sqlQueue.push([]); // today: nobody shipped yet
		sqlQueue.push([row(A2, { actions: 3, score: 3 })]);
		sqlQueue.push([]);

		const { body } = await call();
		expect(body.data.standings).toEqual([]);
		expect(body.data.yesterday_winner).toMatchObject({ rank: 1, agent_id: A2, score: 3 });
		// The yesterday query is the same aggregate one day back, capped at one row.
		expect(sqlCalls[1].vals).toContain(1);
	});

	it('returns the live feed with its skill attribution normalized', async () => {
		sqlQueue.push([]);
		sqlQueue.push([]);
		sqlQueue.push([
			{ agent_id: A1, name: 'Agent b1', type: 'skill_call', source_skill: 'forge', created_at: '2026-08-13T04:00:00.000Z' },
			{ agent_id: A2, name: 'Agent b2', type: 'trade', source_skill: null, created_at: '2026-08-13T03:00:00.000Z' },
		]);

		const { body } = await call();
		expect(body.data.recent).toEqual([
			{ agent_id: A1, name: 'Agent b1', type: 'skill_call', source_skill: 'forge', at: '2026-08-13T04:00:00.000Z' },
			{ agent_id: A2, name: 'Agent b2', type: 'trade', source_skill: null, at: '2026-08-13T03:00:00.000Z' },
		]);
	});

	it('reads the feed from every source the board scores, not just agent_actions', async () => {
		await call();
		// Call 2 is the ticker. Reading only agent_actions used to leave an agent
		// that shipped a launch, a trade or a sale ranked on a board sitting next
		// to an empty "Live output" panel, which read as a broken page.
		const feedSql = sqlCalls[2].text;
		for (const table of [
			'agent_actions',
			'pump_agent_mints',
			'agent_sniper_positions',
			'pump_agent_trades',
			'skill_purchases',
		]) {
			expect(feedSql).toContain(table);
		}
		// Same UTC-day window and public-agent filter as the standings aggregate.
		expect(feedSql).toContain("date_trunc('day', now() at time zone 'utc')");
		expect(feedSql).toContain('i.is_public = true');
	});

	it('maps a feed built from mixed sources into one uniform ticker shape', async () => {
		sqlQueue.push([]);
		sqlQueue.push([]);
		sqlQueue.push([
			{ agent_id: A1, name: 'Agent b1', type: 'launch', source_skill: 'THREE', created_at: '2026-08-13T05:00:00.000Z' },
			{ agent_id: A2, name: 'Agent b2', type: 'sale', source_skill: 'create-3d-avatar', created_at: '2026-08-13T04:30:00.000Z' },
			{ agent_id: A1, name: 'Agent b1', type: 'buy', source_skill: null, created_at: '2026-08-13T04:00:00.000Z' },
		]);

		const { body } = await call();
		expect(body.data.recent.map((r) => r.type)).toEqual(['launch', 'sale', 'buy']);
		expect(body.data.recent[2].source_skill).toBeNull();
		expect(body.data.recent[0].at).toBe('2026-08-13T05:00:00.000Z');
	});
});
