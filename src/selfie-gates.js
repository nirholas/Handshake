/**
 * Selfie capture gates: the single source of truth for every quality threshold
 * the /create/selfie viewfinder and photo assessment enforce, plus the pure
 * scoring functions that apply them. No DOM, no MediaPipe: everything here is
 * unit-testable math over numbers the callers extract from frames.
 *
 * Why these numbers and not invented ones: each threshold is traced to a way
 * the reconstruction pipeline actually fails, so the client rejects for the
 * same reasons the backend would. Sources of truth, in the repo:
 *
 * - "no face" is the native worker's ONLY hard input rejection
 *   (workers/avatar-reconstruction/face_pipeline.py raises
 *   InputError("no face detected in any of the provided photos") after a
 *   FaceMesh pass at min_detection_confidence=0.4 and a BlazeFace small-face
 *   rescue at 0.3). The client mirrors it as the only capture-blocking gate.
 * - Yaw: face_pipeline.MAX_MORPH_YAW_DEG = 35. Above ~35 degrees the worker
 *   skips the geometry morph because the self-occluded half of the face is
 *   depth extrapolation, not structure (eval/detection_guard.py: clean
 *   frontals peak at 2.7 degrees, the one benchmark input that breaks the
 *   morph band reads 58.6). The frontal window of +/-15 keeps captures deep
 *   inside the morph-safe zone; side slots target the ~45 degree band the
 *   multi-view texture pass expects.
 * - Blur: the provider reconstruction lanes fail jobs whose error text the
 *   status mapper (src/selfie-pipeline.js friendlyJobError) matches on
 *   "blur", and the worker's robustness benchmark
 *   (workers/avatar-reconstruction/eval/robustness.py `blurred`) models the
 *   defect as a Gaussian blur of radius longestEdge/220. BLUR_STDDEV_MIN is
 *   the live-feed equivalent: the Laplacian response stddev of a 64px face
 *   crop. The value is measured, not assumed. Six real portrait photographs
 *   were framed as 720x1280 phone selfies and scored through this module's
 *   own math, sharp against the benchmark's exact degradations:
 *
 *     sharp                       22.8  23.4  23.7  27.4  38.3  39.4
 *     GaussianBlur r=longest/220  10.6  12.6  13.8  14.0  14.8  15.7
 *     GaussianBlur r=10            6.3   6.8   8.2   8.4   8.5   9.4
 *
 *   The previous floor of 3.5 sat below every one of those readings, so the
 *   gate never fired on any real photograph, however badly blurred: it told
 *   users "Sharp" on a frame smeared past recognition. 12 sits in the empty
 *   band between the blurred and sharp populations, rejecting every
 *   heavily-blurred sample while leaving the least-sharp real face nearly
 *   2x of headroom. The mild benchmark degradation straddles it on purpose:
 *   it costs identity stability but is not a reconstruction failure, and
 *   over-rejecting a usable capture is worse than accepting a soft one.
 *   SHARPNESS_VAR_MIN = 90 is the same idea at still-photo resolution
 *   (variance, not stddev, at up to 1024px), the threshold
 *   src/selfie-refine.js has always applied at submit time.
 * - Lighting: the robustness benchmark's `dim` degradation (brightness x0.42,
 *   "indoor evening") lands a typical selfie's mean face luma at the LUMA_MIN
 *   boundary, and the adversarial set's "hard-backlight, face in deep shadow"
 *   case is the classic path to the worker's no-face InputError. LUMA_MAX
 *   catches the blown-highlight mirror image (a washed-out face loses the
 *   texture the UV warp samples).
 * - Centering: the refine stage (src/selfie-refine.js computeSubjectFrame)
 *   reframes to a head-and-shoulders square around the detected face, so a
 *   badly off-centre face costs crop headroom rather than failing outright.
 *   CENTER_TOL_X/Y bound the nose offset so the reframe never has to choose
 *   between cutting the head and leaving the subject at the frame edge.
 */

/** Yaw windows per capture slot, in degrees. Positive = looking left. */
export const SLOT_PRESETS = Object.freeze({
	frontal: Object.freeze({ label: 'Frontal', min: -15, max: 15 }),
	left: Object.freeze({ label: 'Left ~45°', min: 30, max: 60 }),
	right: Object.freeze({ label: 'Right ~45°', min: -60, max: -30 }),
});

export const GATES = Object.freeze({
	/** Laplacian-response stddev floor on the 64px live face crop. */
	BLUR_STDDEV_MIN: 12,
	/** Variance-of-Laplacian floor for still photos at up to 1024px. */
	SHARPNESS_VAR_MIN: 90,
	/** Mean face luma bounds (Rec. 601, 0..255). */
	LUMA_MIN: 40,
	LUMA_MAX: 218,
	/** Max share of the face crop allowed to be blown to near-white. */
	CLIPPED_FRAC_MAX: 0.18,
	/** A face pixel at or above this luma carries no recoverable texture. */
	CLIP_LEVEL: 250,
	/** Max nose offset from frame centre, as a fraction of frame size. */
	CENTER_TOL_X: 0.22,
	CENTER_TOL_Y: 0.28,
	/** Worker skips the geometry morph above this head yaw (degrees). */
	MORPH_YAW_MAX: 35,
});

/**
 * Mean luma, blown-highlight share, and Laplacian-response stddev of an 8-bit
 * grey buffer. This is the live viewfinder's blur/lighting measurement,
 * extracted pure so it can be pinned by unit tests. `blurStddev` is the
 * standard deviation of a 4-neighbour Laplacian over the interior pixels:
 * sharp facial detail yields strong high-frequency response, defocus and
 * motion blur collapse it. `clippedFrac` is the share of pixels at or above
 * CLIP_LEVEL, which mean luma cannot see: a face half-blown by window glare
 * still averages into the accepted band while carrying no texture where it
 * counts, and clipping raises the Laplacian response rather than lowering it,
 * so the blur gate cannot catch it either.
 *
 * @param {Uint8Array|Uint8ClampedArray|Float32Array|number[]} grey row-major, length w*h
 * @param {number} w
 * @param {number} h
 * @returns {{ luma: number, blurStddev: number, clippedFrac: number }}
 */
export function grayFaceStats(grey, w, h) {
	const n = w * h;
	if (n === 0) return { luma: 0, blurStddev: 0, clippedFrac: 0 };
	let lumaSum = 0;
	let clipped = 0;
	for (let i = 0; i < n; i++) {
		lumaSum += grey[i];
		if (grey[i] >= GATES.CLIP_LEVEL) clipped++;
	}
	const luma = lumaSum / n;
	const clippedFrac = clipped / n;
	if (w < 3 || h < 3) return { luma, blurStddev: 0, clippedFrac };
	let ls = 0;
	let ls2 = 0;
	let ln = 0;
	for (let row = 1; row < h - 1; row++) {
		for (let col = 1; col < w - 1; col++) {
			const c = grey[row * w + col];
			const lap =
				4 * c -
				grey[(row - 1) * w + col] -
				grey[(row + 1) * w + col] -
				grey[row * w + (col - 1)] -
				grey[row * w + (col + 1)];
			ls += lap;
			ls2 += lap * lap;
			ln++;
		}
	}
	const mean = ls / ln;
	const blurStddev = Math.sqrt(Math.max(0, ls2 / ln - mean * mean));
	return { luma, blurStddev, clippedFrac };
}

/**
 * Grade one live viewfinder frame against the capture gates and name exactly
 * what is wrong, in the order the user should fix it. Pure.
 *
 * @param {{
 *   faceFound: boolean,
 *   slot?: 'frontal'|'left'|'right'|string,
 *   yaw?: number|null,
 *   noseX?: number|null, noseY?: number|null,
 *   blur?: number,
 *   luma?: number,
 *   clippedFrac?: number,
 * }} m `blur` is the grayFaceStats blurStddev; noseX/noseY are normalised 0..1.
 * @returns {{
 *   faceFound: boolean, yawOk: boolean, centered: boolean,
 *   blurOk: boolean, lumaOk: boolean, allPass: boolean,
 *   reason: string|null,
 * }} `reason` is the user-facing retake prompt, null when every gate passes.
 */
export function gradeFrame(m) {
	if (!m.faceFound) {
		return {
			faceFound: false,
			yawOk: false,
			centered: false,
			blurOk: false,
			lumaOk: false,
			allPass: false,
			reason: 'No face detected. Face the camera.',
		};
	}
	const slot = m.slot || 'frontal';
	const cfg = SLOT_PRESETS[slot] || SLOT_PRESETS.frontal;
	const yaw = typeof m.yaw === 'number' ? m.yaw : 0;
	const yawOk = yaw >= cfg.min && yaw <= cfg.max;
	const centered =
		typeof m.noseX === 'number' &&
		typeof m.noseY === 'number' &&
		Math.abs(m.noseX - 0.5) < GATES.CENTER_TOL_X &&
		Math.abs(m.noseY - 0.5) < GATES.CENTER_TOL_Y;
	const blurOk = (m.blur ?? 0) >= GATES.BLUR_STDDEV_MIN;
	const tooDark = (m.luma ?? 0) < GATES.LUMA_MIN;
	const blownOut =
		(m.luma ?? 0) > GATES.LUMA_MAX || (m.clippedFrac ?? 0) > GATES.CLIPPED_FRAC_MAX;
	const lumaOk = !tooDark && !blownOut;

	let reason = null;
	if (!yawOk) {
		reason =
			slot === 'frontal'
				? 'Face the camera straight on.'
				: `Turn your head ${slot === 'left' ? 'left' : 'right'} about 45°.`;
	} else if (!centered) {
		reason = 'Center your face in the oval.';
	} else if (!blurOk) {
		reason = 'Hold steady. The image is blurry.';
	} else if (tooDark) {
		reason = 'Too dark. Find better light.';
	} else if (blownOut) {
		reason = 'Too bright. Move out of direct light or turn away from the window.';
	}

	return {
		faceFound: true,
		yawOk,
		centered,
		blurOk,
		lumaOk,
		allPass: yawOk && centered && blurOk && lumaOk,
		reason,
	};
}
