/**
 * Object storage (R2) health sensor, unit test.
 *
 * On 2026-09-07 the bucket credential stopped verifying and every signed
 * operation failed with `SignatureDoesNotMatch`: text→3D returned an error for
 * every user on both the website and the ChatGPT surface, and /cdn answered 502
 * for every avatar and thumbnail on the site. Production healthz reported the
 * forge as `ok` throughout, because no subsystem held a signal for "our storage
 * credential is rejected". This pins the sensor that now does, including the
 * distinction that decides the runbook: a rejected credential (a human has to
 * re-set it) versus an unreachable endpoint (it may clear itself).
 */

import { describe, it, expect } from 'vitest';
import { classifyObjectStorageProbe } from '../api/_lib/ops/object-storage-health.js';

describe('classifyObjectStorageProbe', () => {
	it('stays neutral when storage is not configured on the deployment', () => {
		const v = classifyObjectStorageProbe({ configured: false });
		expect(v.status).toBe('unknown');
	});

	it('reads ok on a fast signed list', () => {
		const v = classifyObjectStorageProbe({ configured: true, ok: true, latencyMs: 120 });
		expect(v.status).toBe('ok');
		expect(v.detail).toContain('120ms');
	});

	it('degrades on a slow but working bucket', () => {
		const v = classifyObjectStorageProbe({ configured: true, ok: true, latencyMs: 1500 });
		expect(v.status).toBe('degraded');
	});

	it('reports a rejected credential as down, and says the secret is wrong', () => {
		const v = classifyObjectStorageProbe({
			configured: true,
			ok: false,
			error: new Error('The request signature we calculated does not match the signature you provided. Check your secret access key and signing method.'),
		});
		expect(v.status).toBe('down');
		expect(v.detail).toMatch(/rejected our credential/);
		expect(v.hint).toMatch(/S3_SECRET_ACCESS_KEY/);
	});

	it('separates an unreachable endpoint from a rejected credential', () => {
		const v = classifyObjectStorageProbe({
			configured: true,
			ok: false,
			error: new Error('getaddrinfo ENOTFOUND acct.r2.cloudflarestorage.com'),
		});
		expect(v.status).toBe('down');
		expect(v.detail).toMatch(/unreachable/);
		expect(v.hint).toMatch(/S3_ENDPOINT/);
	});
});
