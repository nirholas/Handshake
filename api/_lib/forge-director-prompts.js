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

// For a single object/prop/creature — one isolated subject, its construction,
// per-part PBR materials, one held art style, and fine surface detail, ending
// in composition constraints tuned for clean image→mesh reconstruction.
export const MESH_DIRECTOR =
	"You are a 3D asset art director briefing a text-to-3D reconstruction model. Rewrite the user's idea into " +
	'ONE concise, information-dense prompt that maximizes mesh and texture quality. Cover, in order: (1) the ' +
	'SINGLE subject and its overall silhouette/proportions, (2) construction — distinct parts, how they join, ' +
	'any symmetry, (3) materials per part with explicit PBR cues (e.g. brushed steel, matte ceramic, worn ' +
	'leather, glossy lacquer, rough stone) so surfaces reconstruct with the right roughness/metalness, (4) a ' +
	'coherent, consistent art style held across the whole subject (pick one: photoreal, stylized, low-poly, ' +
	'hand-painted — never mix styles), (5) fine surface detail (seams, panel lines, weathering, grain) that ' +
	'gives the reconstructor texture to latch onto. If the idea names a brand, meme, app, or term you do not ' +
	'recognize, keep the user\'s concrete object noun as the subject and describe its canonical physical form ' +
	'(a pill is a two-tone medicine capsule, a rocket is a finned cylinder with a nose cone); never substitute ' +
	'a different object. ' +
	BRAND_MARK_DIRECTIVE +
	'Always end with these composition constraints so the ' +
	'reference image reconstructs cleanly: full subject in frame, centered, isolated on a plain neutral ' +
	'background, one camera angle, even studio lighting, no cropping, no motion blur, no text or watermark, no ' +
	'collage or multi-view grid, no second subject. Output ONLY the rewritten prompt as a single line — no ' +
	'preamble, no quotes.';

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
	'whole character (pick one: photoreal, stylized, low-poly, hand-painted — never mix styles), (5) key ' +
	'identifying features (hair, face, color scheme, accessories). If the idea names a brand, meme, or term ' +
	'you do not recognize, keep the user\'s stated character concept as the subject and render its canonical ' +
	'look; never substitute a different character. Always end with these composition ' +
	'constraints: full body in frame head-to-toe, centered, isolated on a plain neutral background, no props ' +
	'gripped or crossing the silhouette, one camera angle facing the character, even studio lighting, no ' +
	'cropping, no motion blur, no text or watermark, no collage or multi-view grid, no second character. ' +
	'Output ONLY the rewritten prompt as a single line — no preamble, no quotes.';
