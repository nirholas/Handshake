// The robots matcher is the part of Portal that decides whether we are allowed
// to read a page at all, so it is tested against the cases RFC 9309 actually
// specifies rather than the ones that felt obvious.
import { describe, it, expect } from 'vitest';
import { parseRobots, matchRule, isAllowed } from '../api/_lib/portal/robots.js';

const UA = 'threewsportalbot';

describe('parseRobots', () => {
	it('groups consecutive user-agent lines together', () => {
		const groups = parseRobots(`
User-agent: a
User-agent: b
Disallow: /x

User-agent: c
Disallow: /y
`);
		expect(groups).toHaveLength(2);
		expect(groups[0].agents).toEqual(['a', 'b']);
		expect(groups[0].rules).toEqual([{ allow: false, path: '/x' }]);
		expect(groups[1].agents).toEqual(['c']);
	});

	it('strips comments and ignores junk lines', () => {
		const groups = parseRobots('# hello\nUser-agent: * # everyone\nDisallow: /private # secret\nnonsense\n');
		expect(groups[0].rules).toEqual([{ allow: false, path: '/private' }]);
	});

	it('treats an empty Disallow as no rule at all', () => {
		expect(parseRobots('User-agent: *\nDisallow:')[0].rules).toEqual([]);
	});
});

describe('matchRule', () => {
	it('matches a prefix', () => {
		expect(matchRule('/docs', '/docs/page')).toBeGreaterThan(0);
		expect(matchRule('/docs', '/blog')).toBe(-1);
	});

	it('handles * wildcards anywhere in the pattern', () => {
		expect(matchRule('/*/private', '/a/private')).toBeGreaterThan(0);
		expect(matchRule('/*.pdf', '/files/report.pdf')).toBeGreaterThan(0);
		expect(matchRule('/*.pdf', '/files/report.html')).toBe(-1);
	});

	it('anchors with a trailing $', () => {
		expect(matchRule('/page$', '/page')).toBeGreaterThan(0);
		expect(matchRule('/page$', '/page/more')).toBe(-1);
	});
});

describe('isAllowed', () => {
	it('allows everything when robots.txt is missing or empty', () => {
		expect(isAllowed(null, '/anything', UA)).toBe(true);
		expect(isAllowed('', '/anything', UA)).toBe(true);
	});

	it('honours a wildcard group', () => {
		const body = 'User-agent: *\nDisallow: /private\n';
		expect(isAllowed(body, '/private/thing', UA)).toBe(false);
		expect(isAllowed(body, '/public', UA)).toBe(true);
	});

	it('prefers the most specific matching user-agent group', () => {
		const body = 'User-agent: *\nDisallow: /\n\nUser-agent: ThreeWSPortalBot\nAllow: /\n';
		expect(isAllowed(body, '/anything', UA)).toBe(true);
		expect(isAllowed(body, '/anything', 'someotherbot')).toBe(false);
	});

	it('lets the longest matching rule win, and Allow win a tie', () => {
		const body = 'User-agent: *\nDisallow: /docs\nAllow: /docs/public\n';
		expect(isAllowed(body, '/docs/secret', UA)).toBe(false);
		expect(isAllowed(body, '/docs/public/page', UA)).toBe(true);

		const tie = 'User-agent: *\nDisallow: /page\nAllow: /page\n';
		expect(isAllowed(tie, '/page', UA)).toBe(true);
	});

	it('reads the query string as part of the path, the way a crawler sends it', () => {
		const body = 'User-agent: *\nDisallow: /*?print=1\n';
		expect(isAllowed(body, '/article?print=1', UA)).toBe(false);
		expect(isAllowed(body, '/article', UA)).toBe(true);
	});
});
