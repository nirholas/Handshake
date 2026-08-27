// Gateway rotation for decentralised content (src/ipfs.js).
//
// A CID is served identically by every IPFS gateway, but the app kept picking
// one and dead-ending on it: the ERC-8004 resolver baked `ipfs.io` into an
// agent's `image` and `body.uri` before the browser ever saw the `ipfs://`
// scheme, so a rate-limited ipfs.io (which happens to browsers routinely) left
// every /a/:chainId/:agentId page and every third-party <agent-3d> embed with a
// name, no avatar, and no way to recover. uriCandidates exists so a caller can
// walk the whole list, including when the gateway was already chosen upstream.

import { describe, it, expect } from 'vitest';

import { uriCandidates, resolveURI } from '../src/ipfs.js';

describe('uriCandidates', () => {
	it('expands an ipfs:// URI across every gateway, primary first', () => {
		const out = uriCandidates('ipfs://bafyCID/model.glb');
		expect(out.length).toBeGreaterThan(1);
		expect(out[0]).toBe(resolveURI('ipfs://bafyCID/model.glb'));
		expect(new Set(out).size).toBe(out.length);
		for (const url of out) expect(url.endsWith('bafyCID/model.glb')).toBe(true);
	});

	it('re-extracts the CID from a URL whose gateway was already chosen', () => {
		const out = uriCandidates('https://ipfs.io/ipfs/bafyCID');
		// The caller's own choice stays first (most likely warm in a CDN), and the
		// other gateways follow as recovery options.
		expect(out[0]).toBe('https://ipfs.io/ipfs/bafyCID');
		expect(out.length).toBeGreaterThan(1);
		expect(out.some((url) => url.startsWith('https://dweb.link/ipfs/bafyCID'))).toBe(true);
	});

	it('rewrites a retired gateway host onto a live one', () => {
		const out = uriCandidates('https://cloudflare-ipfs.com/ipfs/bafyCID');
		expect(out.every((url) => !url.includes('cloudflare-ipfs.com'))).toBe(true);
		expect(out.every((url) => url.endsWith('bafyCID'))).toBe(true);
	});

	it('returns one entry for a plain URL so callers can loop unconditionally', () => {
		expect(uriCandidates('https://cdn.example/model.glb')).toEqual(['https://cdn.example/model.glb']);
	});

	it('resolves an ar:// URI to its single gateway', () => {
		expect(uriCandidates('ar://TX123')).toEqual(['https://arweave.net/TX123']);
	});

	it('returns nothing for an empty URI', () => {
		expect(uriCandidates('')).toEqual([]);
		expect(uriCandidates(null)).toEqual([]);
	});
});
