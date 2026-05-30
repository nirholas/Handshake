import { describe, it, expect } from 'vitest';
import { isDecentralizedURI, resolveURI, normalizeGatewayURL } from '../../src/ipfs.js';

describe('isDecentralizedURI', () => {
	it('matches ipfs:// URIs', () => {
		expect(isDecentralizedURI('ipfs://QmCID')).toBe(true);
	});

	it('matches ar:// URIs', () => {
		expect(isDecentralizedURI('ar://txId')).toBe(true);
	});

	it('is case-insensitive', () => {
		expect(isDecentralizedURI('IPFS://QmCID')).toBe(true);
		expect(isDecentralizedURI('Ar://tx')).toBe(true);
	});

	it('rejects http/https URLs', () => {
		expect(isDecentralizedURI('https://example.com/foo')).toBe(false);
		expect(isDecentralizedURI('http://example.com/foo')).toBe(false);
	});

	it('rejects bare paths', () => {
		expect(isDecentralizedURI('/local/path.glb')).toBe(false);
		expect(isDecentralizedURI('model.glb')).toBe(false);
	});

	it('rejects empty string', () => {
		expect(isDecentralizedURI('')).toBe(false);
	});
});

describe('resolveURI', () => {
	it('maps ipfs:// CID to HTTPS gateway', () => {
		const out = resolveURI('ipfs://QmTestCID');
		expect(out).toMatch(/^https:\/\/.+\/ipfs\/QmTestCID$/);
	});

	it('preserves subpath on ipfs:// URIs', () => {
		const out = resolveURI('ipfs://QmTestCID/nested/file.glb');
		expect(out).toMatch(/\/ipfs\/QmTestCID\/nested\/file\.glb$/);
	});

	it('maps ar:// txId to arweave.net', () => {
		expect(resolveURI('ar://someTxId')).toBe('https://arweave.net/someTxId');
	});

	it('returns http(s) URLs unchanged', () => {
		expect(resolveURI('https://example.com/model.glb')).toBe('https://example.com/model.glb');
		expect(resolveURI('http://example.com/x')).toBe('http://example.com/x');
	});

	it('returns falsy input unchanged', () => {
		expect(resolveURI('')).toBe('');
		expect(resolveURI(null)).toBe(null);
		expect(resolveURI(undefined)).toBe(undefined);
	});

	it('cycles through gateways based on index', () => {
		const first = resolveURI('ipfs://QmCID', 0);
		const second = resolveURI('ipfs://QmCID', 1);
		const third = resolveURI('ipfs://QmCID', 2);
		// At least two of them should differ — we have 3 gateways configured.
		const set = new Set([first, second, third]);
		expect(set.size).toBeGreaterThan(1);
	});

	it('wraps gateway index modulo', () => {
		const zero = resolveURI('ipfs://QmCID', 0);
		const three = resolveURI('ipfs://QmCID', 3);
		expect(zero).toBe(three);
	});

	it('is case-insensitive on the scheme', () => {
		expect(resolveURI('IPFS://QmCID')).toMatch(/\/ipfs\/QmCID$/);
		expect(resolveURI('AR://tx')).toBe('https://arweave.net/tx');
	});

	it('repairs retired cf-ipfs.com gateway URLs', () => {
		const out = resolveURI('https://cf-ipfs.com/ipfs/QmTestCID');
		expect(out).not.toContain('cf-ipfs.com');
		expect(out).toMatch(/^https:\/\/.+\/ipfs\/QmTestCID$/);
	});
});

describe('normalizeGatewayURL', () => {
	it('rewrites cf-ipfs.com onto a working gateway, preserving the path', () => {
		const out = normalizeGatewayURL('https://cf-ipfs.com/ipfs/QmCID/img.png');
		expect(out).not.toContain('cf-ipfs.com');
		expect(out).toMatch(/\/ipfs\/QmCID\/img\.png$/);
	});

	it('rewrites cloudflare-ipfs.com too', () => {
		const out = normalizeGatewayURL('https://cloudflare-ipfs.com/ipfs/QmCID');
		expect(out).not.toContain('cloudflare-ipfs.com');
		expect(out).toMatch(/\/ipfs\/QmCID$/);
	});

	it('leaves live gateways and arbitrary URLs untouched', () => {
		expect(normalizeGatewayURL('https://ipfs.io/ipfs/QmCID')).toBe('https://ipfs.io/ipfs/QmCID');
		expect(normalizeGatewayURL('https://example.com/x.png')).toBe('https://example.com/x.png');
	});

	it('returns falsy input unchanged', () => {
		expect(normalizeGatewayURL('')).toBe('');
		expect(normalizeGatewayURL(null)).toBe(null);
	});
});
