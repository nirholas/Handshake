/**
 * Walk preview for the avatar customizer — /avatars/:id/edit, "Walk" tab.
 *
 * Drives the *same* TalkScene.root the rest of the editor sculpts, so every
 * bone/blendshape/accessory edit shows up on the walking avatar instantly (no
 * rig reload needed — it's one shared Object3D). On top of the static pose the
 * editor normally shows, this module:
 *
 *   • retargets the canonical idle + walk clips onto the avatar and crossfades
 *     between them based on ground speed (foot-plant synced via mixer.timeScale),
 *   • auto-pilots the avatar around a 1.5m circle when idle, and hands control
 *     to WASD / arrow keys the moment the creator drives,
 *   • takes over the camera as a smooth third-person follow rig,
 *   • optionally loads a task-18 environment (void grid by default) behind it,
 *   • caps the canvas to 30fps so the editor stays responsive.
 *
 * Lifecycle: construct once, call enter()/exit() as the Walk tab is shown/hidden,
 * dispose() on teardown. enter()/exit() are idempotent and safe to interleave.
 */

import { Box3, Vector3, MathUtils } from 'three';
import { AnimationManager } from './animation-manager.js';
import {
	fetchEnvironmentManifest,
	resolveEnvName,
	getEnvironment,
	loadEnvironmentScenery,
	loadEnvironmentHDR,
	applySky,
} from './walk-environments.js';
import { log } from './shared/log.js';

const MANIFEST_URL = '/animations/manifest.json';
const CLIP_IDLE = 'idle';
const CLIP_WALK = 'av-walk-feminine';
const NATURAL_WALK_SPEED = 1.5; // m/s cadence the walk clip was authored at

const CIRCLE_RADIUS = 1.5; // m — auto-pilot orbit radius
const WALK_SPEED = 1.0; // m/s — target ground speed
const TURN_RATE = 2.6; // rad/s — manual yaw rate (A/D)
const TURN_LERP = 0.15; // how snappily facing follows the auto-pilot heading
const CAM_DISTANCE = 3.2; // m behind the avatar
const CAM_HEIGHT = 1.85; // m above the ground, at the camera
const CAM_LOOK_HEIGHT = 1.05; // m — point the camera aims at on the avatar
const CAM_LERP = 0.12; // follow-camera smoothing
const FPS_CAP = 30;

export class AvatarWalkPreview {
	/**
	 * @param {object} opts
	 * @param {import('./voice/talk-scene.js').TalkScene} opts.scene
	 * @param {HTMLElement} opts.stageEl  the editor stage element (for the on-stage hint + sky)
	 * @param {() => void} [opts.pauseAmbient]  pause the editor's idle layer while walking
	 * @param {() => void} [opts.resumeAmbient] resume it on exit
	 */
	constructor({ scene, stageEl, pauseAmbient, resumeAmbient }) {
		this.scene = scene;
		this.stageEl = stageEl || null;
		this.pauseAmbient = pauseAmbient || (() => {});
		this.resumeAmbient = resumeAmbient || (() => {});

		this.active = false;
		this.anim = null;
		this._tickDispose = null;
		this._savedControls = null;
		this._savedSky = '';
		this._origEnvironment = undefined;

		// Locomotion state.
		this.pos = new Vector3(CIRCLE_RADIUS, 0, 0);
		this.heading = 0;
		this.feetY = 0;
		this._motion = null; // 'idle' | 'walk' — last crossfade target
		this._camPos = new Vector3();
		this._camLook = new Vector3();
		this._camReady = false;

		this.keys = { forward: false, back: false, left: false, right: false };

		// Local TRS of every node captured at the pre-walk rest pose, restored on
		// exit so the skeleton never freezes mid-stride on the static editor tabs.
		this._poseSnapshot = null;

		// Environment.
		this.envManifest = null;
		this.envName = 'void';
		this._envGroup = null;
		this._envDispose = null;
		this._hdrDispose = null;
		this._envToken = 0;

		this._hintEl = null;
		this._onKeyDown = this._onKeyDown.bind(this);
		this._onKeyUp = this._onKeyUp.bind(this);
		this._statusCb = null;
	}

	supported() {
		return !!(this.anim && this.anim.supportsCanonicalClips());
	}

	onStatus(cb) {
		this._statusCb = cb;
	}

	_status(msg) {
		this._statusCb?.(msg);
	}

	/** Lazily load + retarget the idle/walk clips onto the avatar. */
	async _ensureAnim() {
		if (this.anim) return;
		const root = this.scene?.root;
		if (!root) throw new Error('avatar not loaded');
		const anim = new AnimationManager();
		anim.attach(root);
		let defs = [];
		try {
			const manifest = await fetch(MANIFEST_URL, { cache: 'force-cache' }).then((r) => {
				if (!r.ok) throw new Error(`HTTP ${r.status} loading animation manifest`);
				return r.json();
			});
			defs = manifest.filter((d) => d.name === CLIP_IDLE || d.name === CLIP_WALK);
		} catch (err) {
			log.warn('[avatar-edit-walk] manifest load failed:', err?.message);
		}
		anim.setAnimationDefs(defs);
		await anim.loadAll();
		this.anim = anim;
	}

	/**
	 * Re-measure the walk after a skeleton-space proportion edit. The walk clip's
	 * root translation is scaled to the rig's hip height at retarget time, so
	 * lengthening the legs without this leaves the avatar sliding: the feet cover
	 * more ground per stride than the root travels. No-op before the clips load.
	 * Caller must have the rig at rest (applyProportionsToRoot leaves it there).
	 * @returns {boolean}
	 */
	remeasureProportions() {
		return this.anim?.remeasureRigProportions?.() ?? false;
	}

	async enter() {
		if (this.active) return;
		this.active = true;
		this._status('Loading walk…');

		try {
			await this._ensureAnim();
		} catch (err) {
			this.active = false;
			this._status(`Could not start walk: ${err.message}`);
			throw err;
		}
		// A concurrent exit() may have fired while clips streamed in.
		if (!this.active) return;

		this.pauseAmbient();

		// Stop the GLB's own built-in clip (a baked idle) so it can't fight our
		// retargeted locomotion on the shared skeleton.
		this.scene.mixer?.stopAllAction?.();

		// Snapshot the rest pose now, before any walk-clip sampling deforms it.
		this._snapshotPose();

		// Zero the feet to the ground plane so the avatar reads as standing on the
		// floor / grid rather than floating, then seed the orbit start.
		const box = new Box3().setFromObject(this.scene.root);
		this.feetY = -box.min.y;
		this.pos.set(CIRCLE_RADIUS, 0, 0);
		this.heading = 0; // tangent of a CCW orbit at (R,0) points along +Z
		this._motion = null;
		this._camReady = false;

		// Hand the camera off from OrbitControls to our follow rig. Nulling the
		// scene's controls makes the render loop's `controls?.update()` a no-op so
		// it can't fight the per-frame camera writes below; restored on exit.
		this._savedControls = this.scene.controls;
		this.scene.controls = null;

		this.scene.setFpsCap?.(FPS_CAP);

		// Default environment: the void grid (task 18). Honours a previously chosen
		// env if enter() is re-run after the creator picked one.
		await this._applyEnvironment(this.envName).catch((err) =>
			log.warn('[avatar-edit-walk] env load failed:', err?.message),
		);

		window.addEventListener('keydown', this._onKeyDown);
		window.addEventListener('keyup', this._onKeyUp);
		this._installHint();

		this._tickDispose = this.scene.addOnTick((dt) => this._tick(dt));

		this._status(
			this.supported()
				? 'Walking. WASD / arrows to drive.'
				: 'This rig can’t be skeleton-driven — showing it in motion without a leg cycle.',
		);
	}

	async exit() {
		if (!this.active) return;
		this.active = false;

		this._tickDispose?.();
		this._tickDispose = null;

		window.removeEventListener('keydown', this._onKeyDown);
		window.removeEventListener('keyup', this._onKeyUp);
		this.keys = { forward: false, back: false, left: false, right: false };
		this._removeHint();

		this.scene.setFpsCap?.(0);

		// Stop locomotion sampling (keep the mixer attached for a fast re-entry)
		// and restore the exact pre-walk rest pose so the skeleton doesn't freeze
		// mid-stride under the (now-resumed) idle layer.
		this.anim?.mixer?.stopAllAction?.();
		this._motion = null;
		this._restorePose();
		if (this.scene.root) {
			this.scene.root.position.set(0, 0, 0);
			this.scene.root.rotation.y = 0;
		}

		// Restore camera control + ambient idle synchronously so the static editor
		// view is interactive immediately, then tear the environment down async.
		if (this._savedControls) {
			this.scene.controls = this._savedControls;
			this._savedControls = null;
		}
		this.scene.setCameraPreset?.(this.scene.getCameraPreset?.() || 'full');
		this.resumeAmbient();
		this._status('');

		await this._clearEnvironment();
	}

	dispose() {
		this.exit();
		this.anim?.dispose();
		this.anim = null;
		this._clearEnvironment();
	}

	// ── Rest pose ────────────────────────────────────────────────────────────

	_snapshotPose() {
		const snap = [];
		this.scene.root?.traverse((n) => {
			snap.push({ n, p: n.position.clone(), q: n.quaternion.clone(), s: n.scale.clone() });
		});
		this._poseSnapshot = snap;
	}

	_restorePose() {
		if (!this._poseSnapshot) return;
		for (const e of this._poseSnapshot) {
			e.n.position.copy(e.p);
			e.n.quaternion.copy(e.q);
			e.n.scale.copy(e.s);
		}
		this._poseSnapshot = null;
	}

	// ── Environment ────────────────────────────────────────────────────────

	availableEnvironments() {
		if (!this.envManifest) return [{ name: 'void', label: 'Void' }];
		return this.envManifest.environments.map((e) => ({ name: e.name, label: e.label || e.name }));
	}

	/** Ensure the manifest is loaded, then return the selectable environments. */
	async listEnvironments() {
		if (!this.envManifest) {
			this.envManifest = await fetchEnvironmentManifest().catch(() => null);
		}
		return this.availableEnvironments();
	}

	async setEnvironment(name) {
		this.envName = name;
		if (this.active) await this._applyEnvironment(name);
	}

	async _applyEnvironment(name) {
		const token = ++this._envToken;
		if (!this.envManifest) {
			this.envManifest = await fetchEnvironmentManifest().catch(() => ({
				default: 'void',
				environments: [{ name: 'void', label: 'Void', grid: {} }],
			}));
		}
		const resolved = resolveEnvName(this.envManifest, name);
		this.envName = resolved;
		const meta = getEnvironment(this.envManifest, resolved);
		if (!meta) return;

		await this._clearEnvironment(/* keepName */ true);
		if (token !== this._envToken) return;

		const { group, dispose } = await loadEnvironmentScenery(meta);
		if (token !== this._envToken) {
			dispose();
			return;
		}
		this.scene.scene.add(group);
		this._envGroup = group;
		this._envDispose = dispose;

		// Swap in the environment's IBL for believable reflections; stash the
		// editor's RoomEnvironment so exit() can put it back.
		if (this._origEnvironment === undefined) this._origEnvironment = this.scene.scene.environment;
		const hdr = await loadEnvironmentHDR(meta, this.scene.renderer).catch(() => null);
		if (token !== this._envToken) {
			hdr?.dispose();
			return;
		}
		if (hdr) {
			this.scene.scene.environment = hdr.texture;
			this._hdrDispose = hdr.dispose;
		} else {
			this.scene.scene.environment = this._origEnvironment;
		}

		// Paint the stage backdrop to the env sky (void has none → keep editor bg).
		if (this.stageEl) {
			if (!this._savedSky) this._savedSky = this.stageEl.style.background || '';
			if (meta.sky) applySky(meta, this.stageEl);
			else this.stageEl.style.background = this._savedSky;
		}
	}

	async _clearEnvironment(keepName = false) {
		if (this._envGroup) {
			this.scene.scene.remove(this._envGroup);
			this._envDispose?.();
			this._envGroup = null;
			this._envDispose = null;
		}
		if (this._hdrDispose) {
			this._hdrDispose();
			this._hdrDispose = null;
		}
		if (this._origEnvironment !== undefined && this.scene?.scene) {
			this.scene.scene.environment = this._origEnvironment;
			if (!keepName) this._origEnvironment = undefined;
		}
		if (!keepName && this.stageEl && this._savedSky) {
			this.stageEl.style.background = this._savedSky;
			this._savedSky = '';
		}
	}

	// ── On-stage hint ────────────────────────────────────────────────────────

	_installHint() {
		if (!this.stageEl || this._hintEl) return;
		const el = document.createElement('div');
		el.className = 'ae-walk-hint';
		el.textContent = 'WASD / arrows to drive';
		el.style.cssText =
			'position:absolute;left:50%;bottom:16px;transform:translateX(-50%);' +
			'padding:6px 14px;border-radius:999px;font-size:12px;font-weight:600;' +
			'letter-spacing:0.01em;color:rgba(255,255,255,0.92);' +
			'background:rgba(10,10,10,0.66);border:1px solid rgba(255,255,255,0.16);' +
			'backdrop-filter:blur(6px);pointer-events:none;z-index:6;' +
			'opacity:0;transition:opacity 0.3s ease;';
		this.stageEl.appendChild(el);
		this._hintEl = el;
		requestAnimationFrame(() => {
			if (this._hintEl) this._hintEl.style.opacity = '1';
		});
	}

	_removeHint() {
		if (!this._hintEl) return;
		const el = this._hintEl;
		this._hintEl = null;
		el.style.opacity = '0';
		el.addEventListener('transitionend', () => el.remove(), { once: true });
		// Failsafe removal in case the element is detached before the transition.
		setTimeout(() => el.remove(), 400);
	}

	// ── Input ──────────────────────────────────────────────────────────────

	_isTypingTarget(t) {
		if (!t) return false;
		const tag = t.tagName;
		return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || t.isContentEditable;
	}

	_onKeyDown(e) {
		if (!this.active || this._isTypingTarget(e.target)) return;
		if (this._applyKey(e.code, true)) e.preventDefault();
	}

	_onKeyUp(e) {
		if (!this.active) return;
		if (this._applyKey(e.code, false)) e.preventDefault();
	}

	_applyKey(code, down) {
		switch (code) {
			case 'KeyW':
			case 'ArrowUp':
				this.keys.forward = down;
				return true;
			case 'KeyS':
			case 'ArrowDown':
				this.keys.back = down;
				return true;
			case 'KeyA':
			case 'ArrowLeft':
				this.keys.left = down;
				return true;
			case 'KeyD':
			case 'ArrowRight':
				this.keys.right = down;
				return true;
			default:
				return false;
		}
	}

	_hasManualInput() {
		return this.keys.forward || this.keys.back || this.keys.left || this.keys.right;
	}

	// ── Per-frame ────────────────────────────────────────────────────────────

	_tick(dt) {
		if (!this.active || !this.scene.root) return;
		// Clamp dt so a tab-switch stall can't teleport the avatar across the stage.
		const step = Math.min(dt, 0.1);

		let speed = 0;
		if (this._hasManualInput()) {
			speed = this._driveManual(step);
		} else {
			speed = this._driveAutopilot(step);
		}

		// Commit transform to the shared root.
		this.scene.root.position.set(this.pos.x, this.feetY, this.pos.z);
		this.scene.root.rotation.y = this.heading;

		this._updateAnimation(speed, step);
		this._updateCamera(step);
	}

	_driveManual(dt) {
		// Tank-style controls: A/D yaw, W/S translate along facing.
		if (this.keys.left) this.heading += TURN_RATE * dt;
		if (this.keys.right) this.heading -= TURN_RATE * dt;
		const fwd = (this.keys.forward ? 1 : 0) - (this.keys.back ? 1 : 0);
		if (!fwd) return 0;
		const dir = fwd * WALK_SPEED;
		this.pos.x += Math.sin(this.heading) * dir * dt;
		this.pos.z += Math.cos(this.heading) * dir * dt;
		return Math.abs(dir);
	}

	_driveAutopilot(dt) {
		// Steer toward a point a little further along the radius-1.5 circle,
		// gently correcting back to the ring if a prior manual drive left it off.
		const curAngle = Math.atan2(this.pos.z, this.pos.x);
		const aheadAngle = curAngle + 0.35;
		const target = new Vector3(
			Math.cos(aheadAngle) * CIRCLE_RADIUS,
			0,
			Math.sin(aheadAngle) * CIRCLE_RADIUS,
		);
		const desired = Math.atan2(target.x - this.pos.x, target.z - this.pos.z);
		this.heading = lerpAngle(this.heading, desired, TURN_LERP);
		this.pos.x += Math.sin(this.heading) * WALK_SPEED * dt;
		this.pos.z += Math.cos(this.heading) * WALK_SPEED * dt;
		return WALK_SPEED;
	}

	_updateAnimation(speed, dt) {
		if (!this.anim) return;
		const moving = speed > 0.05;
		const want = moving ? 'walk' : 'idle';
		if (this._motion !== want) {
			this._motion = want;
			this.anim.crossfadeTo(want === 'walk' ? CLIP_WALK : CLIP_IDLE, 0.2).catch(() => {});
		}
		if (this.anim.mixer) {
			this.anim.mixer.timeScale = moving
				? MathUtils.clamp(speed / NATURAL_WALK_SPEED, 0.5, 1.7)
				: 1;
		}
		this.anim.update(dt);
	}

	_updateCamera(dt) {
		const cam = this.scene.camera;
		if (!cam) return;
		const ax = this.pos.x;
		const az = this.pos.z;
		// Sit behind the avatar along its facing, raised to eye-ish height.
		const desiredPos = this._camPos.set(
			ax - Math.sin(this.heading) * CAM_DISTANCE,
			this.feetY + CAM_HEIGHT,
			az - Math.cos(this.heading) * CAM_DISTANCE,
		);
		const desiredLook = this._camLook.set(ax, this.feetY + CAM_LOOK_HEIGHT, az);

		if (!this._camReady) {
			cam.position.copy(desiredPos);
			this._lookCurrent = desiredLook.clone();
			this._camReady = true;
		} else {
			const lerp = 1 - Math.pow(1 - CAM_LERP, dt * 60); // frame-rate independent
			cam.position.lerp(desiredPos, lerp);
			this._lookCurrent.lerp(desiredLook, lerp);
		}
		cam.lookAt(this._lookCurrent);
	}
}

/** Shortest-path angular lerp so facing never spins the long way round. */
function lerpAngle(a, b, t) {
	let d = (b - a) % (Math.PI * 2);
	if (d > Math.PI) d -= Math.PI * 2;
	if (d < -Math.PI) d += Math.PI * 2;
	return a + d * t;
}
