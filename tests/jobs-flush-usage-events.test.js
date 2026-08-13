/**
 * QStash webhook guard on api/jobs/flush-usage-events.js.
 *
 * The signature check binds the delivery to an absolute URL (QStash signs it as
 * the JWT `sub`), so the handler has to rebuild the exact string the publisher
 * used. It previously read `process.env.APP_ORIGIN`, a var nothing in this repo
 * sets, while api/_lib/usage.js publishes to `${env.APP_ORIGIN}/...` (which
 * defaults to https://three.ws). Every genuinely signed job therefore compared
 * against a bare path and got 401, silently killing the threshold-triggered
 * flush lane and leaving only the 1-minute safety-net cron.
 *
 * These cases hold the contract: a real QStash JWT is accepted, everything that
 * is not one is rejected 401, and an unset signing key surfaces as a
 * configuration fault rather than a phantom signature failure.
 *
 * The @upstash/qstash Receiver runs for real here: only the Redis/Neon buffer
 * drains and the http.js envelope are substituted.
 */

import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { createHash, createHmac } from 'node:crypto';

const CURRENT_KEY = 'dGVzdC1jdXJyZW50LXNpZ25pbmcta2V5LWZvci11bml0cw==';
const NEXT_KEY = 'dGVzdC1uZXh0LXNpZ25pbmcta2V5LWZvci11bml0LXRlc3Q=';
const JOB_PATH = '/api/jobs/flush-usage-events';

process.env.QSTASH_CURRENT_SIGNING_KEY = CURRENT_KEY;
process.env.QSTASH_NEXT_SIGNING_KEY = NEXT_KEY;

const flushUsageBuffer = vi.fn(async () => ({ flushed: 4, remaining: 0, errors: 0 }));
const flushAuditBuffer = vi.fn(async () => ({ flushed: 2, remaining: 0, errors: 0 }));

vi.mock('../api/_lib/env.js', () => ({ env: { APP_ORIGIN: 'https://three.ws' } }));
vi.mock('../api/_lib/usage.js', () => ({ flushUsageBuffer: (...a) => flushUsageBuffer(...a) }));
vi.mock('../api/_lib/x402/audit-log.js', () => ({ flushAuditBuffer: (...a) => flushAuditBuffer(...a) }));
vi.mock('../api/_lib/http.js', () => ({
	wrap: (fn) => fn,
	readBody: async (req) => Buffer.from(req._raw ?? '', 'utf8'),
	method: (req, res, allowed) => {
		if (allowed.includes(req.method)) return true;
		res._json = { status: 405, body: { error: 'method_not_allowed' } };
		return false;
	},
	json: (res, status, body) => { res._json = { status, body }; return res; },
	error: (res, status, code, message) => {
		res._json = { status, body: { error: code, error_description: message } };
		return res;
	},
}));

const handler = (await import('../api/jobs/flush-usage-events.js')).default;

/** Mint the JWT QStash sends: HS256 over the signing key, `sub` = delivery URL. */
function sign(key, url, body) {
	const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
	const now = Math.floor(Date.now() / 1000);
	const header = b64({ alg: 'HS256', typ: 'JWT' });
	const payload = b64({
		iss: 'Upstash',
		sub: url,
		iat: now,
		nbf: now - 5,
		exp: now + 300,
		jti: `test-${now}-${Math.round(now / 7)}`,
		body: createHash('sha256').update(body).digest('base64url'),
	});
	const sig = createHmac('sha256', key).update(`${header}.${payload}`).digest('base64url');
	return `${header}.${payload}.${sig}`;
}

function post({ signature, body = '{}', headers = {}, method = 'POST' } = {}) {
	const req = { method, headers: { host: 'three-ws-api-xyz.a.run.app', ...headers }, _raw: body };
	if (signature) req.headers['upstash-signature'] = signature;
	return req;
}

const res = () => ({ _json: null });

beforeEach(() => {
	process.env.QSTASH_CURRENT_SIGNING_KEY = CURRENT_KEY;
	flushUsageBuffer.mockClear();
	flushAuditBuffer.mockClear();
	vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterAll(() => {
	delete process.env.QSTASH_CURRENT_SIGNING_KEY;
	delete process.env.QSTASH_NEXT_SIGNING_KEY;
});

describe('POST /api/jobs/flush-usage-events', () => {
	it('accepts a job signed for the publisher origin and drains both buffers', async () => {
		const r = res();
		await handler(post({ signature: sign(CURRENT_KEY, `https://three.ws${JOB_PATH}`, '{}') }), r);
		expect(r._json.status).toBe(200);
		expect(r._json.body).toEqual({
			usage: { flushed: 4, remaining: 0, errors: 0 },
			audit: { flushed: 2, remaining: 0, errors: 0 },
		});
		expect(flushUsageBuffer).toHaveBeenCalledWith({ limit: 500 });
		expect(flushAuditBuffer).toHaveBeenCalledWith({ limit: 1000 });
	});

	it('accepts the rotation (next) signing key', async () => {
		const r = res();
		await handler(post({ signature: sign(NEXT_KEY, `https://three.ws${JOB_PATH}`, '{}') }), r);
		expect(r._json.status).toBe(200);
	});

	it('accepts a delivery to a hostname other than the configured origin', async () => {
		const r = res();
		await handler(post({
			signature: sign(CURRENT_KEY, `https://preview.three.ws${JOB_PATH}`, '{}'),
			headers: { 'x-forwarded-host': 'preview.three.ws', 'x-forwarded-proto': 'https' },
		}), r);
		expect(r._json.status).toBe(200);
	});

	it('rejects a request with no signature header', async () => {
		const r = res();
		await handler(post(), r);
		expect(r._json).toEqual({
			status: 401,
			body: { error: 'unauthorized', error_description: 'invalid qstash signature' },
		});
		expect(flushUsageBuffer).not.toHaveBeenCalled();
	});

	it('rejects a signature minted with an unknown key', async () => {
		const r = res();
		const foreign = 'dW5rbm93bi1rZXktbm90LW91cnMtYXQtYWxsLWZvci10ZXN0';
		await handler(post({ signature: sign(foreign, `https://three.ws${JOB_PATH}`, '{}') }), r);
		expect(r._json.status).toBe(401);
		expect(flushUsageBuffer).not.toHaveBeenCalled();
	});

	it('rejects a valid signature replayed from another endpoint', async () => {
		const r = res();
		await handler(post({ signature: sign(CURRENT_KEY, 'https://three.ws/api/jobs/other', '{}') }), r);
		expect(r._json.status).toBe(401);
	});

	it('rejects a body that does not match the signed hash', async () => {
		const r = res();
		await handler(post({
			signature: sign(CURRENT_KEY, `https://three.ws${JOB_PATH}`, '{}'),
			body: '{"evil":1}',
		}), r);
		expect(r._json.status).toBe(401);
		expect(flushUsageBuffer).not.toHaveBeenCalled();
	});

	it('refuses anything but POST', async () => {
		const r = res();
		await handler(post({ method: 'GET' }), r);
		expect(r._json.status).toBe(405);
		expect(flushUsageBuffer).not.toHaveBeenCalled();
	});

	it('reports a missing signing key as a configuration fault, not a bad signature', async () => {
		delete process.env.QSTASH_CURRENT_SIGNING_KEY;
		const r = res();
		await expect(handler(post({ signature: 'anything' }), r))
			.rejects.toThrow('Missing required env var: QSTASH_CURRENT_SIGNING_KEY');
		expect(r._json).toBeNull();
		expect(flushUsageBuffer).not.toHaveBeenCalled();
	});
});
