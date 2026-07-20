// Service-catalog descriptor — the single written-once listing for this
// service. api/wk.js derives its /.well-known/x402.json resource entry from
// this file via api/_lib/service-catalog/index.js (toBazaarDiscovery), and
// the OKX storefront projection reads the same record (toOkxCatalog).
// Contract: specs/service-catalog.md. Do not re-add a hand-written mirror
// for this route in api/wk.js — edit this descriptor instead.

export default {
	slug: 'pipeline-remesh',
	title: 'Pipeline - Remesh',
	category: '3d',
	useCase: '3D Asset Pipeline — Remesh: pay $0.03 USDC to retopologize a GLB.',
	path: '/api/x402/pipeline-remesh',
	method: 'POST',
	free: false,
	status: 'live',
	priceAtomics: '30000',
	acceptsBuilder: 'standard',
	serviceName: 'three.ws Pipeline - Remesh',
	tags: ['3d', 'remesh', 'retopology', 'glb', 'pipeline'],
	description: '3D Asset Pipeline — Remesh: pay $0.03 USDC to retopologize a GLB. Triangle, quad, or low-poly remeshing plus repair and decimation to a target face count, with the texture re-baked onto the new topology. POST a public glb_url and options; get back a durable first-party GLB URL.',
	input: {
		glb_url: 'https://three.ws/avatars/mannequin.glb',
		remesh_mode: 'quad',
		target_faces: 20000,
	},
	inputSchema: {
		type: 'object',
		required: ['glb_url'],
		properties: {
			glb_url: {
				type: 'string',
				format: 'uri',
				description: 'Public HTTPS URL of the source .glb mesh.',
			},
			remesh_mode: {
				type: 'string',
				enum: ['triangle', 'quad', 'lowpoly'],
				default: 'triangle',
			},
			operation: {
				type: 'string',
				enum: ['full', 'simplify', 'repair', 'convert'],
				default: 'full',
			},
			target_faces: {
				type: 'integer',
				minimum: 1000,
				maximum: 500000,
				default: 50000,
			},
			texture_size: {
				type: 'integer',
				enum: [512, 1024, 2048],
				default: 1024,
			},
		},
	},
	storefronts: ['x402scan'],
};
