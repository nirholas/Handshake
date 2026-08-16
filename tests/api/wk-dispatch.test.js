/**
 * /api/wk dispatcher: name lookup must never touch Object.prototype.
 *
 * The well-known dispatcher resolved handlers with a bare `DISPATCH[name]` on an
 * object literal, so every inherited key was a "route". Measured against
 * production on 2026-08-16, before the fix:
 *
 *   GET /api/wk?name=constructor      → no response at all; the request held a
 *                                       request slot until the gateway gave up
 *                                       (Object was called as the handler and
 *                                       returned a value instead of replying)
 *   GET /api/wk?name=hasOwnProperty   → 500 internal_error
 *
 * Both are reachable anonymously, and `/wk/<name>` + `/.well-known/*` route into
 * the same dispatcher. The hang is the serious half: it is a free way to pin
 * server capacity. These tests pin the own-property lookup and the reflection
 * cap that goes with it.
 */

import { describe, it, expect } from 'vitest';
import handler from '../../api/wk.js';

function fakeReq(name) {
	const qs = name === undefined ? '' : `?name=${encodeURIComponent(name)}`;
	return { method: 'GET', headers: {}, url: `/api/wk${qs}`, query: name === undefined ? {} : { name } };
}

function fakeRes() {
	const headers = {};
	return {
		statusCode: 0,
		body: undefined,
		ended: false,
		setHeader(k, v) {
			headers[String(k).toLowerCase()] = v;
		},
		getHeader(k) {
			return headers[String(k).toLowerCase()];
		},
		end(b) {
			this.body = b;
			this.ended = true;
		},
		_headers: headers,
	};
}

async function call(name) {
	const res = fakeRes();
	await handler(fakeReq(name), res);
	return { res, json: res.body ? JSON.parse(res.body) : undefined };
}

describe('/api/wk name dispatch', () => {
	for (const inherited of ['constructor', 'hasOwnProperty', 'toString', 'valueOf', '__proto__', 'isPrototypeOf']) {
		it(`answers 404 for the inherited key "${inherited}" instead of hanging or 500ing`, async () => {
			const { res, json } = await call(inherited);
			expect(res.ended).toBe(true);
			expect(res.statusCode).toBe(404);
			expect(json.error).toBe('not_found');
		});
	}

	it('still serves a real well-known resource', async () => {
		const { res, json } = await call('x402');
		expect(res.statusCode).toBe(200);
		expect(Array.isArray(json.schemes)).toBe(true);
	});

	it('answers 404 with no name', async () => {
		const { res, json } = await call(undefined);
		expect(res.statusCode).toBe(404);
		expect(json.error).toBe('not_found');
	});

	it('caps how much of the caller input it echoes back', async () => {
		const { res, json } = await call('A'.repeat(5000));
		expect(res.statusCode).toBe(404);
		// Prefix + at most 64 echoed characters, not the whole 5 KB.
		expect(json.error_description.length).toBeLessThan(120);
		expect(json.error_description).toContain('A'.repeat(64));
		expect(json.error_description).not.toContain('A'.repeat(65));
	});
});
