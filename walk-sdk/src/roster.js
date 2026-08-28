// Walk avatar roster — the cast that can walk and talk over your pages.
// =====================================================================
// Every entry is a real, shippable GLB with a known-good animation strategy.
// Two strategies, chosen per rig so nothing ever freezes in a bind/T-pose:
//
//   • rig: 'embedded' — play the clips baked into the GLB itself. Used for
//     non-humanoid or self-animated models (the robot mascot, the fox, the
//     glTF showpieces). State names are matched loosely and fall back to the
//     model's first clip, so even a single-animation GLB still moves.
//   • rig: 'shared' — drive the rig with the platform's retargeted shared
//     clip library via AnimationManager (idle / walk / run / wave / jump).
//     Used for humanoids that ship without locomotion (or, like Michelle,
//     ship ONLY a T-pose — which must never be shown). `clips` maps each
//     state to a clip name in /animations/manifest.json.
//
// `asset` is a path resolved against the SDK's `assetBase` at runtime, so the
// same roster works whether the GLBs are served from the host origin, a CDN,
// or a subpath. User-generated avatars are not in this static list — build one
// on the fly with `makeApiAvatarEntry(id)`.

export const DEFAULT_AVATAR_ID = 'robot';

// Manifest clip names used by retargeted (shared-rig) avatars. Verified present
// in /animations/manifest.json.
export const DEFAULT_SHARED_CLIPS = {
	idle: 'idle',
	walk: 'av-walk-feminine',
	run: 'av-walk-feminine', // no distinct sprint clip; pace comes from timeScale
	wave: 'wave',
	jump: 'jump',
};

// On-command performances for shared-rig avatars: emote name to manifest clip.
// Verified present in /animations/manifest.json (walk-sdk/test/emotes.test.mjs
// enforces this against the real manifest). A roster entry can override any of
// them with its own `emotes` map; embedded rigs match baked clip names instead.
export const DEFAULT_EMOTES = {
	dance: 'dance',
	punch: 'av-muay-thai',
	backflip: 'av-back-flip',
	wave: 'wave',
};

export const WALK_AVATARS = [
	{
		id: 'robot',
		name: 'Robo',
		emoji: '🤖',
		blurb: 'The friendly platform mascot. Expressive, lightweight, always game.',
		category: 'Mascots',
		asset: '/animations/robotexpressive.glb',
		source: 'static',
		rig: 'embedded',
		thumb: '/avatars/thumbs/robotexpressive.png',
		accent: '#7aa2ff',
		tags: ['mascot', 'robot', 'lightweight', 'default'],
	},
	{
		id: 'guide',
		name: 'Guide',
		emoji: '🧭',
		blurb: 'A clean humanoid guide, driven by the shared motion library.',
		category: 'Humanoid',
		asset: '/avatars/default.glb',
		source: 'static',
		rig: 'shared',
		clips: DEFAULT_SHARED_CLIPS,
		thumb: '/avatars/thumbs/default.png',
		accent: '#8bd5ca',
		tags: ['humanoid', 'neutral', 'guide'],
	},
	{
		id: 'michelle',
		name: 'Michelle',
		emoji: '💃',
		blurb: 'Stylised dancer rig, fully retargeted so she struts — never poses.',
		category: 'Humanoid',
		asset: '/avatars/michelle.glb',
		source: 'static',
		rig: 'shared',
		// Michelle's GLB ships only a TPose — force the shared library and never
		// touch the embedded pose. See the repo's no-T-pose rule.
		clips: { ...DEFAULT_SHARED_CLIPS, wave: 'michelle-samba-dance' },
		emotes: { ...DEFAULT_EMOTES, dance: 'michelle-samba-dance' },
		accent: '#ff8fab',
		tags: ['humanoid', 'feminine', 'dancer'],
	},
	{
		id: 'mannequin',
		name: 'Mannequin',
		emoji: '🧍',
		blurb: 'A neutral artist mannequin — the blank canvas of the cast.',
		category: 'Humanoid',
		asset: '/avatars/mannequin.glb',
		source: 'static',
		rig: 'shared',
		clips: DEFAULT_SHARED_CLIPS,
		accent: '#c9b8a8',
		tags: ['humanoid', 'neutral', 'mannequin'],
	},
	{
		id: 'xbot',
		name: 'X-Bot',
		emoji: '🦾',
		blurb: 'Mixamo X-Bot with its own idle/walk/run set for snappy motion.',
		category: 'Humanoid',
		asset: '/avatars/xbot.glb',
		source: 'static',
		rig: 'shared',
		clips: {
			idle: 'xbot-idle',
			walk: 'xbot-walk',
			run: 'xbot-run',
			wave: 'wave',
			jump: 'jump',
		},
		accent: '#9aa7b5',
		tags: ['humanoid', 'robot', 'mixamo'],
	},
	{
		id: 'realistic-female',
		name: 'Ava',
		emoji: '👩',
		blurb: 'Photoreal full-body avatar, retargeted to the shared library.',
		category: 'Realistic',
		asset: '/avatars/realistic-female.glb',
		source: 'static',
		rig: 'shared',
		clips: DEFAULT_SHARED_CLIPS,
		accent: '#f2a65a',
		tags: ['realistic', 'feminine', 'rpm'],
	},
	{
		id: 'realistic-male',
		name: 'Leo',
		emoji: '👨',
		blurb: 'Photoreal full-body avatar, retargeted to the shared library.',
		category: 'Realistic',
		asset: '/avatars/realistic-male.glb',
		source: 'static',
		rig: 'shared',
		clips: DEFAULT_SHARED_CLIPS,
		accent: '#6ea8fe',
		tags: ['realistic', 'masculine', 'rpm'],
	},
	{
		id: 'selfie-girl',
		name: 'Mira',
		emoji: '🤳',
		blurb: 'Selfie-styled avatar — playful, expressive, photo-ready.',
		category: 'Realistic',
		asset: '/avatars/selfie-girl.glb',
		source: 'static',
		rig: 'shared',
		clips: DEFAULT_SHARED_CLIPS,
		accent: '#d39bff',
		tags: ['realistic', 'feminine', 'rpm'],
	},
	{
		id: 'fox',
		name: 'Fox',
		emoji: '🦊',
		blurb: 'The classic glTF fox — a non-humanoid pal that trots and surveys.',
		category: 'Creatures',
		asset: '/avatars/fox.glb',
		source: 'static',
		rig: 'embedded',
		clips: { idle: ['Survey'], walk: ['Walk'], run: ['Run'] },
		accent: '#ff9f43',
		tags: ['creature', 'animal', 'quadruped'],
	},
	{
		id: 'twerk',
		name: 'Groove',
		emoji: '🕺',
		blurb: 'A dancer who never stops moving — pure ambient energy.',
		category: 'Showpieces',
		asset: '/avatars/dancing-twerk.glb',
		source: 'static',
		rig: 'embedded',
		accent: '#ff5e7e',
		tags: ['dancer', 'loop', 'fun'],
	},
	{
		id: 'cesium',
		name: 'Cesium',
		emoji: '🚶',
		blurb: 'The reference walking man — a tireless, steady stroller.',
		category: 'Showpieces',
		asset: '/avatars/cesium-man.glb',
		source: 'static',
		rig: 'embedded',
		accent: '#54c7ec',
		tags: ['reference', 'walk'],
	},
	{
		id: 'brainstem',
		name: 'Stem',
		emoji: '🦿',
		blurb: 'A skeletal showpiece rig with a hypnotic walk cycle.',
		category: 'Showpieces',
		asset: '/avatars/brainstem.glb',
		source: 'static',
		rig: 'embedded',
		accent: '#a0e7a0',
		tags: ['showpiece', 'skeletal'],
	},
	{
		id: 'cz',
		name: 'CZ',
		emoji: '🧑‍💼',
		blurb: 'A stylised character bust with a calm, animated idle.',
		category: 'Showpieces',
		asset: '/avatars/cz.glb',
		source: 'static',
		rig: 'embedded',
		thumb: '/avatars/thumbs/cz.png',
		accent: '#ffd166',
		tags: ['showpiece', 'idle'],
	},
];

const _byId = new Map(WALK_AVATARS.map((a) => [a.id, a]));

/** Look up a roster entry by id. Returns null when unknown. */
export function getAvatar(id) {
	return (id && _byId.get(id)) || null;
}

/** The default roster entry (the platform mascot). */
export function defaultAvatar() {
	return getAvatar(DEFAULT_AVATAR_ID) || WALK_AVATARS[0];
}

/** Distinct categories, in first-seen roster order — handy for grouped UIs. */
export function listCategories() {
	const seen = [];
	for (const a of WALK_AVATARS) if (!seen.includes(a.category)) seen.push(a.category);
	return seen;
}

/**
 * Build a roster-shaped entry for a user-generated avatar served by the
 * platform's GLB proxy (`/api/avatars/<id>/glb`). These are always humanoid
 * RPM/Mixamo bakes with no embedded locomotion, so they use the shared library.
 */
export function makeApiAvatarEntry(id, { name, accent } = {}) {
	return {
		id,
		name: name || 'Your avatar',
		emoji: '✨',
		blurb: 'Your own avatar, retargeted to the shared motion library.',
		category: 'Yours',
		asset: null,
		source: 'api',
		rig: 'shared',
		clips: DEFAULT_SHARED_CLIPS,
		accent: accent || '#7aa2ff',
		tags: ['custom', 'user'],
	};
}

/**
 * Build a roster-shaped entry for a GLB served from anywhere: a contact's
 * avatar, an avatar generated from a selfie, a customer's own character. The
 * URL is used verbatim (absolute URLs pass through resolveAvatarUrl untouched),
 * and the rig is driven by the shared retargeted library, which is what lets an
 * arbitrary humanoid GLB walk and gesture without shipping its own clips.
 *
 * @param {string} url absolute or root-relative GLB URL.
 * @param {{ id?:string, name?:string, accent?:string, rig?:'shared'|'embedded' }} [opts]
 */
export function makeGuestAvatarEntry(url, { id, name, accent, rig = 'shared' } = {}) {
	return {
		id: id || `guest:${url}`,
		name: name || 'Guest',
		emoji: '👤',
		blurb: 'A guest avatar delivering a message.',
		category: 'Guests',
		asset: url,
		source: 'static',
		rig,
		clips: DEFAULT_SHARED_CLIPS,
		accent: accent || '#7aa2ff',
		tags: ['guest'],
	};
}

/**
 * Resolve the GLB URL for a roster entry.
 * - static entries: `assetBase` + the entry's asset path.
 * - api entries:    `apiBase` + `/api/avatars/<id>/glb`.
 */
export function resolveAvatarUrl(entry, { assetBase = '', apiBase = '' } = {}) {
	if (!entry) return null;
	if (entry.source === 'api') {
		return `${apiBase}/api/avatars/${encodeURIComponent(entry.id)}/glb`;
	}
	if (!entry.asset) return null;
	// Absolute URLs pass through untouched; root-relative paths get the base.
	if (/^https?:\/\//i.test(entry.asset)) return entry.asset;
	return `${assetBase}${entry.asset}`;
}
