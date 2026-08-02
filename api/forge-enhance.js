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
import { getGcpAccessToken } from './_lib/gcp-auth.js';

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

// Subject-aware negatives. Each subject class reconstructs badly in a DIFFERENT
// way, so a single flat negative list under-serves all of them: a person's
// failure mode is hands and faces, a vehicle's is wheel count and panel
// symmetry, food's is a fake plastic-replica sheen. These are appended on top of
// FORGE_NEGATIVE_PROMPT for the detected subject so the reference-image and
// reconstruction steps are steered away from the failures that actually happen
// for THAT kind of thing. Included for every style (a low-poly car still must
// not sprout a third wheel); the photoreal block above is layered on separately
// only for the realistic default.
export const SUBJECT_NEGATIVES = Object.freeze({
	person:
		'extra fingers, six fingers, fused fingers, deformed hands, malformed hands, extra arms, ' +
		'extra limbs, missing limbs, asymmetric eyes, crossed eyes, lifeless glassy eyes, distorted face, ' +
		'warped facial features, mannequin joints, elongated neck, unnatural body proportions',
	animal:
		'extra legs, missing legs, fused limbs, malformed paws, distorted muzzle, two heads, extra tails, ' +
		'matted clumped fur, unnatural eye placement, warped anatomy, hybrid creature',
	food:
		'plastic food replica, wax food model, artificial glossy coating, inedible sheen, moldy, rotten, ' +
		'grey unappetizing tones, cartoon food, candy colors on savory food, styrofoam prop',
	vehicle:
		'wrong number of wheels, asymmetric wheels, warped body panels, misaligned doors, melted chrome, ' +
		'floating parts, impossible geometry, bent chassis, duplicated headlights, deformed frame',
	object:
		'warped edges, asymmetric silhouette, melted contours, duplicated features, distorted proportions, ' +
		'uneven symmetry',
});

// Detect the subject class of a rough prompt so the director and the negatives
// can adapt. Ordered person → animal → vehicle → food → object: a "knight on a
// horse" is a person subject, "food truck" is a vehicle, so the more specific
// human/animal/vehicle cues win before the broad food/object nets. Whole-word
// matching so "manatee" can't read as "man" or "carrot" as "car".
const PERSON_WORDS = [
	'person', 'human', 'man', 'woman', 'guy', 'girl', 'boy', 'lady', 'gentleman', 'people',
	'face', 'portrait', 'selfie', 'warrior', 'knight', 'soldier', 'wizard', 'ninja', 'astronaut',
	'pirate', 'king', 'queen', 'hero', 'villain', 'avatar', 'child', 'baby', 'elf', 'dwarf',
	// Occupations and archetypes read as a person even without the word "man/woman".
	'firefighter', 'fireman', 'policeman', 'policewoman', 'police officer', 'officer', 'cop',
	'nurse', 'doctor', 'surgeon', 'chef', 'cook', 'farmer', 'cowboy', 'cowgirl', 'ranger',
	'teacher', 'pilot', 'sailor', 'captain', 'monk', 'priest', 'nun', 'samurai', 'viking',
	'gladiator', 'barbarian', 'mage', 'sorcerer', 'sorceress', 'witch', 'princess', 'prince',
	'superhero', 'athlete', 'dancer', 'ballerina', 'chef', 'builder', 'miner', 'diver',
];
const ANIMAL_WORDS = [
	'animal', 'creature', 'pet', 'dog', 'puppy', 'doggo', 'cat', 'kitten', 'horse', 'pony', 'bird',
	'eagle', 'owl', 'fish', 'shark', 'lion', 'tiger', 'bear', 'wolf', 'fox', 'rabbit', 'bunny', 'deer',
	'cow', 'pig', 'sheep', 'goat', 'elephant', 'giraffe', 'monkey', 'dragon', 'dinosaur', 'dino',
	'snake', 'frog', 'turtle', 'lizard', 'crab', 'octopus', 'whale', 'dolphin', 'penguin', 'panda',
	'koala', 'mouse', 'rat', 'hamster', 'duck', 'chicken', 'rooster', 'insect', 'butterfly', 'bee',
	'spider', 'kangaroo', 'zebra', 'rhino', 'hippo', 'crocodile', 'alligator', 'gorilla', 'squirrel',
	// Common dog breeds (whole-word) so "a golden retriever" reads as an animal.
	'retriever', 'labrador', 'poodle', 'bulldog', 'terrier', 'husky', 'chihuahua', 'corgi',
	'dalmatian', 'pug', 'beagle', 'shepherd', 'rottweiler', 'doberman', 'dachshund',
];
const VEHICLE_WORDS = [
	'car', 'truck', 'van', 'bus', 'motorcycle', 'motorbike', 'bike', 'bicycle', 'scooter', 'plane',
	'airplane', 'aeroplane', 'jet', 'aircraft', 'helicopter', 'boat', 'ship', 'yacht', 'submarine',
	'train', 'tram', 'tank', 'spaceship', 'spacecraft', 'rocket', 'vehicle', 'sedan', 'suv', 'coupe',
	'convertible', 'tractor', 'forklift', 'ambulance', 'firetruck',
];
const FOOD_WORDS = [
	'food', 'fruit', 'vegetable', 'burger', 'hamburger', 'cheeseburger', 'pizza', 'cake', 'cupcake',
	'bread', 'baguette', 'sushi', 'apple', 'banana', 'orange', 'strawberry', 'sandwich', 'donut',
	'doughnut', 'cookie', 'biscuit', 'meal', 'dish', 'drink', 'coffee', 'latte', 'tea', 'juice',
	'smoothie', 'ice cream', 'icecream', 'steak', 'taco', 'burrito', 'noodles', 'ramen', 'pasta',
	'salad', 'soup', 'pie', 'pancake', 'waffle', 'croissant', 'pretzel', 'chocolate', 'candy',
	'lollipop', 'egg', 'cheese', 'meat', 'chicken leg', 'drumstick',
];
function wordRe(words) {
	return new RegExp(`\\b(?:${words.join('|')})\\b`, 'i');
}
const PERSON_RE = wordRe(PERSON_WORDS);
const ANIMAL_RE = wordRe(ANIMAL_WORDS);
const VEHICLE_RE = wordRe(VEHICLE_WORDS);
const FOOD_RE = wordRe(FOOD_WORDS);

export function classifySubject(text) {
	const t = String(text || '');
	if (PERSON_RE.test(t)) return 'person';
	if (ANIMAL_RE.test(t)) return 'animal';
	if (VEHICLE_RE.test(t)) return 'vehicle';
	if (FOOD_RE.test(t)) return 'food';
	return 'object';
}

/**
 * classifySubject plus WHERE in the prompt the subject word was found.
 *
 * The position matters to any caller that has to weigh the subject against
 * another signal read from the same sentence. api/_lib/glb-pbr-derive.js weighs
 * it against material words: "a stainless steel chef knife" is a metal object
 * that happens to contain an occupation word, while "a chef in a wool apron" is
 * a person who happens to be wearing one, and only the ORDER of the two matches
 * tells them apart. classifySubject alone returns 'person' for both.
 *
 * `index` is the character offset of the matched subject word, or -1 when the
 * subject is the 'object' fallback (no word matched anything).
 *
 * @param {string} text
 * @returns {{ subject: 'person'|'animal'|'vehicle'|'food'|'object', index: number }}
 */
export function classifySubjectAt(text) {
	const t = String(text || '');
	for (const [re, subject] of [[PERSON_RE, 'person'], [ANIMAL_RE, 'animal'], [VEHICLE_RE, 'vehicle'], [FOOD_RE, 'food']]) {
		const m = re.exec(t);
		if (m) return { subject, index: m.index };
	}
	return { subject: 'object', index: -1 };
}

// The complete negative-prompt string for a prompt: the universal reconstruction
// failures, the photoreal failures (only when the result should look real), and
// the failures specific to the detected subject. This is the one place negatives
// are assembled, so the /api/forge-enhance response and the reference-image
// module (which imports this) never drift apart.
export function subjectNegativePrompt(text, { realistic = true } = {}) {
	const subject = classifySubject(text);
	const parts = [FORGE_NEGATIVE_PROMPT];
	if (realistic) parts.push(FORGE_PHOTOREAL_NEGATIVE_PROMPT);
	parts.push(SUBJECT_NEGATIVES[subject]);
	return parts.join(', ');
}

// Per-subject realism cue injected into the director's system prompt, so the
// rewrite reaches for the material and surface language that makes THAT subject
// read as a real photographed thing rather than a render.
const SUBJECT_REALISM_HINT = {
	person:
		'This subject is a person or character: describe real skin with visible pores and subtle ' +
		'asymmetry, individual hair strands with natural flyaways, a natural catchlight in the eyes, ' +
		'and real worn fabric. Ordinary human proportions, never doll-like symmetry or oversized eyes.',
	animal:
		'This subject is an animal or creature: describe real fur, feathers, or scales with directional ' +
		'flow and natural variation, a moist natural nose or beak, lifelike eyes with a catchlight, and ' +
		'correct anatomy for the species.',
	vehicle:
		'This subject is a vehicle: describe real painted or brushed-metal body panels with accurate ' +
		'panel gaps, rubber tires with tread, glass and chrome trim, and the correct wheel count and ' +
		'symmetry. It sits still, fully in frame, three-quarter or side product view.',
	food:
		'This subject is food or a drink: describe real edible surface texture, natural moisture and ' +
		'freshness, appetizing true-to-life color, and real crumb, grain, or glaze. It looks freshly ' +
		'made and edible, never a plastic or wax replica.',
	object:
		'This subject is an object: describe its real material, finish, and surface micro-detail (grain, ' +
		'brush marks, wear, weave) so the reconstruction bakes a convincing true-to-life texture.',
};

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

export function buildSystem(style, subject = 'object') {
	const isRealistic = !style || style === 'photorealistic';
	const styleBlock =
		style && STYLE_PRESETS[style]
			? `\n- Apply this target aesthetic to every prompt you write: ${STYLE_PRESETS[style]}.`
			: '';
	const realismBlock = isRealistic ? DEFAULT_REALISM_BLOCK : '';
	// Subject-specific realism guidance only when the result should look real:
	// for an opted-in non-real style the subject hint would fight the user's ask.
	const subjectBlock =
		isRealistic && SUBJECT_REALISM_HINT[subject] ? `\n- ${SUBJECT_REALISM_HINT[subject]}` : '';
	return `You rewrite a user's rough idea into ONE optimal prompt for a text-to-3D pipeline \
(a diffusion model paints a reference image, then a photogrammetry-style model reconstructs \
a textured 3D mesh from it). The realism of the final 3D model is set almost entirely by this \
one reference image, so your prompt must describe a scene that photographs like a REAL object or \
a REAL person, not an illustration or a render.

A great prompt for this pipeline describes a SINGLE, SOLID physical subject (an object, or a \
person/creature) with clear geometry, CENTERED on a plain seamless background as if shot for a \
product or portrait catalog. Rewrite the user's idea following every rule:
- Exactly one subject, centered and fully in frame. If the user named several things, pick the \
most central one; for a person or character, that means the person themselves, not props \
scattered around them.
- Add concrete REAL-WORLD material, surface and color cues that photograph well AND reconstruct \
well, e.g. “brushed aluminium with visible machining marks”, “worn oak with tight grain”, \
“matte ceramic with slight subsurface glow”, “cast iron with rust-speckled patina”, or for a \
person: “weathered tan skin with faint freckles”, “close-cropped grey stubble”, “fine wool knit \
with visible stitching”. Name the surface micro-detail (grain, weave, pores, brush marks, wear): \
it is what makes the reconstruction bake dense, clean geometry and a convincing, true-to-life \
texture rather than a smooth plastic one.
- Prefer opaque, solid materials (metal, wood, stone, ceramic, hard plastic, skin, hair, cloth). \
AVOID transparent, translucent, or mirror-reflective surfaces (glass, crystal, mirror, water) — \
they produce degenerate meshes in photogrammetry reconstructors.
- The silhouette must be distinct and self-contained: no thin wires, no wispy loose strands, no \
fog, no overlapping objects or people. The reconstructor needs unambiguous depth cues.
- Specify soft, even, neutral studio lighting (e.g. “soft even softbox lighting”, “diffuse white \
studio light, no harsh shadows”) and a plain white or light-grey SEAMLESS background. Even, \
shadowless lighting on a seamless sweep is what reconstructs cleanly; hard shadows and busy \
backdrops confuse depth estimation.
- Keep the subject in a neutral, fully-visible resting pose (a person: standing, arms at sides or \
loosely crossed, facing the camera). No actions, no motion blur, no interacting with other people \
or objects, no scenes or environments.
- Stay a compact noun phrase (10 to 40 words). No camera brands, resolution tags, artist names, \
or quotation marks.${subjectBlock}${styleBlock}${realismBlock}

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

// Preferred director lane: Vertex Gemini text, billed to the platform's GCP
// credits (standing owner-approved spend). It outdraws the free 70B rungs on a
// nuanced rewrite like this, and it has no third-party free-tier quota to
// exhaust. Kept strictly OPTIONAL and fail-soft: any failure (no GCP project,
// token-exchange error, safety block, timeout, empty reply) returns null and the
// caller falls through to the existing free-first llmComplete chain unchanged, so
// the director never hard-depends on Vertex. Enabled by default when
// GOOGLE_CLOUD_PROJECT is set; force off with FORGE_ENHANCE_VERTEX=0.
function vertexDirectorEnabled() {
	if (!process.env.GOOGLE_CLOUD_PROJECT) return false;
	return !/^(0|false|no|off)$/i.test(String(process.env.FORGE_ENHANCE_VERTEX ?? '').trim() || 'on');
}

async function vertexDirect({ system, user, maxTokens = 200, timeoutMs = 8_000 }) {
	const project = process.env.GOOGLE_CLOUD_PROJECT;
	const location = process.env.GOOGLE_CLOUD_LOCATION_GEMINI || 'global';
	const model = process.env.VERTEX_GEMINI_MODEL || 'google/gemini-2.5-flash';
	const host =
		location === 'global' ? 'aiplatform.googleapis.com' : `${location}-aiplatform.googleapis.com`;
	const token = await getGcpAccessToken();
	const url = `https://${host}/v1beta1/projects/${project}/locations/${location}/endpoints/openapi/chat/completions`;
	const res = await fetch(url, {
		method: 'POST',
		headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
		body: JSON.stringify({
			model,
			max_tokens: maxTokens,
			messages: [
				{ role: 'system', content: system },
				{ role: 'user', content: user },
			],
		}),
		signal: AbortSignal.timeout(timeoutMs),
	});
	if (!res.ok) throw new Error(`vertex-gemini ${res.status}: ${(await res.text().catch(() => '')).slice(0, 160)}`);
	const data = await res.json();
	const text = data?.choices?.[0]?.message?.content || '';
	if (!text.trim()) throw new Error('vertex-gemini returned empty');
	return { text: text.trim(), provider: 'vertex-gemini', model };
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

	// Detect the subject class so the system prompt reaches for the right realism
	// language and the negative prompt targets the right failure modes.
	const subject = classifySubject(raw);
	const system = buildSystem(style, subject);
	const userPrompt = raw.slice(0, MAX_IN);

	let result;
	// Preferred lane: Vertex Gemini on GCP credits for a higher-quality rewrite,
	// but only when the caller did not opt into the Nemotron lane, and always with
	// automatic fallthrough to the free-first chain below. A Vertex failure here is
	// swallowed so it can never regress the endpoint.
	if (!preferNvidia && vertexDirectorEnabled()) {
		try {
			result = await vertexDirect({ system, user: userPrompt, maxTokens: 200 });
		} catch (err) {
			console.warn('[forge-enhance] vertex director lane failed, using free chain:', err?.message);
		}
	}
	if (!result) {
		try {
			result = await llmComplete({
				system,
				user: userPrompt,
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
	}

	let prompt = cleanPrompt(result.text);
	if (prompt.length > MAX_OUT) prompt = prompt.slice(0, MAX_OUT).replace(/\s\S*$/, '').trim();

	// A degenerate or empty rewrite is worse than the user's own words — fall back.
	if (prompt.length < 3) prompt = raw;

	const isRealistic = !style || style === 'photorealistic';
	// Universal + photoreal (when realistic) + subject-specific failure modes,
	// assembled in one place (subjectNegativePrompt) so this response and the
	// reference-image module never disagree on what to steer away from.
	const negativePrompt = subjectNegativePrompt(raw, { realistic: isRealistic });

	return json(res, 200, {
		prompt,
		original: raw,
		negative_prompt: negativePrompt,
		subject,
		style_applied: style,
		provider: result.provider,
		model: result.model,
	});
});
