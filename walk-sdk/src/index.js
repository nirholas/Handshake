// @three-ws/walk — a 3D avatar that walks and talks over your web pages.
// =====================================================================
// Drop a diverse, animated character into any site. It idles in the corner,
// follows the cursor, waves on navigation, and greets each page. Click it and
// it detaches into a full-page playground (stroll or platformer). Visitors pick
// who walks with them from a roster of avatars — or you supply your own.
//
// Quick start (the whole thing, app-style auto-mount):
//
//   import { createWalkCompanion } from '@three-ws/walk';
//   createWalkCompanion().bootstrap();
//
// Or drive it yourself:
//
//   const walk = createWalkCompanion({ defaultAvatarId: 'fox' });
//   walk.enable();              // mount the corner companion
//   walk.openPicker();          // let the visitor choose
//   walk.setAvatar('michelle'); // swap live
//
// `three` is a peer dependency — bring your own copy.

export const VERSION = '0.3.0';

// Companion (corner mascot) — the main entry point.
export { createWalkCompanion } from './companion.js';

// Playground (full-page stroll / platformer). The companion drives these for
// you, but they're exported for direct/standalone use.
export {
	launchPlayground,
	exitPlayground,
	switchPlaygroundMode,
	getPlaygroundMode,
	shouldDropIn,
	consumeDropIn,
	playgroundState,
} from './playground.js';

// Avatar roster + helpers.
export {
	WALK_AVATARS,
	DEFAULT_AVATAR_ID,
	DEFAULT_SHARED_CLIPS,
	DEFAULT_EMOTES,
	getAvatar,
	defaultAvatar,
	listCategories,
	makeApiAvatarEntry,
	resolveAvatarUrl,
} from './roster.js';

// The picker UI, for hosts that want to place it themselves.
export { createAvatarPicker } from './picker.js';

// Low-level building blocks for advanced integrations.
export { loadWalkAvatar, resolveEmotes } from './internal/load-avatar.js';
export { resolveConfig, resolveAvatarEntry, DEFAULT_EXCLUDED_PREFIXES } from './config.js';
