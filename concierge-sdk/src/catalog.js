/**
 * Concierge catalog — @three-ws/concierge
 * =======================================
 *
 * Every entry is a skeleton-rigged humanoid GLB with verified face morphs or a
 * talk animation, served from the three.ws origin (the repo's public/ web
 * root). The concierge frames the avatar as a bust inside the chat panel and
 * drives blink + viseme lipsync, so an unrigged mesh would read as a dead
 * statue — those are excluded by rule, same as @three-ws/page-agent.
 *
 * Override `assetBase` (or an entry's `url`) to self-host the GLBs.
 */

/** Default CDN base. Real, public three.ws assets — `public/avatars/*.glb`. */
export const DEFAULT_ASSET_BASE = 'https://three.ws/avatars/';

/**
 * @typedef {Object} ConciergeAvatar
 * @property {string} id        Stable slug used in attributes / localStorage.
 * @property {string} name      Display name shown in the header + picker.
 * @property {string} tagline   One-line personality hook for the picker card.
 * @property {string} file      GLB filename under the asset base.
 * @property {string} [url]     Absolute override; wins over assetBase+file.
 * @property {'viseme'|'jaw'|'animation'} lipsync  Mouth driver.
 * @property {'bust'|'upper'|'full'} framing       Camera crop in the panel.
 * @property {{ lang?: string, pitch?: number, rate?: number, match?: string[] }} voice
 * @property {string} accent    Default accent color for this avatar's chrome.
 */

/** @type {ConciergeAvatar[]} */
export const AVATARS = [
	{
		id: 'sol',
		name: 'Sol',
		tagline: 'Calm, clear product guide',
		file: 'realistic-halfbody.glb',
		lipsync: 'viseme',
		framing: 'bust',
		voice: { lang: 'en-US', pitch: 1.0, rate: 1.0, match: ['samantha', 'jenny', 'aria', 'google us english'] },
		accent: '#6366f1',
	},
	{
		id: 'nova',
		name: 'Nova',
		tagline: 'Upbeat, friendly host',
		file: 'selfie-girl.glb',
		lipsync: 'viseme',
		framing: 'upper',
		voice: { lang: 'en-US', pitch: 1.12, rate: 1.04, match: ['jenny', 'aria', 'samantha', 'google us english'] },
		accent: '#ec4899',
	},
	{
		id: 'vera',
		name: 'Vera',
		tagline: 'Composed, professional',
		file: 'realistic-female.glb',
		lipsync: 'viseme',
		framing: 'bust',
		voice: { lang: 'en-GB', pitch: 1.0, rate: 0.98, match: ['libby', 'sonia', 'google uk english female', 'serena'] },
		accent: '#14b8a6',
	},
	{
		id: 'atlas',
		name: 'Atlas',
		tagline: 'Confident, grounded',
		file: 'realistic-male.glb',
		lipsync: 'viseme',
		framing: 'bust',
		voice: { lang: 'en-US', pitch: 0.92, rate: 0.98, match: ['guy', 'eric', 'google us english', 'daniel'] },
		accent: '#3b82f6',
	},
	{
		id: 'echo',
		name: 'Echo',
		tagline: 'Neutral, even-keeled',
		file: 'default.glb',
		lipsync: 'viseme',
		framing: 'upper',
		voice: { lang: 'en-US', pitch: 1.0, rate: 1.0, match: ['google us english', 'samantha', 'guy'] },
		accent: '#8b5cf6',
	},
];

export const DEFAULT_AVATAR_ID = 'sol';

/** Look up a catalog entry by id; unknown ids resolve to the default. */
export function getAvatar(id) {
	return AVATARS.find((a) => a.id === id) || AVATARS.find((a) => a.id === DEFAULT_AVATAR_ID);
}

/** Resolve the GLB URL for an entry (absolute `url` wins over assetBase). */
export function avatarUrl(entry, assetBase = DEFAULT_ASSET_BASE) {
	if (!entry) return null;
	if (entry.url) return entry.url;
	const base = assetBase.endsWith('/') ? assetBase : assetBase + '/';
	return base + entry.file;
}

/**
 * Normalize a host-supplied custom avatar (a plain GLB URL or a partial entry)
 * into a full catalog-shaped entry so the runtime treats it uniformly.
 */
export function customAvatarEntry(urlOrEntry) {
	if (!urlOrEntry) return null;
	if (typeof urlOrEntry === 'string') {
		return {
			id: 'custom',
			name: 'Assistant',
			tagline: 'Custom avatar',
			url: urlOrEntry,
			lipsync: 'viseme',
			framing: 'bust',
			voice: { lang: 'en-US', pitch: 1, rate: 1, match: [] },
			accent: '#6366f1',
		};
	}
	return { ...getAvatar(DEFAULT_AVATAR_ID), id: 'custom', name: 'Assistant', ...urlOrEntry };
}
