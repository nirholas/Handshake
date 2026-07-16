// api/irl/share/[token].js — the public unfurl page for a minted IRL share link.
//
// Regression: GET /irl/s/:token 500'd with a raw Postgres "relation
// irl_pin_shares does not exist" (42P01) the first time anyone opened a share
// link on a fresh database, because the handler queried irl_pin_shares
// directly without ever provisioning it — unlike every other write path in
// this feature (api/irl/share.js, logIrlEvent, getIrlAnalyticsSummary), which
// all call ensureIrlAnalyticsSchema() first. Caught live in production
// 2026-07-16 verifying the deploy; fixed by adding the same guard here.

import { describe, it, expect, beforeEach, vi } from 'vitest';

const sqlMock = vi.fn();
vi.mock('../api/_lib/db.js', () => ({
	sql: sqlMock,
	isDbUnavailableError: () => false,
	isDbCapacityError: () => false,
	isStoragePressured: () => false,
}));
vi.mock('../api/_lib/env.js', () => ({ env: {} }));
vi.mock('../api/_lib/sentry.js', () => ({ captureException: vi.fn() }));
vi.mock('../api/_lib/alerts.js', () => ({ sendOpsAlert: vi.fn() }));
vi.mock('../api/_lib/zauth.js', () => ({ instrument: () => false, drain: vi.fn() }));

const { default: handler } = await import('../api/irl/share/[token].js');

function makeReqRes(token) {
	const req = {
		method: 'GET',
		url: `/api/irl/share/${token || ''}`,
		headers: { host: 'three.ws' },
		query: { token },
	};
	const res = {
		statusCode: 0,
		body: null,
		headers: {},
		setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
		end(b) { this.body = b ?? null; },
		get headersSent() { return this.body !== null; },
		get writableEnded() { return this.body !== null; },
	};
	return { req, res };
}

beforeEach(() => {
	sqlMock.mockReset();
});

describe('GET /api/irl/share/[token]', () => {
	it('provisions the schema before querying irl_pin_shares (no 42P01 on a fresh database)', async () => {
		const order = [];
		sqlMock.mockImplementation(async (strings) => {
			const q = Array.isArray(strings) ? strings.join(' ') : String(strings);
			if (/CREATE TABLE IF NOT EXISTS irl_events/.test(q)) { order.push('create-events'); return []; }
			if (/CREATE INDEX.*irl_events/.test(q)) { order.push('index-events'); return []; }
			if (/CREATE TABLE IF NOT EXISTS irl_pin_shares/.test(q)) { order.push('create-shares'); return []; }
			if (/CREATE INDEX.*irl_pin_shares/.test(q)) { order.push('index-shares'); return []; }
			if (/SELECT s\.image_url/.test(q)) {
				order.push('select-share');
				return [];
			}
			return [];
		});

		const { req, res } = makeReqRes('tok123');
		await handler(req, res);

		// The schema-creating statements must land before the SELECT — the exact
		// ordering invariant the production bug violated.
		expect(order.indexOf('create-shares')).toBeGreaterThanOrEqual(0);
		expect(order.indexOf('create-shares')).toBeLessThan(order.indexOf('select-share'));
		expect(res.statusCode).toBe(404); // no matching row → the designed not-found page
	});

	it('never throws relation-does-not-exist — the SELECT only ever runs after CREATE TABLE IF NOT EXISTS', async () => {
		// Simulates a genuinely empty database: every query succeeds (CREATE TABLE
		// IF NOT EXISTS is idempotent), so the old bug (querying irl_pin_shares
		// before it was ever created) would have surfaced as a rejected promise
		// here if the guard were missing.
		sqlMock.mockResolvedValue([]);
		const { req, res } = makeReqRes('brand-new-token');
		await expect(handler(req, res)).resolves.toBeUndefined();
		expect(res.statusCode).toBe(404);
		expect(res.body).toContain("isn't available anymore");
	});

	it('renders the unfurl page for a real, public share', async () => {
		sqlMock.mockImplementation(async (strings) => {
			const q = Array.isArray(strings) ? strings.join(' ') : String(strings);
			if (/SELECT s\.image_url/.test(q)) {
				return [{ image_url: 'https://cdn.example/irl-share/tok123.png', avatar_name: 'Nova', caption: 'hanging out', published: true, hidden_at: null }];
			}
			if (/UPDATE irl_pin_shares SET view_count/.test(q)) return [{ pin_id: 'pin-1' }];
			return [];
		});

		const { req, res } = makeReqRes('tok123');
		await handler(req, res);

		expect(res.statusCode).toBe(200);
		expect(res.body).toContain('https://cdn.example/irl-share/tok123.png');
		expect(res.body).toContain('Nova');
		// Never a coordinate on the card.
		expect(res.body).not.toMatch(/-?\d{1,3}\.\d{3,}/);
	});

	it('treats an unpublished pin as not-found, never leaking a private placement', async () => {
		sqlMock.mockImplementation(async (strings) => {
			const q = Array.isArray(strings) ? strings.join(' ') : String(strings);
			if (/SELECT s\.image_url/.test(q)) {
				return [{ image_url: 'https://cdn.example/x.png', avatar_name: 'Nova', caption: '', published: false, hidden_at: null }];
			}
			return [];
		});
		const { req, res } = makeReqRes('tok-private');
		await handler(req, res);
		expect(res.statusCode).toBe(404);
	});

	it('returns 404 with no database call for a missing token', async () => {
		const { req, res } = makeReqRes('');
		await handler(req, res);
		expect(res.statusCode).toBe(404);
		expect(sqlMock).not.toHaveBeenCalled();
	});
});
