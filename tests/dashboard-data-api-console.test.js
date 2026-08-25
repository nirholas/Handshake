// @vitest-environment jsdom
//
// /dashboard/data-api: the copyable quickstart and the endpoint catalog.
//
// Two things on this page used to lie to the reader. The quickstart pasted the
// stored key's PREFIX plus a literal ellipsis into a runnable curl command, so
// anyone with an active pass copied a header that can only ever answer 401. And
// the endpoint catalog hard-coded the corpus size, which drifts every hour the
// archive ingests. These pin the honest versions: a snippet only ever carries a
// key that works, and the catalog quotes a number only when it came from the
// live stats endpoint.

import { describe, it, expect } from 'vitest';

const { snippetKey, quickstartSnippets, catalogRows, ledeText, keysTableRows } =
	await import('../src/dashboard-next/pages/data-api.js');

const PLACEHOLDER = 'x402_live_YOUR_KEY';

describe('snippetKey', () => {
	it('uses the plaintext key minted this session', () => {
		expect(snippetKey({ freshKey: 'x402_live_realkeyvalue' })).toBe('x402_live_realkeyvalue');
	});

	it('falls back to the placeholder when no plaintext is held', () => {
		expect(snippetKey({})).toBe(PLACEHOLDER);
		expect(snippetKey()).toBe(PLACEHOLDER);
	});
});

describe('quickstartSnippets', () => {
	it('puts the key in the curl and JavaScript samples', () => {
		const s = quickstartSnippets('x402_live_realkeyvalue');
		expect(s.curl).toContain('X-API-Key: x402_live_realkeyvalue');
		expect(s.javascript).toContain("'X-API-Key': 'x402_live_realkeyvalue'");
	});

	it('never emits a truncated key, so every sample is runnable as copied', () => {
		for (const body of Object.values(quickstartSnippets(snippetKey({})))) {
			expect(body).not.toContain('…');
		}
	});

	it('offers curl, JavaScript, and MCP', () => {
		expect(Object.keys(quickstartSnippets(PLACEHOLDER))).toEqual(['curl', 'javascript', 'mcp']);
	});
});

describe('catalogRows', () => {
	it('quotes the live corpus size and first year when the stats probe landed', () => {
		const [archive] = catalogRows({ articles: 760074, sinceYear: 2017, feedSources: 197 });
		expect(archive[1]).toContain('760,074 articles');
		expect(archive[1]).toContain('back to 2017');
	});

	it('reads the feed source count from the registry', () => {
		const feed = catalogRows({ feedSources: 197 }).find(([ep]) => ep === 'GET /api/news/feed');
		expect(feed[1]).toBe('Live headlines from 197 publisher feeds');
	});

	it('stays true without inventing a number when the probe has not landed', () => {
		const rows = catalogRows({});
		for (const [, what] of rows) expect(what).not.toMatch(/\d[\d,]{2,}/);
		expect(rows[0][1]).toContain('Search the full archive');
		expect(rows.find(([ep]) => ep === 'GET /api/news/feed')[1])
			.toBe('Live headlines from the publisher feed registry');
	});

	it('keeps archive search premium and the stats/trending/feed/digest modes free', () => {
		const access = Object.fromEntries(catalogRows({}).map(([ep, , a]) => [ep, a]));
		expect(access['GET /api/news/archive']).toContain('Premium');
		expect(access['GET /api/news/archive?stats=true']).toBe('Free');
		expect(access['GET /api/news/feed']).toBe('Free');
	});
});

describe('ledeText', () => {
	it('names the live article count when the stats probe landed', () => {
		const t = ledeText({ total_articles: 760074, first_article_date: '2017-09-23T10:00:42.000Z' });
		expect(t).toContain('760,074-article');
		expect(t).toContain('Coverage runs back to 2017.');
	});

	it('drops the figure rather than shipping a stale one', () => {
		const t = ledeText(null);
		expect(t).not.toMatch(/\d[\d,]{2,}/);
		expect(t).toContain('crypto-news archive as a developer product');
	});
});

describe('keysTableRows', () => {
	const key = {
		id: 'sub-1',
		key_prefix: 'x402_live_ab12cd',
		status: 'active',
		rate_limit_per_minute: 600,
		expires_at: '2026-09-06T00:00:00.000Z',
		usage: { granted: 18432, denied: 7, last_seen: null },
	};

	it('says Never rather than a bare dash for a key that has not been used', () => {
		expect(keysTableRows([key])).toContain('<td>Never</td>');
	});

	it('arms rotate and revoke against the key id', () => {
		const html = keysTableRows([key]);
		expect(html).toContain('data-rotate="sub-1"');
		expect(html).toContain('data-revoke="sub-1"');
	});

	it('escapes a hostile status instead of injecting it', () => {
		const html = keysTableRows([{ ...key, status: '<img src=x onerror=alert(1)>' }]);
		expect(html).not.toContain('<img');
		expect(html).toContain('&lt;img');
	});
});
