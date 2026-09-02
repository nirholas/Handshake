// Catalog entry for the free Materialize preparation endpoint: the step between
// "we measured your mesh" and "a machine can run it". Listed beside the quote
// endpoint so an agent that priced a print can also produce the exact files a
// bureau loads, and can show its user what the repair changed.

export default {
	id: 'print-prepare',
	name: 'Repair & Export for Printing (STL, 3MF, GLB)',
	path: '/api/print/prepare',
	methods: ['POST'],
	free: true,
	keyless: true,
	category: '3d',
	order: 41,
	tags: ['3d', 'printing', 'repair', 'stl', '3mf', 'manufacturing', 'materialize'],
	summary:
		'Turn a generated mesh into a watertight solid and export the files a 3D printer takes.',
	description:
		'Welds and re-winds the surface, fills the holes a generator left, closes it into a real ' +
		'solid, scales it to the ordered height, optionally hollows it with drain holes for resin ' +
		'economy, and writes three artifacts to durable storage: a binary STL in millimetres, a 3MF ' +
		'carrying per-vertex colour when the source had a texture (which is what makes a full-colour ' +
		'print possible), and the repaired GLB so the buyer can see exactly what will be printed. ' +
		'Returns the printability report before and after side by side, plus the measured repair ' +
		'metrics. Free and keyless: preparing a file costs CPU, not fulfillment.',
	useCase:
		'An agent holding a generated model produces manufacturing-ready files without a slicer, a ' +
		'desktop tool, or a human, and can show its user precisely which holes were filled and how ' +
		'many triangles changed before anything is ordered.',
	rateLimit: '10 requests/minute per IP',
	input: {
		body: { description: 'JSON. Pass creationId or glbUrl, plus the height and material to prepare for.' },
	},
	inputSchema: {
		$schema: 'https://json-schema.org/draft/2020-12/schema',
		type: 'object',
		properties: {
			creationId: { type: 'string', description: 'A three.ws forge creation id.' },
			glbUrl: { type: 'string', format: 'uri', description: 'Public https URL of a .glb model, instead of a creation id.' },
			materialId: { type: 'string', description: 'Material id from GET /api/print/catalog. Decides the hollowing rules and wall limits.' },
			targetHeightMm: { type: 'number', minimum: 1, maximum: 1000, description: 'Printed height in millimetres.' },
			hollow: { type: 'boolean', description: 'Hollow the solid where it is geometrically safe, adding drain holes.' },
		},
	},
	outputSchema: {
		$schema: 'https://json-schema.org/draft/2020-12/schema',
		type: 'object',
		required: ['assets', 'before', 'after', 'repair'],
		properties: {
			sourceUrl: { type: ['string', 'null'], format: 'uri' },
			creationId: { type: ['string', 'null'] },
			assets: {
				type: 'object',
				required: ['stl', 'threemf', 'glb'],
				properties: {
					stl: { type: 'string', format: 'uri' },
					threemf: { type: 'string', format: 'uri' },
					glb: { type: 'string', format: 'uri' },
					bytes: { type: 'object' },
				},
			},
			before: { type: 'object', description: 'The printability report of the mesh as supplied.' },
			after: { type: 'object', description: 'The printability report of the repaired solid.' },
			repair: {
				type: 'object',
				description: 'What actually changed, all measured.',
				properties: {
					strategy: { type: 'string' },
					holesFilled: { type: 'integer' },
					patchTriangles: { type: 'integer' },
					mergedVertices: { type: 'integer' },
					degenerateRemoved: { type: 'integer' },
					trianglesFlipped: { type: 'integer' },
					trianglesBefore: { type: 'integer' },
					trianglesAfter: { type: 'integer' },
					shells: { type: 'integer' },
					elapsedMs: { type: 'integer' },
				},
			},
			hollow: {
				type: 'object',
				properties: {
					applied: { type: 'boolean' },
					reason: { type: ['string', 'null'] },
					wallMm: { type: ['number', 'null'] },
					drainHoles: { type: 'integer' },
				},
			},
			targetHeightMm: { type: ['number', 'null'] },
			catalogVersion: { type: 'integer' },
		},
	},
	example: {
		request:
			'POST /api/print/prepare {"creationId":"6f1b…","materialId":"resin-standard","targetHeightMm":120,"hollow":true}',
		response: {
			assets: {
				stl: 'https://cdn.three.ws/print/6f1b….stl',
				threemf: 'https://cdn.three.ws/print/6f1b….3mf',
				glb: 'https://cdn.three.ws/print/6f1b….glb',
				bytes: { stl: 233684, threemf: 118220, glb: 402113 },
			},
			before: { version: 1, manifold: false, open_edges: 214, score: 62 },
			after: { version: 1, manifold: true, open_edges: 0, score: 100 },
			repair: { strategy: 'fill_and_close', holesFilled: 7, patchTriangles: 412, trianglesFlipped: 96, shells: 1, elapsedMs: 1840 },
			hollow: { applied: true, reason: null, wallMm: 2, drainHoles: 2 },
			targetHeightMm: 120,
			catalogVersion: 1,
		},
	},
};
