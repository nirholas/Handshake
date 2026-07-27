import { describe, it, expect } from 'vitest';

import {
	deriveModelMetadata,
	parseInspectResult,
	inspectModelRpcBody,
} from '../api/_lib/x402/enrich-model-metadata.js';
import { getFullRegistry } from '../api/_lib/x402/autonomous-registry.js';

// A minimal inspect_model structuredContent shape (matches src/gltf-inspect.js).
const inspection = (over = {}) => ({
	url: 'https://three.ws/cdn/u/x/model.glb',
	filename: 'model.glb',
	container: 'glb',
	generator: 'Khronos Blender glTF 2.0 exporter',
	version: '2.0',
	extensionsUsed: [],
	counts: {
		scenes: 1, nodes: 5, meshes: 1, materials: 1, textures: 1,
		animations: 0, skins: 0, totalVertices: 4000, totalTriangles: 5000,
		indexedPrimitives: 1, nonIndexedPrimitives: 0,
		...(over.counts || {}),
	},
	...over,
});

describe('model metadata enrichment — deriveModelMetadata', () => {
	it('tags a static, single-mesh, textured low-poly glb', () => {
		const { tags, model_category } = deriveModelMetadata(inspection());
		expect(tags).toContain('glb');
		expect(tags).toContain('static');
		expect(tags).toContain('single-mesh');
		expect(tags).toContain('textured');
		expect(tags).toContain('low-poly');
		expect(tags).not.toContain('animated');
		expect(model_category).toBe('prop');
	});

	it('classifies a skinned, animated mesh as an avatar', () => {
		const info = inspection({ counts: { skins: 1, animations: 3, meshes: 2, textures: 2, materials: 2, totalTriangles: 45000 } });
		const { tags, model_category } = deriveModelMetadata(info);
		expect(tags).toContain('rigged');
		expect(tags).toContain('animated');
		expect(tags).toContain('multi-mesh');
		expect(tags).toContain('multi-material');
		expect(tags).toContain('mid-poly');
		expect(model_category).toBe('avatar');
	});

	it('buckets triangles into low / mid / high poly tiers', () => {
		expect(deriveModelMetadata(inspection({ counts: { totalTriangles: 9000 } })).tags).toContain('low-poly');
		expect(deriveModelMetadata(inspection({ counts: { totalTriangles: 50000 } })).tags).toContain('mid-poly');
		expect(deriveModelMetadata(inspection({ counts: { totalTriangles: 250000 } })).tags).toContain('high-poly');
	});

	it('marks an untextured mesh and compression extensions', () => {
		const info = inspection({
			counts: { textures: 0, materials: 0 },
			extensionsUsed: ['KHR_draco_mesh_compression', 'KHR_texture_basisu', 'EXT_meshopt_compression'],
		});
		const { tags } = deriveModelMetadata(info);
		expect(tags).toContain('untextured');
		expect(tags).toContain('draco');
		expect(tags).toContain('ktx2');
		expect(tags).toContain('meshopt');
	});

	it('caps the tag set at 20 and never returns duplicates', () => {
		const { tags } = deriveModelMetadata(inspection());
		expect(tags.length).toBeLessThanOrEqual(20);
		expect(new Set(tags).size).toBe(tags.length);
	});
});

describe('model metadata enrichment — parseInspectResult', () => {
	it('pulls structuredContent out of a JSON-RPC tools/call response', () => {
		const body = { jsonrpc: '2.0', id: 1, result: { structuredContent: inspection() } };
		expect(parseInspectResult(body)).toMatchObject({ container: 'glb' });
	});

	it('returns null on a tool error, a JSON-RPC error, or a malformed envelope', () => {
		expect(parseInspectResult({ result: { isError: true, structuredContent: inspection() } })).toBeNull();
		expect(parseInspectResult({ error: { code: -32000, message: 'boom' } })).toBeNull();
		expect(parseInspectResult({ result: { structuredContent: { no: 'counts' } } })).toBeNull();
		expect(parseInspectResult(null)).toBeNull();
	});
});

describe('model metadata enrichment — inspectModelRpcBody', () => {
	it('builds a tools/call envelope for inspect_model with the GLB url', () => {
		const body = inspectModelRpcBody('https://three.ws/cdn/a.glb');
		expect(body).toMatchObject({
			jsonrpc: '2.0',
			method: 'tools/call',
			params: { name: 'inspect_model', arguments: { url: 'https://three.ws/cdn/a.glb' } },
		});
	});
});

describe('model metadata enrichment — registry wiring', () => {
	it('is registered as an enabled, hourly, run()-style 3d entry on /api/mcp', () => {
		const entry = getFullRegistry().find((e) => e.id === 'enrich-model-metadata');
		expect(entry).toBeTruthy();
		expect(entry.enabled).toBe(true);
		expect(entry.pipeline).toBe('3d');
		expect(entry.cooldown_s).toBe(3600);
		expect(entry.path).toBe('/api/mcp');
		expect(typeof entry.run).toBe('function');
	});
});
