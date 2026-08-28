// Catalog entry for the free 3D Diff endpoint. The /api/3d index globs
// api/_lib/3d-catalog/*.js and merges every default export into the public API
// catalog + the generated OpenAPI doc, so this descriptor is what makes
// /api/3d/diff discoverable to an agent that has never seen this platform.

export default {
	id: 'diff',
	name: '3D Model Diff',
	path: '/api/3d/diff',
	methods: ['GET', 'POST'],
	free: true,
	keyless: true,
	category: '3d',
	tags: ['3d', 'gltf', 'glb', 'diff', 'regression', 'ci', 'version-control'],
	summary: 'Compare two glTF/GLB models and report what changed, with a severity you can gate a build on.',
	description:
		'Fetches two glTF/GLB models and returns a structural change set: geometry, hierarchy, ' +
		'materials, textures, skeletons, and animation clips, each classified as added, removed, ' +
		'renamed, moved, or modified. Rename and move detection works the way git does (match by ' +
		'name, then by content hash, then by similarity), so re-exporting a file does not read as ' +
		'a rewrite. Every change carries a severity: none, cosmetic, minor, major, breaking. ' +
		'Set format=markdown or format=text to get a rendered report instead of JSON.',
	useCase:
		'A pipeline that optimizes, rigs, restyles, or re-exports a model needs to know whether the ' +
		'output is still the same asset. Byte comparison cannot tell a lossless recompression from ' +
		'a rig that lost three finger joints; this can, and the losing case is the one that takes an ' +
		'avatar off the screen. Gate CI on severity, or post the Markdown report on the pull request.',
	input: {
		query: {
			a: { type: 'string', format: 'uri', required: true, description: 'Public https URL of the baseline .glb/.gltf (max 32 MiB).' },
			b: { type: 'string', format: 'uri', required: true, description: 'Public https URL of the candidate .glb/.gltf (max 32 MiB).' },
			format: {
				type: 'string',
				required: false,
				description: 'json (default), markdown for a pull-request comment, or text for the terminal report.',
			},
		},
		body: { description: 'POST { "a": "…", "b": "…", "format": "json" } as application/json.' },
	},
	inputSchema: {
		$schema: 'https://json-schema.org/draft/2020-12/schema',
		type: 'object',
		required: ['a', 'b'],
		properties: {
			a: { type: 'string', format: 'uri', description: 'Baseline model URL.' },
			b: { type: 'string', format: 'uri', description: 'Candidate model URL.' },
			format: { type: 'string', enum: ['json', 'markdown', 'text'], default: 'json' },
		},
	},
	outputSchema: {
		$schema: 'https://json-schema.org/draft/2020-12/schema',
		type: 'object',
		required: ['version', 'identical', 'severity', 'summary', 'totals', 'sections', 'highlights', 'ts'],
		properties: {
			version: { type: 'integer', description: 'Change-set schema version.' },
			identical: { type: 'boolean' },
			severity: { type: 'string', enum: ['none', 'cosmetic', 'minor', 'major', 'breaking'] },
			a: { type: 'object', properties: { name: { type: ['string', 'null'] }, url: { type: 'string' }, sizeBytes: { type: 'integer' } } },
			b: { type: 'object', properties: { name: { type: ['string', 'null'] }, url: { type: 'string' }, sizeBytes: { type: 'integer' } } },
			summary: {
				type: 'object',
				properties: {
					changed: { type: 'integer' },
					added: { type: 'integer' },
					removed: { type: 'integer' },
					modified: { type: 'integer' },
					renamed: { type: 'integer' },
					moved: { type: 'integer' },
				},
			},
			totals: {
				type: 'object',
				description: 'Per-metric before/after with delta and percent change (vertices, triangles, joints, sizeBytes, ...).',
				additionalProperties: {
					type: 'object',
					properties: {
						a: { type: 'number' },
						b: { type: 'number' },
						delta: { type: 'number' },
						pct: { type: ['number', 'null'] },
					},
				},
			},
			sections: {
				type: 'object',
				description: 'One block per object kind, each with added/removed/renamed/modified lists.',
				properties: {
					nodes: { type: 'object' },
					meshes: { type: 'object' },
					materials: { type: 'object' },
					textures: { type: 'object' },
					animations: { type: 'object' },
					skins: { type: 'object' },
				},
			},
			extensions: { type: 'object', properties: { used: { type: 'object' }, required: { type: 'object' } } },
			asset: { type: 'array', items: { type: 'object' } },
			highlights: {
				type: 'array',
				description: 'Plain-language sentences, worst first.',
				items: {
					type: 'object',
					required: ['severity', 'text'],
					properties: { severity: { type: 'string' }, text: { type: 'string' } },
				},
			},
			ts: { type: 'string', format: 'date-time' },
		},
	},
	example: {
		request: 'GET /api/3d/diff?a=https://three.ws/avatars/cesium-man.glb&b=https://three.ws/avatars/michelle.glb',
		response: {
			version: 1,
			identical: false,
			severity: 'breaking',
			a: { name: 'cesium-man.glb', url: 'https://three.ws/avatars/cesium-man.glb', sizeBytes: 438044 },
			b: { name: 'michelle.glb', url: 'https://three.ws/avatars/michelle.glb', sizeBytes: 849756 },
			summary: { changed: 111, added: 75, removed: 26, modified: 1, renamed: 1, moved: 0 },
			totals: {
				triangles: { a: 4672, b: 28106, delta: 23434, pct: 501.6 },
				joints: { a: 19, b: 65, delta: 46, pct: 242.1 },
				sizeBytes: { a: 438044, b: 849756, delta: 411712, pct: 94 },
			},
			highlights: [
				{ severity: 'breaking', text: 'Skeleton "Armature" was removed. The model is no longer rigged.' },
				{ severity: 'breaking', text: 'Mesh "Cesium_Man" was removed (4,672 triangles gone).' },
				{ severity: 'major', text: 'Triangle count is up 23,434 (+501.6%).' },
			],
			ts: '2026-08-28T00:00:00.000Z',
		},
	},
};
