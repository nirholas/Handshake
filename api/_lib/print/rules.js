// The fabrication denylist: what three.ws will not manufacture.
//
// A refused image generation costs nothing. A printed firearm receiver is a
// felony in most of the jurisdictions this platform ships to, and a printed
// key to somebody's front door is a burglary tool. Physical output raises the
// stakes of every moderation decision, so the line lives in code, with a test
// per rule, rather than in a prompt an LLM may or may not honour.
//
// Structure, deliberately not one regex blob:
//
//   tier 'hard'  — refused outright. The object has no lawful hobby use that
//                  a print bureau would accept, and no phrasing exempts it.
//   tier 'soft'  — refused unless the request is unambiguously a display piece
//                  AND the geometry agrees (a tabletop miniature is centimetres
//                  tall; a functional part is life-size). A platform whose main
//                  output is AI figurines cannot refuse the word "sword", so
//                  these escalate to the LLM layer instead of auto-refusing.
//
// Every rule carries the buyer-facing message it refuses with. A refusal that
// says "blocked" and nothing else is a support ticket; one that names the
// category, links the policy and says what IS allowed is a designed state.

export const POLICY_URL = '/docs/materialize#content-policy';

/** Whole-word match so "assassin" never trips on "ass" and "barrelled" never trips on "barrel". */
export function matchTerm(text, terms) {
	for (const term of terms) {
		const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '[\\s_-]+');
		const re = new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, 'i');
		if (re.test(text)) return term;
	}
	return null;
}

export const FABRICATION_RULES = Object.freeze([
	{
		id: 'firearm_components',
		tier: 'hard',
		label: 'firearm components',
		terms: [
			'lower receiver', 'upper receiver', 'ar15 lower', 'ar-15 lower', 'ar15 receiver',
			'ar-15 receiver', 'ak receiver', 'glock frame', 'pistol frame', 'firearm frame',
			'auto sear', 'autosear', 'drop in auto sear', 'lightning link', 'glock switch',
			'giggle switch', 'forced reset trigger', 'bump stock', 'ghost gun', 'ghost guns',
			'80 percent lower', '80% lower', 'unserialized firearm', 'untraceable firearm',
			'fgc9', 'fgc-9', 'liberator pistol', 'zip gun', 'slam fire', 'firing pin',
			'bolt carrier group', 'trigger group', 'sear housing', 'gun barrel', 'rifled barrel',
			'barrel liner', 'breech block', 'pistol slide', 'firearm suppressor',
		],
		message:
			'three.ws does not manufacture firearm components. Receivers, frames, trigger and fire-control parts, barrels and conversion devices are refused regardless of intended use.',
		allowed:
			'Display models of historical or fictional weapons that are one solid piece with no moving mechanism, printed as miniatures, are fine.',
	},
	{
		id: 'suppressors',
		tier: 'hard',
		label: 'suppressors and solvent traps',
		terms: [
			'suppressor', 'silencer', 'solvent trap', 'baffle stack', 'suppressor baffle',
			'monocore baffle', 'oil filter adapter', 'freeze plug kit', 'muzzle can',
		],
		message:
			'three.ws does not manufacture sound suppressors or the parts marketed as solvent traps that convert into them.',
		allowed:
			'Non-functional prop barrels for costume and film use, printed solid with no bore, are fine.',
	},
	{
		id: 'ammunition',
		tier: 'hard',
		label: 'ammunition and feeding devices',
		terms: [
			'ammunition', 'live ammunition', 'cartridge case', 'shell casing', 'bullet mold',
			'bullet mould', 'primer pocket', 'reloading die', 'powder measure',
			'high capacity magazine', 'high-capacity magazine', 'drum magazine',
			'magazine follower', 'magazine baseplate', 'speed loader', 'ammo belt link',
		],
		message:
			'three.ws does not manufacture ammunition, ammunition components, or magazines and feeding devices.',
		allowed:
			'Inert display shells for a museum-style diorama, modelled as a single solid with no cavity, are fine.',
	},
	{
		id: 'lock_bypass',
		tier: 'hard',
		label: 'keys and lock-bypass tools',
		terms: [
			'bump key', 'bump keys', 'lock pick', 'lock picks', 'lockpick', 'lockpicks',
			'lock picking set', 'tension wrench', 'tensioner wrench', 'handcuff key',
			'handcuff shim', 'jiggler key', 'try out key', 'tryout key', 'key blank',
			'key bitting', 'key copy from photo', 'duplicate this key', 'copy of my key',
			'tubular lock pick', 'car door jiggler', 'jim tool', 'slim jim',
			'bypass driver', 'safe bypass tool', 'padlock shim', 'rfid key fob clone',
		],
		message:
			'three.ws does not manufacture keys or lock-bypass tools. A working key, a pick, or a shim is a burglary tool no matter who orders it.',
		allowed:
			'Decorative or fantasy key sculptures that do not reproduce a real key bitting are fine.',
	},
	{
		id: 'counterfeit',
		tier: 'hard',
		label: 'counterfeit and trademark-infringing goods',
		terms: [
			'counterfeit', 'counterfeits', 'knockoff', 'knock off', 'bootleg', 'replica logo',
			'fake logo', 'copy of the logo', 'brand logo badge', 'trademark logo',
			'authentication tag', 'authenticity hologram', 'serial number plate',
			'hallmark stamp', 'luxury brand emblem', 'designer monogram', 'fake hallmark',
			'currency note', 'banknote', 'coin die', 'passport stamp', 'id card blank',
		],
		message:
			'three.ws does not manufacture counterfeit goods, brand marks, or anything that authenticates a product or identity it is not.',
		allowed:
			'Your own logo, your own brand, and original designs are welcome. Upload or generate the mark you own.',
	},
	{
		id: 'working_weapon_mechanisms',
		tier: 'hard',
		label: 'working weapon mechanisms',
		terms: [
			'switchblade', 'automatic knife', 'otf knife', 'out the front knife',
			'butterfly knife', 'balisong', 'push dagger', 'brass knuckles', 'knuckle duster',
			'knuckleduster', 'garrote', 'garrotte', 'blackjack sap', 'spring loaded blade',
			'concealed blade', 'sharpened blade', 'crossbow trigger', 'speargun trigger',
			'blowgun dart', 'caltrop', 'caltrops', 'tire spike', 'punji stake',
		],
		message:
			'three.ws does not manufacture working weapon mechanisms, concealed blades, or impact and area-denial weapons.',
		allowed:
			'Prop and costume weapons with blunt edges, printed as a single non-articulating piece, are fine.',
	},
	{
		id: 'weapon_likeness',
		tier: 'soft',
		label: 'realistic weapon likeness',
		terms: [
			'pistol', 'handgun', 'revolver', 'rifle', 'shotgun', 'carbine', 'submachine gun',
			'assault rifle', 'machine gun', 'ar15', 'ar-15', 'ak47', 'ak-47', 'glock',
			'grenade', 'landmine', 'pipe bomb', 'detonator', 'firearm', 'firearms',
		],
		// A soft rule never refuses on its own. It marks the request for the LLM
		// layer and pairs with the geometry signal: a 28 mm tabletop trooper and a
		// 210 mm life-size pistol shell are the same words and different objects.
		message:
			'three.ws does not manufacture realistic firearm likenesses at or near life size.',
		allowed:
			'Miniature and tabletop-scale figures carrying weapons, and clearly stylised or fantasy designs, are fine.',
	},
]);

/**
 * Evaluate the denylist over one blob of text (prompt lineage, model title and
 * buyer note, concatenated by the caller).
 *
 * @param {string} text
 * @returns {{ hard: object|null, soft: object[], matched: string|null }}
 */
export function evaluateRules(text) {
	const haystack = String(text || '').toLowerCase();
	if (!haystack.trim()) return { hard: null, soft: [], matched: null };

	const soft = [];
	for (const rule of FABRICATION_RULES) {
		const matched = matchTerm(haystack, rule.terms);
		if (!matched) continue;
		if (rule.tier === 'hard') return { hard: rule, soft, matched };
		soft.push({ rule, matched });
	}
	return { hard: null, soft, matched: soft[0]?.matched ?? null };
}

/** Look a rule up by id, for tests and for rendering a stored verdict. */
export function ruleById(id) {
	return FABRICATION_RULES.find((r) => r.id === id) || null;
}
