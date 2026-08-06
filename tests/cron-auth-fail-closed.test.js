// Regression guard for the cron gate.
//
// 2026-07-23 audit: payment-session-sweep and forge-finalize failed OPEN when
// CRON_SECRET was unset ("allow in dev"), the only two handlers in /api/cron
// with an inverted posture. An unset CRON_SECRET on a misconfigured deploy would
// have exposed unauthenticated triggering of a money-moving sweep (session-budget
// refunds) and the forge finalize batch.
//
// 2026-08-06 (security review L8): the gate was copy-pasted into 78 files in
// eleven spellings, two of them with inverted return semantics. It now lives in
// exactly one module, so this suite tests that module — and asserts no handler
// has grown its own copy again, which is the failure mode that made a fail-open
// paste plausible in the first place.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { requireCron, isCronAuthorized } from '../api/_lib/cron-auth.js';

const API_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'api');

function mockRes() {
	const res = {
		statusCode: 0,
		headersSent: false,
		writableEnded: false,
		headers: {},
		body: null,
		setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
		end(payload) { this.writableEnded = true; this.body = payload ? JSON.parse(payload) : null; },
	};
	return res;
}

function walk(dir, out = []) {
	for (const entry of readdirSync(dir)) {
		const full = join(dir, entry);
		if (statSync(full).isDirectory()) walk(full, out);
		else if (full.endsWith('.js')) out.push(full);
	}
	return out;
}

describe('cron auth', () => {
	beforeEach(() => { delete process.env.CRON_SECRET; });
	afterEach(() => { delete process.env.CRON_SECRET; });

	it('fails closed (503) when CRON_SECRET is unset', () => {
		const res = mockRes();
		expect(requireCron({ headers: {} }, res)).toBe(false);
		expect(res.statusCode).toBe(503);
	});

	it('fails closed even when a credential is presented and CRON_SECRET is unset', () => {
		const res = mockRes();
		expect(requireCron({ headers: { 'x-cron-secret': 'anything' } }, res)).toBe(false);
		expect(res.statusCode).toBe(503);
	});

	it('401s when the secret is set but nothing is presented', () => {
		process.env.CRON_SECRET = 'test-cron-secret';
		const res = mockRes();
		expect(requireCron({ headers: {} }, res)).toBe(false);
		expect(res.statusCode).toBe(401);
	});

	it('401s on a wrong secret', () => {
		process.env.CRON_SECRET = 'test-cron-secret';
		const res = mockRes();
		expect(requireCron({ headers: { 'x-cron-secret': 'wrong' } }, res)).toBe(false);
		expect(res.statusCode).toBe(401);
	});

	it('401s on a near-miss (prefix of the real secret)', () => {
		process.env.CRON_SECRET = 'test-cron-secret';
		const res = mockRes();
		expect(requireCron({ headers: { authorization: 'Bearer test-cron-secre' } }, res)).toBe(false);
		expect(res.statusCode).toBe(401);
	});

	it('admits the correct secret via x-cron-secret', () => {
		process.env.CRON_SECRET = 'test-cron-secret';
		const res = mockRes();
		expect(requireCron({ headers: { 'x-cron-secret': 'test-cron-secret' } }, res)).toBe(true);
		expect(res.writableEnded).toBe(false);
	});

	it('admits the correct secret via Bearer, scheme case-insensitively', () => {
		process.env.CRON_SECRET = 'test-cron-secret';
		for (const scheme of ['Bearer', 'bearer', 'BEARER']) {
			const res = mockRes();
			expect(requireCron({ headers: { authorization: `${scheme} test-cron-secret` } }, res)).toBe(true);
			expect(res.writableEnded).toBe(false);
		}
	});

	it('never treats an x-vercel-cron header as authorization', () => {
		process.env.CRON_SECRET = 'test-cron-secret';
		const res = mockRes();
		expect(requireCron({ headers: { 'x-vercel-cron': '1' } }, res)).toBe(false);
		expect(res.statusCode).toBe(401);
	});

	it('isCronAuthorized answers without writing a response', () => {
		expect(isCronAuthorized({ headers: { 'x-cron-secret': 'anything' } })).toBe(false);
		process.env.CRON_SECRET = 'test-cron-secret';
		expect(isCronAuthorized({ headers: { 'x-cron-secret': 'test-cron-secret' } })).toBe(true);
		expect(isCronAuthorized({ headers: {} })).toBe(false);
	});
});

describe('cron auth has exactly one implementation', () => {
	it('no handler under api/ declares its own requireCron', () => {
		const offenders = walk(API_DIR)
			.filter((f) => !f.endsWith(join('_lib', 'cron-auth.js')))
			.filter((f) => /function\s+requireCron\s*\(/.test(readFileSync(f, 'utf8')))
			.map((f) => f.slice(API_DIR.length + 1));
		expect(offenders).toEqual([]);
	});
});
