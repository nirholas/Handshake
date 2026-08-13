// api/irl/world-lines.js provisions irl_pins before it reads it.
//
// Regression: both coordinate feeds (`nearby` and the single-quest detail read)
// JOIN irl_pins for the anchor's precise position, but the handler's own
// ensureTables() only created irl_world_lines and irl_presence_proofs. On a
// database where no pin had ever been placed, the JOIN came back as a raw
// Postgres 42P01 (`relation "irl_pins" does not exist`) and the boundary turned
// it into a 500 + support ref. Same failure shape that hit /irl/s/:token on a
// fresh database (tests/irl-share-view.test.js) and the same fix: provision the
// table through the definition that owns it (api/irl/pins.js) before querying.
//
// The fake `sql` below models that database exactly: any SELECT touching
// irl_pins throws 42P01 until a `CREATE TABLE IF NOT EXISTS irl_pins` has been
// issued. So this test fails with a 500 if the provisioning call is ever removed.

import { describe, it, expect, vi } from 'vitest';
import { Readable } from 'node:stream';

const created = new Set();
const statements = [];

class UndefinedTable extends Error {
	constructor(relation) {
		super(`relation "${relation}" does not exist`);
		this.code = '42P01';
	}
}

const fakeSql = vi.fn(async (strings) => {
	const q = strings.join('§').replace(/\s+/g, ' ');
	statements.push(q);
	const ddl = q.match(/CREATE TABLE IF NOT EXISTS (\w+)/);
	if (ddl) { created.add(ddl[1]); return []; }
	if (/^\s*(CREATE INDEX|CREATE UNIQUE INDEX|ALTER TABLE|UPDATE|INSERT)/.test(q.trim())) return [];
	for (const relation of ['irl_pins', 'irl_world_lines', 'irl_presence_proofs']) {
		if (q.includes(relation) && !created.has(relation)) throw new UndefinedTable(relation);
	}
	return [];
});

vi.mock('../../api/_lib/db.js', () => ({
	sql: fakeSql, isDbUnavailableError: () => false, isDbCapacityError: () => false,
	isStoragePressured: () => false,
}));
vi.mock('../../api/_lib/env.js', () => ({ env: {} }));
vi.mock('../../api/_lib/sentry.js', () => ({ captureException: vi.fn() }));
vi.mock('../../api/_lib/alerts.js', () => ({ sendOpsAlert: vi.fn() }));
vi.mock('../../api/_lib/zauth.js', () => ({ instrument: () => false, drain: vi.fn() }));
vi.mock('../../api/_lib/auth.js', () => ({ getSessionUser: vi.fn(async () => null) }));
vi.mock('../../api/_lib/rate-limit.js', () => ({
	limits: new Proxy({}, { get: () => async () => ({ success: true }) }),
	limitFailClosedRead: async (_name, fn, ...args) => fn(...args),
	clientIp: () => '1.2.3.4',
}));

const handler = (await import('../../api/irl/world-lines.js')).default;

function call(url) {
	const req = Readable.from([]);
	req.method = 'GET';
	req.url = url;
	req.query = Object.fromEntries(new URL(url, 'http://x').searchParams);
	req.headers = { host: 'three.ws' };
	req.socket = { remoteAddress: '1.2.3.4' };
	const res = {
		statusCode: 0, _body: null, _h: {},
		setHeader(k, v) { this._h[k.toLowerCase()] = v; },
		getHeader(k) { return this._h[k.toLowerCase()]; },
		end(b) { this._body = b ?? null; },
		get headersSent() { return this._body !== null; },
		get writableEnded() { return this._body !== null; },
	};
	return handler(req, res).then(() => ({
		status: res.statusCode,
		body: res._body ? JSON.parse(res._body) : null,
	}));
}

describe('world-lines on a database with no irl_pins table', () => {
	it('provisions irl_pins and answers the nearby feed instead of 500ing', async () => {
		const r = await call('/api/irl/world-lines/nearby?lat=40.7484&lng=-73.9857');
		expect(r.status).toBe(200);
		expect(r.body).toEqual({ world_lines: [] });
		expect(created.has('irl_pins')).toBe(true);
		// Provisioning has to land BEFORE the first read of the table.
		const ddlAt = statements.findIndex((q) => q.includes('CREATE TABLE IF NOT EXISTS irl_pins'));
		const readAt = statements.findIndex((q) => q.includes('JOIN irl_pins'));
		expect(ddlAt).toBeGreaterThanOrEqual(0);
		expect(readAt).toBeGreaterThan(ddlAt);
	});

	it('answers the single-quest read the same way', async () => {
		const r = await call('/api/irl/world-lines/ffffffff-ffff-4fff-8fff-ffffffffffff');
		expect(r.status).toBe(404);
		expect(r.body.error).toBe('world line not found');
	});
});
