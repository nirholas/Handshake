// POST /api/internal/event-score, the world server's write path into the live
// event leaderboard.
//
// The store's own maths is covered in tests/event-leaderboard.test.js; what is
// covered here is the endpoint's gate, the part that decides whether a reported
// run is allowed to score at all. Four independent locks have to hold: a valid
// world-service token, a configured event, an open window, and a mission the quest
// engine actually marks `event: true`. A hole in any one of them lets a leaked
// token stuff a board.
//
// The event window is injected through a mocked eventConfig rather than by writing
// public/event.json, so the suite neither depends on a real event being scheduled
// nor turns one on for every other surface that reads that file. Redis is never
// touched: recordEventRun folds through the real applyEventRun into a local map,
// so the record the endpoint echoes back is the record the store would have built.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { applyEventRun, emptyEventRecord } from '../multiplayer/src/event-leaderboard.js';

const verifyWorldServiceTokenMock = vi.fn();
vi.mock('../api/_lib/world-service-auth.js', () => ({
	verifyWorldServiceToken: (...a) => verifyWorldServiceTokenMock(...a),
}));

const eventConfigMock = vi.fn();
vi.mock('../api/_lib/event-config.js', () => ({
	eventConfig: (...a) => eventConfigMock(...a),
}));

const board = new Map(); // account -> record
const recordEventRunMock = vi.fn(async ({ account, name, missionId, gold, at }) => {
	const rec = applyEventRun(board.get(account) || emptyEventRecord(account, name), {
		missionId,
		gold,
		at,
		name,
	});
	board.set(account, rec);
	return { record: rec, durable: false };
});
vi.mock('../api/_lib/event-leaderboard-store.js', async (importOriginal) => ({
	...(await importOriginal()),
	recordEventRun: (...a) => recordEventRunMock(...a),
}));

const { default: handler } = await import('../api/internal/event-score.js');

function mkReq({ method = 'POST', url = '/api/internal/event-score', headers = {}, body = null } = {}) {
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

const AUTH = { authorization: 'Bearer faketoken' };
const ACCOUNT = 'probe:runner';
const MISSION = 'event-supply-run';

function liveWindow(now = Date.now()) {
	return { id: 'unit-event', name: 'Unit event', startsAt: now - 3600_000, endsAt: now + 3600_000 };
}

async function post(body, headers = AUTH) {
	const res = mkRes();
	await handler(mkReq({ headers, body }), res);
	return res;
}

beforeEach(() => {
	board.clear();
	recordEventRunMock.mockClear();
	verifyWorldServiceTokenMock.mockReset().mockResolvedValue(null);
	eventConfigMock.mockReset().mockReturnValue(liveWindow());
});

describe('POST /api/internal/event-score', () => {
	it('scores a run reported by the world server and echoes the updated row', async () => {
		verifyWorldServiceTokenMock.mockResolvedValue({ svc: 'world' });
		const res = await post({
			eventId: 'unit-event',
			account: ACCOUNT,
			name: 'Runner',
			missionId: MISSION,
			gold: 250,
		});
		expect(res.statusCode).toBe(200);
		expect(parse(res)).toEqual({
			ok: true,
			durable: false,
			eventId: 'unit-event',
			runs: 1,
			cash: 250,
		});
		expect(recordEventRunMock).toHaveBeenCalledTimes(1);
		expect(recordEventRunMock.mock.calls[0][0]).toMatchObject({
			eventId: 'unit-event',
			account: ACCOUNT,
			missionId: MISSION,
			gold: 250,
		});
	});

	it('counts a repeat of the same job as a separate run', async () => {
		verifyWorldServiceTokenMock.mockResolvedValue({ svc: 'world' });
		await post({ account: ACCOUNT, name: 'Runner', missionId: MISSION, gold: 250 });
		const res = await post({ account: ACCOUNT, name: 'Runner', missionId: MISSION, gold: 40 });
		expect(parse(res)).toMatchObject({ runs: 2, cash: 290 });
	});

	it('takes the configured event id when the report omits one', async () => {
		verifyWorldServiceTokenMock.mockResolvedValue({ svc: 'world' });
		const res = await post({ account: ACCOUNT, missionId: MISSION });
		expect(parse(res)).toMatchObject({ ok: true, eventId: 'unit-event' });
	});

	it('rejects a report with no valid world-service token', async () => {
		const res = await post({ account: ACCOUNT, missionId: MISSION }, {});
		expect(res.statusCode).toBe(401);
		expect(parse(res).error).toBe('unauthorized');
		expect(recordEventRunMock).not.toHaveBeenCalled();
	});

	it('scores nothing when no event is configured', async () => {
		verifyWorldServiceTokenMock.mockResolvedValue({ svc: 'world' });
		eventConfigMock.mockReturnValue(null);
		const res = await post({ account: ACCOUNT, missionId: MISSION });
		expect(res.statusCode).toBe(409);
		expect(parse(res).error).toBe('no_event');
		expect(recordEventRunMock).not.toHaveBeenCalled();
	});

	it('refuses a run reported against some other event', async () => {
		verifyWorldServiceTokenMock.mockResolvedValue({ svc: 'world' });
		const res = await post({ eventId: 'a-different-event', account: ACCOUNT, missionId: MISSION });
		expect(res.statusCode).toBe(409);
		expect(parse(res).error).toBe('event_mismatch');
		expect(recordEventRunMock).not.toHaveBeenCalled();
	});

	it('refuses a run reported outside the event window', async () => {
		verifyWorldServiceTokenMock.mockResolvedValue({ svc: 'world' });
		const now = Date.now();
		eventConfigMock.mockReturnValue({ id: 'unit-event', name: 'Unit event', startsAt: now - 7200_000, endsAt: now - 3600_000 });
		const res = await post({ account: ACCOUNT, missionId: MISSION });
		expect(res.statusCode).toBe(409);
		expect(parse(res).error).toBe('event_closed');
		expect(recordEventRunMock).not.toHaveBeenCalled();
	});

	it('refuses a mission the quest engine does not mark as an event job', async () => {
		verifyWorldServiceTokenMock.mockResolvedValue({ svc: 'world' });
		for (const missionId of ['', 'not-a-mission', 'daily-sweep']) {
			const res = await post({ account: ACCOUNT, missionId });
			expect(res.statusCode).toBe(400);
			expect(parse(res).error_description).toBe('missionId must be an event mission');
		}
		expect(recordEventRunMock).not.toHaveBeenCalled();
	});

	it('refuses an account key that could not have come from a real player', async () => {
		verifyWorldServiceTokenMock.mockResolvedValue({ svc: 'world' });
		for (const account of ['', '   ', 'has space', 'x'.repeat(97)]) {
			const res = await post({ account, missionId: MISSION });
			expect(res.statusCode).toBe(400);
			expect(parse(res).error_description).toBe('account required');
		}
		expect(recordEventRunMock).not.toHaveBeenCalled();
	});

	it('clamps a junk gold value instead of poisoning the row', async () => {
		verifyWorldServiceTokenMock.mockResolvedValue({ svc: 'world' });
		for (const gold of [-500, 'lots', null, undefined]) {
			board.clear();
			const res = await post({ account: ACCOUNT, missionId: MISSION, gold });
			expect(parse(res)).toMatchObject({ ok: true, runs: 1, cash: 0 });
		}
	});

	it('truncates an oversized display name rather than storing it whole', async () => {
		verifyWorldServiceTokenMock.mockResolvedValue({ svc: 'world' });
		await post({ account: ACCOUNT, name: 'N'.repeat(200), missionId: MISSION });
		expect(recordEventRunMock.mock.calls[0][0].name).toHaveLength(24);
	});

	it('answers 405 to a read and never scores on one', async () => {
		const res = mkRes();
		await handler(mkReq({ method: 'GET', headers: AUTH }), res);
		expect(res.statusCode).toBe(405);
		expect(recordEventRunMock).not.toHaveBeenCalled();
	});
});
