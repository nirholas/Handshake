// three.ws 3D Studio (free) — generation content-safety gate.
//
// The studio is a public, unauthenticated ChatGPT app that must be suitable for
// ages 13–17 (OpenAI app policy). Generation prompts are free-form, so a prompt
// could ask for sexual, graphically violent, hateful, or otherwise age-
// inappropriate content. This gate runs BEFORE any provider work and refuses
// such prompts with a clear, actionable message — the same intent as the
// humanoid gate in mcp-server/src/tools/_humanoid.js, applied to content safety.
//
// It is intentionally dependency-free and synchronous: a whole-word keyword
// classifier, not an LLM call, so it adds no latency and no external dependency
// to the free lane. It is deliberately conservative on the highest-harm
// categories (sexual content involving minors, explicit sexual acts, gore,
// hate/extremism, weapons-for-harm) and lets ordinary creative prompts through.

// Whole-word match so "assassin" doesn't trip "ass" and "scunthorpe" is safe.
function hasTerm(text, terms) {
	for (const t of terms) {
		const re = new RegExp(`(^|[^a-z0-9])${escapeRe(t)}([^a-z0-9]|$)`, 'i');
		if (re.test(text)) return t;
	}
	return null;
}

function escapeRe(s) {
	return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Sexual / adult content — the app must not generate 18+ assets.
const SEXUAL_TERMS = [
	'nude', 'nudes', 'naked', 'nsfw', 'porn', 'porno', 'pornographic', 'xxx',
	'sex', 'sexual', 'sexy', 'erotic', 'erotica', 'hentai', 'rule34', 'r34',
	'fetish', 'bdsm', 'bondage', 'lingerie', 'topless', 'bottomless', 'nipple',
	'nipples', 'genital', 'genitalia', 'penis', 'vagina', 'vulva', 'breasts',
	'boobs', 'cleavage', 'buttocks', 'thong', 'fellatio', 'cunnilingus',
	'masturbation', 'orgasm', 'cum', 'creampie', 'milf', 'camgirl', 'stripper',
	'escort', 'onlyfans',
];

// Child-sexual content — zero tolerance; refuse outright.
//
// Every term here must be unambiguous, because this category refuses with the
// blunt "not allowed" message and accuses the caller of the highest-harm
// request there is. The bare abbreviation "cp" is deliberately NOT in this list:
// as a whole word it fires on ordinary modeling prompts ("a CP/M retro computer
// terminal", "a CP violation physics diagram"), and a false accusation of child
// sexual content is a worse failure than missing an abbreviation nobody types
// into a 3D generator. The spelled-out forms below cover the real intent.
const CSAM_TERMS = [
	'loli', 'lolicon', 'shota', 'shotacon', 'toddlercon', 'underage', 'preteen',
	'pre-teen', 'jailbait', 'child porn', 'childporn', 'child sex', 'child sexual',
	'minor sex', 'csam',
];

// Graphic violence / gore — keep the asset library age-appropriate.
const GORE_TERMS = [
	'gore', 'gory', 'gruesome', 'dismembered', 'dismemberment', 'decapitated',
	'decapitation', 'beheading', 'mutilated', 'mutilation', 'disembowel',
	'disemboweled', 'eviscerated', 'bloodbath', 'massacre', 'torture',
	'tortured', 'snuff',
];

// Hate / extremism — disallowed merchandise/iconography categories.
const HATE_TERMS = [
	'nazi', 'swastika', 'hitler', 'kkk', 'white power', 'heil', 'genocide',
	'ethnic cleansing', 'terrorist', 'isis', 'al qaeda', 'al-qaeda',
];

// Real, usable weapons + drugs — OpenAI prohibits firearms/weapons/explosives
// and illegal-drug commerce. Stylized fantasy weapons (sword, bow, wand) are
// intentionally NOT here; only real-world lethal weapons and drugs are blocked.
const WEAPON_DRUG_TERMS = [
	'ghost gun', 'ar-15', 'ar15', 'ak-47', 'ak47', 'assault rifle',
	'submachine gun', 'handgun', 'pistol', 'firearm', 'firearms', 'silencer',
	'suppressor', 'ammunition magazine', 'pipe bomb', 'ied', 'grenade',
	'landmine', 'c4 explosive', 'meth', 'methamphetamine', 'cocaine', 'heroin',
	'fentanyl', 'crack pipe', 'bong',
];

const CATEGORIES = [
	{ id: 'csam', terms: CSAM_TERMS, message: 'This prompt is not allowed.' },
	{
		id: 'sexual',
		terms: SEXUAL_TERMS,
		message: 'This 3D Studio is rated for ages 13+ and cannot generate sexual or adult content. Try describing a character, creature, or object without explicit themes.',
	},
	{
		id: 'gore',
		terms: GORE_TERMS,
		message: 'This 3D Studio cannot generate graphically violent or gory content. Describe your character or object without graphic violence.',
	},
	{
		id: 'hate',
		terms: HATE_TERMS,
		message: 'This 3D Studio cannot generate hateful or extremist content or iconography.',
	},
	{
		id: 'weapon_drug',
		terms: WEAPON_DRUG_TERMS,
		message: 'This 3D Studio cannot generate real firearms, explosives, or drug paraphernalia. Stylized fantasy props (a sword, a wand) are fine.',
	},
];

/**
 * Classify a generation prompt for age-13+ appropriateness.
 * @param {string} prompt
 * @returns {{ allowed: boolean, category?: string, message?: string, matched?: string }}
 */
export function checkPromptSafety(prompt) {
	const text = String(prompt || '').toLowerCase();
	if (!text.trim()) return { allowed: true };
	for (const cat of CATEGORIES) {
		const matched = hasTerm(text, cat.terms);
		if (matched) return { allowed: false, category: cat.id, message: cat.message, matched };
	}
	return { allowed: true };
}
