// HTTP-level tests for GET /api/play/event-leaderboard, the read the in-world
// jobs board and the web event page both render.
//
// The ranking math has its own suite (tests/event-leaderboard.test.js); this one
// covers the handler around it: the no-event refusal, the wire shape of a live
// board, the pinned `you` row, the limit clamp, and the deliberate decision that
// an unparseable `account` degrades to an anonymous read rather than 400-ing a
// public page over one bad query parameter.
//
// Only the event window is stubbed (it is read from public/event.json on disk,
// which stays in its no-event state between events). The store and the ranking
// are the real modules: with Redis unconfigured the store keeps its rows in
// process, which is the same code path production takes during a Redis outage.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Readable } from 'node:stream';

const EVENT = {
	id: 'test-event-01',
	name: 'Test Event',
	startsAt: Date.now() - 60_000,
	endsAt: Date.now() + 3_600_000,
};

let configuredEvent = EVENT;
vi.mock('../api/_lib/event-config.js', () => ({
	eventConfig: () => configuredEvent,
	eventLiveNow: () => Boolean(configuredEvent),
	eventId: () => configuredEvent?.id || null,
}));

const { recordEventRun, __resetEventBoards } = await import('../api/_lib/event-leaderboard-store.js');
const { default: handler } = await import('../api/play/event-leaderboard.js');

function mockRes() {
	return {
		statusCode: 200, _headers: {}, _body: '', _ended: false,
		setHeader(k, v) { this._headers[k.toLowerCase()] = v; },
		getHeader(k) { return this._headers[k.toLowerCase()]; },
		end(b) { this._body = b || ''; this._ended = true; },
		get json() { try { return JSON.parse(this._body); } catch { return null; } },
	};
}

function mockReq(query = '') {
	const r = Readable.from([]);
	r.method = 'GET';
	r.url = '/api/play/event-leaderboard' + (query ? `?${query}` : '');
	r.headers = { origin: 'http://localhost:3000' };
	return r;
}

const read = async (query = '') => {
	const res = mockRes();
	await handler(mockReq(query), res);
	return res;
};

// Three runners with a clear order: runs first, then cash.
async function seed(count = 3) {
	for (let i = 0; i < count; i += 1) {
		const account = `wallet-${String(i).padStart(2, '0')}`;
		for (let run = 0; run <= i; run += 1) {
			await recordEventRun({
				eventId: EVENT.id, account, name: `Runner ${i}`,
				missionId: 'event-plaza-catch', gold: 100, at: 1_000 + run,
			});
		}
	}
}

beforeEach(() => {
	configuredEvent = EVENT;
	__resetEventBoards();
});

describe('GET /api/play/event-leaderboard', () => {
	it('refuses with 404 when no event is configured', async () => {
		configuredEvent = null;
		const res = await read();
		expect(res.statusCode).toBe(404);
		expect(res.json.error).toBe('no_event');
	});

	it('serves an event nobody has played as an empty board, not an error', async () => {
		const res = await read();
		expect(res.statusCode).toBe(200);
		expect(res.json.top).toEqual([]);
		expect(res.json.you).toBe(null);
		expect(res.json.players).toBe(0);
		expect(res.json.totalRuns).toBe(0);
	});

	it('returns the event window, the ranking and the manual-settlement notice', async () => {
		await seed();
		const res = await read();
		expect(res.statusCode).toBe(200);
		const body = res.json;
		expect(body.event.id).toBe(EVENT.id);
		expect(body.event.name).toBe(EVENT.name);
		expect(body.event.startsAt).toBe(new Date(EVENT.startsAt).toISOString());
		expect(body.event.live).toBe(true);
		expect(body.top.map((r) => r.runs)).toEqual([3, 2, 1]);
		expect(body.players).toBe(3);
		expect(body.totalRuns).toBe(6);
		// No prize is ever paid from this path.
		expect(body.prizes.settlement).toBe('manual');
	});

	it('never puts an account key on the wire', async () => {
		await seed();
		const res = await read('account=wallet-00');
		expect(res._body).not.toContain('wallet-00');
		expect(res.json.you.rank).toBe(3);
		expect(res.json.you.runs).toBe(1);
	});

	it('pins your own row even when you are outside the requested top', async () => {
		await seed();
		const res = await read('account=wallet-00&limit=1');
		expect(res.json.top).toHaveLength(1);
		expect(res.json.you.inTop).toBe(false);
		expect(res.json.you.rank).toBe(3);
	});

	it('treats an unparseable account as an anonymous read rather than a 400', async () => {
		await seed();
		const res = await read('account=' + encodeURIComponent('not a valid key!!'));
		expect(res.statusCode).toBe(200);
		expect(res.json.you).toBe(null);
		expect(res.json.top).toHaveLength(3);
	});

	it('clamps an absurd limit instead of dumping the whole board', async () => {
		await seed(12);
		const res = await read('limit=99999');
		expect(res.json.top.length).toBeLessThanOrEqual(100);
		expect(res.json.players).toBe(12);
	});

	it('refuses a non-GET verb', async () => {
		const res = mockRes();
		const req = mockReq();
		req.method = 'POST';
		await handler(req, res);
		expect(res.statusCode).toBe(405);
	});
});
