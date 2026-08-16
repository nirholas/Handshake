// /api/showcase keyset pagination. The showcase pages the ERC-8004 agent index
// with a cursor, and the cursor is only as good as the sort key it encodes:
//
//   - `registered_at` is nullable (a third of the crawled index has no date), so
//     a row-comparison against a NULL sort key is NULL, not false, and the row
//     falls out of every page after the first. The handler folds NULL to
//     -infinity so the key is total.
//   - Postgres stores microseconds; a cursor rendered through a JS Date keeps
//     only milliseconds. Truncating the boundary repeats a row in ascending
//     order (an infinite next-page loop for the client) and skips one in
//     descending order. The cursor carries Postgres' own text rendering.
//   - LIMIT is a bigint upstream, so a fractional ?limit= has to be floored
//     before it becomes `LIMIT 2.5` and fails the query with 22P02.
//
// Network-free: the database and rate limiter are mocked, and what is under test
// is the cursor contract and the shape of the parameters the handler sends.

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { createServer } from 'node:http';

const DATED = {
	chain_id: 8453,
	agent_id: '46366',
	owner: '0xa17b6b1ae86f029a866b786672b03024ed504f7c',
	registry: '0x8004a169fb4a3325136eb29fa0ceb6d2e539a432',
	agent_uri: 'https://example.test/agent.json',
	name: 'Dated agent',
	description: null,
	image: null,
	glb_url: 'https://models.example.test/a.glb',
	services: [],
	x402_support: false,
	registered_block: '31000000',
	registered_tx: '0xabc',
	registered_at: '2026-05-02T00:11:14.638Z',
	sort_ts: '2026-05-02 00:11:14.638997+00',
};

// The crawler leaves registered_at NULL whenever the registry event carried no
// timestamp. Postgres renders the folded key as '-infinity'.
const UNDATED = {
	...DATED,
	agent_id: '46333',
	name: 'Undated agent',
	registered_at: null,
	sort_ts: '-infinity',
};

// Every call the handler makes, as [strings, ...values]. The rows query is
// always first, the COUNT second.
const calls = [];
let rowsResult = [DATED, UNDATED];

vi.mock('../../api/_lib/db.js', () => ({
	sql: vi.fn(async (...args) => {
		calls.push(args);
		return calls.length === 1 ? rowsResult : [{ count: rowsResult.length }];
	}),
	isDbUnavailableError: () => false,
}));

vi.mock('../../api/_lib/rate-limit.js', () => ({
	limits: { publicIp: vi.fn(async () => ({ success: true, limit: 60, remaining: 59, reset: 0 })) },
	clientIp: () => '127.0.0.1',
}));

let server;
let base;

beforeAll(async () => {
	const { default: handler } = await import('../../api/showcase.js');
	server = createServer((req, res) => handler(req, res));
	await new Promise((r) => server.listen(0, '127.0.0.1', r));
	base = `http://127.0.0.1:${server.address().port}`;
});

afterAll(() => server?.close());

beforeEach(() => {
	calls.length = 0;
	rowsResult = [DATED, UNDATED];
});

/** Values interpolated into the rows query, in order. */
const rowsParams = () => calls[0].slice(1);
const decode = (cursor) => Buffer.from(cursor, 'base64url').toString('utf8');

describe('/api/showcase keyset cursor', () => {
	it('carries the full microsecond sort key, not a millisecond JS Date', async () => {
		const r = await fetch(`${base}/api/showcase?limit=1`);
		expect(r.status).toBe(200);
		const body = await r.json();

		// Two rows came back for limit=1, so there is a next page.
		expect(body.agents).toHaveLength(1);
		expect(decode(body.next_cursor)).toBe('2026-05-02 00:11:14.638997+00|8453|46366');
	});

	it('pages past an agent with no registered_at instead of stranding it', async () => {
		rowsResult = [UNDATED, { ...UNDATED, agent_id: '46300' }];
		const r = await fetch(`${base}/api/showcase?sort=oldest&limit=1`);
		const body = await r.json();

		// The old encoder produced an empty timestamp here, which decoded to null
		// and answered the next page with a 400.
		expect(decode(body.next_cursor)).toBe('-infinity|8453|46333');

		calls.length = 0;
		const back = await fetch(`${base}/api/showcase?sort=oldest&limit=1&cursor=${body.next_cursor}`);
		expect(back.status).toBe(200);
		// The '-infinity' boundary reaches the query verbatim, so Postgres compares
		// it against the same folded key the ORDER BY uses.
		expect(rowsParams()).toContain('-infinity');
	});

	it('floors a fractional limit so LIMIT stays an integer', async () => {
		const r = await fetch(`${base}/api/showcase?limit=1.5`);
		expect(r.status).toBe(200);

		const limitParam = rowsParams().at(-1);
		expect(Number.isInteger(limitParam)).toBe(true);
		expect(limitParam).toBe(2); // floor(1.5) + 1 fetch-ahead row
	});

	it('falls back to the default limit for a limit that is not a number', async () => {
		await fetch(`${base}/api/showcase?limit=abc`);
		expect(rowsParams().at(-1)).toBe(25); // DEFAULT_LIMIT + 1
	});

	it('rejects a cursor that is not a decodable sort key', async () => {
		const r = await fetch(`${base}/api/showcase?cursor=%25%25%25`);
		expect(r.status).toBe(400);
		expect((await r.json()).error).toBe('validation_error');
		// Validation runs before any query: a bad cursor costs no database work.
		expect(calls).toHaveLength(0);
	});

	it('stops paging when the page is not full', async () => {
		rowsResult = [DATED];
		const body = await (await fetch(`${base}/api/showcase?limit=24`)).json();
		expect(body.next_cursor).toBeNull();
		expect(body.total).toBe(1);
	});
});
