import { describe, it, expect } from 'vitest';

// Query-param validation for the standalone x402 REST endpoints.
//
// Every case here started as a real 500 (or a silently wrong answer) observed by
// curling the running server on 2026-08-16:
//   • /api/x402-revenue?since=notadate  → 22P02 "invalid input syntax for type
//     timestamp with time zone" from the ::timestamptz cast, served as a 500 with
//     a support ref for what is plainly a caller typo.
//   • /api/x402-skus?id=notauuid        → 22P02 "invalid input syntax for type
//     uuid", same 500, on GET/PATCH/DELETE alike.
//   • /api/x402-ring?period=alll        → 200, silently widened to a lifetime
//     full-ledger scan instead of the requested window.
// A malformed param has to fail as a 4xx before it reaches Postgres, and the
// filter a response echoes has to be the filter it actually applied.

const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
process.env.X402_ASSET_MINT_SOLANA ||= USDC;

const { endpointSlug, timestampParam } = await import('../api/x402-revenue.js');
const { UUID_RE } = await import('../api/x402-skus.js');
const { PERIODS, sinceFor } = await import('../api/x402-ring.js');
const { TX_SIGNATURE_RE } = await import('../api/x402-pay.js');
const { REPO_RE, SESSION_RE, normalizeEnvelope } = await import('../api/zauth-reposcan.js');

describe('x402-revenue: timestamp params', () => {
	it('normalizes a parseable timestamp to ISO for the ::timestamptz bind', () => {
		expect(timestampParam('2026-08-01T00:00:00Z', 'since')).toBe('2026-08-01T00:00:00.000Z');
		expect(timestampParam('2026-08-01T00:00:00.000Z', 'cursor')).toBe('2026-08-01T00:00:00.000Z');
	});

	it('treats an absent param as no bound rather than as an error', () => {
		expect(timestampParam(null, 'since')).toBeNull();
		expect(timestampParam('', 'cursor')).toBeNull();
		expect(timestampParam(undefined, 'since')).toBeNull();
	});

	it('rejects an unparseable value with a 400-carrying, param-named error', () => {
		expect(() => timestampParam('notadate', 'since')).toThrowError(/since/);
		try {
			timestampParam('zzz', 'cursor');
			throw new Error('expected a throw');
		} catch (err) {
			expect(err.status).toBe(400);
			expect(err.code).toBe('invalid_cursor');
		}
	});
});

describe('x402-revenue: endpoint filter', () => {
	it('accepts a bare slug, a path, and a full route as the same filter', () => {
		expect(endpointSlug('crypto-intel')).toBe('crypto-intel');
		expect(endpointSlug('api/x402/crypto-intel')).toBe('crypto-intel');
		expect(endpointSlug('/api/x402/crypto-intel')).toBe('crypto-intel');
	});

	it('reports the sanitized slug, never the raw string the caller sent', () => {
		// The response echoes this back as `filter.endpoint`; echoing the raw value
		// claimed a traversal string was the applied filter when it never was.
		expect(endpointSlug('../../etc/passwd')).toBe('etcpasswd');
		expect(endpointSlug('  token-intel  ')).toBe('token-intel');
	});

	it('collapses an empty or all-punctuation filter to no filter', () => {
		expect(endpointSlug('')).toBeNull();
		expect(endpointSlug(null)).toBeNull();
		expect(endpointSlug('///')).toBeNull();
	});
});

describe('x402-skus: id shape', () => {
	it('accepts a uuid in either case', () => {
		expect(UUID_RE.test('00000000-0000-4000-8000-000000000000')).toBe(true);
		expect(UUID_RE.test('A1B2C3D4-E5F6-4A7B-8C9D-0E1F2A3B4C5D')).toBe(true);
	});

	it('rejects everything Postgres would have thrown 22P02 on', () => {
		for (const bad of ['notauuid', '', '00000000-0000-4000-8000', 'a,b', "' or 1=1--"]) {
			expect(UUID_RE.test(bad)).toBe(false);
		}
	});
});

describe('x402-ring: period window', () => {
	it('advertises exactly the windows the handler can resolve', () => {
		expect(PERIODS).toEqual(['24h', '7d', '30d', 'all']);
	});

	it('resolves a windowed period to a cutoff in the past and lifetime to null', () => {
		const since = sinceFor('24h');
		expect(Date.parse(since)).toBeLessThan(Date.now());
		expect(Date.now() - Date.parse(since)).toBeCloseTo(24 * 3600 * 1000, -4);
		expect(sinceFor('all')).toBeNull();
	});

	it('keeps a typo out of the lifetime window: it is not an accepted period', () => {
		expect(PERIODS.includes('alll')).toBe(false);
		expect(PERIODS.includes('bogus')).toBe(false);
	});
});

describe('x402-pay: call lookup key', () => {
	it('accepts a real Solana signature', () => {
		expect(
			TX_SIGNATURE_RE.test(
				'5fEhhh54bqAwjZGSzw9o5FbJq5yGsPnQEGtL8bbsHDd14CqixcH9haYtSXysmaAsNVGKwNkYSG6VdZnGSStPqka9',
			),
		).toBe(true);
	});

	it('rejects non-base58 and unbounded values before they become a Redis key', () => {
		expect(TX_SIGNATURE_RE.test('nope!!')).toBe(false);
		expect(TX_SIGNATURE_RE.test('short')).toBe(false);
		expect(TX_SIGNATURE_RE.test('0OIl'.repeat(20))).toBe(false); // base58 excludes 0 O I l
		expect(TX_SIGNATURE_RE.test('A'.repeat(400))).toBe(false);
	});
});

describe('zauth-reposcan: proxy input shapes', () => {
	it('accepts an owner/repo pair and refuses anything else', () => {
		expect(REPO_RE.test('nirholas/three.ws')).toBe(true);
		expect(REPO_RE.test('not a repo')).toBe(false);
		expect(REPO_RE.test('owner/repo/extra')).toBe(false);
		expect(REPO_RE.test('/repo')).toBe(false);
	});

	it('bounds the free progress-poll session token', () => {
		expect(SESSION_RE.test('abcdefgh12345678')).toBe(true);
		expect(SESSION_RE.test('short')).toBe(false);
		expect(SESSION_RE.test('<script>')).toBe(false);
	});

	it('rewrites resource.url to the upstream endpoint without touching the signature', () => {
		const payload = { transaction: 'signed-transfer-bytes' };
		const sent = Buffer.from(
			JSON.stringify({ x402Version: 2, payload, resource: { url: 'https://three.ws/api/zauth-reposcan' } }),
		).toString('base64');
		const forwarded = JSON.parse(Buffer.from(normalizeEnvelope(sent), 'base64').toString('utf8'));
		expect(forwarded.resource.url).toBe('https://api.zauth.inc/x402/reposcan');
		expect(forwarded.payload).toEqual(payload);
	});

	it('forwards an envelope it cannot read untouched rather than mangling it', () => {
		expect(normalizeEnvelope('not-base64-json')).toBe('not-base64-json');
		const noPayload = Buffer.from(JSON.stringify({ x402Version: 2 })).toString('base64');
		expect(normalizeEnvelope(noPayload)).toBe(noPayload);
	});
});
