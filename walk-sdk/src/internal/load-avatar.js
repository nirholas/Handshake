// Unified avatar loader + animation controller.
// ==============================================
// One entry point used by BOTH the corner companion and the full-page
// playground, so adding an avatar to the roster makes it work everywhere at
// once. Given a roster entry it loads the GLB and returns a controller with a
// single interface, setState('idle'|'walk'|'run'|'jump') + playWave() plus
// emotes() / playEmote(name) for on-command performances, no matter how the
// rig is animated underneath:
//
//   • embedded rigs play the clips baked into the GLB (robot, fox, showpieces),
//     with loose name matching that always falls back to the model's first clip
//     so even a one-animation GLB keeps moving and never shows a bind pose.
//   • shared rigs are driven by the retargeted shared clip library through
//     AnimationManager (humanoids that ship no locomotion, or only a T-pose).
//
// The caller is responsible for framing/scaling the returned `model`.

import { AnimationMixer, LoopOnce, LoopRepeat } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { getMeshoptDecoder } from './meshopt.js';
import { AnimationManager } from './runtime.js';
import { resolveClipUrls } from './manifest.js';
import { log } from './log.js';
import { resolveAvatarUrl, DEFAULT_SHARED_CLIPS, DEFAULT_EMOTES } from '../roster.js';

const DEFAULT_WAVE_MS = 1500;

// A looping emote clip (dance, headbang) performs one capped pass before the
// controller settles back to its base state: a tap is a performance, not a
// permanent mode switch.
const EMOTE_MAX_MS = 8000;

// Baked-clip name candidates per emote for embedded rigs, matched with the same
// loose case-insensitive lookup as the locomotion states. RobotExpressive (the
// default mascot) ships Dance/Punch/Wave; rigs missing a clip simply don't
// list that emote, and the UI hides its button.
const EMBEDDED_EMOTE_CANDIDATES = {
	dance: ['Dance'],
	punch: ['Punch'],
	backflip: ['Backflip', 'BackFlip', 'Back Flip', 'back_flip'],
	wave: ['Wave'],
};

/**
 * Resolve an emote map ({name: clip}) against the set of clips that actually
 * exist, dropping emotes whose clip is missing so a UI can render only buttons
 * that work. Pure; exported for tests.
 */
export function resolveEmotes(availableClipNames, emotes = DEFAULT_EMOTES) {
	const available = new Set(availableClipNames);
	const out = {};
	for (const [name, clip] of Object.entries(emotes)) {
		if (clip && available.has(clip)) out[name] = clip;
	}
	return out;
}

// Thrown by buildSharedController when the attached rig can't be driven by the
// shared clip library (no skinned humanoid skeleton). loadWalkAvatar catches it
// to recover to baked clips or the default rig — never a frozen T-pose.
const RIG_UNSUPPORTED = 'WALK_RIG_UNSUPPORTED';

let _loaderPromise = null;
async function makeLoader() {
	// One meshopt-only GLTFLoader, reused across loads. Draco/KTX2 are never
	// emitted by the bakes these avatars come from, so we skip those decoders.
	if (!_loaderPromise) {
		_loaderPromise = (async () => {
			const loader = new GLTFLoader();
			loader.setMeshoptDecoder(await getMeshoptDecoder());
			return loader;
		})();
	}
	return _loaderPromise;
}

/**
 * Load a roster entry and build its controller.
 * @returns {Promise<{ model: import('three').Object3D, controller: object, gltf: object }>}
 */
export async function loadWalkAvatar(entry, opts = {}) {
	const {
		assetBase = '',
		apiBase = '',
		manifestUrl = '/animations/manifest.json',
		fallbackEntry = null,
		waveMs = DEFAULT_WAVE_MS,
	} = opts;

	const loader = await makeLoader();
	const url = resolveAvatarUrl(entry, { assetBase, apiBase });
	if (!url) throw new Error(`walk: cannot resolve a GLB url for avatar "${entry?.id}"`);

	let active = entry;
	let gltf;
	try {
		gltf = await loader.loadAsync(url);
	} catch (err) {
		if (fallbackEntry && fallbackEntry.id !== entry.id) {
			log.warn(
				`avatar "${entry?.id}" failed to load — falling back to "${fallbackEntry.id}"`,
				err?.message || err,
			);
			active = fallbackEntry;
			gltf = await loader.loadAsync(resolveAvatarUrl(fallbackEntry, { assetBase, apiBase }));
		} else {
			throw err;
		}
	}

	const model = gltf.scene;
	model.traverse((n) => {
		if (n.isMesh) n.frustumCulled = false;
	});

	let controller;
	try {
		if (active.rig === 'shared') {
			controller = await buildSharedController(model, active.clips || DEFAULT_SHARED_CLIPS, {
				manifestUrl,
				waveMs,
				emotes: active.emotes,
			});
		} else {
			controller = makeEmbeddedController(model, gltf.animations || [], active.clips || {}, {
				waveMs,
			});
		}
	} catch (err) {
		// A `shared` entry whose GLB turns out NOT to be a retargetable humanoid
		// (no skinned mesh, too few canonical bones) can't be driven by the shared
		// clip library — left alone it would freeze in its bind/T-pose, which the
		// platform forbids. Recover without ever showing a T-pose:
		//   1. play whatever clips are baked into the GLB itself, else
		//   2. fall back to the default rig (the caller's fallbackEntry).
		if (err?.code === RIG_UNSUPPORTED) {
			if (gltf.animations && gltf.animations.length) {
				// Same expected-fallback path: baked clips are a designed recovery,
				// not a failure worth a warning on every page view.
				log.debug(
					`avatar "${active.id}" isn't a retargetable humanoid — driving its ${gltf.animations.length} baked clip(s) instead`,
				);
				// The shared `clips` map names manifest clips, not embedded ones, so
				// drop it and let the embedded matcher use generic names + first-clip
				// fallback (which never freezes).
				controller = makeEmbeddedController(model, gltf.animations, {}, { waveMs });
			} else if (fallbackEntry && fallbackEntry.id !== active.id) {
				// Expected, handled behavior (non-humanoid rigs fall back by design),
				// so log at debug, not warn, to keep every page view's console clean.
				log.debug(
					`avatar "${active.id}" can't be animated (non-humanoid rig, no baked clips) — falling back to "${fallbackEntry.id}"`,
				);
				disposeModel(model);
				// Recurse once into the default rig; clear fallbackEntry so a broken
				// default can't loop. The default (robot) is an embedded rig anyway.
				return loadWalkAvatar(fallbackEntry, { ...opts, fallbackEntry: null });
			} else {
				disposeModel(model);
				throw err;
			}
		} else {
			// Controller build failed after the GLB parsed — free the scene's GPU
			// resources so a failed avatar load doesn't leak meshes/textures.
			disposeModel(model);
			throw err;
		}
	}

	return { model, controller, gltf, entry: active };
}

// Release a parsed GLB scene's GPU resources (geometries, materials, textures)
// when a load is abandoned mid-way so a failed avatar build leaks nothing.
function disposeModel(model) {
	model.traverse((n) => {
		if (!n.isMesh) return;
		n.geometry?.dispose?.();
		const mats = Array.isArray(n.material) ? n.material : [n.material];
		for (const m of mats) {
			if (!m) continue;
			for (const v of Object.values(m)) if (v && v.isTexture) v.dispose();
			m.dispose?.();
		}
	});
}

// ── Embedded-clip controller (rig: 'embedded') ───────────────────────────────
function makeEmbeddedController(root, clips, overrides, { waveMs }) {
	const mixer = new AnimationMixer(root);
	const byName = (name) => clips.find((c) => c.name.toLowerCase() === String(name).toLowerCase());
	const pick = (cands) => {
		for (const n of cands) {
			const c = byName(n);
			if (c) return c;
		}
		return null;
	};
	const ov = (k) => (Array.isArray(overrides?.[k]) ? overrides[k] : []);

	// Idle must always resolve to *something* animated, so a single-clip GLB
	// (a lone walk or dance loop) never stalls in its bind/T-pose.
	const idleClip = pick([...ov('idle'), 'Idle', 'idle']) || clips[0] || null;
	const map = {
		idle: idleClip,
		walk: pick([...ov('walk'), 'Walking', 'Walk', 'walk']) || idleClip,
		run: pick([...ov('run'), 'Running', 'Run', 'run', 'Walking', 'walk']) || idleClip,
		jump: pick([...ov('jump'), 'Jump', 'jump', 'WalkJump']) || null,
		wave: pick([...ov('wave'), 'Wave', 'wave']) || null,
	};

	// Emotes resolve against the same baked clips; a rig without a matching clip
	// simply doesn't list that emote, so UIs can hide dead buttons.
	const emoteClip = {};
	for (const [name, cands] of Object.entries(EMBEDDED_EMOTE_CANDIDATES)) {
		const clip = pick([...ov(name), ...cands]);
		if (clip) emoteClip[name] = clip;
	}

	const action = {};
	for (const [state, clip] of Object.entries(map)) {
		if (!clip) continue;
		const a = mixer.clipAction(clip);
		a.enabled = true;
		action[state] = a;
	}
	const emoteAction = {};
	for (const [name, clip] of Object.entries(emoteClip)) {
		const a = mixer.clipAction(clip);
		a.enabled = true;
		emoteAction[name] = a;
	}

	let base = 'idle';
	let requested = 'idle';
	let current = null;
	let oneShot = false;

	function fadeTo(a, { once = false, dur = 0.3 } = {}) {
		if (!a) return;
		a.reset();
		a.setLoop(once ? LoopOnce : LoopRepeat, once ? 1 : Infinity);
		a.clampWhenFinished = once;
		a.fadeIn(dur).play();
		if (current && current !== a) current.fadeOut(dur);
		current = a;
	}

	function crossfade(name, opts) {
		fadeTo(action[name] || action.idle, opts);
	}

	mixer.addEventListener('finished', () => {
		if (oneShot) {
			oneShot = false;
			crossfade(base, { dur: 0.25 });
		}
	});

	crossfade('idle', { dur: 0 });

	return {
		setState(next) {
			if (next === requested) return;
			requested = next;
			if (next === 'jump') {
				if (action.jump) {
					oneShot = true;
					crossfade('jump', { once: true, dur: 0.12 });
				}
				return;
			}
			base = next;
			if (!oneShot) crossfade(base, { dur: 0.22 });
		},
		// Names this rig can actually perform; render only these as buttons.
		emotes() {
			return Object.keys(emoteAction);
		},
		// Play an emote once, then settle back to the current base state. A tap
		// mid-emote switches to the new one. Returns false when unsupported.
		playEmote(name) {
			const a = emoteAction[name];
			if (!a) return false;
			oneShot = true;
			fadeTo(a, { once: true, dur: 0.2 });
			// Safety net: if the 'finished' event is missed (clip stripped of its
			// end key, etc.), still fall back to the base after the clip's length.
			const len = a.getClip().duration * 1000 || waveMs;
			clearTimeout(this._emoteGuard);
			this._emoteGuard = setTimeout(() => {
				if (oneShot) {
					oneShot = false;
					crossfade(base, { dur: 0.25 });
				}
			}, Math.min(len, EMOTE_MAX_MS) + 250);
			return true;
		},
		playWave() {
			if (oneShot) return;
			this.playEmote('wave');
		},
		// Scale playback rate of every action (global mixer multiplier) so a walk
		// cycle can be sped up/slowed to match actual travel speed and keep feet
		// planted instead of skating. 1 = authored cadence. Survives crossfades.
		setSpeed(scale) {
			mixer.timeScale = scale > 0 ? scale : 1;
		},
		update(dt) {
			mixer.update(dt);
		},
		dispose() {
			clearTimeout(this._emoteGuard);
			mixer.stopAllAction();
			mixer.uncacheRoot(root);
		},
	};
}

// ── Shared retargeted-clip controller (rig: 'shared') ────────────────────────
async function buildSharedController(model, clips, { manifestUrl, waveMs, emotes }) {
	const manager = new AnimationManager();
	manager.attach(model);

	// attach() decides synchronously whether this rig is a retargetable humanoid
	// (skinned mesh + enough canonically-named bones). If not, the library can't
	// drive it — bail before fetching the manifest so loadWalkAvatar can recover
	// to baked clips or the default rig instead of leaving a silent bind pose.
	if (!manager.supportsCanonicalClips()) {
		manager.dispose();
		const err = new Error(
			'walk: rig is not a retargetable humanoid (no skinned skeleton) — cannot drive shared clips',
		);
		err.code = RIG_UNSUPPORTED;
		throw err;
	}

	const resolved = {};
	let resolvedEmotes = {};
	const clipMs = new Map();
	try {
		const manifest = await fetch(manifestUrl, { cache: 'force-cache' }).then((r) => {
			if (!r.ok) throw new Error(`HTTP ${r.status} fetching animation manifest`);
			return r.json();
		}).then((defs) => resolveClipUrls(defs, manifestUrl));
		const available = new Set(manifest.map((d) => d.name));
		for (const d of manifest) clipMs.set(d.name, (Number(d.duration) || 0) * 1000);

		// Resolve each requested clip to one that actually exists; unknown names fall
		// back to idle so the controller never asks the manager for a missing clip.
		for (const [state, name] of Object.entries({ ...DEFAULT_SHARED_CLIPS, ...clips })) {
			resolved[state] = available.has(name) ? name : null;
		}
		resolved.idle = resolved.idle || (available.has('idle') ? 'idle' : null);
		if (!resolved.idle) throw new Error('animation manifest missing an idle clip');
		for (const k of Object.keys(resolved)) if (!resolved[k]) resolved[k] = resolved.idle;

		// Emotes never fall back to idle: a missing clip drops the emote instead,
		// so every rendered emote button visibly performs.
		resolvedEmotes = resolveEmotes(available, { ...DEFAULT_EMOTES, ...(emotes || {}) });

		const wanted = new Set([...Object.values(resolved), ...Object.values(resolvedEmotes)]);
		manager.setAnimationDefs(manifest.filter((d) => wanted.has(d.name)));
		await manager.loadAll();
	} catch (err) {
		// The GLB loaded but the animation manifest/clips didn't — release the
		// AnimationManager's mixer/retarget state instead of leaking it.
		manager.dispose();
		throw err;
	}

	let base = 'idle';
	let waveTimer = null;
	const fade = (name, dur) => Promise.resolve(manager.crossfadeTo(name, dur)).catch(() => {});
	const clipFor = (state) => resolved[state] || resolved.idle;
	fade(resolved.idle, 0);

	return {
		setState(next) {
			if (next === base) return;
			base = next;
			if (!waveTimer) fade(clipFor(next), next === 'jump' ? 0.12 : 0.3);
		},
		// Names this rig can actually perform; render only these as buttons.
		emotes() {
			return Object.keys(resolvedEmotes);
		},
		// Play an emote once (loops get one capped pass), then settle back to the
		// base state. A tap mid-emote switches to the new one. False = unsupported.
		playEmote(name) {
			const clip = resolvedEmotes[name];
			if (!clip || clip === resolved.idle) return false;
			clearTimeout(waveTimer);
			fade(clip, 0.25);
			const len = clipMs.get(clip) || waveMs;
			waveTimer = setTimeout(() => {
				waveTimer = null;
				fade(clipFor(base), 0.3);
			}, Math.min(len, EMOTE_MAX_MS) + 150);
			return true;
		},
		playWave() {
			if (waveTimer) return;
			if (this.playEmote('wave')) return;
			// No wave emote resolved (host stripped it): fall back to the state
			// map's wave clip so nav-waves keep working exactly as before.
			const w = resolved.wave;
			if (!w || w === resolved.idle) return;
			fade(w, 0.25);
			waveTimer = setTimeout(() => {
				waveTimer = null;
				fade(clipFor(base), 0.3);
			}, waveMs);
		},
		// Scale playback rate of the active clip (global mixer multiplier) so a walk
		// cycle can be sped up/slowed to match actual travel speed and keep feet
		// planted instead of skating. 1 = authored cadence. Survives crossfades.
		setSpeed(scale) {
			if (manager.mixer) manager.mixer.timeScale = scale > 0 ? scale : 1;
		},
		update(dt) {
			manager.update(dt);
		},
		dispose() {
			clearTimeout(waveTimer);
			manager.dispose();
		},
	};
}
