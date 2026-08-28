// The endpoint's own contract: what it answers, what it refuses, and what it
// hands to the GLB exporter. The network and the cache are mocked at the module
// boundary (no site is fetched here); the layout, the exporter and the error
// mapping are the real implementations.
import { describe, it, expect, vi, beforeEach } from 'vitest';

process.env.PUBLIC_APP_ORIGIN ||= 'https://three.ws';

const limiterOk = { success: true, reset: Date.now() + 60_000, limit: 10, remaining: 9 };
const limiterHit = { success: false, reset: Date.now() + 60_000, limit: 10, remaining: 0 };
const limits = {
	portalBuildIp: vi.fn(async () => limiterOk),
	portalBuildGlobal: vi.fn(async () => limiterOk),
	portalExportIp: vi.fn(async () => limiterOk),
};
vi.mock('../api/_lib/rate-limit.js', () => ({
	limits,
	clientIp: () => '203.0.113.7',
}));

// A cache that always misses, so every test exercises the real build path.
vi.mock('../api/_lib/cache.js', () => ({
	cacheWrapLastGood: async (_key, _ttl, load) => ({ value: await load(), stale: false }),
}));

const fetchState = { outline: null, error: null };
vi.mock('../api/_lib/portal/fetch-site.js', async (importOriginal) => {
	const mod = await importOriginal();
	return {
		...mod,
		outlineForUrl: vi.fn(async () => {
			if (fetchState.error) throw fetchState.error;
			return fetchState.outline;
		}),
	};
});

const { PortalFetchError } = await import('../api/_lib/portal/fetch-site.js');
const handler = (await import('../api/portal.js')).default;

function makeRes() {
	const res = {
		statusCode: 200,
		headers: {},
		body: null,
		setHeader(k, v) {
			this.headers[k.toLowerCase()] = v;
		},
		getHeader(k) {
			return this.headers[k.toLowerCase()];
		},
		end(payload) {
			this.body = payload;
			this.ended = true;
			return this;
		},
	};
	return res;
}

const call = async (url) => {
	const req = { method: 'GET', url, headers: { host: 'three.ws' } };
	const res = makeRes();
	await handler(req, res);
	return res;
};

const json = (res) => JSON.parse(String(res.body));

const OUTLINE = {
	version: 1,
	url: 'https://site.test/',
	canonical: 'https://site.test/',
	host: 'site.test',
	title: 'Site',
	description: 'desc',
	siteName: null,
	themeColor: '#3366ff',
	image: null,
	icon: null,
	lang: 'en',
	words: 90,
	linkCounts: { internal: 1, external: 0 },
	sections: [
		{ id: 'intro', level: 1, heading: 'Intro', summary: 'hello', words: 90, paragraphs: 3, codeBlocks: 1, links: [{ href: 'https://site.test/a', text: 'a', internal: true }], images: [] },
	],
};

beforeEach(() => {
	fetchState.outline = OUTLINE;
	fetchState.error = null;
	limits.portalBuildIp.mockResolvedValue(limiterOk);
	limits.portalBuildGlobal.mockResolvedValue(limiterOk);
	limits.portalExportIp.mockResolvedValue(limiterOk);
});

describe('GET /api/portal', () => {
	it('returns the outline and the world it built', async () => {
		const res = await call('/api/portal?url=site.test');
		expect(res.statusCode).toBe(200);
		const body = json(res);
		expect(body.ok).toBe(true);
		expect(body.world.meta.host).toBe('site.test');
		expect(body.world.buildings).toHaveLength(1);
		expect(body.outline.title).toBe('Site');
		expect(body.user_agent).toContain('ThreeWSPortalBot');
	});

	it('honours include=world and include=outline', async () => {
		expect(json(await call('/api/portal?url=site.test&include=world')).outline).toBeUndefined();
		expect(json(await call('/api/portal?url=site.test&include=outline')).world).toBeUndefined();
	});

	it('rejects an address that is not a web address', async () => {
		const res = await call('/api/portal?url=' + encodeURIComponent('ftp://files.test/x'));
		expect(res.statusCode).toBe(400);
		expect(json(res).error).toBe('invalid_url');
	});

	it('asks for a url when none is given', async () => {
		expect((await call('/api/portal')).statusCode).toBe(400);
	});

	it('passes a fetch failure through with its own code and status', async () => {
		fetchState.error = new PortalFetchError('robots_disallowed', 'site.test asks crawlers not to read this page.', 403);
		const res = await call('/api/portal?url=site.test');
		expect(res.statusCode).toBe(403);
		expect(json(res).error).toBe('robots_disallowed');
	});

	it('rate limits a new build per address, with a retry hint', async () => {
		limits.portalBuildIp.mockResolvedValue(limiterHit);
		const res = await call('/api/portal?url=site.test');
		expect(res.statusCode).toBe(429);
		expect(json(res).error).toBe('rate_limited');
		expect(Number(res.getHeader('retry-after'))).toBeGreaterThan(0);
	});

	it('brakes fleet-wide when the global bucket is spent', async () => {
		limits.portalBuildGlobal.mockResolvedValue(limiterHit);
		expect((await call('/api/portal?url=site.test')).statusCode).toBe(429);
	});

	it('exports a real GLB, named after the site', async () => {
		const res = await call('/api/portal?url=site.test&format=glb');
		expect(res.statusCode).toBe(200);
		expect(res.getHeader('content-type')).toBe('model/gltf-binary');
		expect(res.getHeader('content-disposition')).toContain('portal-site.test.glb');
		expect(Buffer.from(res.body).subarray(0, 4).toString()).toBe('glTF');
	});

	it('rate limits the export separately from the build', async () => {
		limits.portalExportIp.mockResolvedValue(limiterHit);
		const res = await call('/api/portal?url=site.test&format=glb');
		expect(res.statusCode).toBe(429);
	});

	it('answers a CORS preflight, since the SDK runs on other origins', async () => {
		const req = { method: 'OPTIONS', url: '/api/portal?url=site.test', headers: { origin: 'https://elsewhere.test' } };
		const res = makeRes();
		await handler(req, res);
		expect(res.statusCode).toBeLessThan(300);
		expect(res.getHeader('access-control-allow-origin')).toBeTruthy();
	});
});
