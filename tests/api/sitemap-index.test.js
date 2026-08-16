// The sitemap index at /sitemap.xml (api/sitemap.js), the first file Google and
// Bing fetch. It points at the six sub-sitemaps that api/sitemap/[type].js builds.
//
// Two things are pinned here:
//
//   - It is a read surface. Before the method guard, a POST or a DELETE to
//     /api/sitemap got a 200 and the full index back, which advertises write
//     methods the route does not have.
//   - Every sub-sitemap entry is emitted unconditionally, even when its lastmod
//     probe returns nothing, so a crawler keeps a stable set of files to poll and
//     content appearing later needs no deploy to become discoverable. A dead
//     database degrades the dates, never the document.
//
// Network-free: the database is mocked.

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { createServer } from 'node:http';
import { XMLValidator } from 'fast-xml-parser';

const db = vi.hoisted(() => ({ queries: [], ts: '2026-08-01T10:00:00.000Z', fail: false }));

vi.mock('../../api/_lib/env.js', () => ({ env: { APP_ORIGIN: 'https://three.ws' } }));

vi.mock('../../api/_lib/db.js', () => ({
	sql: Object.assign(() => Promise.resolve([]), {
		unsafe: (text) => {
			db.queries.push(text);
			if (db.fail) return Promise.reject(new Error('connection terminated'));
			return Promise.resolve([{ ts: db.ts }]);
		},
	}),
	isDbUnavailableError: () => false,
}));

let server;
let base;

beforeAll(async () => {
	const { default: handler } = await import('../../api/sitemap.js');
	server = createServer((req, res) => handler(req, res));
	await new Promise((r) => server.listen(0, '127.0.0.1', r));
	base = `http://127.0.0.1:${server.address().port}`;
});

afterAll(() => server?.close());

beforeEach(() => {
	db.queries.length = 0;
	db.fail = false;
});

describe('/api/sitemap index', () => {
	it('serves well-formed XML listing every sub-sitemap', async () => {
		const r = await fetch(`${base}/api/sitemap`);
		expect(r.status).toBe(200);
		expect(r.headers.get('content-type')).toContain('application/xml');
		expect(r.headers.get('cache-control')).toContain('s-maxage=600');

		const body = await r.text();
		expect(XMLValidator.validate(body)).toBe(true);
		for (const type of ['core', 'agents', 'avatars', 'widgets', 'profiles', 'news']) {
			expect(body).toContain(`<loc>https://three.ws/sitemap/${type}.xml</loc>`);
		}
		expect(body).toContain('<lastmod>2026-08-01</lastmod>');
	});

	it('refuses a write method instead of answering it with the index', async () => {
		for (const m of ['POST', 'DELETE', 'PUT', 'PATCH']) {
			const r = await fetch(`${base}/api/sitemap`, { method: m });
			expect(r.status, m).toBe(405);
			expect(r.headers.get('allow')).toContain('GET');
			expect((await r.json()).error).toBe('method_not_allowed');
		}
		// A rejected method costs no database work.
		expect(db.queries).toHaveLength(0);
	});

	it('answers a HEAD probe the way it answers GET', async () => {
		const r = await fetch(`${base}/api/sitemap`, { method: 'HEAD' });
		expect(r.status).toBe(200);
		expect(r.headers.get('content-type')).toContain('application/xml');
	});

	it('still emits every entry when the lastmod probes fail', async () => {
		db.fail = true;
		const r = await fetch(`${base}/api/sitemap`);
		expect(r.status).toBe(200);

		const body = await r.text();
		expect(XMLValidator.validate(body)).toBe(true);
		expect(body.match(/<sitemap>/g)).toHaveLength(6);
	});
});
