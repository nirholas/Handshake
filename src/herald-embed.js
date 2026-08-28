// The CDN build of @three-ws/herald, served at the stable path /herald.js.
//
// Two ways to use it, both from one file:
//
//   import { createHerald } from 'https://three.ws/herald.js';   // as a module
//   <script src="https://three.ws/herald.js"></script>           // as a global
//
// The module path is the real one. The global (`window.threeHerald`) exists so
// a page with no build step, or a CMS that only lets you paste a script tag,
// still gets the whole feature: the loader creates a herald with sane defaults
// on first use, so `threeHerald.announce('...')` works with nothing else.
//
// Vite emits this entry to /herald.js unhashed (see vite.config.js) and
// vercel.json serves it with permissive CORS, so it can be imported from any
// origin exactly like the <agent-3d> bundle.

import { createHerald } from '../herald-sdk/src/index.js';

// three.ws serves the companion at a stable, unhashed path (vite.config.js), so
// a visitor who never turned it on still gets a body for a delivery: the module
// installs `window.__walkCompanion` on import and the presenter picks it up.
// Exported so a page building its own herald passes the same thing.
export const WALK_ON_THREE_WS = { walkModule: '/walk-companion.js' };

export {
	createHerald,
	createAvatarPresenter,
	createCardPresenter,
	createVoice,
	pollSource,
	sseSource,
	railSource,
	manualSource,
	decide,
	planBatch,
	resolveRules,
	scoreMessage,
	dwellMsFor,
	toMessage,
	withinQuietHours,
	DEFAULT_RULES,
	DROP_REASONS,
	HOLD_REASONS,
	VERSION,
} from '../herald-sdk/src/index.js';

export default createHerald;

// Lazily-built default instance for the script-tag path. Building it on first
// use rather than on load means a page that imports the module and configures
// its own herald never pays for a second one.
let ambient = null;
function ensureAmbient() {
	if (!ambient) ambient = createHerald({ voice: 'auto', avatarOptions: WALK_ON_THREE_WS });
	return ambient;
}

if (typeof window !== 'undefined' && !window.threeHerald) {
	window.threeHerald = {
		createHerald,
		/** Announce through the ambient instance, creating it on first call. */
		announce: (message) => ensureAmbient().announce(message),
		mute: (ms) => ensureAmbient().mute(ms),
		unmute: () => ensureAmbient().unmute(),
		stats: () => ensureAmbient().stats(),
		rule: (scorer) => ensureAmbient().rule(scorer),
		source: (source) => ensureAmbient().source(source),
		get instance() {
			return ensureAmbient();
		},
	};
}
