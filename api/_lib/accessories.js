// Baked preset allowlist — IDs mirror public/accessories/presets.json.
// Inline constant avoids runtime fs I/O in Vercel serverless.
// When the preset pack changes, update both files together.

const PRESET_IDS = new Set([
	'outfit-casual',
	'outfit-formal',
	'outfit-sporty',
	'hat-baseball',
	'hat-beanie',
	'hat-cowboy',
	'glasses-round',
	'glasses-shades',
	'earrings-hoops',
	'earrings-studs',
]);

export function isValidPresetId(id) {
	return PRESET_IDS.has(id);
}

// Tintable color slots — mirror COLOR_SLOTS in src/avatar-studio.js and
// SLOT_MATERIALS in api/_lib/bake.js. Each maps to one or more named GLB
// materials whose baseColorFactor the baker multiplies.
const COLOR_SLOT_IDS = new Set(['skin', 'hair', 'outfit']);
// Removable garment layers (skin is never hidden). Mirror LAYER_SLOTS in
// src/avatar-studio.js and SLOT_MATERIALS in api/_lib/bake.js.
const HIDEABLE_SLOT_IDS = new Set(['hair', 'outfit', 'glasses']);
const HEX_RE = /^#[0-9a-f]{6}$/i;

export function validateAppearance(appearance) {
	if (!appearance) return null;

	if (appearance.outfit !== undefined && appearance.outfit !== null) {
		if (typeof appearance.outfit !== 'string')
			return 'appearance.outfit must be a string or null';
		if (!isValidPresetId(appearance.outfit)) return `unknown preset id: ${appearance.outfit}`;
	}

	if (appearance.accessories !== undefined) {
		if (!Array.isArray(appearance.accessories))
			return 'appearance.accessories must be an array';
		if (appearance.accessories.length > 8) return 'appearance.accessories max length is 8';
		for (const id of appearance.accessories) {
			if (typeof id !== 'string') return 'appearance.accessories entries must be strings';
			if (!isValidPresetId(id)) return `unknown preset id: ${id}`;
		}
	}

	if (appearance.morphs !== undefined) {
		if (typeof appearance.morphs !== 'object' || Array.isArray(appearance.morphs)) {
			return 'appearance.morphs must be an object';
		}
		const entries = Object.entries(appearance.morphs);
		if (entries.length > 32) return 'appearance.morphs max 32 keys';
		for (const [k, v] of entries) {
			if (typeof v !== 'number' || v < 0 || v > 1) {
				return `appearance.morphs["${k}"] must be a number 0..1`;
			}
		}
	}

	if (appearance.colors !== undefined && appearance.colors !== null) {
		if (typeof appearance.colors !== 'object' || Array.isArray(appearance.colors)) {
			return 'appearance.colors must be an object';
		}
		const entries = Object.entries(appearance.colors);
		if (entries.length > COLOR_SLOT_IDS.size) {
			return `appearance.colors max ${COLOR_SLOT_IDS.size} keys`;
		}
		for (const [slot, hex] of entries) {
			if (!COLOR_SLOT_IDS.has(slot)) return `unknown color slot: ${slot}`;
			if (typeof hex !== 'string' || !HEX_RE.test(hex)) {
				return `appearance.colors["${slot}"] must be a #rrggbb hex string`;
			}
		}
	}

	if (appearance.hidden !== undefined && appearance.hidden !== null) {
		if (!Array.isArray(appearance.hidden)) return 'appearance.hidden must be an array';
		if (appearance.hidden.length > HIDEABLE_SLOT_IDS.size) {
			return `appearance.hidden max ${HIDEABLE_SLOT_IDS.size} entries`;
		}
		for (const slot of appearance.hidden) {
			if (typeof slot !== 'string') return 'appearance.hidden entries must be strings';
			if (!HIDEABLE_SLOT_IDS.has(slot)) return `unknown hidden slot: ${slot}`;
		}
	}

	return null;
}
