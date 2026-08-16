/**
 * Two public read surfaces whose exported helpers are shared beyond their own
 * handler and had no coverage.
 *
 * api/loom.js is the store behind the world-readable creations gallery, and
 * api/creations.js reads through the same helpers. Its sanitizers and the GLB
 * host allowlist are the only thing between an anonymous POST and an arbitrary
 * URL rendered to every visitor.
 *
 * api/locale.js slices a translation catalog down to the namespaces a page
 * asks for. The slice is CDN-cached per (locale, namespace-set), so namespace
 * normalization has to be order- and duplicate-insensitive or the cache key
 * fragments and the origin serves every permutation.
 */
import { describe, it, expect } from 'vitest';
import { Readable } from 'node:stream';

const {
	sanitizePrompt,
	sanitizeAuthor,
	sanitizeOptionalString,
	validateGlbUrl,
	writeCreation,
	readFeed,
	readOne,
} = await import('../../api/loom.js');
const { normalizeNamespaces, sliceFor, default: localeHandler } = await import(
	'../../api/locale.js',
);

describe('loom sanitizers', () => {
	it('collapses whitespace and control characters in a prompt', () => {
		expect(sanitizePrompt('  a brass   telescope  on a tripod  ')).toBe(
			'a brass telescope on a tripod',
		);
		expect(sanitizePrompt('abcd')).toBe('abcd');
	});

	it('falls back to the anonymous author and caps the length', () => {
		expect(sanitizeAuthor('  Ada  ')).toBe('Ada');
		expect(sanitizeAuthor('   ')).toBe('anon');
		expect(sanitizeAuthor(null)).toBe('anon');
		expect(sanitizeAuthor(42)).toBe('anon');
		expect(sanitizeAuthor('z'.repeat(200))).toHaveLength(40);
	});

	it('returns null rather than an empty string for optional fields', () => {
		expect(sanitizeOptionalString('draft', 40)).toBe('draft');
		expect(sanitizeOptionalString('   ', 40)).toBeNull();
		expect(sanitizeOptionalString(undefined, 40)).toBeNull();
		expect(sanitizeOptionalString('y'.repeat(100), 10)).toHaveLength(10);
	});
});

describe('loom validateGlbUrl', () => {
	it('accepts the hosts a forged GLB can actually live on', () => {
		for (const url of [
			'https://three.ws/models/a.glb',
			'https://three.ws/cdn/models/a.glb',
			'https://pub-abc.r2.dev/forge/a.glb',
			'https://acct.r2.cloudflarestorage.com/a.glb',
			'https://replicate.delivery/pbxt/a.glb',
			'https://raw.githubusercontent.com/o/r/main/a.glb',
		]) {
			expect(validateGlbUrl(url), url).toBeTruthy();
		}
	});

	it('rejects other hosts, other schemes, and junk', () => {
		for (const url of [
			'https://evil.example.com/a.glb',
			'https://three.ws.evil.com/a.glb',
			'https://notthree.ws/a.glb',
			'http://three.ws/a.glb',
			'javascript:alert(1)',
			'not a url',
			'',
			null,
			{ href: 'https://three.ws/a.glb' },
		]) {
			expect(validateGlbUrl(url), String(url)).toBeNull();
		}
	});
});

describe('loom feed store (in-memory backend, no Redis configured)', () => {
	it('reads a written creation back by id and newest-first from the feed', async () => {
		const rec = {
			id: 'test-creation-1',
			prompt: 'a brass telescope',
			glbUrl: 'https://three.ws/models/test-1.glb',
			previewImageUrl: null,
			author: 'anon',
			tier: null,
			backend: null,
			createdAt: 1_700_000_000_000,
		};
		await writeCreation(rec);
		expect(await readOne('test-creation-1')).toEqual(rec);
		expect(await readOne('no-such-id')).toBeNull();
		expect(await readOne('')).toBeNull();

		const feed = await readFeed(10, NaN);
		expect(feed[0].id).toBe('test-creation-1');
	});

	it('pages backwards with the `before` cursor', async () => {
		await writeCreation({ id: 'older', glbUrl: 'x', createdAt: 1_700_000_000_001 });
		await writeCreation({ id: 'newer', glbUrl: 'y', createdAt: 1_700_000_000_002 });
		const page = await readFeed(10, 1_700_000_000_002);
		expect(page.map((r) => r.id)).not.toContain('newer');
		expect(page.map((r) => r.id)).toContain('older');
	});

	it('clamps the page size into the documented range', async () => {
		expect((await readFeed(0, NaN)).length).toBeLessThanOrEqual(120);
		expect((await readFeed(9999, NaN)).length).toBeLessThanOrEqual(120);
	});
});

describe('locale normalizeNamespaces', () => {
	it('is order- and duplicate-insensitive so one cache key serves every caller', () => {
		expect(normalizeNamespaces('nav,play')).toEqual(['nav', 'play']);
		expect(normalizeNamespaces('play,nav')).toEqual(['nav', 'play']);
		expect(normalizeNamespaces(' play , nav , play ')).toEqual(['nav', 'play']);
	});

	it('drops anything that is not a plain namespace identifier', () => {
		expect(normalizeNamespaces('nav,../../etc/passwd,play')).toEqual(['nav', 'play']);
		expect(normalizeNamespaces('a-b,c.d,e/f')).toEqual([]);
		expect(normalizeNamespaces('')).toEqual([]);
		expect(normalizeNamespaces(null)).toEqual([]);
	});
});

describe('locale sliceFor', () => {
	it('returns only the requested sections of a real catalog', () => {
		const body = sliceFor('en', ['nav']);
		expect(body).toBeTruthy();
		expect(Object.keys(JSON.parse(body))).toEqual(['nav']);
	});

	it('omits a section the catalog does not carry instead of nulling it', () => {
		const parsed = JSON.parse(sliceFor('en', ['nav', 'definitely_not_a_section']));
		expect(parsed).not.toHaveProperty('definitely_not_a_section');
	});

	it('returns null for a catalog file that does not exist', () => {
		expect(sliceFor('zz-not-a-locale', ['nav'])).toBeNull();
	});
});

function makeRes() {
	return {
		statusCode: 200,
		headers: {},
		body: null,
		setHeader(name, value) {
			this.headers[String(name).toLowerCase()] = value;
		},
		getHeader(name) {
			return this.headers[String(name).toLowerCase()];
		},
		end(body) {
			this.body = body ?? null;
		},
	};
}

function makeReq(url) {
	const req = Readable.from([]);
	req.method = 'GET';
	req.url = url;
	req.headers = {};
	return req;
}

describe('GET /api/locale', () => {
	it('serves the requested slice with a cacheable response', async () => {
		const res = makeRes();
		await localeHandler(makeReq('/api/locale?code=en&ns=nav'), res);
		expect(res.statusCode).toBe(200);
		expect(res.headers['cache-control']).toContain('s-maxage=');
		expect(Object.keys(JSON.parse(res.body))).toEqual(['nav']);
	});

	it('rejects an unpublished locale without reflecting an unbounded probe', async () => {
		const res = makeRes();
		const probe = 'A'.repeat(500);
		await localeHandler(makeReq(`/api/locale?code=${probe}&ns=nav`), res);
		expect(res.statusCode).toBe(400);
		expect(JSON.parse(res.body).error).toBe('unknown_locale');
		expect(res.body.length).toBeLessThan(200);
	});

	it('requires at least one namespace and caps how many can be asked for', async () => {
		const missing = makeRes();
		await localeHandler(makeReq('/api/locale?code=en'), missing);
		expect(missing.statusCode).toBe(400);
		expect(JSON.parse(missing.body).error).toBe('missing_ns');

		const tooMany = makeRes();
		const ns = Array.from({ length: 70 }, (_, i) => `ns${i}`).join(',');
		await localeHandler(makeReq(`/api/locale?code=en&ns=${ns}`), tooMany);
		expect(tooMany.statusCode).toBe(400);
		expect(JSON.parse(tooMany.body).error).toBe('too_many_ns');
	});
});
