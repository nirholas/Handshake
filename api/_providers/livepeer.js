// Livepeer federation provider: routes one class of the platform's GPU work
// (text-to-image reference synthesis) to the Livepeer decentralized compute
// network instead of a first-party or vendor lane.
//
// Roadmap: "federate with existing decentralized compute networks where
// appropriate" (README Phase 4). This is the adapter behind the flag; the
// measurement harness is scripts/livepeer-federation-bench.mjs and the
// measured recommendation lives in docs/ops/livepeer-federation.md.
//
// ── Gateways ────────────────────────────────────────────────────────────────
//   LIVEPEER_API_KEY set     → https://livepeer.studio/api/generate (Studio AI
//                              gateway, bearer auth, metered free tier)
//   otherwise                → https://dream-gateway.livepeer.cloud (public
//                              no-key gateway, rate-limited; measured DOWN at
//                              the DNS edge on 2026-08-12, see the ops note)
//   LIVEPEER_GATEWAY_URL     → full base-URL override for either (self-hosted
//                              gateway, staging, or a regional edge)
//
// ── Job envelope ─────────────────────────────────────────────────────────────
// Same envelope the platform's own image lanes accept and return:
//   in : (prompt, { aspectRatio, seed }) - identical to textToImage()
//   out: { imageUrl, model, lane, gateway } - imageUrl is a durable R2 https
//        URL, exactly as the NIM FLUX and Vertex lanes produce, so the
//        image-to-3D backends downstream cannot tell the difference.
//
// ── Verification ────────────────────────────────────────────────────────────
// Same verification the platform applies to its own workers at this seam:
//   1. the gateway must return an images[] entry that is not nsfw-flagged,
//   2. the fetched bytes must carry a real PNG/JPEG magic-byte signature
//      (looksLikeImageBytes - a 200 with an HTML error page fails here),
//   3. only verified bytes are persisted to R2 and returned.
// The optional vision QA layer (forge-image-validate) sits above every lane
// unchanged; this adapter never bypasses it.
//
// ── Flag ─────────────────────────────────────────────────────────────────────
// The lane is dark unless LIVEPEER_FEDERATION_ENABLED is truthy
// (1/true/yes/on). Off by default: the public gateway is unreliable and the
// studio gateway is unkeyed, so the lane only goes live after the funded
// comparison in the ops note clears it.

import { env } from '../_lib/env.js';
import { looksLikeImageBytes, persistImageBytes } from '../_lib/image-persist.js';
import { livepeerGatewayConfig } from '../_lib/livepeer-gateway.js';

// Gateway resolution is shared with the LLM comparison lane
// (api/inference/livepeer.js) so the network's URLs live in one file.
export { livepeerGatewayConfig };

// Default pipeline on the Livepeer AI gateway text-to-image surface. A fast
// distilled SDXL variant, matching the lane's role (cheap reference views, not
// hero renders). Override with LIVEPEER_T2I_MODEL.
export const DEFAULT_T2I_MODEL = 'ByteDance/SDXL-Lightning';

// Per-call ceiling. SDXL-Lightning renders in a few seconds on a warm
// orchestrator; the public gateway can sit on a cold one, so this is generous
// but bounded - a hung federated lane must hand off to the next platform lane,
// never stall the text→3D pipeline.
const T2I_TIMEOUT_MS = 90_000;

// Verification floor: a payload under this size is an error page or an empty
// artifact, not a rendered image.
const MIN_IMAGE_BYTES = 1024;

// Aspect-ratio → pixel dimensions. Mirrors the NIM FLUX lane's map (multiples
// of 64, ~1MP), so a caller's aspect choice behaves identically across lanes.
const DIMENSIONS = {
	'1:1': [1024, 1024],
	'16:9': [1344, 768],
	'9:16': [768, 1344],
	'4:3': [1024, 768],
	'3:4': [768, 1024],
	'3:2': [1216, 832],
	'2:3': [832, 1216],
};

function truthy(v) {
	return /^(1|true|yes|on)$/i.test(String(v ?? '').trim());
}

// The env flag is the only switch. readEnv-style (process.env) rather than the
// env.js getter so the flag also works in the bench harness and tests, which
// set process.env directly between cases.
export function livepeerFederationEnabled() {
	return truthy(process.env.LIVEPEER_FEDERATION_ENABLED);
}

// Node's fetch reports every transport failure as the opaque message "fetch
// failed" and hides the real reason on err.cause. That distinction is the whole
// diagnosis for a federated lane: a certificate that belongs to somebody else
// (the public gateway's current state) is a different problem, with a different
// fix, than a refused connection or a DNS miss. Flatten the cause chain into
// the message so a bench report and a production log line both name the actual
// fault instead of "fetch failed".
function describeTransportFailure(err) {
	const parts = [];
	for (let cur = err, depth = 0; cur && depth < 5; cur = cur.cause, depth++) {
		const piece = [cur.code, cur.message].filter(Boolean).join(' ');
		if (piece && !parts.includes(piece)) parts.push(piece);
	}
	return parts.join(': ') || 'unknown transport failure';
}

// Resolve a possibly gateway-relative image URL against the gateway origin.
function resolveImageUrl(raw, base) {
	if (typeof raw !== 'string' || !raw) return null;
	if (/^https:\/\//.test(raw)) return raw;
	if (raw.startsWith('/')) return new URL(raw, base).href;
	return null;
}

// One federated text-to-image job on the Livepeer network.
//
// Throws a coded error on any failure (the textToImage chain treats a throw as
// "hand off to the next lane"): provider_unreachable for socket/TLS failures,
// rate_limited for 429, verification_failed for a well-formed 200 whose
// payload is not a usable image, and upstream_error otherwise.
export async function livepeerTextToImage(prompt, { aspectRatio = '1:1', seed, model, timeoutMs = T2I_TIMEOUT_MS } = {}) {
	const laneTimeoutMs = Math.max(1_000, Math.min(T2I_TIMEOUT_MS, Number(timeoutMs) || T2I_TIMEOUT_MS));
	const { base, gateway, key } = livepeerGatewayConfig();
	const [width, height] = DIMENSIONS[aspectRatio] || DIMENSIONS['1:1'];
	const modelId = model || process.env.LIVEPEER_T2I_MODEL || env.LIVEPEER_T2I_MODEL || DEFAULT_T2I_MODEL;

	const headers = { 'content-type': 'application/json', accept: 'application/json' };
	if (key) headers.authorization = `Bearer ${key}`;

	// Livepeer AI gateway text-to-image pipeline (OpenAPI-documented shape):
	// { prompt, model_id, width, height, seed, num_images_per_prompt,
	//   safety_check } → { images: [{ url, seed, nsfw }] }. safety_check stays
	// on so the gateway's own screening flags the image rather than us shipping
	// it into a reference pipeline.
	const body = {
		prompt: String(prompt || ''),
		model_id: modelId,
		width,
		height,
		num_images_per_prompt: 1,
		safety_check: true,
		...(Number.isInteger(seed) && seed >= 0 ? { seed } : {}),
	};

	let res;
	try {
		res = await fetch(`${base}/text-to-image`, {
			method: 'POST',
			headers,
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(laneTimeoutMs),
		});
	} catch (err) {
		throw Object.assign(new Error(`livepeer gateway unreachable: ${describeTransportFailure(err)}`), {
			code: 'provider_unreachable',
		});
	}

	if (!res.ok) {
		const detail = await res.text().catch(() => '');
		throw Object.assign(
			new Error(`livepeer text-to-image returned ${res.status}${detail ? `: ${detail.slice(0, 200)}` : ''}`),
			{ providerStatus: res.status, ...(res.status === 429 ? { code: 'rate_limited' } : { code: 'upstream_error' }) },
		);
	}

	const data = await res.json().catch(() => ({}));
	const image = Array.isArray(data?.images) ? data.images[0] : null;

	// Verification gate 1: the gateway's own safety screen.
	if (image?.nsfw === true) {
		throw Object.assign(new Error('livepeer returned an nsfw-flagged image'), { code: 'verification_failed' });
	}
	const imageUrl = resolveImageUrl(image?.url, base);
	if (!imageUrl) {
		throw Object.assign(new Error('livepeer finished but produced no image url'), { code: 'verification_failed' });
	}

	// Fetch the artifact. Studio serves these on its own host with the same
	// bearer; the public gateway serves them unauthenticated.
	let imgRes;
	try {
		imgRes = await fetch(imageUrl, {
			headers: key ? { authorization: `Bearer ${key}` } : {},
			signal: AbortSignal.timeout(laneTimeoutMs),
		});
	} catch (err) {
		throw Object.assign(new Error(`livepeer image fetch failed: ${describeTransportFailure(err)}`), {
			code: 'provider_unreachable',
		});
	}
	if (!imgRes.ok) {
		throw Object.assign(new Error(`livepeer image fetch returned ${imgRes.status}`), {
			code: 'upstream_error',
			providerStatus: imgRes.status,
		});
	}
	const bytes = Buffer.from(await imgRes.arrayBuffer());

	// Verification gate 2: magic-byte sniff + size floor, the same check the
	// platform's own lanes get at the persistence seam.
	if (bytes.length < MIN_IMAGE_BYTES || !looksLikeImageBytes(bytes)) {
		throw Object.assign(
			new Error(`livepeer image failed verification (${bytes.length} bytes, no image signature)`),
			{ code: 'verification_failed' },
		);
	}

	return {
		imageUrl: await persistImageBytes(bytes),
		model: modelId,
		lane: 'livepeer',
		gateway,
		seedUsed: Number.isInteger(image?.seed) ? image.seed : (Number.isInteger(seed) ? seed : null),
	};
}
