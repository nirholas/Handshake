/**
 * keyFromPublicUrl() is the reverse of publicUrl(): it resolves a public CDN
 * URL back to the bucket key it serves, so deletion paths (forge-store
 * deleteCreation) can remove the actual bytes behind a URL-bearing column.
 * Real module, env stubbed only.
 */
import { describe, it, expect, beforeAll } from 'vitest';

beforeAll(() => {
	Object.assign(process.env, {
		S3_ENDPOINT: 'https://s3.example.com',
		S3_BUCKET: 'test-bucket',
		S3_PUBLIC_DOMAIN: 'https://cdn.example.com',
		S3_ACCESS_KEY_ID: 'test-key',
		S3_SECRET_ACCESS_KEY: 'test-secret',
	});
});

const { keyFromPublicUrl, publicUrl } = await import('../api/_lib/r2.js');

describe('keyFromPublicUrl', () => {
	it('round-trips publicUrl, including keys with encodable characters', () => {
		for (const key of [
			'forge/uploads/client-abc/photo.jpg',
			'forge/client-abc/creation.glb',
			'forge/uploads/client-abc/my photo (1).png',
		]) {
			expect(keyFromPublicUrl(publicUrl(key))).toBe(key);
		}
	});

	it('strips query strings and fragments', () => {
		expect(keyFromPublicUrl('https://cdn.example.com/forge/a.glb?x=1#frag')).toBe('forge/a.glb');
	});

	it('returns null for URLs outside our bucket domain', () => {
		expect(keyFromPublicUrl('https://replicate.delivery/pbxt/thing.png')).toBeNull();
		expect(keyFromPublicUrl('https://cdn.example.com.evil.com/forge/a.glb')).toBeNull();
		expect(keyFromPublicUrl('https://cdn.example.com')).toBeNull();
		expect(keyFromPublicUrl(null)).toBeNull();
		expect(keyFromPublicUrl('')).toBeNull();
	});
});
