// Lane configuration, health, and response shaping for POST /api/v1/ai/image.
//
// The endpoint routes across the same free/subsidized text→image lanes the 3D
// forge uses (api/_mcp3d/text-to-image.js): NVIDIA NIM FLUX (free), Google
// Vertex/Gemini image (GCP credits), and a Replicate paid backstop. This module
// answers three questions the route needs without duplicating that lane logic:
//
//   1. Which lanes are configured right now? (drives the honest 503 before the
//      GCP env lands, and the /api/v1/ai/image?health=1 probe)
//   2. Is a delivered result a provider safety refusal? (→ 422, never retried)
//   3. What provider label + nominal dimensions describe the result?
//
// It never generates an image itself — health probes are auth/reachability
// checks against each lane's cheap surface, so they cost nothing against quota.

import { getGcpAccessToken, gcpAuthConfigured } from './gcp-auth.js';
import { providersInCooldown } from './provider-health.js';

function readEnv(name) {
	if (typeof process !== 'undefined' && process.env?.[name]) return process.env[name];
	return null;
}

// Mirror of the private gate in text-to-image.js: the Vertex lane is active when
// GOOGLE_CLOUD_PROJECT is set unless VERTEX_IMAGEN_ENABLED explicitly disables it.
function vertexImagenEnabled() {
	const raw = readEnv('VERTEX_IMAGEN_ENABLED');
	if (raw == null) return true;
	return !/^(0|false|no|off)$/i.test(String(raw).trim());
}

// The circuit-breaker key text-to-image.js records a NIM FLUX failure under, so
// the health probe can report a cooling lane as degraded without its own probe.
const NIM_FLUX_COOLDOWN_KEY = 'forge-nim-flux';

// Env vars that gate at least one image lane. Named verbatim in the 503 body so
// the operator knows exactly what to set. NVIDIA / Vertex are the primary
// subsidized lanes; Replicate is the paid backstop.
export const IMAGE_LANE_ENV = Object.freeze({
	nim: ['NVIDIA_API_KEY'],
	vertex: ['GOOGLE_CLOUD_PROJECT', 'GCP_SERVICE_ACCOUNT_JSON', 'GOOGLE_CLOUD_LOCATION'],
	replicate: ['REPLICATE_API_TOKEN'],
});

/**
 * Static (no-I/O) view of which lanes are wired from the current env. Matches
 * text-to-image.js's own config gate so "the endpoint works the moment a lane is
 * set" and "503 not_configured when none are" stay in lockstep with the router.
 */
export function imageLaneConfig() {
	const nim = Boolean(readEnv('NVIDIA_API_KEY'));
	const vertex = Boolean(readEnv('GOOGLE_CLOUD_PROJECT')) && vertexImagenEnabled();
	const replicate = Boolean(readEnv('REPLICATE_API_TOKEN'));
	const hf = Boolean(readEnv('HF_TOKEN'));
	// Pollinations needs no key, so an image lane is always configured.
	const pollinations = true;
	return {
		nim,
		vertex,
		replicate,
		hf,
		pollinations,
		anyConfigured: true,
	};
}

// Flat list of the env vars an operator must set to bring up an image lane —
// surfaced in the 503 body when nothing is configured.
export function missingLaneEnv() {
	return [...IMAGE_LANE_ENV.nim, ...IMAGE_LANE_ENV.vertex.slice(0, 2), ...IMAGE_LANE_ENV.replicate];
}

// ── Provider labelling + dimensions ──────────────────────────────────────────

// Canonical ~1MP pixel dimensions per aspect ratio, mirroring the NIM FLUX map.
// The lanes don't return the rendered size (Gemini takes an aspect ratio, not a
// width/height), so these are the nominal target dimensions for the request.
export const ASPECT_DIMENSIONS = Object.freeze({
	'1:1': [1024, 1024],
	'16:9': [1344, 768],
	'9:16': [768, 1344],
	'4:3': [1024, 768],
	'3:4': [768, 1024],
	'3:2': [1216, 832],
	'2:3': [832, 1216],
});

export const SUPPORTED_ASPECT_RATIOS = Object.freeze(Object.keys(ASPECT_DIMENSIONS));

export function dimensionsFor(aspectRatio) {
	const [width, height] = ASPECT_DIMENSIONS[aspectRatio] || ASPECT_DIMENSIONS['1:1'];
	return { width, height };
}

/**
 * Friendly provider label for a textToImage() result. Distinguishes NIM FLUX
 * from the Replicate flux backstop (both carry a black-forest-labs/flux* model
 * id) via the Replicate-only predictionId, and Vertex by its vertex-ai/ prefix.
 */
export function providerLabel(result) {
	const model = String(result?.model || '');
	if (model.startsWith('vertex-ai/')) return 'vertex';
	if (result?.predictionId) return 'replicate';
	if (model) return 'nvidia-nim';
	return 'unknown';
}

// ── Safety-refusal detection ─────────────────────────────────────────────────

// Gemini/Imagen block a prohibited prompt by returning candidates with a
// finishReason and no image part; text-to-image.js surfaces that as an error
// whose message carries the finishReason. These are the block enums Vertex emits.
const REFUSAL_FINISH_REASONS = /finishReason:\s*(SAFETY|IMAGE_SAFETY|PROHIBITED_CONTENT|RECITATION|BLOCKLIST|SPII|CONTENT_FILTERED|IMAGE_PROHIBITED_CONTENT)/i;
const REFUSAL_PHRASES = /\b(safety|content policy|prohibited content|blocked by|policy violation)\b/i;

/**
 * True when a thrown lane error is a provider safety refusal (content policy),
 * as opposed to a transient outage. A refusal is a terminal verdict about the
 * prompt — the caller must fix the prompt, so it is surfaced as 422 and never
 * retried. A rate-limit / unreachable / billing error is explicitly NOT a
 * refusal (those carry their own codes and are retryable).
 */
export function isProviderRefusal(err) {
	if (!err) return false;
	if (['rate_limited', 'provider_unreachable', 'billing', 'unconfigured'].includes(err.code)) return false;
	const msg = String(err.message || '');
	return REFUSAL_FINISH_REASONS.test(msg) || REFUSAL_PHRASES.test(msg);
}

/** Human-readable refusal reason pulled from the provider error, for the 422 body. */
export function refusalReason(err) {
	const msg = String(err?.message || '');
	const m = REFUSAL_FINISH_REASONS.exec(msg);
	if (m) return `Provider blocked this prompt (${m[1]}).`;
	return 'Provider declined this prompt for content-policy reasons.';
}

// ── Health probe ─────────────────────────────────────────────────────────────

const PROBE_TIMEOUT_MS = 3_000;

// NIM: no free "account" endpoint, so reachability is a plain GET to the API host
// (any answer <500 proves it is routable) folded with the shared FLUX cooldown
// breaker so a recently-failed lane reads as degraded without a probe.
async function probeNim() {
	if (!readEnv('NVIDIA_API_KEY')) return { configured: false, status: 'unconfigured' };
	let cooled = false;
	try {
		cooled = (await providersInCooldown([NIM_FLUX_COOLDOWN_KEY])).has(NIM_FLUX_COOLDOWN_KEY);
	} catch { /* cache miss → not cooling */ }
	if (cooled) return { configured: true, status: 'degraded', detail: 'recent failure cooldown' };
	try {
		const res = await fetch('https://ai.api.nvidia.com/v1/models', {
			headers: { authorization: `Bearer ${readEnv('NVIDIA_API_KEY')}` },
			signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
		});
		return { configured: true, status: res.status < 500 ? 'ok' : 'down', httpStatus: res.status };
	} catch (err) {
		return { configured: true, status: 'down', detail: err?.message?.slice(0, 120) };
	}
}

// Vertex: mint a GCP access token. Success proves the service-account creds and
// the token endpoint work — the actual credit-burning generateContent call is
// never made, so this costs nothing against the image budget.
async function probeVertex() {
	const project = readEnv('GOOGLE_CLOUD_PROJECT');
	if (!project || !vertexImagenEnabled()) return { configured: false, status: 'unconfigured' };
	if (!gcpAuthConfigured()) {
		return {
			configured: true,
			status: 'down',
			detail: 'GCP_SERVICE_ACCOUNT_JSON not set',
			model: readEnv('VERTEX_IMAGEN_MODEL') || 'gemini-2.5-flash-image',
		};
	}
	const model = readEnv('VERTEX_IMAGEN_MODEL') || 'gemini-2.5-flash-image';
	const location = readEnv('GOOGLE_CLOUD_LOCATION') || 'us-central1';
	try {
		const token = await getGcpAccessToken();
		// Minting a token proves the service account, NOT that Vertex will serve.
		// A project in billing dunning hands out tokens happily and then 403s
		// every generative call ("Lightning dunning decision is deny"), which
		// this probe reported as `ok` for a lane that could not paint a single
		// image (observed 2026-08-27). Ask the API itself: listing publisher
		// models is free, needs no quota, and fails with the same project-level
		// denial a real generate would.
		const host = location === 'global' ? 'https://aiplatform.googleapis.com' : `https://${location}-aiplatform.googleapis.com`;
		const res = await fetch(`${host}/v1/publishers/google/models?pageSize=1`, {
			headers: { authorization: `Bearer ${token}` },
			signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
		});
		if (res.ok) return { configured: true, status: 'ok', model, location };
		const body = await res.text().catch(() => '');
		// Name the billing hold explicitly: it reads like an IAM problem and
		// sends operators chasing service-account roles instead of the console.
		const dunning = /dunning/i.test(body);
		return {
			configured: true,
			status: 'down',
			httpStatus: res.status,
			detail: dunning
				? 'project billing is in dunning: generative APIs denied until the billing account is settled'
				: body.slice(0, 120) || `HTTP ${res.status}`,
			model,
			location,
		};
	} catch (err) {
		return { configured: true, status: 'down', detail: err?.message?.slice(0, 120), model, location };
	}
}

// Replicate: authenticated GET /v1/account — 200 proves a valid key + reachable
// host without creating a (billed) prediction.
async function probeReplicate() {
	const token = readEnv('REPLICATE_API_TOKEN');
	if (!token) return { configured: false, status: 'unconfigured' };
	try {
		const res = await fetch('https://api.replicate.com/v1/account', {
			headers: { authorization: `Bearer ${token}` },
			signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
		});
		if (res.status === 200) return { configured: true, status: 'ok' };
		if (res.status === 401) return { configured: true, status: 'down', detail: 'invalid token' };
		return { configured: true, status: res.status < 500 ? 'ok' : 'down', httpStatus: res.status };
	} catch (err) {
		return { configured: true, status: 'down', detail: err?.message?.slice(0, 120) };
	}
}

/**
 * Per-lane configured/reachable health for the /api/v1/ai/image?health=1 probe.
 * Probes only configured lanes; unconfigured lanes report `unconfigured` with no
 * network call. `healthy` is true when at least one lane is reachable, so the
 * probe distinguishes "not wired yet" from "wired but every lane is down".
 */
async function probeHf() {
	if (!readEnv('HF_TOKEN')) return { configured: false, status: 'unconfigured' };
	try {
		const res = await fetch('https://huggingface.co/api/whoami-v2', {
			headers: { authorization: `Bearer ${readEnv('HF_TOKEN')}` },
			signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
		});
		if (res.status === 200) return { configured: true, status: 'ok', providers: ['fal-ai', 'nscale'] };
		if (res.status === 401) return { configured: true, status: 'down', detail: 'invalid token' };
		return { configured: true, status: res.status < 500 ? 'ok' : 'down', httpStatus: res.status };
	} catch (err) {
		return { configured: true, status: 'down', detail: err?.message?.slice(0, 120) };
	}
}

async function probePollinations() {
	try {
		const res = await fetch('https://image.pollinations.ai/', { method: 'HEAD', signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
		return { configured: true, status: res.status < 500 ? 'ok' : 'down', httpStatus: res.status };
	} catch (err) {
		return { configured: true, status: 'down', detail: err?.message?.slice(0, 120) };
	}
}

export async function imageLaneHealth() {
	const [nim, vertex, replicate, hf, pollinations] = await Promise.all([
		probeNim(),
		probeVertex(),
		probeReplicate(),
		probeHf(),
		probePollinations(),
	]);
	const lanes = { nim, vertex, replicate, hf, pollinations };
	const anyConfigured = Object.values(lanes).some((l) => l.configured);
	const anyReachable = Object.values(lanes).some((l) => l.status === 'ok');
	return {
		endpoint: '/api/v1/ai/image',
		configured: anyConfigured,
		healthy: anyReachable,
		lanes,
		// The keyless rung means `configured` is always true, so this names the
		// KEYED lanes an operator has not brought up, not "nothing at all".
		missing_env: [
			...(nim.configured ? [] : IMAGE_LANE_ENV.nim),
			...(vertex.configured ? [] : IMAGE_LANE_ENV.vertex.slice(0, 2)),
			...(hf.configured ? [] : ['HF_TOKEN']),
			...(replicate.configured ? [] : IMAGE_LANE_ENV.replicate),
		],
	};
}
