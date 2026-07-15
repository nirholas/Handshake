// src/irl/pin-idle.js — breathe life into pinned agents.
//
// Every pin used to mount its GLB in the authored bind pose and stay there: a
// plaza of T-posed statues. This module gives each mounted pin the same idle
// clip the carried avatar plays, retargeted per rig through the universal
// canonicalize/retarget pipeline (AnimationManager), so ANY humanoid — Mixamo,
// Avaturn, VRM, Daz — idles naturally. Non-humanoid props fail the
// supportsCanonicalClips() gate and simply stay static, exactly as before.
//
// The idle clip JSON is fetched ONCE for the whole page (memoized promise) and
// injected into a per-pin AnimationManager, so N pins cost N mixers but only
// one network fetch. Animation is upside, never a gate: any failure (manifest
// missing, clip 404, rig rejected by the fallen-pose guard) returns null and
// the pin renders exactly as it did before this module existed.

import { AnimationManager } from '../animation-manager.js';
import { log } from '../shared/log.js';

const MANIFEST_URL = '/animations/manifest.json';
const CLIP_IDLE = 'idle';

let _idleJsonPromise = null;

/**
 * Fetch (once) the pre-baked idle clip JSON from the animation manifest.
 * Memoized across every pin on the page; a failed fetch clears the memo so a
 * later mount retries instead of poisoning the whole session.
 * @returns {Promise<object|null>} raw AnimationClip JSON, or null when unavailable
 */
export function getIdleClipJson() {
	if (!_idleJsonPromise) {
		_idleJsonPromise = (async () => {
			const manifest = await fetch(MANIFEST_URL, { cache: 'force-cache' }).then((r) => {
				if (!r.ok) throw new Error(`HTTP ${r.status}`);
				return r.json();
			});
			const def = Array.isArray(manifest) ? manifest.find((d) => d?.name === CLIP_IDLE) : null;
			if (!def?.url) throw new Error('idle clip missing from manifest');
			const res = await fetch(def.url, { cache: 'force-cache' });
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			return await res.json();
		})().catch((err) => {
			log.warn('[irl] idle clip unavailable:', err?.message || err);
			_idleJsonPromise = null; // allow a later mount to retry
			return null;
		});
	}
	return _idleJsonPromise;
}

/**
 * Attach an idle-playing AnimationManager to a freshly loaded pin model.
 * Call BEFORE the model is added to the scene (the retarget maps are captured
 * from the authored bind pose) and before any impostor bake, so the snapshot
 * captures a natural stance instead of the bind-pose T.
 *
 * @param {import('three').Object3D} model the pin's gltf.scene
 * @param {{ avatarUrl?: string }} [context] for the fallen-pose guard's reports
 * @returns {Promise<AnimationManager|null>} a manager already playing idle
 *   (caller must call .update(dt) per frame and .detach() on evict), or null
 *   when this rig can't be driven — the pin then stays static as before.
 */
export async function mountPinIdle(model, context = {}) {
	const clipJson = await getIdleClipJson();
	if (!clipJson || !model) return null;
	const mgr = new AnimationManager();
	try {
		mgr.attach(model, context);
		if (!mgr.supportsCanonicalClips()) {
			mgr.detach();
			return null;
		}
		mgr.injectClip(CLIP_IDLE, clipJson, { loop: true });
		const playing = await mgr.play(CLIP_IDLE);
		if (!playing) {
			mgr.detach();
			return null;
		}
		// Desynchronize: start each agent at a random phase so a plaza of pins
		// doesn't breathe in eerie lockstep.
		const action = mgr.currentAction;
		const duration = action?.getClip?.()?.duration || 0;
		if (action && duration > 0) action.time = Math.random() * duration;
		// Apply frame 0 now so the caller's impostor bake sees the posed skeleton.
		mgr.update(0);
		return mgr;
	} catch (err) {
		log.warn('[irl] pin idle mount failed:', err?.message || err);
		try { mgr.detach(); } catch { /* already clean */ }
		return null;
	}
}
