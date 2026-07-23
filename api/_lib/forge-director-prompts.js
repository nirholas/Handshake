// Shared IBM Granite "art director" prompt specs — the LLM rewrite step that
// turns a rough user idea into a tight, information-dense spec for the
// text-to-3D reconstruction pipeline (see api/_mcp-studio/forge-client.js's
// directPrompt(), which sends one of these as the system message to watsonx
// Granite in process, free-chain fallback). Centralized here so every surface that runs
// the director — the free MCP tools (api/_mcp-studio/tools.js), the paid
// OKX REST twin (api/_okx3d/rest-services.js), and the public /api/forge
// opt-in `director:true` param — stays in sync on one copy instead of three
// hand-maintained duplicates drifting apart.

import { BRAND_MARK_DIRECTIVE, resolveLogoPrompt } from '../../mcp-server/src/tools/_logo-lexicon.js';
import { classifySubject } from '../forge-enhance.js';

// Deterministic brand-mark resolution ("<brand name> logo" → the real mark's
// geometry). Re-exported here so every api/ director call-site gets the
// lexicon from the same module it already imports the director prompts from.
// `classifySubject` (person/animal/vehicle/food/object) is re-exported too so
// callers can pick the subject-aware director variant below without a second
// import from forge-enhance.js.
export { resolveLogoPrompt, classifySubject };

// The mesh reconstructor never sees the user's words — it only ever sees the
// ONE reference image the director's rewritten prompt produces. So the single
// highest-leverage lever for mesh/texture realism is making that reference
// image read as an actual photograph, not a "3D render" or a game asset: a
// photo already carries the lighting response, material micro-detail, and
// subtle imperfections a reconstruction model needs to bake real PBR values
// instead of flat, plastic-looking color. This phrase block is reused by both
// directors below so a photoreal subject and a photoreal avatar hit the same
// bar. Deliberately generic across camera brands/lens brands (no named gear)
// so it never reads as a product placement.
const PHOTOREAL_CUES =
	'shot like a real photograph, not a render or illustration: natural daylight-balanced studio lighting from a ' +
	'large soft key light with gentle fill (soft, wrapping shadows, no hard graphic highlights), shallow depth of ' +
	'field with the subject in crisp focus, true-to-life color response, and visible micro-detail — fabric weave, ' +
	'skin pores and fine creases, brushed-metal grain, dust and light wear — because nothing in the real world is ' +
	'perfectly clean or perfectly smooth; a small amount of natural asymmetry and imperfection reads as more real ' +
	'than a flawless surface';

// Per-subject-class material/construction cues layered into the MESH_DIRECTOR
// briefing (step 3 below). Each class fails reconstruction in a DIFFERENT way —
// a creature's tell is fur/anatomy, a vehicle's is panel/wheel symmetry, food's
// is an inedible plastic sheen, architecture's is scale and flat facades — so a
// single generic "materials" instruction under-serves all of them. Mirrors the
// SUBJECT_REALISM_HINT map in forge-enhance.js but tuned for the MESH_DIRECTOR's
// construction-first briefing rather than a rewrite-prompt's prose.
const MESH_SUBJECT_HINTS = Object.freeze({
	person:
		'This is a person or humanoid character: call out real skin (visible pores, subtle asymmetry, faint ' +
		'subsurface glow at ears/nose/fingers), hair as many fine strands rather than a sculpted cap, and ' +
		'ordinary human proportions — never doll-like symmetry or oversized eyes.',
	animal:
		'This is an animal or creature: call out real fur/feather/scale direction and texture, correct species ' +
		'anatomy (leg count, joint bend direction, muzzle/beak shape), a moist natural nose, and lifelike eyes ' +
		'with a catchlight — never a plush-toy or cartoon proportion.',
	vehicle:
		'This is a vehicle: call out painted or brushed-metal body panels with accurate panel gaps, correct wheel ' +
		'count and symmetry, rubber tread, and glass/chrome trim — sitting still, fully in frame, three-quarter or ' +
		'side product view, never mid-motion.',
	food:
		'This is food or a drink: call out real edible surface texture (crumb, grain, glaze, condensation), ' +
		'natural moisture and appetizing true-to-life color — never a plastic replica or wax-model sheen.',
	architecture:
		'This is a building or structure: call out real construction materials at true scale (brick coursing, ' +
		'poured concrete, glass curtain wall, weathered stone), consistent perspective, and legible window/door ' +
		'proportions — never a toy-scale or flat, textureless facade.',
	object:
		'Call out the object\'s real material, finish, and surface micro-detail (grain, brush marks, wear, weave) ' +
		'so the reconstructor bakes a convincing true-to-life texture rather than a flat, plastic one.',
});

// Architecture reads as a distinct subject class from the generic "object" net
// for MESH_DIRECTOR's purposes (scale and facade realism are a different
// failure mode from a handheld prop), even though forge-enhance.js's
// classifySubject() folds it into 'object' upstream. Detected locally, ordered
// before the generic object fallback so a named building/structure gets its
// own construction guidance.
const ARCHITECTURE_RE =
	/\b(building|house|tower|skyscraper|bridge|castle|cathedral|church|temple|mansion|cabin|cottage|barn|warehouse|stadium|lighthouse|windmill|architecture|facade|structure)\b/i;

// Resolve the MESH_DIRECTOR hint key for a raw prompt: architecture first (a
// finer-grained class than classifySubject's 'object' bucket), then whatever
// classifySubject() already detects (person/animal/vehicle/food), else 'object'.
export function meshSubjectClass(prompt) {
	if (ARCHITECTURE_RE.test(String(prompt || ''))) return 'architecture';
	return classifySubject(prompt);
}

// Build the MESH_DIRECTOR system prompt for a given subject class — one
// isolated subject, its construction, per-part PBR materials, one held art
// style, subject-specific realism cues, and fine surface detail, ending in
// composition constraints tuned for clean image→mesh reconstruction.
export function meshDirectorFor(subject = 'object') {
	const hint = MESH_SUBJECT_HINTS[subject] || MESH_SUBJECT_HINTS.object;
	return (
		"You are a 3D asset art director briefing a text-to-3D reconstruction model. Rewrite the user's idea into " +
		'ONE concise, information-dense prompt that maximizes mesh and texture quality. Cover, in order: (1) the ' +
		'SINGLE subject and its overall silhouette/proportions, (2) construction — distinct parts, how they join, ' +
		'any symmetry, (3) materials per part with explicit PBR cues (e.g. brushed steel, matte ceramic, worn ' +
		'leather, glossy lacquer, rough stone) so surfaces reconstruct with the right roughness/metalness — and ' +
		'specifically: ' + hint + ' (4) a coherent, consistent art style held across the whole subject. Default to ' +
		'photoreal — most real-world objects should look like an actual photograph of the physical thing. Only ' +
		"choose stylized, low-poly, or hand-painted when the user's own words clearly call for that look (cartoon, " +
		'chibi, voxel, pixel art, toy, anime, retro game, etc.) — never mix styles. When the style is photoreal, ' +
		'weave in these cues: ' + PHOTOREAL_CUES + '. (5) ' +
		'fine surface detail (seams, panel lines, weathering, grain) that gives the reconstructor texture to latch ' +
		"onto. If the idea names a brand, meme, app, or term you do not recognize, keep the user's concrete object " +
		'noun as the subject and describe its canonical physical form (a pill is a two-tone medicine capsule, a ' +
		'rocket is a finned cylinder with a nose cone); never substitute a different object. ' +
		BRAND_MARK_DIRECTIVE +
		'Always end with these composition constraints so the ' +
		'reference image reconstructs cleanly: full subject in frame, centered, isolated on a plain neutral ' +
		'background, one camera angle, even studio lighting, no cropping, no motion blur, no text or watermark, no ' +
		'collage or multi-view grid, no second subject. Output ONLY the rewritten prompt as a single line — no ' +
		'preamble, no quotes.'
	);
}

// Back-compat default (subject-agnostic 'object' briefing) — existing
// call-sites and tests that import the flat constant keep working unchanged;
// new call-sites should classify the prompt and call meshDirectorFor(subject)
// directly for the subject-aware briefing.
export const MESH_DIRECTOR = meshDirectorFor('object');

// Human-specific realism cues layered on top of PHOTOREAL_CUES for avatars —
// the difference between "video-game NPC" and an actual person is almost
// entirely in skin, hair, and eyes, so those get named explicitly rather than
// left to the generic PHOTOREAL_CUES block above.
const PHOTOREAL_HUMAN_CUES =
	'render actual human skin, not plastic or mannequin-smooth: visible pores, fine natural texture, subtle ' +
	'subsurface light scattering at the ears/nose/fingers, faint natural color variation across the face and ' +
	'hands, and realistic individual proportions rather than an idealized/symmetrical video-game-character look. ' +
	'Hair is rendered as many fine individual strands with natural flyaways and light catching them, not a single ' +
	'painted-on helmet shape. Eyes have visible iris detail, a natural wet highlight, and real catchlights from ' +
	'the studio lighting';

// Creature-specific realism cues — the avatar-flavored twin of
// PHOTOREAL_HUMAN_CUES for a non-human full-body character (a dragon, a
// beast-person, an animal-headed avatar) that still needs a humanoid-ish rig.
// Fur/scale/feather direction and species-correct anatomy are the tell for a
// creature reconstruction the way skin/hair/eyes are for a human one.
const PHOTOREAL_CREATURE_CUES =
	'render real fur, feathers, or scales with directional flow and natural variation (not a painted-on flat ' +
	'texture), a moist natural nose/snout or beak, lifelike eyes with a catchlight, and anatomically correct ' +
	'proportions for the creature — never a plush-toy or cartoon-mascot look';

// Build the AVATAR_DIRECTOR system prompt for a subject class. 'person' (the
// default) weaves in PHOTOREAL_HUMAN_CUES; 'animal' (a creature/beast avatar
// that still needs a rig) swaps in PHOTOREAL_CREATURE_CUES instead, since the
// realism tell is completely different — skin/hair/eyes vs. fur/scale/anatomy.
// Every other subject class falls back to the person cues: an avatar is a
// full-body character by definition, and the humanoid gate upstream
// (classifyHumanoidPrompt) already filters out non-character subjects before
// this director ever runs.
export function avatarDirectorFor(subject = 'person') {
	const subjectCues = subject === 'animal' ? PHOTOREAL_CREATURE_CUES : PHOTOREAL_HUMAN_CUES;
	return (
		"You are a 3D character art director briefing a text-to-3D reconstruction model whose output will be " +
		"auto-rigged for animation. Rewrite the user's idea into ONE concise, information-dense prompt. Cover, in " +
		'order: (1) a SINGLE full-body humanoid, standing in a neutral A/T-adjacent pose, arms slightly away from ' +
		'the body and legs slightly apart so limbs are readable and separable for rigging, (2) body type and ' +
		'proportions, (3) outfit and gear per body region (head, torso, arms, legs, feet) with explicit PBR ' +
		'material cues (e.g. brushed metal armor, worn leather straps, matte cloth, glossy visor) so surfaces ' +
		'reconstruct with correct roughness/metalness, (4) one coherent, consistent art style held across the ' +
		'whole character. Default to photoreal — a real human being (or, for a creature/beast character, a real ' +
		"animal) photographed, not a game character or a toy — unless the user's own words clearly call for " +
		'something else (anime, cartoon, chibi, voxel, robot, toy, low-poly, hand-painted, etc.); never mix styles. ' +
		'When the character is photoreal, weave in these cues: ' + PHOTOREAL_CUES + '; and specifically: ' +
		subjectCues + '. (5) key identifying ' +
		'features (hair, face, color scheme, accessories). When the idea is sparse or generic ("a woman", "a knight", ' +
		'"a cool guy"), do NOT default to the same safe, average person: commit to specific, memorable choices the ' +
		'user did not rule out: a particular age, build, and face character; a distinctive hairstyle and hair color; a ' +
		'named 2-3 color palette; one signature garment, pattern, or accessory that makes this character instantly ' +
		'recognizable in a lineup. Draw these choices from the mood and connotations of the words the user chose so two ' +
		'different ideas never converge on the same person. If the idea names a brand, meme, or term you do not ' +
		"recognize, keep the user's stated character concept as the subject and render its canonical look; never " +
		'substitute a different character. Always end with these composition ' +
		'constraints: full body in frame head-to-toe, centered, isolated on a plain neutral background, no props ' +
		'gripped or crossing the silhouette, one camera angle facing the character, even studio lighting, no ' +
		'cropping, no motion blur, no text or watermark, no collage or multi-view grid, no second character. ' +
		'Output ONLY the rewritten prompt as a single line — no preamble, no quotes.'
	);
}

// Back-compat default (person briefing) — existing call-sites and tests that
// import the flat constant keep working unchanged; new call-sites should
// classify the prompt and call avatarDirectorFor(subject) directly.
export const AVATAR_DIRECTOR = avatarDirectorFor('person');
