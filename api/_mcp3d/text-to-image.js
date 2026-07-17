// Text → image helper for the 3D Studio MCP.
//
// Provider selection (free lanes first, per platform policy; first that serves wins):
//   1. NVIDIA_API_KEY set       → FLUX.1-schnell on NVIDIA NIM (free, ~1–2s)
//   2. GOOGLE_CLOUD_PROJECT set → Vertex AI Imagen 3 (high quality, free with GCP credits)
//   3. REPLICATE_API_TOKEN set  → flux-schnell via Replicate (paid backstop, $0.003/image)
//
// The image-to-3D backend (TRELLIS / Hunyuan3D / TripoSR) reconstructs a
// textured GLB from the generated image. Both steps share the same call site.
//
//   NVIDIA_API_KEY          — nvapi key from build.nvidia.com (enables the free NIM lane)
//   GOOGLE_CLOUD_PROJECT    — GCP project id (enables Vertex AI Imagen path)
//   VERTEX_IMAGEN_MODEL     — override Imagen model (default: imagen-3.0-generate-001)
//   REPLICATE_API_TOKEN     — paid backstop when the free lanes are absent or down
//   REPLICATE_TXT2IMG_MODEL — optional Replicate model override
//
// NIM lane: black-forest-labs/flux.1-schnell — Apache-2.0, commercial-OK, served
// free on the NVIDIA NIM catalog as base64 JPEG (no poll; returns inline).
// Replicate backstop: black-forest-labs/flux-schnell — same family, $0.003/run.

import { markProviderCooldown, providersInCooldown } from '../_lib/provider-health.js';
import { reserveProviderRateSlot, SCALE_LIMITS } from '../_lib/forge-scale.js';

const REPLICATE_BASE = 'https://api.replicate.com/v1';
const DEFAULT_TXT2IMG_MODEL = 'black-forest-labs/flux-schnell';

// `Prefer: wait` asks Replicate to hold the create request open until the
// prediction finishes, but it only waits ~60s and, under load or with a cold
// model, returns the prediction still `starting`/`processing` and output-less.
// flux-schnell finishes in a few seconds, so we poll the prediction's status
// URL to a terminal state rather than dead-ending the FREE, never-fail text→3D
// lane on a transient "did not complete (status: starting)". Bounded so a truly
// stuck prediction still fails over instead of stalling the serverless budget.
const REPLICATE_POLL_TIMEOUT_MS = 45_000;
const REPLICATE_POLL_INTERVAL_MS = 1_500;
const REPLICATE_TERMINAL_STATUSES = new Set(['succeeded', 'failed', 'canceled']);

// Poll a Replicate prediction's `get` URL until it reaches a terminal state.
// Returns the final prediction object on success; throws on a failed/canceled
// prediction; returns the last seen object (caller surfaces a clear error) when
// the poll budget is exhausted. A transient poll blip is retried within budget,
// never fatal — the prediction keeps running upstream regardless.
async function pollReplicatePrediction(getUrl, token) {
	const deadline = Date.now() + REPLICATE_POLL_TIMEOUT_MS;
	let last = null;
	while (Date.now() < deadline) {
		await sleep(REPLICATE_POLL_INTERVAL_MS);
		let res;
		try {
			res = await fetch(getUrl, {
				headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
				signal: AbortSignal.timeout(15_000),
			});
		} catch {
			continue;
		}
		const data = await res.json().catch(() => ({}));
		if (!res.ok) continue;
		last = data;
		if (data.status === 'succeeded') return data;
		if (data.status === 'failed' || data.status === 'canceled') {
			const reason = data.error ? `: ${String(data.error).slice(0, 160)}` : '';
			throw new Error(`text-to-image ${data.status}${reason}`);
		}
	}
	return last;
}

// Circuit-breaker key + window for the free NIM FLUX synthesis lane. When NVCF
// times out / errors, one slow window otherwise makes every text→image caller
// (forge text→3D, avatar generation, studio) re-pay the full NIM timeout before
// failing over. A short cooldown — recorded on a health failure, checked before
// the lane runs — lets callers skip a degraded NIM lane and go straight to the
// next configured provider; it expires on its own so a recovered lane is retried
// promptly. Best-effort via the shared cache: a miss just means "not cooling".
const NIM_FLUX_COOLDOWN_KEY = 'forge-nim-flux';
const NIM_FLUX_COOLDOWN_SECONDS = 60;

// Whether a thrown nimFluxImage error means the lane itself is degraded (timeout,
// unreachable, throttle, or 5xx) — worth a cooldown — as opposed to a 4xx client
// fault (bad input / key), which a cooldown would wrongly punish a healthy lane for.
function isNimLaneDegraded(err) {
	if (err?.code === 'provider_unreachable' || err?.code === 'rate_limited') return true;
	const status = err?.providerStatus;
	return typeof status === 'number' && status >= 500;
}

// NVIDIA NIM FLUX.1-schnell — synchronous genai invoke (no 202/poll), returns
// { artifacts: [{ base64, finishReason }] }. flux-schnell is the fast 4-step
// distilled model, so a tight per-attempt timeout is safe: a hung free lane must
// hand off to the paid lanes, never stall the whole text→3D pipeline.
const NIM_FLUX_URL = 'https://ai.api.nvidia.com/v1/genai/black-forest-labs/flux.1-schnell';
const NIM_FLUX_MODEL = 'black-forest-labs/flux.1-schnell';
const NIM_TIMEOUT_MS = 60_000;

// NVCF fronts the free NIM lane with a gateway that answers a cold model or a
// momentary capacity/routing blip with a transient 502/503/504 that returns
// FAST (not the slow-job path — that comes back 200/202). The TRELLIS provider
// already retries these once and it measurably keeps the free lane from
// dead-ending straight to the (often equally throttled) paid backstop and
// surfacing to the user as a hard 502; mirror that here. A genuine socket/DNS
// blip (non-timeout network error) gets the same single retry. A real *timeout*
// is deliberately NOT retried: the request already burned the full window, so a
// second attempt would just double the wait before failover (the same reasoning
// that makes the TRELLIS submit timeout terminal). Bounded to one extra attempt
// so a genuinely-down gateway still hands off fast.
const NIM_GATEWAY_RETRY_STATUSES = new Set([502, 503, 504]);
const NIM_MAX_ATTEMPTS = 2;
const NIM_RETRY_DELAY_MS = 1_200;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// FLUX wants explicit pixel dimensions (multiples of 64). Map the caller's
// aspect ratio to a sensible ~1MP size; anything unmapped falls back to square.
const NIM_DIMENSIONS = {
	'1:1': [1024, 1024],
	'16:9': [1344, 768],
	'9:16': [768, 1344],
	'4:3': [1024, 768],
	'3:4': [768, 1024],
	'3:2': [1216, 832],
	'2:3': [832, 1216],
};

function readEnv(name) {
	if (typeof process !== 'undefined' && process.env && process.env[name]) return process.env[name];
	return null;
}

// Explicit on/off gate for the Vertex image lane, independent of
// GOOGLE_CLOUD_PROJECT (which Vertex Claude and the workers also need — too blunt
// to double as this lane's switch). Unset ⇒ today's behavior: the lane is active
// whenever the project is set. Set VERTEX_IMAGEN_ENABLED to 0/false/no/off to
// force the lane off without unsetting the shared GCP project; anything else
// (1/true/…) keeps it on.
function vertexImagenEnabled() {
	const raw = readEnv('VERTEX_IMAGEN_ENABLED');
	if (raw == null) return true; // unset ⇒ preserve current behavior
	return !/^(0|false|no|off)$/i.test(String(raw).trim());
}

// Record which provider actually served an image so spend attribution and
// debugging work (the forge job also persists result.model as text_to_image_model).
function logImageProvider(result) {
	if (result?.model) console.log(`[text-to-image] served by ${result.model}`);
	return result;
}

// Pull the first https image URL out of Replicate's `output`, which flux models
// emit as an array of URLs (sometimes a bare string for single-image models).
function extractImageUrl(output) {
	if (!output) return null;
	if (typeof output === 'string') return /^https?:\/\//.test(output) ? output : null;
	if (Array.isArray(output)) {
		for (const v of output) if (typeof v === 'string' && /^https?:\/\//.test(v)) return v;
	}
	if (typeof output === 'object') {
		for (const k of ['image', 'url', 'output']) {
			if (typeof output[k] === 'string' && /^https?:\/\//.test(output[k])) return output[k];
		}
	}
	return null;
}

// Best-effort retry hint (in seconds) for a throttled request. Prefers the
// standard Retry-After header; falls back to the "resets in ~Ns" phrasing
// Replicate uses in its throttle message. Defaults to a short, sane backoff.
function parseRetryAfter(headers, message) {
	const header = headers?.get?.('retry-after');
	const fromHeader = header ? Number.parseInt(header, 10) : NaN;
	if (Number.isFinite(fromHeader) && fromHeader > 0) return fromHeader;
	const m = /resets in ~?(\d+)\s*s/i.exec(message || '');
	if (m) return Number.parseInt(m[1], 10);
	return 10;
}

// Persist a base64 image to object storage and return a durable https URL.
// Downstream image-to-3D providers take URLs (Replicate caps inline data URIs at
// ~256 KB — a 1024px image blows straight past that), so neither the Vertex inline
// data URI nor the NIM base64 artifact can be forwarded as-is.
//
// Format is sniffed from the magic bytes so the object key extension and
// Content-Type always match the real payload: NIM FLUX returns JPEG artifacts
// (probed live — see tasks/nvidia-nim/probes/flux.md) while Vertex Imagen
// returns PNG. Unknown bytes keep the PNG label (legacy behavior).
async function persistImageBase64(b64) {
	const { putObject, publicUrl } = await import('../_lib/r2.js');
	const body = Buffer.from(b64, 'base64');
	const isJpeg = body.length > 2 && body[0] === 0xff && body[1] === 0xd8 && body[2] === 0xff;
	const ext = isJpeg ? 'jpg' : 'png';
	const key = `forge/refs/${globalThis.crypto.randomUUID()}.${ext}`;
	await putObject({ key, body, contentType: isJpeg ? 'image/jpeg' : 'image/png' });
	return publicUrl(key);
}

// Vertex Imagen returns the PNG inline as a data: URI — persist it the same way
// the NIM lane persists its base64 artifact.
async function persistDataUriImage(result) {
	if (!result?.imageUrl?.startsWith('data:')) return result;
	const b64 = result.imageUrl.split(',')[1] || '';
	return { ...result, imageUrl: await persistImageBase64(b64) };
}

// Free lane: FLUX.1-schnell on NVIDIA NIM. Synchronous invoke — the artifact
// comes back inline as base64, no poll. Caller guarantees NVIDIA_API_KEY is set.
// Throws on any failure (timeout, throttle, malformed body) so the caller can
// degrade to the paid lanes; never returns a half-result.
async function nimFluxImage(prompt, aspectRatio, seed = 0) {
	const key = readEnv('NVIDIA_API_KEY');
	const [width, height] = NIM_DIMENSIONS[aspectRatio] || NIM_DIMENSIONS['1:1'];

	let lastErr = null;
	for (let attempt = 1; attempt <= NIM_MAX_ATTEMPTS; attempt++) {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), NIM_TIMEOUT_MS);
		let res;
		try {
			res = await fetch(NIM_FLUX_URL, {
				method: 'POST',
				headers: {
					authorization: `Bearer ${key}`,
					accept: 'application/json',
					'content-type': 'application/json',
				},
				// No cfg_scale: schnell is guidance-distilled and the endpoint enforces
				// cfg_scale <= 0 for it (sending 3.5 422s — verified live 2026-06-11).
				body: JSON.stringify({
					prompt,
					mode: 'base',
					width,
					height,
					seed,
					steps: 4,
				}),
				signal: controller.signal,
			});
		} catch (err) {
			const aborted = err?.name === 'AbortError' || err?.name === 'TimeoutError';
			lastErr = Object.assign(
				new Error(aborted ? 'nim flux timed out' : `nim flux unreachable: ${err?.message}`),
				{ code: aborted ? 'rate_limited' : 'provider_unreachable' },
			);
			// A timeout already burned the full window — don't retry it (a second
			// attempt just doubles the wait before failover). A non-timeout network
			// blip gets one retry, mirroring the TRELLIS provider.
			if (!aborted && attempt < NIM_MAX_ATTEMPTS) {
				await sleep(NIM_RETRY_DELAY_MS);
				continue;
			}
			throw lastErr;
		} finally {
			clearTimeout(timer);
		}

		if (!res.ok) {
			const detail = await res.text().catch(() => '');
			const message = `nim flux returned ${res.status}${detail ? `: ${detail.slice(0, 200)}` : ''}`;
			// A fast transient gateway 5xx (cold model / capacity blip) gets one
			// retry before we surface it and cascade to the paid lanes.
			if (NIM_GATEWAY_RETRY_STATUSES.has(res.status) && attempt < NIM_MAX_ATTEMPTS) {
				lastErr = Object.assign(new Error(message), { providerStatus: res.status });
				await sleep(NIM_RETRY_DELAY_MS);
				continue;
			}
			// 429 (credit-metered free tier) is retryable upstream; surface it so a
			// caller can route, but here it just means "fall through to the paid lanes".
			throw Object.assign(new Error(message), {
				providerStatus: res.status,
				...(res.status === 429 ? { code: 'rate_limited' } : {}),
			});
		}

		const data = await res.json().catch(() => ({}));
		const b64 = data?.artifacts?.[0]?.base64;
		if (!b64) throw new Error('nim flux finished but produced no image');
		return { imageUrl: await persistImageBase64(b64), model: NIM_FLUX_MODEL };
	}
	// Exhausted retries on a transient status/blip without a terminal verdict.
	throw lastErr || new Error('nim flux failed after retries');
}

// Background / lighting / composition cues that signal the caller already
// controls the scene. When one is present we leave the prompt untouched;
// otherwise we append cues that steer the image toward a single, evenly-lit
// subject on a plain background, which reconstructs into a far cleaner 3D mesh
// (TRELLIS / Hunyuan3D build geometry + texture from this one image).
//
// These are deliberately NOT art-style words. A "cartoon" or "stylized" subject
// still needs isolation + a plain background for good reconstruction — gating
// the suffix on style words (as an earlier version did, which also listed
// cartoon / stylized / colorful / vibrant) let "a cartoon fox" render a full
// illustrated forest scene on the Gemini lane: background clutter the 3D backend
// then tries, and fails, to reconstruct. Match whole words so a substring like
// "light" inside "lightsaber" can't wrongly suppress the cue either. The suffix
// only ever gets ADDED relative to the old behavior, so it can only push toward
// cleaner single-subject references, never toward busier scenes.
const COMPOSITION_CUE_WORDS = [
	'studio', 'light', 'bright', 'backlit', 'background', 'plain', 'white bg', 'isolated',
];
const COMPOSITION_CUE_RE = new RegExp(`\\b(?:${COMPOSITION_CUE_WORDS.join('|')})\\b`, 'i');
const FLUX_STYLE_SUFFIX = ', isolated subject, bright studio lighting, plain white background';

// Deliberate art-style words — when the caller names a rendering style
// (cartoon, voxel, watercolor…) the realism cues below must NOT fight it. This
// list is only ever consulted to SKIP adding realism words; it never suppresses
// the isolation suffix (see the regression note above — a cartoon fox still
// needs a plain background to reconstruct cleanly).
const ART_STYLE_WORDS = [
	'cartoon', 'anime', 'manga', 'toon', 'chibi', 'stylized', 'low[- ]poly', 'voxel',
	'pixel[- ]art', '8[- ]bit', '16[- ]bit', 'claymation', 'plasticine', 'illustration',
	'illustrated', 'painting', 'painterly', 'watercolor', 'sketch', 'hand[- ]drawn',
	'comic', 'cel[- ]shaded', 'origami', 'papercraft', 'plush', 'crochet', 'knitted',
	'lego', 'minecraft', 'abstract',
];
const ART_STYLE_RE = new RegExp(`\\b(?:${ART_STYLE_WORDS.join('|')})\\b`, 'i');

// Realism cues, added by default: the reference image is the sole source of the
// 3D model's texture and proportions, so photographic language here is what
// makes the final mesh read as a real object/person rather than a render.
// Skipped when the caller named an art style (respect the ask) — and the whole
// suffix pipeline stays untouched when the prompt already carries composition
// cues, exactly as before.
const REALISM_SUFFIX =
	', photorealistic, true-to-life materials and surface detail, sharp focus, professional product photograph';

// A human/humanoid subject needs portrait-photography language, not
// product-photography language — "professional product photograph" reads
// wrong for a person and steers FLUX toward glossy-mannequin skin instead of
// the pores/asymmetry/texture that make a reconstructed avatar look like an
// actual IRL person. Matched as whole words so "personality" or "manatee"
// can't false-positive off "person"/"man".
const PERSON_SUBJECT_WORDS = [
	'person', 'human', 'man', 'woman', 'guy', 'girl', 'boy', 'lady', 'gentleman',
	'people', 'face', 'portrait', 'selfie', 'model(?!s? of)', 'character(?!\\s+prop)',
	'warrior', 'knight', 'soldier', 'wizard', 'ninja', 'astronaut', 'pirate',
	'king', 'queen', 'hero', 'villain', 'avatar',
];
const PERSON_SUBJECT_RE = new RegExp(`\\b(?:${PERSON_SUBJECT_WORDS.join('|')})\\b`, 'i');
const PERSON_REALISM_SUFFIX =
	', photorealistic human, natural skin texture with visible pores and subtle asymmetry, ' +
	'realistic hair strands, natural catchlight in the eyes, portrait photography, shot on a DSLR ' +
	'with an 85mm lens, sharp focus';

export function enhanceFluxPrompt(raw) {
	const text = String(raw || '').trim();
	if (!text) return text;
	if (COMPOSITION_CUE_RE.test(text)) return text;
	let realism = '';
	if (!ART_STYLE_RE.test(text)) {
		realism = PERSON_SUBJECT_RE.test(text) ? PERSON_REALISM_SUFFIX : REALISM_SUFFIX;
	}
	return text + realism + FLUX_STYLE_SUFFIX;
}

// Generate a single image from a text prompt.
//
// Tries the free lanes first (NIM FLUX, then Vertex Imagen) and degrades to the
// paid Replicate backstop on any failure — a broken or throttled preferred
// provider must hand off, never take down the whole text→3D pipeline. The last
// configured lane's error is surfaced only when nothing is left to try.
export async function textToImage(prompt, { aspectRatio = '1:1', skipNim = false, seed } = {}) {
	prompt = enhanceFluxPrompt(prompt);
	// Optional deterministic seed. Honored on the lanes that expose one (NIM FLUX,
	// Replicate flux); the Vertex/Gemini image API has no seed parameter, so a seed
	// is silently ignored there. Undefined preserves the prior default (seed 0).
	const hasSeed = Number.isInteger(seed) && seed >= 0;
	const token = readEnv('REPLICATE_API_TOKEN');
	const hasVertex = !!readEnv('GOOGLE_CLOUD_PROJECT') && vertexImagenEnabled();
	// Quality-first ordering: the Vertex Gemini image model outdraws 4-step
	// distilled FLUX for photoreal reference images, and it burns the GCP credit
	// pool the platform is funded to spend — so when the lane is configured it
	// leads by default. The reference image is the sole source of the 3D model's
	// texture and proportions; this is the cheapest quality lever in the chain.
	// VERTEX_IMAGEN_FIRST=0 restores the legacy NIM-first order without touching
	// the lane's on/off gate (VERTEX_IMAGEN_ENABLED).
	const vertexFirst = hasVertex && readEnv('VERTEX_IMAGEN_FIRST') !== '0';
	// What remains DOWNSTREAM of the NIM lane. When Vertex leads it has already
	// been consumed by the time NIM runs, so it no longer counts as a fallback —
	// otherwise a NIM failure after a Vertex failure would "fall through" to a
	// lane that was already tried and surface the wrong terminal error.
	const hasFallback = (!vertexFirst && hasVertex) || !!token;

	// One attempt at the Vertex lane, shared by both ladder positions. Returns
	// null to mean "hand off to the next lane" (unconfigured, or a failure with a
	// lane left to try); throws only when nothing remains downstream.
	const tryVertex = async (laneRemains) => {
		try {
			const { generateImage, isConfigured } = await import('./vertex-imagen.js');
			if (!isConfigured()) return null;
			return logImageProvider(await persistDataUriImage(await generateImage(prompt, { aspectRatio })));
		} catch (err) {
			if (!laneRemains) throw err;
			console.warn(`vertex imagen failed, falling back: ${err?.message}`);
			return null;
		}
	};

	if (vertexFirst) {
		const served = await tryVertex(!!readEnv('NVIDIA_API_KEY') || !!token);
		if (served) return served;
	}

	// ── NVIDIA NIM FLUX (free, first) ─────────────────────────────────────────
	// Skip the NIM lane when a fallback exists AND either the caller just watched a
	// sibling NVCF lane time out this same request (`skipNim` — the gateway is
	// degraded now, so a second NIM window would just stack timeouts) or a recent
	// NIM FLUX failure left it in cooldown. With no fallback, NIM stays the only
	// lane and is always tried — a degraded lane beats no image at all.
	const nimCooling =
		hasFallback &&
		(skipNim || (await providersInCooldown([NIM_FLUX_COOLDOWN_KEY])).has(NIM_FLUX_COOLDOWN_KEY));
	if (readEnv('NVIDIA_API_KEY') && !nimCooling) {
		try {
			return logImageProvider(await nimFluxImage(prompt, aspectRatio, hasSeed ? seed : 0));
		} catch (err) {
			// A degraded lane (timeout / unreachable / throttle / 5xx) cools down so the
			// next caller skips it; a clean 4xx (bad input) is not a lane-health fault.
			if (isNimLaneDegraded(err)) {
				markProviderCooldown(NIM_FLUX_COOLDOWN_KEY, NIM_FLUX_COOLDOWN_SECONDS).catch(() => {});
			}
			// Nothing downstream to fall through to → surface the NIM error.
			if (!hasFallback) throw err;
			// A handled degradation (Vertex/HF will serve the image), not a fault —
			// warn so it doesn't read as an error in the logs like the rest of the
			// free-first cascade.
			console.warn(`nim flux failed, falling back: ${err?.message}`);
		}
	}

	// ── Vertex AI Imagen path (legacy position — only when not already led) ──
	if (hasVertex && !vertexFirst) {
		const served = await tryVertex(!!token);
		if (served) return served;
	}

	// ── Replicate fallback ───────────────────────────────────────────────────
	if (!token) {
		throw Object.assign(
			new Error(
				'text-to-image is not configured: set NVIDIA_API_KEY (NIM), GOOGLE_CLOUD_PROJECT (Vertex AI), or REPLICATE_API_TOKEN (Replicate)',
			),
			{ code: 'unconfigured' },
		);
	}

	const modelRef = readEnv('REPLICATE_TXT2IMG_MODEL') || DEFAULT_TXT2IMG_MODEL;
	const isVersionHash = /^[a-f0-9]{40,64}$/i.test(modelRef);
	const slug = modelRef.match(/^([a-z0-9-]+)\/([a-z0-9._-]+)(?::([a-f0-9]+))?$/i);

	const input = {
		prompt,
		aspect_ratio: aspectRatio,
		num_outputs: 1,
		output_format: 'png',
		// A clean, evenly-lit, single-subject image on a plain background
		// reconstructs into a far better mesh than a busy scene — steer flux
		// toward that without overriding a caller's own composition cues.
		go_fast: true,
		// Deterministic seed when the caller supplied one (flux accepts `seed`).
		...(hasSeed ? { seed } : {}),
	};

	let endpoint;
	let body;
	if (isVersionHash) {
		endpoint = `${REPLICATE_BASE}/predictions`;
		body = JSON.stringify({ version: modelRef, input });
	} else if (slug) {
		const [, owner, name, pinned] = slug;
		endpoint = `${REPLICATE_BASE}/models/${owner}/${name}/predictions`;
		body = JSON.stringify(pinned ? { version: pinned, input } : { input });
	} else {
		throw new Error(`invalid REPLICATE_TXT2IMG_MODEL reference: ${modelRef}`);
	}

	// Pace creation to the platform account's rate before firing. On a reduced-rate
	// (low-credit) Replicate account this caps at 6/min, burst 1 — and this paid
	// backstop has no further free lane to shed to, so we QUEUE for the next slot
	// rather than stampede the limit into account-wide throttle 429s. Reserve the
	// slot; if it opens within the bounded wait, hold this worker until then; if the
	// queue is deeper than the budget, surface a retryable rate-limit the forge
	// boundary maps to a "queued — retry shortly" 429 (with an accurate Retry-After).
	const slot = await reserveProviderRateSlot('replicate', {
		ratePerMin: SCALE_LIMITS.replicateRatePerMin,
		burst: SCALE_LIMITS.replicateRateBurst,
		maxWaitMs: SCALE_LIMITS.replicateQueueMaxMs,
	});
	if (!slot.ok) {
		throw Object.assign(
			new Error('Image generation is queued behind other requests — please retry in a few seconds.'),
			{ code: 'rate_limited', queued: true, retryAfter: Math.max(1, Math.ceil(slot.waitMs / 1000)) },
		);
	}
	if (slot.waitMs > 0) await sleep(slot.waitMs);

	let res;
	try {
		res = await fetch(endpoint, {
			method: 'POST',
			headers: {
				authorization: `Bearer ${token}`,
				'content-type': 'application/json',
				prefer: 'wait',
			},
			body,
		});
	} catch (err) {
		throw Object.assign(new Error(`text-to-image provider unreachable: ${err?.message}`), {
			code: 'provider_unreachable',
		});
	}

	const data = await res.json().catch(() => ({}));
	if (!res.ok) {
		const detail = data?.detail || data?.title || '';
		// Replicate throttles prediction creation (notably when account credit is
		// low). Surface it as a retryable rate limit, not a generic failure, so the
		// caller can return 429 + retry hint instead of a hard 5xx. The throttle
		// `detail` names the account's credit balance ("…less than $5.0 in credit…")
		// — parse its reset hint for backoff and log it, but never relay that
		// internal state to the buyer.
		if (res.status === 429) {
			if (detail) console.warn(`[text-to-image] replicate throttled: ${detail}`);
			throw Object.assign(
				new Error('Image generation is briefly busy upstream — please retry in a few seconds.'),
				{
					code: 'rate_limited',
					providerDetail: detail,
					retryAfter: parseRetryAfter(res.headers, detail),
				},
			);
		}
		// Hard out-of-credit / billing failure. Replicate returns this as a 402,
		// but the same "purchase credit at replicate.com/billing" copy can ride in
		// on other 4xx codes too — match on status OR content so a status change
		// upstream can never spill the vendor's billing page onto the buyer. Keep
		// the raw detail for logs (providerDetail); surface a neutral, buyer-safe
		// message the caller maps to "temporarily unavailable" (never "go buy
		// credit"). The free NIM lane is the primary path — this backstop being
		// dry must read as a transient platform issue, not a user-facing dead end.
		if (res.status === 402 || /credit|billing|purchase|payment required/i.test(detail)) {
			if (detail) console.warn(`[text-to-image] replicate billing/credit failure: ${detail}`);
			throw Object.assign(new Error('image provider billing error'), {
				code: 'billing',
				providerStatus: 402,
				providerDetail: detail,
			});
		}
		throw Object.assign(new Error(detail || `text-to-image returned ${res.status}`), {
			providerStatus: res.status,
		});
	}

	// With `Prefer: wait` the prediction usually completes inline. When Replicate
	// returns before completion (slow model, cold start, wait window elapsed) it
	// hands back a non-terminal status and no output — poll the prediction to a
	// terminal state so the free text→3D lane never dead-ends on a transient
	// "starting", instead of surfacing the partial state as a hard failure.
	let url = extractImageUrl(data.output);
	if (!url) {
		const getUrl = data?.urls?.get;
		const nonTerminal = data.status && !REPLICATE_TERMINAL_STATUSES.has(data.status);
		if (getUrl && nonTerminal) {
			const finished = await pollReplicatePrediction(getUrl, token);
			url = extractImageUrl(finished?.output);
			if (url) {
				return logImageProvider({ imageUrl: url, predictionId: finished?.id || data.id, model: modelRef });
			}
			throw new Error(
				`text-to-image did not complete (status: ${finished?.status || data.status})`,
			);
		}
		if (data.status && data.status !== 'succeeded') {
			throw new Error(`text-to-image did not complete (status: ${data.status})`);
		}
		throw new Error('text-to-image finished but produced no image');
	}
	return logImageProvider({ imageUrl: url, predictionId: data.id, model: modelRef });
}

// Turnaround-view instructions for multi-view 3D conditioning. Each rotates the
// SAME subject; the identity-preservation phrasing ("this exact same subject,
// identical materials/wear/lighting") is what keeps the Gemini edit from
// redesigning the object between views (verified live 2026-07-16: front/side/
// back of one worn leather chair kept its chassis, scuffs and lighting).
const TURNAROUND_VIEW_INSTRUCTIONS = [
	'Show this exact same subject in direct left side profile view (rotated 90 degrees). Keep the identical subject with identical materials, colors, wear marks and details, and identical lighting, on a plain neutral background. Same camera distance and framing.',
	'Show this exact same subject from directly behind (rotated 180 degrees). Keep the identical subject with identical materials, colors, wear marks and details, and identical lighting, on a plain neutral background. Same camera distance and framing.',
];

// Synthesize additional turnaround views (side, then back) of the subject in
// `primaryImageUrl` for multi-view 3D reconstruction. The self-host TRELLIS
// worker fuses up to 6 views of one asset; geometry the primary view can't
// see (backs, sides) stops being hallucinated when real views cover it.
//
// Runs only on the Vertex Gemini edit lane (image+instruction), the same GCP
// credit pool as the primary reference image; there is no NIM/Replicate
// fallback for edits. Strictly best-effort: any per-view failure (lane
// unconfigured, safety block, throttle) just yields fewer views; the primary
// view alone is always a complete input, so this can only ever add quality.
export async function synthesizeTurnaroundViews(primaryImageUrl, { count = 2 } = {}) {
	const wanted = TURNAROUND_VIEW_INSTRUCTIONS.slice(0, Math.max(0, count));
	if (!wanted.length) return [];
	let editImage;
	try {
		const vertex = await import('./vertex-imagen.js');
		if (!vertex.isConfigured() || !vertexImagenEnabled()) return [];
		editImage = vertex.editImage;
	} catch {
		return [];
	}
	const results = await Promise.allSettled(
		wanted.map((instruction) =>
			editImage(primaryImageUrl, instruction).then(persistDataUriImage),
		),
	);
	const views = [];
	for (const r of results) {
		if (r.status === 'fulfilled' && r.value?.imageUrl) {
			views.push(r.value.imageUrl);
		} else if (r.status === 'rejected') {
			console.warn(`[text-to-image] turnaround view failed, continuing: ${r.reason?.message}`);
		}
	}
	return views;
}
