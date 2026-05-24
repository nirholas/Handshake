/**
 * Browser-side selfie → ARKit-52 blendshapes via MediaPipe Face Landmarker.
 *
 * No bundling: the tasks-vision package + WASM model (~5 MB total) load on
 * demand from a CDN. The first call pays a one-time cost; subsequent
 * captures reuse the cached FaceLandmarker instance.
 *
 *   import { detectFaceBlendshapes } from './avatar-face-capture.js';
 *   const lm = await detectFaceBlendshapes.loadLandmarker();
 *   const map = await detectFaceBlendshapes(canvasOrImage, lm);
 *   // map: { jawOpen: 0.12, mouthSmileLeft: 0.04, ... }  (52 keys)
 *
 * The 52 returned keys are exactly the ARKit blendshape names so they bind
 * 1:1 to RPM / Avaturn / three.ws avatar morphs without any rename pass.
 *
 * License-trap reminder: MediaPipe and the face-landmarker model are both
 * Apache-2.0 — safe to ship. We do *not* bundle FLAME / DECA / SMPL-X weights
 * because those are research-only / non-commercial. See the survey notes.
 */

// We load tasks-vision via dynamic ESM import. Pinning to a specific version
// avoids breaking changes from auto-upgraded CDN aliases; jsDelivr's `+esm`
// suffix returns the ESM build.
const TASKS_VISION_URL =
	'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.22/+esm';

// Hosted by Google. They publish exactly one official URL per model — these
// are the standard locations used in every MediaPipe sample, public CORS,
// no auth.
const WASM_ROOT =
	'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.22/wasm';
const MODEL_URL =
	'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';

let _landmarkerPromise = null;

/**
 * Detect blendshapes from a single image source (canvas, image, or
 * ImageBitmap). Returns an object keyed by the 52 ARKit blendshape names.
 *
 * @param {HTMLCanvasElement|HTMLImageElement|ImageBitmap} source
 * @param {object} [landmarker] — pre-loaded FaceLandmarker (optional)
 * @returns {Promise<Record<string, number>|null>}
 */
export async function detectFaceBlendshapes(source, landmarker) {
	const lm = landmarker || (await loadLandmarker());
	const result = lm.detect(source);
	const arr = result?.faceBlendshapes?.[0]?.categories;
	if (!arr || !arr.length) return null;
	const out = {};
	for (const c of arr) {
		// MediaPipe returns the index-0 "_neutral" pseudo-shape too; skip it.
		if (!c.categoryName || c.categoryName === '_neutral') continue;
		out[c.categoryName] = c.score;
	}
	return out;
}

/**
 * Pre-warm the FaceLandmarker. Useful when the host UI wants to overlap
 * model download with camera permission UI. Subsequent calls are no-ops.
 */
detectFaceBlendshapes.loadLandmarker = loadLandmarker;

function loadLandmarker() {
	if (_landmarkerPromise) return _landmarkerPromise;
	_landmarkerPromise = (async () => {
		const mod = await import(/* @vite-ignore */ TASKS_VISION_URL);
		const { FilesetResolver, FaceLandmarker } = mod;
		const vision = await FilesetResolver.forVisionTasks(WASM_ROOT);
		return FaceLandmarker.createFromOptions(vision, {
			baseOptions: { modelAssetPath: MODEL_URL, delegate: 'GPU' },
			outputFaceBlendshapes: true,
			outputFacialTransformationMatrixes: false,
			runningMode: 'IMAGE',
			numFaces: 1,
		});
	})().catch((err) => {
		_landmarkerPromise = null; // allow a retry next time
		throw err;
	});
	return _landmarkerPromise;
}
