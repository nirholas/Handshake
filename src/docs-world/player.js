// Docs World player: the visitor's avatar walking the documentation.
//
// Loads the default rigged body (or a custom GLB passed via ?avatar=, the same
// contract /play honours) and drives it with the platform's canonical clip
// library through AnimationManager, so any humanoid rig walks here exactly as
// it does in /walk. If the GLB or WebGL-side load fails, a simple glowing
// capsule stands in: the world stays fully usable, it just loses the fancy
// body.

import {
	Box3,
	CapsuleGeometry,
	Group,
	Mesh,
	MeshStandardMaterial,
	Vector3,
} from 'three';
import { AnimationManager } from '../animation-manager.js';
import { gltfLoader } from '../loaders/gltf.js';
import { log } from '../shared/log.js';
import { WORLD_RADIUS, RING_RADIUS } from './world.js';

// The same default body /walk, /walk-embed and the embed preview use. It must
// be a *skinned* rig: the canonical clip library drives the skeleton, so an
// unskinned prop (mannequin.glb carries 0 skins) would stand frozen no matter
// which clips loaded.
const DEFAULT_BODY_GLB = '/avatars/default.glb';

const CLIP_IDLE = 'idle';
const CLIP_WALK = 'av-walk-feminine'; // same walk clip /walk uses; timeScale sets pace

const WALK_SPEED = 3.1; // m/s
const RUN_SPEED = 6.0;
const ACCEL = 18;
const FRICTION = 14;
const TURN_LERP = 12;

// Pavilion platforms are solid: keep the player from clipping through the
// portal rings by pushing them out of a small keep-out disc per pavilion.
const PAVILION_KEEPOUT = 2.4;

const GLB_RE = /\.(glb|gltf|vrm)(\?|#|$)/i;

/** Resolve the avatar to walk with: ?avatar=<glb url> or the default body. */
export function requestedAvatarUrl(search = location.search) {
	try {
		const q = new URLSearchParams(search).get('avatar');
		if (q && GLB_RE.test(q)) {
			const url = new URL(q, location.origin);
			if (url.protocol === 'https:' || url.origin === location.origin) return url.href;
		}
	} catch {
		/* malformed query: fall through to the default body */
	}
	return DEFAULT_BODY_GLB;
}

function fallbackBody() {
	const mesh = new Mesh(
		new CapsuleGeometry(0.32, 1.05, 6, 14),
		new MeshStandardMaterial({
			color: 0x2a2444,
			roughness: 0.5,
			metalness: 0.3,
			emissive: 0x8b5cf6,
			emissiveIntensity: 0.35,
		}),
	);
	mesh.position.y = 0.85;
	return mesh;
}

/**
 * @param {import('three').Scene} scene
 * @param {import('three').WebGLRenderer} renderer
 * @param {{ avatarUrl?: string }} [opts]
 */
export function createPlayer(scene, renderer, { avatarUrl = DEFAULT_BODY_GLB } = {}) {
	const root = new Group();
	// Spawn a few metres off plaza centre: the beacon monolith stands at the
	// exact origin and would otherwise occlude the freshly-loaded avatar.
	// Facing -z, matching the camera's spawn yaw of PI (controls.js), so the
	// first view reads avatar → plaza → pavilion ring.
	root.position.set(0, 0, 3.2);
	root.rotation.y = Math.PI;
	scene.add(root);

	const anim = new AnimationManager();
	let height = 1.7;
	let modelReady = false;
	let currentClip = null;

	const loader = gltfLoader(renderer);
	loader.load(
		avatarUrl,
		async (gltf) => {
			const model = gltf.scene;
			const box = new Box3().setFromObject(model);
			const size = box.getSize(new Vector3());
			// Normalise wildly-scaled custom rigs to human height.
			if (size.y > 0.1 && (size.y < 1.2 || size.y > 2.4)) {
				model.scale.multiplyScalar(1.7 / size.y);
			}
			const fitted = new Box3().setFromObject(model);
			model.position.y -= fitted.min.y;
			height = Math.max(1.2, fitted.max.y - fitted.min.y);
			root.add(model);

			anim.attach(model, { avatarUrl });
			try {
				const defs = await fetch('/animations/manifest.json').then((r) => (r.ok ? r.json() : []));
				if (Array.isArray(defs) && defs.length) {
					anim.setAnimationDefs(defs);
					const ok = await anim.ensureLoaded(CLIP_IDLE);
					if (ok) await anim.crossfadeTo(CLIP_IDLE, 0);
					currentClip = CLIP_IDLE;
					anim.ensureLoaded(CLIP_WALK).catch(() => {});
				}
			} catch (err) {
				log.warn('[docs-world] clip library unavailable', err?.message);
			}
			modelReady = true;
		},
		undefined,
		(err) => {
			log.warn('[docs-world] avatar load failed, using capsule body', err?.message);
			root.add(fallbackBody());
			modelReady = true;
		},
	);

	const velocity = new Vector3();
	const desired = new Vector3();
	let running = false;
	let targetYaw = 0;

	/**
	 * Advance the simulation.
	 *
	 * @param {number} dt seconds (already clamped by the caller)
	 * @param {{x:number, z:number}} move input vector in camera space, |v| <= 1
	 * @param {number} camYaw camera yaw so input is screen-relative
	 * @param {boolean} run
	 * @param {Array<{group: import('three').Group}>} pavilions keep-out volumes
	 */
	function update(dt, move, camYaw, run, pavilions) {
		running = run;
		const mag = Math.min(1, Math.hypot(move.x, move.z));
		const speedCap = (run ? RUN_SPEED : WALK_SPEED) * mag;

		if (mag > 0.01) {
			// Rotate the stick vector into world space around the camera yaw.
			const sin = Math.sin(camYaw);
			const cos = Math.cos(camYaw);
			desired.set(move.x * cos + move.z * sin, 0, -move.x * sin + move.z * cos);
			desired.normalize().multiplyScalar(speedCap);
			velocity.x += (desired.x - velocity.x) * Math.min(1, ACCEL * dt);
			velocity.z += (desired.z - velocity.z) * Math.min(1, ACCEL * dt);
			targetYaw = Math.atan2(velocity.x, velocity.z);
		} else {
			const damp = Math.max(0, 1 - FRICTION * dt);
			velocity.x *= damp;
			velocity.z *= damp;
		}

		root.position.x += velocity.x * dt;
		root.position.z += velocity.z * dt;

		// World bound: soft clamp to the walkable disc.
		const dist = Math.hypot(root.position.x, root.position.z);
		if (dist > WORLD_RADIUS) {
			root.position.x *= WORLD_RADIUS / dist;
			root.position.z *= WORLD_RADIUS / dist;
		}

		// Pavilion keep-out: push out radially so portals stay walk-aroundable.
		if (pavilions) {
			for (const p of pavilions) {
				const dx = root.position.x - p.group.position.x;
				const dz = root.position.z - p.group.position.z;
				const d = Math.hypot(dx, dz);
				if (d > 0.001 && d < PAVILION_KEEPOUT) {
					const push = PAVILION_KEEPOUT / d;
					root.position.x = p.group.position.x + dx * push;
					root.position.z = p.group.position.z + dz * push;
				}
			}
		}

		// Face travel direction.
		const speed = Math.hypot(velocity.x, velocity.z);
		if (speed > 0.15) {
			let delta = targetYaw - root.rotation.y;
			while (delta > Math.PI) delta -= Math.PI * 2;
			while (delta < -Math.PI) delta += Math.PI * 2;
			root.rotation.y += delta * Math.min(1, TURN_LERP * dt);
		}

		// Locomotion clips: idle below a threshold, walk above, run = faster walk.
		if (modelReady && anim.mixer) {
			const want = speed > 0.35 ? CLIP_WALK : CLIP_IDLE;
			if (want !== currentClip && anim.canPlay(want)) {
				currentClip = want;
				anim.crossfadeTo(want, want === CLIP_WALK ? 0.18 : 0.25).catch(() => {});
			}
			anim.setSpeed(want === CLIP_WALK ? Math.max(0.85, Math.min(1.7, speed / WALK_SPEED)) : 1);
			anim.update(dt);
		}
	}

	return {
		root,
		get position() {
			return root.position;
		},
		get height() {
			return height;
		},
		get speed() {
			return Math.hypot(velocity.x, velocity.z);
		},
		get running() {
			return running;
		},
		update,
		setVisible(v) {
			root.visible = v;
		},
		/** Drop the player just inside the ring, facing a pavilion. */
		teleportToPavilion(pavilion) {
			const a = pavilion.angle;
			const r = RING_RADIUS - PAVILION_KEEPOUT - 1.4;
			root.position.set(Math.cos(a) * r, 0, Math.sin(a) * r);
			root.rotation.y = Math.atan2(
				pavilion.group.position.x - root.position.x,
				pavilion.group.position.z - root.position.z,
			);
			velocity.set(0, 0, 0);
		},
	};
}
