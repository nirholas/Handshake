/**
 * publicUrlOrNull() is the read-path variant of publicUrl(): where publicUrl()
 * throws "Missing required env var: S3_PUBLIC_DOMAIN" on a deployment without
 * object storage (correct for an upload path, which has nowhere to put bytes),
 * a feed only wants a URL to render and must degrade to its designed empty
 * state instead of failing the whole response.
 *
 * That throw was a live defect: /api/pulse answered 502 pulse_failed and
 * /api/search answered 503 not_configured for EVERY caller as soon as one row
 * carried a thumbnail key, because both mapped rows through bare publicUrl().
 *
 * Real module, env stubbed only. Storage-unset cases import a fresh copy of the
 * module registry so the env read happens with S3_PUBLIC_DOMAIN genuinely absent.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

const STORAGE_ENV = {
	S3_ENDPOINT: 'https://s3.example.com',
	S3_BUCKET: 'test-bucket',
	S3_PUBLIC_DOMAIN: 'https://cdn.example.com',
	S3_ACCESS_KEY_ID: 'test-key',
	S3_SECRET_ACCESS_KEY: 'test-secret',
};

const savedPublicDomain = process.env.S3_PUBLIC_DOMAIN;

beforeAll(() => {
	Object.assign(process.env, STORAGE_ENV);
});

afterAll(() => {
	if (savedPublicDomain === undefined) delete process.env.S3_PUBLIC_DOMAIN;
	else process.env.S3_PUBLIC_DOMAIN = savedPublicDomain;
});

const { publicUrlOrNull, thumbnailUrl, publicUrl } = await import('../api/_lib/r2.js');

// Load a second, independent instance of the module with storage unconfigured.
async function withStorageUnset(fn) {
	const previous = process.env.S3_PUBLIC_DOMAIN;
	delete process.env.S3_PUBLIC_DOMAIN;
	vi.resetModules();
	try {
		return await fn(await import('../api/_lib/r2.js'));
	} finally {
		process.env.S3_PUBLIC_DOMAIN = previous;
		vi.resetModules();
	}
}

describe('publicUrlOrNull with object storage configured', () => {
	it('resolves a bucket key exactly like publicUrl', () => {
		const key = 'u/42/avatar.glb';
		expect(publicUrlOrNull(key)).toBe(publicUrl(key));
		expect(publicUrlOrNull(key)).toBe('https://cdn.example.com/u/42/avatar.glb');
	});

	it('passes an already-absolute storage key through untouched', () => {
		expect(publicUrlOrNull('https://three.ws/avatars/realistic-male.glb')).toBe(
			'https://three.ws/avatars/realistic-male.glb',
		);
	});

	it('returns null for an absent key rather than a domain-only URL', () => {
		expect(publicUrlOrNull(null)).toBeNull();
		expect(publicUrlOrNull(undefined)).toBeNull();
		expect(publicUrlOrNull('')).toBeNull();
	});

	it('still resolves thumbnails, and still drops legacy poisoned OG keys', () => {
		expect(thumbnailUrl('u/42/thumb.png')).toBe('https://cdn.example.com/u/42/thumb.png');
		expect(thumbnailUrl('https://three.ws/avatar/x_og.png')).toBeNull();
	});
});

describe('publicUrlOrNull without object storage', () => {
	it('degrades to null where publicUrl throws', async () => {
		await withStorageUnset((r2) => {
			expect(() => r2.publicUrl('u/42/avatar.glb')).toThrow(/S3_PUBLIC_DOMAIN/);
			expect(r2.publicUrlOrNull('u/42/avatar.glb')).toBeNull();
			expect(r2.thumbnailUrl('u/42/thumb.png')).toBeNull();
		});
	});

	it('still passes an absolute key through, since it needs no CDN domain', async () => {
		await withStorageUnset((r2) => {
			expect(r2.publicUrlOrNull('https://three.ws/avatars/realistic-male.glb')).toBe(
				'https://three.ws/avatars/realistic-male.glb',
			);
		});
	});
});
