// GET /api/catalog: the public asset-catalog endpoint.
//
// R2 is stubbed with manifests shaped like the published ones, so the suite
// exercises the real join, the real validation, and the real snippet payload
// without a network call. The endpoint is the CLI's only server dependency
// (@three-ws/assets), so its response shape is a contract, not an internal.

import { describe, it, expect, beforeEach, vi } from 'vitest';

const MANIFESTS = {
	'objects/library/manifest.json': {
		objects: [
			{
				name: 'wooden_chair',
				label: 'Wooden Chair',
				url: 'https://cdn.test/objects/wooden_chair.glb',
				thumb: 'https://cdn.test/objects/wooden_chair.png',
				bytes: 1048576,
				categories: ['furniture'],
				tags: ['wood', 'seating'],
				license: 'CC0',
			},
		],
	},
	'avatars/library/manifest.json': {
		avatars: [
			{
				name: 'abe',
				label: 'Abe',
				url: 'https://cdn.test/avatars/abe.glb',
				bytes: 35947032,
				source: 'mixamo',
				license: 'Mixamo',
			},
		],
	},
	'animations/library/manifest.json': { clips: [] },
	'animations/library/generated/manifest.json': null,
};

vi.mock('../../api/_lib/r2.js', () => ({
	getObjectBuffer: vi.fn(async (key) => {
		const value = MANIFESTS[key];
		if (value == null) {
			const err = new Error('NoSuchKey');
			err.name = 'NoSuchKey';
			throw err;
		}
		return Buffer.from(JSON.stringify(value), 'utf8');
	}),
}));

vi.mock('../../api/_lib/rate-limit.js', async (importOriginal) => {
	const actual = await importOriginal();
	return {
		...actual,
		limits: { ...actual.limits, publicIp: async () => ({ success: true, limit: 240, remaining: 239, reset: Date.now() + 60_000 }) },
	};
});

const { resetCatalogCache } = await import('../../api/_lib/asset-catalog.js');
const handler = (await import('../../api/catalog.js')).default;

function invoke(url) {
	const req = { method: 'GET', url, headers: { host: 'three.ws' } };
	let status = 0;
	let body = null;
	const headers = {};
	const res = {
		setHeader: (k, v) => {
			headers[k.toLowerCase()] = v;
		},
		getHeader: (k) => headers[k.toLowerCase()],
		removeHeader: (k) => delete headers[k.toLowerCase()],
		writeHead(code, hdrs) {
			status = code;
			Object.assign(headers, hdrs || {});
			return this;
		},
		end(payload) {
			if (!status) status = 200;
			try {
				body = payload ? JSON.parse(payload) : null;
			} catch {
				body = payload;
			}
			return this;
		},
		set statusCode(v) {
			status = v;
		},
		get statusCode() {
			return status;
		},
	};
	return handler(req, res).then(() => ({ status, body, headers }));
}

beforeEach(() => resetCatalogCache());

describe('GET /api/catalog', () => {
	it('searches across every library', async () => {
		const { status, body } = await invoke('/api/catalog?q=chair');
		expect(status).toBe(200);
		expect(body.ok).toBe(true);
		expect(body.items[0].id).toBe('object:wooden_chair');
		expect(body.total).toBe(2);
	});

	it('filters by kind', async () => {
		const { body } = await invoke('/api/catalog?kind=character');
		expect(body.items.map((i) => i.id)).toEqual(['character:abe']);
	});

	it('returns an item with links, related, frameworks, and every snippet', async () => {
		const { status, body } = await invoke('/api/catalog?id=object:wooden_chair');
		expect(status).toBe(200);
		expect(body.item.id).toBe('object:wooden_chair');
		expect(body.frameworks[0]).toBe('model-viewer');
		expect(Object.keys(body.snippets).sort()).toEqual(
			['agent-3d', 'model-viewer', 'react', 'three'].sort(),
		);
		expect(body.snippets['model-viewer'].code).toContain(body.item.url);
		expect(body.links.browse).toBe('https://three.ws/objects');
	});

	it('404s an unknown id with a hint that names the next call', async () => {
		const { status, body } = await invoke('/api/catalog?id=object:nope');
		expect(status).toBe(404);
		expect(body.error).toBe('not_found');
		expect(body.hint).toMatch(/\/api\/catalog\?q=/);
	});

	it('rejects a bad kind, limit, and offset before reading storage', async () => {
		expect((await invoke('/api/catalog?kind=furniture')).status).toBe(400);
		expect((await invoke('/api/catalog?limit=0')).status).toBe(400);
		expect((await invoke('/api/catalog?limit=2.5')).status).toBe(400);
		expect((await invoke('/api/catalog?limit=999')).status).toBe(400);
		expect((await invoke('/api/catalog?offset=abc')).status).toBe(400);
	});

	it('is cacheable at the edge', async () => {
		const { headers } = await invoke('/api/catalog?q=chair');
		expect(headers['cache-control']).toContain('s-maxage=300');
	});
});
