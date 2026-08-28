import { describe, it, expect, vi, beforeEach } from 'vitest';

// The handler's only third-party call goes through fetchUpstream, so mocking
// that one module gives the whole endpoint a real GitHub shape to work with
// while keeping the test offline. Everything else (the changelog it reads from
// public/changelog.json, the linking, the renderers) runs for real.
const COMMITS = [
	{
		sha: 'a'.repeat(40),
		html_url: 'https://github.com/nirholas/three.ws/commit/aaaaaaa',
		parents: [{ sha: 'p' }],
		commit: {
			message: 'feat(forge): paint concept images across five independent providers',
			author: { name: 'nirholas', date: '2026-08-27T09:00:00Z' },
			committer: { date: '2026-08-27T09:00:00Z' },
		},
		author: { login: 'nirholas' },
	},
	{
		sha: 'b'.repeat(40),
		html_url: 'https://github.com/nirholas/three.ws/commit/bbbbbbb',
		parents: [{ sha: 'p' }],
		commit: {
			message: 'chore(deps): bump ws',
			author: { name: 'nirholas', date: '2026-08-27T09:30:00Z' },
			committer: { date: '2026-08-27T09:30:00Z' },
		},
		author: { login: 'nirholas' },
	},
	{
		sha: 'c'.repeat(40),
		html_url: 'https://github.com/nirholas/three.ws/commit/ccccccc',
		parents: [{ sha: 'p' }],
		commit: {
			message: 'Merge pull request #9 from nirholas/branch',
			author: { name: 'nirholas', date: '2026-08-27T10:00:00Z' },
			committer: { date: '2026-08-27T10:00:00Z' },
		},
		author: { login: 'nirholas' },
	},
];

const fetchUpstream = vi.fn(async () => ({
	ok: true,
	status: 200,
	headers: { get: () => null },
	json: async () => COMMITS,
}));

vi.mock('../api/_lib/upstream-fetch.js', () => ({ fetchUpstream }));

const { default: handler } = await import('../api/ship/feed.js');

function mkRes() {
	return {
		statusCode: 200,
		headers: {},
		body: undefined,
		writableEnded: false,
		headersSent: false,
		getHeader(k) {
			return this.headers[k.toLowerCase()];
		},
		setHeader(k, v) {
			this.headers[k.toLowerCase()] = v;
		},
		end(b) {
			this.body = b;
			this.writableEnded = true;
		},
	};
}

async function call(url = '/api/ship/feed') {
	const req = { method: 'GET', url, headers: {}, socket: { remoteAddress: '127.0.0.1' } };
	const res = mkRes();
	await handler(req, res);
	return res;
}

beforeEach(() => {
	fetchUpstream.mockClear();
});

describe('GET /api/ship/feed', () => {
	it('returns a unified feed with releases, ships, and stats', async () => {
		// A distinct limit per case keeps each assertion off the previous one's
		// cache entry, which is keyed by limit and audience.
		const res = await call('/api/ship/feed?limit=11');
		expect(res.statusCode).toBe(200);
		const feed = JSON.parse(res.body);
		expect(feed.version).toBeGreaterThan(0);
		expect(feed.repo).toBe('nirholas/three.ws');
		expect(Array.isArray(feed.releases)).toBe(true);
		expect(Array.isArray(feed.ships)).toBe(true);
		expect(feed.stats.commits).toBe(COMMITS.length);
		expect(res.getHeader('cache-control')).toContain('max-age=');
	});

	it('classifies the commits it read', async () => {
		const feed = JSON.parse((await call('/api/ship/feed?limit=12')).body);
		const all = [...feed.releases.flatMap((r) => r.commits), ...feed.ships.flatMap((s) => s.commits)];
		const feature = all.find((c) => c.sha.startsWith('aaa'));
		expect(feature.headline).toBe('Feature · forge');
		expect(feature.audience).toBe('holder');
	});

	it('drops machinery when the caller asks for product news only', async () => {
		const feed = JSON.parse((await call('/api/ship/feed?limit=13&audience=holder')).body);
		const shas = [
			...feed.releases.flatMap((r) => r.commits),
			...feed.ships.flatMap((s) => s.commits),
		].map((c) => c.sha);
		expect(shas.some((s) => s.startsWith('aaa'))).toBe(true);
		expect(shas.some((s) => s.startsWith('bbb'))).toBe(false);
		expect(feed.stats.hidden).toBeGreaterThan(0);
	});

	it('renders markdown and RSS from the same feed', async () => {
		const md = await call('/api/ship/feed?limit=14&format=markdown');
		expect(md.getHeader('content-type')).toContain('text/markdown');
		expect(md.body).toContain('# Ship log');

		const rss = await call('/api/ship/feed?limit=15&format=rss');
		expect(rss.getHeader('content-type')).toContain('rss+xml');
		expect(rss.body).toContain('<rss version="2.0">');
	});

	it('explains one commit, scoring and link reasons included', async () => {
		const res = await call(`/api/ship/feed?limit=16&explain=${'a'.repeat(7)}`);
		expect(res.statusCode).toBe(200);
		const body = JSON.parse(res.body);
		expect(body.commit.shortSha).toBe('aaaaaaa');
		expect(body.classification.audience).toBe('holder');
		expect(body.classification.reasons.length).toBeGreaterThan(0);
	});

	it('rejects a malformed sha and reports an unknown one honestly', async () => {
		expect((await call('/api/ship/feed?limit=17&explain=nope')).statusCode).toBe(400);
		expect((await call(`/api/ship/feed?limit=18&explain=${'f'.repeat(40)}`)).statusCode).toBe(404);
	});

	it('serves a second identical request from cache without re-reading GitHub', async () => {
		await call('/api/ship/feed?limit=19');
		const callsAfterFirst = fetchUpstream.mock.calls.length;
		await call('/api/ship/feed?limit=19');
		expect(fetchUpstream.mock.calls.length).toBe(callsAfterFirst);
	});

	it('refuses a non-GET method', async () => {
		const req = { method: 'POST', url: '/api/ship/feed', headers: {}, socket: { remoteAddress: '127.0.0.1' } };
		const res = mkRes();
		await handler(req, res);
		expect(res.statusCode).toBe(405);
	});
});
