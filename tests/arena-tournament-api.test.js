// Two guards on the Social Trading Arena's HTTP surface.
//
// 1. ROUTING. Filesystem routing matches a `[param].js` file only on the LAST
//    path segment, so `api/tournaments/[id].js` answered /api/tournaments/:id
//    and nothing under it. Join, withdraw, close, settle, and the SSE standings
//    stream all 404'd in production while the handler that implements them sat
//    right there, fully written, with a header comment documenting all five.
//    The Arena's Join button reported a failure and the live board's EventSource
//    reconnected against a 404 forever. Nothing in a diff shows this: the file
//    exists, the code is correct, and only the path shape decides whether it is
//    ever reached. So the URLs are asserted against the REAL resolver.
//
// 2. PRIZE PARSING. `prize_pool_three` arrives as JSON from the request body, and
//    the atomics conversion used to run through String(Number(x)). JS renders
//    anything past 1e21 or below 1e-6 in exponential notation, which BigInt
//    refuses, so `1e21` and `0.0000001` reached the handler as a 500 with a
//    support ref instead of a 400 telling the caller what was wrong.

// 3. RE-ENTRY. `joinTournament` inserts with `on conflict do nothing`, so an entry
//    the user had withdrawn stayed withdrawn on re-join while the API answered
//    `joined: true` and the UI toasted "Entered the arena". The agent then sat out
//    the rest of the bracket, scored nothing, and never appeared in the standings.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fileURLToPath } from 'node:url';
import { join, relative } from 'node:path';

import { resolveApi } from '../server/route-resolve.mjs';
import { threeToAtomics } from '../api/tournaments/index.js';

const db = vi.hoisted(() => ({ queries: [], conflict: true }));
vi.mock('../api/_lib/db.js', () => ({
	sql: (strings) => {
		const text = strings.join(' ? ');
		db.queries.push(text);
		if (/insert into tournament_entries/i.test(text)) {
			return Promise.resolve(db.conflict ? [] : [{ agent_id: 'a1', status: 'active' }]);
		}
		if (/update tournament_entries[\s\S]*status = 'active'/i.test(text)) {
			return Promise.resolve([{ agent_id: 'a1', status: 'active', wallet: 'W1' }]);
		}
		return Promise.resolve([]);
	},
}));

const { joinTournament } = await import('../api/_lib/tournament-store.js');

const REPO = fileURLToPath(new URL('..', import.meta.url));
const API_ROOT = join(REPO, 'api');
const ID = '53a2d208-92df-4e75-9cd7-a3c459f17bd6';

/** Resolve an /api/... pathname the way server/index.mjs does. */
function resolve(pathname) {
	const segments = pathname.replace(/^\/api\//, '').split('/').filter(Boolean);
	const hit = resolveApi(API_ROOT, segments, {});
	return hit ? relative(REPO, hit.file) : null;
}

describe('Arena tournament routes reach a handler', () => {
	it('resolves the collection endpoint', () => {
		expect(resolve('/api/tournaments')).toBe('api/tournaments/index.js');
	});

	it('resolves a single tournament', () => {
		expect(resolve(`/api/tournaments/${ID}`)).toBe('api/tournaments/[id].js');
	});

	it.each(['stream', 'join', 'withdraw', 'close', 'settle'])('resolves the %s action', (action) => {
		expect(resolve(`/api/tournaments/${ID}/${action}`)).toBe('api/tournaments/[id]/[action].js');
	});

	it('passes the id and action through as route params', () => {
		const hit = resolveApi(API_ROOT, ['tournaments', ID, 'join'], {});
		expect(hit.params).toEqual({ id: ID, action: 'join' });
	});
});

describe('threeToAtomics', () => {
	it('converts a decimal amount at the token decimals', () => {
		expect(threeToAtomics(1.5, 6)).toBe(1_500_000n);
		expect(threeToAtomics(0, 6)).toBe(0n);
		expect(threeToAtomics(250, 6)).toBe(250_000_000n);
	});

	it('reads a numeric string as written, past double precision', () => {
		expect(threeToAtomics('123456789.123456', 6)).toBe(123_456_789_123_456n);
		expect(threeToAtomics(' 10.5 ', 6)).toBe(10_500_000n);
	});

	it('truncates below one atomic instead of rounding up', () => {
		expect(threeToAtomics('0.0000019', 6)).toBe(1n);
	});

	it('answers null for exponential-notation numbers it cannot back', () => {
		expect(threeToAtomics(1e21, 6)).toBeNull();
		expect(threeToAtomics('1e6', 6)).toBeNull();
	});

	it('flattens a small exponential number rather than crashing on it', () => {
		expect(threeToAtomics(0.0000001, 6)).toBe(0n);
	});

	it('answers null for anything that is not a non-negative decimal', () => {
		expect(threeToAtomics(-5, 6)).toBeNull();
		expect(threeToAtomics(Number.NaN, 6)).toBeNull();
		expect(threeToAtomics(Number.POSITIVE_INFINITY, 6)).toBeNull();
		expect(threeToAtomics('abc', 6)).toBeNull();
		expect(threeToAtomics(true, 6)).toBeNull();
		expect(threeToAtomics({ a: 1 }, 6)).toBeNull();
		expect(threeToAtomics(null, 6)).toBeNull();
		expect(threeToAtomics(undefined, 6)).toBeNull();
	});
});
