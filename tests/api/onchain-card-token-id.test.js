// The on-chain social-card handlers (/api/a-og, /api/a-page) take the chain id
// and the ERC-721 token id straight off the query string. Both used to hand an
// unvalidated token id to `BigInt()` inside resolveOnChainAgent, which throws a
// SyntaxError on anything non-numeric: a caller typo became an unhandled 500
// plus a Sentry event and an ops alert. These pin the 4xx contract, and the
// resolver's own guard, so that cannot come back.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Readable } from 'node:stream';

process.env.PUBLIC_APP_ORIGIN ||= 'https://three.ws';

const resolved = { value: { chainId: 8453, agentId: '1', name: 'Nova', description: 'a guide' } };
const resolveSpy = vi.fn(async () => resolved.value);

vi.mock('../../api/_lib/onchain.js', async (importOriginal) => {
	// Keep isTokenId and SERVER_CHAIN_META real: the handlers' guards are exactly
	// what is under test here. Only the network read is replaced.
	const actual = await importOriginal();
	return { ...actual, resolveOnChainAgent: (...a) => resolveSpy(...a) };
});

const { default: ogHandler } = await import('../../api/a-og.js');
const { default: pageHandler } = await import('../../api/a-page.js');
const { isTokenId } = await import('../../api/_lib/onchain.js');
const { resolveOnChainAgent } = await vi.importActual('../../api/_lib/onchain.js');

function makeReq(url, method = 'GET') {
	const stream = Readable.from([]);
	stream.method = method;
	stream.url = url;
	stream.headers = { host: 'three.ws' };
	return stream;
}

function makeRes() {
	return {
		statusCode: 200,
		headers: {},
		body: '',
		writableEnded: false,
		setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
		getHeader(k) { return this.headers[k.toLowerCase()]; },
		end(chunk) { if (chunk !== undefined) this.body += String(chunk); this.writableEnded = true; },
	};
}

async function call(handler, url, method = 'GET') {
	const res = makeRes();
	await handler(makeReq(url, method), res);
	return res;
}

beforeEach(() => {
	resolveSpy.mockClear();
	resolved.value = { chainId: 8453, agentId: '1', name: 'Nova', description: 'a guide' };
});

describe('isTokenId', () => {
	it('accepts decimal token ids up to the uint256 ceiling', () => {
		expect(isTokenId('0')).toBe(true);
		expect(isTokenId('1')).toBe(true);
		expect(isTokenId(42)).toBe(true);
		expect(isTokenId(((1n << 256n) - 1n).toString())).toBe(true);
	});

	it('rejects anything a uint256 column cannot hold', () => {
		expect(isTokenId('abc')).toBe(false);
		expect(isTokenId('-1')).toBe(false);
		expect(isTokenId('1.5')).toBe(false);
		expect(isTokenId('0x01')).toBe(false);
		expect(isTokenId('1_000')).toBe(false);
		expect(isTokenId('')).toBe(false);
		expect(isTokenId(null)).toBe(false);
		expect(isTokenId((1n << 256n).toString())).toBe(false);
	});
});

describe('resolveOnChainAgent guards the token id', () => {
	it('reports a malformed id instead of throwing out of BigInt()', async () => {
		const result = await resolveOnChainAgent({ chainId: 8453, agentId: 'abc' });
		expect(result.error).toBe('invalid_agent_id');
	});
});

describe('GET /api/a-og', () => {
	it('400s a missing chain rather than resolving against chain 0', async () => {
		const res = await call(ogHandler, '/api/a-og?id=1');
		expect(res.statusCode).toBe(400);
		expect(resolveSpy).not.toHaveBeenCalled();
	});

	it('400s an unsupported chain', async () => {
		const res = await call(ogHandler, '/api/a-og?chain=999999&id=1');
		expect(res.statusCode).toBe(400);
		expect(JSON.parse(res.body).error).toBe('unsupported_chain');
		expect(resolveSpy).not.toHaveBeenCalled();
	});

	it('400s a non-numeric token id', async () => {
		const res = await call(ogHandler, '/api/a-og?chain=8453&id=abc');
		expect(res.statusCode).toBe(400);
		expect(resolveSpy).not.toHaveBeenCalled();
	});

	it('renders the SVG card for a resolvable agent', async () => {
		const res = await call(ogHandler, '/api/a-og?chain=8453&id=1');
		expect(res.statusCode).toBe(200);
		expect(res.headers['content-type']).toContain('image/svg+xml');
		expect(res.body).toContain('Nova');
	});

	it('still serves the card when the resolve degraded, with a short cache', async () => {
		// A chain_read error is ambiguous (missing token or a flaky RPC). Hard-404ing
		// it broke the social image of agents that do exist for as long as the edge
		// cached the 404.
		resolved.value = { chainId: 8453, agentId: '1', name: null, error: 'chain_read: timeout' };
		const res = await call(ogHandler, '/api/a-og?chain=8453&id=1');
		expect(res.statusCode).toBe(200);
		expect(res.headers['cache-control']).toBe('public, max-age=60');
	});

	it('rejects a non-GET method with 405', async () => {
		const res = await call(ogHandler, '/api/a-og?chain=8453&id=1', 'POST');
		expect(res.statusCode).toBe(405);
	});
});

describe('GET /api/a-page', () => {
	it('serves the designed 404 page for a non-numeric token id', async () => {
		const res = await call(pageHandler, '/api/a-page?chain=8453&id=abc');
		expect(res.statusCode).toBe(404);
		expect(res.headers['content-type']).toContain('text/html');
		expect(res.body).toContain('Agent not found');
		expect(resolveSpy).not.toHaveBeenCalled();
	});

	it('serves the metadata page for a valid id', async () => {
		const res = await call(pageHandler, '/api/a-page?chain=8453&id=1');
		expect(res.statusCode).toBe(200);
		expect(res.body).toContain('og:title');
		expect(res.body).toContain('Nova');
	});

	it('rejects a non-GET method with 405', async () => {
		const res = await call(pageHandler, '/api/a-page?chain=8453&id=1', 'POST');
		expect(res.statusCode).toBe(405);
	});
});
