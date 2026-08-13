// Terms of Service acceptance: the shared helper (api/_lib/legal.js) and the
// re-acceptance endpoint (POST /api/legal/tos-ack). The auth-flow recording
// (register / login) is covered in auth-email.test.js.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Readable } from 'node:stream';

process.env.PUBLIC_APP_ORIGIN ||= 'https://app.test';
process.env.JWT_SECRET ||= 'test-legal-tos-secret-at-least-32ch';

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
	clientIp: () => '127.0.0.1',
}));

const sessionState = { user: null };

vi.mock('../../api/_lib/auth.js', () => ({
	getSessionUser: vi.fn(async () => sessionState.user),
}));

const { TOS_VERSION, tosAcceptanceFromBody } = await import('../../api/_lib/legal.js');
const { default: handler } = await import('../../api/legal/tos-ack.js');

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeReq(body = null) {
	const bodyStr = body ? JSON.stringify(body) : '';
	const req = Readable.from([Buffer.from(bodyStr)]);
	req.method = 'POST';
	req.url = '/api/legal/tos-ack';
	req.headers = {
		host: 'app.test',
		...(body !== null ? { 'content-type': 'application/json' } : {}),
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

async function invoke(body) {
	const req = makeReq(body);
	const res = makeRes();
	await handler(req, res);
	// logAudit and the users-table stamp are fire-and-forget microtasks; flush
	// them so assertions can see the resulting sql calls.
	await new Promise((resolve) => setImmediate(resolve));
	let json = null;
	try { json = JSON.parse(res.body); } catch { json = res.body; }
	return { res, status: res.statusCode, body: json };
}

beforeEach(() => {
	sqlState.queue = [];
	sqlState.calls = [];
	rlState.success = true;
	sessionState.user = null;
});

// ── tosAcceptanceFromBody ─────────────────────────────────────────────────────

describe('tosAcceptanceFromBody', () => {
	it('returns null when acceptance is absent or not literal true', () => {
		expect(tosAcceptanceFromBody({})).toBeNull();
		expect(tosAcceptanceFromBody(null)).toBeNull();
		expect(tosAcceptanceFromBody({ tosAccepted: false })).toBeNull();
		expect(tosAcceptanceFromBody({ tosAccepted: 'true' })).toBeNull();
		expect(tosAcceptanceFromBody({ tosAccepted: 1 })).toBeNull();
	});

	it('defaults to the current version when none is sent', () => {
		expect(tosAcceptanceFromBody({ tosAccepted: true })).toEqual({ version: TOS_VERSION });
	});

	it('accepts a valid explicit version', () => {
		expect(tosAcceptanceFromBody({ tosAccepted: true, tosVersion: 1 })).toEqual({ version: 1 });
	});

	it('clamps out-of-range or garbage versions to the current one', () => {
		expect(tosAcceptanceFromBody({ tosAccepted: true, tosVersion: 0 })).toEqual({ version: TOS_VERSION });
		expect(tosAcceptanceFromBody({ tosAccepted: true, tosVersion: TOS_VERSION + 5 })).toEqual({ version: TOS_VERSION });
		expect(tosAcceptanceFromBody({ tosAccepted: true, tosVersion: 'nine' })).toEqual({ version: TOS_VERSION });
		expect(tosAcceptanceFromBody({ tosAccepted: true, tosVersion: 1.5 })).toEqual({ version: TOS_VERSION });
	});
});

// ── POST /api/legal/tos-ack ───────────────────────────────────────────────────

describe('POST /api/legal/tos-ack', () => {
	it('records an anonymous acceptance in the audit log only', async () => {
		const { status, body } = await invoke({ context: 'register-page', path: '/register' });
		expect(status).toBe(200);
		expect(body).toEqual({ ok: true, version: TOS_VERSION, recorded: true });
		const audits = sqlState.calls.filter((c) => /insert into audit_log/.test(c.query));
		expect(audits).toHaveLength(1);
		expect(audits[0].values).toContain('tos-accept');
		const stamps = sqlState.calls.filter((c) => /update users/.test(c.query));
		expect(stamps).toHaveLength(0);
	});

	it('stamps the user row when signed in', async () => {
		sessionState.user = { id: 'user-9' };
		const { status, body } = await invoke({});
		expect(status).toBe(200);
		expect(body).toEqual({ ok: true, version: TOS_VERSION, recorded: true });
		const stamps = sqlState.calls.filter((c) => /update users\s+set tos_accepted_version/.test(c.query));
		expect(stamps).toHaveLength(1);
		expect(stamps[0].values).toContain('user-9');
		const audits = sqlState.calls.filter((c) => /insert into audit_log/.test(c.query));
		expect(audits).toHaveLength(1);
	});

	it('keeps the accepting page in the audit meta for a signed-in user', async () => {
		sessionState.user = { id: 'user-9' };
		const { status } = await invoke({ context: 'settings', path: '/settings' });
		expect(status).toBe(200);
		const audit = sqlState.calls.find((c) => /insert into audit_log/.test(c.query));
		expect(audit.values).toContainEqual({ version: TOS_VERSION, context: 'settings', path: '/settings' });
	});

	it('drops a malformed path instead of storing it', async () => {
		const { status } = await invoke({ context: 'settings', path: 'no-leading-slash' });
		expect(status).toBe(200);
		const audit = sqlState.calls.find((c) => /insert into audit_log/.test(c.query));
		expect(audit.values).toContainEqual({ version: TOS_VERSION, context: 'settings', path: null });
	});

	it('reports recorded:false when the durable write fails', async () => {
		// A deterministic SQL error, not a transient connection blip: db-retry
		// surfaces it on the first attempt instead of retrying.
		sqlState.queue = [new Error('relation "audit_log" does not exist')];
		const { status, body } = await invoke({ context: 'register-page' });
		expect(status).toBe(200);
		expect(body).toEqual({ ok: true, version: TOS_VERSION, recorded: false });
	});

	it('rejects a version that does not exist', async () => {
		const { status, body } = await invoke({ version: TOS_VERSION + 1 });
		expect(status).toBe(400);
		expect(body.error).toBe('invalid_version');
	});

	it('rate limits', async () => {
		rlState.success = false;
		const { status } = await invoke({});
		expect(status).toBe(429);
	});
});
