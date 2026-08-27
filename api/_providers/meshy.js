// Meshy provider — the geometry-first + high-poly backend.
//
// Two real Meshy endpoints back the two forge paths:
//
//   geometry path → POST /openapi/v2/text-to-3d  (mode: "preview")
//       Native text→geometry: emits an untextured mesh directly from the
//       prompt with no synthesized intermediate image. `target_polycount`
//       (from the quality tier) is honored via server-side remesh, so the
//       high tier yields a visibly denser mesh than draft.
//
//   image path    → POST /openapi/v1/image-to-3d
//       Single-image reconstruction with native geometry + PBR texturing.
//
// Both are asynchronous: submit returns a task id, which we poll on the
// matching GET endpoint until SUCCEEDED, then read model_urls.glb.
//
// BYOK only: the caller passes the user's Meshy API key (msy_…). No platform
// key — when absent, the forge endpoint never reaches this module.

import { fetchUpstream } from '../_lib/upstream-fetch.js';

const MESHY_BASE = 'https://api.meshy.ai';

// Meshy accepts 100–300,000 for target_polycount. Clamp the tier budget into
// that window so a high-tier request never 422s on an out-of-range count.
const POLY_MIN = 100;
const POLY_MAX = 300_000;

function clampPoly(n) {
	const v = Math.round(Number(n) || 0);
	return Math.max(POLY_MIN, Math.min(POLY_MAX, v));
}

function mapStatus(meshyStatus) {
	switch (meshyStatus) {
		case 'PENDING':
			return 'queued';
		case 'IN_PROGRESS':
			return 'running';
		case 'SUCCEEDED':
			return 'done';
		case 'FAILED':
		case 'CANCELED':
			return 'failed';
		default:
			return 'queued';
	}
}

// The two Meshy task families live on different API versions; poll routes here.
const ENDPOINT = Object.freeze({
	'text-to-3d': '/openapi/v2/text-to-3d',
	'image-to-3d': '/openapi/v1/image-to-3d',
});

export function createMeshyProvider(apiKey) {
	if (!apiKey) {
		throw Object.assign(new Error('Meshy API key is required'), { code: 'missing_key' });
	}
	const headers = {
		authorization: `Bearer ${apiKey}`,
		'content-type': 'application/json',
	};

	async function postTask(path, body) {
		let res;
		try {
			res = await fetchUpstream(`${MESHY_BASE}${path}`, {
				method: 'POST',
				headers,
				body: JSON.stringify(body),
			}, { name: 'meshy', timeoutMs: 30_000, attempts: 2, okWhen: () => true });
		} catch (err) {
			throw Object.assign(new Error(`meshy unreachable: ${err?.message}`), {
				code: 'provider_unreachable',
				status: 502,
			});
		}
		const data = await res.json().catch(() => ({}));
		if (res.status === 401 || res.status === 403) {
			throw Object.assign(new Error('Meshy rejected the API key.'), {
				code: 'invalid_key',
				status: 401,
				providerStatus: res.status,
			});
		}
		if (res.status === 402) {
			throw Object.assign(new Error('Meshy account is out of credits.'), {
				code: 'insufficient_credits',
				status: 402,
				providerStatus: 402,
			});
		}
		if (res.status === 429) {
			throw Object.assign(new Error('Meshy is rate limiting this key.'), {
				code: 'rate_limited',
				status: 429,
				providerStatus: 429,
			});
		}
		if (!res.ok) {
			throw Object.assign(
				new Error(data?.message || data?.error || `meshy returned ${res.status}`),
				{ code: 'provider_error', status: 502, providerStatus: res.status },
			);
		}
		// v2 returns { result: "<id>" }; some endpoints return { id }.
		const id = data.result || data.id;
		if (!id) {
			throw Object.assign(new Error('meshy accepted the task but returned no id'), {
				code: 'provider_error',
				status: 502,
			});
		}
		return String(id);
	}

	return {
		// Native geometry-first: text → untextured mesh, no intermediate image.
		async textToGeometry({ prompt, tier }) {
			const taskId = await postTask(ENDPOINT['text-to-3d'], {
				mode: 'preview',
				prompt: String(prompt).slice(0, 600),
				ai_model: 'meshy-6',
				topology: 'triangle',
				target_polycount: clampPoly(tier.polycount),
				should_remesh: true,
				target_formats: ['glb'],
			});
			return { kind: 'text-to-3d', taskId };
		},

		// Single image → native geometry + textures, poly target from the tier.
		async imageTo3d({ imageUrl, prompt, tier }) {
			const body = {
				image_url: imageUrl,
				ai_model: 'meshy-6',
				topology: 'triangle',
				target_polycount: clampPoly(tier.polycount),
				should_remesh: true,
				should_texture: true,
				enable_pbr: Boolean(tier.pbr),
				hd_texture: Boolean(tier.hd),
				target_formats: ['glb'],
			};
			if (prompt) body.texture_prompt = String(prompt).slice(0, 600);
			const taskId = await postTask(ENDPOINT['image-to-3d'], body);
			return { kind: 'image-to-3d', taskId };
		},

		// Poll a task on the endpoint matching its kind.
		async status({ kind, taskId }) {
			const base = ENDPOINT[kind];
			if (!base) return { status: 'failed', error: `unknown meshy task kind "${kind}"` };
			let res;
			try {
				res = await fetchUpstream(`${MESHY_BASE}${base}/${encodeURIComponent(taskId)}`, { headers }, { name: 'meshy', timeoutMs: 15_000, attempts: 2, okWhen: () => true });
			} catch (err) {
				return { status: 'running', error: `meshy poll failed: ${err?.message}` };
			}
			const data = await res.json().catch(() => ({}));
			if (res.status === 404) return { status: 'failed', error: 'meshy task not found' };
			if (!res.ok) return { status: 'running', error: `meshy returned ${res.status}` };

			const status = mapStatus(data.status);
			const result = { status, progress: Number(data.progress) || 0 };
			if (typeof data.consumed_credits === 'number') result.credits = data.consumed_credits;

			if (status === 'done') {
				const glb = data?.model_urls?.glb;
				if (glb) result.resultGlbUrl = glb;
				else result.error = 'meshy finished but produced no GLB';
			}
			if (status === 'failed') {
				result.error = data?.task_error?.message || data?.task_error || 'meshy task failed';
			}
			return result;
		},
	};
}
