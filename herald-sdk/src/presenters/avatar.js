// The avatar presenter: a 3D character walks into the corner and says it.
//
// This is the whole point of the SDK, and it is deliberately the thinnest file
// in it. The body, the rig, the retargeted walk cycle, the speech bubble and
// the corner arbitration all already exist in @three-ws/walk; this presenter's
// only job is to find a companion (a live one on the page, the package, or the
// CDN build) and hand it a line.
//
// Resolution order, cheapest first:
//   1. `window.__walkCompanion`: three.ws pages already run one, and reusing
//      it means the visitor's own avatar delivers the message instead of a
//      second character appearing beside it.
//   2. A companion the integrator passed in (`companion` option).
//   3. `import('@three-ws/walk')`: bundlers resolve this at build time.
//   4. `import(cdn)`: a plain <script type="module"> page with no bundler.
// Every rung is optional. If none resolve, `ready()` is false and the runtime
// falls back to the card presenter, which needs nothing at all.

const DEFAULT_CDN = 'https://three.ws/agent-3d/latest/walk.mjs';

/**
 * @param {object} [opts]
 * @param {object} [opts.companion] a control object from createWalkCompanion()
 * @param {object} [opts.companionOptions] options used when this presenter
 *   creates its own companion (avatars, defaultAvatarId, assetBase, apiBase...)
 * @param {string|null} [opts.cdn] module URL used when the package is absent
 * @param {(name: string) => any} [opts.globalLookup] test seam for window lookups
 */
export function createAvatarPresenter({
	companion = null,
	companionOptions = null,
	cdn = DEFAULT_CDN,
	globalLookup = (name) => globalThis?.[name],
} = {}) {
	let control = companion;
	let resolving = null;

	async function resolveControl() {
		if (control) return control;
		if (resolving) return resolving;
		resolving = (async () => {
			const live = globalLookup('__walkCompanion');
			if (live && typeof live.announce === 'function') return live;

			const mod = await importWalk(cdn);
			if (!mod?.createWalkCompanion) return null;
			const created = mod.createWalkCompanion(companionOptions || {});
			// Never flip the visitor's persisted companion preference on: the
			// SDK borrows the corner for a message and gives it straight back.
			return created;
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

// Kept separate so a bundler that cannot resolve the optional package still
// produces a working build: the failure is caught and the CDN rung runs.
async function importWalk(cdn) {
	try {
		return await import(/* @vite-ignore */ '@three-ws/walk');
	} catch {
		if (!cdn) return null;
		try {
			return await import(/* @vite-ignore */ cdn);
		} catch {
			return null;
		}
	}
}
