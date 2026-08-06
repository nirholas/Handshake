// Avatar thumbnail renderer — turns a GLB/VRM avatar URL into a small framed
// PNG portrait so the lobby's avatar picker shows the *actual* model instead of
// a generic emoji. One shared offscreen WebGLRenderer snapshots each avatar in
// turn and caches the result by URL, so previewing N avatars costs a single
// WebGL context (not N live canvases) — consistent with the scene's WebGL
// context budget. Avatars natively face +Z (the scene rotates them to face the
// chase camera), so the portrait camera sits on +Z for a head-on front view.

import {
	Scene, PerspectiveCamera, WebGLRenderer, Group, Box3, Vector3,
	HemisphereLight, DirectionalLight, AmbientLight,
} from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { AnimationManager } from '../animation-manager.js';
import { loadManifest, getLocomotionDefs, CLIP_IDLE, dracoLoader, meshoptReady } from './avatar-rig.js';
import { log } from '../shared/log.js';
import { applyCinematicDefaults, loadEnvironment } from '../shared/cinematic-render.js';

const SIZE = 160; // square render target, downscaled by the chip's CSS box

// Share the rig's Draco-enabled loader so compressed avatar GLBs preview too,
// plus the shared meshopt decoder so EXT_meshopt_compression GLBs (incl. the
// default avatar) preview instead of throwing.
const _loader = new GLTFLoader();
_loader.setDRACOLoader(dracoLoader);
meshoptReady.then((decoder) => { if (decoder) _loader.setMeshoptDecoder(decoder); });
const _cache = new Map(); // url -> Promise<string|null> (PNG data URL)
let _renderer = null;
let _scene = null;
let _camera = null;
let _failed = false; // WebGL unavailable — give up quietly after the first try

function ensureRenderer() {
	if (_renderer) return true;
	if (_failed) return false;
	try {
		_renderer = new WebGLRenderer({ alpha: true, antialias: true, preserveDrawingBuffer: true });
		// Cinematic defaults (ACES tone mapping, sRGB output) shared with every
		// other viewer on the platform. Product-shot style HDRI, loaded once for
		// this shared offscreen renderer (not per-thumbnail) and fire-and-forget
		// so it never blocks the first render.
		applyCinematicDefaults(_renderer, { exposure: 1.1, tier: 'medium' });
		_renderer.setPixelRatio(1); // fixed thumbnail resolution, independent of quality tier
		_renderer.setSize(SIZE, SIZE, false);
		_scene = new Scene();
		// Procedural room environment, same call boot-avatar makes and for the
		// same reason: a 160px thumbnail cannot justify a 1.5MB studio HDRI
		// download racing the lobby's avatar GLBs for bandwidth.
		loadEnvironment(_renderer, _scene, null);
		_scene.add(new HemisphereLight(0xffffff, 0x404a5a, 1.15));
		const key = new DirectionalLight(0xffffff, 1.7);
		key.position.set(1.6, 2.4, 2.0);
		_scene.add(key, new AmbientLight(0xffffff, 0.45));
		_camera = new PerspectiveCamera(30, 1, 0.01, 100);
		return true;
	} catch (err) {
		log.warn('[avatar-thumb] WebGL unavailable, skipping previews:', err?.message);
		_failed = true;
		_renderer = null;
		return false;
	}
}

// Snapshots share ONE offscreen scene (_scene), so they must run one at a
// time: the lobby fires 7 preset chips concurrently, and overlapping renders
// used to composite each other's avatars into the same PNG. A promise chain
// serializes them; each caller still gets its own result promise.
let _queue = Promise.resolve();
function enqueueSnapshot(url) {
	const run = _queue.then(() => _snapshot(url));
	// The queue itself must never reject or every later thumbnail dies with it.
	_queue = run.catch(() => {});
	return run;
}

// Render `url` to a PNG portrait data URL. Cached per URL (including the null
// failure case) so repeated picker renders never re-load or re-render a model.
export function renderAvatarThumb(url) {
	if (!url) return Promise.resolve(null);
	if (_cache.has(url)) return _cache.get(url);
	const p = enqueueSnapshot(url).catch((err) => {
		log.warn('[avatar-thumb] preview failed:', url, err?.message);
		return null;
	});
	_cache.set(url, p);
	return p;
}

async function _snapshot(url) {
	if (!ensureRenderer()) return null;
	await meshoptReady; // ensure the decoder is wired before the first parse
	const gltf = await _loader.loadAsync(url);
	const model = gltf.scene;
	model.traverse((n) => { if (n.isMesh) n.frustumCulled = false; });
	_scene.add(model);

	// Settle the rig into idle so portraits read as a standing character, not a
	// stiff T-pose bind pose. Best-effort: a model with no skeleton or a missing
	// idle clip simply renders as-imported.
	let anim = null;
	try {
		await loadManifest();
		const idle = getLocomotionDefs().find((d) => d.name === CLIP_IDLE);
		if (idle) {
			anim = new AnimationManager();
			anim.attach(model);
			anim.setAnimationDefs([idle]);
			await anim.loadAll();
			await anim.crossfadeTo(CLIP_IDLE, 0);
			anim.update(0.6); // advance into the idle loop for a relaxed stance
		}
	} catch { /* render the bind pose */ }

	try {
		// Feet on the ground, centred on the vertical axis.
		const box = new Box3().setFromObject(model);
		const size = new Vector3(); box.getSize(size);
		const center = new Vector3(); box.getCenter(center);
		model.position.x -= center.x;
		model.position.z -= center.z;
		model.position.y -= box.min.y;

		// Portrait framing: aim at the head/shoulders and fill the frame with the
		// upper body, with a slight 3/4 turn for depth.
		const h = Math.max(0.2, size.y);
		const target = new Vector3(0, h * 0.84, 0);
		const frameH = h * 0.52;
		const fov = (_camera.fov * Math.PI) / 180;
		const dist = (frameH / 2) / Math.tan(fov / 2) * 1.12;
		_camera.position.set(dist * 0.22, target.y, dist);
		_camera.lookAt(target);
		_camera.updateProjectionMatrix();

		_renderer.render(_scene, _camera);
		return _renderer.domElement.toDataURL('image/png');
	} finally {
		anim?.dispose?.();
		_scene.remove(model);
		model.traverse((n) => {
			if (!n.isMesh) return;
			n.geometry?.dispose?.();
			const mats = Array.isArray(n.material) ? n.material : [n.material];
			for (const m of mats) {
				if (!m) continue;
				for (const k in m) { const v = m[k]; if (v && v.isTexture) v.dispose(); }
				m.dispose?.();
			}
		});
	}
}
