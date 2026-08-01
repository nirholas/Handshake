/**
 * Talk-mode emote controller.
 *
 * Wraps the existing AnimationManager (src/animation-manager.js) with:
 *   - manifest fetch from /animations/manifest.json
 *   - curated subset selection for the talk overlay's emote bar
 *   - lazy clip load on first play (fast first paint, no eager 30-clip fetch)
 *
 * AnimationManager already handles model attachment, track filtering by bone
 * names (so unmatched-rig clips no-op cleanly), crossfade, and one-shot vs
 * looped playback. This is just the glue and the UI-facing curation.
 *
 * The bone-name filter is what makes this safe across rig conventions: the
 * retargeted clips were authored against the Avaturn skeleton, but the
 * filter drops tracks for any joint not present on the loaded avatar, so
 * applying a "dance" clip to a robot or stylized mesh either animates the
 * matching bones or no-ops — never throws.
 */

import { AnimationManager } from '../animation-manager.js';
import { log } from '../shared/log.js';

// Curated set shown on the talk overlay's emote bar. Keep it short — too
// many buttons creates choice paralysis during a live conversation.
// Each entry's `name` must match a `name` in /animations/manifest.json.
export const TALK_EMOTE_BAR = [
	{ name: 'idle', label: 'Idle', icon: '🧍', loop: true },
	{ name: 'wave', label: 'Wave', icon: '👋', loop: false },
	{ name: 'celebrate', label: 'Celebrate', icon: '🎉', loop: false },
	{ name: 'dance', label: 'Dance', icon: '💃', loop: true },
	{ name: 'reaction', label: 'React', icon: '😲', loop: false },
	{ name: 'pray', label: 'Pray', icon: '🙏', loop: false },
];

export class TalkEmotes {
	constructor() {
		this._manager = new AnimationManager();
		this._defs = [];
		this._defsByName = new Map();
		this._loaded = new Set();
		this._loading = new Map(); // name → in-flight promise
		this._manifestPromise = null;
	}

	/** Attach to the live model. Call after TalkScene loads its GLB. */
	attach(model) {
		this._manager.attach(model);
	}

	detach() {
		this._manager.detach();
	}

	/**
	 * Re-measure the rig after a skeleton-space proportion edit (Avatar Studio's
	 * Proportions sliders) so root motion is rescaled to the new hip height and
	 * the avatar doesn't foot-slide. Call with the rig at rest.
	 * @returns {boolean}
	 */
	remeasureRig() {
		return this._manager.remeasureRigProportions();
	}

	/** Tick the underlying AnimationMixer. Hook into the scene's RAF loop. */
	update(dt) {
		this._manager.mixer?.update(dt);
	}

	/**
	 * Load the manifest. Idempotent — subsequent calls return the cached promise.
	 * Returns true once defs are populated, false on failure (e.g. 404).
	 *
	 * Not declared `async` so the cached promise identity is preserved across
	 * callers (an outer `async` wrapper would re-wrap on every invocation).
	 */
	loadManifest() {
		if (this._manifestPromise) return this._manifestPromise;
		this._manifestPromise = (async () => {
			try {
				const r = await fetch('/animations/manifest.json');
				if (!r.ok) return false;
				const list = await r.json();
				if (!Array.isArray(list)) return false;
				this._defs = list;
				this._defsByName = new Map(list.map((d) => [d.name, d]));
				this._manager.setAnimationDefs(list);
				return true;
			} catch (err) {
				log.warn('[talk-emotes] manifest fetch failed:', err?.message);
				return false;
			}
		})();
		return this._manifestPromise;
	}

	/** Available emote def list — full manifest, post-load. */
	getAllDefs() {
		return this._defs;
	}

	/**
	 * Return only the curated bar entries whose clip exists in the manifest.
	 * If the manifest hasn't loaded yet, returns []. The talk overlay should
	 * re-render after loadManifest() resolves.
	 */
	getBarDefs() {
		if (!this._defs.length) return [];
		return TALK_EMOTE_BAR.filter((entry) => this._defsByName.has(entry.name));
	}

	/**
	 * Play an emote by name. Lazy-loads the clip on first play; subsequent
	 * plays are immediate. The clip's loop flag is fixed at load time from
	 * the manifest entry.
	 *
	 * Returns false if the emote isn't in the manifest, true on play start.
	 */
	async play(name) {
		const def = this._defsByName.get(name);
		if (!def) {
			log.warn(`[talk-emotes] unknown emote: ${name}`);
			return false;
		}

		// Lazy-load with deduplication: parallel calls for the same name share
		// one in-flight fetch.
		if (!this._loaded.has(name)) {
			let inflight = this._loading.get(name);
			if (!inflight) {
				inflight = this._manager
					.loadAnimation(name, def.url, { loop: def.loop !== false })
					.then(() => this._loaded.add(name))
					.finally(() => this._loading.delete(name));
				this._loading.set(name, inflight);
			}
			try {
				await inflight;
			} catch (err) {
				log.warn(`[talk-emotes] load failed for "${name}":`, err?.message);
				return false;
			}
		}

		// Cross-fade if something else is already playing, otherwise just play.
		if (this._manager.currentName && this._manager.currentName !== name) {
			await this._manager.crossfadeTo(name, 0.25);
		} else {
			await this._manager.play(name);
		}
		return true;
	}

	/**
	 * Play a one-shot emote once, then settle back into a looping clip (idle by
	 * default) with a crossfade. For manifest entries whose `loop` is false
	 * (wave, celebrate, flex, …) this avoids freezing the avatar on the final
	 * frame. Lazily loads both the one-shot and the settle clip via the manager.
	 *
	 * @param {string} name
	 * @param {{ settleTo?: string, fade?: number }} [opts]
	 * @returns {Promise<boolean>} false if the emote isn't in the manifest.
	 */
	async playOnce(name, { settleTo = 'idle', fade = 0.25 } = {}) {
		const def = this._defsByName.get(name);
		if (!def) {
			log.warn(`[talk-emotes] unknown emote: ${name}`);
			return false;
		}
		await this._manager.playOnce(name, { settleTo, fade });
		return true;
	}

	get currentEmote() {
		return this._manager.currentName;
	}
}
