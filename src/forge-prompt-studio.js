// Forge prompt studio — the text-mode authoring aids that sit under the
// composer: a combinatorial prompt generator behind "Surprise me" and
// "More ideas", a live prompt coach that grades what you typed against how
// the model actually reconstructs, and an honest character counter.
//
// All client-side. Prompts come from src/forge-prompt-gen.js: curated slot
// grammars whose every combination is a single isolated subject with a
// material/lighting cue (the shape Forge meshes cleanest), so the ideas are
// genuinely random without ever leaving the model's sweet spot. Nothing here
// fakes a network call.

import { generateDistinctForgePrompts } from './forge-prompt-gen.js';

const MAXLEN = 1000;
// Example chips stay scannable: only prompts short enough to read at a
// glance are seeded into chip UI ("Surprise me" uses the full range).
const CHIP_MAXLEN = 64;

const $ = (id) => document.getElementById(id);

const els = {
	prompt: $('prompt'),
	surprise: $('surprise'),
	coach: $('prompt-coach'),
	count: $('prompt-count'),
	examples: $('examples'),
	chipsMore: $('chips-more'),
	emptyStarters: $('empty-starters'),
};

// Heuristic lexicons used by the coach. These describe how TRELLIS-style
// reconstruction behaves: a named material/finish and a clean isolated
// subject produce the sharpest mesh; scenes and multi-object prompts
// compress poorly into a single mesh.
const MATERIAL_WORDS = [
	'metal',
	'metallic',
	'brass',
	'bronze',
	'copper',
	'steel',
	'iron',
	'chrome',
	'aluminium',
	'aluminum',
	'gold',
	'silver',
	'ceramic',
	'porcelain',
	'glazed',
	'glass',
	'crystal',
	'wood',
	'wooden',
	'oak',
	'leather',
	'plastic',
	'rubber',
	'matte',
	'glossy',
	'polished',
	'brushed',
	'velvet',
	'felt',
	'stone',
	'marble',
	'granite',
	'concrete',
	'fabric',
	'knit',
	'enamel',
	'carbon fibre',
	'carbon fiber',
	'bakelite',
	'terracotta',
	'weathered',
	'rusted',
	'patina',
	'clay',
	'obsidian',
	'jade',
	'wool',
	'timber',
	'sandstone',
	'brick',
	'cloth',
	'linen',
];
const LIGHT_WORDS = ['studio', 'lighting', 'light', 'backlit', 'soft shadows', 'soft light', 'neutral'];
// Signals that the prompt is asking for a scene rather than one object.
const SCENE_WORDS = [
	'scene',
	'landscape',
	'environment',
	'diorama',
	'room',
	'interior',
	'forest',
	'city',
	'street',
	'battlefield',
	'background of',
	'surrounded by',
];

function hasAny(text, words) {
	return words.some((w) => text.includes(w));
}

// Scene words need whole-word matching: substring matching flags innocent
// subjects ("mushroom" and "heirloom" both contain "room").
function hasSceneWord(text) {
	return SCENE_WORDS.some((w) => new RegExp(`\\b${w}\\b`).test(text));
}

// Count subjects loosely — an " and " joining two nouns, or several
// comma-separated clauses, both push the model toward a multi-object mesh.
function looksMultiSubject(text) {
	if (hasSceneWord(text)) return true;
	if (/\b(two|three|four|several|a group of|a pair of|a set of)\b/.test(text)) return true;
	// " x and y " where both sides carry a noun-ish token.
	if (/\w+\s+and\s+\w+/.test(text) && !/black and white|red and white|salt and pepper/.test(text))
		return true;
	return false;
}

function grade(raw) {
	const text = raw.trim().toLowerCase();
	const words = text ? text.split(/\s+/).length : 0;

	if (!text) {
		return {
			grade: 'tip',
			msg: 'Name one object and a material — e.g. “a brass compass, weathered”.',
		};
	}
	if (words < 2) {
		return { grade: 'tip', msg: 'Add a little detail — a material, colour, or finish.' };
	}
	if (looksMultiSubject(text)) {
		return {
			grade: 'warn',
			msg: 'One isolated object reconstructs cleanest — scenes and multiple subjects compress poorly.',
		};
	}
	const material = hasAny(text, MATERIAL_WORDS);
	const light = hasAny(text, LIGHT_WORDS);
	if (material && light) {
		return { grade: 'strong', msg: 'Strong prompt — clear subject, material and lighting cues.' };
	}
	if (material) {
		return { grade: 'strong', msg: 'Good prompt — add “studio lighting” for an even cleaner bake.' };
	}
	return {
		grade: 'tip',
		msg: 'Add a material or finish — “matte ceramic”, “brushed brass” — for a sharper mesh.',
	};
}

function updateCoach() {
	if (!els.prompt) return;
	const value = els.prompt.value;
	if (els.coach) {
		const { grade: g, msg } = grade(value);
		els.coach.dataset.grade = g;
		els.coach.textContent = msg;
	}
	if (els.count) {
		const len = value.length;
		els.count.textContent = `${len} / ${MAXLEN}`;
		els.count.dataset.near = String(len >= MAXLEN - 100);
	}
}

function surprise() {
	if (!els.prompt) return;
	const [pick] = generateDistinctForgePrompts(1, new Set([els.prompt.value.trim()]));
	if (!pick) return;
	els.prompt.value = pick;
	updateCoach();
	els.prompt.focus();
	const end = els.prompt.value.length;
	els.prompt.setSelectionRange(end, end);
	els.surprise?.classList.remove('is-rolling');
	// reflow so the animation restarts on rapid clicks
	void els.surprise?.offsetWidth;
	els.surprise?.classList.add('is-rolling');
}

// Write a generated prompt into a chip and take ownership of its text.
//
// The static chip labels in the HTML carry data-i18n keys so a no-JS visitor
// still gets translated copy. Once we replace that label with a generated
// prompt, the key no longer describes the node: i18n's applyCatalog walks
// [data-i18n] whenever a catalog loads or the locale changes and would write
// the original English string back over the generated one. That silently undid
// every rotation (the "fresh set every visit" promise below), and because the
// generated prompts are longer than the static ones the revert re-wrapped the
// flex row and moved everything under it, which measured as the single largest
// layout shift on /forge. Dropping the attribute hands the node to its real
// owner, the same way nav-auth's data-auth-name guard does in src/i18n.js.
function setChipPrompt(chip, text) {
	chip.textContent = text;
	chip.removeAttribute('data-i18n');
}

function shuffleChips() {
	if (!els.examples) return;
	// Seasonal presets (.chip--festive) are pinned: "More ideas" only rotates
	// the regular library chips, never overwrites the festive prompts.
	const chips = [...els.examples.querySelectorAll('.chip:not(.chip--festive)')];
	if (!chips.length) return;
	const current = new Set(chips.map((c) => c.textContent.trim()));
	const fresh = generateDistinctForgePrompts(chips.length, current, Math.random, CHIP_MAXLEN);
	chips.forEach((chip, i) => {
		const next = fresh[i];
		if (!next) return;
		chip.classList.add('is-swapping');
	});
	const swap = () => {
		chips.forEach((chip, i) => {
			if (fresh[i]) setChipPrompt(chip, fresh[i]);
			chip.classList.remove('is-swapping');
		});
	};
	if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) swap();
	else setTimeout(swap, 180);
	els.chipsMore?.classList.remove('is-rolling');
	void els.chipsMore?.offsetWidth;
	els.chipsMore?.classList.add('is-rolling');
}

// Every visit opens on a fresh random set; the static chip text in the HTML
// is only the no-JS fallback. Covers both the composer's example chips and
// the empty-stage starters, kept mutually distinct; festive (pinned
// seasonal) chips are untouched.
function seedChips() {
	const chips = [els.examples, els.emptyStarters].flatMap((container) =>
		container ? [...container.querySelectorAll('.chip:not(.chip--festive)')] : []
	);
	if (!chips.length) return;
	const fresh = generateDistinctForgePrompts(chips.length, undefined, Math.random, CHIP_MAXLEN);
	chips.forEach((chip, i) => {
		if (fresh[i]) setChipPrompt(chip, fresh[i]);
	});
}

if (els.prompt) {
	els.prompt.addEventListener('input', updateCoach);
	els.surprise?.addEventListener('click', surprise);
	els.chipsMore?.addEventListener('click', shuffleChips);
	seedChips();
	// Reflect any value already present (remix ?prompt= prefill, restored draft).
	updateCoach();
}
