// OKX.AI (X Layer agent marketplace) service catalog — the single source of
// truth for every A2MCP service agent #2632 "three.ws 3D Studio" sells on
// OKX.AI. Endpoints, the free catalog/health service, tests, AND the listing
// update submitted to OKX all read from this module, so the live endpoints can
// never drift from the marketplace listing.
//
// OKX listing format: every service carries a 2-part description — part 1 says
// what the service does, part 2 says what the caller must provide — and each
// part must fit in 200 display-width characters, where East-Asian wide glyphs
// count 2 and everything else counts 1 (OKX rejects over-length listings).
// `validateCatalog()` enforces this; tests/okx-catalog.test.js runs it in CI.
//
// Work order 03 (prompts/okx-ai/03-service-decomposition.md) decomposes the
// rest of the 3D studio into rows of this catalog; work order 06 seeded it
// with the Agent Identity Studio flagship plus the free discovery lane.

const BASE = 'https://three.ws';

// Display width per the OKX listing rule: East-Asian Wide / Fullwidth code
// points count 2, everything else counts 1. Ranges follow Unicode UAX #11
// (W/F categories) closely enough for listing validation: CJK ideographs and
// radicals, Hangul, Kana, fullwidth forms, and the supplementary ideographic
// planes.
export function displayWidth(str) {
	let width = 0;
	for (const ch of String(str ?? '')) {
		const cp = ch.codePointAt(0);
		const wide =
			(cp >= 0x1100 && cp <= 0x115f) || // Hangul Jamo
			(cp >= 0x2e80 && cp <= 0x303e) || // CJK radicals, Kangxi, CJK symbols
			(cp >= 0x3041 && cp <= 0x33ff) || // Kana, CJK compat
			(cp >= 0x3400 && cp <= 0x4dbf) || // CJK ext A
			(cp >= 0x4e00 && cp <= 0x9fff) || // CJK unified
			(cp >= 0xa000 && cp <= 0xa4cf) || // Yi
			(cp >= 0xac00 && cp <= 0xd7a3) || // Hangul syllables
			(cp >= 0xf900 && cp <= 0xfaff) || // CJK compat ideographs
			(cp >= 0xfe30 && cp <= 0xfe4f) || // CJK compat forms
			(cp >= 0xff00 && cp <= 0xff60) || // Fullwidth forms
			(cp >= 0xffe0 && cp <= 0xffe6) || // Fullwidth signs
			(cp >= 0x20000 && cp <= 0x3fffd); // Supplementary ideographic planes
		width += wide ? 2 : 1;
	}
	return width;
}

export const DESCRIPTION_MAX_WIDTH = 200;

// USDC uses 6 decimals on every rail we accept.
function usdToAtomics(usd) {
	return String(Math.round(Number(usd) * 1e6));
}

// One row per marketplace service. Fields:
//   id                  URL slug — the service's route is /api/okx/3d/<id>
//   name                Listing display name
//   kind                'a2mcp' (MCP Streamable HTTP JSON-RPC) | 'rest' (plain JSON GET)
//   describes           2-part OKX listing description { capability, input }
//   priceUsd            Retail price in USD as a string ('0' = free)
//   amountAtomics       x402 amount (USDC 6-decimals atomic string), null = free
//   endpoint            Absolute endpoint URL buyers call
//   tool                For a2mcp services: the paid MCP tool name on that endpoint
//   inputSchema         JSON Schema of the paid call's arguments (free lanes: response shape)
export const OKX_CATALOG = Object.freeze([
	{
		id: 'identity-studio',
		name: 'Agent Identity Studio',
		kind: 'a2mcp',
		describes: {
			capability:
				'Creates a 3D identity for an AI agent from a text brief: a rigged, animation-ready GLB ' +
				'avatar plus posed studio renders — a square PFP sized for the OKX avatar slot and ' +
				'full-body shots.',
			input:
				'Call create_identity with agent_name and a brief (any language); optional style_hints ' +
				'and reference_image_url. Returns a job_id — poll identity_status free until the ' +
				'deliverables are ready.',
		},
		priceUsd: '1.50',
		amountAtomics: usdToAtomics(1.5),
		endpoint: `${BASE}/api/okx/3d/identity-studio`,
		tool: 'create_identity',
		inputSchema: {
			type: 'object',
			required: ['agent_name', 'brief'],
			additionalProperties: false,
			properties: {
				agent_name: {
					type: 'string',
					minLength: 1,
					maxLength: 80,
					description: 'The agent’s display name. Rendered into the identity brief.',
				},
				brief: {
					type: 'string',
					minLength: 3,
					maxLength: 4000,
					description:
						'Personality / brand description in any language. Longer than 2000 characters is ' +
						'truncated (the response flags brief_truncated).',
				},
				style_hints: {
					type: 'string',
					maxLength: 500,
					description: 'Optional visual direction: palette, materials, era, mood.',
				},
				reference_image_url: {
					type: 'string',
					format: 'uri',
					description:
						'Optional public image to guide the look. Validated before any charge — an ' +
						'unreachable URL fails the call without settling payment.',
				},
			},
		},
	},
	// ── Work order 03: the decomposed 3D studio ────────────────────────────
	// Micro-priced REST services, one capability per endpoint, all backed by
	// the same engines /api/mcp-3d runs on (api/_okx3d/rest-services.js maps
	// each id to its engine — no logic duplicated). Prices clear worst-case
	// lane cost; the math is recorded in prompts/okx-ai/PROGRESS.md.
	{
		id: 'text-to-3d',
		name: 'Text to 3D Model (GLB)',
		kind: 'rest',
		describes: {
			capability:
				'Generates a textured, downloadable 3D model (GLB) from a text prompt on the fast draft ' +
				'lane. Returns the finished GLB URL inline or a job to poll for free. Paid only when the ' +
				'job is accepted.',
			input:
				'POST JSON with prompt (3-1000 chars) describing one object or character; optional ' +
				'aspect_ratio. Poll poll_url free until status is done.',
		},
		priceUsd: '0.01',
		amountAtomics: usdToAtomics(0.01),
		endpoint: `${BASE}/api/okx/3d/text-to-3d`,
		tool: null,
		inputSchema: {
			type: 'object',
			required: ['prompt'],
			additionalProperties: false,
			properties: {
				prompt: { type: 'string', minLength: 3, maxLength: 1000 },
				aspect_ratio: { type: 'string', enum: ['1:1', '4:3', '3:4', '16:9', '9:16'] },
			},
		},
	},
	{
		id: 'text-to-3d-pro',
		name: 'Text to 3D Model (Pro)',
		kind: 'rest',
		describes: {
			capability:
				'Art-directed text to 3D: an LLM art director refines the prompt, then a higher-quality ' +
				'lane generates the textured GLB — standard tier by default, high for maximum detail ' +
				'plus PBR textures.',
			input:
				'POST JSON with prompt (3-1000 chars); optional tier standard|high and aspect_ratio. ' +
				'Returns the GLB URL inline or job_id + poll_url; polling is free.',
		},
		priceUsd: '0.30',
		amountAtomics: usdToAtomics(0.3),
		endpoint: `${BASE}/api/okx/3d/text-to-3d-pro`,
		tool: null,
		inputSchema: {
			type: 'object',
			required: ['prompt'],
			additionalProperties: false,
			properties: {
				prompt: { type: 'string', minLength: 3, maxLength: 1000 },
				tier: { type: 'string', enum: ['standard', 'high'] },
				aspect_ratio: { type: 'string', enum: ['1:1', '4:3', '3:4', '16:9', '9:16'] },
			},
		},
	},
	{
		id: 'image-to-3d',
		name: 'Image to 3D Model',
		kind: 'rest',
		describes: {
			capability:
				'Reconstructs a textured 3D model (GLB) from one to four reference photos of a single ' +
				'object. Paid per call; the job is polled for free until done.',
			input:
				'POST JSON with image_urls: 1-4 public https photos of the same object; optional prompt ' +
				'hint. Returns the GLB URL or job_id + poll_url.',
		},
		priceUsd: '0.30',
		amountAtomics: usdToAtomics(0.3),
		endpoint: `${BASE}/api/okx/3d/image-to-3d`,
		tool: null,
		inputSchema: {
			type: 'object',
			required: ['image_urls'],
			additionalProperties: false,
			properties: {
				image_urls: {
					type: 'array',
					items: { type: 'string', format: 'uri' },
					minItems: 1,
					maxItems: 4,
				},
				prompt: { type: 'string', maxLength: 1000 },
			},
		},
	},
	{
		id: 'rig',
		name: 'GLB Auto-Rigging',
		kind: 'rest',
		describes: {
			capability:
				'Rigs a static humanoid GLB model into an animation-ready character: adds a skeleton and ' +
				'skin weights so the model can be posed and animated in any engine.',
			input:
				'Provide: 1. a public link to the static GLB model. Humanoid models rig best. Returns a ' +
				'job you can check for free until the rigged model is ready.',
		},
		priceUsd: '0.25',
		amountAtomics: usdToAtomics(0.25),
		endpoint: `${BASE}/api/okx/3d/rig`,
		tool: null,
		inputSchema: {
			type: 'object',
			required: ['glb_url'],
			additionalProperties: false,
			properties: { glb_url: { type: 'string', format: 'uri' } },
		},
	},
	{
		id: 'avatar',
		name: 'Text to Rigged Avatar',
		kind: 'rest',
		describes: {
			capability:
				'One call from text to an animation-ready character: generates the mesh, then auto-rigs a ' +
				'humanoid skeleton. Non-humanoid prompts are steered to plain mesh generation instead of ' +
				'a wasted rig pass.',
			input:
				'POST JSON with prompt describing a full-body character, or image_url reference; optional ' +
				'allow_non_humanoid. Returns the mesh GLB plus a rig job to poll free.',
		},
		priceUsd: '0.50',
		amountAtomics: usdToAtomics(0.5),
		endpoint: `${BASE}/api/okx/3d/avatar`,
		tool: null,
		inputSchema: {
			type: 'object',
			additionalProperties: false,
			properties: {
				prompt: { type: 'string', maxLength: 1000 },
				image_url: { type: 'string', format: 'uri' },
				allow_non_humanoid: { type: 'boolean' },
			},
		},
	},
	{
		id: 'retarget',
		name: 'Animation Retargeting',
		kind: 'rest',
		describes: {
			capability:
				'Applies a curated animation clip such as idle, walk, or dance onto any rigged humanoid ' +
				'GLB model, keyed to its skeleton, with a bone coverage report. Finishes within the ' +
				'request.',
			input:
				'Provide: 1. a public link to the rigged GLB model 2. the animation name 3. an optional ' +
				'output format and playback speed.',
		},
		priceUsd: '0.10',
		amountAtomics: usdToAtomics(0.1),
		endpoint: `${BASE}/api/okx/3d/retarget`,
		tool: null,
		inputSchema: {
			type: 'object',
			required: ['model_url', 'animation'],
			additionalProperties: false,
			properties: {
				model_url: { type: 'string', format: 'uri' },
				animation: { type: 'string' },
				format: { type: 'string', enum: ['glb', 'clip'] },
				speed: { type: 'number', minimum: 0.25, maximum: 2.5 },
			},
		},
	},
	{
		id: 'pose-seed',
		name: 'Pose Seed',
		kind: 'rest',
		describes: {
			capability:
				'Resolves a natural-language pose description to a deterministic pose seed and a full ' +
				'joint-rotation map for humanoid rigs. The same prompt always returns the same pose. ' +
				'Completes in-request.',
			input:
				'POST JSON with prompt (pose description, 1-500 chars). Returns the seed, per-joint ' +
				'rotations, and a preview link.',
		},
		priceUsd: '0.02',
		amountAtomics: usdToAtomics(0.02),
		endpoint: `${BASE}/api/okx/3d/pose-seed`,
		tool: null,
		inputSchema: {
			type: 'object',
			required: ['prompt'],
			additionalProperties: false,
			properties: { prompt: { type: 'string', minLength: 1, maxLength: 500 } },
		},
	},
	{
		id: 'fbx-export',
		name: 'FBX Export (rig-preserving)',
		kind: 'rest',
		describes: {
			capability:
				'Converts a GLB to FBX for Unity/Unreal — a rigged GLB keeps its skeleton, skin weights, ' +
				'and blendshapes. Also exports obj, stl, ply, usdz, and 3mf. Paid per call; job polling ' +
				'is free.',
			input:
				'POST JSON with model_url (GLB https URL); optional format (default fbx). Returns ' +
				'job_id + poll_url; poll free until done.',
		},
		priceUsd: '0.10',
		amountAtomics: usdToAtomics(0.1),
		endpoint: `${BASE}/api/okx/3d/fbx-export`,
		tool: null,
		inputSchema: {
			type: 'object',
			required: ['model_url'],
			additionalProperties: false,
			properties: {
				model_url: { type: 'string', format: 'uri' },
				format: { type: 'string', enum: ['fbx', 'obj', 'stl', 'ply', 'usdz', '3mf'] },
			},
		},
	},
	{
		id: 'catalog',
		name: '3D Studio Service Catalog',
		kind: 'rest',
		describes: {
			capability:
				'Free machine-readable index of every three.ws 3D Studio service on OKX.AI: names, ' +
				'descriptions, prices, endpoints, and input formats, always in sync with the live ' +
				'services.',
			input: 'Provide nothing. No parameters, no payment, no account required.',
		},
		priceUsd: '0',
		amountAtomics: null,
		endpoint: `${BASE}/api/okx/3d/catalog`,
		tool: null,
		inputSchema: null,
	},
	{
		id: 'health',
		name: '3D Studio Health Status',
		kind: 'rest',
		describes: {
			capability:
				'Free live health status for the systems behind every paid service: generation, rigging, ' +
				'rendering, storage, and the payment rail, from real checks rather than a fixed reply.',
			input: 'Provide nothing. No parameters, no payment, no account required.',
		},
		priceUsd: '0',
		amountAtomics: null,
		endpoint: `${BASE}/api/okx/3d/health`,
		tool: null,
		inputSchema: null,
	},
]);

export function catalogEntry(id) {
	return OKX_CATALOG.find((e) => e.id === id) || null;
}

// The OKX listing description string: part ① and part ② joined on a newline —
// the layout the approved sellers use. Work order 05 submits this verbatim.
export function listingDescription(entry) {
	return `${entry.describes.capability}\n${entry.describes.input}`;
}

// The machine-readable index the free catalog service returns — the exact
// payload OKX buyers (and work order 05's listing update) consume.
export function catalogIndex() {
	return {
		provider: 'three.ws 3D Studio',
		okxAgentId: 2632,
		chain: 'eip155:196',
		services: OKX_CATALOG.map((e) => ({
			id: e.id,
			name: e.name,
			kind: e.kind,
			description: e.describes,
			price_usd: e.priceUsd,
			endpoint: e.endpoint,
			...(e.tool ? { tool: e.tool } : {}),
			...(e.inputSchema ? { input_schema: e.inputSchema } : {}),
		})),
		docs: `${BASE}/docs/okx-marketplace`,
	};
}

// Catalog integrity check — throws on the first malformed entry. Tests call
// this; anything that would get the listing rejected fails CI instead.
export function validateCatalog(catalog = OKX_CATALOG) {
	const seen = new Set();
	for (const e of catalog) {
		const ctx = `okx-catalog entry "${e?.id}"`;
		if (!e.id || !/^[a-z0-9-]+$/.test(e.id)) throw new Error(`${ctx}: bad id`);
		if (seen.has(e.id)) throw new Error(`${ctx}: duplicate id`);
		seen.add(e.id);
		if (!e.name) throw new Error(`${ctx}: missing name`);
		if (!['a2mcp', 'rest'].includes(e.kind)) throw new Error(`${ctx}: bad kind`);
		for (const part of ['capability', 'input']) {
			const text = e.describes?.[part];
			if (!text) throw new Error(`${ctx}: missing describes.${part}`);
			const w = displayWidth(text);
			if (w > DESCRIPTION_MAX_WIDTH) {
				throw new Error(`${ctx}: describes.${part} display width ${w} > ${DESCRIPTION_MAX_WIDTH}`);
			}
		}
		if (!/^\d+(\.\d{1,2})?$/.test(e.priceUsd)) throw new Error(`${ctx}: bad priceUsd`);
		const free = e.priceUsd === '0';
		if (free && e.amountAtomics !== null) throw new Error(`${ctx}: free row must have null atomics`);
		if (!free) {
			if (!/^\d+$/.test(e.amountAtomics ?? '')) throw new Error(`${ctx}: bad amountAtomics`);
			if (String(Math.round(Number(e.priceUsd) * 1e6)) !== e.amountAtomics) {
				throw new Error(`${ctx}: amountAtomics does not equal priceUsd in USDC atomics`);
			}
		}
		if (!/^https:\/\/three\.ws\/api\/okx\/3d\/[a-z0-9-]+$/.test(e.endpoint)) {
			throw new Error(`${ctx}: endpoint must be https://three.ws/api/okx/3d/<id>`);
		}
		if (!e.endpoint.endsWith(`/${e.id}`)) throw new Error(`${ctx}: endpoint/id mismatch`);
		if (e.kind === 'a2mcp' && (!e.tool || !e.inputSchema)) {
			throw new Error(`${ctx}: a2mcp row needs tool + inputSchema`);
		}
		// Paid REST rows must document their POST body — the catalog service and
		// the listing both surface the schema, and buyers have nothing else.
		if (e.kind === 'rest' && !free && !e.inputSchema) {
			throw new Error(`${ctx}: paid rest row needs inputSchema`);
		}
	}
	return true;
}
