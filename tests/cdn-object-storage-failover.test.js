/**
 * /cdn/<key> failover, unit test.
 *
 * The signed read exists to dodge the public bucket domain's rate limit, not
 * because the public domain is unavailable: the same bytes are readable there,
 * unauthenticated, the whole time. On 2026-09-07 the R2 credential stopped
 * verifying and this route answered `upstream_error` for every avatar, thumbnail
 * and GLB on the site while `pub-….r2.dev` was serving those same keys with a
 * 200. A credential fault now redirects there instead of 502ing the page.
 *
 * The redirect is deliberately uncacheable: the moment the credential is healthy
 * again, traffic has to return to the signed path rather than sit pinned on the
 * rate-limited domain by a cached hop.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const send = vi.fn();
vi.mock('../api/_lib/r2.js', async (importOriginal) => {
	const actual = await importOriginal();
	return { ...actual, r2: { send: (...args) => send(...args) } };
});

const { default: handler } = await import('../api/cdn-object.js');

const KEYS = ['S3_ENDPOINT', 'S3_BUCKET', 'S3_PUBLIC_DOMAIN', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY'];
let saved;

function makeRes() {
	return {
		statusCode: 200,
		headers: {},
		body: '',
		setHeader(k, v) {
			this.headers[k.toLowerCase()] = String(v);
		},
		getHeader(k) {
			return this.headers[k.toLowerCase()];
		},
		end(chunk) {
			if (chunk) this.body += chunk;
			this.ended = true;
			return this;
		},
	};
}

const req = (key) => ({ method: 'GET', url: `/api/cdn-object?key=${key}`, headers: {}, query: { key } });

function s3Error(name, message) {
	const err = new Error(message);
	err.name = name;
	err.Code = name;
	err.$metadata = { httpStatusCode: 403 };
	return err;
}

beforeEach(() => {
	saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
	process.env.S3_ENDPOINT = 'https://acct.r2.cloudflarestorage.com';
	process.env.S3_BUCKET = 'three-ws';
	process.env.S3_PUBLIC_DOMAIN = 'https://pub-example.r2.dev';
	process.env.S3_ACCESS_KEY_ID = 'AKIAEXAMPLE';
	process.env.S3_SECRET_ACCESS_KEY = 'secret';
	send.mockReset();
});

afterEach(() => {
	for (const k of KEYS) {
		if (saved[k] === undefined) delete process.env[k];
		else process.env[k] = saved[k];
	}
});

describe('/cdn on a storage credential fault', () => {
	it('redirects to the public bucket domain instead of 502ing the object', async () => {
		send.mockRejectedValue(
			s3Error(
				'SignatureDoesNotMatch',
				'The request signature we calculated does not match the signature you provided. Check your secret access key and signing method.',
			),
		);
		const res = makeRes();
		await handler(req('thumb/abc.png'), res);
		expect(res.statusCode).toBe(302);
		expect(res.getHeader('location')).toBe('https://pub-example.r2.dev/thumb/abc.png');
	});

	it('never lets the fallback hop be cached', async () => {
		send.mockRejectedValue(s3Error('InvalidAccessKeyId', 'The AWS Access Key Id you provided does not exist in our records.'));
		const res = makeRes();
		await handler(req('u/1/model.glb'), res);
		expect(res.statusCode).toBe(302);
		expect(res.getHeader('cache-control')).toBe('no-store');
	});

	it('still 404s a missing object rather than bouncing it to the public domain', async () => {
		send.mockRejectedValue(s3Error('NoSuchKey', 'The specified key does not exist.'));
		const res = makeRes();
		await handler(req('thumb/gone.png'), res);
		expect(res.statusCode).toBe(404);
	});

	it('keeps 502ing a fault that says nothing about our credentials', async () => {
		const err = new Error('unexpected upstream state');
		err.$metadata = { httpStatusCode: 500 };
		send.mockRejectedValue(err);
		const res = makeRes();
		await handler(req('thumb/abc.png'), res);
		expect(res.statusCode).toBe(502);
	});
});
