// Service-catalog descriptor — the single written-once listing for this
// service. api/wk.js derives its /.well-known/x402.json resource entry from
// this file via api/_lib/service-catalog/index.js (toBazaarDiscovery), and
// the OKX storefront projection reads the same record (toOkxCatalog).
// Contract: specs/service-catalog.md. Do not re-add a hand-written mirror
// for this route in api/wk.js — edit this descriptor instead.
//
// Pricing is per-stage and dynamic: the live 402 quotes the EXACT sum of the
// requested stages (api/_lib/pipeline.js priceForChain). The catalog
// advertises the example chain's price — generate (draft, $0.05) + rig
// ($0.10) = $0.15 — so facilitators can index the route; per-stage prices are
// env-overridable via X402_PRICE_PIPELINE_STAGE_*.

export default {
	slug: 'pipeline',
	title: '3D Asset Pipeline',
	category: '3d',
	useCase:
		'One call, full 3D asset pipeline — text or GLB in, rigged/optimized game-ready GLB out; the only asset pipeline in the x402 ecosystem.',
	path: '/api/x402/pipeline',
	method: 'POST',
	free: false,
	status: 'live',
	priceAtomics: '150000',
	acceptsBuilder: 'standard',
	serviceName: 'three.ws 3D Asset Pipeline',
	tags: ['3d', 'pipeline', 'rig', 'gameready', 'glb'],
	description:
		'One call, full 3D asset pipeline — text or GLB in, rigged/optimized ' +
		'game-ready GLB out; the only asset pipeline in the x402 ecosystem. Submit an ' +
		'ordered chain of stages (generate → rig → remesh → gameready → stylize) and ' +
		'get back a job token you poll for FREE at GET /api/forge?job=<id>, watching ' +
		'per-stage progress until the final GLB is delivered. Priced per stage and ' +
		'quoted EXACTLY in the 402 challenge (the sum of the requested stages). Pay ' +
		'autonomously in USDC on Solana mainnet — no API key, no account.',
	input: {
		stages: ['generate', 'rig'],
		prompt: 'a brass steampunk owl, full body',
		options: { tier: 'draft', rig: { rig_type: 'biped' } },
	},
	inputSchema: {
		type: 'object',
		required: ['stages'],
		properties: {
			stages: {
				type: 'array',
				minItems: 1,
				maxItems: 5,
				items: { type: 'string', enum: ['generate', 'rig', 'remesh', 'gameready', 'stylize'] },
				description:
					'Ordered subsequence of ["generate","rig","remesh","gameready","stylize"]. ' +
					'generate must be first and requires prompt; without generate, glb_url is required.',
			},
			prompt: {
				type: 'string',
				minLength: 3,
				maxLength: 1000,
				description: 'Subject for the generate stage. Required when stages starts with generate.',
			},
			glb_url: {
				type: 'string',
				format: 'uri',
				description:
					'Public https GLB to feed the first stage when the chain does not start with generate.',
			},
			options: {
				type: 'object',
				description:
					'Per-stage options: { tier, aspect_ratio, rig:{rig_type}, remesh:{...}, gameready:{topology,poly_budget,texture_size}, stylize:{style,resolution} }.',
			},
		},
	},
	outputExample: {
		job_id: 'f1.eyJwIjoicGlwZWxpbmUifQ.sig',
		status: 'running',
		poll_url: '/api/forge?job=f1.eyJwIjoicGlwZWxpbmUifQ.sig',
		price_usdc: '0.15',
		stages: [
			{ id: 'generate', status: 'done', output_url: 'https://three.ws/cdn/forge/example/model.glb' },
			{ id: 'rig', status: 'running', output_url: null },
		],
	},
	storefronts: ['x402scan'],
};
