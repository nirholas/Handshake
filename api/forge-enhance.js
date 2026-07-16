// POST /api/forge-enhance — turn a terse object description into a prompt the
// text→3D pipeline (FLUX reference image → TRELLIS reconstruction) can actually
// render well. Single subject, centered, plain background, with the material,
// surface and lighting cues that make reconstruction sharp.
//
//   Body: { prompt: string, style?: string, engine?: 'nemotron' }
//   200:  { prompt, original, negative_prompt, style_applied, provider, model }
//
// `style` is an optional hint that makes the rewrite consistent for a generation
// set (e.g. “low-poly game asset”, “photorealistic PBR”, “clay render”). When
// absent the director picks the most photorealistic, reconstruction-friendly phrasing.
//
// `negative_prompt` in the response is a ready-made comma-separated list of
// things the pipeline produces bad results for — pass it straight to providers
// that support it (Hunyuan3D, some Replicate models). Providers that ignore
// unknown params are unaffected.
//
// Runs on the same free-first LLM chain as every other text feature on the site
// (Groq / OpenRouter / NVIDIA lead; host's paid keys are last resort). When no
// provider is configured at all it returns 503 and the page quietly keeps the
// original prompt — enhancement is a boost, never a gate.

import { cors, method, wrap, error, readJson, json, rateLimited } from './_lib/http.js';
import { limits, clientIp } from './_lib/rate-limit.js';
import { llmComplete, LlmUnavailableError } from './_lib/llm.js';

const MAX_IN = 1000;
const MAX_OUT = 240;

// Negative prompts that apply to every 3D generation regardless of subject.
// These are the failure modes the TRELLIS / Hunyuan3D family most reliably
// produces on unclear inputs — listed once and appended to every response so
// callers don't have to remember them.
export const FORGE_NEGATIVE_PROMPT =
	'multiple objects, busy scene, background clutter, partial view, cut off, floating pieces, ' +
	'disconnected parts, transparent geometry, hollow interior, inside-out normals, ' +
	'flat image, 2D illustration, watermark, text overlay, blur';

// Appended on top of FORGE_NEGATIVE_PROMPT only for the photorealistic default
// and the explicit `photorealistic` style — the platform's most common failure
// mode against a real-looking result is a plasticky, doll-like, or uncanny
// render, not the reconstruction-geometry issues above. Never appended for
// styles that deliberately want a non-real look (lowpoly, clay, stylized,
// scifi, fantasy), where these would fight the user's own request.
export const FORGE_PHOTOREAL_NEGATIVE_PROMPT =
	'plastic doll skin, waxy texture, mannequin, toy figurine, action figure, chibi proportions, ' +
	'cartoon shading, cel shading, airbrushed skin, uncanny valley, wax figure, cgi render look, ' +
	'video game character, low detail skin, plastic sheen';

// Style presets: a caller can pass `style` to keep generated-set consistency
// (“I want all my assets to look like low-poly game items”).
const STYLE_PRESETS = {
	photorealistic:
		'photorealistic, shot on a full-frame camera, physically-based rendering, ' +
		'true-to-life material response, natural skin micro-texture and pore detail on any person ' +
		'or creature, real fabric weave and wrinkles on any clothing, 8K texture detail, ' +
		'unretouched documentary realism',
	lowpoly: 'low-poly, faceted surfaces, flat shading, stylized game asset',
	clay: 'matte clay render, smooth surfaces, uniform studio lighting, no shadows',
	stylized: 'stylized, illustrative 3D, clean hand-painted textures, vibrant colors',
	scifi: 'sci-fi industrial, matte metal panels, glowing accents, hard-surface details',
	fantasy: 'fantasy, hand-painted texture, slightly warm studio light, vivid surface detail',
};

// Every generation is real-looking by default: the platform's whole promise is
// that what comes out could pass for a photograph of an actual object or
// person, not a video-game asset. A caller opts OUT of that by passing any
// other `style`; passing none, or `photorealistic` explicitly, both mean "as
// real as possible."
const DEFAULT_REALISM_BLOCK =
	'\n- This is the DEFAULT aesthetic unless the user clearly asked for something else (a game, a ' +
	'toy, a cartoon, a specific art style): render it as if it were a real object or a real person, ' +
	'photographed. Skin has natural pores, subtle asymmetry, and true subsurface scattering, never a ' +
	'smooth plastic or airbrushed sheen. Hair reads as individual real strands with natural flyaways, ' +
	'not a sculpted cartoon helmet. Fabric has real weave, weight, and wrinkles from actually being ' +
	'worn. Faces are anatomically ordinary — no oversized eyes, no doll-like symmetry, no exaggerated ' +
	'proportions — like an actual person stood in front of the camera.';

function buildSystem(style) {
	const isRealistic = !style || style === 'photorealistic';
	const styleBlock =
		style && STYLE_PRESETS[style]
			? `\n- Apply this target aesthetic to every prompt you write: ${STYLE_PRESETS[style]}.`
			: '';
	const realismBlock = isRealistic ? DEFAULT_REALISM_BLOCK : '';
	return `You rewrite a user's rough idea into ONE optimal prompt for a text-to-3D pipeline \
(a diffusion model paints a reference image, then a photogrammetry-style model reconstructs \
a textured 3D mesh from it).

A great prompt for this pipeline describes a SINGLE, SOLID physical subject (an object, or a \
person/creature) with clear geometry, centered on a plain background as if shot for a product \
or portrait catalog. Rewrite the user's idea following every rule:
- Exactly one subject. If the user named several things, pick the most central one — for a person \
or character, that means the person themselves, not props scattered around them.
- Add concrete material, surface and color cues that photograph well AND reconstruct well, \
e.g. “brushed aluminium with visible machining marks”, “worn oak with tight grain”, \
“matte ceramic with slight subsurface glow”, “cast iron with rust-speckled patina”, or for a \
person: “weathered tan skin with faint freckles”, “close-cropped grey stubble”, “fine wool knit \
with visible stitching”. Surface micro-detail helps the reconstruction model generate dense, \
clean geometry and a convincing texture bake.
- Prefer opaque, solid materials (metal, wood, stone, ceramic, hard plastic, skin, hair, cloth). \
AVOID transparent, translucent, or mirror-reflective surfaces (glass, crystal, mirror, water) — \
they produce degenerate meshes in photogrammetry reconstructors.
- The silhouette must be distinct and self-contained: no thin wires, no wispy loose strands, no \
fog, no overlapping objects or people. The reconstructor needs unambiguous depth cues.
- Specify soft, even studio lighting (e.g. “soft box lighting”, “diffuse white studio light”) \
and a plain white or light-grey background. Sharp shadows confuse depth estimation.
- Keep the subject in a neutral, fully-visible resting pose (a person: standing, arms at sides or \
loosely crossed, facing the camera). No actions, no motion blur, no interacting with other people \
or objects, no scenes or environments.
- Stay a compact noun phrase (10–40 words). No camera brands, resolution tags, artist names, \
or quotation marks.${styleBlock}${realismBlock}

Output ONLY the rewritten prompt as a single line of plain text. No preamble, no explanation, \
no markdown, no extra lines.`;
}

// Strip anything the model wraps around the prompt despite instructions: quotes,
// a “Prompt:” label, surrounding whitespace, stray line breaks.
function cleanPrompt(text) {
	let t = (text || '').trim();
	t = t.replace(/^(?:enhanced\s+)?prompt\s*[:\-—]\s*/i, '');
	t = t.replace(/\s+/g, ' ').trim();
	if ((t.startsWith('”') && t.endsWith('”')) || (t.startsWith('“') && t.endsWith('”'))) {
		t = t.slice(1, -1).trim();
	}
	t = t.replace(/[.\s]+$/, '').trim();
	return t;
}

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'POST,OPTIONS' })) return;
	if (!method(req, res, ['POST'])) return;

	const rl = await limits.forgeEnhance(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const body = await readJson(req);
	const raw = typeof body?.prompt === 'string' ? body.prompt.trim() : '';
	if (raw.length < 3) {
		return error(res, 400, 'prompt_too_short', 'Describe the object in a few words first.');
	}

	// Optional style preset — kept to the defined set so callers get consistency
	// without us injecting arbitrary text from user input into the system prompt.
	const style =
		typeof body?.style === 'string' && STYLE_PRESETS[body.style.toLowerCase().trim()]
			? body.style.toLowerCase().trim()
			: null;

	// Opt-in: route the refine through NVIDIA's Nemotron NIM (the /forge-spark
	// pipeline asks for this). Still falls back to the free chain on failure.
	const preferNvidia = body?.engine === 'nemotron';

	let result;
	try {
		result = await llmComplete({
			system: buildSystem(style),
			user: raw.slice(0, MAX_IN),
			maxTokens: 200,
			preferNvidia,
			track: { tool: 'forge-enhance', clientId: clientIp(req) },
		});
	} catch (err) {
		if (err instanceof LlmUnavailableError) {
			return error(res, 503, 'llm_unavailable', 'Prompt enhancement is not available right now.');
		}
		console.error('[forge-enhance] LLM failed', err.status || '', err.message);
		return error(res, 502, 'llm_failed', 'Could not enhance the prompt. Try again.');
	}

	let prompt = cleanPrompt(result.text);
	if (prompt.length > MAX_OUT) prompt = prompt.slice(0, MAX_OUT).replace(/\s\S*$/, '').trim();

	// A degenerate or empty rewrite is worse than the user's own words — fall back.
	if (prompt.length < 3) prompt = raw;

	const isRealistic = !style || style === 'photorealistic';
	const negativePrompt = isRealistic
		? `${FORGE_NEGATIVE_PROMPT}, ${FORGE_PHOTOREAL_NEGATIVE_PROMPT}`
		: FORGE_NEGATIVE_PROMPT;

	return json(res, 200, {
		prompt,
		original: raw,
		negative_prompt: negativePrompt,
		style_applied: style,
		provider: result.provider,
		model: result.model,
	});
});
