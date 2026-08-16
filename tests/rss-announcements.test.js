// Coverage for the public RSS feed at /rss/announcements.xml (and its /rss.xml
// alias): api/rss/announcements.js plus the builder in api/_lib/rss-feed.js.
//
// HackerNoon auto-imports this feed, so a single malformed byte anywhere in it
// takes the whole syndication pipeline down rather than dropping one item. The
// regressions pinned here are exactly the inputs that used to do that:
//   - a curated body_html containing a CDATA terminator, which closed the
//     section early and corrupted every item after it;
//   - a scraped post whose prose happened to spell the internal URL
//     placeholder, which threw and returned a 500 for the entire feed;
//   - a control character XML 1.0 forbids, which no escaping can rescue.
// Plus the handler contract: source selection, an unknown source, and the
// 500 boundary.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { XMLValidator } from 'fast-xml-parser';

const loaders = vi.hoisted(() => ({
	curated: null,
	archive: null,
}));

vi.mock('../api/_lib/rss-feed.js', async (importOriginal) => {
	const actual = await importOriginal();
	return {
		...actual,
		loadCuratedItems: (...args) => (loaders.curated ? loaders.curated(...args) : actual.loadCuratedItems(...args)),
		loadAnnouncementItems: (...args) => (loaders.archive ? loaders.archive(...args) : actual.loadAnnouncementItems(...args)),
	};
});

const { buildRssXml, deriveSlug } = await import('../api/_lib/rss-feed.js');
const { default: handler } = await import('../api/rss/announcements.js');

function makeRes() {
	return {
		statusCode: 0,
		headers: {},
		body: '',
		ended: false,
		setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
		getHeader(k) { return this.headers[k.toLowerCase()]; },
		end(chunk) { this.body = chunk == null ? this.body : String(chunk); this.ended = true; return this; },
		write(chunk) { this.body += String(chunk); return this; },
	};
}

async function call(url, { method = 'GET', headers = {} } = {}) {
	const res = makeRes();
	await handler({ url, method, headers }, res);
	return res;
}

const CDATA_CLOSE = ']' + ']' + '>';
const BELL = String.fromCharCode(7);
const AT = new Date('2026-01-01T12:00:00Z');

const curatedItem = (over = {}) => ({
	id: 'launch-1',
	slug: 'launch-1',
	permalink: 'https://three.ws/news/launch-1',
	externalLink: '',
	externalSource: 'X',
	title: 'three.ws ships the forge',
	author: 'three.ws',
	summary: 'A summary of the launch.',
	bodyHtml: '<p>We shipped it.</p>',
	image: '',
	imageAlt: '',
	imageWidth: 0,
	imageHeight: 0,
	tags: ['launch'],
	timestamp: AT,
	published: true,
	...over,
});

const archiveItem = (over = {}) => ({
	id: '1900000000000000001',
	account: 'trythreews',
	url: 'https://x.com/trythreews/status/1900000000000000001',
	text: 'A post long enough to clear the archive minimum length filter for the feed.',
	timestamp: AT,
	hasImage: false,
	hasVideo: false,
	...over,
});

function expectWellFormed(xml) {
	const verdict = XMLValidator.validate(xml);
	expect(verdict, typeof verdict === 'object' ? JSON.stringify(verdict.err) : '').toBe(true);
}

beforeEach(() => {
	loaders.curated = null;
	loaders.archive = null;
});

describe('buildRssXml: malformed-output regressions', () => {
	it('keeps the feed parseable when a curated body carries a CDATA terminator', () => {
		const xml = buildRssXml({
			items: [curatedItem({ bodyHtml: `<p>use <code>if (a[b[c${CDATA_CLOSE}0)</code> here</p>` })],
			selfUrl: 'https://three.ws/rss/announcements.xml',
			source: 'curated',
		});
		expectWellFormed(xml);
		// The terminator survives as content, split across two CDATA sections.
		expect(xml).toContain(']]]]><![CDATA[>');
	});

	it('keeps the feed parseable when a scraped post spells the URL placeholder', () => {
		// Both spellings: ` URL5 ` is what the placeholder used to look like (prose
		// containing it threw and 500'd the whole feed), `<5>` is what it looks like
		// now. Neither may ever be mistaken for a real link, whichever form is in use.
		const xml = buildRssXml({
			items: [
				archiveItem({ id: '1', text: 'we shipped it, see URL5 for details and read the release notes' }),
				archiveItem({ id: '2', text: 'the build emits <5> as a marker, which the reader should show verbatim' }),
			],
			selfUrl: 'https://three.ws/rss/announcements.xml?source=trythreews',
			source: 'trythreews',
		});
		expectWellFormed(xml);
		expect(xml).toContain('URL5');
		expect(xml).toContain('&lt;5&gt;');
		expect(xml).not.toContain('<a href="undefined"');
	});

	it('still linkifies real URLs and handles in scraped prose', () => {
		const xml = buildRssXml({
			items: [archiveItem({ text: 'built with @nichxbt, see https://three.ws/create for the full walkthrough' })],
			selfUrl: 'https://three.ws/rss/announcements.xml?source=trythreews',
			source: 'trythreews',
		});
		expectWellFormed(xml);
		expect(xml).toContain('<a href="https://three.ws/create" rel="noopener">https://three.ws/create</a>');
		expect(xml).toContain('<a href="https://x.com/nichxbt" rel="noopener">@nichxbt</a>');
	});

	it('drops control characters XML 1.0 forbids instead of emitting them', () => {
		const xml = buildRssXml({
			items: [curatedItem({ title: `Ti${BELL}tle`, bodyHtml: `<p>bo${BELL}dy</p>` })],
			selfUrl: 'https://three.ws/rss/announcements.xml',
			source: 'curated',
		});
		expectWellFormed(xml);
		expect(xml).not.toContain(BELL);
		expect(xml).toContain('<title>Title</title>');
		expect(xml).toContain('<p>body</p>');
	});

	it('escapes markup in titles and preserves astral characters', () => {
		const xml = buildRssXml({
			items: [curatedItem({ title: 'a <script> & an emoji 🚀' })],
			selfUrl: 'https://three.ws/rss/announcements.xml',
			source: 'curated',
		});
		expectWellFormed(xml);
		expect(xml).toContain('a &lt;script&gt; &amp; an emoji 🚀');
	});

	it('builds a valid feed with no items at all', () => {
		const xml = buildRssXml({ items: [], selfUrl: 'https://three.ws/rss/announcements.xml', source: 'curated' });
		expectWellFormed(xml);
		expect(xml).not.toContain('<item>');
	});

	it('derives a URL-safe slug from a curated id', () => {
		expect(deriveSlug({ id: 't-1900000000000000001' })).toBe('1900000000000000001');
		expect(deriveSlug({ slug: 'Forge Ships!' })).toBe('forge-ships');
		expect(deriveSlug({})).toBe('item');
	});
});

describe('GET /rss/announcements.xml', () => {
	it('serves the curated feed as RSS with a cacheable, self-referential channel', async () => {
		loaders.curated = async () => [curatedItem()];
		const res = await call('/api/rss/announcements');

		expect(res.statusCode).toBe(200);
		expect(res.getHeader('content-type')).toBe('application/rss+xml; charset=utf-8');
		expect(res.getHeader('cache-control')).toContain('max-age=600');
		expectWellFormed(res.body);
		expect(res.body).toContain('<atom:link href="https://three.ws/rss/announcements.xml" rel="self"');
		expect(res.body).toContain('<title>three.ws ships the forge</title>');
		expect(res.body).toContain('<link>https://three.ws/news/launch-1</link>');
	});

	it('serves an account mirror and points the self link at that source', async () => {
		loaders.archive = async ({ source }) => {
			expect(source).toBe('trythreews');
			return [archiveItem()];
		};
		const res = await call('/api/rss/announcements?source=trythreews');

		expect(res.statusCode).toBe(200);
		expectWellFormed(res.body);
		expect(res.body).toContain('rss/announcements.xml?source=trythreews" rel="self"');
		expect(res.body).toContain('three.ws: three.ws updates');
	});

	it('maps ?source=archive onto every archived account', async () => {
		const seen = [];
		loaders.archive = async ({ source }) => { seen.push(source); return [archiveItem()]; };
		const res = await call('/api/rss/announcements?source=archive');

		expect(res.statusCode).toBe(200);
		expect(seen).toEqual(['all']);
	});

	it('accepts a source in any case', async () => {
		loaders.archive = async () => [archiveItem()];
		const res = await call('/api/rss/announcements?source=NichXBT');

		expect(res.statusCode).toBe(200);
		expect(res.body).toContain('rss/announcements.xml?source=nichxbt" rel="self"');
	});

	it('rejects an unknown source instead of silently serving the curated feed', async () => {
		loaders.curated = async () => { throw new Error('curated loader must not run'); };
		const res = await call('/api/rss/announcements?source=trythreewz');

		expect(res.statusCode).toBe(400);
		const body = JSON.parse(res.body);
		expect(body.error).toBe('unknown_source');
		expect(body.error_description).toContain('trythreewz');
		expect(res.getHeader('cache-control')).toBe('no-store');
	});

	it('rejects a non-GET method', async () => {
		const res = await call('/api/rss/announcements', { method: 'POST' });
		expect(res.statusCode).toBe(405);
		expect(JSON.parse(res.body).error).toBe('method_not_allowed');
	});

	it('answers a CORS preflight without building a feed', async () => {
		loaders.curated = async () => { throw new Error('preflight must not build a feed'); };
		const res = await call('/api/rss/announcements', { method: 'OPTIONS', headers: { origin: 'https://hackernoon.com' } });

		expect(res.statusCode).toBe(204);
		expect(res.getHeader('access-control-allow-origin')).toBe('*');
	});

	it('returns an uncached 500 with a support ref when the source data is unreadable', async () => {
		loaders.curated = async () => { throw new Error('ENOENT: items.json'); };
		const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		const res = await call('/api/rss/announcements');
		errSpy.mockRestore();

		expect(res.statusCode).toBe(500);
		expect(res.getHeader('content-type')).toBe('text/plain; charset=utf-8');
		expect(res.getHeader('cache-control')).toBe('no-store');
		expect(res.body).toMatch(/^feed unavailable\. Quote ref \S+ to support\.$/);
		expect(res.body).not.toContain('items.json');
	});
});
