// Forge model-category classifier.
//
// Every forge_creations row carries a model_category (avatar / accessory / item
// / scene / creature / vehicle / other) that drives the coloured category badges
// and category filtering across the showcase, gallery, Forge-Off board, creator
// portfolios, and search. But nothing ever set it: the generation lanes call
// createCreation without a category, so ~99% of finished models default to
// 'other' and the whole category dimension is dead.
//
// This is the missing classifier. It reads the prompt — the only signal we have
// at generation time — and maps it to a category with a keyword match, ordered
// most-specific first so "a knight riding a horse" reads as a character (avatar)
// rather than an animal (creature). Deterministic, dependency-free, and cheap
// enough to run inline on every generation and to backfill the existing corpus.
//
// It is intentionally high-precision, not exhaustive: a prompt that matches
// nothing stays 'other' rather than being force-fit. Even partial coverage turns
// a monochrome wall of "other" into a browsable, colour-coded gallery.

// Keyword STEMS (singular) per category. A generic `(?:e?s)?` plural suffix is
// appended when the group regex is built, so "fox"→"foxes", "cat"→"cats",
// "horse"→"horses" all match from one stem — no hand-encoded plurals to get
// wrong. Irregular plurals that the suffix can't reach (wolves, elves, mice…)
// are listed alongside their singular as extra stems.
const GROUPS = [
	// People / characters first — a humanoid subject dominates whatever it holds,
	// wears, or rides.
	[
		'avatar',
		[
			'avatar', 'character', 'human', 'person', 'people', 'man', 'men', 'woman', 'women',
			'boy', 'girl', 'kid', 'child', 'children', 'guy', 'lady', 'ladies', 'knight', 'warrior',
			'wizard', 'mage', 'sorcerer', 'witch', 'soldier', 'king', 'queen', 'prince', 'princess',
			'hero', 'heroine', 'ninja', 'samurai', 'pirate', 'viking', 'elf', 'elves', 'dwarf', 'dwarves',
			'angel', 'demon', 'devil', 'god', 'goddess', 'astronaut', 'cosmonaut', 'spaceman', 'superhero',
			'villain', 'zombie', 'skeleton', 'ghost', 'mummy', 'clown', 'chef', 'cook', 'doctor', 'nurse',
			'policeman', 'firefighter', 'cowboy', 'gladiator', 'assassin', 'mascot', 'figurine', 'bust',
			'portrait', 'fairy', 'mermaid', 'genie', 'robot', 'android', 'cyborg',
		],
	],
	// Animals / monsters / mythical beasts.
	[
		'creature',
		[
			'creature', 'animal', 'beast', 'monster', 'dragon', 'dinosaur', 'dino', 'cat', 'kitten', 'dog',
			'puppy', 'fox', 'wolf', 'wolves', 'bear', 'lion', 'tiger', 'leopard', 'panther', 'horse', 'pony',
			'unicorn', 'deer', 'elk', 'moose', 'rabbit', 'bunny', 'mouse', 'mice', 'rat', 'hamster', 'squirrel',
			'bird', 'eagle', 'owl', 'parrot', 'penguin', 'duck', 'chicken', 'rooster', 'fish', 'shark', 'whale',
			'dolphin', 'octopus', 'squid', 'crab', 'lobster', 'turtle', 'tortoise', 'frog', 'toad', 'lizard',
			'snake', 'serpent', 'crocodile', 'alligator', 'spider', 'scorpion', 'ant', 'bee', 'butterfly',
			'beetle', 'bug', 'insect', 'slime', 'goblin', 'orc', 'ogre', 'troll', 'griffin', 'phoenix', 'hydra',
			'kraken', 'yeti', 'cow', 'bull', 'pig', 'piglet', 'sheep', 'goat', 'elephant', 'giraffe', 'zebra',
			'rhino', 'hippo', 'monkey', 'ape', 'gorilla', 'kangaroo', 'koala', 'panda', 'sloth', 'raccoon',
			'hedgehog', 'bat', 'snail', 'crow', 'raven', 'fox',
		],
	],
	// Vehicles / craft.
	[
		'vehicle',
		[
			'vehicle', 'car', 'truck', 'van', 'bus', 'jeep', 'taxi', 'ambulance', 'tractor', 'bulldozer',
			'forklift', 'motorcycle', 'motorbike', 'scooter', 'bicycle', 'bike', 'trike', 'ship', 'boat',
			'yacht', 'sailboat', 'submarine', 'canoe', 'kayak', 'ferry', 'plane', 'airplane', 'aeroplane',
			'jet', 'biplane', 'glider', 'helicopter', 'chopper', 'rocket', 'spaceship', 'spacecraft',
			'starship', 'shuttle', 'ufo', 'tank', 'train', 'locomotive', 'tram', 'trolley', 'cart', 'wagon',
			'chariot', 'sled', 'sleigh', 'snowmobile', 'hovercraft', 'mech', 'mecha',
		],
	],
	// Environments / places / architecture.
	[
		'scene',
		[
			'scene', 'environment', 'landscape', 'diorama', 'world', 'level', 'room', 'interior', 'kitchen',
			'bedroom', 'bathroom', 'office', 'classroom', 'house', 'home', 'cottage', 'cabin', 'hut', 'tent',
			'castle', 'palace', 'fortress', 'tower', 'temple', 'shrine', 'church', 'cathedral', 'mosque',
			'pyramid', 'dungeon', 'cave', 'cavern', 'mine', 'city', 'cities', 'town', 'village', 'street',
			'alley', 'bridge', 'dock', 'pier', 'harbor', 'harbour', 'station', 'airport', 'factory', 'factories',
			'warehouse', 'barn', 'farm', 'garden', 'park', 'forest', 'jungle', 'wood', 'desert', 'beach',
			'island', 'mountain', 'valley', 'canyon', 'cliff', 'volcano', 'glacier', 'arena', 'stadium',
			'colosseum', 'market', 'shop', 'store', 'cafe', 'bar', 'tavern', 'inn', 'library', 'libraries',
			'museum', 'lab', 'laboratory', 'battlefield', 'campsite', 'playground', 'gate',
		],
	],
	// Wearables, held gear, and weapons — things worn or wielded.
	[
		'accessory',
		[
			'helmet', 'helm', 'hat', 'cap', 'crown', 'tiara', 'mask', 'goggle', 'glasses', 'sunglasses',
			'monocle', 'visor', 'ring', 'necklace', 'amulet', 'pendant', 'locket', 'bracelet', 'earring',
			'brooch', 'armor', 'armour', 'breastplate', 'gauntlet', 'greave', 'pauldron', 'shield', 'buckler',
			'sword', 'katana', 'blade', 'dagger', 'knife', 'knives', 'axe', 'hatchet', 'mace', 'hammer',
			'warhammer', 'club', 'spear', 'lance', 'halberd', 'scythe', 'bow', 'crossbow', 'arrow', 'quiver',
			'gun', 'pistol', 'revolver', 'rifle', 'shotgun', 'musket', 'cannon', 'bazooka', 'blaster',
			'lightsaber', 'weapon', 'staff', 'staves', 'wand', 'scepter', 'sceptre', 'glove', 'boot', 'shoe',
			'sandal', 'sneaker', 'belt', 'sash', 'cape', 'cloak', 'scarf', 'scarves', 'backpack', 'satchel',
			'purse', 'handbag', 'wallet', 'watch',
		],
	],
	// Concrete everyday objects and props.
	[
		'item',
		[
			'item', 'object', 'prop', 'chair', 'stool', 'bench', 'sofa', 'couch', 'table', 'desk', 'shelf',
			'shelves', 'cabinet', 'drawer', 'wardrobe', 'bed', 'lamp', 'lantern', 'candle', 'torch',
			'chandelier', 'cup', 'mug', 'goblet', 'bottle', 'flask', 'jug', 'jar', 'vase', 'pot', 'teapot',
			'kettle', 'pan', 'bowl', 'plate', 'dish', 'fork', 'spoon', 'barrel', 'keg', 'crate', 'box', 'chest',
			'basket', 'bucket', 'bag', 'sack', 'book', 'tome', 'scroll', 'map', 'key', 'lock', 'coin', 'gem',
			'crystal', 'diamond', 'jewel', 'treasure', 'potion', 'elixir', 'camera', 'phone', 'smartphone',
			'laptop', 'computer', 'keyboard', 'monitor', 'television', 'tv', 'radio', 'clock', 'hourglass',
			'compass', 'telescope', 'microscope', 'binocular', 'tool', 'wrench', 'screwdriver', 'drill', 'saw',
			'toy', 'doll', 'teddy', 'ball', 'die', 'dice', 'cube', 'block', 'flower', 'plant', 'tree', 'bush',
			'cactus', 'cacti', 'mushroom', 'fruit', 'apple', 'banana', 'food', 'cake', 'cookie', 'donut',
			'burger', 'pizza', 'bread', 'instrument', 'guitar', 'piano', 'drum', 'violin', 'trumpet', 'flute',
			'mirror', 'frame', 'painting', 'statue', 'sculpture', 'trophy', 'medal', 'sign', 'banner', 'flag',
			'umbrella', 'fan', 'gadget', 'machine', 'engine', 'gear', 'drone',
		],
	],
];

// Escape regex metacharacters in a stem (none of ours have any today, but keeps
// the builder safe) and join into one alternation with a generic plural suffix.
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const RULES = GROUPS.map(([category, stems]) => [
	category,
	// `(?:e?s)?` matches "", "s", or "es" so one singular stem covers regular and
	// -es plurals (cat/cats, fox/foxes, horse/horses).
	new RegExp(`\\b(?:${stems.map(escape).join('|')})(?:e?s)?\\b`, 'i'),
]);

/**
 * Classify a forge prompt into a model_category. Returns one of the seven
 * MODEL_CATEGORIES; falls back to 'other' when nothing matches (or the prompt is
 * empty). Deterministic and side-effect free.
 * @param {string} prompt
 * @returns {'avatar'|'accessory'|'item'|'scene'|'creature'|'vehicle'|'other'}
 */
export function classifyModelCategory(prompt) {
	if (typeof prompt !== 'string' || !prompt.trim()) return 'other';
	const p = prompt.toLowerCase();
	for (const [category, re] of RULES) {
		if (re.test(p)) return category;
	}
	return 'other';
}
