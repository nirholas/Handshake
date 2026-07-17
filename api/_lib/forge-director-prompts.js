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

// Deterministic brand-mark resolution ("<brand name> logo" → the real mark's
// geometry). Re-exported here so every api/ director call-site gets the
// lexicon from the same module it already imports the director prompts from.
export { resolveLogoPrompt };

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

// For a single object/prop/creature — one isolated subject, its construction,
// per-part PBR materials, one held art style, and fine surface detail, ending
// in composition constraints tuned for clean image→mesh reconstruction.
export const MESH_DIRECTOR =
	"You are a 3D asset art director briefing a text-to-3D reconstruction model. Rewrite the user's idea into " +
	'ONE concise, information-dense prompt that maximizes mesh and texture quality. Cover, in order: (1) the ' +
	'SINGLE subject and its overall silhouette/proportions, (2) construction — distinct parts, how they join, ' +
	'any symmetry, (3) materials per part with explicit PBR cues (e.g. brushed steel, matte ceramic, worn ' +
	'leather, glossy lacquer, rough stone) so surfaces reconstruct with the right roughness/metalness, (4) a ' +
	'coherent, consistent art style held across the whole subject. Default to photoreal — most real-world objects ' +
	'should look like an actual photograph of the physical thing. Only choose stylized, low-poly, or hand-painted ' +
	"when the user's own words clearly call for that look (cartoon, chibi, voxel, pixel art, toy, anime, retro " +
	'game, etc.) — never mix styles. When the style is photoreal, weave in these cues: ' + PHOTOREAL_CUES + '. (5) ' +
	'fine surface detail (seams, panel lines, weathering, grain) that gives the reconstructor texture to latch ' +
	"onto. If the idea names a brand, meme, app, or term you do not recognize, keep the user's concrete object " +
	'noun as the subject and describe its canonical physical form (a pill is a two-tone medicine capsule, a ' +
	'rocket is a finned cylinder with a nose cone); never substitute a different object. ' +
	BRAND_MARK_DIRECTIVE +
	'Always end with these composition constraints so the ' +
	'reference image reconstructs cleanly: full subject in frame, centered, isolated on a plain neutral ' +
	'background, one camera angle, even studio lighting, no cropping, no motion blur, no text or watermark, no ' +
	'collage or multi-view grid, no second subject. Output ONLY the rewritten prompt as a single line — no ' +
	'preamble, no quotes.';

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

// For a full-body humanoid destined for auto-rigging — a readable, separable
// pose plus the same per-region PBR/material and single-style discipline.
export const AVATAR_DIRECTOR =
	"You are a 3D character art director briefing a text-to-3D reconstruction model whose output will be " +
	"auto-rigged for animation. Rewrite the user's idea into ONE concise, information-dense prompt. Cover, in " +
	'order: (1) a SINGLE full-body humanoid, standing in a neutral A/T-adjacent pose, arms slightly away from ' +
	'the body and legs slightly apart so limbs are readable and separable for rigging, (2) body type and ' +
	'proportions, (3) outfit and gear per body region (head, torso, arms, legs, feet) with explicit PBR ' +
	'material cues (e.g. brushed metal armor, worn leather straps, matte cloth, glossy visor) so surfaces ' +
	'reconstruct with correct roughness/metalness, (4) one coherent, consistent art style held across the ' +
	'whole character. Default to photoreal — a real human being photographed, not a game character or a toy — ' +
	"unless the user's own words clearly call for something else (anime, cartoon, chibi, voxel, robot, creature, " +
	'toy, low-poly, hand-painted, etc.); never mix styles. When the character is a photoreal human, weave in ' +
	'these cues: ' + PHOTOREAL_CUES + '; and specifically: ' + PHOTOREAL_HUMAN_CUES + '. (5) key identifying ' +
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
	'Output ONLY the rewritten prompt as a single line — no preamble, no quotes.';
