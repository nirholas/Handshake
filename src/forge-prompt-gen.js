// Forge prompt generator: truly random prompts that reliably forge well.
//
// Instead of sampling a fixed list, "Surprise me" and the example chips draw
// from curated slot grammars: each family combines a subject pool with only
// the materials, finishes, and bases that suit it, so every one of the tens
// of thousands of possible prompts stays inside what the TRELLIS lane
// reconstructs beautifully (single isolated subject, chunky silhouette, a
// named material, no thin wires, no glass-only builds, no multi-object
// scenes). The family design mirrors the prompt coach in
// forge-prompt-studio.js: every generated prompt carries a material word and
// never trips the multi-subject heuristics.
//
// Pure module, no DOM: consumed by the Forge page UI and unit-tested
// directly (tests/forge-prompt-gen.test.js). `rng` is injectable so tests
// can seed it; the UI passes nothing and gets Math.random.

const pick = (arr, rng) => arr[Math.floor(rng() * arr.length)];
// Article-aware join for slots that can start with a vowel ("an amethyst
// geode"). Good enough for this vocabulary; no silent-h words in the pools.
const art = (phrase) => `${/^[aeiou]/.test(phrase) ? 'an' : 'a'} ${phrase}`;

// ── Family: statues & sculpture ─────────────────────────────────────────
// Sculpture is the single strongest TRELLIS category: solid silhouette,
// and patina/roughness reads as intentional surface detail.
const STATUE_SUBJECTS = [
	'an astronaut',
	'a ballerina mid-twirl',
	'a seated lion',
	'a coiled dragon',
	'a meditating monk',
	'a chess knight',
	'a perched owl',
	'a rearing horse',
	'a leaping koi fish',
	'a curled-up cat',
	'a standing bear',
	'a twisting abstract ribbon',
];
const STATUE_MATERIALS = [
	['weathered bronze', 'green patina'],
	['carved white marble', 'soft grey veining'],
	['polished black obsidian', 'glassy sheen'],
	['terracotta', 'warm matte finish'],
	['carved jade', 'polished deep green'],
	['sandstone', 'wind-worn texture'],
	['cast concrete', 'brutalist finish'],
	['gilded bronze', 'warm gold sheen'],
	['carved walnut', 'oiled wood grain'],
	['celadon ceramic', 'crackle glaze'],
];
const STATUE_BASES = [
	'on a square stone plinth',
	'on a round marble base',
	'on a black granite pedestal',
	'museum piece, soft studio light',
];

// ── Family: creature figurines ──────────────────────────────────────────
// Style pairs a material adjective with the finish cue that sells it.
const FIGURINE_STYLES = [
	['low-poly', 'faceted matte surface'],
	['glazed porcelain', 'soft studio light'],
	['plush felt', 'stitched seams'],
	['brass clockwork', 'polished gears'],
	['carved wood', 'hand-painted details'],
	['hand-sculpted clay', 'chunky rounded shapes'],
	['knitted wool', 'chunky yarn texture'],
];
const FIGURINE_ANIMALS = [
	'red fox',
	'axolotl',
	'hedgehog',
	'barn owl',
	'octopus',
	'humpback whale',
	'sea turtle',
	'bear cub',
	'tree frog',
	'penguin',
	'highland cow',
	'dachshund',
	'chameleon',
	'baby elephant',
];

// ── Family: potted plants ───────────────────────────────────────────────
const PLANTS = [
	'monstera',
	'fiddle-leaf fig',
	'jade succulent',
	'aloe vera',
	'trailing pothos',
	'bonsai juniper',
	'barrel cactus',
	'lavender bush',
	'boston fern',
	'flowering orchid',
];
const POTS = [
	'a terracotta pot',
	'a glazed cobalt ceramic pot',
	'a ribbed concrete planter',
	'a woven rattan basket',
	'a hammered copper pot',
	'a matte black ceramic planter',
	'a speckled stoneware pot',
];

// ── Family: crystals & geodes ───────────────────────────────────────────
const MINERALS = [
	'amethyst',
	'rose quartz',
	'emerald fluorite',
	'golden citrine',
	'deep blue azurite',
	'smoky quartz',
	'turquoise',
	'malachite',
];

// ── Family: food & bakery ───────────────────────────────────────────────
const FOODS = [
	['a glazed chocolate donut with rainbow sprinkles', 'glossy icing'],
	['a layered strawberry cake on a ceramic stand', 'smooth buttercream'],
	['a rustic sourdough loaf', 'floury matte crust'],
	['a ripe pomegranate split open', 'glossy ruby seeds'],
	['a stack of pastel macarons', 'glossy smooth shells'],
	['a honey jar with a wooden dipper', 'warm golden light'],
	['a steaming bowl of ramen', 'glossy ceramic bowl'],
	['a watermelon with a cut wedge', 'glossy rind, juicy red flesh'],
];

// ── Family: crafted props ───────────────────────────────────────────────
// Each builder owns its object's compatible variants, so a teapot never
// comes out in wrought iron nor a lantern in buttercream.
const PROP_BUILDERS = [
	(rng) =>
		`a glazed ceramic teapot, ${pick(['cobalt blue', 'oxblood red', 'matte sage green', 'speckled cream'], rng)}, studio lighting`,
	(rng) =>
		`a ${pick(['brass', 'copper', 'wrought iron'], rng)} storm lantern, weathered patina, warm glow`,
	(rng) => `a treasure chest, ${pick(['dark oak', 'weathered cedar', 'ebony wood'], rng)}, tarnished iron bands`,
	(rng) =>
		`a ${pick(['worn cognac leather', 'mustard velvet', 'deep green velvet', 'charcoal wool'], rng)} armchair, studio lighting`,
	(rng) =>
		`a knight helm, ${pick(['dark polished steel', 'brass-trimmed steel', 'blackened iron'], rng)}, plumed crest`,
	(rng) =>
		`a tall ceramic vase, ${pick(['crackle-glazed turquoise', 'matte terracotta', 'cobalt-striped white'], rng)}`,
	(rng) =>
		`a retro radio, ${pick(['cream bakelite', 'mint green enamel', 'walnut with brass dials'], rng)}`,
	(rng) =>
		`a vintage film camera, brushed aluminium, ${pick(['black', 'tan', 'burgundy'], rng)} leather grip`,
	(rng) =>
		`a wizard staff, gnarled ${pick(['oak', 'blackthorn', 'driftwood'], rng)}, embedded ${pick(['amber', 'sapphire', 'emerald'], rng)} gem`,
	(rng) =>
		`a stack of hardcover books, ${pick(['aged cloth binding', 'embossed leather covers', 'linen spines, gilt titles'], rng)}`,
];

// ── Family: cozy miniatures ─────────────────────────────────────────────
const MINI_BUILDERS = [
	(rng) =>
		`a cozy mushroom cottage, thatched roof, ${pick(['moss-covered stone base', 'round oak door', 'stone chimney'], rng)}`,
	(rng) => `a small lighthouse, ${pick(['red', 'teal', 'navy'], rng)}-striped enamel paint, rocky stone base`,
	(rng) =>
		`a low-poly camper van, ${pick(['pastel teal', 'butter yellow', 'salmon pink'], rng)} paint, chrome bumper`,
	(rng) =>
		`a hot air balloon, ${pick(['striped red-cream', 'patchwork rainbow', 'teal-gold'], rng)} canvas, wicker basket`,
	(rng) => `a dutch windmill, ${pick(['red brick', 'whitewashed stone', 'dark timber wood'], rng)} tower, canvas sails`,
	(rng) => `a tiny houseboat, painted wooden hull, ${pick(['sage green', 'ochre', 'sky blue'], rng)} rounded cabin`,
];

// One builder per family. Exported so tests can exercise each family
// directly; generateForgePrompt samples them uniformly.
export const FAMILIES = [
	function statue(rng) {
		const [adj, detail] = pick(STATUE_MATERIALS, rng);
		return `a ${adj} statue of ${pick(STATUE_SUBJECTS, rng)}, ${detail}, ${pick(STATUE_BASES, rng)}`;
	},
	function figurine(rng) {
		const [adj, finish] = pick(FIGURINE_STYLES, rng);
		return `a ${adj} ${pick(FIGURINE_ANIMALS, rng)} figurine, ${finish}`;
	},
	function plant(rng) {
		return `a potted ${pick(PLANTS, rng)} in ${pick(POTS, rng)}, soft studio light`;
	},
	function crystal(rng) {
		const mineral = pick(MINERALS, rng);
		return rng() < 0.5
			? `a cluster of ${mineral} crystals on raw grey rock, glossy facets`
			: `${art(mineral)} geode, sparkling crystal core, soft studio light`;
	},
	function food(rng) {
		const [subject, finish] = pick(FOODS, rng);
		return `${subject}, ${finish}`;
	},
	function prop(rng) {
		return pick(PROP_BUILDERS, rng)(rng);
	},
	function mini(rng) {
		return pick(MINI_BUILDERS, rng)(rng);
	},
];

// Family draw weights, proportional to each grammar's combinatorial size:
// uniform selection would over-sample the small pools (food, crystals) and
// make repeats feel common. Order matches FAMILIES.
const FAMILY_WEIGHTS = [5, 3, 2, 1, 1, 2, 1];
const WEIGHTED_FAMILY_INDEX = FAMILY_WEIGHTS.flatMap((w, i) => Array(w).fill(i));

/** One random prompt, guaranteed to be a single isolated subject with a
 * material cue (the shape the Forge lane meshes cleanest). */
export function generateForgePrompt(rng = Math.random) {
	return FAMILIES[pick(WEIGHTED_FAMILY_INDEX, rng)](rng);
}

/** `count` distinct prompts, none of which appear in `avoid`, used so
 * "Surprise me" and "More ideas" never echo what is already on screen.
 * `maxLength` filters to prompts that fit compact UI (example chips). */
export function generateDistinctForgePrompts(count, avoid = new Set(), rng = Math.random, maxLength = Infinity) {
	const out = [];
	const seen = new Set(avoid);
	// The combinatorial space is ~10^4, so collisions are rare; the attempt
	// cap only guards against a caller asking for more than the space holds.
	for (let attempts = 0; out.length < count && attempts < count * 40; attempts++) {
		const prompt = generateForgePrompt(rng);
		if (prompt.length > maxLength || seen.has(prompt)) continue;
		seen.add(prompt);
		out.push(prompt);
	}
	return out;
}
