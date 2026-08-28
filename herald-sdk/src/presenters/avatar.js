// The avatar presenter: a 3D character walks into the corner and says it.
//
// This is the whole point of the SDK, and it is deliberately the thinnest file
// in it. The body, the rig, the retargeted walk cycle, the speech bubble and
// the corner arbitration all already exist in @three-ws/walk; this presenter's
// only job is to find a companion (a live one on the page, the package, or the
// CDN build) and hand it a line.
//
// Resolution order, cheapest first:
//   1. A companion the integrator passed in (`companion` option). If you
//      already build one, hand it over: nothing else has to resolve.
//   2. `window.__walkCompanion`: three.ws pages already run one, and reusing
//      it means the visitor's own avatar delivers the message instead of a
//      second character appearing beside it.
//   3. `walkModule`: a module URL (or bare specifier) to import at runtime.
//      Either it exports `createWalkCompanion`, or it installs the global on
//      import, which is how the three.ws build serves it at /walk-companion.js.
// Every rung is optional. If none resolve, `ready()` is false and the runtime
// falls back to the card presenter, which needs nothing at all.
//
// The import is deliberately NOT a static specifier: a bundler that resolved
// `@three-ws/walk` at build time would make an optional peer dependency a hard
// build-time one, and a missing dist/ would fail the whole build rather than
// costing one delivery its 3D body.

/**
 * @param {object} [opts]
 * @param {object} [opts.companion] a control object from createWalkCompanion()
 * @param {object} [opts.companionOptions] options used when this presenter
 *   creates its own companion (avatars, defaultAvatarId, assetBase, apiBase...)
 * @param {string|null} [opts.walkModule] module URL or specifier to import when
 *   no companion was passed and none is live on the page
 * @param {(name: string) => any} [opts.globalLookup] test seam for window lookups
 * @param {(spec: string) => Promise<any>} [opts.importModule] test seam for the
 *   dynamic import
 */
export function createAvatarPresenter({
	companion = null,
	companionOptions = null,
	walkModule = null,
	globalLookup = (name) => globalThis?.[name],
	importModule = (spec) => import(/* @vite-ignore */ spec),
} = {}) {
	let control = companion;
	let resolving = null;

	async function resolveControl() {
		if (control) return control;
		if (resolving) return resolving;
		resolving = (async () => {
			const live = globalLookup('__walkCompanion');
			if (live && typeof live.announce === 'function') return live;
			if (!walkModule) return null;

			let mod = null;
			try {
				mod = await importModule(walkModule);
			} catch {
				return null;
			}
			if (typeof mod?.createWalkCompanion === 'function') {
				// Never flip the visitor's persisted companion preference on: the
				// SDK borrows the corner for a message and gives it straight back.
				return mod.createWalkCompanion(companionOptions || {});
			}
			// A module that installs the global on import (the three.ws build at
			// /walk-companion.js) rather than exporting a factory.
			const installed = globalLookup('__walkCompanion');
			return installed && typeof installed.announce === 'function' ? installed : null;
		})()
			.catch(() => null)
			.then((resolved) => {
				control = resolved;
				resolving = null;
				return resolved;
			});
		return resolving;
	}

	async function ready() {
		if (typeof globalThis?.document === 'undefined') return false;
		return !!(await resolveControl())?.announce;
	}

	/**
	 * @param {import('../rules.js').Message} message
	 * @param {{dwellMs:number, actions?:Array<object>}} opts
	 * @returns {Promise<boolean>} false when no avatar could be shown, which is
	 *   the runtime's signal to fall back rather than drop the message.
	 */
	async function present(message, { dwellMs = 6000, actions = [] } = {}) {
		const ctl = await resolveControl();
		if (!ctl?.announce) return false;
		const line = message.from ? `${message.from}: ${message.text}` : message.text;
		return !!(await ctl.announce(line, {
			hold: dwellMs,
			tone: message.tone === 'neutral' ? 'neutral' : 'alert',
			emote: message.emote || (message.tone === 'celebrate' ? 'dance' : 'wave'),
			actions,
			...(message.avatar ? { avatar: message.avatar } : {}),
		}));
	}

	function stop() {
		try {
			control?.instance?.hideBubble?.();
		} catch {
			/* companion already gone */
		}
	}

	return { name: 'avatar', ready, present, stop, get control() { return control; } };
}
