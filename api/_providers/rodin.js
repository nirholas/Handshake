// Rodin (Hyper3D) provider — native geometry-first + image→3D backend with
// quad topology and a real poly-count target. A BYOK alternative to Meshy/Tripo.
//
// Three real Rodin Gen-2 endpoints back the forge paths:
//
//   geometry path → POST /api/v2/rodin { tier:"Gen-2", prompt, mesh_mode:"Quad" }
//       Native text→geometry: emits an untextured quad mesh directly from the
//       prompt. `quality_override` carries the tier's poly budget.
//
//   image path    → POST /api/v2/rodin { tier:"Gen-2", images:<file>, prompt? }
//       Single-image reconstruction with PBR texturing + quad topology.
//
// Submit is multipart/form-data and returns a top-level task `uuid` (used to
// download results) plus `jobs.subscription_key` (used to poll status). Both
// ids are needed later, so the forge job handle carries the subscription key in
// `kind` and the download uuid in `taskId`. Status is polled on /api/v2/status;
// when Done, the GLB url is fetched from /api/v2/download.
//
// BYOK only: the caller supplies their own Rodin key. No platform key — when
// absent, the forge endpoint never reaches this module.

import { fetchUpstream } from '../_lib/upstream-fetch.js';

const RODIN_BASE = 'https://api.hyper3d.com/api/v2';

// Quad mode accepts 1,000–200,000 for the poly target; clamp the tier budget
// into that window so a request never 4xxs on an out-of-range count.
const POLY_MIN = 1_000;
const POLY_MAX = 200_000;

function clampPoly(n) {
	const v = Math.round(Number(n) || 0);
	return Math.max(POLY_MIN, Math.min(POLY_MAX, v));
}

// Map the forge tier to Rodin's named quality rung (quality_override still
// carries the exact poly target; this is the coarse speed/detail knob).
function qualityForTier(tier) {
	switch (tier?.id) {
		case 'draft':
			return 'low';
		case 'high':
			return 'high';
		default:
			return 'medium';
	}
}

function mapStatus(jobs) {
	const statuses = (Array.isArray(jobs) ? jobs : []).map((j) => String(j?.status || ''));
	if (!statuses.length) return 'queued';
	if (statuses.some((s) => s === 'Failed')) return 'failed';
	if (statuses.every((s) => s === 'Done')) return 'done';
	if (statuses.some((s) => s === 'Generating')) return 'running';
	return 'queued';
}

function glbFromList(list) {
	if (!Array.isArray(list)) return null;
	// Prefer an explicit .glb; ignore preview.webp and texture maps.
	const glb = list.find((f) => /\.glb($|\?)/i.test(String(f?.name || f?.url || '')));
	return glb?.url || null;
}

export function createRodinProvider(apiKey) {
	if (!apiKey) {
		throw Object.assign(new Error('Rodin API key is required'), { code: 'missing_key' });
	}
	const authHeader = { authorization: `Bearer ${apiKey}` };

	function normalizeError(res, data) {
		if (res.status === 401 || res.status === 403) {
			return Object.assign(new Error('Rodin rejected the API key.'), {
				code: 'invalid_key',
				status: 401,
				providerStatus: res.status,
			});
		}
		if (res.status === 402) {
			return Object.assign(new Error('Rodin account is out of credits.'), {
				code: 'insufficient_credits',
				status: 402,
				providerStatus: 402,
			});
		}
		if (res.status === 429) {
			return Object.assign(new Error('Rodin is rate limiting this key.'), {
				code: 'rate_limited',
				status: 429,
				providerStatus: 429,
			});
		}
		return Object.assign(
			new Error(data?.error || data?.message || `rodin returned ${res.status}`),
			{ code: 'provider_error', status: 502, providerStatus: res.status },
		);
	}

	async function submit(form) {
		let res;
		try {
			res = await fetchUpstream(`${RODIN_BASE}/rodin`, { method: 'POST', headers: authHeader, body: form }, { name: 'rodin', timeoutMs: 60_000, attempts: 2, okWhen: () => true });
		} catch (err) {
			throw Object.assign(new Error(`rodin unreachable: ${err?.message}`), {
				code: 'provider_unreachable',
				status: 502,
			});
		}
		const data = await res.json().catch(() => ({}));
		if (!res.ok || data?.error) throw normalizeError(res, data);
		const uuid = data?.uuid;
		const subscriptionKey = data?.jobs?.subscription_key;
		if (!uuid || !subscriptionKey) {
			throw Object.assign(new Error('rodin accepted the task but returned no uuid/subscription_key'), {
				code: 'provider_error',
				status: 502,
			});
		}
		// kind carries the poll key; taskId carries the download uuid.
		return { kind: String(subscriptionKey), taskId: String(uuid) };
	}

	return {
		// Native geometry-first: text → untextured quad mesh, no intermediate image.
		async textToGeometry({ prompt, tier }) {
			const form = new FormData();
			form.set('tier', 'Gen-2');
			form.set('prompt', String(prompt).slice(0, 1024));
			form.set('mesh_mode', 'Quad');
			form.set('material', 'None');
			form.set('quality', qualityForTier(tier));
			form.set('quality_override', String(clampPoly(tier.polycount)));
			form.set('geometry_file_format', 'glb');
			return submit(form);
		},

		// Single image → native geometry + PBR textures, poly target from the tier.
		async imageTo3d({ imageUrl, prompt, tier }) {
			let imgRes;
			try {
				imgRes = await fetchUpstream(imageUrl, {}, { timeoutMs: 20_000, attempts: 2, okWhen: () => true });
			} catch (err) {
				throw Object.assign(new Error(`could not fetch reference image: ${err?.message}`), {
					code: 'bad_image',
					status: 400,
				});
			}
			if (!imgRes.ok) {
				throw Object.assign(new Error(`reference image fetch returned ${imgRes.status}`), {
					code: 'bad_image',
					status: 400,
				});
			}
			const blob = await imgRes.blob();
			const form = new FormData();
			form.set('tier', 'Gen-2');
			form.append('images', blob, 'reference.png');
			if (prompt) form.set('prompt', String(prompt).slice(0, 1024));
			form.set('mesh_mode', 'Quad');
			form.set('material', tier.pbr ? 'PBR' : 'Shaded');
			form.set('quality', qualityForTier(tier));
			form.set('quality_override', String(clampPoly(tier.polycount)));
			form.set('geometry_file_format', 'glb');
			return submit(form);
		},

		// Poll on /status with the subscription key (carried in `kind`); when Done,
		// resolve the GLB url from /download using the task uuid (carried in `taskId`).
		async status({ kind, taskId }) {
			let res;
			try {
				res = await fetchUpstream(`${RODIN_BASE}/status`, {
					method: 'POST',
					headers: { ...authHeader, 'content-type': 'application/json' },
					body: JSON.stringify({ subscription_key: kind }),
				}, { name: 'rodin', timeoutMs: 15_000, attempts: 2, okWhen: () => true });
			} catch (err) {
				return { status: 'running', error: `rodin poll failed: ${err?.message}` };
			}
			const data = await res.json().catch(() => ({}));
			if (res.status === 404) return { status: 'failed', error: 'rodin task not found' };
			if (!res.ok) return { status: 'running', error: `rodin returned ${res.status}` };

			const status = mapStatus(data.jobs);
			const result = { status };
			if (status === 'failed') {
				result.error = data?.error || 'rodin task failed';
				return result;
			}
			if (status !== 'done') return result;

			// Done — fetch the downloadable file list and pull the GLB url.
			let dl;
			try {
				dl = await fetchUpstream(`${RODIN_BASE}/download`, {
					method: 'POST',
					headers: { ...authHeader, 'content-type': 'application/json' },
					body: JSON.stringify({ task_uuid: taskId }),
				}, { name: 'rodin', timeoutMs: 15_000, attempts: 2, okWhen: () => true });
			} catch (err) {
				return { status: 'running', error: `rodin download list failed: ${err?.message}` };
			}
			const dlData = await dl.json().catch(() => ({}));
			if (!dl.ok) return { status: 'running', error: `rodin download returned ${dl.status}` };
			const glb = glbFromList(dlData.list);
			if (glb) result.resultGlbUrl = glb;
			else result.error = 'rodin finished but produced no GLB';
			return result;
		},
	};
}
