// SSRF host-pinning for provider-returned GLB URLs. The auto-rig / reconstruct
// completion paths fetch a URL the provider hands back; a forged or compromised
// payload could point that fetch at cloud metadata, loopback, or an RFC1918
// address. These tests cover the two positive gates this module adds on top of
// ssrf-guard.js's IP/DNS checks: the scheme-validating extractor and the
// provider-host allowlist.

import { describe, it, expect, vi, beforeEach } from 'vitest';

// fetchProviderGlbBuffer delegates to ssrf-guard's pinned fetch (raw node http).
// Stub just that transport so the size-ceiling path can be exercised without a
// real socket; keep SsrfBlockedError real so `code === 'ssrf_blocked'` holds.
const pinnedFetchMock = vi.fn();
vi.mock('../api/_lib/ssrf-guard.js', async (importOriginal) => {
	const actual = await importOriginal();
	return { ...actual, fetchSafePublicUrlPinned: (...a) => pinnedFetchMock(...a) };
});

const {
	extractGlbUrl,
	isAllowedProviderResultUrl,
	assertProviderResultUrl,
	fetchProviderGlbBuffer,
	PROVIDER_RESULT_HOSTS,
	MAX_GLB_BYTES,
	SsrfBlockedError,
} = await import('../api/_lib/provider-result-url.js');

beforeEach(() => {
	vi.clearAllMocks();
});

describe('extractGlbUrl — only ever returns an http(s) string', () => {
	it('rejects non-http(s) string schemes', () => {
		expect(extractGlbUrl('file:///etc/passwd')).toBeNull();
		expect(extractGlbUrl('javascript:alert(1)')).toBeNull();
		expect(extractGlbUrl('gopher://x/1')).toBeNull();
		expect(extractGlbUrl('data:model/gltf-binary;base64,AAAA')).toBeNull();
	});

	it('rejects non-string / empty / numeric input', () => {
		expect(extractGlbUrl(42)).toBeNull();
		expect(extractGlbUrl(null)).toBeNull();
		expect(extractGlbUrl(undefined)).toBeNull();
		expect(extractGlbUrl('')).toBeNull();
		expect(extractGlbUrl({})).toBeNull();
	});

	it('rejects object/array members whose scheme is unsafe or non-string', () => {
		expect(extractGlbUrl({ url: 'gopher://x' })).toBeNull();
		expect(extractGlbUrl({ url: 169 })).toBeNull();
		expect(extractGlbUrl({ glb: 'file:///x.glb' })).toBeNull();
		expect(extractGlbUrl(['file:///a.glb', 'gopher://b'])).toBeNull();
	});

	it('returns a valid https string verbatim', () => {
		expect(extractGlbUrl('https://pbxt.replicate.delivery/x.glb')).toBe(
			'https://pbxt.replicate.delivery/x.glb',
		);
	});

	it('prefers the .glb entry from an array, only among http(s) entries', () => {
		expect(extractGlbUrl(['https://a/x.glb', 'https://b/y.png'])).toBe('https://a/x.glb');
		// Non-glb http entries still resolve to the first http(s) member.
		expect(extractGlbUrl(['https://b/y.png', 'https://a/z.bin'])).toBe('https://b/y.png');
	});

	it('reads the conventional object keys (http(s) only)', () => {
		expect(extractGlbUrl({ mesh_url: 'https://pbxt.replicate.delivery/m.glb' })).toBe(
			'https://pbxt.replicate.delivery/m.glb',
		);
		expect(extractGlbUrl({ model: 'https://replicate.delivery/out.glb' })).toBe(
			'https://replicate.delivery/out.glb',
		);
	});
});

describe('isAllowedProviderResultUrl — host allowlist (webhook semantics)', () => {
	it('seeds the allowlist from the Replicate delivery hosts', () => {
		expect(PROVIDER_RESULT_HOSTS).toEqual(
			expect.arrayContaining(['replicate.delivery', 'replicate.com', 'pbxt.replicate.delivery']),
		);
	});

	it('allows exact and dot-suffix matches over https', () => {
		expect(isAllowedProviderResultUrl('https://replicate.delivery/x.glb')).toBe(true);
		expect(isAllowedProviderResultUrl('https://pbxt.replicate.delivery/a/b/x.glb')).toBe(true);
		// dot-suffix: a sub-subdomain of an allowed host.
		expect(isAllowedProviderResultUrl('https://edge.pbxt.replicate.delivery/x.glb')).toBe(true);
		expect(isAllowedProviderResultUrl('https://cdn.replicate.com/x.glb')).toBe(true);
	});

	it('rejects http:// even on an allowed host', () => {
		expect(isAllowedProviderResultUrl('http://replicate.delivery/x.glb')).toBe(false);
		expect(isAllowedProviderResultUrl('http://pbxt.replicate.delivery/x.glb')).toBe(false);
	});

	it('rejects look-alike and unrelated hosts', () => {
		expect(isAllowedProviderResultUrl('https://replicate.delivery.evil.com/x.glb')).toBe(false);
		expect(isAllowedProviderResultUrl('https://notreplicate.delivery/x.glb')).toBe(false);
		expect(isAllowedProviderResultUrl('https://evil.com/x.glb')).toBe(false);
	});

	it('rejects private / loopback / metadata hosts', () => {
		expect(isAllowedProviderResultUrl('http://127.0.0.1/x.glb')).toBe(false);
		expect(isAllowedProviderResultUrl('https://127.0.0.1/x.glb')).toBe(false);
		expect(isAllowedProviderResultUrl('http://169.254.169.254/latest/meta-data')).toBe(false);
		expect(isAllowedProviderResultUrl('http://10.0.0.5/x.glb')).toBe(false);
		expect(isAllowedProviderResultUrl('http://192.168.1.10/x.glb')).toBe(false);
	});

	it('never throws on malformed input', () => {
		expect(isAllowedProviderResultUrl('not a url')).toBe(false);
		expect(isAllowedProviderResultUrl('')).toBe(false);
		expect(isAllowedProviderResultUrl(null)).toBe(false);
	});
});

describe('isAllowedProviderResultUrl — own GCS result buckets (gcp workers)', () => {
	// The env getter reads process.env at call time, so each test can set the
	// bucket list and restore it after.
	let savedBuckets;
	beforeEach(() => {
		savedBuckets = process.env.GCS_RESULT_BUCKETS;
		return () => {
			if (savedBuckets === undefined) delete process.env.GCS_RESULT_BUCKETS;
			else process.env.GCS_RESULT_BUCKETS = savedBuckets;
		};
	});

	it('accepts a path-style URL for the default production bucket', () => {
		delete process.env.GCS_RESULT_BUCKETS;
		expect(
			isAllowedProviderResultUrl(
				'https://storage.googleapis.com/three-ws-avatar-reconstructions/reconstruct/x.glb',
			),
		).toBe(true);
	});

	it('accepts virtual-hosted-style URLs for an allowed bucket', () => {
		process.env.GCS_RESULT_BUCKETS = 'bucket-a, bucket-b';
		expect(
			isAllowedProviderResultUrl('https://bucket-a.storage.googleapis.com/out/x.glb'),
		).toBe(true);
		expect(
			isAllowedProviderResultUrl('https://storage.googleapis.com/bucket-b/out/x.glb'),
		).toBe(true);
	});

	it('rejects any bucket not in the allowlist (host alone is never enough)', () => {
		process.env.GCS_RESULT_BUCKETS = 'bucket-a';
		expect(
			isAllowedProviderResultUrl('https://storage.googleapis.com/attacker-bucket/x.glb'),
		).toBe(false);
		expect(
			isAllowedProviderResultUrl('https://attacker-bucket.storage.googleapis.com/x.glb'),
		).toBe(false);
		// No object path at all: no bucket to match.
		expect(isAllowedProviderResultUrl('https://storage.googleapis.com/')).toBe(false);
	});

	it('rejects look-alike hosts and http downgrades', () => {
		process.env.GCS_RESULT_BUCKETS = 'bucket-a';
		expect(
			isAllowedProviderResultUrl('https://storage.googleapis.com.evil.com/bucket-a/x.glb'),
		).toBe(false);
		expect(
			isAllowedProviderResultUrl('http://storage.googleapis.com/bucket-a/x.glb'),
		).toBe(false);
	});
});

describe('assertProviderResultUrl', () => {
	it('returns the url on an allowed host', () => {
		const u = 'https://pbxt.replicate.delivery/x.glb';
		expect(assertProviderResultUrl(u)).toBe(u);
	});

	it('throws SsrfBlockedError (code ssrf_blocked, status 400) on a disallowed host', () => {
		for (const u of ['http://169.254.169.254/x.glb', 'https://evil.com/x.glb', 'http://127.0.0.1/x.glb']) {
			let thrown;
			try {
				assertProviderResultUrl(u);
			} catch (err) {
				thrown = err;
			}
			expect(thrown).toBeInstanceOf(SsrfBlockedError);
			expect(thrown.code).toBe('ssrf_blocked');
			expect(thrown.status).toBe(400);
		}
	});
});

describe('fetchProviderGlbBuffer — allowlist gate + size ceiling', () => {
	it('blocks a metadata/loopback/non-allowlisted host BEFORE opening any socket', async () => {
		for (const u of ['http://169.254.169.254/x.glb', 'https://localhost/x.glb', 'https://evil.com/x.glb']) {
			await expect(fetchProviderGlbBuffer(u)).rejects.toMatchObject({ code: 'ssrf_blocked' });
		}
		// The host gate runs first, so the pinned transport is never reached.
		expect(pinnedFetchMock).not.toHaveBeenCalled();
	});

	it('rejects an oversized content-length with the size error', async () => {
		pinnedFetchMock.mockResolvedValueOnce({
			ok: true,
			headers: { get: (k) => (k === 'content-length' ? String(MAX_GLB_BYTES + 1) : null) },
			arrayBuffer: async () => new ArrayBuffer(0),
		});
		await expect(
			fetchProviderGlbBuffer('https://pbxt.replicate.delivery/big.glb'),
		).rejects.toThrow(/glb too large/);
	});

	it('rejects a non-ok response with the status error', async () => {
		pinnedFetchMock.mockResolvedValueOnce({
			ok: false,
			status: 502,
			headers: { get: () => null },
			arrayBuffer: async () => new ArrayBuffer(0),
		});
		await expect(
			fetchProviderGlbBuffer('https://pbxt.replicate.delivery/x.glb'),
		).rejects.toThrow(/fetch glb: 502/);
	});

	it('returns the buffer for an allowed host within the size ceiling', async () => {
		const bytes = new Uint8Array([0x67, 0x6c, 0x54, 0x46]);
		pinnedFetchMock.mockResolvedValueOnce({
			ok: true,
			headers: { get: () => '4' },
			arrayBuffer: async () => bytes.buffer,
		});
		const buf = await fetchProviderGlbBuffer('https://pbxt.replicate.delivery/x.glb');
		expect(Buffer.isBuffer(buf)).toBe(true);
		expect(buf.equals(Buffer.from(bytes))).toBe(true);
		expect(pinnedFetchMock).toHaveBeenCalledOnce();
		// The pinned variant is used with allowHttp:false (forwarded/stored response).
		expect(pinnedFetchMock.mock.calls[0][2]).toMatchObject({ allowHttp: false });
	});
});
