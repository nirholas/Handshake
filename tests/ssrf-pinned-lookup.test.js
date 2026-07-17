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
import { makePinnedLookup } from '../api/_lib/ssrf-guard.js';

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
