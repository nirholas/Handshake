// Brand-mark lexicon for text→3D logo prompts.
//
// Text→3D runs text→image→mesh: neither the prompt director LLM nor the image
// model reliably knows what a niche brand mark looks like, so a raw prompt like
// "pumpfun logo" reconstructs as a generic badge covered in garbled lettering.
// This module resolves well-known marks DETERMINISTICALLY: when a prompt is
// essentially "<known brand> logo" (or just the brand name), it returns a
// concrete geometric description of the real mark, written so the image model
// draws shapes, never text. Anything more specific than brand+mark words falls
// through to the LLM director, which carries BRAND_MARK_DIRECTIVE below.
//
// Dependency-free on purpose: this file ships in the published mcp-server npm
// package AND loads in the hosted api/ bundle (api/_lib/forge-director-prompts.js
// and the studio lanes import it), so it may import nothing.
//
// The emitted specs intentionally never contain the brand name: if the image
// model sees "pump.fun" it will try to letter the word onto the mesh, and
// letterforms reconstruct as noise.

// Mirror of the composition constraints the Granite mesh director appends, so a
// lexicon hit reconstructs under the same framing rules as a directed prompt.
const COMPOSITION_TAIL =
	'full subject in frame, centered, isolated on a plain neutral background, one camera angle, ' +
	'even studio lighting, no cropping, no motion blur, no text or watermark, no collage or ' +
	'multi-view grid, no second subject';

// Shared director clause: how the LLM director should handle brand/logo ideas
// the lexicon did not resolve. Imported by every mesh-director instruction so
// the guidance cannot drift between the api/ and mcp-server copies.
export const BRAND_MARK_DIRECTIVE =
	'If the idea names a brand, company, app, or crypto token and asks for its logo, icon, or mark, ' +
	'describe the mark ITSELF as one solid extruded dimensional emblem: its real geometric shapes, ' +
	'proportions, and exact brand colors if you know them; if you do not know the mark, describe a ' +
	'clean minimal abstract geometric emblem in the brand color instead. Never repeat the brand name ' +
	'in your output and never invent lettering, wordmarks, badges, or slogan text: rendered text ' +
	'reconstructs as unreadable noise. ';

// Each entry: aliases are matched in normalized space (lowercase, punctuation
// collapsed to single spaces). `bare` aliases resolve even without a mark word
// ("pumpfun" alone clearly wants the mark); short ticker aliases require an
// explicit mark word ("sol logo" yes, bare "sol" no).
//
// `image` (optional) is a deployment-relative path to a pre-rendered reference
// view of the mark under public/marks/. When present, call-sites submit
// image→3D against `<base><image>` instead of gambling on the text→image draw:
// live E2E showed the text lane reconstructs the right SHAPE but rolls random
// colorways (red/white, green/teal) run to run, while the reference view
// reconstructs the exact mark every time. The spec prompt still rides along as
// the caption and as the fallback for callers that cannot do image mode.
const BRANDS = [
	{
		id: 'pump.fun',
		aliases: ['pumpfun', 'pump fun', '$pump'],
		bare: ['pumpfun', 'pump fun', '$pump'],
		image: '/marks/pump-fun.png',
		spec:
			'A single glossy two-part gel capsule pill tilted diagonally at 45 degrees, two smooth ' +
			'cylindrical halves with rounded hemispherical ends joined at a crisp center seam, upper half ' +
			'vivid spring green, lower half clean white, smooth glossy plastic PBR surface with soft ' +
			'specular highlights, subtle seam ridge detail, clean minimal stylized look, ' +
			COMPOSITION_TAIL,
	},
	{
		id: 'bitcoin',
		aliases: ['bitcoin', 'btc', '$btc'],
		bare: ['bitcoin'],
		spec:
			'A single thick round coin standing upright, polished metallic orange-gold PBR finish, face ' +
			'embossed with one large tilted capital letter B crossed by two short vertical strokes at top ' +
			'and bottom, raised circular rim, subtle brushed-metal grain, clean stylized look, ' +
			COMPOSITION_TAIL,
	},
	{
		id: 'ethereum',
		aliases: ['ethereum', 'eth', '$eth', 'ether'],
		bare: ['ethereum'],
		spec:
			'A single faceted octahedron gemstone, two four-sided pyramids joined base to base with a thin ' +
			'horizontal split gap between the upper and lower halves, mirror symmetric, polished ' +
			'silver-grey crystalline PBR surface with crisp flat facets and sharp edges, clean minimal ' +
			'stylized look, ' +
			COMPOSITION_TAIL,
	},
	{
		id: 'solana',
		aliases: ['solana', 'sol', '$sol'],
		bare: ['solana'],
		spec:
			'A single emblem of three identical flat parallelogram bars stacked horizontally with even ' +
			'gaps, the top and bottom bars slanting one way and the middle bar slanting the opposite way, ' +
			'each bar extruded with slight thickness, smooth PBR surface with a vibrant purple to teal ' +
			'gradient flowing across the bars, clean minimal stylized look, ' +
			COMPOSITION_TAIL,
	},
	{
		id: 'dogecoin',
		aliases: ['dogecoin', 'doge', '$doge'],
		bare: ['dogecoin'],
		spec:
			'A single thick round coin standing upright, matte gold PBR finish, face embossed with the ' +
			'head of a Shiba Inu dog with pointed ears and a calm sideways glance, raised circular rim ' +
			'with small embossed circular studs, clean stylized look, ' +
			COMPOSITION_TAIL,
	},
];

const MARK_WORDS = new Set([
	'logo',
	'logos',
	'logotype',
	'logomark',
	'icon',
	'symbol',
	'emblem',
	'mark',
	'brandmark',
	'insignia',
	'badge',
	'sign',
]);

// Words that carry no subject information: a prompt made only of brand + mark
// words + filler is "just the logo" and resolves; any other leftover token
// means the user asked for something more specific, so the director handles it.
const FILLER = new Set([
	'a', 'an', 'the', 'of', 'for', 'in', 'as', 'its', 'their', 'this', 'that',
	'one', 'single', 'i', 'me', 'my', 'us', 'we', 'please', 'want', 'need',
	'make', 'makes', 'making', 'generate', 'create', 'render', 'give', 'get',
	'3d', 'dimensional', 'model', 'mesh', 'object', 'asset', 'prop', 'version',
	'official', 'original', 'coin', 'token', 'crypto', 'cryptocurrency', 'brand',
]);

function normalize(text) {
	return String(text || '')
		.toLowerCase()
		.replace(/[^a-z0-9$]+/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
}

// Resolve a prompt that is essentially "<known brand> logo" (or a bare
// unambiguous brand name) into a concrete geometric spec for the real mark.
// Returns { brand, prompt, imagePath } on a hit, null otherwise. Null means:
// not a known mark, or the prompt carries extra intent the deterministic spec
// would drop. `imagePath` (nullable) is deployment-relative; callers that can
// submit image→3D should prefer `<their forge base><imagePath>` over the text
// prompt for an exact reconstruction of the mark.
export function resolveLogoPrompt(rawPrompt) {
	const norm = normalize(rawPrompt);
	if (!norm) return null;
	const padded = ` ${norm} `;
	for (const brand of BRANDS) {
		for (const alias of brand.aliases) {
			if (!padded.includes(` ${alias} `)) continue;
			const rest = padded.replace(` ${alias} `, ' ').trim();
			const tokens = rest ? rest.split(' ') : [];
			const hasMark = tokens.some((t) => MARK_WORDS.has(t));
			const leftover = tokens.filter((t) => !MARK_WORDS.has(t) && !FILLER.has(t));
			if (leftover.length > 0) continue;
			if (hasMark || brand.bare.includes(alias)) {
				return { brand: brand.id, prompt: brand.spec, imagePath: brand.image || null };
			}
		}
	}
	return null;
}
