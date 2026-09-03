// Configuration resolution for the Walk SDK.
// ===========================================
// One options object flows to both the companion and the playground. Defaults
// match the three.ws app exactly — including the localStorage/sessionStorage
// keys — so dropping the SDK in is behaviourally identical to the hand-written
// modules it replaces, and an existing visitor's saved state carries over.

import { WALK_AVATARS, DEFAULT_AVATAR_ID, getAvatar, makeApiAvatarEntry } from './roster.js';

// Routes that already own the viewport with their own full-screen 3D, where a
// corner mascot would be redundant or intrusive.
export const DEFAULT_EXCLUDED_PREFIXES = [
	'/walk',
	'/walk-embed',
	'/embed',
	'/play',
	'/club',
	'/city',
	'/xr',
	'/ar',
	'/pose',
	'/mocap-studio',
	'/avatar-studio',
	// The widget studio absorbed the /embed editor. It runs a full-bleed live
	// preview iframe, so a corner mascot would sit on top of the thing the page
	// exists to show, exactly as it would have on /embed.
	'/studio',
];

export function resolveConfig(opts = {}) {
	const prefix = opts.storagePrefix || 'walk';
	return {
		avatars: opts.avatars || WALK_AVATARS,
		defaultAvatarId: opts.defaultAvatarId || DEFAULT_AVATAR_ID,
		assetBase: opts.assetBase || '',
		apiBase: opts.apiBase || '',
		manifestUrl: opts.manifestUrl || '/animations/manifest.json',
		excludedRoutes: opts.excludedRoutes || DEFAULT_EXCLUDED_PREFIXES,
		enablePicker: opts.enablePicker !== false,
		// Procedural head tracking: the companion's chest/neck/head follow the
		// visitor's cursor through runtime IK (src/procedural/look-at.js). On by
		// default; pass lookAt: false to keep the pre-0.4 fixed gaze.
		lookAt: opts.lookAt !== false,
		greeting: typeof opts.greeting === 'function' ? opts.greeting : null,
		docsUrl: opts.docsUrl || null,
		keys: {
			enabled: `${prefix}:companion:enabled`,
			state: `${prefix}:companion:state`,
			avatar: `${prefix}:companion:avatar`,
			greet: `${prefix}:companion:greet`,
			invited: `${prefix}:companion:invited`,
			resume: `${prefix}:playground:resume`,
			mode: `${prefix}:playground:mode`,
		},
	};
}

/**
 * Resolve a stored/queried avatar id into a roster entry. An id that isn't in
 * the static roster is assumed to be a user-generated avatar served by the GLB
 * proxy, so it becomes an on-the-fly API entry.
 */
export function resolveAvatarEntry(id, config) {
	if (!id) return getAvatar(config.defaultAvatarId) || config.avatars[0];
	const fromRoster = config.avatars.find((a) => a.id === id) || getAvatar(id);
	if (fromRoster) return fromRoster;
	return makeApiAvatarEntry(id);
}
