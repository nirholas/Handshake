// Where MediaPipe's runtime and model files come from.
//
// Every vision feature (face and body mocap, sign-language input, selfie
// refinement, capture quality gating) needs three things: the tasks-vision
// module, the vision WASM runtime, and a `.task` / `.tflite` model. Each call
// site used to name a CDN URL for all three, so /mocap, /sign and
// selfie-to-avatar were simultaneously hard-dependent on cdn.jsdelivr.net AND
// storage.googleapis.com, with no timeout and no alternative. One blocked host
// (a corporate proxy, a region, an ad blocker, a CDN incident) took every one of
// those features down with a raw MediaPipe error string.
//
// This module answers all three questions once:
//
//   loadVision()        the tasks-vision module, from our own bundle
//   visionWasmBase()    the WASM directory, our copy first, then two CDNs
//   modelUrl(name)      a model file, our copy first, then Google's bucket
//
// `@mediapipe/tasks-vision` is a real dependency of this repo, so the module
// itself now ships in our bundle and needs no CDN at all. The WASM runtime is
// vendored under public/vendor/mediapipe/wasm, and face_landmarker.task with
// it; the larger models (pose, holistic, hand, segmenter) are still fetched
// from Google's public bucket, but under a deadline, so a stalled download
// surfaces as a real error instead of a spinner that never resolves.

// Models vendored into public/vendor/mediapipe. Anything not listed here is
// fetched from Google's bucket.
const LOCAL_MODELS = new Set(['face_landmarker.task']);

const GOOGLE_MODELS = 'https://storage.googleapis.com/mediapipe-models';

// Pinned to the version in package.json: the WASM runtime and the JS module must
// agree, so this constant moves when the dependency does.
const VERSION = '0.10.35';
const CDN_WASM_BASES = [
	`https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${VERSION}/wasm`,
	`https://unpkg.com/@mediapipe/tasks-vision@${VERSION}/wasm`,
];

// Resolved against this module's own URL rather than written as a site-absolute
// path, so an embed served from three.ws still points at three.ws instead of at
// the embedding page's origin.
const LOCAL_BASE = (() => {
	try {
		return new URL('../../vendor/mediapipe', import.meta.url).href.replace(/\/$/, '');
	} catch {
		return '/vendor/mediapipe';
	}
})();

const PROBE_TIMEOUT_MS = 4_000;

/**
 * The tasks-vision module. Bundled, so this resolves without any network call
 * beyond our own assets.
 *
 * @returns {Promise<typeof import('@mediapipe/tasks-vision')>}
 */
export function loadVision() {
	return import('@mediapipe/tasks-vision');
}

let _wasmBase = null;

/**
 * Directory to hand `FilesetResolver.forVisionTasks()`. Prefers the copy under
 * public/vendor/mediapipe/wasm and falls back to jsDelivr then unpkg, probing
 * once per page and remembering the answer.
 *
 * @returns {Promise<string>}
 */
export async function visionWasmBase() {
	if (_wasmBase) return _wasmBase;
	for (const base of [LOCAL_BASE + '/wasm', ...CDN_WASM_BASES]) {
		try {
			const res = await fetch(`${base}/vision_wasm_internal.wasm`, {
				method: 'HEAD',
				signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
			});
			if (res.ok) {
				_wasmBase = base;
				return base;
			}
		} catch {
			// Unreachable or blocked: try the next host.
		}
	}
	// Nothing answered the probe. Return the first CDN anyway rather than
	// throwing here: MediaPipe's own loader gives a better error than a probe.
	_wasmBase = CDN_WASM_BASES[0];
	return _wasmBase;
}

/**
 * Absolute URL for a MediaPipe model file. Vendored models come from our own
 * origin; everything else comes from Google's public bucket.
 *
 * @param {string} path  Bucket-relative path, e.g.
 *   'pose_landmarker/pose_landmarker_full/float16/1/pose_landmarker_full.task'
 * @returns {string}
 */
export function modelUrl(path) {
	const file = String(path).split('/').pop();
	if (LOCAL_MODELS.has(file)) return `${LOCAL_BASE}/${file}`;
	return `${GOOGLE_MODELS}/${String(path).replace(/^\/+/, '')}`;
}

/**
 * The two calls every consumer makes, in one await: the module plus a WASM
 * fileset resolved against the healthiest host.
 *
 * @returns {Promise<{ vision: any, tasks: typeof import('@mediapipe/tasks-vision') }>}
 */
export async function visionFileset() {
	const [tasks, base] = await Promise.all([loadVision(), visionWasmBase()]);
	const vision = await tasks.FilesetResolver.forVisionTasks(base);
	return { vision, tasks };
}
