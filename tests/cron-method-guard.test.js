// Regression guard for the HTTP-method allowlist on /api/cron handlers.
//
// 2026-08-10 audit: forge-finalize and payment-session-sweep called cors() for
// its headers but then only short-circuited OPTIONS, so they never checked the
// verb. A `DELETE /api/cron/forge-finalize` with a valid CRON_SECRET ran the
// full finalize batch and answered 200 (proven against a local server before
// the fix). The same shape in payment-session-sweep meant any verb could drive
// a money-moving sweep (session expiry + budget refunds to credit_ledger).
//
// Both are the exact pair that failed OPEN on the cron secret in the 2026-07-23
// audit (see cron-auth-fail-closed.test.js), because both were written from the
// same hand-rolled preamble instead of the shared helpers. So this suite guards
// the class, not just the two files: every handler under api/cron must run its
// verb through method() before doing any work.

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const API_CRON_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'api', 'cron');

function cronFiles(dir, out = []) {
	for (const entry of readdirSync(dir)) {
		const full = join(dir, entry);
		if (statSync(full).isDirectory()) cronFiles(full, out);
		else if (full.endsWith('.js')) out.push(full);
	}
	return out;
}

function mockRes() {
	return {
		statusCode: 0,
		headersSent: false,
		writableEnded: false,
		headers: {},
		body: null,
		setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
		end(payload) {
			this.writableEnded = true;
			this.body = payload ? JSON.parse(payload) : null;
		},
	};
}

const mockReq = (verb, url) => ({ method: verb, url, headers: {} });

// The two handlers the audit caught. Driven through their real exported
// handler, so this fails if the guard is ever removed again: a source grep
// alone would not catch a guard that runs after the work.
const AUDITED = [
	{ name: 'forge-finalize', path: '../api/cron/forge-finalize.js' },
	{ name: 'payment-session-sweep', path: '../api/cron/payment-session-sweep.js' },
];

describe('cron handlers enforce a method allowlist', () => {
	for (const { name, path } of AUDITED) {
		it(`${name} rejects a disallowed verb with 405 before doing any work`, async () => {
			const handler = (await import(path)).default;
			for (const verb of ['DELETE', 'PUT', 'PATCH']) {
				const res = mockRes();
				await handler(mockReq(verb, `/api/cron/${name}`), res);
				expect(res.statusCode, `${verb} ${name}`).toBe(405);
				expect(res.body?.error).toBe('method_not_allowed');
				// The rejection must advertise what IS allowed (RFC 9110 section 15.5.6).
				expect(res.headers.allow).toContain('GET');
			}
		});

		it(`${name} still answers the CORS preflight with 204`, async () => {
			const handler = (await import(path)).default;
			const res = mockRes();
			await handler(mockReq('OPTIONS', `/api/cron/${name}`), res);
			expect(res.statusCode).toBe(204);
			expect(res.headers['access-control-allow-methods']).toContain('GET');
		});

		it(`${name} lets an allowed verb through the guard to the auth gate`, async () => {
			const handler = (await import(path)).default;
			const res = mockRes();
			// No CRON_SECRET header: the fail-closed cron gate must be what stops
			// it (401 with a secret configured, 503 when the env has none, per
			// api/_lib/cron-auth.js), which proves the method guard did not reject
			// a legitimate verb before auth ever ran.
			await handler(mockReq('GET', `/api/cron/${name}`), res);
			expect([401, 503]).toContain(res.statusCode);
			expect(res.body?.error).not.toBe('method_not_allowed');
		});
	}

	// Class-level guard: no cron handler may set CORS headers and then act on a
	// request without ever consulting method(). This is the shape that produced
	// both bugs above.
	it('no api/cron handler calls cors() without a method() allowlist', () => {
		const offenders = cronFiles(API_CRON_DIR).filter((file) => {
			const src = readFileSync(file, 'utf8');
			return src.includes('cors(req, res') && !src.includes('method(req, res');
		});
		expect(offenders).toEqual([]);
	});
});
