// The owner-visible listing and the public gallery totals are the two queries
// whose cost used to grow with the whole avatar catalog rather than with the
// page being served. Both were measured against the live 58k-row table:
//
//   listAvatars({ includePublic: true })  48.7 ms / 7,605 heap pages read,
//     because `(owner_id = $1 or visibility = 'public')` is unindexable and
//     Postgres seq-scanned and sorted every surviving row.
//   searchPublicAvatars({ withTotals })   42 ms sequential scan for the
//     count + view-count sum, on every single request.
//
// These tests lock in the shapes that fixed them: a UNION ALL of two indexed
// branches, and a cached aggregate. They assert on the SQL the module emits
// rather than on timings, so they stay meaningful without a database.

import { describe, it, expect, beforeEach, vi } from 'vitest';

process.env.S3_PUBLIC_DOMAIN ||= 'https://cdn.test';
process.env.S3_BUCKET ||= 'test-bucket';

const calls = [];
vi.mock('../api/_lib/db.js', () => ({
	sql: vi.fn(async (text, params) => {
		calls.push({ text: typeof text === 'string' ? text : String(text), params });
		return [];
	}),
	isDbUnavailableError: () => false,
	isDbCapacityError: () => false,
}));

const cacheWrapCalls = [];
vi.mock('../api/_lib/cache.js', () => ({
	cacheWrap: vi.fn(async (key, ttl, fn) => {
		cacheWrapCalls.push({ key, ttl });
		return fn();
	}),
}));

const { listAvatars, searchPublicAvatars } = await import('../api/_lib/avatars.js');

const USER = '11111111-2222-3333-4444-555555555555';

function lastSelect() {
	return calls[calls.length - 1];
}

beforeEach(() => {
	calls.length = 0;
	cacheWrapCalls.length = 0;
});

describe('listAvatars row selection', () => {
	it('unions two indexed branches instead of an unindexable OR', async () => {
		await listAvatars({ userId: USER, limit: 50, includePublic: true });
		const { text, params } = lastSelect();

		expect(text).toContain('union all');
		// The predicate that forced the seq scan must be gone.
		expect(text).not.toMatch(/owner_id = \$1 or/);
		// Owner branch and public branch, each ordered + limited on its own so
		// Postgres can serve them from avatars_owner_idx / avatars_public_idx.
		expect(text).toContain("where owner_id = $1 and deleted_at is null order by created_at desc");
		expect(text).toContain("where visibility = 'public' and owner_id is distinct from $1");
		// limit+1 drives both branches and the outer merge, so hasMore still works.
		expect(params[params.length - 1]).toBe(51);
	});

	it('excludes the caller from the public branch with is-distinct-from', async () => {
		// A plain `owner_id <> $1` drops every NULL-owner row from the catalog.
		await listAvatars({ userId: USER, includePublic: true });
		expect(lastSelect().text).toContain('owner_id is distinct from $1');
		expect(lastSelect().text).not.toContain('owner_id <> $1');
	});

	it('keeps a single indexed branch when the caller wants only their own', async () => {
		await listAvatars({ userId: USER, limit: 10 });
		const { text, params } = lastSelect();
		expect(text).not.toContain('union all');
		expect(text).toContain('where owner_id = $1');
		expect(params).toEqual([USER, 11]);
	});

	it('applies visibility and cursor filters to every branch', async () => {
		await listAvatars({
			userId: USER,
			includePublic: true,
			visibility: 'public',
			cursor: '2026-09-01T00:00:00.000Z',
			limit: 20,
		});
		const { text, params } = lastSelect();
		// Both branches share the filters, so a cursor page can never return rows
		// from one branch that the other already passed.
		expect(text.match(/visibility = \$2/g)?.length).toBe(2);
		expect(text.match(/created_at < \$3/g)?.length).toBe(2);
		expect(params).toEqual([USER, 'public', new Date('2026-09-01T00:00:00.000Z'), 21]);
	});

	it('joins the wide column list to the union result, not to a scan', async () => {
		await listAvatars({ userId: USER, includePublic: true });
		const { text } = lastSelect();
		expect(text).toContain('join avatars a on a.id = v.id');
		expect(text).toContain('order by v.created_at desc');
	});
});

describe('public gallery totals', () => {
	it('caches the catalog-wide aggregate for the endpoint cache window', async () => {
		await searchPublicAvatars({ limit: 24, withTotals: true });
		expect(cacheWrapCalls).toHaveLength(1);
		expect(cacheWrapCalls[0].ttl).toBe(60);
		expect(cacheWrapCalls[0].key).toMatch(/^avatars:public-totals:[0-9a-f]{40}$/);
	});

	it('keys the cache by the filter set so a filtered view never reads unfiltered numbers', async () => {
		await searchPublicAvatars({ limit: 24, withTotals: true });
		await searchPublicAvatars({ limit: 24, withTotals: true, rigged: 'rigged' });
		await searchPublicAvatars({ limit: 24, withTotals: true, tag: 'knight' });
		const keys = cacheWrapCalls.map((c) => c.key);
		expect(new Set(keys).size).toBe(3);
	});

	it('runs no aggregate at all when totals were not asked for', async () => {
		await searchPublicAvatars({ limit: 24 });
		expect(cacheWrapCalls).toHaveLength(0);
		expect(calls.some((c) => c.text.includes('count(*)'))).toBe(false);
	});
});
