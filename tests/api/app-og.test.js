// Integration tests for GET /api/app-og, the server-rendered share card a
// social crawler gets when it hits /app?agent=<uuid>.
//
// The regression this file exists for: the handler declared a local
// `const thumbnailUrl` initialized by calling the imported `thumbnailUrl()`
// helper. The local binding shadows the import across the whole function body,
// so the initializer's own call landed in the temporal dead zone and threw
// ReferenceError for every agent that HAS a thumbnail, which is the only case
// the route exists to serve. Crawlers got a 500 with no OG tags at all.
//
// No network and no mocked HTTP layer: the real handler runs against mocked
// req/res objects (the pattern in tests/api/avatar-og.test.js), so the assertions
// exercise the real HTML builder.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const sqlMock = vi.fn(async () => []);

vi.mock('../../api/_lib/db.js', () => ({
	sql: (...a) => sqlMock(...a),
	isDbUnavailableError: () => false,
	isDbCapacityError: () => false,
}));
vi.mock('../../api/_lib/r2.js', () => ({
	thumbnailUrl: (k) => `https://cdn.test/${k}`,
}));
vi.mock('../../api/_lib/env.js', () => ({ env: { APP_ORIGIN: 'https://three.ws' } }));
vi.mock('../../api/_lib/zauth.js', () => ({ instrument: () => {}, drain: async () => {} }));
vi.mock('../../api/_lib/sentry.js', () => ({ captureException: () => {} }));

const { default: handler } = await import('../../api/app-og.js');

const AGENT_UUID = 'fce196ec-aaa1-417e-bb9c-e8a5b4d9f945';

function mkReq(qs = `agent=${AGENT_UUID}`, method = 'GET') {
	return { method, url: `/api/app-og?${qs}`, headers: { host: 'three.ws' } };
}

function mkRes() {
	return {
		statusCode: 200,
		_h: {},
		_body: undefined,
		writableEnded: false,
		setHeader(k, v) { this._h[k.toLowerCase()] = v; },
		getHeader(k) { return this._h[k.toLowerCase()]; },
		end(b) { this._body = b; this.writableEnded = true; },
	};
}

const AGENT_WITH_THUMBNAIL = {
	id: AGENT_UUID,
	name: 'Aurora',
	description: 'A research agent.',
	avatar_id: '5b888ec3-bca3-4d9e-bdab-c802bb35f6a0',
	skills: ['greet', 'think'],
	avatar_thumbnail_key: 'u/272dc4a6/draft-bb4pq9/mp4b08rd_og.png',
	avatar_storage_key: 'u/272dc4a6/draft-bb4pq9/mp4b08rd.glb',
	avatar_visibility: 'public',
};

beforeEach(() => {
	sqlMock.mockReset();
	sqlMock.mockResolvedValue([]);
});

describe('GET /api/app-og', () => {
	it('renders the card with the avatar thumbnail as og:image', async () => {
		sqlMock.mockResolvedValueOnce([AGENT_WITH_THUMBNAIL]);
		const res = mkRes();
		await handler(mkReq(), res);

		expect(res.statusCode).toBe(200);
		expect(res.getHeader('content-type')).toMatch(/text\/html/);
		expect(res._body).toContain(
			'<meta property="og:image" content="https://cdn.test/u/272dc4a6/draft-bb4pq9/mp4b08rd_og.png">',
		);
		expect(res._body).toMatch(/<meta property="og:title" content="Aurora .{1,3}three\.ws">/);
	});

	it('falls back to the rendered agent OG image when the avatar has no thumbnail', async () => {
		sqlMock.mockResolvedValueOnce([{ ...AGENT_WITH_THUMBNAIL, avatar_thumbnail_key: null }]);
		const res = mkRes();
		await handler(mkReq(), res);

		expect(res.statusCode).toBe(200);
		expect(res._body).toContain(
			`<meta property="og:image" content="https://three.ws/api/agent/${AGENT_UUID}/og">`,
		);
	});

	it('appends the agent skills to the description', async () => {
		sqlMock.mockResolvedValueOnce([AGENT_WITH_THUMBNAIL]);
		const res = mkRes();
		await handler(mkReq(), res);

		expect(res._body).toContain('Skills: greet, think.');
	});

	it('escapes HTML in the agent name so a crafted name cannot inject markup', async () => {
		sqlMock.mockResolvedValueOnce([
			{ ...AGENT_WITH_THUMBNAIL, name: '<script>alert(1)</script>', description: null },
		]);
		const res = mkRes();
		await handler(mkReq(), res);

		expect(res._body).not.toContain('<script>alert(1)</script>');
		expect(res._body).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
	});

	it('redirects to /app for a non-UUID agent param without touching the DB', async () => {
		const res = mkRes();
		await handler(mkReq('agent=not-a-uuid'), res);

		expect(res.statusCode).toBe(302);
		expect(res.getHeader('location')).toBe('/app');
		expect(sqlMock).not.toHaveBeenCalled();
	});

	it('redirects to /app when the agent does not exist', async () => {
		sqlMock.mockResolvedValueOnce([]);
		const res = mkRes();
		await handler(mkReq(), res);

		expect(res.statusCode).toBe(302);
		expect(res.getHeader('location')).toBe('/app');
	});
});
