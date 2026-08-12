// Regression cover for the /api/demo/* handlers.
//
// Three defects motivated these tests, all of them invisible until a caller
// supplied input the happy path never produced:
//
//  1. `?limit=abc` parsed to NaN and `?limit=-5` / `?limit=0` passed straight
//     through, so each reached the SQL LIMIT clause as an invalid value and
//     turned a malformed query string into a 500 instead of a 4xx.
//  2. The OG card resolved the active coin twice per render (a ternary whose
//     `||` bound looser than its `===`), doubling the DB round-trips on every
//     social-scraper hit of the un-parameterised brand card.
//  3. /api/demo/economy?status=1 returned before the rate limiter ran, leaving
//     two Solana RPC balance reads plus a price lookup unmetered per request.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const MINT = 'THREEsynthetic1111111111111111111111111111';

// Captures every tagged-template query the handlers issue, with the interpolated
// values, so a test can assert what actually reached the LIMIT clause.
const queries = [];
const rows = [];
vi.mock('../api/_lib/db.js', () => ({
	sql: (strings, ...values) => {
		queries.push({ text: strings.join('?'), values });
		return Promise.resolve(rows.shift() ?? []);
	},
}));

const listActiveCoins = vi.fn();
const loadCoinByMint = vi.fn();
vi.mock('../api/_lib/coin/index.js', () => ({
	listActiveCoins: (...a) => listActiveCoins(...a),
	loadCoinByMint: (...a) => loadCoinByMint(...a),
}));

const publicIp = vi.fn(async () => ({ success: true, limit: 60, remaining: 59, reset: Date.now() + 60_000 }));
vi.mock('../api/_lib/rate-limit.js', () => ({
	limits: { publicIp: (...a) => publicIp(...a) },
	clientIp: () => '127.0.0.1',
}));

const { default: action } = await import('../api/demo/coin/[action].js');

const COIN = {
	id: 7,
	mint: MINT,
	symbol: 'THREE',
	name: 'three.ws demo',
	network: 'solana',
	is_live: true,
	min_holder_balance: '1000',
	draw_interval_seconds: 3600,
	reflection_interval_seconds: 600,
	lottery_pot_lamports: '5000000000',
	reflection_pot_lamports: '2500000000',
	ops_pot_lamports: '100000000',
	total_claimed_lamports: '7600000000',
	lottery_bps: 5000,
	reflection_bps: 4000,
	ops_bps: 1000,
};

function mkReq(query = {}) {
	return { method: 'GET', url: '/api/demo/coin/x', headers: {}, query };
}
function mkRes() {
	return {
		statusCode: 200,
		headers: {},
		body: undefined,
		headersSent: false,
		writableEnded: false,
		setHeader(k, v) {
			this.headers[k.toLowerCase()] = v;
		},
		getHeader(k) {
			return this.headers[k.toLowerCase()];
		},
		writeHead(code, hdrs) {
			this.statusCode = code;
			Object.assign(this.headers, hdrs || {});
			return this;
		},
		end(b) {
			this.body = b;
			this.writableEnded = true;
			this.headersSent = true;
		},
	};
}
const payload = (res) => (res.body ? JSON.parse(res.body) : undefined);

// The value the handler handed to the SQL LIMIT clause, from the last query issued.
const lastLimit = () => queries.at(-1).values.at(-1);

beforeEach(() => {
	queries.length = 0;
	rows.length = 0;
	listActiveCoins.mockReset().mockResolvedValue([COIN]);
	loadCoinByMint.mockReset().mockResolvedValue(COIN);
	publicIp.mockClear();
});

describe('GET /api/demo/coin/:action limit handling', () => {
	// Each row is [querystring limit, expected value reaching SQL].
	// Non-numeric and out-of-range input must land on a usable integer, never
	// NaN / 0 / a negative, all three of which make Postgres reject the query.
	it.each([
		['abc', 20],
		['-5', 1],
		['0', 1],
		['', 20],
		[undefined, 20],
		['9999', 100],
		['25', 25],
	])('winners?limit=%s clamps to %s', async (limit, expected) => {
		rows.push([]);
		const res = mkRes();
		await action(mkReq({ action: 'winners', mint: MINT, ...(limit === undefined ? {} : { limit }) }), res);

		expect(res.statusCode).toBe(200);
		expect(lastLimit()).toBe(expected);
		expect(Number.isSafeInteger(lastLimit())).toBe(true);
		expect(lastLimit()).toBeGreaterThan(0);
	});

	it('applies each action its own maximum', async () => {
		// holders allows up to 500, events up to 200. A shared cap would silently
		// truncate the holder table on a page that legitimately asks for more.
		rows.push([]);
		await action(mkReq({ action: 'holders', mint: MINT, limit: '9999' }), mkRes());
		expect(lastLimit()).toBe(500);

		rows.push([]);
		await action(mkReq({ action: 'events', mint: MINT, limit: '9999' }), mkRes());
		expect(lastLimit()).toBe(200);
	});

	it('never lets a junk limit reach SQL on any paginated action', async () => {
		for (const act of ['history', 'events', 'winners', 'holders']) {
			queries.length = 0;
			rows.push([], [], []);
			const res = mkRes();
			await action(mkReq({ action: act, mint: MINT, limit: 'not-a-number' }), res);
			expect(res.statusCode, act).toBe(200);
			for (const q of queries) {
				const v = q.values.at(-1);
				expect(Number.isSafeInteger(v), `${act}: ${v}`).toBe(true);
				expect(v, act).toBeGreaterThan(0);
			}
		}
	});
});

describe('GET /api/demo/coin/:action routing and errors', () => {
	it('404s an unknown action without touching the database', async () => {
		const res = mkRes();
		await action(mkReq({ action: 'definitely-not-an-action' }), res);
		expect(res.statusCode).toBe(404);
		expect(payload(res).error).toBe('not_found');
		expect(queries).toHaveLength(0);
	});

	it('405s a non-GET method', async () => {
		const res = mkRes();
		const req = mkReq({ action: 'state' });
		req.method = 'POST';
		await action(req, res);
		expect(res.statusCode).toBe(405);
		expect(payload(res).error).toBe('method_not_allowed');
	});

	it('404s with a JSON envelope when no coin resolves', async () => {
		loadCoinByMint.mockResolvedValue(null);
		const res = mkRes();
		await action(mkReq({ action: 'state', mint: MINT }), res);
		expect(res.statusCode).toBe(404);
		expect(payload(res)).toMatchObject({ error: 'coin_not_found' });
	});

	it('400s a holder lookup with no wallet', async () => {
		const res = mkRes();
		await action(mkReq({ action: 'holder', mint: MINT }), res);
		expect(res.statusCode).toBe(400);
		expect(payload(res).error).toBe('validation_error');
	});

	it('429s with a Retry-After when the limiter rejects, before any query', async () => {
		publicIp.mockResolvedValueOnce({ success: false, limit: 60, remaining: 0, reset: Date.now() + 30_000 });
		const res = mkRes();
		await action(mkReq({ action: 'state', mint: MINT }), res);
		expect(res.statusCode).toBe(429);
		expect(payload(res).error).toBe('rate_limited');
		expect(res.getHeader('retry-after')).toBeDefined();
		expect(queries).toHaveLength(0);
	});
});
