// Reading content-addressed bytes back off IPFS.
//
// This is the retrieval half of signed agent manifests (specs/AGENT_MANIFEST.md
// § Signed envelope). It is the path an outside verifier walks, so its failure
// modes are the ones that decide whether "anyone can check this" is true or
// merely claimed. Two of them are covered here because both have bitten us:
// a retired gateway left in the fallback chain, and a serial walk that lets one
// hung gateway decide the whole read timed out.

import { describe, it, expect, afterEach, vi } from 'vitest';

import { IPFS_READ_GATEWAYS, fetchFromGateways } from '../api/_lib/ipfs-pin.js';

const CID = 'Qmc2vc5fgpQX9m5d2YJS7XvdAfF1yQLJpRyQtrHyW3kVy1';

const realFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = realFetch;
	vi.restoreAllMocks();
});

/** A fetch stub driven by a per-host script of outcomes. */
function stubFetch(plan) {
	const seen = [];
	globalThis.fetch = vi.fn(async (url) => {
		seen.push(url);
		const entry = Object.entries(plan).find(([host]) => String(url).includes(host));
		const outcome = entry ? entry[1] : { status: 504 };
		if (outcome.delayMs) await new Promise((r) => setTimeout(r, outcome.delayMs));
		if (outcome.throws) throw new Error(outcome.throws);
		return {
			ok: !outcome.status || outcome.status === 200,
			status: outcome.status || 200,
			headers: { get: (h) => (h === 'content-length' ? String(outcome.length ?? (outcome.body || '').length) : null) },
			text: async () => outcome.body ?? '',
		};
	});
	return seen;
}

describe('IPFS_READ_GATEWAYS', () => {
	// Cloudflare retired both of its public gateways in 2024 and flk-ipfs.xyz
	// stopped accepting connections. A dead host in a fallback chain is worse
	// than a missing one: it consumes the retry budget and reports a DNS failure
	// as though the document were unretrievable.
	it('lists no retired gateway hosts', () => {
		const retired = ['cloudflare-ipfs.com', 'cf-ipfs.com', 'flk-ipfs.xyz'];
		for (const host of retired) {
			expect(IPFS_READ_GATEWAYS.some((g) => g.includes(host))).toBe(false);
		}
	});

	it('leads with gateways that are independent of the platform and its pinning vendor', () => {
		expect(IPFS_READ_GATEWAYS[0]).toContain('ipfs.io');
		expect(IPFS_READ_GATEWAYS.some((g) => g.includes('three.ws'))).toBe(false);
	});

	// A freshly pinned CID can take hours to propagate across the DHT. Until it
	// does, the pinning provider's own gateway is the only copy in existence, so
	// dropping it would make every just-published manifest unverifiable.
	it('keeps the pinning provider gateway as the guaranteed-complete copy', () => {
		expect(IPFS_READ_GATEWAYS.some((g) => g.includes('pinata'))).toBe(true);
	});
});

describe('fetchFromGateways', () => {
	it('returns the body and the gateway that actually served it', async () => {
		stubFetch({ 'ipfs.io': { body: '{"ok":true}' } });
		const got = await fetchFromGateways(CID);
		expect(JSON.parse(got.text)).toEqual({ ok: true });
		expect(got.gateway).toBe(`https://ipfs.io/ipfs/${CID}`);
	});

	it('takes the one gateway holding the document when the rest 504', async () => {
		stubFetch({
			'ipfs.io': { status: 504 },
			'dweb.link': { status: 504 },
			'w3s.link': { status: 504 },
			'pinata': { body: '{"pinned":true}' },
		});
		const got = await fetchFromGateways(CID);
		expect(got.gateway).toContain('pinata');
		expect(JSON.parse(got.text)).toEqual({ pinned: true });
	});

	// The regression this guards: walking the list serially made the slowest
	// gateway the floor on every read, so a document one gateway could serve
	// immediately sat behind the timeouts of the ones that could not.
	it('queries every gateway concurrently rather than waiting out the slow ones', async () => {
		const seen = stubFetch({
			'ipfs.io': { delayMs: 60, status: 504 },
			'dweb.link': { delayMs: 60, status: 504 },
			'w3s.link': { delayMs: 60, status: 504 },
			'pinata': { body: '{"fast":true}' },
		});
		const started = Date.now();
		const got = await fetchFromGateways(CID);
		const elapsed = Date.now() - started;

		expect(got.gateway).toContain('pinata');
		expect(seen).toHaveLength(IPFS_READ_GATEWAYS.length);
		// Serial would have paid all three 60ms delays before reaching the winner.
		expect(elapsed).toBeLessThan(120);
	});

	it('reports every gateway it tried when none of them serve the CID', async () => {
		stubFetch({
			'ipfs.io': { status: 504 },
			'dweb.link': { throws: 'ENOTFOUND' },
			'w3s.link': { status: 404 },
			'pinata': { status: 403 },
		});
		await expect(fetchFromGateways(CID)).rejects.toMatchObject({ code: 'gateway_unreachable' });
		await expect(fetchFromGateways(CID)).rejects.toThrow(/504.*ENOTFOUND|ENOTFOUND.*504/s);
	});

	it('refuses a body larger than the budget the caller set', async () => {
		stubFetch({ 'ipfs.io': { body: 'x'.repeat(500), length: 500 } });
		await expect(fetchFromGateways(CID, { maxBytes: 100 })).rejects.toMatchObject({
			code: 'gateway_unreachable',
		});
	});

	it('honors an explicit gateway list', async () => {
		const seen = stubFetch({ 'example.test': { body: '{}' } });
		const got = await fetchFromGateways(CID, { gateways: ['https://example.test/ipfs/'] });
		expect(seen).toEqual([`https://example.test/ipfs/${CID}`]);
		expect(got.gateway).toContain('example.test');
	});
});
