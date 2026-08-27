/**
 * Selfie refinement — the missing preprocessing stage between the capture UI and
 * the avatar reconstruction backend.
 *
 * Why this exists: the reconstruct lane (/api/avatars/reconstruct) feeds the raw
 * photo straight to a generic image→3D model. Those models have no facial prior
 * and reconstruct depth from shading/parallax — so a face photo with its full
 * background (or worse, a flat 2D illustration) collapses to a textured plane:
 * the "card" failure. The text→avatar lane right next to it works well precisely
 * because it hands the model a clean, centred, plain-background figure. This
 * module makes the selfie lane do the same to its input before upload:
 *
 *   1. assess()  — gate the input (face present? sharp? a real photo not a flat
 *                  drawing? close enough?) and surface actionable warnings.
 *   2. refine()  — isolate the human subject from the background (MediaPipe
 *                  Selfie Segmentation), composite onto a neutral studio
 *                  backdrop, and reframe to a centred head-and-shoulders square
 *                  — the exact composition the reconstruction lane handles best.
 *
 * Everything runs in the browser. No server keys, no GPU workers, no upload of
 * the raw frame. The deterministic math (framing, sharpness, flatness, quality
 * verdict) is exported as pure functions so it is unit-tested without a DOM.
 *
 * Graceful degradation is a hard rule here (CLAUDE.md: "no errors without
 * solutions"): if the segmentation model can't load, refine() still reframes off
 * the detected face box — tight framing alone removes most of the background —
 * and never throws into the capture flow.
 */

import { GATES } from './selfie-gates.js';
import { log } from './shared/log.js';
import { loadVision, modelUrl, visionWasmBase } from './shared/mediapipe-assets.js';

// MediaPipe tasks-vision — same pinned build the face stack uses, so the WASM
// runtime is shared/cached across the landmarker and the segmenter.
// tasks-vision is bundled from the npm dependency; the WASM runtime comes from
// the shared resolver, which prefers our vendored copy over a CDN.
// Official Google-hosted binary selfie segmenter (Apache-2.0). One confidence
// mask: per-pixel probability the pixel belongs to the person.
const SELFIE_MODEL_URL =
	modelUrl('image_segmenter/selfie_segmenter/float16/latest/selfie_segmenter.tflite');
// BlazeFace short-range detector (Apache-2.0): bounding boxes + count. Cheaper
// than the 478-point landmarker and the right tool for "where/how many faces".
const FACE_DETECTOR_MODEL_URL =
	modelUrl('face_detector/blaze_face_short_range/float16/latest/blaze_face_short_range.tflite');

// Working resolution: cap the longest edge so the matte + reframe stay fast on
// phones. The output square is rendered at OUTPUT_SIZE regardless.
const WORK_MAX = 1024;
const OUTPUT_SIZE = 1024;
const JPEG_QUALITY = 0.92;

// Quality thresholds. Heuristic, tuned conservative so a real photo is never
// blocked — the only hard gate is "no face". Everything else is a warning the
// user can act on or ignore.
const THRESH = Object.freeze({
	// Variance-of-Laplacian on an 8-bit grey image. Sharp phone selfies land in
	// the hundreds-to-thousands; sub-this reads as soft/blurry.
	sharpnessBlurry: 90,
	// Fraction of near-flat 3×3 neighbourhoods. Cel-shaded drawings are mostly
	// flat fills with hard edges; photographs carry sensor/texture noise.
	flatnessHigh: 0.62,
	// Mean saturation (0..1). Illustrations skew saturated; pairing high flatness
	// with high saturation separates "cartoon" from "plain-wall photo".
	saturationHigh: 0.28,
	// Face width as a fraction of the frame's shorter edge — below this the
	// subject is too far away for a faithful reconstruction.
	faceTooFarRel: 0.14,
	// Absolute minimum useful frame.
	minDimPx: 320,
});

/* ────────────────────────────────────────────────────────────────────────── *
 * Pure helpers — no DOM. Exported for unit tests.
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * Variance-of-Laplacian sharpness on an 8-bit grey buffer. Higher = sharper.
 * The Laplacian (4-neighbour) responds to edges; a blurry image has little
 * high-frequency energy so its response variance is low.
 *
 * @param {Uint8Array|Uint8ClampedArray|number[]} grey row-major, length w*h
 * @param {number} w
 * @param {number} h
 * @returns {number}
 */
export function laplacianVariance(grey, w, h) {
	if (w < 3 || h < 3) return 0;
	let sum = 0;
	let sumSq = 0;
	let n = 0;
	for (let y = 1; y < h - 1; y++) {
		for (let x = 1; x < w - 1; x++) {
			const i = y * w + x;
			const lap =
				4 * grey[i] - grey[i - 1] - grey[i + 1] - grey[i - w] - grey[i + w];
			sum += lap;
			sumSq += lap * lap;
			n++;
		}
	}
	if (n === 0) return 0;
	const mean = sum / n;
	return sumSq / n - mean * mean;
}

/**
 * Fraction of pixels whose 3×3 neighbourhood is nearly constant. A proxy for
 * "flat-fill illustration vs. textured photograph". Operates on an 8-bit grey
 * buffer; a neighbourhood counts as flat when its max−min span ≤ `tol`.
 *
 * @param {Uint8Array|Uint8ClampedArray|number[]} grey row-major, length w*h
 * @param {number} w
 * @param {number} h
 * @param {number} [tol=6]
 * @returns {number} 0..1
 */
export function flatnessScore(grey, w, h, tol = 6) {
	if (w < 3 || h < 3) return 0;
	let flat = 0;
	let n = 0;
	for (let y = 1; y < h - 1; y++) {
		for (let x = 1; x < w - 1; x++) {
			const i = y * w + x;
			let mn = 255;
			let mx = 0;
			for (let dy = -1; dy <= 1; dy++) {
				for (let dx = -1; dx <= 1; dx++) {
					const v = grey[i + dy * w + dx];
					if (v < mn) mn = v;
					if (v > mx) mx = v;
				}
			}
			if (mx - mn <= tol) flat++;
			n++;
		}
	}
	return n ? flat / n : 0;
}

/**
 * Mean saturation (HSV S, 0..1) over an RGBA buffer, sampled with a stride for
 * speed. Used together with flatness to flag illustrations.
 *
 * @param {Uint8Array|Uint8ClampedArray|number[]} rgba length w*h*4
 * @param {number} w
 * @param {number} h
 * @param {number} [stride=4] sample every Nth pixel
 * @returns {number} 0..1
 */
export function meanSaturation(rgba, w, h, stride = 4) {
	let acc = 0;
	let n = 0;
	const step = Math.max(1, stride) * 4;
	for (let i = 0; i < w * h * 4; i += step) {
		const r = rgba[i];
		const g = rgba[i + 1];
		const b = rgba[i + 2];
		const mx = Math.max(r, g, b);
		const mn = Math.min(r, g, b);
		acc += mx === 0 ? 0 : (mx - mn) / mx;
		n++;
	}
	return n ? acc / n : 0;
}

/**
 * Decide whether the input is good enough to reconstruct, and why not.
 * Only "no face" blocks; everything else is a non-fatal warning. Pure.
 *
 * @param {{
 *   width: number, height: number,
 *   faceCount: number,
 *   faceBox?: { x:number, y:number, w:number, h:number } | null,
 *   sharpness: number,
 *   flatness: number,
 *   saturation: number,
 *   luma?: number,
 * }} m `luma` is the mean face luma (0..255) when the caller measured it;
 *   omitted, lighting is not judged (the server stays the final authority).
 * @returns {{ verdict: 'good'|'warn'|'block', issues: string[], primary: string|null, message: string }}
 */
export function assessPhotoQuality(m) {
	const issues = [];
	const shortEdge = Math.max(1, Math.min(m.width, m.height));

	if (!m.faceCount) {
		return {
			verdict: 'block',
			issues: ['no-face'],
			primary: 'no-face',
			message:
				"We couldn't find a face. Use a clear, front-facing photo with your face well-lit and unobscured.",
		};
	}

	if (m.faceCount > 1) issues.push('multiple-faces');

	if (m.faceBox) {
		const faceRel = m.faceBox.w / shortEdge;
		if (faceRel < THRESH.faceTooFarRel) issues.push('far');
	}

	if (m.width < THRESH.minDimPx || m.height < THRESH.minDimPx) issues.push('low-res');
	if (m.sharpness < THRESH.sharpnessBlurry) issues.push('blurry');
	if (typeof m.luma === 'number') {
		if (m.luma < GATES.LUMA_MIN) issues.push('dark');
		else if (m.luma > GATES.LUMA_MAX) issues.push('bright');
	}
	if (m.flatness > THRESH.flatnessHigh && m.saturation > THRESH.saturationHigh)
		issues.push('illustration');

	const MESSAGES = {
		illustration:
			'This looks like a drawing or cartoon. 3D works best from a real photo — a flat illustration may come out flat. You can continue, but a real selfie gives a real you.',
		blurry: 'This photo looks soft. A sharper, well-lit shot reconstructs with more detail.',
		dark: 'Your face is in shadow. Face a light source so your features are visible.',
		bright: 'Your face is washed out. Step away from direct light or glare.',
		far: 'Your face is small in frame. Move closer or crop tighter for a stronger likeness.',
		'low-res': 'This image is low-resolution. A larger photo captures more facial detail.',
		'multiple-faces': "More than one face detected — we'll use the largest. Crop to just you for the best result.",
	};

	const order = ['illustration', 'blurry', 'dark', 'bright', 'far', 'low-res', 'multiple-faces'];
	const primary = order.find((k) => issues.includes(k)) || null;
	return {
		verdict: issues.length ? 'warn' : 'good',
		issues,
		primary,
		message: primary ? MESSAGES[primary] : 'Looks great.',
	};
}

/**
 * Compute a centred, square head-and-shoulders crop from a detected face box.
 * The face is placed in the upper third with headroom above and torso below —
 * the framing reconstruction models reconstruct most reliably. Optionally
 * widened to include the segmented subject's horizontal extent (shoulders are
 * wider than the face). Always returns an integer square clamped inside the
 * image; if the ideal square doesn't fit, the largest fitting square centred on
 * the face is returned instead. Pure.
 *
 * @param {{ x:number, y:number, w:number, h:number }} faceBox pixel space
 * @param {number} imgW
 * @param {number} imgH
 * @param {{ subjectBox?: {x:number,y:number,w:number,h:number}|null,
 *           headroom?: number, vertical?: number, scale?: number }} [opts]
 * @returns {{ x:number, y:number, w:number, h:number }}
 */
export function computeSubjectFrame(faceBox, imgW, imgH, opts = {}) {
	const headroom = opts.headroom ?? 0.7; // multiples of face height above the face top
	const scale = opts.scale ?? 3.4; // crop side as multiples of face height
	const faceCx = faceBox.x + faceBox.w / 2;

	// Ideal square side from face height, widened if the subject mask is wider.
	let side = faceBox.h * scale;
	if (opts.subjectBox && opts.subjectBox.w > 0) {
		side = Math.max(side, opts.subjectBox.w * 1.25);
	}
	side = Math.min(side, imgW, imgH); // can't exceed the frame

	// Top: leave headroom above the face; the rest of the square falls below,
	// capturing neck + shoulders.
	let top = faceBox.y - faceBox.h * headroom;
	let left = faceCx - side / 2;

	// Clamp inside the image, preserving the square side.
	left = Math.max(0, Math.min(left, imgW - side));
	top = Math.max(0, Math.min(top, imgH - side));

	return {
		x: Math.round(left),
		y: Math.round(top),
		w: Math.round(side),
		h: Math.round(side),
	};
}

/**
 * Bounding box (pixel space) of the foreground in a confidence mask, using a
 * threshold. Returns null if nothing crosses the threshold. Pure.
 *
 * @param {Float32Array|number[]} mask length maskW*maskH, values 0..1
 * @param {number} maskW
 * @param {number} maskH
 * @param {number} imgW target image width to scale the box into
 * @param {number} imgH
 * @param {number} [thresh=0.5]
 * @returns {{ x:number, y:number, w:number, h:number } | null}
 */
export function maskBoundingBox(mask, maskW, maskH, imgW, imgH, thresh = 0.5) {
	let minX = maskW;
	let minY = maskH;
	let maxX = -1;
	let maxY = -1;
	for (let y = 0; y < maskH; y++) {
		for (let x = 0; x < maskW; x++) {
			if (mask[y * maskW + x] >= thresh) {
				if (x < minX) minX = x;
				if (x > maxX) maxX = x;
				if (y < minY) minY = y;
				if (y > maxY) maxY = y;
			}
		}
	}
	if (maxX < 0) return null;
	const sx = imgW / maskW;
	const sy = imgH / maskH;
	return {
		x: Math.round(minX * sx),
		y: Math.round(minY * sy),
		w: Math.round((maxX - minX + 1) * sx),
		h: Math.round((maxY - minY + 1) * sy),
	};
}

/** Smoothstep — used to feather the segmentation mask edge into alpha. Pure. */
export function smoothstep(edge0, edge1, x) {
	if (edge0 === edge1) return x < edge0 ? 0 : 1;
	const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
	return t * t * (3 - 2 * t);
}

/* ────────────────────────────────────────────────────────────────────────── *
 * DOM / MediaPipe wrappers — browser only.
 * ────────────────────────────────────────────────────────────────────────── */

let _segmenterPromise = null;

/** Lazy-load the Selfie Segmenter. Resolves null (never throws) on failure. */
async function loadSegmenter() {
	if (_segmenterPromise) return _segmenterPromise;
	_segmenterPromise = (async () => {
		const mod = await loadVision();
		const { FilesetResolver, ImageSegmenter } = mod;
		const vision = await FilesetResolver.forVisionTasks(await visionWasmBase());
		return ImageSegmenter.createFromOptions(vision, {
			baseOptions: { modelAssetPath: SELFIE_MODEL_URL, delegate: 'GPU' },
			runningMode: 'IMAGE',
			outputConfidenceMasks: true,
			outputCategoryMask: false,
		});
	})().catch((err) => {
		_segmenterPromise = null; // allow a retry on the next photo
		log.warn('[selfie-refine] segmenter load failed:', err);
		return null;
	});
	return _segmenterPromise;
}

let _detectorPromise = null;

/** Lazy-load the BlazeFace detector. Resolves null (never throws) on failure. */
async function loadFaceDetector() {
	if (_detectorPromise) return _detectorPromise;
	_detectorPromise = (async () => {
		const mod = await loadVision();
		const { FilesetResolver, FaceDetector } = mod;
		const vision = await FilesetResolver.forVisionTasks(await visionWasmBase());
		return FaceDetector.createFromOptions(vision, {
			baseOptions: { modelAssetPath: FACE_DETECTOR_MODEL_URL, delegate: 'GPU' },
			runningMode: 'IMAGE',
		});
	})().catch((err) => {
		_detectorPromise = null;
		log.warn('[selfie-refine] face detector load failed:', err);
		return null;
	});
	return _detectorPromise;
}

/**
 * Detect faces and return the largest as a normalised box plus the total count.
 * Coordinates are fractions of the image (0..1) so the box is resolution
 * independent. Returns null when no face is found or the detector is
 * unavailable.
 *
 * @param {ImageBitmap|HTMLImageElement|HTMLCanvasElement} bitmap
 * @returns {Promise<{ x:number, y:number, w:number, h:number, count:number } | null>}
 */
export async function detectFaceBox(bitmap) {
	const detector = await loadFaceDetector();
	if (!detector) return null;
	const { w, h } = dimsOf(bitmap);
	if (!w || !h) return null;
	const res = detector.detect(bitmap);
	const dets = res?.detections || [];
	if (!dets.length) return null;
	// Largest by area — the subject, not a bystander in the background.
	let best = null;
	let bestArea = -1;
	for (const d of dets) {
		const b = d.boundingBox;
		if (!b) continue;
		const area = b.width * b.height;
		if (area > bestArea) {
			bestArea = area;
			best = b;
		}
	}
	if (!best) return null;
	return {
		x: best.originX / w,
		y: best.originY / h,
		w: best.width / w,
		h: best.height / h,
		count: dets.length,
	};
}

/** Pre-warm the detection + segmentation models (overlap with camera UI). */
export function warmRefiner() {
	loadFaceDetector().catch(() => {});
	loadSegmenter().catch(() => {});
}

/** @param {ImageBitmap|HTMLImageElement|HTMLCanvasElement} src */
function dimsOf(src) {
	const w = src.width || src.naturalWidth || src.videoWidth || 0;
	const h = src.height || src.naturalHeight || src.videoHeight || 0;
	return { w, h };
}

/** Fit (w,h) within max, preserving aspect. */
function fitWithin(w, h, max) {
	if (w <= max && h <= max) return { w, h };
	const s = Math.min(max / w, max / h);
	return { w: Math.round(w * s), h: Math.round(h * s) };
}

/**
 * Assess a photo's suitability for reconstruction. Loads the face landmarker to
 * locate the face, samples the pixels for sharpness/flatness/saturation, and
 * returns the pure {@link assessPhotoQuality} verdict plus the face box (for
 * reframing). Never throws — on detector failure it returns a permissive
 * "good" so the server stays the final authority.
 *
 * @param {ImageBitmap|HTMLImageElement} bitmap
 * @returns {Promise<{ verdict:string, issues:string[], primary:string|null, message:string, faceBox:object|null }>}
 */
export async function assessPhoto(bitmap) {
	const { w, h } = dimsOf(bitmap);
	try {
		const face = await detectFaceBox(bitmap);

		// Sample at a small fixed size — quality metrics don't need full res and
		// this keeps the per-pixel passes cheap.
		const s = fitWithin(w, h, 256);
		const canvas = makeCanvas(s.w, s.h);
		const ctx = canvas.getContext('2d', { willReadFrequently: true });
		ctx.drawImage(bitmap, 0, 0, s.w, s.h);
		const { data } = ctx.getImageData(0, 0, s.w, s.h);

		const grey = new Uint8Array(s.w * s.h);
		for (let i = 0, p = 0; i < data.length; i += 4, p++) {
			// Rec. 601 luma.
			grey[p] = (data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114) | 0;
		}

		const faceBoxPx = face
			? { x: face.x * w, y: face.y * h, w: face.w * w, h: face.h * h }
			: null;

		// Mean luma over the face region (whole frame when no box): the lighting
		// gate cares whether the FACE is legible, not whether the room is bright.
		let luma;
		{
			const bx = face ? Math.max(0, Math.round(face.x * s.w)) : 0;
			const by = face ? Math.max(0, Math.round(face.y * s.h)) : 0;
			const bw = face ? Math.min(s.w - bx, Math.max(1, Math.round(face.w * s.w))) : s.w;
			const bh = face ? Math.min(s.h - by, Math.max(1, Math.round(face.h * s.h))) : s.h;
			let sum = 0;
			for (let y = by; y < by + bh; y++)
				for (let x = bx; x < bx + bw; x++) sum += grey[y * s.w + x];
			luma = sum / (bw * bh);
		}

		const assessment = assessPhotoQuality({
			width: w,
			height: h,
			faceCount: face ? face.count : 0,
			faceBox: faceBoxPx,
			sharpness: laplacianVariance(grey, s.w, s.h),
			flatness: flatnessScore(grey, s.w, s.h),
			saturation: meanSaturation(data, s.w, s.h),
			luma,
		});
		return { ...assessment, faceBox: faceBoxPx };
	} catch (err) {
		log.warn('[selfie-refine] assess failed, allowing through:', err);
		return { verdict: 'good', issues: [], primary: null, message: '', faceBox: null };
	}
}

/**
 * Isolate the subject and reframe into a clean head-and-shoulders square on a
 * neutral studio backdrop — the composition the reconstruction lane handles
 * best. Returns a JPEG data URL. Never throws: on any failure it falls back to
 * a plain centred crop (or the original frame) so capture always proceeds.
 *
 * @param {ImageBitmap|HTMLImageElement} bitmap
 * @param {{ faceBox?: object|null, onStep?: (label:string)=>void }} [opts]
 * @returns {Promise<{ dataUrl: string, isolated: boolean }>}
 */
export async function refineSelfie(bitmap, opts = {}) {
	const onStep = opts.onStep || (() => {});
	const { w: srcW, h: srcH } = dimsOf(bitmap);
	const work = fitWithin(srcW, srcH, WORK_MAX);

	// Draw the frame once at working resolution.
	const frame = makeCanvas(work.w, work.h);
	const fctx = frame.getContext('2d', { willReadFrequently: true });
	fctx.drawImage(bitmap, 0, 0, work.w, work.h);

	// Face box in working-resolution pixels (from the prior assess pass, or a
	// fresh detect). Without a face we can still matte + centre-crop.
	let faceBox = opts.faceBox
		? { x: opts.faceBox.x * (work.w / srcW), y: opts.faceBox.y * (work.h / srcH), w: opts.faceBox.w * (work.w / srcW), h: opts.faceBox.h * (work.h / srcH) }
		: null;
	if (!faceBox) {
		try {
			const f = await detectFaceBox(bitmap);
			if (f) faceBox = { x: f.x * work.w, y: f.y * work.h, w: f.w * work.w, h: f.h * work.h };
		} catch (_) {}
	}

	let subjectBox = null;
	let isolated = false;

	// ── Matte the subject onto a neutral backdrop ────────────────────────────
	try {
		onStep('Isolating subject…');
		const segmenter = await loadSegmenter();
		if (segmenter) {
			// Segment the original source, not the OffscreenCanvas working frame:
			// MediaPipe accepts ImageBitmap/HTMLImageElement everywhere, whereas
			// OffscreenCanvas input isn't supported across all builds. The mask
			// covers the same aspect ratio either way, so the work-space sampling
			// below is unaffected.
			const result = segmenter.segment(bitmap);
			const conf = result?.confidenceMasks?.[0];
			if (conf) {
				const maskW = conf.width;
				const maskH = conf.height;
				const maskArr = conf.getAsFloat32Array();
				subjectBox = maskBoundingBox(maskArr, maskW, maskH, work.w, work.h, 0.5);

				// Apply the feathered mask as alpha on the frame.
				const img = fctx.getImageData(0, 0, work.w, work.h);
				const d = img.data;
				for (let y = 0; y < work.h; y++) {
					const my = Math.min(maskH - 1, (y * maskH / work.h) | 0);
					for (let x = 0; x < work.w; x++) {
						const mx = Math.min(maskW - 1, (x * maskW / work.w) | 0);
						const p = maskArr[my * maskW + mx];
						const a = smoothstep(0.35, 0.65, p);
						d[(y * work.w + x) * 4 + 3] = (a * 255) | 0;
					}
				}
				// Composite over a neutral studio gradient: matted subject on top.
				const subjectCanvas = makeCanvas(work.w, work.h);
				subjectCanvas.getContext('2d').putImageData(img, 0, 0);
				paintStudioBackdrop(fctx, work.w, work.h);
				fctx.drawImage(subjectCanvas, 0, 0);
				isolated = true;

				if (typeof result.close === 'function') result.close();
				else conf.close?.();
			}
		}
	} catch (err) {
		log.warn('[selfie-refine] segmentation failed, framing only:', err);
	}

	// ── Reframe to a centred head-and-shoulders square ───────────────────────
	onStep('Reframing…');
	const out = makeCanvas(OUTPUT_SIZE, OUTPUT_SIZE);
	const octx = out.getContext('2d');
	// Fill first so any crop that runs past the subject reads as studio, not black.
	paintStudioBackdrop(octx, OUTPUT_SIZE, OUTPUT_SIZE);

	const frameBox = faceBox
		? computeSubjectFrame(faceBox, work.w, work.h, { subjectBox })
		: centreSquare(work.w, work.h);
	octx.drawImage(
		frame,
		frameBox.x, frameBox.y, frameBox.w, frameBox.h,
		0, 0, OUTPUT_SIZE, OUTPUT_SIZE,
	);

	const dataUrl = await canvasToDataUrl(out, JPEG_QUALITY);
	return { dataUrl, isolated };
}

/**
 * Data URL from either a DOM canvas (toDataURL) or an OffscreenCanvas
 * (convertToBlob → FileReader), so the working canvas can be either.
 * @param {HTMLCanvasElement|OffscreenCanvas} canvas
 * @param {number} quality
 * @returns {Promise<string>}
 */
async function canvasToDataUrl(canvas, quality) {
	if (typeof canvas.toDataURL === 'function') {
		return canvas.toDataURL('image/jpeg', quality);
	}
	const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality });
	return await new Promise((resolve, reject) => {
		const fr = new FileReader();
		fr.onload = () => resolve(/** @type {string} */ (fr.result));
		fr.onerror = () => reject(fr.error || new Error('blob read failed'));
		fr.readAsDataURL(blob);
	});
}

/** Largest centred square within (w,h). */
function centreSquare(w, h) {
	const side = Math.min(w, h);
	return { x: Math.round((w - side) / 2), y: Math.round((h - side) / 2), w: side, h: side };
}

/**
 * Paint a soft, neutral studio backdrop — a gentle vertical grey gradient with
 * a subtle radial vignette behind the head. Mirrors the "plain neutral studio
 * background, soft even lighting" the text→avatar prompt steers toward.
 * @param {CanvasRenderingContext2D} ctx
 */
function paintStudioBackdrop(ctx, w, h) {
	const lin = ctx.createLinearGradient(0, 0, 0, h);
	lin.addColorStop(0, '#d9dbe0');
	lin.addColorStop(1, '#b7bac1');
	ctx.fillStyle = lin;
	ctx.fillRect(0, 0, w, h);
	const rad = ctx.createRadialGradient(w / 2, h * 0.34, h * 0.05, w / 2, h * 0.34, h * 0.7);
	rad.addColorStop(0, 'rgba(255,255,255,0.55)');
	rad.addColorStop(1, 'rgba(255,255,255,0)');
	ctx.fillStyle = rad;
	ctx.fillRect(0, 0, w, h);
}

/** OffscreenCanvas when available (workers/perf), else a DOM canvas. */
function makeCanvas(w, h) {
	if (typeof OffscreenCanvas === 'function') {
		try {
			return new OffscreenCanvas(w, h);
		} catch (_) {}
	}
	const c = document.createElement('canvas');
	c.width = w;
	c.height = h;
	return c;
}
