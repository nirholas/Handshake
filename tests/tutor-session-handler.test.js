// GET/POST /api/tutor/session, the free tutor ledger endpoint, plus the ledger
// it reads.
//
// The endpoint shipped with no coverage and its only storage backend was an
// Upstash KV rail that is not configured on this deployment, so in production
// every read returned an empty tab and every "end session" returned a $0 invoice
// no matter how many $0.01 answers the learner had paid for. These tests pin the
// behaviour that fix depends on: the tab round-trips through the Postgres tier,
// a close is idempotent, closing an id that has no tab never poisons it, and a
// store fault surfaces as a failure instead of a false "you owe nothing".

import { beforeEach, describe, expect, it, vi } from 'vitest';

// Fake Postgres: enough of the tutor_sessions table to round-trip a session.
const rows = new Map();
const dbState = { failNextRead: false, failNextWrite: false };

vi.mock('../api/_lib/db.js', () => ({
	sql: vi.fn(async (strings, ...values) => {
		const q = (typeof strings === 'string' ? strings : strings.join('?')).toLowerCase();
		if (q.includes('create table') || q.includes('create index') || q.includes('delete from')) return [];
		if (q.includes('insert into tutor_sessions')) {
			if (dbState.failNextWrite) {
				dbState.failNextWrite = false;
				throw new Error('write failed: storage at cap');
			}
			rows.set(values[0], values[3]);
			return [];
		}
		if (q.includes('select session from tutor_sessions')) {
			if (dbState.failNextRead) {
				dbState.failNextRead = false;
				throw new Error('connection terminated unexpectedly');
			}
			const stored = rows.get(values[0]);
			return stored ? [{ session: stored }] : [];
		}
		return [];
	}),
	isDbUnavailableError: () => false,
	isDbCapacityError: () => false,
	isStoragePressured: async () => ({ pressured: false, sizeMb: 1, highWaterMb: 100 }),
}));

const { default: handler } = await import('../api/tutor/session.js');
const ledger = await import('../agents/tutor/src/session.js');

function makeRes() {
	return {
		statusCode: 0,
		payload: null,
		headers: {},
		setHeader(k, v) { this.headers[String(k).toLowerCase()] = v; },
		getHeader(k) { return this.headers[String(k).toLowerCase()]; },
		removeHeader(k) { delete this.headers[String(k).toLowerCase()]; },
		writeHead(code) { this.statusCode = code; return this; },
		get headersSent() { return false; },
		get writableEnded() { return false; },
		end(chunk) {
			if (chunk) { try { this.payload = JSON.parse(String(chunk)); } catch { this.payload = String(chunk); } }
			return this;
		},
	};
}

async function call(req) {
	const res = makeRes();
	await handler(req, res);
	return res;
}

const get = (query) => call({ method: 'GET', url: `/api/tutor/session${query}`, headers: {} });

const post = (body) =>
	call({ method: 'POST', url: '/api/tutor/session', headers: { 'content-type': 'application/json' }, body });

const charge = (sessionId, question) =>
	ledger.appendCharge(sessionId, { question, level: 'beginner', costAtomics: 10_000, outputTokens: 42 });

beforeEach(() => {
	rows.clear();
	dbState.failNextRead = false;
	dbState.failNextWrite = false;
	// The tier production runs on: DATABASE_URL set, no KV.
	vi.stubEnv('DATABASE_URL', 'postgresql://tutor:tutor@localhost:5432/tutor');
	vi.stubEnv('UPSTASH_REDIS_REST_URL', '');
	vi.stubEnv('UPSTASH_REDIS_REST_TOKEN', '');
});

describe('tutor session ledger backend', () => {
	it('prefers Postgres, falls back to KV, then to process memory', () => {
		expect(ledger.sessionBackend()).toBe('db');
		vi.stubEnv('DATABASE_URL', '');
		vi.stubEnv('UPSTASH_REDIS_REST_URL', 'https://kv.example.upstash.io');
		vi.stubEnv('UPSTASH_REDIS_REST_TOKEN', 'token');
		expect(ledger.sessionBackend()).toBe('kv');
		vi.stubEnv('UPSTASH_REDIS_REST_URL', '');
		vi.stubEnv('UPSTASH_REDIS_REST_TOKEN', '');
		expect(ledger.sessionBackend()).toBe('memory');
	});

	it('renders atomics as a USDC 6dp string', () => {
		expect(ledger.atomicsToUsd(10_000)).toBe('0.010000');
		expect(ledger.atomicsToUsd(0)).toBe('0.000000');
	});

	it('rejects a charge on a closed session', async () => {
		await charge('s-closed', 'Why does my recursion overflow?');
		await ledger.closeSession('s-closed');
		await expect(charge('s-closed', 'one more')).rejects.toMatchObject({
			status: 409,
			code: 'session_closed',
		});
	});

	it('surfaces a store fault instead of reporting an empty tab', async () => {
		await charge('s-fault', 'Why does my recursion overflow?');
		dbState.failNextRead = true;
		await expect(ledger.loadSession('s-fault')).rejects.toThrow(/connection terminated/);
	});

	it('keeps the answer when the ledger read fails on the paid path', async () => {
		dbState.failNextRead = true;
		const session = await charge('s-degraded-read', 'Why does my recursion overflow?');
		expect(session.entries).toHaveLength(1);
		expect(session.totalAtomics).toBe(10_000);
	});

	it('keeps the answer when the ledger write fails on the paid path', async () => {
		dbState.failNextWrite = true;
		const session = await charge('s-degraded-write', 'Why does my recursion overflow?');
		expect(session.entries).toHaveLength(1);
		expect(rows.has('s-degraded-write')).toBe(false);
	});
});

describe('GET /api/tutor/session', () => {
	it('400s without a sessionId', async () => {
		const res = await get('');
		expect(res.statusCode).toBe(400);
		expect(res.payload.error).toBe('missing_session');
	});

	it('returns an empty open tab for an id that has no session yet', async () => {
		const res = await get('?sessionId=s-fresh');
		expect(res.statusCode).toBe(200);
		expect(res.payload).toMatchObject({ sessionId: 's-fresh', status: 'open', questionCount: 0, totalUsd: '0.000000' });
		expect(res.payload.lineItems).toEqual([]);
	});

	it('itemizes a tab persisted by an earlier paid answer', async () => {
		await charge('s-tab', 'Why does my recursion overflow?');
		await charge('s-tab', 'How do I make it iterative?');
		const res = await get('?sessionId=s-tab');
		expect(res.statusCode).toBe(200);
		expect(res.payload.questionCount).toBe(2);
		expect(res.payload.totalAtomics).toBe(20_000);
		expect(res.payload.totalUsd).toBe('0.020000');
		expect(res.payload.lineItems.map((l) => l.n)).toEqual([1, 2]);
		expect(res.payload.lineItems[0]).toMatchObject({ question: 'Why does my recursion overflow?', costUsd: '0.010000' });
	});

	it('caps an oversized sessionId rather than passing it to the store', async () => {
		const res = await get(`?sessionId=${'x'.repeat(400)}`);
		expect(res.statusCode).toBe(200);
		expect(res.payload.sessionId).toHaveLength(100);
	});
});

describe('POST /api/tutor/session', () => {
	it('400s without a sessionId', async () => {
		const res = await post({ action: 'end' });
		expect(res.statusCode).toBe(400);
		expect(res.payload.error).toBe('missing_session');
	});

	it('400s on an action other than end', async () => {
		const res = await post({ sessionId: 's-x', action: 'delete' });
		expect(res.statusCode).toBe(400);
		expect(res.payload.error).toBe('bad_action');
	});

	it('405s on a method the endpoint does not serve', async () => {
		const res = await call({ method: 'PUT', url: '/api/tutor/session', headers: {} });
		expect(res.statusCode).toBe(405);
	});

	it('closes the session with an itemized, attested invoice', async () => {
		await charge('s-close', 'Why does my recursion overflow?');
		const res = await post({ sessionId: 's-close', action: 'end' });
		expect(res.statusCode).toBe(200);
		expect(res.payload.questionCount).toBe(1);
		expect(res.payload.totalUsd).toBe('0.010000');
		expect(res.payload.attestation).toMatch(/^sha256:[0-9a-f]{64}$/);
		const after = await get('?sessionId=s-close');
		expect(after.payload.status).toBe('closed');
		expect(after.payload.invoice.attestation).toBe(res.payload.attestation);
	});

	it('returns the identical invoice when the same session is closed twice', async () => {
		await charge('s-twice', 'Why does my recursion overflow?');
		const first = await post({ sessionId: 's-twice', action: 'end' });
		const second = await post({ sessionId: 's-twice', action: 'end' });
		expect(second.payload).toEqual(first.payload);
		expect(second.payload.closedAt).toBe(first.payload.closedAt);
	});

	it('does not poison an id that has no tab, so its first charge still lands', async () => {
		const res = await post({ sessionId: 's-unused', action: 'end' });
		expect(res.statusCode).toBe(200);
		expect(res.payload.questionCount).toBe(0);
		expect(rows.has('s-unused')).toBe(false);
		const session = await charge('s-unused', 'first question');
		expect(session.status).toBe('open');
		expect(session.entries).toHaveLength(1);
	});
});
