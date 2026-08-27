// Tripo provider — alternative native geometry-first backend.
//
//   geometry path → POST /v2/openapi/task { type: "text_to_model" }
//       Native text→model: clean (often quad) geometry directly from the
//       prompt. `face_limit` carries the tier's poly budget.
//
//   image path    → POST /v2/openapi/task { type: "image_to_model" }
//       Single-image reconstruction with PBR textures.
//
// Tripo wraps every response in { code, data } and polls a single task
// endpoint regardless of type, so this client is simpler than Meshy's.
//
// BYOK only: the caller passes the user's Tripo key (tsk_…). The model version
// defaults to v3.1 and is overridable via TRIPO_MODEL_VERSION.

import { fetchUpstream } from '../_lib/upstream-fetch.js';

const TRIPO_BASE = 'https://api.tripo3d.ai/v2/openapi';
const DEFAULT_MODEL_VERSION = 'v3.1-20260211';

// Tripo's face_limit is unbounded upward in practice, but keep the same sane
// floor/ceiling as the rest of the pipeline so a tier can't request an
// unworkable mesh.
const FACE_MIN = 100;
const FACE_MAX = 300_000;

function clampFaces(n) {
	const v = Math.round(Number(n) || 0);
	return Math.max(FACE_MIN, Math.min(FACE_MAX, v));
}

function modelVersion() {
	if (typeof process !== 'undefined' && process.env?.TRIPO_MODEL_VERSION) {
		return process.env.TRIPO_MODEL_VERSION;
	}
	return DEFAULT_MODEL_VERSION;
}

function mapStatus(s) {
	switch (String(s || '').toLowerCase()) {
		case 'queued':
			return 'queued';
		case 'running':
			return 'running';
		case 'success':
			return 'done';
		case 'failed':
		case 'cancelled':
		case 'banned':
		case 'expired':
		case 'unknown':
			return 'failed';
		default:
			return 'queued';
	}
}

// .jpg / .jpeg / .png — Tripo's image_to_model `file` needs an explicit type.
function imageTypeFor(url) {
	const m = /\.(jpe?g|png|webp)(\?|$)/i.exec(url || '');
	const ext = m ? m[1].toLowerCase() : 'jpg';
	return ext === 'jpeg' ? 'jpg' : ext;
}

// Parse a data:image/...;base64,... URI into its raw bytes, mime, and the file
// extension Tripo expects. Returns null for anything that isn't a base64 image
// data URI (e.g. a plain http(s) URL), so callers can branch on it.
function parseImageDataUri(s) {
	const m = /^data:(image\/(?:png|jpe?g|webp));base64,(.+)$/is.exec(String(s || ''));
	if (!m) return null;
	const mime = m[1].toLowerCase();
	const ext = mime === 'image/png' ? 'png' : mime === 'image/webp' ? 'webp' : 'jpg';
	let bytes;
	try {
		bytes = Buffer.from(m[2], 'base64');
	} catch {
		return null;
	}
	if (!bytes.length) return null;
	return { bytes, mime, ext };
}

export function createTripoProvider(apiKey) {
	if (!apiKey) {
		throw Object.assign(new Error('Tripo API key is required'), { code: 'missing_key' });
	}
	const headers = {
		authorization: `Bearer ${apiKey}`,
		'content-type': 'application/json',
	};

	async function createTask(body) {
		let res;
		try {
			res = await fetchUpstream(`${TRIPO_BASE}/task`, {
				method: 'POST',
				headers,
				body: JSON.stringify(body),
			}, { name: 'tripo', timeoutMs: 30_000, attempts: 2, okWhen: () => true });
		} catch (err) {
			throw Object.assign(new Error(`tripo unreachable: ${err?.message}`), {
				code: 'provider_unreachable',
				status: 502,
			});
		}
		const data = await res.json().catch(() => ({}));
		if (res.status === 401 || res.status === 403) {
			throw Object.assign(new Error('Tripo rejected the API key.'), {
				code: 'invalid_key',
				status: 401,
				providerStatus: res.status,
			});
		}
		if (res.status === 402 || data?.code === 2000) {
			throw Object.assign(new Error('Tripo account is out of credits.'), {
				code: 'insufficient_credits',
				status: 402,
			});
		}
		if (res.status === 429) {
			throw Object.assign(new Error('Tripo is rate limiting this key.'), {
				code: 'rate_limited',
				status: 429,
				providerStatus: 429,
			});
		}
		// Tripo signals success with code 0; anything else is an error envelope.
		if (!res.ok || data?.code !== 0) {
			throw Object.assign(
				new Error(data?.message || `tripo returned ${res.status} (code ${data?.code})`),
				{ code: 'provider_error', status: 502, providerStatus: res.status },
			);
		}
		const taskId = data?.data?.task_id;
		if (!taskId) {
			throw Object.assign(new Error('tripo accepted the task but returned no task_id'), {
				code: 'provider_error',
				status: 502,
			});
		}
		return String(taskId);
	}

	// Tripo's image_to_model `file` accepts a public http(s) `url` or an uploaded
	// `file_token` — never an inline data: URI. Selfies arrive as base64 data
	// URIs, so push the raw bytes through Tripo's multipart /upload endpoint and
	// hand the task the returned token. Mirrors createTask's error classification
	// so a bad key / no credits / throttle surfaces the same actionable code.
	async function uploadImage({ bytes, mime, ext }) {
		const form = new FormData();
		form.append('file', new Blob([bytes], { type: mime }), `selfie.${ext}`);
		let res;
		try {
			// Let fetch set the multipart content-type (with boundary) itself — only
			// forward the bearer, never the JSON content-type from `headers`.
			res = await fetchUpstream(`${TRIPO_BASE}/upload`, {
				method: 'POST',
				headers: { authorization: headers.authorization },
				body: form,
			}, { name: 'tripo', timeoutMs: 60_000, attempts: 2, okWhen: () => true });
		} catch (err) {
			throw Object.assign(new Error(`tripo upload unreachable: ${err?.message}`), {
				code: 'provider_unreachable',
				status: 502,
			});
		}
		const data = await res.json().catch(() => ({}));
		if (res.status === 401 || res.status === 403) {
			throw Object.assign(new Error('Tripo rejected the API key.'), {
				code: 'invalid_key',
				status: 401,
				providerStatus: res.status,
			});
		}
		if (res.status === 402 || data?.code === 2000) {
			throw Object.assign(new Error('Tripo account is out of credits.'), {
				code: 'insufficient_credits',
				status: 402,
			});
		}
		if (res.status === 429) {
			throw Object.assign(new Error('Tripo is rate limiting this key.'), {
				code: 'rate_limited',
				status: 429,
				providerStatus: 429,
			});
		}
		if (!res.ok || data?.code !== 0) {
			throw Object.assign(
				new Error(data?.message || `tripo upload returned ${res.status} (code ${data?.code})`),
				{ code: 'provider_error', status: 502, providerStatus: res.status },
			);
		}
		// Upload returns the handle as image_token; older responses use file_token.
		const token = data?.data?.image_token || data?.data?.file_token;
		if (!token) {
			throw Object.assign(new Error('tripo upload returned no image token'), {
				code: 'provider_error',
				status: 502,
			});
		}
		return String(token);
	}

	return {
		async textToGeometry({ prompt, tier }) {
			const taskId = await createTask({
				type: 'text_to_model',
				prompt: String(prompt).slice(0, 1024),
				model_version: modelVersion(),
				face_limit: clampFaces(tier.polycount),
				texture: false,
				pbr: false,
			});
			return { kind: 'task', taskId };
		},

		async imageTo3d({ imageUrl, tier }) {
			// Data URI (selfie) → upload first and reference the token; a real
			// http(s) URL passes straight through as `file.url`.
			const parsed = parseImageDataUri(imageUrl);
			const file = parsed
				? { type: parsed.ext, file_token: await uploadImage(parsed) }
				: { type: imageTypeFor(imageUrl), url: imageUrl };
			const taskId = await createTask({
				type: 'image_to_model',
				file,
				model_version: modelVersion(),
				face_limit: clampFaces(tier.polycount),
				texture: true,
				pbr: Boolean(tier.pbr),
			});
			return { kind: 'task', taskId };
		},

		// One status endpoint for every task type.
		async status({ taskId }) {
			let res;
			try {
				res = await fetchUpstream(`${TRIPO_BASE}/task/${encodeURIComponent(taskId)}`, { headers }, { name: 'tripo', timeoutMs: 15_000, attempts: 2, okWhen: () => true });
			} catch (err) {
				return { status: 'running', error: `tripo poll failed: ${err?.message}` };
			}
			const data = await res.json().catch(() => ({}));
			if (res.status === 404) return { status: 'failed', error: 'tripo task not found' };
			if (!res.ok || data?.code !== 0) {
				return { status: 'running', error: `tripo returned ${res.status}` };
			}

			const d = data.data || {};
			const status = mapStatus(d.status);
			const result = { status, progress: Number(d.progress) || 0 };

			if (status === 'done') {
				const out = d.output || d.result || {};
				const glb = out.pbr_model || out.model || out.base_model;
				if (glb) result.resultGlbUrl = glb;
				else result.error = 'tripo finished but produced no model url';
			}
			if (status === 'failed') {
				result.error = `tripo task ${d.status || 'failed'}`;
			}
			return result;
		},
	};
}
