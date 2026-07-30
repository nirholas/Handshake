// Procedural prop catalog: the shared source of truth for the autonomous forge
// prop space. The pipeline (forge-content.js) reads it to pick what to buy next;
// the public feed (api/forged.js) reads CATEGORIES to validate its ?category
// filter. Keeping both on this one module is deliberate: when the two lists were
// declared separately they drifted, and the feed rejected every real category
// while accepting four names that matched nothing.

// ── Procedural prop catalog ────────────────────────────────────────────────────
// Combinatorial text→3D prompt space, aligned to the surfaces that actually
// consume props: the /forged gallery, the /club stage, AR Studio placements,
// diorama set-dressing, and avatar-adjacent items. Each category holds base
// SUBJECTS; STYLES and FINISHES multiply them into thousands of distinct
// prompts (8 categories × ~8 subjects × 10 styles × 8 finishes ≈ 5k combos),
// so at 24-48 props/day the catalog effectively never loops, while staying
// fully deterministic per hour (see nextForgeProp).
export const PROP_CATALOG = Object.freeze({
	'club-decor': [
		'a DJ booth with turntables and a mixer',
		'a large stage loudspeaker stack',
		'a mirrored disco ball on a short chain mount',
		'a neon bar sign on a metal frame',
		'a velvet-rope stanchion pair',
		'a cocktail bar counter with bottle shelf',
		'a stage spotlight rig on a tripod',
		'a standing subwoofer cabinet with glowing ring',
	],
	'ar-object': [
		'a potted monstera plant in a ceramic pot',
		'a desk lamp with an articulated arm',
		'a retro arcade cabinet',
		'a coffee table with a glass top',
		'a floor-standing globe on a wooden stand',
		'a vintage record player console',
		'a small bookshelf filled with books',
		'a pedestal fan with round cage',
	],
	'diorama-set': [
		'a market stall with a striped awning',
		'a stone fountain with a round basin',
		'a wrought-iron street lamppost',
		'a small arched footbridge',
		'a phone booth',
		'a food cart with an umbrella',
		'a park bench with cast-iron ends',
		'a windmill with cloth sails',
	],
	'avatar-item': [
		'a wide-brim wizard hat',
		'a hiking backpack with straps and buckles',
		'a round wooden shield with a metal boss',
		'an electric guitar with a strap',
		'a katana with sheath',
		'a pirate tricorn hat',
		'a skateboard with printed deck art',
		'a knight helmet with hinged visor',
	],
	vehicle: [
		'a compact hover scooter',
		'a vintage moped',
		'a go-kart with roll bar',
		'a small wooden rowboat with oars',
		'a delivery drone with four rotors',
		'a bumper car',
		'a snowmobile',
		'a hot air balloon with basket',
	],
	container: [
		'a wooden shipping crate with iron-banded corners',
		'a barrel with riveted hoops',
		'a treasure chest with a heavy hasp',
		'a sci-fi cargo pod with glowing seams',
		'a stack of supply crates with stenciled markings',
		'a coolant drum with warning decals',
		'an apothecary cabinet with small drawers',
		'a woven picnic basket with hinged lids',
	],
	furniture: [
		'a tavern stool, three-legged and hand-carved',
		'a banquet table of heavy planks',
		'a worn leather armchair with brass studs',
		'an ornate writing desk with drawers',
		'a canopy bed with carved posts',
		'a rocking chair',
		'a bar cart on casters',
		'a folding director chair',
	],
	terrain: [
		'a modular rocky cliff terrain tile with seamless edges',
		'a desert dune terrain tile with sparse rocks',
		'a snowy mountain terrain tile with jagged ice',
		'a lush grassland terrain tile with scattered boulders',
		'a volcanic terrain tile with glowing lava veins',
		'a coral reef seabed terrain tile',
		'a mossy forest floor terrain tile with roots',
		'a cracked salt-flat terrain tile',
	],
});

// Style and finish axes multiply the subject list. Every entry must read well
// appended to any subject above; no contradictions with category wording.
export const STYLES = Object.freeze([
	'low-poly game-ready',
	'stylized hand-painted',
	'realistic PBR textured',
	'sci-fi with glowing accents',
	'medieval fantasy',
	'steampunk with brass fittings',
	'weathered post-apocalyptic',
	'clean minimalist modern',
	'voxel blocky',
	'retro 1980s neon',
]);
export const FINISHES = Object.freeze([
	'matte finish',
	'worn paint and scuffed edges',
	'polished metal highlights',
	'rich wood grain',
	'soft pastel palette',
	'bold saturated colors',
	'rusted and patinated',
	'iridescent sheen',
]);

export const CATEGORIES = Object.freeze(Object.keys(PROP_CATALOG));
