// IRL interactions privacy invariants (H1 — IRL-Hardening regression fence).
//
// /api/irl/interactions is the IRL feedback loop, and it touches money + location:
//   • a `pay` is the one caller-asserted type that names money, so it is recorded
//     ONLY with a real settlement signature + a $THREE/USDC mint;
//   • the stored lat/lng are the PIN's location (snapshotted server-side), never a
//     caller-supplied coordinate — a tap must not be able to assert "I was at X";
//   • the owner inbox (?mine=1) is null-guarded so an empty device token matches
//     nothing (a bare '' must not surface every legacy NULL-token row).
// This file pins those three so a regression goes red. DB / auth / limiter /
// notify / alerts mocked → fully offline.

import { describe, it, expect, vi, beforeEach } from 'vitest';

let pinRow = null;
let viewDupeRow = null;
let paySigDupeRow = null;
let lastInsert = null;     // bound values of the most recent INSERT
let mineQueries = [];      // bound values of every owner-feed (?mine=1) SELECT

const sqlMock = vi.fn((strings, ...values) => {
	const q = Array.isArray(strings) ? strings.join(' ') : String(strings);
	if (/FROM irl_pins[\s\S]*WHERE id =/i.test(q)) {
		return Promise.resolve(pinRow ? [pinRow] : []);
	}
	if (/SELECT id FROM irl_interactions[\s\S]*type = 'view'/i.test(q)) {
		return Promise.resolve(viewDupeRow ? [viewDupeRow] : []);
	}
	if (/type = 'pay' AND payload->>'signature'/i.test(q)) {
		return Promise.resolve(paySigDupeRow ? [paySigDupeRow] : []);
	}
	if (/INSERT INTO irl_interactions/i.test(q)) {
		lastInsert = { values };
		return Promise.resolve([{ id: 'ix-new', type: values[2], created_at: '2026-06-17T00:00:00Z' }]);
	}
	// Owner feed (?mine=1): the JOINed SELECT and the unread aggregate. Capture the
	// bound owner id + device token so the null-guard can be asserted.
	if (/FROM irl_interactions ix[\s\S]*JOIN irl_pins p/i.test(q)) {
		mineQueries.push(values);
		return Promise.resolve([]);
	}
	return Promise.resolve([]); // DDL, view_count UPDATE, etc.
});
vi.mock('../../api/_lib/db.js', () => ({ sql: (...a) => sqlMock(...a), isDbUnavailableError: () => false, isDbCapacityError: () => false }));

let sessionUser = null;
vi.mock('../../api/_lib/auth.js', () => ({ getSessionUser: vi.fn(async () => sessionUser) }));
vi.mock('../../api/_lib/rate-limit.js', () => ({
	limits: { irlInteractIp: vi.fn(async () => ({ success: true })) },
	clientIp: () => '127.0.0.1',
}));
vi.mock('../../api/_lib/notify.js', () => ({ insertNotification: vi.fn() }));
vi.mock('../../api/_lib/alerts.js', () => ({ sendOpsAlert: vi.fn() }));
// This spec is about what a pay stores, not about proving it: stub the on-chain
// check to a match so an unstubbed RPC read cannot turn every accepted pay into
// a 202 pending and hide the assertions behind it.
vi.mock('../../api/_lib/settlement-verify.js', () => ({
	verifySettlement: vi.fn(async () => ({ status: 'match' })),
}));

const { default: handler } = await import('../../api/irl/interactions.js');

const THREE_MINT = 'FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump';
const SOL_SIG = '5'.repeat(64);
const PIN_ID = '33333333-3333-4333-8333-333333333333';

function makeRes() {
	return {
		statusCode: 200, _h: {}, headersSent: false, writableEnded: false,
		setHeader(k, v) { this._h[k.toLowerCase()] = v; },
		end(body) { this.writableEnded = true; this._body = body; },
	};
}
async function call(method, { query = {}, body } = {}) {
	const res = makeRes();
	await handler({ method, url: '/api/irl/interactions', headers: { host: 'x' }, query, body }, res);
	let parsed = null; try { parsed = JSON.parse(res._body); } catch {}
	return { res, body: parsed };
}

beforeEach(() => {
	sqlMock.mockClear();
	sessionUser = null;
	pinRow = null;
	viewDupeRow = null;
	paySigDupeRow = null;
	lastInsert = null;
	mineQueries = [];
});

describe('POST pay — rejected without a valid signature + an allowed mint', () => {
	beforeEach(() => {
		pinRow = { id: PIN_ID, agent_id: 'a1', lat: 40.7128, lng: -74.006, user_id: 'owner', device_token: null };
	});

	it('400s a pay with no settlement signature, and inserts nothing', async () => {
		const { res, body } = await call('POST', {
			body: { pinId: PIN_ID, type: 'pay', currencyMint: THREE_MINT, amount: 1 },
		});
		expect(res.statusCode).toBe(400);
		expect(body.error).toMatch(/signature/i);
		expect(lastInsert).toBeNull();
	});

	it('400s a pay whose mint is neither $THREE nor USDC, and inserts nothing', async () => {
		const { res, body } = await call('POST', {
			body: { pinId: PIN_ID, type: 'pay', signature: SOL_SIG, currencyMint: 'SomeOtherMint1111111111111111111111111111111', amount: 1 },
		});
		expect(res.statusCode).toBe(400);
		expect(body.error).toMatch(/\$THREE or USDC/i);
		expect(lastInsert).toBeNull();
	});

	it('accepts a pay with a valid signature + the $THREE mint', async () => {
		const { res } = await call('POST', {
			body: { pinId: PIN_ID, type: 'pay', signature: SOL_SIG, currencyMint: THREE_MINT, amount: 1 },
		});
		expect(res.statusCode).toBe(201);
		expect(lastInsert).not.toBeNull();
	});
});

describe('POST — the stored coordinate is the PIN’s, never the caller’s', () => {
	it('snapshots lat/lng from the pin and ignores any caller-supplied position', async () => {
		pinRow = { id: PIN_ID, agent_id: 'a1', lat: 51.5074, lng: -0.1278, user_id: 'owner', device_token: null };
		await call('POST', {
			// A malicious caller tries to assert they were somewhere else entirely.
			body: { pinId: PIN_ID, type: 'tap', lat: 0, lng: 0, deviceToken: 'visitor-dev' },
		});
		expect(lastInsert).not.toBeNull();
		// INSERT columns: (pin_id, agent_id, type, message, viewer_user_id,
		//                  viewer_device, lat, lng, amount, currency_mint, payload, seen_at)
		const v = lastInsert.values;
		expect(v[6]).toBe(51.5074); // lat = pin's
		expect(v[7]).toBe(-0.1278); // lng = pin's
		// The caller's spoofed (0,0) was never persisted.
		expect(v[6]).not.toBe(0);
		expect(v[7]).not.toBe(0);
	});
});

describe('GET ?mine=1 — owner feed is null-guarded against an empty device token', () => {
	it('400s a caller with neither a session nor a device token; runs no feed query', async () => {
		const { res } = await call('GET', { query: { mine: '1' } });
		expect(res.statusCode).toBe(400);
		expect(mineQueries.length).toBe(0);
	});

	it('passes a NULL (not "") device token when the caller’s token is empty', async () => {
		// An empty-string token must collapse to NULL so the IS NOT NULL guard makes
		// it match nothing — never every legacy NULL-token row.
		const { res } = await call('GET', { query: { mine: '1', deviceToken: '' } });
		// No usable identifier → 400, and the feed query never ran with a '' clause.
		expect(res.statusCode).toBe(400);
		expect(mineQueries.length).toBe(0);
	});

	it('a real device token is passed through, the NULL session id stays NULL', async () => {
		await call('GET', { query: { mine: '1', deviceToken: 'real-device' } });
		expect(mineQueries.length).toBeGreaterThan(0);
		// Each captured query binds (ownerId, ownerDev) repeatedly; the owner id is
		// NULL for an anonymous caller and the device token is the literal one given.
		const flat = mineQueries.flat();
		expect(flat).toContain('real-device');
		expect(flat).toContain(null);     // ownerId NULL, never '' (a guessable match)
		expect(flat).not.toContain('');   // an empty string would widen the match
	});
});
