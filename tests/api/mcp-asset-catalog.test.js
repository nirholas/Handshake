// The asset-catalog MCP tools (api/_mcp/tools/library.js) and the two libraries
// under them: the manifest join (api/_lib/asset-catalog.js) and the snippet
// builder (api/_lib/asset-snippets.js).
//
// R2 is stubbed with manifests shaped exactly like the published ones (the
// field names and the "collection: x" category convention come from the live
// objects/avatars/animations manifests), so the suite exercises the real join,
// the real ranking, and the real code generation without a network call.

import { describe, it, expect, beforeEach, vi } from 'vitest';

const MANIFESTS = {
	'objects/library/manifest.json': {
		generated_at: '2026-09-01T00:00:00.000Z',
		objects: [
			{
				name: 'adjustable_wrench',
				label: 'Adjustable Wrench',
				url: 'https://cdn.test/objects/adjustable_wrench.glb',
				thumb: 'https://cdn.test/objects/adjustable_wrench.png',
				bytes: 2639744,
				categories: ['collection: project_lighthouse', 'props', 'tools'],
				tags: ['vintage', 'garage', 'hand tool'],
				license: 'CC0',
			},
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
				thumb: 'https://cdn.test/avatars/abe.png',
				bytes: 35947032,
				skins: 1,
				animations: 1,
				source: 'mixamo',
				license: 'Mixamo',
			},
		],
	},
	'animations/library/manifest.json': {
		clips: [
			{
				name: 'mx-wave-abc123',
				label: 'Wave',
				url: 'https://cdn.test/animations/mx-wave-abc123.json',
				thumb: 'https://cdn.test/animations/mx-wave-abc123.webp',
				duration: 2.5,
				loop: false,
				icon: '👋',
			},
		],
	},
	// The generated catalog may not exist yet; a missing key must degrade to
	// empty rather than failing the whole catalog.
	'animations/library/generated/manifest.json': null,
};

const getObjectBuffer = vi.fn(async (key) => {
	const value = MANIFESTS[key];
	if (value == null) {
		const err = new Error('NoSuchKey');
		err.name = 'NoSuchKey';
		throw err;
	}
	return Buffer.from(JSON.stringify(value), 'utf8');
});

vi.mock('../../api/_lib/r2.js', () => ({ getObjectBuffer }));

const { searchCatalog, getCatalogItem, relatedItems, resetCatalogCache } = await import(
	'../../api/_lib/asset-catalog.js'
);
const { sourceFor, snippetFor, frameworksFor, agentElementRelease } = await import(
	'../../api/_lib/asset-snippets.js'
);
const { toolDefs } = await import('../../api/_mcp/tools/library.js');
const { isPublicTool } = await import('../../api/_mcp/dispatch.js');

const tool = (name) => toolDefs.find((t) => t.name === name);
const req = { headers: { host: 'three.ws' } };

beforeEach(() => {
	resetCatalogCache();
	getObjectBuffer.mockClear();
});

describe('catalog join', () => {
	it('reads all three libraries into one normalized list', async () => {
		const res = await searchCatalog({ limit: 50 });
		expect(res.total).toBe(4);
		expect(res.items.map((i) => i.id).sort()).toEqual([
			'animation:mx-wave-abc123',
			'character:abe',
			'object:adjustable_wrench',
			'object:wooden_chair',
		]);
	});

	it('lifts "collection: x" out of the browsable categories', async () => {
		const item = await getCatalogItem('object:adjustable_wrench');
		expect(item.categories).toEqual(['props', 'tools']);
		expect(item.collection).toBe('project_lighthouse');
	});

	it('degrades to empty for a manifest that was never published', async () => {
		// The generated animation manifest throws NoSuchKey above; the catalog
		// still holds the curated clip.
		const res = await searchCatalog({ kind: 'animation', limit: 50 });
		expect(res.items).toHaveLength(1);
	});

	it('memoizes the manifests so repeat searches do not re-read storage', async () => {
		await searchCatalog({ q: 'chair' });
		const afterFirst = getObjectBuffer.mock.calls.length;
		await searchCatalog({ q: 'wrench' });
		expect(getObjectBuffer.mock.calls.length).toBe(afterFirst);
	});
});

describe('ranking', () => {
	it('ranks a title match above a tag match', async () => {
		const res = await searchCatalog({ q: 'wrench' });
		expect(res.items[0].id).toBe('object:adjustable_wrench');
	});

	it('requires every term to match, so a two-word query does not return everything', async () => {
		const res = await searchCatalog({ q: 'wooden chair' });
		expect(res.items.map((i) => i.id)).toEqual(['object:wooden_chair']);
		expect(res.relaxed).toBe(false);
	});

	it('relaxes to a partial match rather than dead-ending an unmatched phrase', async () => {
		const res = await searchCatalog({ q: 'wooden wrench' });
		expect(res.relaxed).toBe(true);
		// Both words land somewhere, and the item matching a title word outranks
		// the one matching only a tag.
		expect(res.items.map((i) => i.id)).toEqual([
			'object:adjustable_wrench',
			'object:wooden_chair',
		]);
	});

	it('does not relax a single-word query that simply has no match', async () => {
		const res = await searchCatalog({ q: 'submarine' });
		expect(res.relaxed).toBe(false);
		expect(res.items).toHaveLength(0);
	});

	it('filters by kind, category, and tag', async () => {
		expect((await searchCatalog({ kind: 'character' })).items[0].id).toBe('character:abe');
		expect((await searchCatalog({ category: 'FURNITURE' })).items[0].id).toBe('object:wooden_chair');
		expect((await searchCatalog({ tag: 'Garage' })).items[0].id).toBe('object:adjustable_wrench');
	});

	it('pages with a stable order and reports next_offset', async () => {
		const first = await searchCatalog({ kind: 'object', limit: 1 });
		expect(first.next_offset).toBe(1);
		const second = await searchCatalog({ kind: 'object', limit: 1, offset: 1 });
		expect(second.items[0].id).not.toBe(first.items[0].id);
		expect(second.next_offset).toBeNull();
	});

	it('resolves a bare name as well as a `<kind>:<name>` id', async () => {
		expect((await getCatalogItem('abe')).id).toBe('character:abe');
		expect(await getCatalogItem('nope')).toBeNull();
	});

	it('relates items of the same kind that share tags', async () => {
		const wrench = await getCatalogItem('object:adjustable_wrench');
		const related = await relatedItems(wrench);
		expect(related.every((r) => r.kind === 'object')).toBe(true);
		expect(related.some((r) => r.id === 'object:adjustable_wrench')).toBe(false);
	});
});

describe('source snippets', () => {
	it('recommends model-viewer for a prop and the avatar component for a character', async () => {
		expect(frameworksFor(await getCatalogItem('object:wooden_chair'))[0]).toBe('model-viewer');
		expect(frameworksFor(await getCatalogItem('character:abe'))[0]).toBe('agent-3d');
		expect(frameworksFor(await getCatalogItem('animation:mx-wave-abc123'))[0]).toBe('three');
	});

	it('pins the agent-3d snippet to a version and never ships "latest"', async () => {
		const item = await getCatalogItem('character:abe');
		const snippet = snippetFor(item, 'agent-3d', 'https://three.ws');
		expect(snippet.code).not.toContain('/latest/');
		const release = agentElementRelease();
		if (release?.version && release.integrity) {
			expect(snippet.code).toContain(`/agent-3d/${release.version}/agent-3d.js`);
			expect(snippet.code).toContain(release.integrity);
		} else {
			expect(snippet.code).toContain('/agent-3d/1/agent-3d.js');
		}
	});

	it('emits the asset url into every model framework', async () => {
		const item = await getCatalogItem('object:wooden_chair');
		const { snippets } = sourceFor(item, 'https://three.ws');
		for (const framework of ['agent-3d', 'model-viewer', 'three', 'react']) {
			expect(snippets[framework].code).toContain(item.url);
		}
	});

	it('builds a clip snippet that parses THREE.AnimationClip JSON with the clip loop mode', async () => {
		const item = await getCatalogItem('animation:mx-wave-abc123');
		const snippet = snippetFor(item, 'three', 'https://three.ws');
		expect(snippet.code).toContain('THREE.AnimationClip.parse');
		expect(snippet.code).toContain('THREE.LoopOnce');
		expect(snippet.code).toContain(item.url);
	});

	it('produces a legal React identifier even for a title that starts with a digit', async () => {
		const item = { ...(await getCatalogItem('animation:mx-wave-abc123')), title: '135 Degree Turn' };
		const snippet = snippetFor(item, 'react', 'https://three.ws');
		expect(snippet.code).toMatch(/export function use[A-Za-z]/);
	});

	it('links each kind to the page that actually browses it', async () => {
		expect(sourceFor(await getCatalogItem('object:wooden_chair'), 'https://three.ws').links.browse)
			.toBe('https://three.ws/objects');
		expect(sourceFor(await getCatalogItem('character:abe'), 'https://three.ws').links.browse)
			.toBe('https://three.ws/character-library');
		expect(sourceFor(await getCatalogItem('animation:mx-wave-abc123'), 'https://three.ws').links.preview)
			.toBe('https://three.ws/animations?clip=mx-wave-abc123');
	});
});

describe('mcp tools', () => {
	it('search_catalog returns readable text and structured results', async () => {
		const out = await tool('search_catalog').handler({ q: 'chair' }, {}, req);
		expect(out.structuredContent.ok).toBe(true);
		expect(out.structuredContent.items[0].id).toBe('object:wooden_chair');
		expect(out.content[0].text).toContain('object:wooden_chair');
	});

	it('search_catalog tells an empty result what to do next', async () => {
		const out = await tool('search_catalog').handler({ q: 'submarine' }, {}, req);
		expect(out.structuredContent.items).toHaveLength(0);
		expect(out.content[0].text).toContain('No catalog items match');
	});

	it('search_catalog says so when it fell back to a partial match', async () => {
		const out = await tool('search_catalog').handler({ q: 'wooden wrench' }, {}, req);
		expect(out.structuredContent.relaxed).toBe(true);
		expect(out.content[0].text).toContain('Nothing matches every word');
	});

	it('get_catalog_item rejects an unknown id with a usable hint', async () => {
		await expect(tool('get_catalog_item').handler({ id: 'object:nope' }, {}, req)).rejects.toThrow(
			/no catalog item/,
		);
	});

	it('get_item_source defaults to the recommended framework', async () => {
		const out = await tool('get_item_source').handler({ id: 'object:wooden_chair' }, {}, req);
		expect(out.structuredContent.framework).toBe('model-viewer');
		expect(out.content[0].text).toContain('<model-viewer');
	});

	it('get_item_source with framework "all" returns every applicable variant', async () => {
		const out = await tool('get_item_source').handler(
			{ id: 'character:abe', framework: 'all' },
			{},
			req,
		);
		expect(Object.keys(out.structuredContent.snippets).sort()).toEqual(
			['agent-3d', 'model-viewer', 'react', 'three'].sort(),
		);
	});

	it('get_item_source refuses a framework that does not apply to a motion clip', async () => {
		await expect(
			tool('get_item_source').handler(
				{ id: 'animation:mx-wave-abc123', framework: 'model-viewer' },
				{},
				req,
			),
		).rejects.toThrow(/does not apply/);
	});

	it('every catalog tool is callable with no account and no payment', () => {
		for (const def of toolDefs) {
			expect(def.scope).toBeUndefined();
			expect(isPublicTool(def.name)).toBe(true);
		}
	});

	it('does not make an account-scoped tool public', () => {
		expect(isPublicTool('list_my_avatars')).toBe(false);
		expect(isPublicTool('recall')).toBe(false);
		expect(isPublicTool('getting_started')).toBe(true);
	});
});
