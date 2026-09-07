// The avatar thumbnail pipeline retires a model after MAX_ATTEMPTS failed
// renders, which is correct for a corrupt GLB and wrong for anything that failed
// because the environment was broken. Two classifiers decide which is which, and
// getting them wrong is permanent: a blameless avatar never gets a thumbnail
// again. This file pins the failure strings that were actually observed in the
// live backfill ledger, in both directions.

import { describe, it, expect } from 'vitest';
import { isBrowserInfrastructureError, INFRA_ERROR_PATTERN } from '../api/_lib/render-glb.js';
import {
	isStorageInfrastructureError,
	objectStorageConfigured,
	STORAGE_ERROR_PATTERN,
} from '../api/_lib/r2.js';

const blameless = (err) => isBrowserInfrastructureError(err) || isStorageInfrastructureError(err);

describe('blameless render failures', () => {
	it('treats a dead or unlaunchable browser as the environment’s fault', () => {
		// Four avatars sat permanently retired at attempts=3 on "spawn EFAULT":
		// the kernel refusing the fork, charged to the model.
		expect(blameless(new Error('spawn EFAULT'))).toBe(true);
		expect(blameless(new Error('spawn ENOMEM'))).toBe(true);
		expect(blameless(new Error('Connection closed.'))).toBe(true);
		expect(blameless(new Error('Failed to launch the browser process'))).toBe(true);
		expect(blameless(new Error('Protocol error: Target closed'))).toBe(true);
	});

	it('treats unconfigured or unreachable object storage as the environment’s fault', () => {
		// Every claim in a batch fails identically on this one, so without it a
		// storage outage retires the whole remaining backlog in three ticks.
		expect(blameless(new Error('Missing required env var: S3_BUCKET'))).toBe(true);
		expect(blameless(new Error('Missing required env var: S3_ACCESS_KEY_ID'))).toBe(true);
		expect(blameless(new Error('InvalidAccessKeyId'))).toBe(true);
		expect(blameless(new Error('NoSuchBucket: the bucket does not exist'))).toBe(true);
		expect(blameless({ message: 'connect ECONNREFUSED 10.0.0.1:443' })).toBe(true);
	});

	it('still blames the model for a model-attributable failure', () => {
		// These are the errors the live ledger retired legitimately. If any of them
		// were reclassified, a broken GLB would be retried forever.
		expect(blameless(new Error('glb fetch failed: upstream returned 404'))).toBe(false);
		expect(blameless(new Error('render failed: glb decode failed: Unexpected token'))).toBe(false);
		expect(blameless(new Error('renderer returned no bytes'))).toBe(false);
		expect(blameless(new Error('Waiting failed: 15000ms exceeded'))).toBe(false);
		expect(blameless(new Error('Unexpected status code: 504.'))).toBe(false);
	});

	it('handles a non-Error throw without crashing the batch runner', () => {
		expect(blameless('spawn EAGAIN')).toBe(true);
		expect(blameless(null)).toBe(false);
		expect(blameless(undefined)).toBe(false);
	});
});

describe('classifier patterns are reusable as SQL', () => {
	// resetInfrastructureFailures() builds its `~*` predicate from these strings
	// instead of keeping a hand-copied alternation, which had already drifted.
	// Postgres ERE has no lookarounds, backreferences, or \d-style shorthands.
	it('stay inside the JS/POSIX-ERE intersection', () => {
		for (const pattern of [INFRA_ERROR_PATTERN, STORAGE_ERROR_PATTERN]) {
			expect(typeof pattern).toBe('string');
			expect(pattern).not.toMatch(/\(\?[=!:<]/);
			expect(pattern).not.toMatch(/\\[dwsbDWSB]/);
			expect(() => new RegExp(pattern, 'i')).not.toThrow();
		}
	});

	it('match every string their compiled counterpart matches', () => {
		const infra = new RegExp(INFRA_ERROR_PATTERN, 'i');
		const storage = new RegExp(STORAGE_ERROR_PATTERN, 'i');
		expect(infra.test('spawn EFAULT')).toBe(isBrowserInfrastructureError('spawn EFAULT'));
		expect(storage.test('Missing required env var: S3_BUCKET')).toBe(
			isStorageInfrastructureError('Missing required env var: S3_BUCKET'),
		);
	});
});

describe('objectStorageConfigured', () => {
	const KEYS = ['S3_ENDPOINT', 'S3_BUCKET', 'S3_PUBLIC_DOMAIN', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY'];

	function withEnv(values, fn) {
		const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
		try {
			for (const k of KEYS) {
				if (values[k] === undefined) delete process.env[k];
				else process.env[k] = values[k];
			}
			return fn();
		} finally {
			for (const k of KEYS) {
				if (saved[k] === undefined) delete process.env[k];
				else process.env[k] = saved[k];
			}
		}
	}

	const full = Object.fromEntries(KEYS.map((k) => [k, 'x']));

	it('is true only when every var the storage helpers dereference is present', () => {
		expect(withEnv(full, objectStorageConfigured)).toBe(true);
	});

	it('is false when any single var is missing', () => {
		for (const missing of KEYS) {
			const partial = { ...full, [missing]: undefined };
			expect(withEnv(partial, objectStorageConfigured), `missing ${missing}`).toBe(false);
		}
	});

	// A credential that is nothing but a newline is not configured storage: it
	// signs every request straight into a SignatureDoesNotMatch while a bare
	// truthiness check reads healthy.
	it('is false when any single var is blank', () => {
		for (const blank of KEYS) {
			const padded = { ...full, [blank]: '  \n' };
			expect(withEnv(padded, objectStorageConfigured), `blank ${blank}`).toBe(false);
		}
	});
});
