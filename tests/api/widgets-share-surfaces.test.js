/**
 * Widget share surfaces: oEmbed, the /w/:id metadata page, the baked-in demo
 * fixtures, and the edge geo header the view logger records.
 *
 * These are the endpoints social consumers hit (Slack, Discord, X, WordPress,
 * Ghost, Notion), so their contract is the preview every shared widget link
 * renders. Postgres and the embed-policy reader are mocked at the module
 * boundary; nothing here touches the network.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const sqlQueue = [];
const sqlMock = vi.fn(() => {
	if (sqlQueue.length === 0) return Promise.resolve([]);
	const next = sqlQueue.shift();
	if (next instanceof Error) return Promise.reject(next);
	return Promise.resolve(next);
});

vi.mock('../../api/_lib/db.js', () => ({
	sql: sqlMock,
	isDbUnavailableError: () => false,
	isDbCapacityError: () => false,
}));

const policyState = { policy: null };
vi.mock('../../api/_lib/embed-policy.js', () => ({
	readEmbedPolicy: vi.fn(async () => policyState.policy),
	originAllowed: (referer, policy) => {
		if (!policy?.origins?.length) return true;
		if (!referer) return false;
		return policy.origins.includes(new URL(referer).hostname);
	},
}));

const oembedHandler = (await import('../../api/widgets/oembed.js')).default;
const pageHandler = (await import('../../api/widgets/page.js')).default;
const viewHandler = (await import('../../api/widgets/view.js')).default;
const { DEMO_WIDGETS, isDemoWidgetId, getDemoWidget } = await import(
	'../../api/widgets/_demo-fixtures.js'
);
const { clientCountry, normalizeCountry } = await import('../../api/_lib/client-geo.js');
const { env } = await import('../../api/_lib/env.js');

function mockRes() {
	return {
		statusCode: 200,
		headers: {},
		_body: '',
		writableEnded: false,
		setHeader(name, value) {
			this.headers[name.toLowerCase()] = value;
		},
		getHeader(name) {
			return this.headers[name.toLowerCase()];
		},
		end(body) {
			if (body !== undefined) this._body = body;
			this.writableEnded = true;
		},
	};
}

function mockReq({ method = 'GET', url = '/', headers = {} } = {}) {
	return { method, url, headers: { ...headers }, socket: { remoteAddress: '127.0.0.1' } };
}

const ORIGIN = env.APP_ORIGIN;

function oembedReq(target, extra = '') {
	return mockReq({
		url: `/api/widgets/oembed?url=${encodeURIComponent(target)}${extra}`,
	});
}

beforeEach(() => {
	sqlQueue.length = 0;
	sqlMock.mockClear();
	policyState.policy = null;
});

// ── GET /api/widgets/oembed ─────────────────────────────────────────────────

describe('GET /api/widgets/oembed', () => {
	it('400s when the url parameter is missing', async () => {
		const res = mockRes();
		await oembedHandler(mockReq({ url: '/api/widgets/oembed' }), res);
		expect(res.statusCode).toBe(400);
		expect(JSON.parse(res._body).error).toBe('invalid_request');
	});

	it('returns a rich oEmbed payload for a demo widget without touching the DB', async () => {
		const res = mockRes();
		await oembedHandler(oembedReq(`${ORIGIN}/w/wdgt_demo_turntab`), res);
		expect(res.statusCode).toBe(200);
		expect(res.headers['content-type']).toMatch(/application\/json\+oembed/);
		const body = JSON.parse(res._body);
		expect(body.type).toBe('rich');
		expect(body.version).toBe('1.0');
		expect(body.title).toBe('Turntable Showcase');
		expect(body.html).toContain('<iframe');
		expect(body.html).toContain('wdgt_demo_turntab');
		expect(body.thumbnail_url).toBe(`${ORIGIN}/api/widgets/wdgt_demo_turntab/og`);
		expect(sqlMock).not.toHaveBeenCalled();
	});

	it('sandboxes the embed iframe so a consumer cannot be navigated by it', async () => {
		const res = mockRes();
		await oembedHandler(oembedReq(`${ORIGIN}/w/wdgt_demo_turntab`), res);
		const { html } = JSON.parse(res._body);
		expect(html).toMatch(/sandbox="[^"]*allow-scripts/);
		expect(html).not.toContain('allow-top-navigation');
	});

	it('404s a url whose origin is not ours, so we cannot be used as an open resolver', async () => {
		const res = mockRes();
		await oembedHandler(oembedReq('https://evil.example.com/w/wdgt_demo_turntab'), res);
		expect(res.statusCode).toBe(404);
		expect(sqlMock).not.toHaveBeenCalled();
	});

	it('404s a url that does not parse', async () => {
		const res = mockRes();
		await oembedHandler(oembedReq('not-a-url'), res);
		expect(res.statusCode).toBe(404);
	});

	it('501s an unsupported format instead of silently serving json', async () => {
		const res = mockRes();
		await oembedHandler(oembedReq(`${ORIGIN}/w/wdgt_demo_turntab`, '&format=yaml'), res);
		expect(res.statusCode).toBe(501);
		expect(JSON.parse(res._body).error).toBe('unsupported_format');
	});

	it('serves well-formed xml when format=xml', async () => {
		const res = mockRes();
		await oembedHandler(oembedReq(`${ORIGIN}/w/wdgt_demo_turntab`, '&format=xml'), res);
		expect(res.statusCode).toBe(200);
		expect(res.headers['content-type']).toMatch(/text\/xml/);
		expect(res._body).toMatch(/^<\?xml version="1\.0"/);
		expect(res._body).toContain('<title>Turntable Showcase</title>');
		// The iframe markup must be entity-escaped inside the xml element.
		expect(res._body).toContain('&lt;iframe');
		expect(res._body).not.toMatch(/<html><iframe/);
	});

	it('resolves the /widget# and legacy /app# hash forms to the same widget', async () => {
		for (const target of [
			`${ORIGIN}/widget#widget=wdgt_demo_animgal`,
			`${ORIGIN}/app#widget=wdgt_demo_animgal`,
			`${ORIGIN}/#widget=wdgt_demo_animgal`,
		]) {
			const res = mockRes();
			await oembedHandler(oembedReq(target), res);
			expect(res.statusCode).toBe(200);
			expect(JSON.parse(res._body).title).toBe('Animation Gallery');
		}
	});

	it('clamps maxwidth/maxheight into the supported range', async () => {
		const res = mockRes();
		await oembedHandler(
			oembedReq(`${ORIGIN}/w/wdgt_demo_turntab`, '&maxwidth=99999&maxheight=10'),
			res,
		);
		const body = JSON.parse(res._body);
		expect(body.width).toBe(1600);
		expect(body.height).toBe(240);
	});

	it('404s a private widget: the DB filters on is_public', async () => {
		sqlQueue.push([]);
		const res = mockRes();
		await oembedHandler(oembedReq(`${ORIGIN}/w/wdgt_private1`), res);
		expect(res.statusCode).toBe(404);
		expect(sqlMock).toHaveBeenCalled();
	});

	it('404s rather than 500s when the widgets table is absent', async () => {
		sqlQueue.push(new Error('relation "widgets" does not exist'));
		const res = mockRes();
		await oembedHandler(oembedReq(`${ORIGIN}/w/wdgt_real1234`), res);
		expect(res.statusCode).toBe(404);
	});
});

// ── GET /api/widgets/page (/w/:id) ──────────────────────────────────────────

describe('GET /api/widgets/page', () => {
	it('404s an HTML card when id is missing', async () => {
		const res = mockRes();
		await pageHandler(mockReq({ url: '/api/widgets/page' }), res);
		expect(res.statusCode).toBe(404);
		expect(res.headers['content-type']).toMatch(/text\/html/);
		expect(res._body).toContain('Widget not found');
	});

	it('renders the full crawler card for a demo widget', async () => {
		const res = mockRes();
		await pageHandler(mockReq({ url: '/api/widgets/page?id=wdgt_demo_hotspot' }), res);
		expect(res.statusCode).toBe(200);
		expect(res.headers['content-type']).toMatch(/text\/html/);
		const html = res._body;
		expect(html).toContain('<meta property="og:title" content="Hotspot Tour">');
		expect(html).toContain(`<meta property="og:url" content="${ORIGIN}/w/wdgt_demo_hotspot">`);
		expect(html).toContain(`<meta property="og:image" content="${ORIGIN}/api/widgets/wdgt_demo_hotspot/og">`);
		expect(html).toContain('<meta name="twitter:card" content="summary_large_image">');
		expect(html).toContain('application/json+oembed');
		expect(html).toContain(`<link rel="canonical" href="${ORIGIN}/w/wdgt_demo_hotspot">`);
		expect(sqlMock).not.toHaveBeenCalled();
	});

	it('emits valid ld+json with the widget identity', async () => {
		const res = mockRes();
		await pageHandler(mockReq({ url: '/api/widgets/page?id=wdgt_demo_turntab' }), res);
		const ld = res._body.match(
			/<script type="application\/ld\+json">\n([\s\S]*?)\n\t<\/script>/,
		);
		expect(ld).not.toBeNull();
		const parsed = JSON.parse(ld[1]);
		expect(parsed['@type']).toBe('CreativeWork');
		expect(parsed.identifier).toBe('wdgt_demo_turntab');
		expect(parsed.url).toBe(`${ORIGIN}/w/wdgt_demo_turntab`);
	});

	it('escapes a hostile widget name instead of injecting markup', async () => {
		sqlQueue.push([
			{
				id: 'wdgt_xss12345',
				name: '</title><script>alert(1)</script>',
				type: 'turntable',
				avatar_id: null,
				agent_id: null,
				is_public: true,
			},
		]);
		const res = mockRes();
		await pageHandler(mockReq({ url: '/api/widgets/page?id=wdgt_xss12345' }), res);
		expect(res.statusCode).toBe(200);
		expect(res._body).not.toContain('<script>alert(1)</script>');
		expect(res._body).toContain('&lt;script&gt;');
	});

	it('serves a noindex placeholder for a private widget, never its name', async () => {
		sqlQueue.push([
			{
				id: 'wdgt_private1',
				name: 'Unreleased Client Pitch',
				type: 'turntable',
				avatar_id: null,
				agent_id: null,
				is_public: false,
			},
		]);
		const res = mockRes();
		await pageHandler(mockReq({ url: '/api/widgets/page?id=wdgt_private1' }), res);
		expect(res.statusCode).toBe(200);
		expect(res._body).toContain('noindex, nofollow');
		expect(res._body).toContain('Private widget');
		expect(res._body).not.toContain('Unreleased Client Pitch');
		expect(res.headers['cache-control']).toContain('private');
	});

	it('403s when the agent owner disabled the widget surface', async () => {
		sqlQueue.push([
			{
				id: 'wdgt_agent123',
				name: 'Agent widget',
				type: 'turntable',
				avatar_id: null,
				agent_id: 'agent-1',
				is_public: true,
			},
		]);
		policyState.policy = { surfaces: { widget: false }, origins: [] };
		const res = mockRes();
		await pageHandler(mockReq({ url: '/api/widgets/page?id=wdgt_agent123' }), res);
		expect(res.statusCode).toBe(403);
		expect(res._body).toContain('Access denied');
	});

	it('403s when the referring origin is outside the agent policy allowlist', async () => {
		sqlQueue.push([
			{
				id: 'wdgt_agent123',
				name: 'Agent widget',
				type: 'turntable',
				avatar_id: null,
				agent_id: 'agent-1',
				is_public: true,
			},
		]);
		policyState.policy = { surfaces: { widget: true }, origins: ['partner.example'] };
		const res = mockRes();
		await pageHandler(
			mockReq({
				url: '/api/widgets/page?id=wdgt_agent123',
				headers: { referer: 'https://scraper.example/post' },
			}),
			res,
		);
		expect(res.statusCode).toBe(403);
	});

	it('falls back to the pre-agent_id query when that column is absent', async () => {
		sqlQueue.push(new Error('column "agent_id" does not exist'));
		sqlQueue.push([
			{
				id: 'wdgt_legacy12',
				name: 'Legacy',
				type: 'turntable',
				avatar_id: null,
				is_public: true,
			},
		]);
		const res = mockRes();
		await pageHandler(mockReq({ url: '/api/widgets/page?id=wdgt_legacy12' }), res);
		expect(res.statusCode).toBe(200);
		expect(res._body).toContain('Legacy');
	});

	it('404s rather than 500s when the widgets table is absent', async () => {
		sqlQueue.push(new Error('relation "widgets" does not exist'));
		const res = mockRes();
		await pageHandler(mockReq({ url: '/api/widgets/page?id=wdgt_real1234' }), res);
		expect(res.statusCode).toBe(404);
	});
});

// ── Demo fixtures ───────────────────────────────────────────────────────────

describe('widget demo fixtures', () => {
	const showcase = JSON.parse(
		readFileSync(
			fileURLToPath(new URL('../../public/widgets-gallery/showcase.json', import.meta.url)),
			'utf8',
		),
	);

	// The fixture module is the server-side half of the public gallery. If the
	// two lists drift, a gallery tile links to /w/<id> and gets the not-found
	// card, which is invisible until someone clicks it.
	it('stays in sync with the public gallery showcase', () => {
		const showcaseIds = (Array.isArray(showcase) ? showcase : showcase.widgets || showcase.items)
			.map((w) => w.id)
			.sort();
		expect(Object.keys(DEMO_WIDGETS).sort()).toEqual(showcaseIds);
	});

	it('gives every fixture the shape the share surfaces read', () => {
		for (const [key, w] of Object.entries(DEMO_WIDGETS)) {
			expect(w.id, key).toBe(key);
			expect(typeof w.name, key).toBe('string');
			expect(w.name.length, key).toBeGreaterThan(0);
			expect(typeof w.type, key).toBe('string');
			expect(w.is_public, key).toBe(true);
			expect(w.config, key).toBeTypeOf('object');
			// Every fixture serves its mesh from /public, so a share page never
			// needs an R2 round-trip or a signed URL.
			expect(w.avatar.model_url, key).toMatch(/^\//);
		}
	});

	it('declares only widget types the platform actually supports', async () => {
		const { WIDGET_TYPES } = await import('../../api/_lib/widget-types.js');
		for (const [key, w] of Object.entries(DEMO_WIDGETS)) {
			expect(WIDGET_TYPES, key).toContain(w.type);
		}
	});

	it('recognises demo ids and rejects everything else', () => {
		expect(isDemoWidgetId('wdgt_demo_turntab')).toBe(true);
		expect(isDemoWidgetId('wdgt_realone123')).toBe(false);
		expect(isDemoWidgetId(null)).toBe(false);
		expect(isDemoWidgetId(undefined)).toBe(false);
		expect(getDemoWidget('wdgt_demo_turntab').name).toBe('Turntable Showcase');
		// A demo-shaped id with no fixture must miss, not resolve to a partial.
		expect(getDemoWidget('wdgt_demo_nothere')).toBeNull();
	});
});

// ── Edge geo header ─────────────────────────────────────────────────────────

describe('clientCountry', () => {
	it('reads the Google Cloud load balancer geo header', () => {
		expect(clientCountry({ headers: { 'x-client-geo-location': 'US,Mountain View' } })).toBe('US');
		expect(clientCountry({ headers: { 'x-client-region': 'de' } })).toBe('DE');
	});

	it('still reads the Cloudflare and Vercel headers', () => {
		expect(clientCountry({ headers: { 'cf-ipcountry': 'FR' } })).toBe('FR');
		expect(clientCountry({ headers: { 'x-vercel-ip-country': 'JP' } })).toBe('JP');
	});

	it('prefers the load balancer header over a client-supplied one', () => {
		const headers = { 'x-client-geo-location': 'US,Reno', 'x-vercel-ip-country': 'ZZ' };
		expect(clientCountry({ headers })).toBe('US');
	});

	it('rejects anything that is not a two-letter code', () => {
		expect(normalizeCountry('NOT-A-COUNTRY-CODE')).toBeNull();
		expect(normalizeCountry('U')).toBeNull();
		expect(normalizeCountry('USA')).toBeNull();
		expect(normalizeCountry('<script>')).toBeNull();
		expect(normalizeCountry('')).toBeNull();
		expect(normalizeCountry(null)).toBeNull();
		expect(normalizeCountry(42)).toBeNull();
	});

	it('treats the Cloudflare unknown and Tor placeholders as no country', () => {
		expect(normalizeCountry('XX')).toBeNull();
		expect(normalizeCountry('T1')).toBeNull();
	});

	it('returns null when no geo header is present', () => {
		expect(clientCountry({ headers: {} })).toBeNull();
		expect(clientCountry({})).toBeNull();
	});
});

// ── POST /api/widgets/:id/view: country capture ──────────────────────────────

describe('POST /api/widgets/:id/view records the edge country', () => {
	function viewReq(headers) {
		return mockReq({ method: 'POST', url: '/api/widgets/view?id=wdgt_real1234', headers });
	}

	it('passes the normalised country through to the insert', async () => {
		sqlQueue.push([]);
		sqlQueue.push([]);
		const res = mockRes();
		await viewHandler(
			viewReq({ 'x-client-geo-location': 'NZ,Auckland', referer: 'https://example.com/a/b?q=1' }),
			res,
		);
		expect(res.statusCode).toBe(204);
		const values = sqlMock.mock.calls[0].slice(1);
		expect(values).toContain('NZ');
		// Referer is reduced to a bare hostname: no path, no query.
		expect(values).toContain('example.com');
		expect(values.some((v) => String(v).includes('?q=1'))).toBe(false);
	});

	it('drops a forged country header rather than storing arbitrary text', async () => {
		sqlQueue.push([]);
		sqlQueue.push([]);
		const res = mockRes();
		await viewHandler(viewReq({ 'x-vercel-ip-country': 'X'.repeat(500) }), res);
		expect(res.statusCode).toBe(204);
		// Bound values are (widget_id, country, referer_host): country must be null
		// and the forged string must appear nowhere in the statement.
		const values = sqlMock.mock.calls[0].slice(1);
		expect(values[1]).toBeNull();
		expect(values.some((v) => String(v).includes('XXX'))).toBe(false);
	});

	it('still 204s when the widget id matches no row (foreign-key miss)', async () => {
		const fk = Object.assign(new Error('insert violates foreign key constraint'), {
			code: '23503',
		});
		sqlQueue.push(fk);
		sqlQueue.push(fk);
		const res = mockRes();
		await viewHandler(viewReq({}), res);
		expect(res.statusCode).toBe(204);
	});

	// The best-effort swallow is deliberately narrow. A fault outside it must
	// reach the wrap() boundary and surface as a 5xx, never a phantom 204 that
	// hides the analytics lane going dark.
	it('surfaces a real database fault instead of reporting success', async () => {
		sqlQueue.push(
			Object.assign(new Error('column "country" does not exist'), { code: '42703' }),
		);
		const res = mockRes();
		await viewHandler(viewReq({}), res);
		expect(res.statusCode).toBeGreaterThanOrEqual(500);
	});
});
