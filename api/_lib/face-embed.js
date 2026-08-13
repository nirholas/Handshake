// Face identity embedding: the measuring instrument behind the Phase 1 likeness
// score (README Roadmap, "≥4/5 likeness score").
//
// Everything the platform measured about a reconstruction until now was either
// realism (api/_lib/quality-bench.js: a Gemini vision judge scoring
// photorealism / geometry / texture / prompt adherence) or face SHAPE
// (workers/avatar-reconstruction/eval/identity_eval.py: ISE, a landmark
// geometry distance that deliberately ignores texture). Neither answers the
// question the roadmap actually gates on, which is whether a stranger looking
// at the finished avatar would say it is the same person as the photos. That
// question has one honest instrument: a face-recognition embedding, the same
// class of model a phone uses to decide a face unlocks it.
//
// Two OSS models, both commercially clean, matching the reconstruction worker's
// standing "Apache-2.0 / MIT only, no non-commercial 3DMM weights" rule:
//
//   • YuNet  (MIT, Shiqi Yu / OpenCV Zoo): face detection plus the five
//     landmarks (eyes, nose tip, mouth corners) that identity models align on.
//   • SFace  (Apache-2.0, Zhong & Deng / OpenCV Zoo): 128-d identity
//     embedding, the model OpenCV's own FaceRecognizerSF ships.
//
// They run on onnxruntime-web's WASM backend (MIT) rather than
// onnxruntime-node: the node binding's installer downloads CUDA provider
// packages from NuGet at `npm install` time and fails outright on a machine
// that has no GPU tree, which would make the whole repo uninstallable. WASM has
// no native step, runs identically on a laptop and on Cloud Run, and scores a
// face in tens of milliseconds, which is far below the cost of the render that
// produced the image.
//
// Weights are NOT vendored: 39 MB of ONNX does not belong in git. They are
// fetched once from a commit-pinned OpenCV Zoo URL, verified against a
// hardcoded SHA-256, and cached on disk. A hash mismatch is fatal: a
// silently-swapped identity model would corrupt every score in the table.
//
// Cosine similarity is the score. OpenCV publishes SFace's operating point as
// 0.363 (same identity above, different identity below) on its own benchmark.
// That constant is exported here rather than buried, because every downstream
// interpretation of a number this module returns depends on it.

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// Pinned to one opencv_zoo commit, not to `main`: a moving ref means a model
// swap could land in a cron run nobody triggered, and every stored score before
// it would silently stop being comparable.
const ZOO_COMMIT = '47534e27c9851bb1128ccc0102f1145e27f23f98';
const ZOO_RAW = `https://raw.githubusercontent.com/opencv/opencv_zoo/${ZOO_COMMIT}/models`;

export const MODELS = {
	detect: {
		id: 'yunet_2023mar',
		url: `${ZOO_RAW}/face_detection_yunet/face_detection_yunet_2023mar.onnx`,
		sha256: '8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4',
		license: 'MIT',
	},
	embed: {
		id: 'sface_2021dec',
		url: `${ZOO_RAW}/face_recognition_sface/face_recognition_sface_2021dec.onnx`,
		sha256: '0ba9fbfa01b5270c96627c4ef784da859931e02f04419c829e83484087c34e79',
		license: 'Apache-2.0',
	},
};

// Bumped whenever anything that can move a number changes: a model swap, the
// alignment template, the detector thresholds. Stored next to every score so a
// row always says which instrument produced it and `where scorer_version <> $current`
// is the re-score query.
export const SCORER_VERSION = 'threews.likeness.sface.v1';

// OpenCV's published SFace decision threshold on cosine similarity.
export const SFACE_SAME_IDENTITY_COSINE = 0.363;

// YuNet's detection head: one 640x640 input, three strides, and per-stride
// classification / objectness / box / keypoint tensors on a plain grid prior.
const DETECT_SIZE = 640;
const STRIDES = [8, 16, 32];
const DETECT_SCORE_THRESHOLD = 0.6;
const DETECT_NMS_IOU = 0.3;

// SFace's alignment template: the canonical 112x112 five-point layout every
// ArcFace-family model was trained against, in YuNet's landmark order
// (subject's right eye, left eye, nose tip, right mouth corner, left mouth
// corner: "right" as the subject's, so it sits at the smaller x in frame).
const ALIGN_SIZE = 112;
const ALIGN_TEMPLATE = [
	[38.2946, 51.6963],
	[73.5318, 51.5014],
	[56.0252, 71.7366],
	[41.5493, 92.3655],
	[70.7299, 92.2041],
];

function cacheDir() {
	return process.env.FACE_MODEL_CACHE_DIR || path.join(os.tmpdir(), 'three-ws-face-models');
}

// Fetch-once, verify-always. A cached file that fails its hash is treated as a
// corrupt download and re-fetched exactly once before giving up, so a truncated
// write on a previous run heals itself instead of poisoning every later run.
async function modelBytes(spec) {
	const dir = cacheDir();
	const file = path.join(dir, `${spec.id}.onnx`);
	const cached = await readFile(file).catch(() => null);
	if (cached && createHash('sha256').update(cached).digest('hex') === spec.sha256) return cached;

	const res = await fetch(spec.url);
	if (!res.ok) throw new Error(`face model ${spec.id} download failed: HTTP ${res.status}`);
	const buf = Buffer.from(await res.arrayBuffer());
	const got = createHash('sha256').update(buf).digest('hex');
	if (got !== spec.sha256) {
		throw new Error(`face model ${spec.id} hash mismatch: expected ${spec.sha256}, got ${got}`);
	}
	await mkdir(dir, { recursive: true });
	await writeFile(file, buf);
	return buf;
}

let _ort = null;
async function ort() {
	if (_ort) return _ort;
	const mod = await import('onnxruntime-web');
	const api = mod.default ?? mod;
	// One thread and no SIMD-thread pool: Cloud Run gives this container a small,
	// shared CPU budget and the scoring work is already dwarfed by the headless
	// render in front of it. Spawning workers here only competes with the API.
	api.env.wasm.numThreads = 1;
	api.env.logLevel = 'error';
	_ort = api;
	return api;
}

const _sessions = new Map();
async function session(spec) {
	if (_sessions.has(spec.id)) return _sessions.get(spec.id);
	const promise = (async () => {
		const [api, bytes] = await Promise.all([ort(), modelBytes(spec)]);
		return api.InferenceSession.create(bytes, { executionProviders: ['wasm'] });
	})().catch((err) => {
		_sessions.delete(spec.id);
		throw err;
	});
	_sessions.set(spec.id, promise);
	return promise;
}

// Decode any image the platform can hand us (PNG render, JPEG selfie, WebP
// upload) into tightly-packed RGB bytes. sharp is already a dependency and is
// the only decoder in the repo that handles all three without a browser.
export async function decodeImage(buffer) {
	const { default: sharp } = await import('sharp');
	const { data, info } = await sharp(buffer)
		.removeAlpha()
		.raw()
		.toBuffer({ resolveWithObject: true });
	return { data, width: info.width, height: info.height };
}

// Letterbox into the detector's fixed 640x640 input rather than stretching:
// YuNet regresses landmark offsets in its own input space, and a non-uniform
// scale bends the five-point geometry that alignment then depends on. Returns
// the scale/offset so detections map back to original-image coordinates.
function letterbox(img) {
	const scale = Math.min(DETECT_SIZE / img.width, DETECT_SIZE / img.height);
	const w = Math.max(1, Math.round(img.width * scale));
	const h = Math.max(1, Math.round(img.height * scale));
	const dx = Math.floor((DETECT_SIZE - w) / 2);
	const dy = Math.floor((DETECT_SIZE - h) / 2);
	return { scale, w, h, dx, dy };
}

// YuNet consumes raw 0-255 BGR in NCHW, with no mean subtraction and no scaling
// (this mirrors what cv2.FaceDetectorYN does internally).
async function detectInputTensor(buffer, box) {
	const { default: sharp } = await import('sharp');
	const { data } = await sharp(buffer)
		.removeAlpha()
		.resize(box.w, box.h, { fit: 'fill' })
		.extend({
			top: box.dy,
			bottom: DETECT_SIZE - box.h - box.dy,
			left: box.dx,
			right: DETECT_SIZE - box.w - box.dx,
			background: { r: 0, g: 0, b: 0 },
		})
		.raw()
		.toBuffer({ resolveWithObject: true });
	const plane = DETECT_SIZE * DETECT_SIZE;
	const out = new Float32Array(3 * plane);
	for (let i = 0; i < plane; i += 1) {
		out[i] = data[i * 3 + 2];
		out[plane + i] = data[i * 3 + 1];
		out[2 * plane + i] = data[i * 3];
	}
	return out;
}

function iou(a, b) {
	const x1 = Math.max(a.x, b.x);
	const y1 = Math.max(a.y, b.y);
	const x2 = Math.min(a.x + a.w, b.x + b.w);
	const y2 = Math.min(a.y + a.h, b.y + b.h);
	const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
	if (inter <= 0) return 0;
	return inter / (a.w * a.h + b.w * b.h - inter);
}

function nms(faces, threshold) {
	const kept = [];
	for (const face of [...faces].sort((p, q) => q.score - p.score)) {
		if (kept.every((k) => iou(k, face) < threshold)) kept.push(face);
	}
	return kept;
}

// Decode YuNet's per-stride heads onto the grid prior. Cell (r, c) at stride s
// carries a centre offset in cells, log-space width/height, and five landmark
// offsets in the same units; the confidence is the geometric mean of the
// classification and objectness scores.
function decodeDetections(outputs, box) {
	const faces = [];
	for (const stride of STRIDES) {
		const cls = outputs[`cls_${stride}`]?.data;
		const obj = outputs[`obj_${stride}`]?.data;
		const bbox = outputs[`bbox_${stride}`]?.data;
		const kps = outputs[`kps_${stride}`]?.data;
		if (!cls || !obj || !bbox || !kps) continue;
		const cols = DETECT_SIZE / stride;
		for (let idx = 0; idx < cls.length; idx += 1) {
			const score = Math.sqrt(Math.max(0, cls[idx]) * Math.max(0, obj[idx]));
			if (score < DETECT_SCORE_THRESHOLD) continue;
			const r = Math.floor(idx / cols);
			const c = idx % cols;
			const cx = (c + bbox[idx * 4]) * stride;
			const cy = (r + bbox[idx * 4 + 1]) * stride;
			const w = Math.exp(bbox[idx * 4 + 2]) * stride;
			const h = Math.exp(bbox[idx * 4 + 3]) * stride;
			const landmarks = [];
			for (let k = 0; k < 5; k += 1) {
				landmarks.push([
					((c + kps[idx * 10 + k * 2]) * stride - box.dx) / box.scale,
					((r + kps[idx * 10 + k * 2 + 1]) * stride - box.dy) / box.scale,
				]);
			}
			faces.push({
				score,
				x: (cx - w / 2 - box.dx) / box.scale,
				y: (cy - h / 2 - box.dy) / box.scale,
				w: w / box.scale,
				h: h / box.scale,
				landmarks,
			});
		}
	}
	return nms(faces, DETECT_NMS_IOU);
}

// Every detected face in one image, highest confidence first, in the original
// image's pixel coordinates.
export async function detectFaces(buffer) {
	const [api, sess, img] = await Promise.all([ort(), session(MODELS.detect), decodeImage(buffer)]);
	const box = letterbox(img);
	const input = await detectInputTensor(buffer, box);
	const feeds = { [sess.inputNames[0]]: new api.Tensor('float32', input, [1, 3, DETECT_SIZE, DETECT_SIZE]) };
	const outputs = await sess.run(feeds);
	return decodeDetections(outputs, box);
}

// Closed-form least-squares similarity fit (Umeyama) from the detected five
// points onto the canonical template. Similarity, not affine: identity must not
// be recoverable by shearing a face into the template, and the closed form is
// deterministic where OpenCV's RANSAC estimate is not, so the same image always
// produces the same embedding.
function similarityTransform(src, dst) {
	const n = src.length;
	let sx = 0;
	let sy = 0;
	let dx = 0;
	let dy = 0;
	for (let i = 0; i < n; i += 1) {
		sx += src[i][0];
		sy += src[i][1];
		dx += dst[i][0];
		dy += dst[i][1];
	}
	sx /= n;
	sy /= n;
	dx /= n;
	dy /= n;

	let varSrc = 0;
	let a = 0;
	let b = 0;
	for (let i = 0; i < n; i += 1) {
		const px = src[i][0] - sx;
		const py = src[i][1] - sy;
		const qx = dst[i][0] - dx;
		const qy = dst[i][1] - dy;
		varSrc += px * px + py * py;
		a += px * qx + py * qy;
		b += px * qy - py * qx;
	}
	if (varSrc <= 1e-9) throw new Error('degenerate landmark set: all five points coincide');
	const scaleCos = a / varSrc;
	const scaleSin = b / varSrc;
	return {
		m: [
			[scaleCos, -scaleSin, dx - (scaleCos * sx - scaleSin * sy)],
			[scaleSin, scaleCos, dy - (scaleSin * sx + scaleCos * sy)],
		],
	};
}

// Invert the 2x3 similarity so the crop can be filled by pulling source pixels
// (destination-driven sampling leaves no holes; source-driven scattering does).
function invert(m) {
	const det = m[0][0] * m[1][1] - m[0][1] * m[1][0];
	if (Math.abs(det) < 1e-12) throw new Error('non-invertible alignment transform');
	const i00 = m[1][1] / det;
	const i01 = -m[0][1] / det;
	const i10 = -m[1][0] / det;
	const i11 = m[0][0] / det;
	return [
		[i00, i01, -(i00 * m[0][2] + i01 * m[1][2])],
		[i10, i11, -(i10 * m[0][2] + i11 * m[1][2])],
	];
}

// Bilinear-sample the aligned 112x112 crop straight into SFace's BGR NCHW
// input. Edge coordinates clamp rather than wrap so a face that runs off the
// frame contributes its border pixels instead of the opposite side of the image.
function alignCrop(img, landmarks) {
	const inv = invert(similarityTransform(landmarks, ALIGN_TEMPLATE).m);
	const plane = ALIGN_SIZE * ALIGN_SIZE;
	const out = new Float32Array(3 * plane);
	const maxX = img.width - 1;
	const maxY = img.height - 1;
	for (let y = 0; y < ALIGN_SIZE; y += 1) {
		for (let x = 0; x < ALIGN_SIZE; x += 1) {
			const sxf = Math.min(maxX, Math.max(0, inv[0][0] * x + inv[0][1] * y + inv[0][2]));
			const syf = Math.min(maxY, Math.max(0, inv[1][0] * x + inv[1][1] * y + inv[1][2]));
			const x0 = Math.floor(sxf);
			const y0 = Math.floor(syf);
			const x1 = Math.min(maxX, x0 + 1);
			const y1 = Math.min(maxY, y0 + 1);
			const fx = sxf - x0;
			const fy = syf - y0;
			const o = y * ALIGN_SIZE + x;
			for (let ch = 0; ch < 3; ch += 1) {
				const p00 = img.data[(y0 * img.width + x0) * 3 + ch];
				const p10 = img.data[(y0 * img.width + x1) * 3 + ch];
				const p01 = img.data[(y1 * img.width + x0) * 3 + ch];
				const p11 = img.data[(y1 * img.width + x1) * 3 + ch];
				const top = p00 + (p10 - p00) * fx;
				const bottom = p01 + (p11 - p01) * fx;
				// RGB in, BGR out: channel 0 of the source lands in plane 2.
				out[(2 - ch) * plane + o] = top + (bottom - top) * fy;
			}
		}
	}
	return out;
}

function l2Normalize(vec) {
	let norm = 0;
	for (const v of vec) norm += v * v;
	norm = Math.sqrt(norm);
	if (norm < 1e-9) throw new Error('degenerate embedding: zero-norm vector');
	return Float32Array.from(vec, (v) => v / norm);
}

// The identity vector for the most confident face in an image, L2-normalized so
// cosine similarity is a plain dot product. Returns null when no face clears
// the detector threshold: an avatar whose head is not recognisable AS a face is
// a real, reportable finding, never a fabricated score.
export async function embedFace(buffer) {
	const faces = await detectFaces(buffer);
	if (!faces.length) return null;
	const best = faces.reduce((a, b) => (b.score > a.score ? b : a));
	const [api, sess, img] = await Promise.all([ort(), session(MODELS.embed), decodeImage(buffer)]);
	const input = alignCrop(img, best.landmarks);
	const feeds = { [sess.inputNames[0]]: new api.Tensor('float32', input, [1, 3, ALIGN_SIZE, ALIGN_SIZE]) };
	const outputs = await sess.run(feeds);
	const raw = outputs[sess.outputNames[0]].data;
	return { embedding: l2Normalize(raw), detection: { score: best.score, box: [best.x, best.y, best.w, best.h] } };
}

// Cosine similarity of two L2-normalized embeddings, in [-1, 1].
export function cosineSimilarity(a, b) {
	if (!a || !b || a.length !== b.length) throw new Error('cosine similarity needs two equal-length vectors');
	let dot = 0;
	for (let i = 0; i < a.length; i += 1) dot += a[i] * b[i];
	return dot;
}
