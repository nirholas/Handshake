/**
 * FaceMocap — webcam facial motion capture for Three.js avatars.
 *
 * Uses MediaPipe Face Landmarker (newer than the FaceMesh model RiggingJs uses)
 * to output:
 *   - 52 ARKit blendshape scores per frame
 *   - 478 3D face landmarks (with iris)
 *   - 4x4 facial transformation matrix (head pose in camera space)
 *
 * Pipeline:
 *   webcam → Face Landmarker → calibration delta → one-euro smoothing →
 *   ARKit morph targets + head bone rotation on a Three.js avatar.
 *
 *   The detection result is also exposed via getLastResult() so a separate
 *   visualizer can render landmarks + head-pose gizmo onto the webcam canvas.
 *
 * Recording: while .recording is true every frame's blendshapes + head matrix
 * are appended to an in-memory buffer that can be downloaded as a JSON clip.
 */

import { FaceLandmarker, FilesetResolver } from '@mediapipe/tasks-vision';
import { Matrix4, Euler, MathUtils } from 'three';
import { resolveMorphTargets, setCanonicalMorph, MORPH_ALIASES, ARKIT_52 } from './runtime/arkit52.js';

const WASM_URL  = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35/wasm';
const MODEL_URL = 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';
const HEAD_MAX  = 40 * (Math.PI / 180);

// ── One-Euro filter (Casiez et al. 2012) ─────────────────────────────────────
// Adaptive low-pass: cutoff scales with signal velocity so fast motion stays
// crisp while slow motion is heavily smoothed. Standard in mocap pipelines.
class OneEuro {
	constructor({ minCutoff = 1.0, beta = 0.05, dCutoff = 1.0 } = {}) {
		this.minCutoff = minCutoff;
		this.beta      = beta;
		this.dCutoff   = dCutoff;
		this.xPrev     = null;
		this.dxPrev    = 0;
		this.tPrev     = null;
	}
	_alpha(cutoff, dt) {
		const tau = 1 / (2 * Math.PI * cutoff);
		return 1 / (1 + tau / dt);
	}
	filter(x, t) {
		if (this.tPrev == null) {
			this.tPrev  = t;
			this.xPrev  = x;
			return x;
		}
		const dt = Math.max(1e-6, t - this.tPrev);
		const dx = (x - this.xPrev) / dt;
		const aD = this._alpha(this.dCutoff, dt);
		const dxHat = aD * dx + (1 - aD) * this.dxPrev;
		const cutoff = this.minCutoff + this.beta * Math.abs(dxHat);
		const a  = this._alpha(cutoff, dt);
		const xHat = a * x + (1 - a) * this.xPrev;
		this.xPrev  = xHat;
		this.dxPrev = dxHat;
		this.tPrev  = t;
		return xHat;
	}
	reset() {
		this.xPrev = null; this.dxPrev = 0; this.tPrev = null;
	}
}

export class FaceMocap {
	constructor(opts = {}) {
		this._landmarker     = null;
		this._video          = null;
		this._stream         = null;
		this._running        = false;
		this._morphResolved  = null;
		this._headBone       = null;
		this._headRest       = null;
		this._lastVideoTime  = -1;
		this._mat4           = new Matrix4();
		this._euler          = new Euler();
		this._lastResult     = null;
		this._onFace         = null;
		this._fps            = 0;
		this._fpsAccum       = 0;
		this._fpsFrames      = 0;
		this._fpsLastT       = 0;

		// One-euro filters keyed by ARKit blendshape name + 3 head-rotation axes
		const filterOpts = opts.filter ?? { minCutoff: 1.0, beta: 0.03 };
		this._filters = {};
		for (const name of ARKIT_52) this._filters[name] = new OneEuro(filterOpts);
		this._headFilters = {
			x: new OneEuro({ minCutoff: 1.2, beta: 0.04 }),
			y: new OneEuro({ minCutoff: 1.2, beta: 0.04 }),
			z: new OneEuro({ minCutoff: 1.2, beta: 0.04 }),
		};

		// Calibration baseline (subtracted from blendshapes each frame)
		this._calibration = null; // { [name]: score } captured neutral pose

		// Recording
		this.recording   = false;
		this._recordBuf  = []; // [{ t, shapes:{...}, mat:[...] }]
		this._recordT0   = 0;
	}

	// ── Lifecycle ─────────────────────────────────────────────────────────────

	async init() {
		const fileset = await FilesetResolver.forVisionTasks(WASM_URL);
		this._landmarker = await FaceLandmarker.createFromOptions(fileset, {
			baseOptions: {
				modelAssetPath: MODEL_URL,
				delegate: 'GPU',
			},
			outputFaceBlendshapes: true,
			outputFacialTransformationMatrixes: true,
			runningMode: 'VIDEO',
			numFaces: 1,
		});
	}

	async startWebcam() {
		this._stream = await navigator.mediaDevices.getUserMedia({
			video: { width: 640, height: 480, facingMode: 'user' },
			audio: false,
		});
		const video = document.createElement('video');
		video.srcObject  = this._stream;
		video.autoplay   = true;
		video.playsInline = true;
		video.muted      = true;
		await new Promise((res) => { video.onloadeddata = res; });
		this._video = video;
		return video;
	}

	attach(avatarRoot, headBone) {
		this._morphResolved = resolveMorphTargets(avatarRoot);
		this._headBone      = headBone ?? null;
		this._headRest      = null;
		// Reset filters so a fresh avatar doesn't inherit stale smoothing state
		for (const f of Object.values(this._filters))     f.reset();
		for (const f of Object.values(this._headFilters)) f.reset();
	}

	start() { this._running = true; }

	stop() {
		this._running = false;
		this._stream?.getTracks().forEach((t) => t.stop());
		this._video  = null;
		this._stream = null;
	}

	onFaceDetected(cb) { this._onFace = cb; }

	// ── Per-frame ─────────────────────────────────────────────────────────────

	update() {
		if (!this._running || !this._landmarker || !this._video) return;
		if (this._video.readyState < 2) return;

		const ct = this._video.currentTime;
		if (ct === this._lastVideoTime) return;
		this._lastVideoTime = ct;

		const now = performance.now();
		const result = this._landmarker.detectForVideo(this._video, now);
		this._lastResult = result;

		// FPS averaged over a 500ms window — RiggingJs uses Stats.js, we roll our own
		// to avoid the dep.
		this._fpsFrames++;
		if (now - this._fpsLastT >= 500) {
			this._fps = (this._fpsFrames * 1000) / (now - this._fpsLastT);
			this._fpsFrames = 0;
			this._fpsLastT  = now;
		}

		const hasFace = result.faceBlendshapes?.length > 0;
		this._onFace?.(hasFace);
		if (!hasFace) return;

		const tSec = now / 1000;
		const shapes = this._applyBlendshapes(result.faceBlendshapes[0].categories, tSec);

		let headMat = null;
		if (this._headBone && result.facialTransformationMatrixes?.length) {
			headMat = result.facialTransformationMatrixes[0].data;
			this._applyHeadRotation(headMat, tSec);
		}

		// Recording — append a frame snapshot. JSON-able so the clip can be
		// downloaded and replayed on any avatar later.
		if (this.recording) {
			if (this._recordBuf.length === 0) this._recordT0 = now;
			this._recordBuf.push({
				t: (now - this._recordT0) / 1000,
				shapes,
				mat: headMat ? Array.from(headMat) : null,
			});
		}
	}

	// ── Calibration ───────────────────────────────────────────────────────────

	/**
	 * Capture the current frame's blendshape scores as the user's neutral pose.
	 * Subsequent frames have this baseline subtracted out, so a resting brow
	 * doesn't sit at 0.15 forever. Call once with a relaxed face.
	 */
	calibrate() {
		if (!this._lastResult?.faceBlendshapes?.length) return false;
		const cats = this._lastResult.faceBlendshapes[0].categories;
		this._calibration = {};
		for (const { categoryName, score } of cats) {
			this._calibration[categoryName] = score;
		}
		return true;
	}

	clearCalibration() {
		this._calibration = null;
	}

	// ── Recording ─────────────────────────────────────────────────────────────

	startRecording() {
		this._recordBuf.length = 0;
		this._recordT0 = 0;
		this.recording = true;
	}

	stopRecording() {
		this.recording = false;
		return this.getRecording();
	}

	getRecording() {
		return {
			format: 'three.ws.face-mocap.v1',
			duration: this._recordBuf.length
				? this._recordBuf[this._recordBuf.length - 1].t
				: 0,
			frames: this._recordBuf.slice(),
		};
	}

	clearRecording() {
		this._recordBuf.length = 0;
	}

	/**
	 * Replay a recorded clip against the attached avatar.
	 * Returns a stop() handle. Pauses live detection while playing back.
	 * @param {object} clip — from getRecording()
	 * @param {{loop?: boolean, onEnd?: function}} [opts]
	 */
	playback(clip, opts = {}) {
		if (!clip?.frames?.length) return { stop: () => {} };
		const wasRunning = this._running;
		this._running = false; // freeze live capture while playing back

		const t0     = performance.now();
		const frames = clip.frames;
		let i = 0, raf = 0, stopped = false;

		const tick = () => {
			if (stopped) return;
			const t = (performance.now() - t0) / 1000;
			while (i < frames.length - 1 && frames[i + 1].t <= t) i++;
			const f = frames[i];

			// Apply blendshapes from the recorded frame (no smoothing — already smooth)
			if (this._morphResolved) {
				for (const [name, score] of Object.entries(f.shapes)) {
					const canonical = MORPH_ALIASES[name] ?? name;
					setCanonicalMorph(this._morphResolved, canonical, score);
				}
			}
			// Head matrix → bone rotation (no filter; recording is post-smoothed)
			if (this._headBone && f.mat) {
				this._mat4.fromArray(f.mat);
				this._euler.setFromRotationMatrix(this._mat4, 'ZYX');
				if (!this._headRest) {
					this._headRest = {
						x: this._headBone.rotation.x,
						y: this._headBone.rotation.y,
						z: this._headBone.rotation.z,
					};
				}
				const r = this._headRest;
				this._headBone.rotation.x = r.x + MathUtils.clamp( this._euler.x, -HEAD_MAX, HEAD_MAX);
				this._headBone.rotation.y = r.y + MathUtils.clamp(-this._euler.y, -HEAD_MAX, HEAD_MAX);
				this._headBone.rotation.z = r.z + MathUtils.clamp( this._euler.z, -HEAD_MAX, HEAD_MAX);
			}

			if (i >= frames.length - 1 && t >= clip.duration) {
				if (opts.loop) {
					i = 0;
					return; // restart on next rAF
				}
				stopped = true;
				this._running = wasRunning;
				opts.onEnd?.();
				return;
			}
			raf = requestAnimationFrame(tick);
		};
		raf = requestAnimationFrame(tick);

		return {
			stop: () => {
				stopped = true;
				cancelAnimationFrame(raf);
				this._running = wasRunning;
			},
		};
	}

	// ── Accessors for the visualizer / UI ────────────────────────────────────

	getLastResult()    { return this._lastResult; }
	getFps()           { return this._fps; }
	getMorphCount()    { return this._morphResolved?.size ?? 0; }
	getCalibration()   { return this._calibration; }
	get videoElement() { return this._video; }

	// ── Private ──────────────────────────────────────────────────────────────

	_applyBlendshapes(categories, tSec) {
		if (!this._morphResolved) return {};
		const out = {};
		for (const { categoryName, score } of categories) {
			// Calibration subtraction — clamp negative deltas at zero so a resting
			// face never drives morphs.
			let raw = score;
			if (this._calibration && this._calibration[categoryName] != null) {
				raw = Math.max(0, score - this._calibration[categoryName]);
			}
			const filt = this._filters[categoryName];
			const smoothed = filt ? filt.filter(raw, tSec) : raw;
			out[categoryName] = smoothed;

			const canonical = MORPH_ALIASES[categoryName] ?? categoryName;
			setCanonicalMorph(this._morphResolved, canonical, smoothed);
		}
		return out;
	}

	_applyHeadRotation(matData, tSec) {
		this._mat4.fromArray(matData);
		this._euler.setFromRotationMatrix(this._mat4, 'ZYX');

		if (!this._headRest) {
			this._headRest = {
				x: this._headBone.rotation.x,
				y: this._headBone.rotation.y,
				z: this._headBone.rotation.z,
			};
		}

		const xS = this._headFilters.x.filter( this._euler.x, tSec);
		const yS = this._headFilters.y.filter(-this._euler.y, tSec);
		const zS = this._headFilters.z.filter( this._euler.z, tSec);

		const r = this._headRest;
		this._headBone.rotation.x = r.x + MathUtils.clamp(xS, -HEAD_MAX, HEAD_MAX);
		this._headBone.rotation.y = r.y + MathUtils.clamp(yS, -HEAD_MAX, HEAD_MAX);
		this._headBone.rotation.z = r.z + MathUtils.clamp(zS, -HEAD_MAX, HEAD_MAX);
	}
}
