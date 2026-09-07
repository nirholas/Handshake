/**
 * env.js S3 credential hygiene, unit test.
 *
 * The sibling of env-upstash-cred.test.js, for the bucket. A trailing newline or
 * stray space on S3_SECRET_ACCESS_KEY (the classic dashboard / secret-payload
 * paste artifact) is invisible and fatal: the AWS SDK signs the request with the
 * padded secret and R2 answers `SignatureDoesNotMatch`, which reads as "wrong
 * key" rather than "wrong bytes". That failure is total: the forge cannot park a
 * reference image, uploads cannot land, and /cdn cannot read an object, so the
 * getters trim at the source and no signer ever sees the padding.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { env } from '../api/_lib/env.js';

const KEYS = ['S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY', 'S3_ENDPOINT', 'S3_BUCKET', 'S3_PUBLIC_DOMAIN'];
let saved;

beforeEach(() => {
	saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
});

afterEach(() => {
	for (const k of KEYS) {
		if (saved[k] === undefined) delete process.env[k];
		else process.env[k] = saved[k];
	}
});

describe('S3 credential getters', () => {
	it('strips a trailing newline from the secret access key', () => {
		process.env.S3_SECRET_ACCESS_KEY = 'abc123secret\n';
		expect(env.S3_SECRET_ACCESS_KEY).toBe('abc123secret');
	});

	it('strips surrounding whitespace from the access key id', () => {
		process.env.S3_ACCESS_KEY_ID = '  AKIAEXAMPLE  ';
		expect(env.S3_ACCESS_KEY_ID).toBe('AKIAEXAMPLE');
	});

	it('leaves a clean credential untouched', () => {
		process.env.S3_SECRET_ACCESS_KEY = 'abc123secret';
		expect(env.S3_SECRET_ACCESS_KEY).toBe('abc123secret');
	});

	it('treats a whitespace-only credential as missing, not as configured', () => {
		process.env.S3_SECRET_ACCESS_KEY = '   \n';
		expect(() => env.S3_SECRET_ACCESS_KEY).toThrow(/S3_SECRET_ACCESS_KEY/);
	});
});
