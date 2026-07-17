// Regression guard for the IP-pinned Agent's custom DNS lookup.
//
// Node enables autoSelectFamily (Happy Eyeballs) by default, and for a
// dual-stack host it calls a custom `lookup` with `{ all: true }`, expecting the
// array form `cb(null, [{ address, family }])`. The pinned-fetch helper used to
// return only the legacy positional form, so under `all:true` Node read
// `undefined` as the address and threw `Invalid IP address: undefined` before
// any socket opened — silently breaking every pinned fetch to a dual-stack host
// (storage.googleapis.com, the GCP avatar-reconstruction result bucket). These
// tests pin both lookup contracts so the array shape can never regress.

import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import { makePinnedLookup, collectCappedBody, MaxBytesExceededError } from '../api/_lib/ssrf-guard.js';

// Minimal stand-ins for a Node http.IncomingMessage / ClientRequest pair. The
// response is an EventEmitter we drive manually; both record whether their
// socket was torn down so a test can assert the cap aborts the transfer.
function fakeResponse(headers = {}) {
	const res = new EventEmitter();
	res.headers = headers;
	res.destroyed = false;
	res.destroy = () => { res.destroyed = true; };
	return res;
}
function fakeRequest() {
	return { destroyed: false, destroy() { this.destroyed = true; } };
}

describe('makePinnedLookup', () => {
	it('returns the array form when options.all is true (autoSelectFamily path)', () => {
		const lookup = makePinnedLookup('142.250.73.123');
		let out;
		lookup('storage.googleapis.com', { all: true }, (err, ...rest) => {
			out = { err, rest };
		});
		expect(out.err).toBeNull();
		// Modern contract: a SINGLE array argument of { address, family } records.
		expect(out.rest).toHaveLength(1);
		expect(out.rest[0]).toEqual([{ address: '142.250.73.123', family: 4 }]);
	});

	it('returns the legacy positional form when options.all is falsy', () => {
		const lookup = makePinnedLookup('142.250.73.123');
		let out;
		lookup('example.com', {}, (err, address, family) => {
			out = { err, address, family };
		});
		expect(out.err).toBeNull();
		expect(out.address).toBe('142.250.73.123');
		expect(out.family).toBe(4);
	});

	it('reports family 6 for an IPv6 pinned address', () => {
		const lookup = makePinnedLookup('2607:f8b0:400a:802::201b');
		let all;
		lookup('h', { all: true }, (_e, records) => { all = records; });
		expect(all).toEqual([{ address: '2607:f8b0:400a:802::201b', family: 6 }]);

		let legacyFamily;
		lookup('h', undefined, (_e, _a, fam) => { legacyFamily = fam; });
		expect(legacyFamily).toBe(6);
	});

	it('never yields an undefined address in either contract (the original bug)', () => {
		const lookup = makePinnedLookup('74.125.195.207');
		for (const options of [{ all: true }, { all: false }, {}, undefined]) {
			lookup('h', options, (_e, a, _f) => {
				// Under all:true, `a` is the array; otherwise the address string.
				const address = Array.isArray(a) ? a[0]?.address : a;
				expect(address).toBe('74.125.195.207');
				expect(address).not.toBeUndefined();
			});
		}
	});
});

describe('collectCappedBody streaming byte ceiling', () => {
	it('buffers the whole body when under the cap', async () => {
		const res = fakeResponse({ 'content-length': '6' });
		const req = fakeRequest();
		const p = collectCappedBody(res, req, 1024);
		res.emit('data', Buffer.from('foo'));
		res.emit('data', Buffer.from('bar'));
		res.emit('end');
		const body = await p;
		expect(body.toString()).toBe('foobar');
		expect(res.destroyed).toBe(false);
	});

	it('rejects up front on an over-limit content-length, before any data', async () => {
		const res = fakeResponse({ 'content-length': String(100 * 1024 * 1024) });
		const req = fakeRequest();
		await expect(collectCappedBody(res, req, 64 * 1024 * 1024)).rejects.toBeInstanceOf(MaxBytesExceededError);
		// Sockets torn down so nothing streams.
		expect(res.destroyed).toBe(true);
		expect(req.destroyed).toBe(true);
	});

	it('aborts mid-stream when actual bytes exceed the cap despite a lying/absent header', async () => {
		const res = fakeResponse({}); // no content-length advertised
		const req = fakeRequest();
		const p = collectCappedBody(res, req, 10);
		res.emit('data', Buffer.from('12345'));
		res.emit('data', Buffer.from('678901')); // crosses 10 here
		await expect(p).rejects.toBeInstanceOf(MaxBytesExceededError);
		expect(res.destroyed).toBe(true);
		expect(req.destroyed).toBe(true);
	});

	it('is unbounded when maxBytes is null (prior behavior preserved)', async () => {
		const res = fakeResponse({ 'content-length': String(5 * 1024 * 1024) });
		const req = fakeRequest();
		const p = collectCappedBody(res, req, null);
		res.emit('data', Buffer.alloc(5 * 1024 * 1024));
		res.emit('end');
		const body = await p;
		expect(body.length).toBe(5 * 1024 * 1024);
		expect(res.destroyed).toBe(false);
	});

	it('carries observed and limit sizes on the error for logging', async () => {
		const res = fakeResponse({ 'content-length': '2000' });
		const req = fakeRequest();
		const err = await collectCappedBody(res, req, 1000).catch((e) => e);
		expect(err).toBeInstanceOf(MaxBytesExceededError);
		expect(err.observed).toBe(2000);
		expect(err.limit).toBe(1000);
		expect(err.status).toBe(413);
		expect(err.code).toBe('max_bytes_exceeded');
	});
});
