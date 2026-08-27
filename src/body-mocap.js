/**
 * BodyMocap — webcam body/limb motion capture for Three.js humanoid avatars.
 *
 * The body counterpart to FaceMocap. Uses MediaPipe Pose Landmarker (from the
 * already-bundled `@mediapipe/tasks-vision`) to recover 33 world landmarks per
 * frame, runs them through the pure `pose-solve` solver to get per-bone rotation
 * deltas, smooths each with damped slerp, and drives the avatar's humanoid bones.
 *
 * Pipeline:
 *   webcam → Pose Landmarker → world landmarks → solvePose() →
 *   parent-local quaternion conversion → damped slerp → bone.quaternion
 *
 * Designed to compose with FaceMocap on the same avatar: FaceMocap owns morphs +
 * the head bone; BodyMocap owns the arms, spine, and legs. Neither touches the
 * other's bones. It attaches to the existing Viewer render loop the same way
 * FaceMocap does — the caller pushes `bodyMocap.update` into the per-frame hook.
 */

import { PoseLandmarker, FilesetResolver } from '@mediapipe/tasks-vision';
import { Quaternion } from 'three';
import { solvePose } from './runtime/pose-solve.js';
import { canonicalizeBoneName } from './glb-canonicalize.js';

import { modelUrl, visionWasmBase } from './shared/mediapipe-assets.js';
// Runtime + model locations come from the shared resolver (see face-mocap.js).
const MODEL_URL = modelUrl('pose_landmarker/pose_landmarker_full/float16/1/pose_landmarker_full.task');

// Canonical bones this module is allowed to drive. Head/neck stay with FaceMocap.
const DRIVEN_BONES = Object.freeze([
	'LeftArm', 'LeftForeArm', 'RightArm', 'RightForeArm',
	'Spine', 'LeftUpLeg', 'LeftLeg', 'RightUpLeg', 'RightLeg',
]);

// Delegate to the shared canonicalizer so all rig conventions (Mixamo,
// Blender .L/.R, Rigify DEF-/ORG-, VRM, CharacterStudio CH_, Daz, etc.)
// are handled consistently with the rest of the app.
function canonicalKey(name) {
	return (canonicalizeBoneName(name) || '').toLowerCase();
}

export class BodyMocap {
	constructor(opts = {}) {
		this._landmarker   = null;
		this._video        = null;
		this._stream       = null;
		this._running      = false;
		this._lastVideoTime = -1;
		this._lastResult   = null;
		this._onPose       = null;

		this._mirror = opts.mirror ?? false;
		this._legs   = opts.legs ?? true;
		// Damping for the per-bone slerp. Higher = snappier, lower = smoother.
		// Expressed as a per-second rate so motion is framerate-independent.
		this._stiffness = opts.stiffness ?? 12;
		this._minVisibility = opts.minVisibility ?? 0.5;

		// Per-driven-bone runtime state: { node, restLocal }.
		this._bones = new Map();

		// Scratch quaternions — zero per-frame allocation in the hot path.
		this._qParent     = new Quaternion();
		this._qParentInv  = new Quaternion();
		this._qLocalDelta = new Quaternion();
		this._qTarget     = new Quaternion();

		this._fps = 0; this._fpsFrames = 0; this._fpsLastT = 0;

		this.recording  = false;
		this._recordBuf = [];
		this._recordT0  = 0;
	}

	// ── Lifecycle ─────────────────────────────────────────────────────────────

	async init() {
		const fileset = await FilesetResolver.forVisionTasks(await visionWasmBase());
		this._landmarker = await PoseLandmarker.createFromOptions(fileset, {
			baseOptions: { modelAssetPath: MODEL_URL, delegate: 'GPU' },
			runningMode: 'VIDEO',
			numPoses: 1,
			outputSegmentationMasks: false,
		});
	}

	async startWebcam() {
		this._stream = await navigator.mediaDevices.getUserMedia({
			video: { width: 640, height: 480, facingMode: 'user' },
			audio: false,
		});
		const video = document.createElement('video');
		video.srcObject   = this._stream;
		video.autoplay    = true;
		video.playsInline = true;
		video.muted       = true;
		await new Promise((res) => { video.onloadeddata = res; });
		this._video = video;
		return video;
	}

	/**
	 * Bind to an avatar root. Walks the skeleton, resolves the canonical bones we
	 * drive, and captures each bone's rest local quaternion so target rotations
	 * compose on top of the rig's bind pose rather than replacing it.
	 */
	attach(avatarRoot) {
		this._bones.clear();
		const wanted = new Set(DRIVEN_BONES.map((b) => b.toLowerCase()));
		const byKey = new Map();
		avatarRoot.traverse((node) => {
			if (!node.isBone) return;
			const key = canonicalKey(node.name);
			if (wanted.has(key) && !byKey.has(key)) byKey.set(key, node);
		});
		for (const canonical of DRIVEN_BONES) {
			const node = byKey.get(canonical.toLowerCase());
			if (node) {
				this._bones.set(canonical, { node, restLocal: node.quaternion.clone() });
			}
		}
		return this._bones.size;
	}

	start() { this._running = true; }

	stop() {
		this._running = false;
		this._stream?.getTracks().forEach((t) => t.stop());
		this._video = null;
		this._stream = null;
	}

	onPoseDetected(cb) { this._onPose = cb; }

	// ── Per-frame ─────────────────────────────────────────────────────────────

	update(dt = 1 / 60) {
		if (!this._running || !this._landmarker || !this._video) return;
		if (this._video.readyState < 2) return;

		const ct = this._video.currentTime;
		if (ct === this._lastVideoTime) return;
		this._lastVideoTime = ct;

		const now = performance.now();
		const result = this._landmarker.detectForVideo(this._video, now);
		this._lastResult = result;

		this._fpsFrames++;
		if (now - this._fpsLastT >= 500) {
			this._fps = (this._fpsFrames * 1000) / (now - this._fpsLastT);
			this._fpsFrames = 0;
			this._fpsLastT  = now;
		}

		const world = result.worldLandmarks?.[0];
		const hasPose = !!world;
		this._onPose?.(hasPose);
		if (!hasPose) return;

		const { bones } = solvePose(world, {
			mirror: this._mirror,
			legs: this._legs,
			minVisibility: this._minVisibility,
		});

		this._applyBones(bones, dt);

		if (this.recording) {
			if (this._recordBuf.length === 0) this._recordT0 = now;
			const frame = { t: (now - this._recordT0) / 1000, q: {} };
			for (const [name, q] of Object.entries(bones)) {
				frame.q[name] = [q.x, q.y, q.z, q.w];
			}
			this._recordBuf.push(frame);
		}
	}

	/**
	 * Apply solved world-space rest→target deltas to the rig. Converts each delta
	 * into the bone's parent-local frame, composes with the captured rest pose,
	 * and damp-slerps toward it. Bones absent from `solved` hold their current
	 * rotation (occlusion) rather than snapping back to rest.
	 */
	_applyBones(solved, dt) {
		const alpha = 1 - Math.exp(-this._stiffness * dt); // framerate-independent damping
		for (const [name, state] of this._bones) {
			const worldDelta = solved[name];
			if (!worldDelta) continue;
			const { node, restLocal } = state;

			// localDelta = P⁻¹ · worldDelta · P, then target = localDelta · restLocal
			node.parent.getWorldQuaternion(this._qParent);
			this._qParentInv.copy(this._qParent).invert();
			this._qLocalDelta
				.copy(this._qParentInv)
				.multiply(worldDelta)
				.multiply(this._qParent);
			this._qTarget.copy(this._qLocalDelta).multiply(restLocal);

			node.quaternion.slerp(this._qTarget, alpha);
		}
	}

	/** Restore every driven bone to its captured rest pose. */
	resetToRest() {
		for (const { node, restLocal } of this._bones.values()) {
			node.quaternion.copy(restLocal);
		}
	}

	// ── Recording / playback (parity with FaceMocap) ──────────────────────────

	startRecording() { this._recordBuf.length = 0; this._recordT0 = 0; this.recording = true; }
	stopRecording()  { this.recording = false; return this.getRecording(); }

	getRecording() {
		return {
			format: 'three.ws.body-mocap.v1',
			duration: this._recordBuf.length ? this._recordBuf[this._recordBuf.length - 1].t : 0,
			frames: this._recordBuf.slice(),
		};
	}

	clearRecording() { this._recordBuf.length = 0; }

	// ── Accessors ─────────────────────────────────────────────────────────────

	getLastResult()    { return this._lastResult; }
	getFps()           { return this._fps; }
	getBoneCount()     { return this._bones.size; }
	get videoElement() { return this._video; }
}
