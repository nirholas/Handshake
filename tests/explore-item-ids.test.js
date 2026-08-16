// Malformed ids on the public discover detail endpoints must be client errors,
// never 500s and never silent wrong answers.
//
// Two real defects this pins, both found by probing the live handlers:
//
//   1. GET /api/explore-item?kind=avatar&id=abc answered 500 internal_error.
//      `avatars.id` is a uuid column, so an unvalidated id reached Postgres as
//      22P02 (invalid input syntax for type uuid) and bubbled out of the handler
//      as an unhandled 5xx on an unauthenticated endpoint that anyone can hit,
//      complete with a Sentry event per request. The detail page (public/discover
//      /detail.js showError) renders its designed "Not found" state for 404 and a
//      generic "something went wrong" for anything else, so the bug also showed
//      the wrong empty state to every visitor who followed a stale avatar link.
//
//   2. Both handlers matched `agent_id = parseInt(id, 10)` against what is a TEXT
//      column holding a uint256 ERC-8004 token id. Any id past 2^53 rounds to a
//      float in exponent notation ("1.157920892373162e+77") that matches no row,
//      so a perfectly valid high agent id silently 404s instead of resolving.
//
// The malformed-input assertions below run without a database: every guard sits
// in front of the first query, so the response is the same with DATABASE_URL set
// or unset. That is deliberate: it keeps the regression pinned in CI.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer } from './helpers/test-server.js';
import { isErc8004AgentId, isUuid } from '../api/_lib/validate.js';
import { splitCapabilities } from '../api/explore-item.js';

describe('isErc8004AgentId', () => {
	it('accepts a uint256 token id well past what a JS number holds', () => {
		// 2^256 - 1, the widest legal ERC-8004 agent id.
		const max = '115792089237316195423570985008687907853269984665640564039457584007913129639935';
		expect(isErc8004AgentId(max)).toBe(true);
		// Why the raw string has to reach the query: the old parseInt() comparand
		// could not round-trip, so it matched no row in a TEXT column.
		expect(String(Number.parseInt(max, 10))).not.toBe(max);
		expect(String(Number.parseInt(max, 10))).toContain('e+');
	});

	it('accepts an ordinary id', () => {
		expect(isErc8004AgentId('50035')).toBe(true);
		expect(isErc8004AgentId('0')).toBe(true);
	});

	it('rejects anything that is not a bare digit string', () => {
		for (const bad of ['abc', '', '12a', '1.5', '-1', ' 12', '1e77', null, undefined, 12]) {
			expect(isErc8004AgentId(bad), `should reject ${JSON.stringify(bad)}`).toBe(false);
		}
	});

	it('rejects an id wider than uint256 so a padded flood cannot reach the query', () => {
		expect(isErc8004AgentId('9'.repeat(78))).toBe(true);
		expect(isErc8004AgentId('9'.repeat(79))).toBe(false);
	});
});

describe('splitCapabilities', () => {
	it('splits the free-text capability list the crawled registries publish', () => {
		expect(splitCapabilities('trading, analysis; imaging|research')).toEqual([
			'trading',
			'analysis',
			'imaging',
			'research',
		]);
	});

	it('passes an array through and drops empties', () => {
		expect(splitCapabilities([' a ', '', 'b'])).toEqual(['a', 'b']);
	});

	it('caps a padded entry so one row cannot flood the page', () => {
		expect(splitCapabilities(Array.from({ length: 100 }, (_, i) => `cap${i}`)).length).toBe(24);
		expect(splitCapabilities(Array.from({ length: 100 }, (_, i) => `cap${i}`).join(',')).length).toBe(24);
	});

	it('returns an empty list for a row with no capabilities', () => {
		expect(splitCapabilities(null)).toEqual([]);
		expect(splitCapabilities(undefined)).toEqual([]);
		expect(splitCapabilities(42)).toEqual([]);
	});
});

describe('GET /api/explore-item rejects malformed ids without a 500', () => {
	let BASE;
	let server;

	beforeAll(async () => {
		server = await startTestServer();
		BASE = server.base;
	}, 90000);

	afterAll(() => server?.close());

	it('answers 404, not 500, for an avatar id that is not a uuid', async () => {
		const res = await fetch(`${BASE}/api/explore-item?kind=avatar&id=abc`, {
			signal: AbortSignal.timeout(10000),
		});
		expect(res.status).toBe(404);
		const body = await res.json();
		expect(body.error).toBe('not_found');
	}, 15000);

	it('answers 404 for an on-chain agent id that is not a digit string', async () => {
		const res = await fetch(`${BASE}/api/explore-item?kind=onchain&chain=1&id=abc`, {
			signal: AbortSignal.timeout(10000),
		});
		expect(res.status).toBe(404);
		expect((await res.json()).error).toBe('not_found');
	}, 15000);

	it('still answers 400 when kind or id is missing at all', async () => {
		const res = await fetch(`${BASE}/api/explore-item`, { signal: AbortSignal.timeout(10000) });
		expect(res.status).toBe(400);
		expect((await res.json()).error).toBe('validation_error');
	}, 15000);

	it('still answers 400 for an unknown kind', async () => {
		const res = await fetch(`${BASE}/api/explore-item?kind=bogus&id=1`, {
			signal: AbortSignal.timeout(10000),
		});
		expect(res.status).toBe(400);
		expect((await res.json()).error).toBe('validation_error');
	}, 15000);

	it('serves the SSR shell for a malformed detail-page id instead of erroring', async () => {
		const res = await fetch(`${BASE}/api/discover-detail?kind=avatar&id=abc`, {
			signal: AbortSignal.timeout(10000),
		});
		expect(res.status).toBe(200);
		expect(res.headers.get('content-type')).toContain('text/html');
		expect(await res.text()).toContain('<title>three.ws</title>');
	}, 15000);
});
