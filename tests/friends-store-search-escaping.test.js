// searchUsers(): LIKE-pattern escaping in the friend search.
//
// The search wraps the caller's term in `%…%` and runs it through ILIKE, so
// every character Postgres treats as special has to be neutralised first. The
// escaper originally covered the two wildcards (% and _) but not the escape
// character itself, which broke two ways:
//
//   * a term ending in a backslash escaped the closing wildcard, so "neo\"
//     became the pattern %neo\% and matched a literal "neo%" instead;
//   * a backslash anywhere in the term escaped the following character, so a
//     display name holding one ("neo\matrix") could never be found.
//
// Escaping the backslash FIRST fixes both. These tests capture the pattern the
// store actually hands to Postgres, then assert the real matching semantics of
// each pattern against Postgres' documented ILIKE rules.

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Capture every query's parameters. The store composes a `publicUserCols()`
// fragment into its SELECT, so the mock has to return a fragment-ish object for
// the no-parameter column list and a normal result for real queries.
const queries = [];
vi.mock('../api/_lib/db.js', () => ({
	sql: Object.assign(
		vi.fn((strings, ...values) => {
			queries.push({ text: strings.join('?'), values });
			return Promise.resolve([]);
		}),
		{ transaction: vi.fn(async (fns) => { for (const f of fns) await f; }) },
	),
	isDbUnavailableError: () => false,
	isDbCapacityError: () => false,
}));

const { searchUsers } = await import('../api/_lib/friends-store.js');

const ME = '00000000-0000-0000-0000-0000000000aa';

// The LIKE pattern is the first parameter that starts and ends with a wildcard.
function capturedPattern() {
	for (const q of queries) {
		for (const v of q.values) {
			if (typeof v === 'string' && v.startsWith('%') && v.endsWith('%')) return v;
		}
	}
	return null;
}

// Postgres ILIKE, reduced to the rules this escaping depends on: a backslash
// escapes the next character (making it literal), an unescaped % matches any
// run, an unescaped _ matches one character.
function ilikeMatches(pattern, subject) {
	let rx = '';
	for (let i = 0; i < pattern.length; i++) {
		const c = pattern[i];
		if (c === '\\') { rx += pattern[++i]?.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') ?? ''; continue; }
		if (c === '%') { rx += '[\\s\\S]*'; continue; }
		if (c === '_') { rx += '[\\s\\S]'; continue; }
		rx += c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	}
	return new RegExp(`^${rx}$`, 'i').test(subject);
}

beforeEach(() => { queries.length = 0; });

describe('searchUsers LIKE escaping', () => {
	it('escapes a backslash so a name containing one is findable', async () => {
		await searchUsers(ME, 'o\\m');
		const pattern = capturedPattern();
		expect(pattern).toBe('%o\\\\m%');
		expect(ilikeMatches(pattern, 'neo\\matrix')).toBe(true);
	});

	it('keeps a trailing backslash from swallowing the closing wildcard', async () => {
		await searchUsers(ME, 'neo\\');
		const pattern = capturedPattern();
		// The term's backslash is escaped, so the final % stays a wildcard.
		expect(pattern).toBe('%neo\\\\%');
		expect(ilikeMatches(pattern, 'neo\\matrix')).toBe(true);
		// The pre-fix pattern matched a literal "neo%" and missed the real name.
		expect(ilikeMatches('%neo\\%', 'neo\\matrix')).toBe(false);
	});

	it('still escapes the wildcards themselves', async () => {
		await searchUsers(ME, 'pct%user');
		const pattern = capturedPattern();
		expect(pattern).toBe('%pct\\%user%');
		expect(ilikeMatches(pattern, 'pct%user')).toBe(true);
		expect(ilikeMatches(pattern, 'pctSOMETHINGuser')).toBe(false);
	});

	it('escapes the single-character wildcard', async () => {
		await searchUsers(ME, 'a_b');
		const pattern = capturedPattern();
		expect(pattern).toBe('%a\\_b%');
		expect(ilikeMatches(pattern, 'a_b')).toBe(true);
		expect(ilikeMatches(pattern, 'axb')).toBe(false);
	});

	it('never queries for a term shorter than two characters', async () => {
		expect(await searchUsers(ME, 'a')).toEqual([]);
		expect(await searchUsers(ME, ' ')).toEqual([]);
		expect(await searchUsers(ME, null)).toEqual([]);
		expect(queries.length).toBe(0);
	});
});
