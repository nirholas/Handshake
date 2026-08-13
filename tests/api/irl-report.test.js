// POST /api/irl/report — IRL-Live D4 community moderation + task 13 abuse hardening.
//
// A pin is queued out of public view once enough DISTINCT reporters flag it — not
// on a single report, and not twice from the same reporter. These tests prove the
// threshold gate, the owner protection (you can't self-report your own pin into
// hiding, one actor can't hide someone else's), the terminal states, and the task
// 13 hardening: a strict-UUID pinId guard, the free-text `detail` sanitization, and
// the per-pin 24h report ceiling. DB / auth / limiter are mocked so the suite stays
// offline.

import { describe, it, expect, vi, beforeEach } from 'vitest';

// `pinRow` is what the pin lookup returns (null → 404). `distinctReporters` is what
// the COUNT(DISTINCT reporter_token) returns. `recentReports` is what the per-pin
// 24h COUNT(*) returns (drives the abuse ceiling). `hideUpdated` models whether the
// guarded UPDATE ... WHERE hidden_at IS NULL actually flipped a row. `lastInsert`
// captures the bound params of the most recent report INSERT so a test can assert
// exactly what was stored (e.g. the sanitized detail).
let pinRow = null;
let distinctReporters = 1;
let recentReports = 0;
let hideUpdated = true;
let lastInsert = null;
const sqlMock = vi.fn((strings, ...values) => {
	const q = Array.isArray(strings) ? strings.join(' ') : String(strings);
	if (/SELECT[\s\S]*FROM irl_pins[\s\S]*WHERE id =/i.test(q)) {
		return Promise.resolve(pinRow ? [pinRow] : []);
	}
	// Per-pin 24h ceiling — count(*) over irl_pin_reports within the rolling window.
	if (/count\(\*\)[\s\S]*FROM irl_pin_reports[\s\S]*24 hours/i.test(q)) {
		return Promise.resolve([{ n: recentReports }]);
	}
	if (/count\(DISTINCT reporter_token\)/i.test(q)) {
		return Promise.resolve([{ n: distinctReporters }]);
	}
	if (/INSERT INTO irl_pin_reports/i.test(q)) {
		lastInsert = { pinId: values[0], reporterToken: values[1], reason: values[2] };
		return Promise.resolve([]);
	}
	if (/UPDATE irl_pins[\s\S]*hidden_at = NOW\(\)/i.test(q)) {
		return Promise.resolve(hideUpdated ? [{ id: pinRow?.id }] : []);
	}
	// ensureTable DDL, anything else.
	return Promise.resolve([]);
});
vi.mock('../../api/_lib/db.js', () => ({ sql: (...a) => sqlMock(...a), isDbUnavailableError: () => false, isDbCapacityError: () => false }));

let sessionUser = null;
vi.mock('../../api/_lib/auth.js', () => ({
	getSessionUser: vi.fn(async () => sessionUser),
}));

vi.mock('../../api/_lib/rate-limit.js', () => ({
	limits: { irlReportIp: vi.fn(async () => ({ success: true })) },
	clientIp: () => '127.0.0.1',
}));

const { default: handler } = await import('../../api/irl/report.js');

// Real, server-shaped UUIDs — pin_id is a UUID column, so the handler now rejects
// any non-UUID pinId at the boundary. Tests use these everywhere a pin is reported.
const PIN_A = '11111111-1111-4111-8111-111111111111';
const OWNER = '22222222-2222-4222-8222-222222222222';

function makeRes() {
	return {
		statusCode: 200,
		_h: {},
		writableEnded: false,
		setHeader(k, v) { this._h[k.toLowerCase()] = v; },
		getHeader(k) { return this._h[k.toLowerCase()]; },
		end(body) { this.writableEnded = true; this._body = body; },
	};
}
async function report(body, headers = {}) {
	const res = makeRes();
	await handler({ url: '/api/irl/report', method: 'POST', headers: { host: 'x', ...headers }, query: {}, body }, res);
	let parsed = null;
	try { parsed = JSON.parse(res._body); } catch {}
	return { res, body: parsed };
}

beforeEach(() => {
	sqlMock.mockClear();
	pinRow = { id: PIN_A, user_id: null, device_token: 'owner-dev', hidden_at: null, lat: 40.7128, lng: -74.006 };
	distinctReporters = 1;
	recentReports = 0;
	hideUpdated = true;
	lastInsert = null;
	sessionUser = null;
});

describe('POST /api/irl/report', () => {
	it('400s without a pinId', async () => {
		const { res, body } = await report({ reason: 'spam' });
		expect(res.statusCode).toBe(400);
		expect(body.error).toMatch(/pinId/);
	});

	it('400s a non-UUID pinId before any DB work (no Postgres cast 500)', async () => {
		const { res, body } = await report({ pinId: 'pin-1', reason: 'spam', deviceToken: 'dev-X' });
		expect(res.statusCode).toBe(400);
		expect(body.error).toMatch(/invalid pinId/i);
		const ranSelect = sqlMock.mock.calls.some(([s]) =>
			/FROM irl_pins/i.test(Array.isArray(s) ? s.join(' ') : String(s)));
		expect(ranSelect).toBe(false);
	});

	it('rejects an injection-shaped / oversized pinId at the boundary', async () => {
		for (const bad of ["1' OR '1'='1", 'x'.repeat(5000), 'drop;--']) {
			const { res } = await report({ pinId: bad, reason: 'spam', deviceToken: 'dev-X' });
			expect(res.statusCode).toBe(400);
		}
	});

	it('404s when the pin does not exist', async () => {
		pinRow = null;
		const { res } = await report({ pinId: PIN_A, reason: 'spam', deviceToken: 'dev-X' });
		expect(res.statusCode).toBe(404);
	});

	it('records a single report without hiding the pin (below threshold)', async () => {
		distinctReporters = 1;
		const { res, body } = await report({ pinId: PIN_A, reason: 'spam', deviceToken: 'dev-X' });
		expect(res.statusCode).toBe(200);
		expect(body.hidden).toBe(false);
		expect(body.reports).toBe(1);
		const updated = sqlMock.mock.calls.some(([s]) =>
			/hidden_at = NOW\(\)/i.test(Array.isArray(s) ? s.join(' ') : String(s)));
		expect(updated).toBe(false);
	});

	it('hides the pin once distinct reporters reach the threshold (3)', async () => {
		distinctReporters = 3;
		const { res, body } = await report({ pinId: PIN_A, reason: 'harassment', deviceToken: 'dev-Z' });
		expect(res.statusCode).toBe(200);
		expect(body.hidden).toBe(true);
	});

	it('reports the pin as not hidden when the guarded hide UPDATE flips nothing (race)', async () => {
		distinctReporters = 3;
		hideUpdated = false; // a concurrent report already set hidden_at
		const { body } = await report({ pinId: PIN_A, reason: 'scam', deviceToken: 'dev-W' });
		expect(body.hidden).toBe(false);
	});

	it('a single reporter cannot hide a pin (one distinct token, threshold not met)', async () => {
		distinctReporters = 1;
		const { body } = await report({ pinId: PIN_A, reason: 'scam', deviceToken: 'lone-dev' });
		expect(body.hidden).toBe(false);
	});

	it('ignores an owner self-report (device-token owner) without counting it', async () => {
		const { res, body } = await report({ pinId: PIN_A, reason: 'spam', deviceToken: 'owner-dev' });
		expect(res.statusCode).toBe(200);
		expect(body.self).toBe(true);
		const inserted = sqlMock.mock.calls.some(([s]) =>
			/INSERT INTO irl_pin_reports/i.test(Array.isArray(s) ? s.join(' ') : String(s)));
		expect(inserted).toBe(false);
	});

	// H2 transport: the device credential rides the `x-irl-device` HEADER, with the
	// body as the fallback. This path used to read `body.deviceToken` only, so a
	// header-only client lost BOTH device-keyed protections at once: the owner became
	// an "independent" reporter of their own pin, and the per-device dedup fell back
	// to the coarse per-IP identity.
	it('honours the x-irl-device header for the owner self-report', async () => {
		const { res, body } = await report({ pinId: PIN_A, reason: 'spam' }, { 'x-irl-device': 'owner-dev' });
		expect(res.statusCode).toBe(200);
		expect(body.self).toBe(true);
	});

	it('dedupes a header-only reporter by device, not by IP', async () => {
		await report({ pinId: PIN_A, reason: 'spam' }, { 'x-irl-device': 'visitor-dev' });
		expect(lastInsert.reporterToken).toBe('visitor-dev');
	});

	it('ignores an authenticated owner self-report', async () => {
		pinRow = { id: PIN_A, user_id: OWNER, device_token: null, hidden_at: null };
		sessionUser = { id: OWNER };
		const { body } = await report({ pinId: PIN_A, reason: 'spam' });
		expect(body.self).toBe(true);
	});

	it('reports an already-hidden pin idempotently', async () => {
		pinRow.hidden_at = '2026-06-17T00:00:00Z';
		const { res, body } = await report({ pinId: PIN_A, reason: 'spam', deviceToken: 'dev-Y' });
		expect(res.statusCode).toBe(200);
		expect(body.hidden).toBe(true);
	});

	it('normalizes an unknown reason to "other" (still accepted)', async () => {
		const { res } = await report({ pinId: PIN_A, reason: 'banana', deviceToken: 'dev-Q' });
		expect(res.statusCode).toBe(200);
		expect(lastInsert.reason).toBe('other');
	});
});

describe('POST /api/irl/report — detail sanitization (task 13)', () => {
	it('strips NUL + control chars and collapses whitespace before storing', async () => {
		await report({
			pinId: PIN_A,
			reason: 'spam',
			detail: 'evil\u0000\u001b[31mred\u007f   line\nbreak\t\tend',
			deviceToken: 'dev-S',
		});
		// Stored as "reason: detail" — the detail half must be free of control chars
		// and have whitespace runs collapsed to single spaces.
		expect(lastInsert.reason).toBe('spam: evil [31mred line break end');
		expect(lastInsert.reason).not.toMatch(/[\u0000-\u001F\u007F-\u009F]/);
	});

	it('bounds the detail length to the cap', async () => {
		await report({ pinId: PIN_A, reason: 'spam', detail: 'a'.repeat(1000), deviceToken: 'dev-L' });
		const detail = lastInsert.reason.replace(/^spam: /, '');
		expect(detail.length).toBe(240);
	});

	it('stores the bare reason when detail is only control chars / whitespace', async () => {
		await report({ pinId: PIN_A, reason: 'scam', detail: '\u0000\u0000\t  \u001b ', deviceToken: 'dev-E' });
		expect(lastInsert.reason).toBe('scam');
	});

	it('ignores a non-string detail', async () => {
		await report({ pinId: PIN_A, reason: 'spam', detail: { x: 1 }, deviceToken: 'dev-O' });
		expect(lastInsert.reason).toBe('spam');
	});
});

describe('POST /api/irl/report — per-pin 24h abuse ceiling (task 13)', () => {
	it('429s once the pin is at the 24h report ceiling, and never inserts', async () => {
		recentReports = 25; // at the cap
		const { res, body } = await report({ pinId: PIN_A, reason: 'spam', deviceToken: 'flood-dev' });
		expect(res.statusCode).toBe(429);
		expect(body.error).toMatch(/too_many_reports/);
		expect(res.getHeader('retry-after')).toBeTruthy();
		const inserted = sqlMock.mock.calls.some(([s]) =>
			/INSERT INTO irl_pin_reports/i.test(Array.isArray(s) ? s.join(' ') : String(s)));
		expect(inserted).toBe(false);
	});

	it('accepts a report while under the ceiling', async () => {
		recentReports = 24; // one below the cap
		const { res } = await report({ pinId: PIN_A, reason: 'spam', deviceToken: 'ok-dev' });
		expect(res.statusCode).toBe(200);
	});

	it('does NOT apply the ceiling to an already-hidden pin (idempotent report)', async () => {
		pinRow.hidden_at = '2026-06-17T00:00:00Z';
		recentReports = 999; // well over the cap, but the pin is terminal
		const { res, body } = await report({ pinId: PIN_A, reason: 'spam', deviceToken: 'dev-H' });
		expect(res.statusCode).toBe(200);
		expect(body.hidden).toBe(true);
		// The 24h count query must not even run for a hidden pin.
		const ranCount = sqlMock.mock.calls.some(([s]) =>
			/count\(\*\)[\s\S]*24 hours/i.test(Array.isArray(s) ? s.join(' ') : String(s)));
		expect(ranCount).toBe(false);
	});

	it('does NOT apply the ceiling to an owner self-report', async () => {
		recentReports = 999;
		const { res, body } = await report({ pinId: PIN_A, reason: 'spam', deviceToken: 'owner-dev' });
		expect(res.statusCode).toBe(200);
		expect(body.self).toBe(true);
	});
});
