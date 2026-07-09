// Service-catalog descriptor — the single written-once listing for this
// service. api/wk.js derives its /.well-known/x402.json resource entry from
// this file via api/_lib/service-catalog/index.js (toBazaarDiscovery), and
// the OKX storefront projection reads the same record (toOkxCatalog).
// Contract: specs/service-catalog.md. Do not re-add a hand-written mirror
// for this route in api/wk.js — edit this descriptor instead.

export default {
	slug: 'remix-asset',
	title: 'Remix a 3D asset (with creator royalties)',
	category: '3d',
	useCase: 'Remix a published 3D model by describing a change; a creator-set royalty of the fee routes on-chain to the original creator.',
	path: '/api/x402/remix-asset',
	method: 'POST',
	free: false,
	status: 'live',
	priceAtomics: '250000',
	acceptsBuilder: 'standard',
	serviceName: 'Remix a 3D asset + royalties',
	tags: ['3d', 'remix', 'royalties', 'generation', 'glb'],
	description:
		'Remix a published, remixable 3D model: pay a fixed fee in USDC and describe the change in words ' +
		'("make it metallic", "add wings"). The platform generates a NEW model anchored to the source, records ' +
		'durable parent→child provenance, and routes a creator-set royalty (≤20% of the fee, the remixer always ' +
		'keeps the majority) on-chain to the original creator. Browse remixable assets and their royalty terms for ' +
		'free at GET /api/remix-feed; publish your own finished models there to earn royalties when others build on them.',
	input: {
		source_creation_id: '00000000-0000-0000-0000-000000000000',
		instruction: 'make it metallic',
	},
	inputSchema: {
		type: 'object',
		required: ['source_creation_id', 'instruction'],
		properties: {
			source_creation_id: {
				type: 'string',
				minLength: 1,
				maxLength: 64,
				description: 'The id of a remixable creation (from GET /api/remix-feed).',
			},
			instruction: {
				type: 'string',
				minLength: 1,
				maxLength: 500,
				description: 'The change to make, in plain language: "make it metallic", "bigger helmet", "add a cape".',
			},
		},
	},
	// Mirrors the settled 200 in api/x402/remix-asset.js — the new remix, its
	// source lineage, and the honest royalty split (paid or not).
	outputExample: {
		ok: true,
		remix: {
			glbUrl: 'https://cdn.three.ws/forge/example-remix/model.glb',
			viewerUrl: 'https://three.ws/viewer?src=https%3A%2F%2Fcdn.three.ws%2Fforge%2Fexample-remix%2Fmodel.glb',
			creationId: '11111111-2222-4333-8444-555555555555',
			prompt: 'a low-poly fox, but make it metallic',
			instruction: 'make it metallic',
			anchored: true,
		},
		source: {
			id: '00000000-0000-0000-0000-000000000000',
			prompt: 'a low-poly fox',
			royaltyBps: 1000,
			royaltyPercent: 10,
		},
		royalty: {
			paid: true,
			royaltyBps: 1000,
			capped: false,
			creatorUsd: 0.025,
			platformUsd: 0.225,
			creatorAtomics: '25000',
			creatorTx: '5synthetictransactionsignature1111111111111111111111111111111111111111111111111111111',
		},
	},
	storefronts: ['x402scan'],
};
