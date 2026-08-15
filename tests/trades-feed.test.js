// Contract for GET /api/trades/feed, the public feed of notable closed exits.
//
// This is the platform's top-of-funnel surface, so every wrong answer here is a
// wrong answer in public. Four of them shipped at once:
//   - `min_pnl_pct=0` was rewritten to 10 by a `Number(x) || 10` default, so the
//     oracle coin drawer, which passes 0 to mean "every trade on this coin",
//     silently only ever saw the winners above 10%.
//   - `multiple` was exit/entry, but a position that took initials first rewrites
//     its cost basis and books only the closing leg's proceeds, so the feed
//     rendered "0.56x" beside "+88%" on the same row.
//   - A malformed `cursor` slipped past a prefix regex into a `::timestamptz`
//     cast, and a malformed `mint` was dropped, answering a coin-scoped request
//     with the whole platform feed.
//   - A blanket `.catch(() => [])` turned any database fault into a 200 with an
//     empty feed: no error, no alert, just a platform that looks like it has
//     never had a profitable trade.

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../api/_lib/http.js', async () => {
	const actual = await vi.importActual('../api/_lib/http.js');
	return {
		...actual,
		wrap: (fn) => fn,
		cors: () => false,
		method: () => true,
		rateLimited: (res) => { res._rateLimited = true; },
		json: (res, status, body, headers = {}) => { res._json = { status, body, headers }; return res; },
		error: (res, status, code, message) => {
			res._json = { status, body: { error: code, error_description: message } };
			return res;
		},
	};
});

vi.mock('../api/_lib/rate-limit.js', () => ({
	limits: { publicIp: vi.fn(async () => ({ success: true })) },
	clientIp: () => '1.2.3.4',
}));

// Every tagged-template read lands here. The handler builds three small SQL
// fragments (window / cursor / mint) before the feed query itself, so tests pick
// the main query out by the table it reads rather than by call index.
const sqlCalls = [];
let feedRows = [];
let feedError = null;
vi.mock('../api/_lib/db.js', () => ({
	sql: (strings, ...values) => {
		sqlCalls.push({ text: strings.join('?'), values });
		if (!strings.join('').includes('agent_sniper_positions pos')) return Promise.resolve([]);
		return feedError ? Promise.reject(feedError) : Promise.resolve(feedRows);
	},
	isDbUnavailableError: () => false,
	isDbCapacityError: () => false,
}));

import feed from '../api/trades/feed.js';

const THREE_MINT = 'FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump';
const AGENT_ID   = '0846c27e-6258-4859-bc1c-3148d59951c5';

// A position that took initials before its final exit: the basis left on the row
// is the moon bag's, the exit is the closing leg only, and the realized numbers
// are cumulative across both legs. Shape lifted from a live mainnet row.
function partialExitRow(overrides = {}) {
	return {
		id: 'c6ad1e50-3fcb-4d4a-9a19-2a4a0b7bbf16',
		mint: THREE_MINT,
		symbol: 'THREE',
		name: 'three.ws',
		network: 'mainnet',
		status: 'closed',
		exit_reason: 'trailing_stop',
		realized_pnl_lamports: '2339513',
		realized_pnl_pct: '87.93654170563242',
		entry_quote_lamports: '2660456',
		exit_quote_lamports: '1487868',
		buy_sig: 'buysig',
		sell_sig: 'sellsig',
		opened_at: '2026-08-15T00:14:15.507Z',
		closed_at: '2026-08-15T00:15:13.750Z',
		hold_seconds: 58,
		agent_id: AGENT_ID,
		agent_name: 'Moe Money AI',
		agent_avatar: null,
		agent_image: null,
		oracle_score: null,
		oracle_tier: null,
		oracle_category: null,
		image_uri: null,
		copier_count: '3',
		...overrides,
	};
}

function fakeRes() {
	return {
		statusCode: 200,
		_headers: {},
		setHeader(k, v) { this._headers[k.toLowerCase()] = v; },
		getHeader(k) { return this._headers[k.toLowerCase()]; },
		end() { this.writableEnded = true; },
	};
}

function fakeReq(url) {
	return { method: 'GET', url, headers: { host: 'three.ws' } };
}

function mainQuery() {
	return sqlCalls.find((c) => c.text.includes('agent_sniper_positions pos'));
}

beforeEach(() => {
	sqlCalls.length = 0;
	feedRows = [];
	feedError = null;
});

describe('GET /api/trades/feed', () => {
	it('shapes a closed position into a feed item with real trader and coin context', async () => {
		feedRows = [partialExitRow()];
		const res = fakeRes();
		await feed(fakeReq('/api/trades/feed?window=all&limit=40'), res);

		expect(res._json.status).toBe(200);
		const { body } = res._json;
		expect(body.count).toBe(1);
		expect(body.window).toBe('all');
		const item = body.items[0];
		expect(item.mint).toBe(THREE_MINT);
		expect(item.symbol).toBe('THREE');
		expect(item.agent_id).toBe(AGENT_ID);
		expect(item.agent_name).toBe('Moe Money AI');
		expect(item.copier_count).toBe(3);
		expect(item.entry_sol).toBeCloseTo(0.002660456, 9);
		expect(item.realized_pnl_sol).toBeCloseTo(0.002339513, 9);
		expect(item.realized_pnl_pct).toBeCloseTo(87.93654, 4);
		expect(item.hold_seconds).toBe(58);
		expect(item.closed_at).toBe('2026-08-15T00:15:13.750Z');
		// A short page does not advertise another one.
		expect(body.next_cursor).toBeNull();
	});

	it('derives `multiple` from the cumulative pct so it cannot contradict the pnl', async () => {
		feedRows = [partialExitRow()];
		const res = fakeRes();
		await feed(fakeReq('/api/trades/feed?window=all'), res);

		const item = res._json.body.items[0];
		// exit/entry on this row is 0.56, which is the closing leg alone. The
		// position returned +87.9%, so the honest multiple is 1.88.
		expect(item.multiple).toBe(1.88);
		expect(item.multiple).toBeGreaterThan(1);
		expect(item.exit_sol / item.entry_sol).toBeLessThan(1);
	});

	it('honors an explicit min_pnl_pct=0 instead of defaulting it back to 10', async () => {
		const res = fakeRes();
		await feed(fakeReq('/api/trades/feed?window=all&min_pnl_pct=0'), res);

		expect(res._json.body.min_pnl_pct).toBe(0);
		// The floor the query actually filtered on, not just the echoed field.
		expect(mainQuery().values).toContain(0);
	});

	it('still defaults min_pnl_pct to 10 when it is absent or unparseable', async () => {
		for (const qs of ['', '&min_pnl_pct=', '&min_pnl_pct=abc']) {
			sqlCalls.length = 0;
			const res = fakeRes();
			await feed(fakeReq(`/api/trades/feed?window=all${qs}`), res);
			expect(res._json.body.min_pnl_pct).toBe(10);
			expect(mainQuery().values).toContain(10);
		}
	});

	it('400s a malformed cursor instead of letting the timestamptz cast reject', async () => {
		const res = fakeRes();
		await feed(fakeReq('/api/trades/feed?cursor=2020-01-01Tgarbage'), res);

		expect(res._json.status).toBe(400);
		expect(res._json.body.error).toBe('validation_error');
		// The bad cursor must never have reached the database.
		expect(mainQuery()).toBeUndefined();
	});

	it('400s a malformed mint rather than answering with the whole platform feed', async () => {
		feedRows = [partialExitRow()];
		const res = fakeRes();
		await feed(fakeReq('/api/trades/feed?mint=not-a-base58-mint'), res);

		expect(res._json.status).toBe(400);
		expect(res._json.body.error).toBe('validation_error');
		expect(mainQuery()).toBeUndefined();
	});

	it('scopes a valid mint to that coin and drops the time window', async () => {
		feedRows = [partialExitRow()];
		const res = fakeRes();
		await feed(fakeReq(`/api/trades/feed?window=24h&mint=${THREE_MINT}`), res);

		expect(res._json.status).toBe(200);
		expect(res._json.body.mint).toBe(THREE_MINT);
		expect(res._json.body.window).toBe('all');
		// The mint reaches SQL through its own fragment, and no window fragment is
		// built alongside it.
		expect(sqlCalls.find((c) => c.text.includes('pos.mint =')).values).toContain(THREE_MINT);
		expect(sqlCalls.some((c) => c.text.includes('now() -'))).toBe(false);
	});

	it('excludes deleted agents and null exit timestamps from the public feed', async () => {
		const res = fakeRes();
		await feed(fakeReq('/api/trades/feed?window=all'), res);

		const text = mainQuery().text;
		expect(text).toContain('ai.deleted_at is null');
		expect(text).toContain('pos.closed_at is not null');
		// A stable tiebreaker, or the cursor walks a nondeterministic order.
		expect(text).toContain('order by pos.closed_at desc, pos.id desc');
	});

	it('advertises a cursor only when the page is full', async () => {
		feedRows = [partialExitRow(), partialExitRow({ id: 'b', closed_at: '2026-08-14T00:00:00.000Z' })];
		const res = fakeRes();
		await feed(fakeReq('/api/trades/feed?window=all&limit=2'), res);

		expect(res._json.body.count).toBe(2);
		expect(res._json.body.next_cursor).toBe('2026-08-14T00:00:00.000Z');
	});

	it('lets a database fault reach the error boundary instead of serving an empty feed', async () => {
		feedError = new Error('connection terminated unexpectedly');
		const res = fakeRes();

		await expect(feed(fakeReq('/api/trades/feed?window=all'), res)).rejects.toThrow(/connection terminated/);
		// The old `.catch(() => [])` answered 200 with count 0 here, which reads as
		// "no agent has ever turned a profit" and fires no alert.
		expect(res._json).toBeUndefined();
	});
});
