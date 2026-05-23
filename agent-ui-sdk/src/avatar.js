import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const ROOT_BONE_RX = /^(Hips|Root|mixamorig:?Hips)$/i;

/**
 * Load the avatar GLB and parse the named clip JSONs in parallel.
 *
 * @param {{
 *   avatar: string,
 *   clipsBase: string,
 *   clips: string[],
 *   subclips?: Record<string, { start: number, end: number, fps?: number }>
 * }} options
 */
export async function loadAvatar({ avatar, clipsBase, clips, subclips = {} }) {
	const loader = new GLTFLoader();
	const [gltf, clipJsons] = await Promise.all([
		new Promise((resolve, reject) => loader.load(avatar, resolve, undefined, reject)),
		Promise.all(clips.map((name) =>
			fetch(`${clipsBase}${name}.json`).then((r) => {
				if (!r.ok) throw new Error(`[agent-ui] failed to load clip "${name}": ${r.status}`);
				return r.json();
			})
		)),
	]);

	const object = gltf.scene;
	let rootBone = null;
	object.traverse((n) => {
		if (!rootBone && ROOT_BONE_RX.test(n.name)) rootBone = n;
	});
	object.rotation.y = 0;

	const parsed = {};
	clips.forEach((name, i) => {
		let clip = THREE.AnimationClip.parse(clipJsons[i]);
		const sub = subclips[name];
		if (sub) {
			clip = THREE.AnimationUtils.subclip(clip, name, sub.start, sub.end, sub.fps ?? 30);
		}
		parsed[name] = clip;
	});

	return { object, rootBone, clips: parsed };
}

/**
 * Wrap a mixer + actions table with crossfade semantics matching the demos.
 * Returns a small controller exposing play() / current() / onFinished().
 */
export function createAnimator({ object, clips, crossfade = 0.3 }) {
	const mixer = new THREE.AnimationMixer(object);
	const actions = {};
	for (const [name, clip] of Object.entries(clips)) {
		actions[name] = mixer.clipAction(clip);
	}
	let current = null;
	let currentName = null;

	const finishCallbacks = new Map();
	mixer.addEventListener('finished', (e) => {
		const cb = finishCallbacks.get(e.action);
		if (cb) {
			finishCallbacks.delete(e.action);
			cb();
		}
	});

	function play(name, { loop = true, hold = false, onComplete } = {}) {
		const next = actions[name];
		if (!next) {
			console.warn(`[agent-ui] no such clip: "${name}"`);
			return;
		}
		if (next === current && loop) return;
		next.reset();
		next.setLoop(loop ? THREE.LoopRepeat : THREE.LoopOnce, loop ? Infinity : 1);
		next.clampWhenFinished = hold;
		if (current) next.crossFadeFrom(current, crossfade, false).play();
		else next.fadeIn(crossfade).play();
		current = next;
		currentName = name;
		if (!loop && onComplete) finishCallbacks.set(next, onComplete);
	}

	function clipDuration(name) {
		return clips[name]?.duration ?? 1.0;
	}

	function update(dt) {
		mixer.update(dt);
	}

	return { play, update, clipDuration, get currentName() { return currentName; }, actions, clips };
}

/**
 * Many Mixamo clips bake hip translation into the walk cycle; if we let that
 * through, the avatar drifts off-screen during 'walk' loops or rises during
 * 'falling' loops. Patch renderer.render to clamp the root bone back to its
 * rest position every frame.
 */
export function lockRootMotion(renderer, rootBone) {
	if (!rootBone) return () => {};
	const basePos = rootBone.position.clone();
	const original = renderer.render.bind(renderer);
	renderer.render = (sc, cam) => {
		try { rootBone.position.copy(basePos); } catch (_) {}
		original(sc, cam);
	};
	return () => { renderer.render = original; };
}
