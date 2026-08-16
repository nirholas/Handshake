import { describe, it, expect, afterEach, vi } from 'vitest';

import { fetchOgImage, MAX_OG_IMAGE_BYTES } from '../api/_lib/og-avatar.js';
import { parseLimit } from '../api/trending.js';

const realFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = realFetch;
	vi.restoreAllMocks();
});

/** A Response whose body streams `bytes` in `chunkSize` pieces, like a real host. */
function imageResponse(bytes, { ct = 'image/png', contentLength, status = 200, chunkSize = 4096 } = {}) {
	const headers = new Headers();
	if (ct) headers.set('content-type', ct);
	if (contentLength !== null) headers.set('content-length', String(contentLength ?? bytes.length));

	let offset = 0;
	const body = new ReadableStream({
		pull(controller) {
			if (offset >= bytes.length) return controller.close();
			controller.enqueue(bytes.subarray(offset, offset + chunkSize));
			offset += chunkSize;
		},
	});
	return { ok: status >= 200 && status < 300, status, headers, body };
}

function mockFetch(response) {
	const spy = vi.fn(async () => (typeof response === 'function' ? response() : response));
	globalThis.fetch = spy;
	return spy;
}

describe('og-avatar: fetchOgImage main path', () => {
	it('returns the inline-ready image for a real portrait response', async () => {
		const png = Buffer.alloc(2048, 7);
		mockFetch(imageResponse(png));

		const got = await fetchOgImage('https://cdn.example.test/a.png');

		expect(got).not.toBeNull();
		expect(got.ct).toBe('image/png');
		expect(Buffer.from(got.b64, 'base64').equals(png)).toBe(true);
	});

	it('strips charset parameters off the content type', async () => {
		mockFetch(imageResponse(Buffer.alloc(16, 1), { ct: 'image/svg+xml; charset=utf-8' }));
		expect((await fetchOgImage('https://cdn.example.test/a.svg')).ct).toBe('image/svg+xml');
	});
});

describe('og-avatar: fetchOgImage failure paths', () => {
	it('rejects a body that outgrows the cap even when content-length lied', async () => {
		const huge = Buffer.alloc(MAX_OG_IMAGE_BYTES + 8192, 3);
		// Host claims a tiny image, then streams a huge one: the stream cap is the
		// only thing standing between this and an unbounded read.
		mockFetch(imageResponse(huge, { contentLength: 64 }));

		expect(await fetchOgImage('https://cdn.example.test/huge.png')).toBeNull();
	});

	it('rejects an oversized image on its declared content-length alone', async () => {
		const spy = mockFetch(imageResponse(Buffer.alloc(8, 1), { contentLength: MAX_OG_IMAGE_BYTES + 1 }));
		expect(await fetchOgImage('https://cdn.example.test/big.png')).toBeNull();
		expect(spy).toHaveBeenCalledOnce();
	});

	it('rejects a non-image response, so an HTML error page never lands in the card', async () => {
		mockFetch(imageResponse(Buffer.from('<!doctype html>'), { ct: 'text/html' }));
		expect(await fetchOgImage('https://cdn.example.test/oops')).toBeNull();
	});

	it('returns null for a non-ok status', async () => {
		mockFetch(imageResponse(Buffer.alloc(8), { status: 404 }));
		expect(await fetchOgImage('https://cdn.example.test/missing.png')).toBeNull();
	});

	it('swallows a thrown fetch rather than breaking the unfurl', async () => {
		globalThis.fetch = vi.fn(async () => { throw new Error('ENOTFOUND'); });
		expect(await fetchOgImage('https://cdn.example.test/dead.png')).toBeNull();
	});

	it('never fetches a non-http URL', async () => {
		const spy = mockFetch(imageResponse(Buffer.alloc(8)));
		for (const bad of [null, undefined, '', 'file:///etc/passwd', 'data:image/png;base64,AA', 42]) {
			expect(await fetchOgImage(bad)).toBeNull();
		}
		expect(spy).not.toHaveBeenCalled();
	});
});

describe('trending: parseLimit', () => {
	it('clamps a real limit into 1..20', () => {
		expect(parseLimit('5')).toBe(5);
		expect(parseLimit('999')).toBe(20);
		expect(parseLimit('-4')).toBe(1);
		expect(parseLimit('0')).toBe(1);
	});

	it('falls back to the default instead of producing "limit NaN"', () => {
		// The regression: Number('abc') reached Postgres as NaN, both rankings
		// failed, and the board answered 200 with an empty list.
		for (const raw of ['abc', '', null, undefined, 'NaN', ' ']) {
			expect(parseLimit(raw)).toBe(10);
		}
	});
});
