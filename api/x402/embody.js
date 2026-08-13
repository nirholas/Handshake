// POST /api/x402/embody
//
// Give your agent a 3D body — one paid x402 call returns a rigged, animated,
// talking avatar plus a one-tag embed for any website. The only embodiment
// endpoint in the x402 ecosystem. $1 USDC, no account.
//
// An external agent on any framework pays $1 USDC and gets an embeddable,
// animated, voiced presence: a text prompt (or a reference image) plus a name in;
// a rigged GLB, a durable persona that reloads by id in any future session, a
// voice, and a copy-paste <iframe> embed out.
//
// Contract
//   POST { name, prompt?, image_url?, personality?, voice? }
//     name        required, ≤64 chars
//     prompt      text description of the body (exactly one of prompt|image_url)
//     image_url   reference image URL             (exactly one of prompt|image_url)
//     personality optional flavor text stored on the persona (≤600 chars)
//     voice       optional TTS voice id (see /api/tts/voices); defaults to 'nova'
//   → 200 {
//       agent_id, glb_url, viewer_url, profile_url, embed_html, reload_url,
//       voice, rigged, name
//     }
//
// Design note: this is SYNCHRONOUS and settles on delivery, not a submit-then-poll
// job. The buyer is only charged when a finished body is returned — a failed or
// timed-out generation never settles (payment is verified but not captured). This
// is the more consumer-fair reading of the prompt's job-based sketch: no orphaned
// paid jobs, and the returned bundle is complete on the single call. The heavy
// lifting reuses the SAME free NVIDIA TRELLIS generate → auto-rig chain the 3D
// Studio uses (api/_mcp-studio/forge-client.js) and the durable persona store
// behind the embodiment embed (api/_lib/persona-store.js) — no new pipeline.
//
// Price: priceFor('embody', '1000000') = $1.00 USDC. Solana + Base.

import { paidEndpoint } from '../_lib/x402-paid-endpoint.js';
import { readBody as readRawBody } from '../_lib/http.js';
import { buildBazaarSchema } from '../_lib/x402-spec.js';
import { withService } from '../_lib/x402/bazaar-helpers.js';
import { priceFor } from '../_lib/x402-prices.js';
import { originFromReq, generate, rig, viewerUrl } from '../_mcp-studio/forge-client.js';
import { createPersona } from '../_lib/persona-store.js';
import { buildEmbedUrl } from '../_lib/embodiment-artifact.js';
import { TTS_VOICE_IDS, DEFAULT_VOICE } from '../_lib/tts-voices.js';

const ROUTE = '/api/x402/embody';

const NAME_MAX = 64;
const PROMPT_MAX = 600;
const PERSONALITY_MAX = 600;

const DESCRIPTION =
	'Give your agent a 3D body — one x402 call returns a rigged, animated, talking ' +
	'avatar plus a one-tag embed for any website. The only embodiment endpoint in the ' +
	'x402 ecosystem. POST { name, prompt | image_url, personality?, voice? } and get back ' +
	'{ agent_id, glb_url, viewer_url, profile_url, embed_html, voice }. The body is a ' +
	'durable persona that reloads by id in any future session. $1 USDC, no account. ' +
	'Generation failures never settle — you are only charged when a finished body is returned.';

const INPUT_SCHEMA = {
	$schema: 'https://json-schema.org/draft/2020-12/schema',
	type: 'object',
	required: ['name'],
	oneOf: [{ required: ['prompt'] }, { required: ['image_url'] }],
	properties: {
		name: { type: 'string', minLength: 1, maxLength: NAME_MAX, description: 'Display name for the agent body.' },
		prompt: { type: 'string', minLength: 1, maxLength: PROMPT_MAX, description: 'Text description of the avatar to generate.' },
		image_url: { type: 'string', format: 'uri', description: 'Reference image URL to reconstruct into 3D.' },
		personality: { type: 'string', maxLength: PERSONALITY_MAX, description: 'Optional flavor text stored on the persona.' },
		voice: { type: 'string', enum: TTS_VOICE_IDS, description: `TTS voice id. Default ${DEFAULT_VOICE}.` },
	},
	additionalProperties: false,
};

const OUTPUT_SCHEMA = {
	$schema: 'https://json-schema.org/draft/2020-12/schema',
	type: 'object',
	required: ['agent_id', 'glb_url', 'viewer_url', 'profile_url', 'embed_html', 'voice', 'rigged'],
	properties: {
		agent_id: { type: 'string', description: 'Durable persona id — reload the same body with GET /api/mcp3d/persona?id=<agent_id>.' },
		glb_url: { type: 'string', description: 'The rigged, animation-ready GLB.' },
		viewer_url: { type: 'string', description: 'Interactive 3D viewer for the body.' },
		profile_url: { type: 'string', description: 'The hosted embodiment presence page (renders + speaks + emotes).' },
		embed_html: { type: 'string', description: 'One-tag <iframe> embed to drop into any website.' },
		reload_url: { type: 'string', description: 'JSON endpoint that reloads the persona by id.' },
		voice: { type: 'string' },
		rigged: { type: 'boolean', description: 'True when the auto-rig succeeded; false when the endpoint fell back to the un-rigged mesh.' },
		name: { type: 'string' },
	},
};

const OUTPUT_EXAMPLE = {
	agent_id: 'persona_8f2a1c9d4be6f70a1b2c',
	glb_url: 'https://pub-xxxx.r2.dev/personas/persona_8f2a1c9d4be6f70a1b2c.glb',
	viewer_url: 'https://three.ws/viewer?src=https%3A%2F%2Fpub-xxxx.r2.dev%2Fpersonas%2Fpersona_8f2a1c9d4be6f70a1b2c.glb',
	profile_url: 'https://three.ws/embodiment/embed?persona=persona_8f2a1c9d4be6f70a1b2c',
	embed_html: '<iframe src="https://three.ws/embodiment/embed?persona=persona_8f2a1c9d4be6f70a1b2c" width="480" height="640" loading="lazy" style="border:0;border-radius:12px;max-width:100%" allow="autoplay; fullscreen; xr-spatial-tracking" allowfullscreen></iframe>',
	reload_url: 'https://three.ws/api/mcp3d/persona?id=persona_8f2a1c9d4be6f70a1b2c',
	voice: 'nova',
	rigged: true,
	name: 'Nova Scout',
};

const BAZAAR = {
	discoverable: true,
	info: {
		input: { type: 'json', example: { name: 'Nova Scout', prompt: 'a friendly explorer in a teal jumpsuit', voice: 'nova' }, schema: INPUT_SCHEMA },
		output: { type: 'json', example: OUTPUT_EXAMPLE },
	},
	schema: buildBazaarSchema({ method: 'POST', bodySchema: INPUT_SCHEMA, outputSchema: OUTPUT_SCHEMA }),
};

// Embed iframe sizing — a portrait frame suits a standing avatar.
const EMBED_W = 480;
const EMBED_H = 640;

async function readBody(req) {
	if (req.body && typeof req.body === 'object') return req.body;
	const chunks = [await readRawBody(req, 1_000_000)];
	const raw = Buffer.concat(chunks).toString('utf8').trim();
	if (!raw) return {};
	return JSON.parse(raw);
}

// Throw a 400 with a stable code — runs after verify but BEFORE settle, so a
// rejected body is never charged.
function bad(code, message, extra = {}) {
	const err = new Error(message);
	err.status = 400;
	err.code = code;
	Object.assign(err, extra);
	return err;
}

function validate(body) {
	const name = typeof body?.name === 'string' ? body.name.trim() : '';
	if (!name) throw bad('invalid_name', 'name is required');
	if (name.length > NAME_MAX) throw bad('invalid_name', `name must be ≤${NAME_MAX} characters`);

	const prompt = typeof body?.prompt === 'string' ? body.prompt.trim() : '';
	const imageUrl = typeof body?.image_url === 'string' ? body.image_url.trim() : '';
	if (!prompt && !imageUrl) throw bad('missing_input', 'provide either a prompt or an image_url');
	if (prompt && imageUrl) throw bad('ambiguous_input', 'provide exactly one of prompt or image_url, not both');
	if (prompt && prompt.length > PROMPT_MAX) throw bad('invalid_prompt', `prompt must be ≤${PROMPT_MAX} characters`);
	if (imageUrl) {
		let u;
		try { u = new URL(imageUrl); } catch { throw bad('invalid_image_url', 'image_url must be a valid URL'); }
		if (u.protocol !== 'https:' && u.protocol !== 'http:') throw bad('invalid_image_url', 'image_url must be http(s)');
	}

	const personality = typeof body?.personality === 'string' ? body.personality.trim().slice(0, PERSONALITY_MAX) : '';

	let voice = DEFAULT_VOICE;
	if (body?.voice !== undefined && body?.voice !== null && body?.voice !== '') {
		if (typeof body.voice !== 'string' || !TTS_VOICE_IDS.includes(body.voice)) {
			throw bad('invalid_voice', `voice must be one of: ${TTS_VOICE_IDS.join(', ')}`, { valid_voices: TTS_VOICE_IDS });
		}
		voice = body.voice;
	}

	return { name, prompt, imageUrl, personality, voice };
}

// Run the generate → rig chain and mint a durable persona. Exported for tests
// (dependency-injected forge/persona so the pipeline can be exercised offline).
export async function runEmbodyChain(
	{ base, name, prompt, imageUrl, personality, voice },
	{ generateFn = generate, rigFn = rig, createPersonaFn = createPersona } = {},
) {
	// 1. Mesh generation (free NVIDIA TRELLIS lane; image→3D reconstructs).
	const gen = await generateFn(
		base,
		{
			...(prompt ? { prompt } : {}),
			...(imageUrl ? { imageUrls: [imageUrl] } : {}),
			aspect: '1:1',
			tier: 'draft',
		},
		{ timeoutEnv: 'EMBODY_GEN_TIMEOUT_MS' },
	);
	if (gen?._timedOut) {
		const e = new Error('avatar generation timed out before a body was produced');
		e.status = 504; e.code = 'generation_timeout'; e.stage = 'generate';
		throw e;
	}
	if (!gen?.glb_url) {
		const e = new Error('avatar generation did not return a model');
		e.status = 502; e.code = 'generation_failed'; e.stage = 'generate';
		throw e;
	}

	// 2. Auto-rig (humanoid skeleton + skin weights). A rig failure/timeout is a
	//    graceful degrade to the un-rigged mesh — never a hard failure, never a
	//    T-pose (the mesh itself renders fine; it just isn't skeleton-driven yet).
	let riggedGlb = gen.glb_url;
	let rigged = false;
	try {
		const rigResult = await rigFn(base, gen.glb_url, { timeoutEnv: 'EMBODY_RIG_TIMEOUT_MS' });
		if (rigResult && !rigResult._timedOut && rigResult.glb_url) {
			riggedGlb = rigResult.glb_url;
			rigged = true;
		}
	} catch {
		// Keep the mesh; rigged stays false. Surfaced to the caller in `rigged`.
	}

	// 3. Durable persona — copies the GLB into our own storage and stores the
	//    name/voice/personality so the body reloads by id in any future session.
	const persona = await createPersonaFn({
		glbUrl: riggedGlb,
		name,
		voice,
		sourcePrompt: prompt || `image:${imageUrl}`,
		look: { rigged, style: personality || null },
	});

	return { persona, glbUrl: riggedGlb, rigged, voice, name };
}

function buildBundle(base, { persona, glbUrl, rigged, voice, name }) {
	const personaView = { persona_id: persona.id, glb_url: persona.glb_url || glbUrl, name };
	const profileUrl = buildEmbedUrl({ persona: personaView, state: 'idle' });
	const embedHtml =
		`<iframe src="${profileUrl}" width="${EMBED_W}" height="${EMBED_H}" ` +
		`loading="lazy" style="border:0;border-radius:12px;max-width:100%" ` +
		`allow="autoplay; fullscreen; xr-spatial-tracking" allowfullscreen ` +
		`sandbox="allow-scripts allow-same-origin allow-popups"></iframe>`;
	return {
		agent_id: persona.id,
		glb_url: personaView.glb_url,
		viewer_url: viewerUrl(base, personaView.glb_url),
		profile_url: profileUrl,
		embed_html: embedHtml,
		reload_url: `${base}/api/mcp3d/persona?id=${encodeURIComponent(persona.id)}`,
		voice,
		rigged,
		name,
	};
}

export default paidEndpoint({
	route: ROUTE,
	method: 'POST',
	priceAtomics: priceFor('embody', '1000000'),
	networks: ['solana', 'base'],
	description: DESCRIPTION,
	bazaar: BAZAAR,
	service: withService({
		serviceName: 'three.ws Embodiment',
		tags: ['3d', 'avatar', 'embed', 'agent', 'embodiment'],
	}),

	async handler({ req }) {
		let body;
		try {
			body = await readBody(req);
		} catch {
			throw bad('invalid_json', 'request body must be valid JSON');
		}
		// Validation runs here (post-verify, pre-settle) so a bad request is never charged.
		const input = validate(body);

		const base = originFromReq(req);
		const chain = await runEmbodyChain({ base, ...input });
		return buildBundle(base, chain);
	},
});

export { validate as _validate, buildBundle as _buildBundle };
