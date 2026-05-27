/**
 * Real-time face mesh quality engine.
 *
 * Wraps MediaPipe FaceLandmarker for live video analysis. Provides:
 *   - 468-point wireframe overlay rendering
 *   - Head-pose estimation (yaw / pitch / roll)
 *   - Blur detection via Laplacian variance
 *   - Lighting analysis (luma mean)
 *   - Face centering check
 *   - Per-frame quality verdict with named gates
 *
 * Usage:
 *   const session = await createQualitySession(videoEl, canvasEl);
 *   session.onUpdate = (report) => { ... };
 *   session.start();
 *   // later:
 *   session.stop();
 *
 * The session lazily loads the ~5MB model on first use and caches it
 * for subsequent sessions. CDN-hosted for Vite WASM compatibility.
 */

const TASKS_VISION_URL =
	'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.22/+esm';
const WASM_ROOT =
	'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.22/wasm';
const MODEL_URL =
	'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker.task';

const BLUR_MIN = 3.5;
const LUMA_MIN = 40;
const LUMA_MAX = 218;

let _modPromise = null;
let _landmarkerPromise = null;

function loadModule() {
	if (!_modPromise) {
		_modPromise = import(/* @vite-ignore */ TASKS_VISION_URL);
	}
	return _modPromise;
}

function loadLandmarker() {
	if (_landmarkerPromise) return _landmarkerPromise;
	_landmarkerPromise = (async () => {
		const { FilesetResolver, FaceLandmarker } = await loadModule();
		const vision = await FilesetResolver.forVisionTasks(WASM_ROOT);
		return FaceLandmarker.createFromOptions(vision, {
			baseOptions: { modelAssetPath: MODEL_URL, delegate: 'GPU' },
			outputFaceBlendshapes: false,
			outputFacialTransformationMatrixes: false,
			runningMode: 'VIDEO',
			numFaces: 1,
		});
	})().catch((err) => {
		_landmarkerPromise = null;
		throw err;
	});
	return _landmarkerPromise;
}

/** Pre-warm the model download. */
export function preload() {
	loadLandmarker().catch(() => {});
}

/**
 * Slot presets for yaw-angle gating.
 * Yaw sign: looking left (camera's right) → positive.
 */
export const SLOT_PRESETS = {
	frontal: { label: 'Frontal', min: -15, max: 15 },
	left:    { label: 'Left ~45°', min: 30, max: 60 },
	right:   { label: 'Right ~45°', min: -60, max: -30 },
};

/**
 * @typedef {Object} QualityReport
 * @property {boolean} faceFound
 * @property {boolean} centered
 * @property {boolean} yawOk
 * @property {boolean} blurOk
 * @property {boolean} lumaOk
 * @property {boolean} allPass
 * @property {number|null} yaw
 * @property {number|null} pitch
 * @property {number|null} roll
 * @property {number} blur
 * @property {number} luma
 * @property {Array|null} landmarks
 */

/**
 * Create a real-time face quality session.
 *
 * @param {HTMLVideoElement} videoEl - Live camera video element
 * @param {HTMLCanvasElement} canvasEl - Canvas overlay for wireframe drawing
 * @param {{ slot?: string, onUpdate?: (report: QualityReport) => void }} [opts]
 * @returns {Promise<{ start: () => void, stop: () => void, setSlot: (s: string) => void, onUpdate: ((r: QualityReport) => void)|null }>}
 */
export async function createQualitySession(videoEl, canvasEl, opts = {}) {
	const landmarker = await loadLandmarker();
	const mod = await loadModule();
	const { FaceLandmarker, DrawingUtils } = mod;

	let _running = false;
	let _rafId = 0;
	let _lastVideoTime = -1;
	let _slot = opts.slot || 'frontal';
	let _qCanvas = null;
	let _qCtx = null;

	const session = {
		onUpdate: opts.onUpdate || null,

		start() {
			if (_running) return;
			_running = true;
			_lastVideoTime = -1;
			tick();
		},

		stop() {
			_running = false;
			if (_rafId) {
				cancelAnimationFrame(_rafId);
				_rafId = 0;
			}
		},

		setSlot(s) {
			_slot = s;
		},
	};

	function tick() {
		if (!_running) return;
		const report = analyze();
		if (report && session.onUpdate) session.onUpdate(report);
		_rafId = requestAnimationFrame(tick);
	}

	function analyze() {
		const w = videoEl.videoWidth;
		const h = videoEl.videoHeight;
		if (!w || !h) return null;

		if (canvasEl.width !== w || canvasEl.height !== h) {
			canvasEl.width = w;
			canvasEl.height = h;
		}

		const ctx = canvasEl.getContext('2d');
		ctx.clearRect(0, 0, w, h);

		let result = null;
		if (videoEl.currentTime !== _lastVideoTime) {
			_lastVideoTime = videoEl.currentTime;
			try {
				result = landmarker.detectForVideo(videoEl, performance.now());
			} catch (_) {
				return null;
			}
		}
		if (!result) return null;

		const lms = result.faceLandmarks?.[0];
		if (!lms || lms.length < 468) {
			return {
				faceFound: false, centered: false, yawOk: false,
				blurOk: false, lumaOk: false, allPass: false,
				yaw: null, pitch: null, roll: null,
				blur: 0, luma: 0, landmarks: null,
			};
		}

		drawWireframe(ctx, lms, FaceLandmarker, DrawingUtils);

		const pose = estimateHeadPose(lms);
		const nose = lms[1] || lms[4];
		const centered = nose && Math.abs(nose.x - 0.5) < 0.22 && Math.abs(nose.y - 0.5) < 0.28;
		const q = computeFaceQuality(videoEl, lms);

		const slotCfg = SLOT_PRESETS[_slot] || SLOT_PRESETS.frontal;
		const yawOk = pose.yaw >= slotCfg.min && pose.yaw <= slotCfg.max;
		const blurOk = q.blur >= BLUR_MIN;
		const lumaOk = q.luma >= LUMA_MIN && q.luma <= LUMA_MAX;

		return {
			faceFound: true,
			centered,
			yawOk,
			blurOk,
			lumaOk,
			allPass: yawOk && centered && blurOk && lumaOk,
			yaw: pose.yaw,
			pitch: pose.pitch,
			roll: pose.roll,
			blur: q.blur,
			luma: q.luma,
			landmarks: lms,
		};
	}

	function drawWireframe(ctx, lms, FL, DU) {
		const utils = new DU(ctx);
		utils.drawConnectors(lms, FL.FACE_LANDMARKS_TESSELATION, {
			color: 'rgba(255, 255, 255, 0.12)', lineWidth: 0.4,
		});
		utils.drawConnectors(lms, FL.FACE_LANDMARKS_FACE_OVAL, {
			color: 'rgba(255, 255, 255, 0.45)', lineWidth: 1.2,
		});
		utils.drawConnectors(lms, FL.FACE_LANDMARKS_RIGHT_EYE, {
			color: 'rgba(255, 255, 255, 0.55)', lineWidth: 1,
		});
		utils.drawConnectors(lms, FL.FACE_LANDMARKS_LEFT_EYE, {
			color: 'rgba(255, 255, 255, 0.55)', lineWidth: 1,
		});
		utils.drawConnectors(lms, FL.FACE_LANDMARKS_RIGHT_EYEBROW, {
			color: 'rgba(255, 255, 255, 0.35)', lineWidth: 0.8,
		});
		utils.drawConnectors(lms, FL.FACE_LANDMARKS_LEFT_EYEBROW, {
			color: 'rgba(255, 255, 255, 0.35)', lineWidth: 0.8,
		});
		utils.drawConnectors(lms, FL.FACE_LANDMARKS_LIPS, {
			color: 'rgba(255, 255, 255, 0.45)', lineWidth: 1,
		});
	}

	function computeFaceQuality(video, lms) {
		const SIZE = 64;
		if (!_qCanvas) {
			_qCanvas = document.createElement('canvas');
			_qCanvas.width = _qCanvas.height = SIZE;
			_qCtx = _qCanvas.getContext('2d', { willReadFrequently: true });
		}
		let minX = 1, minY = 1, maxX = 0, maxY = 0;
		for (const lm of lms) {
			if (lm.x < minX) minX = lm.x;
			if (lm.y < minY) minY = lm.y;
			if (lm.x > maxX) maxX = lm.x;
			if (lm.y > maxY) maxY = lm.y;
		}
		const pad = 0.05;
		const vw = video.videoWidth, vh = video.videoHeight;
		const fx = Math.max(0, (minX - pad)) * vw;
		const fy = Math.max(0, (minY - pad)) * vh;
		const fw = Math.min(vw - fx, (maxX - minX + 2 * pad) * vw);
		const fh = Math.min(vh - fy, (maxY - minY + 2 * pad) * vh);
		if (fw < 4 || fh < 4) return { luma: 0, blur: 0 };

		_qCtx.drawImage(video, fx, fy, fw, fh, 0, 0, SIZE, SIZE);
		const { data: d } = _qCtx.getImageData(0, 0, SIZE, SIZE);
		const n = SIZE * SIZE;
		const grays = new Float32Array(n);
		let lumaSum = 0;
		for (let i = 0, j = 0; i < d.length; i += 4, j++) {
			const g = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
			grays[j] = g;
			lumaSum += g;
		}
		const luma = lumaSum / n;
		let ls = 0, ls2 = 0, ln = 0;
		for (let row = 1; row < SIZE - 1; row++) {
			for (let col = 1; col < SIZE - 1; col++) {
				const c = grays[row * SIZE + col];
				const lap = 4 * c
					- grays[(row - 1) * SIZE + col]
					- grays[(row + 1) * SIZE + col]
					- grays[row * SIZE + (col - 1)]
					- grays[row * SIZE + (col + 1)];
				ls += lap; ls2 += lap * lap; ln++;
			}
		}
		const mean = ls / ln;
		const blur = Math.sqrt(Math.max(0, ls2 / ln - mean * mean));
		return { luma, blur };
	}

	return session;
}

/**
 * Head-pose estimation from 478 MediaPipe landmarks.
 * Uses geometric asymmetry — fast, no solvePnP dependency.
 */
export function estimateHeadPose(lms) {
	const r = lms[33];
	const l = lms[263];
	const nose = lms[1];
	const dxEye = l.x - r.x;
	const dyEye = l.y - r.y;
	const roll = (Math.atan2(dyEye, dxEye) * 180) / Math.PI;
	const distR = Math.hypot(nose.x - r.x, nose.y - r.y);
	const distL = Math.hypot(nose.x - l.x, nose.y - l.y);
	const yawRaw = (distR - distL) / (distR + distL);
	const yaw = -yawRaw * 90;
	const eyeMidY = (l.y + r.y) / 2;
	const eyeSpan = Math.hypot(l.x - r.x, l.y - r.y) || 1;
	const pitchRaw = (eyeMidY - nose.y) / eyeSpan;
	const pitch = pitchRaw * 90;
	return { yaw, pitch, roll };
}

/**
 * Run a one-shot quality check on a static image.
 * Useful for validating uploaded photos.
 *
 * @param {HTMLImageElement|ImageBitmap} source
 * @param {string} [slot='frontal']
 * @returns {Promise<QualityReport>}
 */
export async function checkImageQuality(source, slot = 'frontal') {
	const mod = await loadModule();
	const { FilesetResolver, FaceLandmarker } = mod;
	const vision = await FilesetResolver.forVisionTasks(WASM_ROOT);
	const imgLandmarker = await FaceLandmarker.createFromOptions(vision, {
		baseOptions: { modelAssetPath: MODEL_URL, delegate: 'GPU' },
		runningMode: 'IMAGE',
		numFaces: 1,
		outputFaceBlendshapes: false,
	});
	const result = imgLandmarker.detect(source);
	imgLandmarker.close();

	const lms = result.faceLandmarks?.[0];
	if (!lms || lms.length < 468) {
		return {
			faceFound: false, centered: false, yawOk: false,
			blurOk: true, lumaOk: true, allPass: false,
			yaw: null, pitch: null, roll: null,
			blur: 0, luma: 0, landmarks: null,
		};
	}

	const pose = estimateHeadPose(lms);
	const nose = lms[1] || lms[4];
	const centered = nose && Math.abs(nose.x - 0.5) < 0.30 && Math.abs(nose.y - 0.5) < 0.35;
	const slotCfg = SLOT_PRESETS[slot] || SLOT_PRESETS.frontal;
	const yawOk = pose.yaw >= slotCfg.min && pose.yaw <= slotCfg.max;

	return {
		faceFound: true,
		centered,
		yawOk,
		blurOk: true,
		lumaOk: true,
		allPass: yawOk && centered,
		yaw: pose.yaw,
		pitch: pose.pitch,
		roll: pose.roll,
		blur: 0,
		luma: 0,
		landmarks: lms,
	};
}
