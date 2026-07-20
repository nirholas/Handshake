// Service-catalog descriptor — the single written-once listing for this
// service. api/wk.js derives its /.well-known/x402.json resource entry from
// this file via api/_lib/service-catalog/index.js (toBazaarDiscovery), and
// the OKX storefront projection reads the same record (toOkxCatalog).
// Contract: specs/service-catalog.md. Do not re-add a hand-written mirror
// for this route in api/wk.js — edit this descriptor instead.

export default {
	slug: 'pipeline-rig',
	title: 'Pipeline - Rig',
	category: '3d',
	useCase: '3D Asset Pipeline — Rig: pay $0.05 USDC to make a static GLB animation-ready.',
	path: '/api/x402/pipeline-rig',
	method: 'POST',
	free: false,
	status: 'live',
	priceAtomics: '50000',
	acceptsBuilder: 'standard',
	serviceName: 'three.ws Pipeline - Rig',
	tags: ['3d', 'rigging', 'skeleton', 'glb', 'pipeline'],
	description: '3D Asset Pipeline — Rig: pay $0.05 USDC to make a static GLB animation-ready. A humanoid skeleton is inferred and bound to the mesh with skin weights so the model can walk, wave, and emote. POST a public glb_url; get back a durable first-party rigged GLB URL. No other x402 resource rigs a mesh.',
	input: {
		glb_url: 'https://three.ws/avatars/mannequin.glb',
		rig_type: 'biped',
	},
	inputSchema: {
		type: 'object',
		required: ['glb_url'],
		properties: {
			glb_url: {
				type: 'string',
				format: 'uri',
				description: 'Public HTTPS URL of the static .glb mesh to rig.',
			},
			rig_type: {
				type: 'string',
				enum: ['biped', 'quadruped'],
				default: 'biped',
			},
		},
	},
	storefronts: ['x402scan'],
};
