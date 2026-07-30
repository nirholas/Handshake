// /api/avatar/optimize refuses sources over its 50 MB cap.
//
// The cap used to be enforced as `Buffer.from(await upstream.arrayBuffer())`
// followed by a length check. That only measures AFTER the whole body is in
// memory, and it only short-circuits early when the server declares a
// content-length. A chunked response carries no such header, so an oversized
// source was downloaded in full before anyone measured it: the request looked
// like a stall instead of returning the documented 413.
//
// readCapped counts bytes as they arrive and aborts at the cap. These tests
// exercise it directly: the byte accounting and the abort are the whole fix.

import { describe, expect, it, vi } from 'vitest';

const { readCapped } = await import('../api/avatar/optimize.js');

const CAP = 1024;

// A body that yields `chunkSize` bytes per pull, up to `total`, and records how
// much it was actually asked for. A real oversized source is effectively endless;
// what matters is that the reader stops pulling once the cap is passed.
function streamingBody(chunkSize, total) {
	const stats = { yielded: 0 };
	return {
		stats,
		async *[Symbol.asyncIterator]() {
			let sent = 0;
			while (sent < total) {
				const n = Math.min(chunkSize, total - sent);
				sent += n;
				stats.yielded += n;
				yield Buffer.alloc(n, 1);
			}
		},
	};
}

function upstreamWith(body) {
	return { body, arrayBuffer: async () => { throw new Error('arrayBuffer must not be used when a stream exists'); } };
}

describe('readCapped', () => {
	it('returns the full body when it fits under the cap', async () => {
		const body = streamingBody(100, 500);
		const out = await readCapped(upstreamWith(body), CAP, null);

		expect(out.byteLength).toBe(500);
		expect(body.stats.yielded).toBe(500);
	});

	it('returns a body that lands exactly on the cap', async () => {
		const body = streamingBody(256, CAP);
		const out = await readCapped(upstreamWith(body), CAP, null);

		expect(out.byteLength).toBe(CAP);
	});

	it('throws too_large for a chunked body with NO content-length', async () => {
		const body = streamingBody(256, CAP * 100);

		await expect(readCapped(upstreamWith(body), CAP, null)).rejects.toMatchObject({ code: 'too_large' });
	});

	it('stops pulling instead of draining the whole oversized body', async () => {
		// The regression this pins: the old path read every byte before deciding.
		const body = streamingBody(256, CAP * 100);

		await readCapped(upstreamWith(body), CAP, null).catch(() => {});

		// It must give up shortly past the cap, not anywhere near the full body.
		expect(body.stats.yielded).toBeLessThanOrEqual(CAP + 256);
		expect(body.stats.yielded).toBeLessThan(CAP * 100);
	});

	it('aborts the upstream transfer when the cap is passed', async () => {
		const abort = { abort: vi.fn() };
		const body = streamingBody(256, CAP * 10);

		await readCapped(upstreamWith(body), CAP, abort).catch(() => {});

		expect(abort.abort).toHaveBeenCalledTimes(1);
	});

	it('still applies the cap when no stream is available', async () => {
		// Some responses arrive already buffered; the limit must hold there too.
		const buffered = { body: null, arrayBuffer: async () => new ArrayBuffer(CAP * 4) };

		await expect(readCapped(buffered, CAP, null)).rejects.toMatchObject({ code: 'too_large' });
	});

	it('returns a buffered under-cap body unchanged', async () => {
		const buffered = { body: null, arrayBuffer: async () => new ArrayBuffer(64) };

		const out = await readCapped(buffered, CAP, null);
		expect(out.byteLength).toBe(64);
	});
});
