// OKX.AI (X Layer agent marketplace) service catalog, the single source of
// truth for every A2MCP service agent #2632 "three.ws 3D Studio" sells on
// OKX.AI. Endpoints, the free catalog/health service, tests, AND the listing
// update submitted to OKX all read from this module, so the live endpoints can
// never drift from the marketplace listing.
//
// OKX listing format: every service carries a 2-part description, part 1 says
// what the service does, part 2 says what the caller must provide, and each
// part must fit in 200 display-width characters, where East-Asian wide glyphs
// count 2 and everything else counts 1 (OKX rejects over-length listings).
// `validateCatalog()` enforces this; tests/okx-catalog.test.js runs it in CI.
//
// The okx-ai campaign's work order 03 (retired; readable in git history)
// decomposes the
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

// Tool names on every A2MCP forge endpoint. They are deliberately identical
// across the paid rows so a buying agent writes one client and points it at
// whichever price/quality row it wants.
export const FORGE_TOOL = 'forge_3d';
export const FORGE_STATUS_TOOL = 'forge_status';

// The paid text lanes take the same arguments; only the endpoint's lane and
// fee differ. Built fresh per row so no two rows share a mutable schema object.
function textForgeSchema() {
	return {
		type: 'object',
		required: ['prompt'],
		additionalProperties: false,
		properties: {
			prompt: { type: 'string', minLength: 3, maxLength: 1000 },
			aspect_ratio: { type: 'string', enum: ['1:1', '4:3', '3:4', '16:9', '9:16'] },
		},
	};
}

function forgeStatusSchema() {
	return {
		type: 'object',
		required: ['job_id'],
		additionalProperties: false,
		properties: {
			job_id: { type: 'string', minLength: 8, maxLength: 1024 },
			title: { type: 'string', maxLength: 200 },
		},
	};
}

// One row per marketplace service. Fields:
//   id                  URL slug, the service's route is /api/okx/3d/<id>
//   name                Listing display name
//   kind                'a2mcp' (MCP Streamable HTTP JSON-RPC) | 'rest' (plain JSON GET)
//   describes           2-part OKX listing description { capability, input }
//   priceUsd            Retail price in USD as a string ('0' = free)
//   amountAtomics       x402 amount (USDC 6-decimals atomic string), null = free
//   endpoint            Absolute endpoint URL buyers call
//   tool                For a2mcp services: the paid MCP tool name on that endpoint
//   inputSchema         JSON Schema of the paid call's arguments (free lanes: response shape)
//   listed              true = on the live OKX.AI listing; false = back burner,
//                       still deployed and routable, absent from the submission
//   lane                For forge rows: which generation lane the endpoint drives
export const OKX_CATALOG = Object.freeze([
	// ── The listed OKX.AI line-up: three.ws Forge ────────────────────────────
	// One capability, sold four ways, plus a free poll. Every listed row is a
	// real A2MCP endpoint (MCP Streamable HTTP, JSON-RPC tools/call) whose paid
	// tool answers an unpaid call with an OKX-dialect 402 that leads with
	// eip155:196, which is the OKX Agent Payments Protocol integration the
	// 2026-07-04 review rejected us for missing.
	//
	// The four paid rows differ ONLY in lane and price: OKX prices a service,
	// not a parameter, so a quality tier has to be its own row to carry its own
	// fee. Buyers keep one client shape: every endpoint exposes the same
	// forge_3d (paid) / forge_status (free) / getting_started (free) tools.
	//
	// What a buyer gets back is byte-for-byte what the "three.ws 3D Studio"
	// custom GPT gets from /api/3d/studio: the GLB, the concept image, a browser
	// viewer link and a device-aware AR link, and nothing else. Both fronts
	// shape their responses through api/_mcp-studio/studio-shape.js, so the
	// marketplace and the GPT cannot drift apart.
	{
		id: 'forge-draft',
		name: 'Forge 3D Draft',
		kind: 'a2mcp',
		listed: true,
		lane: { tier: 'draft', path: 'image', mode: 'text_to_3d' },
		describes: {
			capability:
				'Turns a text description of one object or character into a downloadable textured 3D ' +
				'model in GLB format, with a browser preview link and an augmented-reality link that ' +
				'places it in a real room.',
			input:
				'Provide a text description of a single subject, 3 to 1000 characters, naming its style ' +
				'and main colours. An aspect ratio is optional. Returns a job id to poll on the free ' +
				'status service.',
		},
		priceUsd: '0.01',
		amountAtomics: usdToAtomics(0.01),
		endpoint: `${BASE}/api/okx/3d/forge-draft`,
		tool: FORGE_TOOL,
		inputSchema: textForgeSchema(),
	},
	{
		id: 'forge-standard',
		name: 'Forge 3D Standard',
		kind: 'a2mcp',
		listed: true,
		lane: { tier: 'standard', mode: 'text_to_3d' },
		describes: {
			capability:
				'Turns a text description of one object or character into a downloadable textured 3D ' +
				'model in GLB format on the standard quality pass, with a browser preview link and an ' +
				'augmented-reality link.',
			input:
				'Provide a text description of a single subject, 3 to 1000 characters, naming its style ' +
				'and main colours. An aspect ratio is optional. Returns a job id to poll on the free ' +
				'status service.',
		},
		priceUsd: '0.05',
		amountAtomics: usdToAtomics(0.05),
		endpoint: `${BASE}/api/okx/3d/forge-standard`,
		tool: FORGE_TOOL,
		inputSchema: textForgeSchema(),
	},
	{
		id: 'forge-hd',
		name: 'Forge 3D HD',
		kind: 'a2mcp',
		listed: true,
		lane: { tier: 'high', mode: 'text_to_3d' },
		describes: {
			capability:
				'Turns a text description of one object or character into a downloadable textured 3D ' +
				'model in GLB format on the highest detail pass, with a browser preview link and an ' +
				'augmented-reality link.',
			input:
				'Provide a text description of a single subject, 3 to 1000 characters, naming its style ' +
				'and main colours. An aspect ratio is optional. This pass runs longer, so keep polling ' +
				'the free status service.',
		},
		priceUsd: '0.25',
		amountAtomics: usdToAtomics(0.25),
		endpoint: `${BASE}/api/okx/3d/forge-hd`,
		tool: FORGE_TOOL,
		inputSchema: textForgeSchema(),
	},
	{
		id: 'forge-image',
		name: 'Forge 3D from Image',
		kind: 'a2mcp',
		listed: true,
		lane: { mode: 'image_to_3d' },
		describes: {
			capability:
				'Rebuilds a downloadable textured 3D model in GLB format from photographs or rendered ' +
				'views of one object, with a browser preview link and an augmented-reality link that ' +
				'places it in a real room.',
			input:
				'Provide one to four publicly reachable image links showing the same subject. A short ' +
				'text description is optional and sharpens the result. Returns a job id to poll on the ' +
				'free status service.',
		},
		priceUsd: '0.25',
		amountAtomics: usdToAtomics(0.25),
		endpoint: `${BASE}/api/okx/3d/forge-image`,
		tool: FORGE_TOOL,
		inputSchema: {
			type: 'object',
			required: ['image_urls'],
			additionalProperties: false,
			properties: {
				image_urls: {
					type: 'array',
					minItems: 1,
					maxItems: 4,
					items: { type: 'string', format: 'uri', pattern: '^https://' },
				},
				prompt: { type: 'string', minLength: 3, maxLength: 1000 },
			},
		},
	},
	{
		id: 'forge-status',
		name: 'Forge Job Status',
		kind: 'a2mcp',
		listed: true,
		lane: { mode: 'status' },
		describes: {
			capability:
				'Reports the live state of any three.ws forge generation job and returns the finished ' +
				'model file, concept image, browser preview link and augmented-reality link once the ' +
				'job completes. Always free.',
			input:
				'Provide the job id returned when a generation was accepted. Optionally provide the ' +
				'original description so the preview pages carry a title. No payment, account, or key ' +
				'is required to call it.',
		},
		priceUsd: '0',
		amountAtomics: null,
		endpoint: `${BASE}/api/okx/3d/forge-status`,
		tool: FORGE_STATUS_TOOL,
		inputSchema: forgeStatusSchema(),
	},

	// ── Back burner (owner directive 2026-08-22) ─────────────────────────────
	// Everything below stays deployed, tested and individually routable, and is
	// NOT part of the OKX.AI listing: `listed: false` keeps it out of
	// catalogIndex() and out of scripts/okx-listing-payload.mjs. The listing was
	// rebuilt around the forge because a focused line-up is what sells and what
	// passes review on this marketplace; these specialist services return to the
	// listing when the forge rows have real sales behind them.
	{
		id: 'identity-studio',
		listed: false,
		name: 'Agent Identity Studio',
		kind: 'a2mcp',
		describes: {
			capability:
				'Creates a complete 3D identity for an AI agent from a text brief: a rigged, ' +
				'animation-ready GLB avatar plus posed studio renders, including a square profile ' +
				'picture and full-body shots.',
			input:
				'Provide: 1. the agent name 2. a brand or personality brief in any language 3. optional ' +
				'style hints 4. an optional reference image. Example: name LedgerLynx, brief: a calm ' +
				'on-chain accounting agent.',
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
						'Optional public image to guide the look. Validated before any charge, an ' +
						'unreachable URL fails the call without settling payment.',
				},
			},
		},
	},
	// ── Work order 03: the decomposed 3D studio ────────────────────────────
	// Micro-priced REST services, one capability per endpoint, all backed by
	// the same engines /api/mcp-3d runs on (api/_okx3d/rest-services.js maps
	// each id to its engine, no logic duplicated). Prices clear worst-case
	// lane cost; the math is recorded in prompts/finish/okx-ai-PROGRESS.md.
	{
		id: 'text-to-3d',
		listed: false,
		name: 'Text to 3D Model (GLB)',
		kind: 'rest',
		describes: {
			capability:
				'Generates a textured, downloadable 3D model in GLB format from a text description on ' +
				'the fast draft lane. Suited to quick props, objects, and concept assets. You pay only ' +
				'when the job is accepted.',
			input:
				'Provide: 1. a text description of one object or character, 3 to 1000 characters ' +
				'2. an optional aspect ratio. Example: a brass steampunk owl, full body. Returns the ' +
				'model link or a free-to-check job.',
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
		listed: false,
		name: 'Text to 3D Model (Pro)',
		kind: 'rest',
		describes: {
			capability:
				'Art-directed text to 3D: refines your description, then generates a higher-quality ' +
				'textured GLB model. Standard tier by default; the high tier adds maximum detail and ' +
				'PBR materials.',
			input:
				'Provide: 1. a text description 2. an optional quality tier, standard or high 3. an ' +
				'optional aspect ratio. Example: an ornate elven longsword, tier high. Returns the ' +
				'model link or a free-to-check job.',
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
		listed: false,
		name: 'Image to 3D Model',
		kind: 'rest',
		describes: {
			capability:
				'Reconstructs a textured 3D model in GLB format from photos of a single object, turning ' +
				'product shots or concept art into usable 3D assets.',
			input:
				'Provide: 1. one to four public photo links of the same object 2. an optional text ' +
				'hint. Example: front and side photos of one sneaker. Returns the model link or a ' +
				'free-to-check job.',
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
		listed: false,
		name: 'GLB Auto-Rigging',
		kind: 'rest',
		describes: {
			capability:
				'Rigs a static humanoid GLB model into an animation-ready character: adds a skeleton and ' +
				'skin weights so the model can be posed and animated in any engine.',
			input:
				'Provide: 1. a public link to the static GLB model. Humanoid models rig best. Example: ' +
				'a knight character model. Returns a job you can check for free until the rigged model ' +
				'is ready.',
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
		listed: false,
		name: 'Text to Rigged Avatar',
		kind: 'rest',
		describes: {
			capability:
				'One call from text to an animation-ready character: generates the 3D mesh, then rigs a ' +
				'humanoid skeleton. Non-humanoid subjects fall back to plain mesh generation so no ' +
				'rigging pass is wasted.',
			input:
				'Provide: 1. a text description of a full-body character, or a reference image link ' +
				'2. optionally allow non-humanoid subjects. Example: a heroic knight in silver armor, ' +
				'full body.',
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
		listed: false,
		name: 'Animation Retargeting',
		kind: 'rest',
		describes: {
			capability:
				'Applies a curated animation clip such as idle, walk, or dance onto any rigged humanoid ' +
				'GLB model, keyed to its skeleton, with a bone coverage report. Finishes within the ' +
				'request.',
			input:
				'Provide: 1. a public link to the rigged GLB model 2. the animation name 3. an optional ' +
				'output format and playback speed. Example: your knight model plus the walk animation.',
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
		listed: false,
		name: 'Pose Seed',
		kind: 'rest',
		describes: {
			capability:
				'Turns a text pose description into a deterministic pose seed and a full joint rotation ' +
				'map for humanoid rigs. The same description always returns the same pose. Finishes ' +
				'within the request.',
			input:
				'Provide: 1. a pose description, 1 to 500 characters. Example: confident standing ' +
				'pose, arms crossed. Returns the seed, per-joint rotations, and a preview link.',
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
		listed: false,
		name: 'FBX Export (rig-preserving)',
		kind: 'rest',
		describes: {
			capability:
				'Converts a GLB model to FBX for Unity or Unreal. A rigged model keeps its skeleton, ' +
				'skin weights, and blendshapes. Also exports OBJ, STL, PLY, USDZ, and 3MF formats.',
			input:
				'Provide: 1. a public link to the GLB model 2. an optional target format, FBX by ' +
				'default; OBJ, STL, PLY, USDZ, and 3MF also work. Example: your rigged knight model ' +
				'to FBX for Unity.',
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
		listed: true,
		name: '3D Studio Service Catalog',
		kind: 'rest',
		describes: {
			capability:
				'Free machine-readable index of every three.ws 3D Studio service sold here: names, ' +
				'descriptions, prices, endpoints, and input formats, always in sync with the live ' +
				'services.',
			input:
				'Provide nothing. No parameters, no payment, and no account are required. Returns the ' +
				'full service list with names, prices, endpoints, and the exact input each one expects.',
		},
		priceUsd: '0',
		amountAtomics: null,
		endpoint: `${BASE}/api/okx/3d/catalog`,
		tool: null,
		inputSchema: null,
	},
	{
		id: 'health',
		listed: true,
		name: '3D Studio Health Status',
		kind: 'rest',
		describes: {
			capability:
				'Free live health status for the systems behind every paid service: generation, rigging, ' +
				'rendering, storage, and the payment rail, from real checks rather than a fixed reply.',
			input:
				'Provide nothing. No parameters, no payment, and no account are required. Returns a ' +
				'per-system reading so a buyer can confirm everything is up before paying for a job.',
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

// The OKX listing description string: part ① and part ② joined on a newline,
// the layout the approved sellers use. Work order 05 submits this verbatim.
export function listingDescription(entry) {
	return `${entry.describes.capability}\n${entry.describes.input}`;
}

// The machine-readable index the free catalog service returns, the exact
// payload OKX buyers (and the listing update in scripts/okx-listing-payload.mjs)
// consume.
//
// `services` is the live OKX.AI line-up. `unlisted` is the back burner: still
// deployed, still payable, deliberately absent from the marketplace listing. It
// is published rather than hidden because those endpoints answer real 402s to
// anyone who calls them, and a catalog that pretended otherwise would be lying
// to the buyer holding the URL.
function publicRow(e) {
	return {
		id: e.id,
		name: e.name,
		kind: e.kind,
		description: e.describes,
		price_usd: e.priceUsd,
		endpoint: e.endpoint,
		...(e.tool ? { tool: e.tool } : {}),
		...(e.inputSchema ? { input_schema: e.inputSchema } : {}),
	};
}

export function listedCatalog(catalog = OKX_CATALOG) {
	return catalog.filter((e) => e.listed);
}

export function catalogIndex() {
	return {
		provider: 'three.ws 3D Studio',
		okxAgentId: 2632,
		chain: 'eip155:196',
		services: listedCatalog().map(publicRow),
		unlisted: OKX_CATALOG.filter((e) => !e.listed).map(publicRow),
		docs: `${BASE}/docs/okx-marketplace`,
	};
}

// Catalog integrity check, throws on the first malformed entry. Tests call
// this; anything that would get the listing rejected fails CI instead.
export function validateCatalog(catalog = OKX_CATALOG) {
	const seen = new Set();
	for (const e of catalog) {
		const ctx = `okx-catalog entry "${e?.id}"`;
		if (!e.id || !/^[a-z0-9-]+$/.test(e.id)) throw new Error(`${ctx}: bad id`);
		if (seen.has(e.id)) throw new Error(`${ctx}: duplicate id`);
		seen.add(e.id);
		if (!e.name) throw new Error(`${ctx}: missing name`);
		// OKX caps a service name at 30 display columns (5 minimum); an over-long
		// name is rejected at submission, not at review, so catch it in CI.
		if (e.listed) {
			const nw = displayWidth(e.name);
			if (nw < 5 || nw > 30) throw new Error(`${ctx}: listed name display width ${nw} outside 5..30`);
		}
		if (typeof e.listed !== 'boolean') throw new Error(`${ctx}: listed must be a boolean`);
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
		// Paid REST rows must document their POST body, the catalog service and
		// the listing both surface the schema, and buyers have nothing else.
		if (e.kind === 'rest' && !free && !e.inputSchema) {
			throw new Error(`${ctx}: paid rest row needs inputSchema`);
		}
	}
	if (!catalog.some((e) => e.listed)) throw new Error('okx-catalog: no listed services, the submission would be empty');
	return true;
}
