// Isolated NIM TRELLIS demo endpoint — talks DIRECTLY to a self-hosted Microsoft
// TRELLIS NIM (nvcr.io/nim/microsoft/trellis, large:image) at /v1/infer, which
// accepts REAL user images and returns the GLB synchronously as
// { artifacts:[{ base64 }] }. This is fully standalone: it shares NO routing,
// state, or env with the production /forge pipeline, so the live demo can never
// affect production. The NIM URL + optional bearer live server-side and are never
// exposed to the browser.
//
//   GET  /api/nim-forge             → { configured } readiness (no secrets leaked)
//   POST /api/nim-forge { image }   → { glb_base64, bytes, ms } (image→3D)
//   POST /api/nim-forge { prompt }  → { glb_base64, bytes, ms } (text→3D)
//
// The hosted NVIDIA preview rejects real images (only its 4 sample example_ids,
// verified live) — so this demo only works against a self-hosted NIM. Point
// NIM_TRELLIS_URL at it.

import { wrap, cors, json, method, readJson, rateLimited } from './_lib/http.js';
import { limits, clientIp } from './_lib/rate-limit.js';

// NIM_TRELLIS_URL only. MODEL_TRELLIS_URL points at our own Cloud Run TRELLIS
// worker (workers/model-trellis/), whose async `/infer` + `/tasks/{id}` API is
// not the NIM contract, so falling back to it reported the demo as configured
// and then 404'd every generation.
const NIM_URL = process.env.NIM_TRELLIS_URL || '';
const NIM_KEY = process.env.NIM_TRELLIS_KEY || process.env.NVIDIA_API_KEY || '';

// A self-host NIM reconstructs in ~15–45 s on an L4; give the synchronous call
// generous headroom under the function's max duration.
const INFER_TIMEOUT_MS = 110_000;

// TRELLIS accepts 10–50 sampling steps. A self-hosted NIM serves the full window
// (unlike the hosted preview, which only completes at the low end), so the tiers
// scale real fidelity here.
function stepsForTier(tier) {
	switch (tier) {
		case 'high':
			return 50;
		case 'standard':
			return 25;
		case 'draft':
		default:
			return 15;
	}
}

// Normalize every GLB artifact shape a TRELLIS NIM can return into raw bytes:
// { artifacts:[{base64}] } (documented), { data }, a bare base64 string, a CDN
// { url } (fetched here), an object with numeric-string keys, or raw model bytes
// when the gateway ignores Accept.
async function extractGlb(res) {
	const ct = (res.headers.get('content-type') || '').toLowerCase();
	if (ct.includes('json')) {
		const data = await res.json().catch(() => null);
		const a0 = data?.artifacts?.[0];
		if (typeof a0 === 'string' && a0 && !a0.startsWith('http')) return Buffer.from(a0, 'base64');
		const inline = a0?.base64 ?? a0?.data ?? (typeof data?.output === 'string' ? data.output : null);
		if (typeof inline === 'string' && inline && !inline.startsWith('http')) return Buffer.from(inline, 'base64');
		const url = a0?.url ?? (typeof inline === 'string' && inline.startsWith('http') ? inline : null);
		if (url) {
			const r = await fetch(url, { signal: AbortSignal.timeout(INFER_TIMEOUT_MS) });
			if (r.ok) return Buffer.from(await r.arrayBuffer());
			throw Object.assign(new Error(`artifact url fetch ${r.status}`), { status: 502 });
		}
		const arts = data?.artifacts;
		if (arts && typeof arts === 'object' && !Array.isArray(arts)) {
			const v = arts['0'] ?? Object.values(arts)[0];
			const b64 = v?.base64 ?? (typeof v === 'string' && !v.startsWith('http') ? v : null);
			if (b64) return Buffer.from(b64, 'base64');
		}
		throw Object.assign(
			new Error(`no GLB in response: keys=${JSON.stringify(Object.keys(data || {}))}`),
			{ status: 502 },
		);
	}
	if (ct.includes('gltf') || ct.includes('octet-stream') || ct.startsWith('model/') || ct.includes('binary')) {
		return Buffer.from(await res.arrayBuffer());
	}
	const t = await res.text().catch(() => '');
	throw Object.assign(new Error(`unexpected content-type ${ct || 'none'}: ${t.slice(0, 160)}`), { status: 502 });
}

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,POST,OPTIONS' })) return;

	// Readiness probe — the page calls this on load to show a configured/offline
	// badge. Never reveals the URL or key.
	if (req.method === 'GET') {
		return json(res, 200, { configured: Boolean(NIM_URL), endpoint: '/v1/infer' });
	}
	if (!method(req, res, ['GET', 'POST'])) return;

	// Public endpoint that drives a real self-hosted GPU TRELLIS inference per call,
	// so meter per IP before touching the upstream — otherwise an anonymous caller
	// can spam reconstructions against the platform's NIM/key. Mirrors the sibling
	// /api/forge-nim limiter (limits.forgeNim, 30/hr/IP).
	const rl = await limits.forgeNim(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	if (!NIM_URL) {
		return json(res, 503, {
			error: 'unconfigured',
			message:
				'Self-hosted TRELLIS NIM is not configured. Set NIM_TRELLIS_URL to your NIM base URL.',
		});
	}

	// Up to ~12 MB so a base64 image comfortably fits; the page downscales before
	// upload, so real payloads are far smaller.
	const body = await readJson(req, 12_000_000).catch(() => null);
	if (!body) return json(res, 400, { error: 'bad_request', message: 'JSON body required.' });

	const image = typeof body.image === 'string' ? body.image.trim() : '';
	const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
	const tier = typeof body.tier === 'string' ? body.tier : 'standard';
	const seed = Number.isInteger(body.seed) ? body.seed : 0;
	const steps = stepsForTier(tier);

	if (!image && !prompt) {
		return json(res, 400, { error: 'bad_request', message: 'Provide an image (data-uri) or a prompt.' });
	}
	if (image && !/^data:image\/[a-z0-9.+-]+;base64,/i.test(image)) {
		return json(res, 400, { error: 'bad_image', message: 'image must be a base64 data-uri.' });
	}

	// slat_cfg_scale governs how strictly the structured-latent diffusion adheres
	// to the input. TRELLIS defaults to 3.0, which makes reconstructions look
	// smooth and cartoonish (the model invents toy-like detail). Raising it to 5.0
	// keeps the output faithful to the real texture/shape in the source photo.
	const SLAT_CFG = 5.0;
	const SS_CFG = 7.5;
	const payload = image
		? { mode: 'image', image, ss_sampling_steps: steps, slat_sampling_steps: steps, ss_cfg_scale: SS_CFG, slat_cfg_scale: SLAT_CFG, output_format: 'glb', seed }
		: { mode: 'text', prompt, ss_sampling_steps: steps, slat_sampling_steps: steps, ss_cfg_scale: SS_CFG, slat_cfg_scale: SLAT_CFG, output_format: 'glb', seed };

	const url = `${NIM_URL.replace(/\/$/, '')}/v1/infer`;
	const headers = { 'content-type': 'application/json', accept: 'application/json' };
	if (NIM_KEY) headers.authorization = `Bearer ${NIM_KEY}`;

	const t0 = Date.now();
	let upstream;
	try {
		upstream = await fetch(url, {
			method: 'POST',
			headers,
			body: JSON.stringify(payload),
			signal: AbortSignal.timeout(INFER_TIMEOUT_MS),
		});
	} catch (err) {
		return json(res, 502, { error: 'nim_unreachable', message: `Could not reach the NIM: ${err?.message || err}` });
	}

	if (!upstream.ok) {
		let detail = '';
		try {
			const d = await upstream.json();
			detail = d?.detail || d?.message || d;
		} catch {
			detail = (await upstream.text().catch(() => '')).slice(0, 300);
		}
		if (detail && typeof detail !== 'string') detail = JSON.stringify(detail);
		return json(res, 502, {
			error: 'nim_error',
			upstream_status: upstream.status,
			message: detail || `NIM returned ${upstream.status}`,
		});
	}

	let glb;
	try {
		glb = await extractGlb(upstream);
	} catch (err) {
		return json(res, err.status || 502, { error: 'nim_no_glb', message: err.message });
	}
	if (!glb?.length) return json(res, 502, { error: 'nim_no_glb', message: 'NIM returned an empty model.' });

	return json(res, 200, {
		glb_base64: glb.toString('base64'),
		bytes: glb.length,
		ms: Date.now() - t0,
		mode: image ? 'image_to_3d' : 'text_to_3d',
		steps,
	});
});

// Self-host reconstruction is synchronous and can run tens of seconds; give the
// function room beyond the default so a real generation completes inline.
export const config = { maxDuration: 300 };
