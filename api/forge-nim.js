// POST /api/forge-nim — drive a SELF-HOSTED TRELLIS NIM directly.
//
// The demo page (/forge-nim) showcases the one contract a self-hosted NIM
// (nvcr.io/nim/microsoft/trellis, large:image) actually exposes:
//
//     POST {baseUrl}/v1/infer
//          { mode:"image"|"text", image|prompt, ss_sampling_steps,
//            slat_sampling_steps, output_format:"glb", seed? }
//     200  { artifacts: [ { base64 } ] }      ← GLB returned SYNCHRONOUSLY
//
// Unlike NVIDIA's hosted NVCF preview (text-only, async poll, rejects real
// photos), a self-host NIM reconstructs a textured GLB from a real reference
// image in a single hop and inlines it as base64. This endpoint is a thin,
// honest proxy: browsers can't POST cross-origin to a private NIM (CORS + the
// container's plain-HTTP API), so we forward server-side, normalize every
// documented artifact shape to base64, and hand the bytes straight back. The
// page decodes that base64 into a Blob and renders it — so the NIM's wire
// contract is visible end-to-end, no R2 round-trip, no mocks.
//
//   GET  /api/forge-nim?action=health → { configured, reachable, baseUrl }
//
// The NIM URL comes from NIM_TRELLIS_URL; a request may override it (handy for
// pointing the demo at your own box), but the override is SSRF-guarded — only
// https hosts that don't resolve to private/loopback/link-local/metadata space,
// so this can never be turned into an internal-network probe.

import { cors, method, wrap, error, readJson, json } from './_lib/http.js';
import { limits, clientIp } from './_lib/rate-limit.js';
import { env } from './_lib/env.js';
import { fetchSafePublicUrl, SsrfBlockedError } from './_lib/ssrf-guard.js';

const INFER_PATH = '/v1/infer';
const READY_PATH = '/v1/health/ready'; // NIM containers expose this by convention
const SUBMIT_TIMEOUT_MS = 120_000; // a cold large:image NIM can take a while on the first hit
const HEALTH_TIMEOUT_MS = 5_000;
const PROMPT_MAX = 77; // TRELLIS truncates beyond this; match the provider
const STYLE_SUFFIX = ', studio lighting';
const STYLE_WORDS = ['studio', 'light', 'bright', 'backlit', 'colorful', 'vibrant', 'cartoon', 'stylized'];
const MAX_IMAGE_BYTES = 10 * 1024 * 1024; // 10 MB decoded reference image ceiling
const MAX_BODY_BYTES = 16 * 1024 * 1024; // base64 inflates ~33%, plus JSON envelope

function trellisSteps(tier) {
	return tier === 'high' ? { ss: 50, slat: 50 } : { ss: 15, slat: 15 };
}

// CFG scales control how strictly diffusion adheres to the input. TRELLIS defaults
// slat_cfg_scale to 3.0, which yields smooth, cartoonish reconstructions; 5.0 keeps
// the output faithful to the real texture/shape of the source photo. ss_cfg_scale
// stays at the tuned 7.5 default.
const SS_CFG = 7.5;
const SLAT_CFG = 5.0;

// Mirror the provider's prompt shaping so text-mode results look the same as the
// production forge lane: keep an already-styled prompt, else append a lighting
// cue, always inside TRELLIS's 77-char window.
function shapePrompt(raw) {
	const text = String(raw || '').trim();
	if (!text) return '';
	const lower = text.toLowerCase();
	if (STYLE_WORDS.some((w) => lower.includes(w))) return text.slice(0, PROMPT_MAX);
	return (text.slice(0, PROMPT_MAX - STYLE_SUFFIX.length) + STYLE_SUFFIX).slice(0, PROMPT_MAX);
}

// Block override URLs that point anywhere we don't host the NIM. Only https,
// never an IP literal in private/loopback/link-local space, never the cloud
// metadata host. The env-configured URL is exempt (it's operator-trusted and may
// legitimately be an internal address reachable only from the function).
function assertSafeBaseUrl(raw) {
	let u;
	try {
		u = new URL(raw);
	} catch {
		throw Object.assign(new Error('baseUrl must be a valid URL'), { status: 400, code: 'bad_base_url' });
	}
	if (u.protocol !== 'https:') {
		throw Object.assign(new Error('baseUrl must use https'), { status: 400, code: 'bad_base_url' });
	}
	const host = u.hostname.toLowerCase();
	const blockedHost =
		host === 'localhost' ||
		host === '0.0.0.0' ||
		host === 'metadata.google.internal' ||
		host.endsWith('.local') ||
		host.endsWith('.internal');
	if (blockedHost) {
		throw Object.assign(new Error('baseUrl host is not allowed'), { status: 400, code: 'bad_base_url' });
	}
	// IPv4 literal → reject private/loopback/link-local/CGNAT ranges.
	const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
	if (m) {
		const [a, b] = [Number(m[1]), Number(m[2])];
		const isPrivate =
			a === 10 ||
			a === 127 ||
			(a === 169 && b === 254) ||
			(a === 172 && b >= 16 && b <= 31) ||
			(a === 192 && b === 168) ||
			(a === 100 && b >= 64 && b <= 127) ||
			a === 0;
		if (isPrivate) {
			throw Object.assign(new Error('baseUrl host is not allowed'), { status: 400, code: 'bad_base_url' });
		}
	}
	// Bare IPv6 literal — refuse; we can't cheaply classify every reserved range.
	if (host.includes(':')) {
		throw Object.assign(new Error('baseUrl host is not allowed'), { status: 400, code: 'bad_base_url' });
	}
	return u.origin;
}

// Resolve the NIM origin for this request. A caller-supplied baseUrl is SSRF
// guarded; absent that, fall back to the operator-configured NIM_TRELLIS_URL.
//
// This deliberately does NOT read MODEL_TRELLIS_URL. That variable is the
// platform-wide pointer to our own Cloud Run TRELLIS worker
// (workers/model-trellis/), which speaks a different contract: an async
// `/infer` + `/tasks/{id}` API, not the NIM's synchronous `/v1/infer`. Reading
// it here made health report a configured, unreachable NIM and turned every
// generation into a 404 against a service that was never a NIM.
function configuredNimUrl() {
	return env.NIM_TRELLIS_URL || process.env.NIM_TRELLIS_URL || '';
}

function resolveBaseUrl(requested) {
	if (requested) return assertSafeBaseUrl(requested);
	const configured = configuredNimUrl();
	if (!configured) {
		throw Object.assign(
			new Error(
				'No self-hosted TRELLIS NIM is configured. Set NIM_TRELLIS_URL on the deployment, or pass a baseUrl pointing at your own NIM (nvcr.io/nim/microsoft/trellis).',
			),
			// expose: this is a documented contract error, not a leaked runtime code,
			// so wrap() may hand the caller the real reason instead of internal_error.
			{ status: 503, code: 'nim_unconfigured', expose: true },
		);
	}
	return configured.replace(/\/$/, '');
}

// Pull a real reference image into a data-uri the NIM accepts. Accept a data-uri
// the page already built (the common path — the dropzone reads the File locally),
// or fetch an http(s) URL. Bound the size so a huge upload can't blow the body.
async function toImageDataUri(image) {
	if (typeof image !== 'string' || !image) {
		throw Object.assign(new Error('image is required for image mode'), { status: 400, code: 'no_image' });
	}
	if (image.startsWith('data:')) {
		const comma = image.indexOf(',');
		const b64 = comma >= 0 ? image.slice(comma + 1) : '';
		if (Buffer.byteLength(b64, 'utf8') * 0.75 > MAX_IMAGE_BYTES) {
			throw Object.assign(new Error('reference image exceeds 10 MB'), { status: 413, code: 'image_too_large' });
		}
		return image;
	}
	if (/^https?:\/\//i.test(image)) {
		// SSRF guard: this is an unauthenticated, public endpoint and the fetched
		// bytes are forwarded to the NIM. Route through the SSRF guard so a caller
		// can't point `image` at cloud-metadata (169.254.169.254), loopback, or any
		// RFC1918 host — each redirect hop is re-validated and http:// is rejected.
		let res;
		try {
			res = await fetchSafePublicUrl(image, { signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS * 3) });
		} catch (err) {
			if (err instanceof SsrfBlockedError) {
				throw Object.assign(new Error('reference image URL is not allowed (must be a public https URL)'), {
					status: 400,
					code: 'bad_image_url',
				});
			}
			throw Object.assign(new Error('could not fetch reference image'), { status: 502, code: 'image_fetch_failed' });
		}
		if (!res.ok) {
			throw Object.assign(new Error(`could not fetch reference image (${res.status})`), {
				status: 502,
				code: 'image_fetch_failed',
			});
		}
		const ct = (res.headers.get('content-type') || 'image/png').split(';')[0].trim() || 'image/png';
		const buf = Buffer.from(await res.arrayBuffer());
		if (buf.length > MAX_IMAGE_BYTES) {
			throw Object.assign(new Error('reference image exceeds 10 MB'), { status: 413, code: 'image_too_large' });
		}
		return `data:${ct};base64,${buf.toString('base64')}`;
	}
	throw Object.assign(new Error('image must be a data: or http(s) URL'), { status: 400, code: 'bad_image' });
}

// Normalize every documented TRELLIS artifact shape to base64 GLB bytes. The
// canonical shape is { artifacts:[{ base64 }] }, but a NIM may inline under
// `data`, return a bare base64 string, serve the GLB from a URL artifact, or
// stream the raw bytes directly. Accept them all so the demo works against
// whatever build is deployed. Returns a Buffer or throws a clean boundary error.
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
			// Defense in depth: the NIM-supplied artifact URL is also SSRF-guarded so a
			// (possibly caller-pointed) NIM can't redirect the second hop at an internal host.
			let r;
			try {
				r = await fetchSafePublicUrl(url, { signal: AbortSignal.timeout(SUBMIT_TIMEOUT_MS) });
			} catch (err) {
				if (err instanceof SsrfBlockedError) {
					throw Object.assign(new Error('artifact url is not allowed'), { status: 502, code: 'nim_bad_artifact' });
				}
				throw err;
			}
			if (r.ok) return Buffer.from(await r.arrayBuffer());
			throw Object.assign(new Error(`artifact url fetch ${r.status}`), { status: 502, code: 'nim_bad_artifact' });
		}
		// Object with numeric-string keys: { artifacts: { "0": {…} } }
		const arts = data?.artifacts;
		if (arts && typeof arts === 'object' && !Array.isArray(arts)) {
			const v = arts['0'] ?? Object.values(arts)[0];
			const b64 = v?.base64 ?? (typeof v === 'string' && !v.startsWith('http') ? v : null);
			if (b64) return Buffer.from(b64, 'base64');
		}
		throw Object.assign(
			new Error(`NIM returned no GLB artifact (keys: ${JSON.stringify(Object.keys(data || {}))})`),
			{ status: 502, code: 'nim_no_artifact' },
		);
	}
	if (ct.includes('gltf') || ct.includes('octet-stream') || ct.startsWith('model/') || ct.includes('binary')) {
		return Buffer.from(await res.arrayBuffer());
	}
	const snippet = (await res.text().catch(() => '')).slice(0, 160);
	throw Object.assign(new Error(`unexpected content-type from NIM: ${ct} — ${snippet}`), {
		status: 502,
		code: 'nim_bad_response',
	});
}

// GET ?action=health — surface whether a NIM is wired up and reachable so the
// page can show an honest status pill before the user spends a generation.
async function health(req, res) {
	let baseUrl;
	try {
		baseUrl = resolveBaseUrl((new URL(req.url, 'http://x').searchParams.get('baseUrl') || '').trim());
	} catch (err) {
		// `configured` describes the DEPLOYMENT, not the request. A caller-supplied
		// baseUrl that fails the SSRF guard is the caller's mistake and says nothing
		// about whether the operator wired NIM_TRELLIS_URL, so it is answered from
		// the env directly. Reporting configured:false on a rejected override made
		// the page's status pill claim nothing was set up on a wired deployment.
		return json(res, 200, {
			configured: Boolean(configuredNimUrl()),
			reachable: false,
			reason: err.message,
		});
	}
	let reachable = false;
	let detail = null;
	try {
		const key = env.NIM_TRELLIS_KEY || process.env.NIM_TRELLIS_KEY || env.NVIDIA_API_KEY || process.env.NVIDIA_API_KEY;
		const r = await fetch(`${baseUrl}${READY_PATH}`, {
			headers: key ? { authorization: `Bearer ${key}` } : {},
			signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
		});
		reachable = r.ok;
		if (!r.ok) detail = `ready check returned ${r.status}`;
	} catch (err) {
		detail = err?.name === 'TimeoutError' ? 'ready check timed out' : `unreachable: ${err?.message || err}`;
	}
	return json(res, 200, {
		configured: true,
		reachable,
		baseUrl: maskUrl(baseUrl),
		endpoint: `${maskUrl(baseUrl)}${INFER_PATH}`,
		detail,
	});
}

// Show the host but hide any credential/path noise — enough for the operator to
// confirm which box they're hitting without leaking a token in a query string.
function maskUrl(u) {
	try {
		const url = new URL(u);
		return `${url.protocol}//${url.host}`;
	} catch {
		return u;
	}
}

async function infer(req, res) {
	const rl = await limits.forgeNim(clientIp(req));
	if (!rl.success) {
		return error(res, 429, 'rate_limited', 'Too many NIM generations — wait a moment and try again.');
	}

	const body = await readJson(req, MAX_BODY_BYTES);
	const mode = body?.mode === 'text' ? 'text' : 'image';
	const tier = body?.tier === 'high' ? 'high' : 'draft';
	const seed = Number.isInteger(body?.seed) ? body.seed : null;
	const steps = trellisSteps(tier);

	// Cheap, network-free input checks run BEFORE the NIM is resolved: a caller who
	// sent no prompt (or no image) deserves the 400 that names their mistake, not
	// the 503 an unconfigured deployment would otherwise answer first for every
	// request regardless of what was wrong with it.
	const rawPrompt = typeof body?.prompt === 'string' ? body.prompt.trim() : '';
	if (mode === 'text' && rawPrompt.length < 2) {
		return error(res, 400, 'no_prompt', 'Describe the object in a few words first.');
	}
	const rawImage = body?.image || body?.imageUrl;
	if (mode === 'image' && (typeof rawImage !== 'string' || !rawImage)) {
		return error(res, 400, 'no_image', 'image is required for image mode.');
	}

	const baseUrl = resolveBaseUrl(typeof body?.baseUrl === 'string' ? body.baseUrl.trim() : '');

	let payload;
	if (mode === 'text') {
		const prompt = shapePrompt(rawPrompt);
		payload = {
			mode: 'text',
			prompt,
			ss_sampling_steps: steps.ss,
			slat_sampling_steps: steps.slat,
			ss_cfg_scale: SS_CFG,
			slat_cfg_scale: SLAT_CFG,
			output_format: 'glb',
		};
	} else {
		const imageDataUri = await toImageDataUri(rawImage);
		payload = {
			mode: 'image',
			image: imageDataUri,
			ss_sampling_steps: steps.ss,
			slat_sampling_steps: steps.slat,
			ss_cfg_scale: SS_CFG,
			slat_cfg_scale: SLAT_CFG,
			output_format: 'glb',
		};
	}
	if (seed !== null) payload.seed = seed;

	const key = env.NIM_TRELLIS_KEY || process.env.NIM_TRELLIS_KEY || env.NVIDIA_API_KEY || process.env.NVIDIA_API_KEY;
	const t0 = Date.now();
	let upstream;
	try {
		upstream = await fetch(`${baseUrl}${INFER_PATH}`, {
			method: 'POST',
			headers: {
				...(key ? { authorization: `Bearer ${key}` } : {}),
				accept: 'application/json',
				'content-type': 'application/json',
			},
			body: JSON.stringify(payload),
			signal: AbortSignal.timeout(SUBMIT_TIMEOUT_MS),
		});
	} catch (err) {
		const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
		return error(
			res,
			timedOut ? 504 : 502,
			timedOut ? 'nim_timeout' : 'nim_unreachable',
			timedOut
				? 'The NIM did not respond in time — a large:image build can be slow on a cold start. Try again.'
				: `Could not reach the NIM: ${err?.message || err}`,
		);
	}

	if (!upstream.ok) {
		const detail = (await upstream.text().catch(() => '')).slice(0, 300);
		if (upstream.status === 401 || upstream.status === 403) {
			return error(res, 502, 'nim_auth', 'The NIM rejected the request (auth). Check NIM_TRELLIS_KEY / NVIDIA_API_KEY or the gateway.');
		}
		return error(res, 502, 'nim_error', `NIM /v1/infer returned ${upstream.status}${detail ? `: ${detail}` : ''}`);
	}

	let glb;
	try {
		glb = await extractGlb(upstream);
	} catch (err) {
		return error(res, err.status || 502, err.code || 'nim_bad_response', err.message);
	}
	if (!glb || glb.length === 0) {
		return error(res, 502, 'nim_empty', 'The NIM returned an empty GLB.');
	}

	const ms = Date.now() - t0;
	return json(res, 200, {
		ok: true,
		mode,
		tier,
		contract: 'artifacts[0].base64',
		endpoint: `${maskUrl(baseUrl)}${INFER_PATH}`,
		bytes: glb.length,
		ms,
		glb_base64: glb.toString('base64'),
	});
}

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,POST,OPTIONS' })) return;

	const url = new URL(req.url, 'http://x');
	if (req.method === 'GET') {
		if ((url.searchParams.get('action') || '').trim() === 'health') return health(req, res);
		return error(res, 400, 'bad_action', 'Use ?action=health, or POST to generate.');
	}
	if (!method(req, res, ['POST', 'GET'])) return;
	return infer(req, res);
});
