// IRL privacy-center invariants (H5 — IRL-Hardening right-to-be-forgotten).
//
// Drives the REAL api/irl/privacy.js handler with a content-addressed SQL mock so
// the ownership + null-guard contract is pinned: a caller sees and erases ONLY
// their own data, an unidentified caller is rejected before any query runs, every
// delete cascades to irl_interactions and returns honest counts, and "forget this
// device" additionally purges the trail the device left on other people's pins.
//
// Fully offline: DB / auth / limiter / guardian all mocked. The mock differentiates
// each statement by content and records bound values, so we can assert the owner
// identifier is threaded into every WHERE (it never widens to another owner).

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Content-addressed SQL mock ──────────────────────────────────────────────
const calls = [];          // { q, values } for every statement the handler ran
const writes = [];         // tags for every mutating statement, in order
let summaryPinAgg = [{}];
let summaryInbox = [{ total: 0 }];
let summaryAuthored = [{ total: 0 }];
let exportPins = [];
let exportReceived = [];
let exportAuthored = [];
let updateResult = [];     // PATCH UPDATE RETURNING
let delIx = [];            // DELETE FROM irl_interactions (cascade / inbox) RETURNING
let delPins = [];          // DELETE FROM irl_pins RETURNING
let delAuthored = [];      // DELETE FROM irl_interactions (viewer_device) RETURNING

const P = (v) => Promise.resolve(v);

const sqlMock = vi.fn((strings, ...values) => {
	const raw = Array.isArray(strings) ? strings.join(' ') : String(strings);
	const q = raw.replace(/\s+/g, ' ').trim();
	calls.push({ q, values });

	// ── Summary aggregates ──
	if (/FILTER \(WHERE published IS FALSE\)/i.test(q)) return P(summaryPinAgg);
	if (/JOIN irl_pins/i.test(q) && /COUNT\(\*\)::int\s+AS total/i.test(q)) return P(summaryInbox);
	if (/FROM irl_interactions/i.test(q) && /viewer_device =/i.test(q) && /COUNT\(\*\)::int AS total/i.test(q)) {
		return P(summaryAuthored);
	}

	// ── Export selects ──
	if (/SELECT id, agent_id, lat, lng, heading/i.test(q)) return P(exportPins);
	if (/JOIN irl_pins/i.test(q) && /ix\.currency_mint/i.test(q)) return P(exportReceived);
	if (/SELECT id, pin_id, agent_id, type/i.test(q) && /viewer_device =/i.test(q)) return P(exportAuthored);

	// ── Mutations ──
	if (/UPDATE irl_pins/i.test(q)) { writes.push('update'); return P(updateResult); }
	if (/DELETE FROM irl_interactions/i.test(q)) {
		// The authored purge ("forget device") is the only interactions-delete keyed
		// on viewer_device with no pin_id clause.
		if (/viewer_device IS NOT NULL AND viewer_device =/i.test(q) && !/pin_id/i.test(q)) {
			writes.push('del-authored');
			return P(delAuthored);
		}
		writes.push('del-ix');
		return P(delIx);
	}
	if (/DELETE FROM irl_pins/i.test(q)) { writes.push('del-pins'); return P(delPins); }

	return P([]); // anything else
});
vi.mock('../../api/_lib/db.js', () => ({ sql: (...a) => sqlMock(...a), isDbUnavailableError: () => false, isDbCapacityError: () => false }));

let sessionUser = null;
vi.mock('../../api/_lib/auth.js', () => ({ getSessionUser: vi.fn(async () => sessionUser) }));
vi.mock('../../api/_lib/rate-limit.js', () => ({
	limits: { irlPinIp: vi.fn(async () => ({ success: true })) },
	clientIp: () => '127.0.0.1',
}));
vi.mock('../../api/_lib/granite-guardian.js', () => ({
	guardianConfig: () => ({ configured: false }), assess: vi.fn(), decide: vi.fn(),
}));

let handler;

function makeRes() {
	return {
		statusCode: 200, _h: {}, headersSent: false, writableEnded: false,
		setHeader(k, v) { this._h[k.toLowerCase()] = v; },
		getHeader(k) { return this._h[k.toLowerCase()]; },
		end(body) { this.writableEnded = true; this._body = body; },
	};
}
async function call(method, { query = {}, body, device } = {}) {
	const res = makeRes();
	const headers = { host: 'x' };
	if (device !== undefined) headers['x-irl-device'] = device;
	await handler({ url: '/api/irl/privacy', method, headers, query, body }, res);
	let parsed = null; try { parsed = JSON.parse(res._body); } catch {}
	return { res, body: parsed };
}

// Does any statement's bound values include this exact value?
const someValueIs = (v) => calls.some((c) => c.values.includes(v));

beforeEach(async () => {
	sqlMock.mockClear();
	calls.length = 0;
	writes.length = 0;
	sessionUser = null;
	summaryPinAgg = [{}];
	summaryInbox = [{ total: 0 }];
	summaryAuthored = [{ total: 0 }];
	exportPins = [];
	exportReceived = [];
	exportAuthored = [];
	updateResult = [];
	delIx = [];
	delPins = [];
	delAuthored = [];
	vi.resetModules();
	({ default: handler } = await import('../../api/irl/privacy.js'));
});

const DEVICE = 'device-abc-123';
const PIN_ID = '11111111-1111-4111-8111-111111111111';

describe('identity — an unidentified caller owns nothing and runs no query', () => {
	it('no session and no device header → 400 before any SQL', async () => {
		const { res, body } = await call('GET');
		expect(res.statusCode).toBe(400);
		expect(body.error).toMatch(/sign in|x-irl-device/i);
		expect(calls.length).toBe(0);
	});

	it('a whitespace-only device header null-guards to nothing → 400, no SQL', async () => {
		const { res, body } = await call('GET', { device: '   ' });
		expect(res.statusCode).toBe(400);
		expect(body.error).toMatch(/sign in|x-irl-device/i);
		expect(calls.length).toBe(0);
	});
});

describe('GET summary — accurate, plain-language, the caller’s own data only', () => {
	it('reports counts and never leaks a coordinate', async () => {
		summaryPinAgg = [{
			total: 3, unpublished: 1, permanent: 0,
			oldest: '2026-06-01T00:00:00Z', newest: '2026-06-20T00:00:00Z',
			next_expiry: '2026-06-27T00:00:00Z',
		}];
		summaryInbox = [{ total: 5 }];
		summaryAuthored = [{ total: 7 }];

		const { res, body } = await call('GET', { device: DEVICE });
		expect(res.statusCode).toBe(200);
		const s = body.summary;
		expect(s.pins.total).toBe(3);
		expect(s.pins.unpublished).toBe(1);
		expect(s.pins.published).toBe(2);
		expect(s.interactions.onYourPins).toBe(5);
		expect(s.interactions.youLeftElsewhere).toBe(7);
		expect(s.account).toBe('anonymous-device');
		expect(Array.isArray(s.stored)).toBe(true);
		// A summary is counts + copy only — never raw coordinates of anyone.
		expect(res._body).not.toMatch(/"lat"|"lng"/);
		// The device token is threaded into the scoped queries (never widened).
		expect(someValueIs(DEVICE)).toBe(true);
	});

	it('a signed-in caller with no device skips the authored-trail query', async () => {
		sessionUser = { id: 'user-uuid-1' };
		summaryPinAgg = [{ total: 1, unpublished: 0, permanent: 1, oldest: null, newest: null, next_expiry: null }];
		const { res, body } = await call('GET');
		expect(res.statusCode).toBe(200);
		expect(body.summary.account).toBe('signed-in');
		expect(body.summary.interactions.youLeftElsewhere).toBe(0);
		// No statement should be keyed on viewer_device for a tokenless caller.
		expect(calls.some((c) => /viewer_device =/i.test(c.q))).toBe(false);
	});
});

describe('GET export — full JSON of the caller’s own data', () => {
	it('streams pins + both interaction directions with a download header', async () => {
		exportPins = [{ id: PIN_ID, avatar_name: 'Scout', lat: 1, lng: 2 }];
		exportReceived = [{ id: 'ix-1', pin_id: PIN_ID }];
		exportAuthored = [{ id: 'ix-2', pin_id: 'other-pin' }];
		const { res, body } = await call('GET', { query: { export: '1' }, device: DEVICE });
		expect(res.statusCode).toBe(200);
		expect(res.getHeader('content-disposition')).toMatch(/attachment; filename="irl-my-data\.json"/);
		expect(body.pins.length).toBe(1);
		expect(body.interactionsOnYourPins.length).toBe(1);
		expect(body.interactionsYouLeft.length).toBe(1);
		expect(body.account).toBe('anonymous-device');
	});
});

describe('PATCH visibility — owner-gated unpublish / republish', () => {
	it('rejects an invalid pinId and a bad action without writing', async () => {
		const bad = await call('PATCH', { body: { pinId: 'not a uuid!!', action: 'unpublish' }, device: DEVICE });
		expect(bad.res.statusCode).toBe(400);
		const badAction = await call('PATCH', { body: { pinId: PIN_ID, action: 'nuke' }, device: DEVICE });
		expect(badAction.res.statusCode).toBe(400);
		expect(writes.length).toBe(0);
	});

	// Unpublish writes `published`, NOT `hidden_at`: a pin taken out of public view
	// must stay visible to its own owner in AR (hidden_at blanks it for everyone).
	it('unpublish on an owned pin → 200 private; republish → public', async () => {
		updateResult = [{ id: PIN_ID, published: false }];
		const hide = await call('PATCH', { body: { pinId: PIN_ID, action: 'unpublish' }, device: DEVICE });
		expect(hide.res.statusCode).toBe(200);
		expect(hide.body.hidden).toBe(true);
		expect(hide.body.visibility).toBe('private');

		updateResult = [{ id: PIN_ID, published: true }];
		const show = await call('PATCH', { body: { pinId: PIN_ID, action: 'republish' }, device: DEVICE });
		expect(show.res.statusCode).toBe(200);
		expect(show.body.hidden).toBe(false);
		expect(show.body.visibility).toBe('public');
	});

	// The UPDATE must touch `published` and never re-introduce the moderation column.
	it('the visibility UPDATE writes published, never hidden_at', async () => {
		calls.length = 0;
		updateResult = [{ id: PIN_ID, published: false }];
		await call('PATCH', { body: { pinId: PIN_ID, action: 'unpublish' }, device: DEVICE });
		const update = calls.map(c => c.q).find(q => /UPDATE irl_pins/i.test(q));
		expect(update).toMatch(/SET published = FALSE/i);
		expect(update).not.toMatch(/hidden_at/i);
	});

	it('a non-owner matches no row (UPDATE RETURNING empty) → 404', async () => {
		updateResult = [];
		const { res, body } = await call('PATCH', { body: { pinId: PIN_ID, action: 'unpublish' }, device: 'attacker-device' });
		expect(res.statusCode).toBe(404);
		expect(body.error).toMatch(/not found|not yours/i);
	});
});

describe('DELETE — scope validation, cascade, and honest counts', () => {
	it('rejects an unknown scope and a pin-scope without a valid id', async () => {
		const badScope = await call('DELETE', { body: { scope: 'everything' }, device: DEVICE });
		expect(badScope.res.statusCode).toBe(400);
		const badPin = await call('DELETE', { body: { scope: 'pin', pinId: 'x x x' }, device: DEVICE });
		expect(badPin.res.statusCode).toBe(400);
		expect(writes.length).toBe(0);
	});

	it('scope:pin deletes the pin + its interactions and returns counts', async () => {
		delIx = [{ id: 'ix-1' }, { id: 'ix-2' }];
		delPins = [{ id: PIN_ID }];
		const { res, body } = await call('DELETE', { body: { scope: 'pin', pinId: PIN_ID }, device: DEVICE });
		expect(res.statusCode).toBe(200);
		expect(body.deletedPins).toBe(1);
		expect(body.deletedInteractions).toBe(2);
		expect(writes).toEqual(['del-ix', 'del-pins']);
	});

	it('scope:pin on a non-owned pin (no row deleted) → 404', async () => {
		delIx = [];
		delPins = [];
		const { res, body } = await call('DELETE', { body: { scope: 'pin', pinId: PIN_ID }, device: 'attacker-device' });
		expect(res.statusCode).toBe(404);
		expect(body.error).toMatch(/not found|not yours/i);
	});

	it('scope:all wipes the caller’s pins + inbox but NOT the authored trail', async () => {
		delIx = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
		delPins = [{ id: 'p1' }, { id: 'p2' }];
		const { res, body } = await call('DELETE', { body: { scope: 'all' }, device: DEVICE });
		expect(res.statusCode).toBe(200);
		expect(body.scope).toBe('all');
		expect(body.deletedPins).toBe(2);
		expect(body.deletedInteractions).toBe(3);
		expect(writes).toEqual(['del-ix', 'del-pins']); // never touches viewer_device rows
	});

	it('scope:device ALSO purges the authored trail and folds it into the count', async () => {
		delIx = [{ id: 'a' }];
		delPins = [{ id: 'p1' }];
		delAuthored = [{ id: 'x' }, { id: 'y' }];
		const { res, body } = await call('DELETE', { body: { scope: 'device' }, device: DEVICE });
		expect(res.statusCode).toBe(200);
		expect(body.scope).toBe('device');
		expect(body.deletedPins).toBe(1);
		expect(body.deletedInteractions).toBe(1 + 2); // inbox + authored
		expect(writes).toEqual(['del-ix', 'del-pins', 'del-authored']);
		// The authored purge is keyed on the exact device token (never widened).
		expect(someValueIs(DEVICE)).toBe(true);
	});

	it('scope:device for a tokenless signed-in caller skips the authored purge', async () => {
		sessionUser = { id: 'user-uuid-2' };
		delIx = [];
		delPins = [{ id: 'p1' }];
		const { res, body } = await call('DELETE', { body: { scope: 'device' } });
		expect(res.statusCode).toBe(200);
		expect(writes).toEqual(['del-ix', 'del-pins']); // no del-authored without a device token
		expect(body.deletedInteractions).toBe(0);
	});

	it('after forget-device, a follow-up summary reads empty', async () => {
		// Simulate the post-wipe state: every aggregate is zero.
		summaryPinAgg = [{ total: 0, unpublished: 0, permanent: 0, oldest: null, newest: null, next_expiry: null }];
		summaryInbox = [{ total: 0 }];
		summaryAuthored = [{ total: 0 }];
		const { res, body } = await call('GET', { device: DEVICE });
		expect(res.statusCode).toBe(200);
		expect(body.summary.pins.total).toBe(0);
		expect(body.summary.interactions.onYourPins).toBe(0);
		expect(body.summary.interactions.youLeftElsewhere).toBe(0);
	});
});
