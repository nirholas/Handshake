// Risk Disclosure acceptance endpoint (POST /api/legal/risk-ack). The client
// gate that calls it (public/risk-ack.js) is covered in tests/risk-ack.test.js;
// this file covers the server side: what it accepts, what it refuses, and
// whether it tells the caller the truth about the durable record.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Readable } from 'node:stream';

process.env.PUBLIC_APP_ORIGIN ||= 'https://app.test';
process.env.JWT_SECRET ||= 'test-legal-risk-secret-at-least-32ch';

// ── Mocks ─────────────────────────────────────────────────────────────────────

const sqlState = { queue: [], calls: [] };

vi.mock('../../api/_lib/db.js', () => ({
	sql: vi.fn(async (strings, ...values) => {
		sqlState.calls.push({ query: strings.join('?'), values });
		if (sqlState.queue.length === 0) return [];
		const next = sqlState.queue.shift();
		if (next instanceof Error) throw next;
		return next;
	}),
	isDbUnavailableError: () => false,
	isDbCapacityError: () => false,
}));

const rlState = { success: true };

vi.mock('../../api/_lib/rate-limit.js', () => ({
	limits: {
		publicIp: vi.fn(async () => ({ success: rlState.success })),
	},
	clientIp: () => '203.0.113.7',
}));

const sessionState = { user: null };

vi.mock('../../api/_lib/auth.js', () => ({
	getSessionUser: vi.fn(async () => sessionState.user),
}));

const { RISK_ACK_VERSION } = await import('../../public/risk-ack.js');
const { default: handler } = await import('../../api/legal/risk-ack.js');

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeReq(body = null, { method = 'POST', origin = null, contentType, raw = null } = {}) {
	const bodyStr = raw ?? (body === null ? '' : JSON.stringify(body));
	const ct = contentType === undefined ? (body !== null || raw !== null ? 'application/json' : null) : contentType;
	const req = Readable.from([Buffer.from(bodyStr)]);
	req.method = method;
	req.url = '/api/legal/risk-ack';
	req.headers = {
		host: 'app.test',
		'user-agent': 'vitest',
		...(ct ? { 'content-type': ct } : {}),
		...(origin ? { origin } : {}),
	};
	return req;
}

function makeRes() {
	return {
		statusCode: 200,
		headers: {},
		body: '',
		writableEnded: false,
		setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
		getHeader(k) { return this.headers[k.toLowerCase()]; },
		end(chunk) {
			if (chunk !== undefined) this.body += chunk;
			this.writableEnded = true;
		},
	};
}

async function invoke(body, opts) {
	const res = makeRes();
	await handler(makeReq(body, opts), res);
	let json = null;
	try { json = JSON.parse(res.body); } catch { json = res.body; }
	return { res, status: res.statusCode, body: json };
}

const auditRows = () => sqlState.calls.filter((c) => /insert into audit_log/.test(c.query));

beforeEach(() => {
	sqlState.queue = [];
	sqlState.calls = [];
	rlState.success = true;
	sessionState.user = null;
});

// ── POST /api/legal/risk-ack ──────────────────────────────────────────────────

describe('POST /api/legal/risk-ack', () => {
	it('records an anonymous acceptance with its context and page', async () => {
		const { status, body } = await invoke({ version: RISK_ACK_VERSION, context: 'trade', path: '/create' });
		expect(status).toBe(200);
		expect(body).toEqual({ ok: true, recorded: true });
		const rows = auditRows();
		expect(rows).toHaveLength(1);
		expect(rows[0].values[0]).toBeNull(); // user_id: anonymous
		expect(rows[0].values).toContain('risk-ack-accept');
		expect(rows[0].values).toContainEqual({ version: RISK_ACK_VERSION, context: 'trade', path: '/create' });
		expect(rows[0].values).toContain('203.0.113.7');
	});

	it('attributes the acceptance to the signed-in user', async () => {
		sessionState.user = { id: 'user-42' };
		const { status, body } = await invoke({ version: RISK_ACK_VERSION, context: 'x402-pay' });
		expect(status).toBe(200);
		expect(body.recorded).toBe(true);
		expect(auditRows()[0].values[0]).toBe('user-42');
	});

	it('records anonymously when the session lookup fails', async () => {
		const { getSessionUser } = await import('../../api/_lib/auth.js');
		getSessionUser.mockRejectedValueOnce(new Error('expired token'));
		const { status, body } = await invoke({ version: RISK_ACK_VERSION });
		expect(status).toBe(200);
		expect(body.recorded).toBe(true);
		expect(auditRows()[0].values[0]).toBeNull();
	});

	it('refuses a disclosure version that does not exist', async () => {
		const { status, body } = await invoke({ version: RISK_ACK_VERSION + 1 });
		expect(status).toBe(400);
		expect(body.error).toBe('invalid_version');
		expect(auditRows()).toHaveLength(0);
	});

	it.each([
		[{}],
		[{ version: 0 }],
		[{ version: 1.5 }],
		[{ version: 'one' }],
		[{ version: null }],
	])('refuses a malformed version %#', async (body) => {
		const { status } = await invoke(body);
		expect(status).toBe(400);
		expect(auditRows()).toHaveLength(0);
	});

	// A body the endpoint could not read used to be reported as a bad `version`,
	// pointing the caller at a field that was never the problem.
	it('names the size limit rather than the version when the body is too large', async () => {
		const { status, body } = await invoke({ version: RISK_ACK_VERSION, pad: 'a'.repeat(11_000) });
		expect(status).toBe(413);
		expect(body.error).toBe('payload_too_large');
		expect(auditRows()).toHaveLength(0);
	});

	it('names the content-type rather than the version when the body is not JSON', async () => {
		const { status, body } = await invoke(null, {
			contentType: 'application/x-www-form-urlencoded',
			raw: 'version=1',
		});
		expect(status).toBe(415);
		expect(body.error).toBe('unsupported_media_type');
		expect(auditRows()).toHaveLength(0);
	});

	it('refuses an unparseable body', async () => {
		const { status, body } = await invoke(null, { raw: '{oops' });
		expect(status).toBe(400);
		expect(body.error).toBe('bad_request');
		expect(auditRows()).toHaveLength(0);
	});

	it('drops a malformed context or path rather than storing it', async () => {
		const { status } = await invoke({
			version: RISK_ACK_VERSION,
			context: 'NOT A SLUG!',
			path: 'missing-leading-slash',
		});
		expect(status).toBe(200);
		expect(auditRows()[0].values).toContainEqual({ version: RISK_ACK_VERSION, context: null, path: null });
	});

	it('reports recorded:false when the durable write fails', async () => {
		// A deterministic SQL error, not a transient connection blip: db-retry
		// surfaces it on the first attempt instead of retrying.
		sqlState.queue = [new Error('relation "audit_log" does not exist')];
		const { status, body } = await invoke({ version: RISK_ACK_VERSION, context: 'trade' });
		expect(status).toBe(200);
		expect(body).toEqual({ ok: true, recorded: false });
	});

	it('rejects a non-POST method', async () => {
		const { status, body } = await invoke(null, { method: 'GET' });
		expect(status).toBe(405);
		expect(body.error).toBe('method_not_allowed');
	});

	it('rate limits', async () => {
		rlState.success = false;
		const { status } = await invoke({ version: RISK_ACK_VERSION });
		expect(status).toBe(429);
		expect(auditRows()).toHaveLength(0);
	});

	it('allows any origin, so the x402 embed on a merchant site can record', async () => {
		const { res, status } = await invoke({ version: RISK_ACK_VERSION }, { origin: 'https://merchant.example' });
		expect(status).toBe(200);
		expect(res.headers['access-control-allow-origin']).toBe('*');
		// No credentials on a wildcard origin: cross-site acceptances stay anonymous.
		expect(res.headers['access-control-allow-credentials']).toBeUndefined();
	});
});
