// Live 3D avatar for the /play boot loader.
//
// The boot loader (#kx-loading) covers the gap while the main scene bundle and
// avatar assets download. Instead of a bare spinner, we spin up a tiny WebGL
// canvas inside the loader card and render the real default avatar — loaded,
// posed into idle, and slowly turning under a soft key light — so the very
// first thing a player sees is a character, not a wait.
//
// Self-contained on purpose: this evaluates as soon as its module + Three.js
// chunk arrive (overlapping the main bundle's download), so the avatar is on
// screen as early as possible. It shares Three.js and the avatar-rig manifest
// with the scene, so the second GLB fetch is served from the browser cache.
//
// Hand-off: coincommunities.js awaits `window.__ccBootAvatar.ready` before it
// fades the loader out, then calls `dispose()`. `ready` ALWAYS resolves (even on
// WebGL/asset failure) so a missing avatar can never wedge the loader open.

import {
	Scene, PerspectiveCamera, WebGLRenderer, Box3, Vector3,
	HemisphereLight, DirectionalLight, AmbientLight, SRGBColorSpace,
} from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { AnimationManager } from '../animation-manager.js';
import {
	AVATAR_DEFAULT, loadManifest, getLocomotionDefs, CLIP_IDLE,
	resolveAvatarUrl, dracoLoader,
} from './avatar-rig.js';
import { getPlayAvatar } from './play-handoff.js';

const REDUCED_MOTION = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
const TURN_SPEED = 0.5; // radians/sec — a slow, premium turntable

function boot() {
	const canvas = document.getElementById('kx-boot-avatar');
	if (!canvas) return { ready: Promise.resolve(), dispose() {} };

	let renderer, scene, camera, anim, model, raf = 0, last = 0, yaw = -0.35, alive = true;
	let resolveReady;
	const ready = new Promise((res) => { resolveReady = res; });
	const done = () => { resolveReady?.(); resolveReady = null; };

	try {
		renderer = new WebGLRenderer({ canvas, alpha: true, antialias: true });
		renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
		renderer.outputColorSpace = SRGBColorSpace;
		sizeToBox();

		scene = new Scene();
		scene.add(new HemisphereLight(0xffffff, 0x202028, 1.1));
		const key = new DirectionalLight(0xffffff, 1.9);
		key.position.set(1.4, 2.6, 2.2);
		const rim = new DirectionalLight(0xbcd2ff, 0.7);
		rim.position.set(-1.8, 1.4, -2.0);
		scene.add(key, rim, new AmbientLight(0xffffff, 0.4));

		camera = new PerspectiveCamera(28, 1, 0.05, 100);
	} catch (err) {
		// No WebGL — reveal the static fallback mark and let the loader proceed.
		console.warn('[boot-avatar] WebGL unavailable:', err?.message);
		canvas.parentElement?.classList.add('kx-boot-noavatar');
		done();
		return { ready, dispose() {} };
	}

	window.addEventListener('resize', sizeToBox, { passive: true });

	// Preview the avatar the player has actually chosen (persisted in cc-avatar by
	// the lobby / a create→play handoff), not a generic default — so the first
	// character they see while the scene loads is *theirs*. DRACO is wired in
	// because most avatar GLBs are compressed. Falls back to the default on any
	// resolve/load failure so a broken pick never wedges the loader.
	const loader = new GLTFLoader();
	loader.setDRACOLoader(dracoLoader);
	resolveAvatarUrl(getPlayAvatar())
		.then((chosen) => loader.loadAsync(chosen).catch(() => loader.loadAsync(AVATAR_DEFAULT)))
		.then(async (gltf) => {
		if (!alive) return;
		model = gltf.scene;
		model.traverse((n) => { if (n.isMesh) { n.frustumCulled = false; n.castShadow = false; } });
		scene.add(model);

		// Feet on the ground, centred, framed from the chest up with a slight 3/4
		// turn — a portrait, not a full body lost in the small frame.
		const box = new Box3().setFromObject(model);
		const size = new Vector3(); box.getSize(size);
		const center = new Vector3(); box.getCenter(center);
		model.position.x -= center.x;
		model.position.z -= center.z;
		model.position.y -= box.min.y;

		const h = Math.max(0.4, size.y);
		const target = new Vector3(0, h * 0.82, 0);
		const frameH = h * 0.6;
		const fov = (camera.fov * Math.PI) / 180;
		const dist = (frameH / 2) / Math.tan(fov / 2) * 1.1;
		camera.position.set(0, target.y, dist);
		camera.lookAt(target);

		// Settle into idle so it reads as a standing character, not a T-pose.
		try {
			await loadManifest();
			const idle = getLocomotionDefs().find((d) => d.name === CLIP_IDLE);
			if (idle && alive) {
				anim = new AnimationManager();
				anim.attach(model);
				anim.setAnimationDefs([idle]);
				await anim.loadAll();
				await anim.crossfadeTo(CLIP_IDLE, 0);
			}
		} catch { /* render the bind pose */ }

		if (!alive) return;
		canvas.parentElement?.classList.add('kx-boot-ready');
		last = performance.now();
		loop(last, target);
		done();
	}).catch((err) => {
		console.warn('[boot-avatar] avatar load failed:', err?.message);
		canvas.parentElement?.classList.add('kx-boot-noavatar');
		done();
	});

	// Safety net: never hold the loader more than 6s waiting on the avatar.
	setTimeout(done, 6000);

	function loop(now, target) {
		if (!alive) return;
		raf = requestAnimationFrame((t) => loop(t, target));
		const dt = Math.min(0.05, (now - last) / 1000);
		last = now;
		if (!REDUCED_MOTION && model) {
			yaw += TURN_SPEED * dt;
			model.rotation.y = Math.sin(yaw) * 0.5 - 0.1; // gentle ease back and forth
		}
		anim?.update(dt);
		renderer.render(scene, camera);
	}

	function sizeToBox() {
		const r = canvas.getBoundingClientRect();
		const w = Math.max(1, r.width || canvas.clientWidth || 220);
		const h = Math.max(1, r.height || canvas.clientHeight || 280);
		renderer.setSize(w, h, false);
		if (camera) { camera.aspect = w / h; camera.updateProjectionMatrix(); }
	}

	function dispose() {
		alive = false;
		cancelAnimationFrame(raf);
		window.removeEventListener('resize', sizeToBox);
		try {
			anim?.dispose?.();
			model?.traverse((n) => {
				if (!n.isMesh) return;
				n.geometry?.dispose?.();
				const mats = Array.isArray(n.material) ? n.material : [n.material];
				for (const m of mats) {
					if (!m) continue;
					for (const k in m) { const v = m[k]; if (v && v.isTexture) v.dispose(); }
					m.dispose?.();
				}
			});
			renderer.dispose();
		} catch { /* best-effort teardown */ }
	}

	return { ready, dispose };
}

window.__ccBootAvatar = boot();
