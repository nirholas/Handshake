// Canonical server-side image understanding (VLM completion) + the platform's
// vision provider policy. The image-side twin of api/_lib/llm.js — same
// free-first doctrine, same spend-ledger discipline, so vision never becomes a
// per-endpoint reinvention that drifts out of policy.
//
// Policy (identical to llm.js — read that file's header for the rationale):
//
//   • FREE NIM VISION LANES FIRST, ALWAYS. NVIDIA NIM hosts several VLMs on the
//     OpenAI-compatible chat host (integrate.api.nvidia.com) at zero marginal
//     cost to the platform. They lead every chain, tried in order, and every
//     consumer must survive on them alone.
//
//   • Paid vision-capable backstop LAST, automatically. When OPENAI_API_KEY is
//     configured, gpt-5.4-nano (vision-capable) is appended to the tail so a
//     request that exhausted the free lanes still succeeds. It never leads, and
//     no consumer hard-fails when it is absent.
//
//   • NOTHING HARD-FAILS ON A VISION OUTAGE. describeImage throws on total
//     failure, but every consumer is required to treat that as "skip the
//     vision-derived enhancement", never as an error the end user sees. See
//     visionConfigured() for the gate, and each consumer's degraded path.
//
// Image input — pass EITHER an http(s) URL (default; the model server fetches it
// — used for first-party R2 URLs and already-validated claim image URLs) OR a
// base64 blob + mimeType (inlined as a data URI). Both verified live against
// every NIM lane; see tasks/nvidia-nim/probes/vision.md.

import { isIP } from 'node:net';
import { env } from './env.js';
import { recordEvent } from './usage.js';
import { costMicroUsd } from './llm-pricing.js';
import { validatePublicUrl, isPrivateAddress, SsrfError } from './ssrf.js';
import { fetchSafePublicUrl } from './ssrf-guard.js';
import {
	vertexGeminiAvailable,
	vertexGeminiModel,
	vertexGeminiChatUrl,
	vertexGeminiHeaders,
} from './vertex-gemini.js';

// Free NIM vision lanes, in order. nemotron-nano carries the smallest image
// token footprint (~281 prompt tokens for a tiny image vs ~1600 for llama-90B);
// llama-3.2-11b is a different model family, so its failure modes are
// independent — a real second lane, not a re-roll of the first.
const NVIDIA_VISION_MODELS = [
	'nvidia/nemotron-nano-12b-v2-vl',
	'meta/llama-3.2-11b-vision-instruct',
];
// Paid last-resort tail. gpt-5.4-nano is vision-capable and already priced in
// llm-pricing.js, keeping the backstop cheap and the spend ledger truthful.
const OPENAI_VISION_MODEL = 'gpt-5.4-nano';

// Thrown when no vision provider is available at all. Carries an HTTP status so
// a handler that *chose* to surface it can return 503 — but consumers should
// generally catch it and degrade silently instead.
export class VisionUnavailableError extends Error {
	constructor(message = 'No vision provider available. Configure NVIDIA_API_KEY (free), GOOGLE_CLOUD_PROJECT (Vertex Gemini credits anchor), or OPENAI_API_KEY (paid backstop).') {
		super(message);
		this.name = 'VisionUnavailableError';
		this.code = 'vision_unavailable';
		this.status = 503;
	}
}

// One OpenAI-compatible vision provider entry. The multimodal user message is
// the only shape difference from llm.js's text providers. `getHeaders` (async)
// replaces the static key header for keyless lanes whose auth is minted per
// request (the Vertex Gemini credits anchor).
function openaiCompatVisionProvider({ name, key, url, model, getHeaders = null }) {
	return {
		name,
		model,
		url,
		...(getHeaders
			? { getHeaders }
			: { headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` } }),
		buildBody: (system, parts, maxTokens) => {
			const messages = [];
			if (system) messages.push({ role: 'system', content: system });
			messages.push({ role: 'user', content: parts });
			return { model, max_tokens: maxTokens, temperature: 0, messages };
		},
		extractText: (r) => r.choices?.[0]?.message?.content || '',
		extractUsage: (r) => ({ input: r.usage?.prompt_tokens ?? 0, output: r.usage?.completion_tokens ?? 0 }),
	};
}

// Build the ordered vision provider chain: free NIM lanes first, then the
// credits-funded Vertex Gemini anchor, paid OpenAI backstop appended last and
// only when its key is set. Exported for the anchor regression tests
// (tests/api/llm-vertex-anchor-surfaces).
export function visionChain() {
	const chain = [];
	if (env.NVIDIA_API_KEY) {
		for (const model of NVIDIA_VISION_MODELS) {
			chain.push(openaiCompatVisionProvider({
				name: 'nvidia',
				key: env.NVIDIA_API_KEY,
				url: 'https://integrate.api.nvidia.com/v1/chat/completions',
				model,
			}));
		}
	}
	// Vertex Gemini credits anchor: multimodal (Gemini Flash reads image_url
	// parts, data URIs included, through the same OpenAI-compatible endpoint),
	// keyless (OAuth token minted per request), billed to GCP credits. Sits
	// after the free NIM lanes and ahead of the paid tail, exactly like the
	// text anchor in llm.js's providerChain: the prod OPENAI_API_KEY is
	// billing-dead, so this rung is what keeps vision answering when the NIM
	// queue throttles or hangs. Nothing may evict it (see api/_lib/vertex-gemini.js).
	if (vertexGeminiAvailable()) {
		chain.push(openaiCompatVisionProvider({
			name: 'vertex-gemini',
			url: vertexGeminiChatUrl(),
			model: vertexGeminiModel(),
			getHeaders: vertexGeminiHeaders,
		}));
	}
	if (env.OPENAI_API_KEY) {
		chain.push(openaiCompatVisionProvider({
			name: 'openai',
			key: env.OPENAI_API_KEY,
			url: 'https://api.openai.com/v1/chat/completions',
			model: OPENAI_VISION_MODEL,
		}));
	}
	return chain;
}

// True when at least one vision provider can serve a request. Use to gate a
// consumer's vision-derived enhancement WITHOUT making the doomed upstream call —
// this is the fail-open switch (forge validation, alt text, image evidence all
// check it first).
export function visionConfigured() {
	return visionChain().length > 0;
}

// Synchronous SSRF guard for a caller-supplied image URL. Requires https (http
// only in dev) and blocks IP-literal hosts in private/loopback/link-local ranges
// plus localhost — the direct SSRF targets reachable through the provider's
// server-side image fetch. DNS-name hosts pass (we can't pin the provider's DNS
// resolution, so name→private rebinding is out of scope here). Throws a 400
// invalid_image_url so callers treat it as bad input, not a vision outage.
function assertSafeImageUrl(rawUrl) {
	let url;
	try {
		url = validatePublicUrl(rawUrl);
	} catch (e) {
		if (e instanceof SsrfError) {
			throw Object.assign(new Error('image URL is not a public https address'), {
				status: 400,
				code: 'invalid_image_url',
			});
		}
		throw e;
	}
	const host = url.hostname.replace(/^\[|\]$/g, '');
	const fam = isIP(host);
	const blocked = fam
		? isPrivateAddress(host, fam)
		: host === 'localhost' || /\.(local|internal|localdomain)$/i.test(host);
	if (blocked) {
		throw Object.assign(new Error('image URL resolves to a non-public host'), {
			status: 400,
			code: 'invalid_image_url',
		});
	}
	return url;
}

// 12 MiB — matches /api/vision's inbound cap; comfortably covers a viewer
// screenshot or photo while bounding the per-request buffer.
const MAX_INLINE_IMAGE_BYTES = 12 * 1024 * 1024;

// Fetch a caller-supplied image URL ourselves and return it as inline base64.
// The provider model servers otherwise fetch imageUrl server-side, and hosts
// with hotlink / User-Agent protection (Wikipedia thumbnails, some CDNs) reject
// that fetch — which fails EVERY URL-based lane and forces a fall-through to the
// paid backstop. Fetching here (SSRF-guarded, redirects re-validated per hop)
// makes the free NIM lanes independent of whether the provider can reach the
// host. Throws on non-2xx, oversize, or transport error so the caller can decide
// whether to fall back to URL pass-through.
async function inlineImageFromUrl(imageUrl, { timeoutMs = 8_000 } = {}) {
	const res = await fetchSafePublicUrl(imageUrl, {
		signal: AbortSignal.timeout(timeoutMs),
		// A browser-like UA + image Accept gets past CDNs that reject empty/bot
		// user-agents — the same gate that blocks the providers' own fetchers.
		headers: {
			'user-agent': 'Mozilla/5.0 (compatible; three.ws-vision/1.0; +https://three.ws)',
			accept: 'image/avif,image/webp,image/png,image/*;q=0.8,*/*;q=0.5',
		},
	});
	if (!res.ok) throw Object.assign(new Error(`image fetch ${res.status}`), { status: res.status });
	const advertised = Number(res.headers.get('content-length') || 0);
	if (advertised > MAX_INLINE_IMAGE_BYTES) {
		throw Object.assign(new Error('image exceeds inline size cap'), { status: 413 });
	}
	const buf = Buffer.from(await res.arrayBuffer());
	if (buf.length > MAX_INLINE_IMAGE_BYTES) {
		throw Object.assign(new Error('image exceeds inline size cap'), { status: 413 });
	}
	const ct = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
	return { imageBase64: buf.toString('base64'), mimeType: ct.startsWith('image/') ? ct : 'image/jpeg' };
}

// Normalize a caller's image spec into one OpenAI `image_url` content part.
// Accepts { imageUrl } (pass-through) or { imageBase64, mimeType } (data URI).
function imagePart({ imageUrl, imageBase64, mimeType = 'image/jpeg' }) {
	if (imageUrl) return { type: 'image_url', image_url: { url: imageUrl } };
	if (imageBase64) {
		const raw = imageBase64.startsWith('data:') ? imageBase64 : `data:${mimeType};base64,${imageBase64}`;
		return { type: 'image_url', image_url: { url: raw } };
	}
	throw Object.assign(new Error('describeImage requires imageUrl or imageBase64'), {
		status: 400,
		code: 'no_image',
	});
}

// Map a non-2xx vision response to a normalized error code, mirroring the other
// NIM provider contracts (probes/vision.md error table). Folded into lastErr so
// the final throw after the whole chain fails carries a meaningful code.
function normalizeStatus(status) {
	if (status === 401 || status === 403) return 'invalid_key';
	if (status === 402) return 'insufficient_credits';
	if (status === 429) return 'rate_limited';
	if (status >= 500) return 'provider_error';
	return 'provider_error';
}

// Describe / analyze one image against a prompt, against the first available
// provider, falling over to the next on transport or non-2xx errors.
//
//   { prompt, imageUrl? , imageBase64?, mimeType?, system?, maxTokens?,
//     timeoutMs?, track? }
//
// `timeoutMs` bounds EACH provider attempt so a hung free lane can't stall a
// serverless function — the next lane is tried instead. `deadlineMs` bounds the
// WHOLE chain: without it, a handful of lanes each timing out at `timeoutMs`
// sequentially can blow past the function's wall-clock limit, which is exactly
// what produced the "Vercel Runtime Timeout Error: Task timed out after 30s" 504
// on /api/vision (3 free NIM models + a paid backstop × 20s each ≫ 30s). With a
// deadline we stop walking the chain and return a clean 504 before the platform
// hard-kills the invocation. Each attempt is capped at min(timeoutMs, time left).
// `track` is the same optional spend-ledger attribution as llmComplete; a
// successful call records a kind:'vision' usage event with provider/model/tokens/cost
// (free NIM prices to 0 in llm-pricing.js).
//
// Returns { text, provider, model, usage:{input,output}, raw }.
// Throws VisionUnavailableError when nothing is configured, or the last upstream
// error (with .status = 502/504, .code = normalized) when every provider failed
// or the deadline elapsed.
export async function describeImage({
	prompt,
	imageUrl = null,
	imageBase64 = null,
	mimeType = 'image/jpeg',
	system = null,
	maxTokens = 512,
	timeoutMs = 20_000,
	deadlineMs = null,
	track = null,
}) {
	const chain = visionChain();
	if (!chain.length) throw new VisionUnavailableError();
	const deadlineAt = deadlineMs != null ? Date.now() + deadlineMs : Infinity;

	// SSRF guard: the provider's model server fetches `imageUrl` server-side, so a
	// caller-supplied URL could otherwise reach internal targets (169.254.169.254,
	// localhost, RFC1918) through the provider. We can't DNS-pin the provider's
	// fetch, so apply a synchronous string-level guard — require https and reject
	// private/loopback/link-local IP literals + localhost — before the URL leaves
	// this process. Centralized here so every consumer of describeImage is covered,
	// not just the forge image-validate path that already pre-validates.
	if (imageUrl) assertSafeImageUrl(imageUrl);

	// Prefer inlining the image ourselves over handing the URL to each provider's
	// server-side fetcher. If our own fetch fails (a host the provider CAN reach
	// but we can't, or a transient error), fall back to URL pass-through so we
	// never regress a currently-working path. Bounded by the remaining chain
	// deadline so a slow image host can't blow the whole budget before a lane runs.
	if (imageUrl && !imageBase64) {
		try {
			const budget = Math.max(1_000, Math.min(timeoutMs, deadlineAt - Date.now()));
			const inlined = await inlineImageFromUrl(imageUrl, { timeoutMs: budget });
			imageBase64 = inlined.imageBase64;
			mimeType = inlined.mimeType;
			imageUrl = null;
		} catch {
			// keep imageUrl set — the providers will try their own server-side fetch
		}
	}

	const parts = [
		{ type: 'text', text: prompt },
		imagePart({ imageUrl, imageBase64, mimeType }),
	];

	let lastErr;
	for (const p of chain) {
		// Stop walking the chain once the overall budget is spent — returning a clean
		// 504 here beats letting the platform hard-kill the function mid-request.
		const remaining = deadlineAt - Date.now();
		if (remaining <= 0) {
			lastErr = Object.assign(new Error('vision deadline exceeded before a provider answered'), {
				status: 504,
				code: 'deadline_exceeded',
			});
			break;
		}
		const attemptTimeout = Math.min(timeoutMs, remaining);
		const startedAt = Date.now();
		let upstream;
		try {
			// Keyless lanes (the Vertex Gemini credits anchor) mint their auth per
			// attempt via getHeaders; a token-exchange failure lands in the catch
			// below and fails over to the next lane like any transport error.
			upstream = await fetch(p.url, {
				method: 'POST',
				headers: p.getHeaders ? await p.getHeaders() : p.headers,
				body: JSON.stringify(p.buildBody(system, parts, maxTokens)),
				signal: AbortSignal.timeout(attemptTimeout),
			});
		} catch (e) {
			lastErr = Object.assign(new Error(`${p.name} vision unreachable: ${e.message}`), { status: 502, code: 'provider_unreachable' });
			continue;
		}
		if (!upstream.ok) {
			const body = await upstream.text().catch(() => '');
			lastErr = Object.assign(
				new Error(`${p.name} vision ${upstream.status}: ${body.slice(0, 200)}`),
				{ status: 502, code: normalizeStatus(upstream.status) },
			);
			continue;
		}
		const data = await upstream.json();
		const usage = p.extractUsage(data);
		recordVisionSpend(p, usage, Date.now() - startedAt, track);
		return {
			text: (p.extractText(data) || '').trim(),
			provider: p.name,
			model: p.model,
			usage,
			raw: data,
		};
	}
	throw lastErr || new VisionUnavailableError();
}

// Convenience: describeImage + tolerant JSON parse of the reply. VLMs reliably
// honor "reply ONLY JSON" (probes/vision.md) but may wrap it in a ```json fence
// or a trailing newline; this strips both. Returns the parsed object plus the
// provider metadata, or throws if the model returned unparseable text (the
// caller's degraded path handles that exactly like a vision outage).
export async function describeImageJson(opts) {
	const result = await describeImage(opts);
	return { ...result, json: parseJsonLoose(result.text) };
}

// Strip a ```json fence / stray prose and parse the first JSON object/array in
// the text. Throws a normalized error on failure so callers treat it as a
// degraded vision result.
export function parseJsonLoose(text) {
	const trimmed = String(text || '').trim();
	const fenced = trimmed.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
	const start = fenced.search(/[[{]/);
	const candidate = start >= 0 ? fenced.slice(start) : fenced;
	try {
		return JSON.parse(candidate);
	} catch {
		// Last resort: grab the outermost {...} or [...] span.
		const m = candidate.match(/[{[][\s\S]*[}\]]/);
		if (m) {
			try {
				return JSON.parse(m[0]);
			} catch {
				/* fall through */
			}
		}
		throw Object.assign(new Error('vision reply was not valid JSON'), { status: 502, code: 'vision_bad_json' });
	}
}

// Fire-and-forget spend ledger write for one vision call. Free NIM prices to 0;
// the paid OpenAI backstop prices via llm-pricing.js. Never throws.
function recordVisionSpend(provider, usage, latencyMs, track) {
	const input = usage?.input ?? 0;
	const output = usage?.output ?? 0;
	recordEvent({
		kind: 'vision',
		provider: provider.name,
		model: provider.model,
		inputTokens: input,
		outputTokens: output,
		costMicroUsd: costMicroUsd({ provider: provider.name, model: provider.model, input, output }),
		latencyMs,
		userId: track?.userId ?? null,
		agentId: track?.agentId ?? null,
		avatarId: track?.avatarId ?? null,
		clientId: track?.clientId ?? null,
		apiKeyId: track?.apiKeyId ?? null,
		tool: track?.tool ?? null,
		meta: track?.meta ?? undefined,
	});
}
