/**
 * Browser-side selfie → avatar shape transfer via MediaPipe Face Landmarker.
 *
 * Two outputs:
 *
 *   1. detectFaceBlendshapes() — raw 52 ARKit blendshape weights from the
 *      photo. These describe the *expression* the user was making, not their
 *      face *shape*. If the user smiled, mouthSmileLeft/Right will be high.
 *      Useful only for live-track or "freeze my current expression" flows.
 *
 *   2. detectFaceIdentity() — identity-only morph weights derived from the
 *      478-point landmark mesh via geometric ratios (face width, jaw width,
 *      lip thickness, eye spacing, etc.). This is what you want for
 *      "personalize from selfie": it captures who they are, not what they
 *      were doing with their face when the shutter fired.
 *
 * Why this split: RPM, Avaturn, and in3D all do the equivalent server-side
 * via proprietary regressions. We can't bundle FLAME / SMPL / DECA weights
 * (research-only licenses), and shipping the raw ARKit expression scores
 * burns a smile into the avatar forever. The ratio heuristics are crude,
 * but they ship, they respect licensing, and the user fine-tunes from the
 * Sculpt panel anyway.
 *
 * No bundling: tasks-vision + WASM model (~5 MB) load on demand from a CDN.
 * License: MediaPipe + face_landmarker.task are both Apache-2.0 — safe.
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
