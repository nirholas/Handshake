// Catalog entry for the free Materialize printability + quote endpoint. The
// /api/3d index globs api/_lib/3d-catalog/*.js and merges every default export
// into the public API catalog and the generated OpenAPI doc, so an agent that
// found the free 3D API also finds the lane that turns a model into an object.
//
// The endpoint is one call with two modes on purpose: without a material it is
// a pure printability analysis (free, keyless, no price), and with one it also
// prices the print and returns a signed quote token. Advertising it as a single
// entry keeps the catalog honest about the one round trip an agent makes.

export default {
	id: 'print-quote',
	name: 'Printability Report & Print Quote',
	path: '/api/print/quote',
	methods: ['POST'],
	free: true,
	keyless: true,
	category: '3d',
	order: 40,
	tags: ['3d', 'printing', 'manufacturing', 'physical', 'quote', 'materialize'],
	summary:
		'Measure whether a 3D model can be physically printed, and price the print in USDC.',
	description:
		'Analyzes a GLB for real-world manufacturing and, when a material is given, prices it. ' +
		'The report covers whether the mesh is a closed solid, how many separate bodies it contains, ' +
		'its open and non-manifold edges, self-intersections, exact enclosed volume, thinnest wall, ' +
		'and a 0-100 printability score with named deductions, plus the smallest height each material ' +
		'class can hold that detail at. With a materialId it returns an itemized quote (build setup, ' +
		'material with the cm3 it was computed from, finish, quantity break, shipping) and an ' +
		'HMAC-signed quote token valid for 24 hours. Free and keyless in both modes; nothing is ' +
		'ordered and no money moves. Settle the token at POST /api/x402/print-order to have the ' +
		'object manufactured and shipped.',
	useCase:
		'An agent that just generated a 3D model checks whether the thing can exist physically, at ' +
		'what size, in what material, and for how much, before committing its owner to a purchase. ' +
		'The same call is what the /materialize page asks on every material and size change.',
	rateLimit: '30 requests/minute per IP',
	input: {
		body: {
			description:
				'JSON. Pass creationId or glbUrl. Omit materialId for a free analysis with no price.',
		},
	},
	inputSchema: {
		$schema: 'https://json-schema.org/draft/2020-12/schema',
		type: 'object',
		properties: {
			creationId: { type: 'string', description: 'A three.ws forge creation id.' },
			glbUrl: { type: 'string', format: 'uri', description: 'Public https URL of a .glb model, instead of a creation id. Max 100 MB, 2M triangles.' },
			materialId: { type: 'string', description: 'Material id from GET /api/print/catalog. Omit for analysis only.' },
			finishId: { type: 'string', description: 'Optional finish id from that material.' },
			targetHeightMm: { type: 'number', minimum: 1, maximum: 1000, description: 'Printed height in millimetres.' },
			quantity: { type: 'integer', minimum: 1, maximum: 500, default: 1, description: 'How many. Price breaks at 5 and 20.' },
			country: { type: 'string', minLength: 2, maxLength: 2, description: 'ISO 3166-1 alpha-2 destination, for shipping.' },
			hollow: { type: 'boolean', description: 'Hollow the solid where it is geometrically safe. Lowers the price.' },
			note: { type: 'string', maxLength: 500, description: 'Optional note about the intended object. Read by the fabrication safety gate.' },
		},
	},
	outputSchema: {
		$schema: 'https://json-schema.org/draft/2020-12/schema',
		type: 'object',
		required: ['report', 'fits'],
		properties: {
			report: {
				type: 'object',
				required: ['version', 'manifold', 'volume_cm3', 'bbox_mm', 'score', 'deductions'],
				properties: {
					version: { type: 'integer' },
					manifold: { type: 'boolean' },
					watertight: { type: 'boolean' },
					shells: { type: 'integer' },
					open_edges: { type: 'integer' },
					non_manifold_edges: { type: 'integer' },
					self_intersections: { type: 'integer' },
					triangles: { type: 'integer' },
					volume_cm3: { type: 'number' },
					volume_source: { type: 'string', enum: ['manifold', 'signed_sum'] },
					surface_area_cm2: { type: 'number' },
					min_wall_mm: { type: ['number', 'null'] },
					bbox_mm: {
						type: 'object',
						properties: { x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' }, diagonal: { type: 'number' } },
					},
					recommended_min_height_mm: { type: ['object', 'null'] },
					score: { type: 'integer', minimum: 0, maximum: 100 },
					deductions: {
						type: 'array',
						items: {
							type: 'object',
							required: ['id', 'points', 'detail'],
							properties: { id: { type: 'string' }, points: { type: 'number' }, detail: { type: 'string' } },
						},
					},
				},
			},
			fits: { type: 'array', description: 'Per material: the height band this mesh can be printed at, or why it cannot.' },
			screening: {
				type: 'object',
				description: 'The fabrication gate verdict. A refused request answers 451 instead.',
				properties: { verdict: { type: 'string' }, stage: { type: 'string' }, policy_url: { type: 'string' } },
			},
			quote: { type: ['object', 'null'], description: 'Itemized price. Null when no material was given or the mesh was rejected.' },
			rejection: { type: ['object', 'null'], description: 'Why this material cannot take this mesh, with the measured number, the required number and the fix.' },
			token: { type: ['string', 'null'], description: 'Signed quote token, valid 24 hours. Null for a quote-on-request material.' },
			expiresInSeconds: { type: ['integer', 'null'] },
		},
	},
	example: {
		request:
			'POST /api/print/quote {"creationId":"6f1b…","materialId":"resin-standard","targetHeightMm":120,"quantity":1,"country":"US"}',
		response: {
			report: {
				version: 1,
				manifold: true,
				shells: 1,
				open_edges: 0,
				triangles: 4672,
				volume_cm3: 27.144,
				volume_source: 'manifold',
				min_wall_mm: 2.4,
				bbox_mm: { x: 41, y: 120, z: 38, diagonal: 133 },
				score: 100,
				deductions: [],
			},
			screening: { verdict: 'allow', stage: 'quote', policy_url: '/docs/materialize#content-policy' },
			quote: {
				currency: 'USDC',
				chain: 'solana',
				lines: [
					{ id: 'setup', label: 'Build setup, Standard resin', amount: 6 },
					{ id: 'material', label: 'Standard resin', detail: '27.144 cm3 at 0.55 USDC per cm3.', amount: 14.93 },
					{ id: 'shipping', label: 'Shipping to United States and Canada', amount: 12.94 },
				],
				total: 33.87,
				leadTimeDays: 12,
			},
			token: 'pq1.eyJ2IjoxLC…',
			expiresInSeconds: 86400,
		},
	},
};
