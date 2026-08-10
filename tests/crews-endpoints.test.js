import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { crewTagFromRequest } from '../api/crews/[tag].js';

// Contract tests for the crews HTTP surface. `/api/crews/:tag` is the public,
// shareable URL of a crew, so which crew it answers for has to be decided by the
// path and nothing else, and a link with a trailing slash is still that link.

const root = resolve(import.meta.dirname, '..');
const read = (p) => readFileSync(resolve(root, p), 'utf8');

describe('GET /api/crews/:tag tag resolution', () => {
	it('reads the tag out of the path', () => {
		expect(crewTagFromRequest({ url: '/api/crews/NOVA' })).toBe('NOVA');
	});

	it('resolves a link that carries a trailing slash', () => {
		expect(crewTagFromRequest({ url: '/api/crews/NOVA/' })).toBe('NOVA');
	});

	it('upper-cases so /api/crews/nova is the same crew', () => {
		expect(crewTagFromRequest({ url: '/api/crews/nova' })).toBe('NOVA');
	});

	it('prefers the route param, so ?tag= cannot answer for another crew', () => {
		const req = { url: '/api/crews/NOVA?tag=AXIOM', query: { tag: 'NOVA' } };
		expect(crewTagFromRequest(req)).toBe('NOVA');
	});

	it('rejects a tag outside the 2-6 char grammar', () => {
		expect(crewTagFromRequest({ url: '/api/crews/N' })).toBe('');
		expect(crewTagFromRequest({ url: '/api/crews/TOOMANYCHARS' })).toBe('');
	});

	it('rejects a malformed percent-escape instead of throwing', () => {
		expect(crewTagFromRequest({ url: '/api/crews/%E0%A4%A' })).toBe('');
	});
});

describe('POST /api/crews', () => {
	it('CSRF-guards mutations for cookie callers, like the friends graph', () => {
		const src = read('api/crews/index.js');
		expect(src).toContain("import { requireCsrf } from '../_lib/csrf.js'");
		expect(src).toContain('if (!(await requireCsrf(req, res, me))) return;');
		// The guard has to sit ahead of the mutation switch, not beside it.
		expect(src.indexOf('requireCsrf(req, res, me)')).toBeLessThan(src.indexOf("case 'create'"));
	});

	it('answers a bad envelope with its own status instead of "unknown action"', () => {
		const src = read('api/crews/index.js');
		expect(src).toContain("return error(res, e?.status || 400, 'bad_body'");
		expect(src).toContain("return error(res, 400, 'bad_body', 'body must be a JSON object')");
	});
});

describe('GET /api/crews/search', () => {
	it('bounds the search term at the boundary', () => {
		expect(read('api/crews/search.js')).toContain("slice(0, 64)");
	});

	it('reuses the crew it already resolved instead of looking it up twice', () => {
		expect(read('api/crews/search.js')).toContain('searchInvitees(auth.userId, q, { crew })');
		expect(read('api/_lib/crews-store.js')).toContain('const myCrew = crew || (await getMyCrew(meId));');
	});
});
