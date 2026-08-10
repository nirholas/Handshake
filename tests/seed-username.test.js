/**
 * seed-username: the one username claim every synthetic-account seeder uses.
 *
 * The regression this pins: the three private copies this module replaced all
 * capped their "which variants exist" query at 100 rows, so a popular base word
 * (wolf had 101 variants in production, fog 336) came back with a truncated
 * taken-set and the helper cheerfully handed out a name that was already in the
 * table. Every seeder insert then hit `on conflict do nothing`, returned no row,
 * and the tick skipped. The avaturn seeder was a permanent no-op because of it.
 *
 * The query is asserted here as well as the return value: a future edit that
 * reintroduces a row cap, or drops the case-insensitive comparison that matches
 * the unique index on lower(username), fails these tests.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

let rows = [];
let queries = [];
vi.mock('../api/_lib/db.js', () => ({
	sql: (strings, ...values) => {
		queries.push({ text: strings.join('?').replace(/\s+/g, ' ').trim(), values });
		return Promise.resolve(rows);
	},
	isDbUnavailableError: () => false,
	isDbCapacityError: () => false,
}));

const { claimSeedUsername, seedDisplayName } = await import('../api/_lib/seed-username.js');

beforeEach(() => {
	rows = [];
	queries = [];
});

describe('claimSeedUsername', () => {
	it('returns the bare word when nothing is taken', async () => {
		expect(await claimSeedUsername('wolf')).toBe('wolf');
	});

	it('skips to the first free numbered slot', async () => {
		rows = ['wolf', 'wolf2', 'wolf3'].map((username) => ({ username }));
		expect(await claimSeedUsername('wolf')).toBe('wolf4');
	});

	it('walks past 99 instead of stopping there', async () => {
		const taken = ['wolf'];
		for (let n = 2; n <= 150; n++) taken.push(`wolf${n}`);
		rows = taken.map((username) => ({ username }));
		expect(await claimSeedUsername('wolf')).toBe('wolf151');
	});

	it('never returns a name the query reported as taken', async () => {
		// The exact shape of the old bug: a large taken-set. Nothing it returns
		// may collide, no matter how many variants exist.
		const taken = ['fog'];
		for (let n = 2; n <= 400; n++) taken.push(`fog${n}`);
		rows = taken.map((username) => ({ username }));
		const claimed = await claimSeedUsername('fog');
		expect(taken).not.toContain(claimed);
	});

	it('asks for the whole variant space, uncapped and case-insensitively', async () => {
		await claimSeedUsername('wolf');
		expect(queries).toHaveLength(1);
		expect(queries[0].text).not.toMatch(/limit/i);
		expect(queries[0].text).toContain('lower(username)');
		expect(queries[0].values[0]).toBe('^wolf[0-9]{0,3}$');
	});

	it('treats a differently-cased existing name as taken', async () => {
		rows = [{ username: 'wolf' }];
		expect(await claimSeedUsername('WOLF')).toBe('wolf2');
	});

	it('escapes regex metacharacters in a slugified base word', async () => {
		await claimSeedUsername('ada-lovelace');
		expect(queries[0].values[0]).toBe('^ada\\-lovelace[0-9]{0,3}$');
	});

	it('falls back to a hex suffix when every numbered slot is taken', async () => {
		const taken = ['zed'];
		for (let n = 2; n <= 999; n++) taken.push(`zed${n}`);
		rows = taken.map((username) => ({ username }));
		const claimed = await claimSeedUsername('zed');
		expect(claimed).toMatch(/^zed_[0-9a-f]{4}$/);
	});

	it('returns null for an empty word instead of querying', async () => {
		expect(await claimSeedUsername('   ')).toBeNull();
		expect(queries).toHaveLength(0);
	});
});

describe('seedDisplayName', () => {
	it('titles the bare word', () => {
		expect(seedDisplayName('wolf')).toBe('Wolf');
	});

	it('drops a numbered slot', () => {
		expect(seedDisplayName('wolf42')).toBe('Wolf');
	});

	it('drops the hex fallback suffix before titling', () => {
		// Stripping digits alone left the literal display name "Fog_".
		expect(seedDisplayName('fog_1a2b')).toBe('Fog');
	});
});
