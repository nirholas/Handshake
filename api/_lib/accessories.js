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

// Hosts an `attachments[].url` may point at. A stored attachment is loaded by
// every browser that renders the avatar, including viewers who do not own it,
// so an unrestricted URL would turn a public avatar into an open relay for
// third-party bytes. Anchored the same way as TRUSTED_ASSET_HOST_RE in
// src/shared/safe-model-url.js (the client-side twin of this check), so
// `three.ws.evil.com` never matches; keep the two lists in step.
const TRUSTED_ATTACHMENT_HOST_RE =
	/(^|\.)(three\.ws|r2\.dev|storage\.googleapis\.com|mypinata\.cloud|pinata\.cloud|ipfs\.io|dweb\.link|arweave\.net)$/i;

/** Whether a custom attachment URL is safe to store and re-serve to viewers. */
export function isTrustedAttachmentUrl(raw) {
	if (typeof raw !== 'string' || !raw) return false;
	// Same-origin relative path (a bundled prop under /accessories/…).
	if (raw.startsWith('/') && !raw.startsWith('//')) return true;
	let u;
	try {
		u = new URL(raw);
	} catch {
		return false;
	}
	if (u.protocol !== 'https:') return false;
	return TRUSTED_ATTACHMENT_HOST_RE.test(u.hostname);
}

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

	if (appearance.attachments !== undefined && appearance.attachments !== null) {
		if (!Array.isArray(appearance.attachments)) {
			return 'appearance.attachments must be an array';
		}
		if (appearance.attachments.length > 8) return 'appearance.attachments max 8 entries';
		for (const item of appearance.attachments) {
			if (!item || typeof item !== 'object' || Array.isArray(item)) {
				return 'appearance.attachments entries must be objects';
			}
			if (typeof item.bone !== 'string' || !item.bone.trim()) {
				return 'appearance.attachments[].bone must be a non-empty string';
			}
			if (!isTrustedAttachmentUrl(item.url)) {
				return `appearance.attachments[].url must be an https URL on a three.ws asset host: ${item.url}`;
			}
		}
	}

	return null;
}
