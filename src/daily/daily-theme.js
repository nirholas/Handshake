// Daily Forge — the deterministic daily creative challenge.
//
// Every UTC day resolves to exactly one theme, the same for everyone, computed
// with no backend and no randomness (so it's testable and every device agrees):
// a stable hash of the YYYY-MM-DD date picks a theme, and a rotation offset keyed
// to the week keeps a theme from repeating on consecutive same-weekday slots.
// A "day number" (days since the launch anchor) gives the challenge a running
// count — "Day 142" — that makes returning feel like a streak worth keeping.
//
// Pure + DOM-free so it unit-tests directly and can run identically on the client
// or in a future cron that pre-renders the day's gallery.

// A curated set of themes the free text→3D lane renders well: single, well-lit
// subjects with a clear material story, no scenes/crowds. Each carries a few
// seed prompts (a tap-to-fill starting point) and an accent for the day's UI.
export const THEMES = Object.freeze([
	{ id: 'tiny-robots', emoji: '🤖', title: 'Tiny Robots', hint: 'A small, characterful robot with a clear personality.', accent: '#7cc4ff', seeds: ['a tiny rusty gardening robot holding a watering can', 'a round chrome barista robot with glowing eyes', 'a cardboard-box robot with mismatched arms'] },
	{ id: 'glass-creatures', emoji: '🫧', title: 'Glass Creatures', hint: 'An animal or creature blown from coloured glass.', accent: '#8be9d6', seeds: ['a koi fish made of swirling stained glass', 'a translucent glass hummingbird mid-flight', 'a frosted-glass fox curled asleep'] },
	{ id: 'cozy-mugs', emoji: '☕', title: 'Cozy Objects', hint: 'A small comforting everyday object, lovingly detailed.', accent: '#f2b880', seeds: ['a chunky handmade ceramic mug with a tiny house painted on it', 'a knitted teapot cozy shaped like a sleeping cat', 'a stack of worn leather-bound books tied with twine'] },
	{ id: 'crystal-relics', emoji: '💎', title: 'Crystal Relics', hint: 'A gemstone artifact — faceted, glowing, precious.', accent: '#c9a8ff', seeds: ['a crystal chess knight glowing from within', 'an amethyst geode cracked open with a tiny city inside', 'a floating quartz compass etched with runes'] },
	{ id: 'micro-plants', emoji: '🪴', title: 'Micro Gardens', hint: 'A tiny potted plant or terrarium world.', accent: '#8fd694', seeds: ['a bonsai tree growing inside a glowing glass cube', 'a mossy terrarium in a lightbulb with a tiny ladder', 'a succulent in a hand-painted face pot'] },
	{ id: 'retro-tech', emoji: '📼', title: 'Retro Tech', hint: 'A nostalgic gadget, faithfully worn and detailed.', accent: '#ff9ec4', seeds: ['a chunky 80s boombox with rainbow buttons', 'a beige retro computer with a smiling face on screen', 'a translucent purple handheld game console'] },
	{ id: 'sweet-treats', emoji: '🍰', title: 'Sweet Treats', hint: 'A dessert good enough to screenshot.', accent: '#ffb3c1', seeds: ['a towering strawberry shortcake with dripping glaze', 'a glossy donut with galaxy sprinkles', 'a matcha parfait in a tall glass with mochi'] },
	{ id: 'brave-knights', emoji: '🛡️', title: 'Brave Little Knights', hint: 'A pint-sized hero in charming armor.', accent: '#a9b4ff', seeds: ['a tiny knight in acorn-cap armor holding a needle sword', 'a chubby corgi in polished plate armor', 'a mushroom knight with a shield made of bark'] },
	{ id: 'deep-sea', emoji: '🐙', title: 'Deep Sea', hint: 'A bioluminescent creature from the dark ocean.', accent: '#6fe3ff', seeds: ['a glowing anglerfish with a lantern of stars', 'a translucent jellyfish trailing neon ribbons', 'a curled-up bioluminescent octopus'] },
	{ id: 'space-junk', emoji: '🛰️', title: 'Space Explorers', hint: 'A little astronaut, rover, or friendly craft.', accent: '#b8b3ff', seeds: ['a stubby one-eyed rover with big wheels', 'a tiny astronaut planting a flag made of candy', 'a round friendly satellite with antenna ears'] },
	{ id: 'autumn', emoji: '🍂', title: 'Autumn Things', hint: 'Something warm, seasonal, and hand-made.', accent: '#f0a868', seeds: ['a carved pumpkin lantern with a cozy grin', 'a woven basket spilling tiny gourds and leaves', 'a candle shaped like a stack of fallen leaves'] },
	{ id: 'music', emoji: '🎸', title: 'Little Instruments', hint: 'A miniature musical instrument, beautifully finished.', accent: '#ffcf70', seeds: ['a tiny lacquered grand piano with glowing keys', 'a hand-painted ukulele with floral inlay', 'a brass trumpet with a snail curled in the bell'] },
	{ id: 'mythic', emoji: '🐉', title: 'Mythic Beasts', hint: 'A small friendly mythical creature.', accent: '#c58bff', seeds: ['a chubby baby dragon hoarding a single gold coin', 'a moss-covered forest spirit with lantern eyes', 'a tiny phoenix made of warm ember glass'] },
	{ id: 'vehicles', emoji: '🚗', title: 'Tiny Vehicles', hint: 'A toy-like vehicle with character.', accent: '#7ad6c0', seeds: ['a rounded bubble-top bug car in mint green', 'a wooden toy submarine with brass portholes', 'a hot-air balloon shaped like a strawberry'] },
	{ id: 'lanterns', emoji: '🏮', title: 'Lights & Lanterns', hint: 'A glowing light source, warm and inviting.', accent: '#ffb15c', seeds: ['a paper lantern shaped like a sleepy moon', 'a firefly jar lamp on a little wooden stand', 'a stained-glass lighthouse the size of a thumb'] },
	{ id: 'winter', emoji: '❄️', title: 'Winter Wonders', hint: 'Something frosty, cozy, or crystalline.', accent: '#9fd8ff', seeds: ['a snow globe with a tiny warm cabin inside', 'a hot cocoa mug topped with a marshmallow snowman', 'an ice-crystal deer standing in soft snow'] },
	{ id: 'birds', emoji: '🐦', title: 'Bright Birds', hint: 'A colorful little bird, richly textured.', accent: '#7fe0a0', seeds: ['a plump origami paper crane unfolding into color', 'an enamel-pin robin with a tiny scarf', 'a peacock made of hand-cut felt'] },
	{ id: 'desserts-2', emoji: '🍄', title: 'Curious Mushrooms', hint: 'A whimsical mushroom, glowing or storybook.', accent: '#f79fb0', seeds: ['a glowing blue mushroom house with round windows', 'a red-cap mushroom with a tiny wooden door', 'a cluster of bioluminescent toadstools on a log'] },
	{ id: 'tools', emoji: '🔧', title: 'Handmade Tools', hint: 'A crafted tool or trinket with worn character.', accent: '#e8b478', seeds: ['a brass pocket compass engraved with stars', 'a wooden-handled magnifying glass with a leather cord', 'a tiny anvil with a glowing horseshoe'] },
	{ id: 'candy', emoji: '🍬', title: 'Candy World', hint: 'An object made of sweets and sugar glass.', accent: '#ff9ecb', seeds: ['a gingerbread cottage with gumdrop shingles', 'a lollipop tree with swirling rainbow candy', 'a chocolate fountain frozen mid-pour'] },
	{ id: 'gems-2', emoji: '🔮', title: 'Fortune & Magic', hint: 'A magical object — orbs, potions, charms.', accent: '#bfa4ff', seeds: ['a glowing crystal ball on a clawed brass stand', 'a bubbling potion bottle with a tiny galaxy inside', 'a spellbook wrapped in glowing chains'] },
	{ id: 'garden-2', emoji: '🌸', title: 'Spring Blooms', hint: 'A flower or blossom, delicate and vivid.', accent: '#ffa6c9', seeds: ['a single glass cherry blossom branch', 'a sunflower with a tiny bee wearing goggles', 'a lotus flower opening over still water'] },
	{ id: 'ghosts', emoji: '👻', title: 'Friendly Spirits', hint: 'A cute, harmless ghost or spirit.', accent: '#b9c2ff', seeds: ['a round sheet-ghost holding a tiny candle', 'a translucent cat spirit with star eyes', 'a shy lantern-ghost with a soft glow'] },
	{ id: 'castles', emoji: '🏰', title: 'Tiny Castles', hint: 'A small storybook building or tower.', accent: '#9fb8ff', seeds: ['a spiral wizard tower on a floating rock', 'a mushroom-topped fairy cottage', 'a sandcastle with real seashell windows'] },
]);

// Anchor the running "Day N" counter to a fixed launch date so the number is
// stable across devices and time zones (UTC midnight boundaries).
const ANCHOR_UTC = Date.UTC(2026, 6, 17); // 2026-07-17, Daily Forge launch
const DAY_MS = 86_400_000;

/** Normalize a Date | ISO string | 'YYYY-MM-DD' to a UTC 'YYYY-MM-DD' key. */
export function utcDayKey(input) {
	let d;
	if (input instanceof Date) d = input;
	else if (typeof input === 'string') {
		// A bare YYYY-MM-DD is parsed as UTC midnight by Date; guard other strings.
		d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(input) ? `${input}T00:00:00Z` : input);
	} else d = new Date(input);
	if (Number.isNaN(d.getTime())) return '';
	return d.toISOString().slice(0, 10);
}

// FNV-1a over the date key — a stable, well-distributed hash with no deps.
function hashKey(key) {
	let h = 0x811c9dc5;
	for (let i = 0; i < key.length; i++) {
		h ^= key.charCodeAt(i);
		h = Math.imul(h, 0x01000193) >>> 0;
	}
	return h >>> 0;
}

/**
 * The running challenge number for a date — days since the launch anchor, 1-based
 * ("Day 1" on launch day). Dates before the anchor clamp to 1.
 * @param {Date|string} input
 * @returns {number}
 */
export function dayNumber(input) {
	const key = utcDayKey(input);
	if (!key) return 1;
	const t = Date.parse(`${key}T00:00:00Z`);
	return Math.max(1, Math.floor((t - ANCHOR_UTC) / DAY_MS) + 1);
}

/**
 * Resolve the theme for a given date. Deterministic: same day → same theme
 * everywhere. A week-indexed rotation offset means the sequence doesn't line up
 * into a fixed 24-day loop, so a given weekday doesn't always draw the same theme.
 * @param {Date|string} [input]  Defaults handled by the caller (pass a real date).
 * @returns {{ id, emoji, title, hint, accent, seeds:string[], day:number, dateKey:string }}
 */
export function themeForDate(input) {
	const dateKey = utcDayKey(input) || '1970-01-01';
	const day = dayNumber(dateKey);
	const week = Math.floor((Date.parse(`${dateKey}T00:00:00Z`) - ANCHOR_UTC) / (DAY_MS * 7));
	const idx = (hashKey(dateKey) + (Number.isFinite(week) ? week * 5 : 0)) % THEMES.length;
	const theme = THEMES[((idx % THEMES.length) + THEMES.length) % THEMES.length];
	return { ...theme, day, dateKey };
}

/** Pick one seed prompt for a date deterministically (stable "starter" per day). */
export function seedForDate(input) {
	const t = themeForDate(input);
	const dateKey = t.dateKey;
	const pick = hashKey(`seed:${dateKey}`) % t.seeds.length;
	return t.seeds[pick];
}
