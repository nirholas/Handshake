// Coverage for the per-entity sub-sitemaps at /sitemap/<type>.xml
// (api/sitemap/[type].js), the files Google and Bing fetch from the
// sitemap index that api/sitemap.js emits.
//
// Two regressions are pinned here because both were live on 2026-08-16:
//
//   - `constructor`, `toString`, `valueOf` and `hasOwnProperty` resolved
//     through the prototype chain of the builder lookup object, so they passed
//     the "is this a known type?" guard, got called as if they were builders,
//     and answered any scanner walking /api/sitemap/<word> with a 500 plus a
//     fabricated sitemap_failed report in error tracking. The lookup is a Map
//     now, and every one of them has to stay a 404.
//
//   - profiles.xml listed every users row with a username, which on that date
//     was 29,600 seed-cron machine accounts against 42 humans. The
//     service_account predicate has to stay in the query, and no machine
//     account may reach the XML.
//
// Plus the handler contract: the six real types, XML well-formedness and
// escaping, the .xml suffix the vercel.json rewrite leaves on, and the 500
// boundary when a builder throws.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { XMLValidator } from 'fast-xml-parser';

const db = vi.hoisted(() => ({ queries: [], rows: new Map(), fail: null }));

vi.mock('../api/_lib/env.js', () => ({
	env: { APP_ORIGIN: 'https://three.ws' },
}));

vi.mock('../api/_lib/db.js', () => ({
	sql: (strings, ...values) => {
		const text = strings.join('?');
		db.queries.push({ text, values });
		if (db.fail) return Promise.reject(db.fail);
		for (const [table, rows] of db.rows) {
			if (text.includes(`from ${table}`)) return Promise.resolve(rows);
		}
		return Promise.resolve([]);
	},
	isDbUnavailableError: () => false,
	isDbCapacityError: () => false,
}));

vi.mock('../api/_lib/http.js', () => ({
	reportServerError: () => 'ref00000deadbeef',
	redactUrl: (u) => String(u ?? ''),
}));

const news = vi.hoisted(() => ({ months: [], byMonth: new Map() }));

vi.mock('../api/_lib/news-archive-store.js', () => ({
	getMonths: async () => news.months,
	loadMonth: async (m) => news.byMonth.get(m) || [],
}));

const { default: handler } = await import('../api/sitemap/[type].js');

function makeRes() {
	return {
		statusCode: 0,
		headers: {},
		body: '',
		setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
		end(chunk) { this.body = chunk == null ? this.body : String(chunk); return this; },
	};
}

async function call(type) {
	const res = makeRes();
	await handler({ query: { type }, url: `/api/sitemap/${type}` }, res);
	return res;
}

function locs(xml) {
	return [...xml.matchAll(/<loc>([^<]*)<\/loc>/g)].map((m) => m[1]);
}

function expectWellFormed(xml) {
	const verdict = XMLValidator.validate(xml);
	expect(verdict, typeof verdict === 'object' ? JSON.stringify(verdict.err) : '').toBe(true);
}

const AT = new Date('2026-03-04T05:06:07Z');

beforeEach(() => {
	db.queries = [];
	db.fail = null;
	db.rows = new Map([
		['agent_identities', [{ id: 'agent-1', updated_at: AT, created_at: AT }]],
		['avatars', [{ id: 'avatar-1', updated_at: null, created_at: AT }]],
		['widgets', [{ id: 'widget-1', updated_at: AT, created_at: AT }]],
		['users u', [{ username: 'realhuman', updated_at: AT, created_at: AT }]],
	]);
	news.months = ['2026-01', '2026-02', '2026-03'];
	// storyPath() only builds a URL for a 16-hex id plus a datable pub_date.
	news.byMonth = new Map([
		['2026-03', [{ id: 'a'.repeat(16), title: 'A story', pub_date: '2026-03-02T00:00:00Z' }]],
		['2026-02', [{ id: 'b'.repeat(16), title: 'B story', pub_date: '2026-02-02T00:00:00Z' }]],
		['2026-01', [{ id: 'c'.repeat(16), title: 'C story', pub_date: '2026-01-02T00:00:00Z' }]],
	]);
});

describe('GET /sitemap/<type>.xml: the six real types', () => {
	it.each(['core', 'agents', 'avatars', 'widgets', 'profiles', 'news'])(
		'serves %s as cacheable, well-formed XML with at least one absolute https URL',
		async (type) => {
			const res = await call(type);
			expect(res.statusCode).toBe(200);
			expect(res.headers['content-type']).toBe('application/xml; charset=utf-8');
			expect(res.headers['cache-control']).toContain('s-maxage=600');
			expectWellFormed(res.body);
			expect(res.body.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n')).toBe(true);
			expect(res.body).toContain('xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"');
			const found = locs(res.body);
			expect(found.length).toBeGreaterThan(0);
			for (const loc of found) expect(loc.startsWith('https://three.ws/')).toBe(true);
			// A crawler that sees the same URL twice wastes budget on it twice.
			expect(new Set(found).size).toBe(found.length);
		},
	);

	it('strips the .xml the vercel.json rewrite leaves on the type', async () => {
		const bare = await call('widgets');
		const suffixed = await call('widgets.xml');
		expect(suffixed.statusCode).toBe(200);
		expect(suffixed.body).toBe(bare.body);
	});

	it('advertises the xhtml namespace only when entries carry hreflang alternates', async () => {
		// core localizes (public/locales/localized-pages.json); widgets never do.
		expect((await call('core')).body).toContain('xmlns:xhtml="http://www.w3.org/1999/xhtml"');
		expect((await call('widgets')).body).not.toContain('xmlns:xhtml');
	});

	it('escapes XML metacharacters that reach a loc through user data', async () => {
		db.rows.set('users u', [{ username: `a&b<c>d"e'f`, updated_at: AT, created_at: AT }]);
		const res = await call('profiles');
		expectWellFormed(res.body);
		expect(res.body).toContain('<loc>https://three.ws/u/a&amp;b&lt;c&gt;d&quot;e&apos;f</loc>');
	});

	it('drains the news archive newest month first', async () => {
		const found = locs((await call('news')).body);
		expect(found).toEqual([
			`https://three.ws/markets/news/2026-03/${'a'.repeat(16)}-a-story`,
			`https://three.ws/markets/news/2026-02/${'b'.repeat(16)}-b-story`,
			`https://three.ws/markets/news/2026-01/${'c'.repeat(16)}-c-story`,
		]);
	});
});

describe('profiles.xml excludes seed-cron machine accounts', () => {
	it('filters on service_account in SQL, not after the fact', async () => {
		await call('profiles');
		const q = db.queries.find((x) => x.text.includes('from users u'));
		expect(q, 'profiles must query users').toBeTruthy();
		expect(q.text).toContain('service_account = false');
		expect(q.text).toContain('deleted_at is null');
		expect(q.text).toContain('username is not null');
	});

	it('emits nothing when every profile row is a machine account', async () => {
		// The predicate lives in SQL, so a filtered query returns no rows at all.
		db.rows.set('users u', []);
		const res = await call('profiles');
		expect(res.statusCode).toBe(200);
		expectWellFormed(res.body);
		expect(locs(res.body)).toEqual([]);
		expect(res.body).toContain('</urlset>');
	});
});

describe('GET /sitemap/<type>.xml: failure paths', () => {
	it.each(['bogus', '', 'CORE', '../../etc/passwd'])('404s on the unknown type %j', async (type) => {
		const res = await call(type);
		expect(res.statusCode).toBe(404);
		expect(res.headers['content-type']).toBe('text/plain; charset=utf-8');
		expect(res.headers['cache-control']).toBe('no-store');
		expect(res.body).toContain('unknown sitemap');
		expect(res.body).not.toContain('<');
	});

	it.each(['constructor', 'toString', 'valueOf', 'hasOwnProperty', 'isPrototypeOf', '__proto__'])(
		'404s on the prototype-chain key %j instead of 500ing',
		async (type) => {
			const res = await call(type);
			expect(res.statusCode).toBe(404);
			expect(res.body).toContain('unknown sitemap');
		},
	);

	it('returns a plain-text 500 with a support ref, never a stack trace, when the DB fails', async () => {
		db.fail = Object.assign(new Error('connection terminated at 10.0.0.1:5432'), { stack: 'Error: boom\n    at agentsSitemap' });
		const res = await call('agents');
		expect(res.statusCode).toBe(500);
		expect(res.headers['content-type']).toBe('text/plain; charset=utf-8');
		expect(res.headers['cache-control']).toBe('no-store');
		expect(res.body).toContain('ref00000deadbeef');
		expect(res.body).not.toContain('at agentsSitemap');
		expect(res.body).not.toContain('10.0.0.1');
		expect(res.body).not.toContain('<');
	});

	it('falls back to the home page rather than 500ing when the news store is unreachable', async () => {
		news.months = [];
		const res = await call('news');
		expect(res.statusCode).toBe(200);
		expectWellFormed(res.body);
		expect(locs(res.body)).toEqual([]);
	});
});
