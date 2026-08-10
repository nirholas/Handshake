// SSRF-hardening tests for api/_lib/fetch-model.js.
//
// The fetcher resolves DNS on our side, rejects private/loopback/link-local
// targets, and pins the undici connection to the validated address so a
// DNS-rebinding host cannot connect to an internal IP at connect time. We mock
// node:dns/promises so no real network/DNS is touched.

import { describe, it, expect, vi, beforeEach } from 'vitest';

process.env.PUBLIC_APP_ORIGIN ||= 'https://app.test';

const dnsState = { records: [], throws: false };
vi.mock('node:dns/promises', () => ({
	lookup: vi.fn(async () => {
		if (dnsState.throws) throw new Error('ENOTFOUND');
		return dnsState.records;
	}),
}));

const { fetchModel, FetchModelError } = await import('../../api/_lib/fetch-model.js');

beforeEach(() => {
	dnsState.records = [];
	dnsState.throws = false;
});

describe('fetchModel SSRF guard', () => {
	it('rejects a host that resolves to a private RFC1918 IPv4', async () => {
		dnsState.records = [{ address: '10.0.0.5', family: 4 }];
		await expect(fetchModel('https://internal.example.com/model.glb')).rejects.toMatchObject({
			code: 'private_address',
		});
	});

	it('rejects a host that resolves to loopback', async () => {
		dnsState.records = [{ address: '127.0.0.1', family: 4 }];
		await expect(fetchModel('https://localhost.evil.test/model.glb')).rejects.toMatchObject({
			code: 'private_address',
		});
	});

	it('rejects the cloud metadata link-local address', async () => {
		dnsState.records = [{ address: '169.254.169.254', family: 4 }];
		await expect(fetchModel('https://metadata.evil.test/latest/meta-data')).rejects.toMatchObject(
			{ code: 'private_address' },
		);
	});

	it('rejects a private IPv6 (ULA) address', async () => {
		dnsState.records = [{ address: 'fd00::1', family: 6 }];
		await expect(fetchModel('https://v6.evil.test/model.glb')).rejects.toMatchObject({
			code: 'private_address',
		});
	});

	it('rejects when ANY resolved address is private (mixed records)', async () => {
		// A rebinding host that returns one public + one private record must be
		// rejected wholesale — we never connect to the private one.
		dnsState.records = [
			{ address: '93.184.216.34', family: 4 }, // public
			{ address: '192.168.1.10', family: 4 }, // private
		];
		await expect(fetchModel('https://rebind.evil.test/model.glb')).rejects.toMatchObject({
			code: 'private_address',
		});
	});

	it('surfaces a dns_failed error (not a private-address false-positive) on NXDOMAIN', async () => {
		dnsState.throws = true;
		await expect(fetchModel('https://nope.example.com/model.glb')).rejects.toMatchObject({
			code: 'dns_failed',
		});
	});

	it('rejects a non-https scheme before any DNS work', async () => {
		await expect(fetchModel('ftp://example.com/model.glb')).rejects.toBeInstanceOf(
			FetchModelError,
		);
	});

	it('raises a private-address refusal as FetchModelError, not a raw SsrfError', async () => {
		// Callers branch on the CLASS to separate a caller-fault URL (400) from an
		// upstream failure (502). The per-hop resolution inside the redirect loop
		// used to let the SsrfError escape untyped, so a blocked URL was reported
		// to the caller as "our upstream broke, retry" on a URL that can never work.
		dnsState.records = [{ address: '10.1.2.3', family: 4 }];
		await expect(fetchModel('https://internal.example.com/model.glb')).rejects.toBeInstanceOf(
			FetchModelError,
		);
	});
});
