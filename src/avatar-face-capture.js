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
	'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.21/+esm';

// Hosted by Google. They publish exactly one official URL per model — these
// are the standard locations used in every MediaPipe sample, public CORS,
// no auth.
const WASM_ROOT =
	'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.21/wasm';
const MODEL_URL =
	'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';

let _landmarkerPromise = null;

/**
 * Run face landmarking on a single image and return the full result.
 * Internal — exposed for callers that want both blendshapes + landmarks.
 */
async function detectFace(source, landmarker) {
	const lm = landmarker || (await loadLandmarker());
	return lm.detect(source);
}

/**
 * Detect 52 ARKit *expression* blendshapes (smile/jawOpen/etc.). These are
 * NOT identity — driving them all from a single photo bakes whatever
 * expression the user happened to be wearing into the avatar permanently.
 * Use detectFaceIdentity() for "personalize from selfie" UX. Use this only
 * for live face tracking or one-shot mirroring.
 */
export async function detectFaceBlendshapes(source, landmarker) {
	const result = await detectFace(source, landmarker);
	const arr = result?.faceBlendshapes?.[0]?.categories;
	if (!arr || !arr.length) return null;
	const out = {};
	for (const c of arr) {
		// MediaPipe always emits index-0 "_neutral" — skip it.
		if (!c.categoryName || c.categoryName === '_neutral') continue;
		out[c.categoryName] = c.score;
	}
	return out;
}

/**
 * Identity capture — derive ARKit-named morph weights from 478 landmarks
 * via geometric ratios that approximate face shape. Returns a small map
 * (≤12 keys) of *identity-shaped* morphs only. Expression morphs (smile,
 * frown, jaw open, squint) are intentionally absent so a candid selfie
 * doesn't burn a wink into the avatar forever.
 *
 * The ratios are calibrated against MediaPipe's canonical face mesh — the
 * 478-point neutral template ships baked into the model. Each ratio gets
 * mapped through a tanh-style normalizer so a person whose ratio matches
 * canonical → 0, person with a wider jaw → positive jaw weight, etc.
 *
 * @returns {Promise<Record<string, number>|null>}
 */
export async function detectFaceIdentity(source, landmarker) {
	const result = await detectFace(source, landmarker);
	const lm = result?.faceLandmarks?.[0];
	if (!lm || lm.length < 478) return null;
	return identityMorphsFromLandmarks(lm);
}

/**
 * Run both passes in one detect() call. Returns { blendshapes, identity }.
 */
export async function detectFaceAll(source, landmarker) {
	const result = await detectFace(source, landmarker);
	const lm = result?.faceLandmarks?.[0];
	const bsArr = result?.faceBlendshapes?.[0]?.categories || [];
	if (!lm || lm.length < 478) return null;
	const blendshapes = {};
	for (const c of bsArr) {
		if (!c.categoryName || c.categoryName === '_neutral') continue;
		blendshapes[c.categoryName] = c.score;
	}
	return {
		blendshapes,
		identity: identityMorphsFromLandmarks(lm),
		// 4x4 head pose; useful for live track if the caller wants it later.
		transform: result?.facialTransformationMatrixes?.[0]?.data || null,
	};
}

/**
 * Pre-warm the FaceLandmarker. Useful when the host UI wants to overlap
 * model download with camera permission UI. Subsequent calls are no-ops.
 */
detectFaceBlendshapes.loadLandmarker = loadLandmarker;
detectFaceIdentity.loadLandmarker = loadLandmarker;
detectFaceAll.loadLandmarker = loadLandmarker;

function loadLandmarker() {
	if (_landmarkerPromise) return _landmarkerPromise;
	_landmarkerPromise = (async () => {
		const mod = await import(/* @vite-ignore */ TASKS_VISION_URL);
		const { FilesetResolver, FaceLandmarker } = mod;
		const vision = await FilesetResolver.forVisionTasks(WASM_ROOT);
		return FaceLandmarker.createFromOptions(vision, {
			baseOptions: { modelAssetPath: MODEL_URL, delegate: 'GPU' },
			outputFaceBlendshapes: true,
			// Surfaces the 4×4 head-pose matrix — wired through detectFaceAll()
			// so live-track callers can drive head bone rotation later without
			// running a second detect pass.
			outputFacialTransformationMatrixes: true,
			runningMode: 'IMAGE',
			numFaces: 1,
		});
	})().catch((err) => {
		_landmarkerPromise = null; // allow a retry next time
		throw err;
	});
	return _landmarkerPromise;
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Landmark indices — picked off the MediaPipe FaceMesh diagram.
 *
 * https://developers.google.com/static/mediapipe/images/solutions/face_landmarker_keypoints.png
 *
 * Each index references a {x,y,z} point in normalized image space (0..1 for
 * x/y, z is depth in face-relative units). x increases left-to-right in the
 * image (mirrored from the user's perspective when source is a front-cam
 * selfie). We normalize against an inter-ocular reference distance so the
 * ratios are scale-invariant.
 * ────────────────────────────────────────────────────────────────────────── */

const LMK = {
	// Eyes — outer / inner corners
	leftEyeOuter: 33,
	leftEyeInner: 133,
	rightEyeOuter: 263,
	rightEyeInner: 362,
	leftEyeTop: 159,
	leftEyeBottom: 145,
	rightEyeTop: 386,
	rightEyeBottom: 374,
	// Brows
	leftBrowInner: 105,
	leftBrowOuter: 70,
	rightBrowInner: 334,
	rightBrowOuter: 300,
	// Nose
	noseTip: 1,
	noseBridge: 6,
	noseLeftAla: 49,
	noseRightAla: 279,
	// Mouth
	mouthLeft: 61,
	mouthRight: 291,
	upperLipTop: 13,
	upperLipBottom: 14,
	lowerLipTop: 17,
	lowerLipBottom: 18,
	// Face boundary
	forehead: 10,
	chin: 152,
	jawLeft: 234,
	jawRight: 454,
	cheekLeft: 50,
	cheekRight: 280,
};

function dist(a, b) {
	const dx = a.x - b.x;
	const dy = a.y - b.y;
	return Math.hypot(dx, dy);
}

// Smooth tanh-style map: input ∈ R → output ∈ [-1, 1]. Sensitivity sets
// how far the input has to deviate from the canonical baseline to saturate.
function ratioToWeight(ratio, canonical, sensitivity = 8) {
	const x = (ratio - canonical) * sensitivity;
	return Math.tanh(x);
}

/**
 * Compute identity morph weights from 478 MediaPipe landmarks. Output map
 * uses ARKit-named morphs where one fits the semantic; uses our own
 * `body*` / `shape*` morph names for face-shape proportions that have no
 * ARKit equivalent. Avatars that lack those custom morphs silently no-op
 * those entries (AccessoryManager._applyRawMorphs skips unknown names).
 *
 * Values are always ≥0 and ≤0.7 — even the most extreme ratio shouldn't
 * push a slider into saturation. The user fine-tunes from the Sculpt UI.
 */
export function identityMorphsFromLandmarks(lm) {
	// Inter-ocular distance — scale reference. Every other measurement is
	// expressed as a ratio of this to make the result selfie-distance- and
	// resolution-independent.
	const eyeOuterL = lm[LMK.leftEyeOuter];
	const eyeOuterR = lm[LMK.rightEyeOuter];
	const interocular = dist(eyeOuterL, eyeOuterR) || 1e-6;

	const norm = (a, b) => dist(lm[a], lm[b]) / interocular;

	// ── Compute the raw ratios ────────────────────────────────────────────
	const faceHeight = norm(LMK.forehead, LMK.chin);            // ~2.2 canonical
	const jawWidth = norm(LMK.jawLeft, LMK.jawRight);           // ~2.2 canonical
	const lipThickness = norm(LMK.upperLipTop, LMK.lowerLipBottom); // ~0.5 canonical
	const noseWidth = norm(LMK.noseLeftAla, LMK.noseRightAla);  // ~0.55 canonical
	const noseLength = norm(LMK.noseBridge, LMK.noseTip);       // ~0.65 canonical
	const browHeightL = norm(LMK.leftBrowInner, LMK.leftEyeInner) /
		(norm(LMK.leftEyeTop, LMK.leftEyeBottom) || 1e-6);      // ratio of brow-eye to eye-height
	const eyeHeight = (
		norm(LMK.leftEyeTop, LMK.leftEyeBottom) +
		norm(LMK.rightEyeTop, LMK.rightEyeBottom)
	) / 2;                                                       // ~0.18 canonical
	const cheekWidth = norm(LMK.cheekLeft, LMK.cheekRight);     // ~1.9 canonical
	const mouthWidth = norm(LMK.mouthLeft, LMK.mouthRight);     // ~0.95 canonical

	// ── Map ratios → morph weights ────────────────────────────────────────
	// We only emit non-negative weights (additive morphs); negative ratios
	// (e.g. "thinner than canonical") get clamped to 0 — the avatar's neutral
	// already represents the canonical, so undershoot reads as "no change."
	const clampPos = (v) => Math.max(0, Math.min(0.7, v));

	const out = {};

	// Wider jaw → drive a custom `bodyJawWide` / `shapeJawWide` morph if the
	// avatar has it. Avatars without it no-op.
	const jaw = clampPos(ratioToWeight(jawWidth, 2.2, 4));
	if (jaw > 0.02) {
		out.bodyJawWide = jaw;
		out.shapeJawWide = jaw;
	}

	// Thicker lips
	const lips = clampPos(ratioToWeight(lipThickness, 0.5, 8));
	if (lips > 0.02) {
		out.bodyLipsThick = lips;
		out.shapeLipsThick = lips;
		// Also nudge mouthShrugLower/Upper — the ARKit-named morphs that come
		// closest to "fuller lip" on a stock RPM/Avaturn rig.
		out.mouthShrugLower = lips * 0.4;
		out.mouthShrugUpper = lips * 0.4;
	}

	// Wider nose ala
	const nose = clampPos(ratioToWeight(noseWidth, 0.55, 8));
	if (nose > 0.02) {
		out.bodyNoseWide = nose;
		out.shapeNoseWide = nose;
	}

	// Longer nose
	const noseLong = clampPos(ratioToWeight(noseLength, 0.65, 8));
	if (noseLong > 0.02) {
		out.bodyNoseLong = noseLong;
		out.shapeNoseLong = noseLong;
	}

	// Larger eye opening (resting "wider" eyes — not blink)
	const eyes = clampPos(ratioToWeight(eyeHeight, 0.18, 12));
	if (eyes > 0.02) {
		// Spread a small amount onto eyeWideLeft/Right as an identity baseline.
		// Cap heavily — 0.2 max — so it reads as "alert eyes" not "wide open."
		const cap = Math.min(0.2, eyes);
		out.eyeWideLeft = cap;
		out.eyeWideRight = cap;
		out.bodyEyesLarge = eyes;
	}

	// Higher brows — drives the ARKit browInnerUp baseline. Cap aggressively
	// (0.2 max) so it doesn't read as "permanently surprised."
	const brow = clampPos(ratioToWeight(browHeightL, 1.5, 4));
	if (brow > 0.05) {
		out.browInnerUp = Math.min(0.2, brow);
		out.bodyBrowHigh = brow;
	}

	// Longer face (vs canonical 2.2)
	const longFace = clampPos(ratioToWeight(faceHeight, 2.2, 4));
	if (longFace > 0.02) {
		out.bodyFaceLong = longFace;
		out.shapeFaceLong = longFace;
	}

	// Wider cheeks → cheekPuff baseline (capped low, otherwise reads as cheeks-puffed-out).
	const cheeks = clampPos(ratioToWeight(cheekWidth, 1.9, 4));
	if (cheeks > 0.05) {
		out.cheekPuff = Math.min(0.15, cheeks);
		out.bodyCheekWide = cheeks;
	}

	// Wider mouth opening corners — no clean ARKit slot, custom morph only.
	const mouth = clampPos(ratioToWeight(mouthWidth, 0.95, 8));
	if (mouth > 0.02) {
		out.bodyMouthWide = mouth;
		out.shapeMouthWide = mouth;
	}

	return out;
}
