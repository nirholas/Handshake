// Curation layer over the runtime animation manifest (/public/animations/manifest.json).
//
// The manifest is a flat list of built clips. This module groups those clips
// into human-readable categories and marks a small "featured" set (the actions
// users reach for first: idle, walk, jump, wave, dance, celebrate) so the
// gallery can lead with them. It adds no clips of its own — every entry shown
// is a real, retargetable clip the build produced. Clips with no explicit
// category fall through to "More", so adding a clip to the manifest never makes
// it disappear from the gallery.

// Ordered category definitions. `key` matches values in CLIP_CATEGORIES.
export const CATEGORIES = [
	{ key: 'idle', label: 'Idle & Stand', icon: '🧍' },
	{ key: 'locomotion', label: 'Locomotion', icon: '🚶' },
	{ key: 'dance', label: 'Dance', icon: '💃' },
	{ key: 'gesture', label: 'Gestures', icon: '👋' },
	{ key: 'action', label: 'Action & Combat', icon: '🥊' },
	{ key: 'sport', label: 'Sports', icon: '⚽' },
	{ key: 'reaction', label: 'Reactions & Falls', icon: '😲' },
	{ key: 'fitness', label: 'Fitness & Yoga', icon: '🧘' },
	{ key: 'farming', label: 'Farming & Chores', icon: '🌱' },
	{ key: 'more', label: 'More', icon: '✨' },
];

// Clip name → category key. Names mirror manifest.json / animations.config.json.
export const CLIP_CATEGORIES = Object.freeze({
	// Idle & stand
	idle: 'idle',
	'av-idle-breath': 'idle',
	'av-waiting': 'idle',
	'av-idle-anim': 'idle',
	'av-idle-male': 'idle',
	'av-idle-female': 'idle',
	'av-chilling': 'idle',
	'av-pose1': 'idle',
	'av-leaning-wall': 'idle',
	'av-smoking': 'idle',
	'av-listening-music': 'idle',
	standup: 'idle',
	coverstand: 'idle',
	// Locomotion
	walk: 'locomotion',
	'av-walk-feminine': 'locomotion',
	'av-walk-crouching': 'locomotion',
	stepback: 'locomotion',
	dodge: 'locomotion',
	// Dance
	dance: 'dance',
	rumba: 'dance',
	silly: 'dance',
	thriller: 'dance',
	capoeira: 'dance',
	'av-dance-shuffle': 'dance',
	'av-headbang': 'dance',
	'av-boxer-dance': 'dance',
	'av-rap-dance': 'dance',
	'av-offabean-dance': 'dance',
	'av-banging-tunes': 'dance',
	'av-conductor': 'dance',
	// Gestures & expression
	wave: 'gesture',
	'av-call-me': 'gesture',
	'av-brag-claps': 'gesture',
	pray: 'gesture',
	kiss: 'gesture',
	taunt: 'gesture',
	'av-vtubing': 'gesture',
	'av-spy': 'gesture',
	'av-joy': 'gesture',
	facepalm: 'gesture',
	angry: 'gesture',
	lookdown: 'gesture',
	covereyes: 'gesture',
	// Celebrations
	celebrate: 'gesture',
	'av-celebrating': 'gesture',
	'av-cheering': 'gesture',
	// Action & combat
	jump: 'action',
	'av-superhero-jump': 'action',
	'av-back-flip': 'action',
	'av-gymnastics-aerial': 'action',
	'av-muay-thai': 'action',
	'av-chest-bump': 'action',
	'av-arm-flex': 'action',
	'av-flexing-arm': 'action',
	'av-push-block': 'action',
	'av-stand-crouch-stand': 'action',
	removing: 'action',
	// Sports
	header: 'sport',
	goalkeeper: 'sport',
	// Reactions & falls
	reaction: 'reaction',
	shoved: 'reaction',
	defeated: 'reaction',
	dying: 'reaction',
	falling: 'reaction',
	falltolanding: 'reaction',
	jumpdown: 'reaction',
	jumpdown2: 'reaction',
	jumpdown3: 'reaction',
	sitclap: 'reaction',
	sitlaugh: 'reaction',
	// Fitness & yoga
	downdog: 'fitness',
	// Farming & chores
	digging: 'farming',
	'farm-dig-plant': 'farming',
	'farm-pull-plant': 'farming',
	'farm-plant-tree': 'farming',
	'farm-plant-a-plant': 'farming',
	'farm-watering': 'farming',
	'farm-pick-fruit': 'farming',
	'farm-cow-milking': 'farming',
	'farm-kneeling-idle': 'farming',
	'farm-box-idle': 'farming',
	'farm-box-walk': 'farming',
	'farm-box-turn': 'farming',
	'farm-holding-walk': 'farming',
	'farm-holding-turn-left': 'farming',
	'farm-holding-turn-right': 'farming',
	'farm-wheelbarrow-idle': 'farming',
	'farm-wheelbarrow-walk': 'farming',
	'farm-wheelbarrow-turn': 'farming',
	'farm-wheelbarrow-dump': 'farming',
});

// The headline actions. Order is intentional — it's the row users see first.
export const FEATURED = ['idle', 'walk', 'jump', 'wave', 'dance', 'celebrate'];

/** Category key for a clip, defaulting to 'more'. */
export function categoryOf(name) {
	return CLIP_CATEGORIES[name] || 'more';
}

/**
 * Group manifest defs into ordered, non-empty categories, and resolve the
 * featured defs (in FEATURED order). Defs keep their manifest shape plus an
 * added `category` key.
 *
 * @param {Array<{name:string,label?:string,icon?:string,loop?:boolean,url:string}>} defs
 * @returns {{ featured: Array, groups: Array<{key:string,label:string,icon:string,items:Array}> }}
 */
export function curate(defs) {
	const byName = new Map(defs.map((d) => [d.name, { ...d, category: categoryOf(d.name) }]));
	const tagged = [...byName.values()];

	const featured = FEATURED.map((n) => byName.get(n)).filter(Boolean);

	const groups = CATEGORIES.map((cat) => ({
		...cat,
		items: tagged
			.filter((d) => d.category === cat.key)
			.sort((a, b) => (a.label || a.name).localeCompare(b.label || b.name)),
	})).filter((g) => g.items.length > 0);

	return { featured, groups };
}
