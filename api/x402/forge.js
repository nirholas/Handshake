// POST /api/x402/forge   { prompt | image_urls[], tier?, aspect_ratio? }
//
// Paid, autonomous 3D generation. The free /api/forge endpoint is browser-facing
// and IP-rate-limited; this is its pay-per-call twin for AI agents that settle in
// USDC with no account, key, or signup — cataloged by the CDP x402 Bazaar.
//
// One payment buys one generation. After verifying payment the server submits the
// real Forge job, then settles. Text→3D runs on the FREE NVIDIA NIM TRELLIS lane
// (native text→mesh, zero vendor cost) as the primary engine for every tier; if
// that lane is unconfigured or unavailable it degrades to the FLUX→TRELLIS
// reconstruct lane so a paid call never dead-ends. Image→3D (caller-supplied
// reference views) always reconstructs — NVIDIA's hosted preview is text-only.
// The response hands back a job token the buyer polls for FREE on the existing
// provider-aware endpoint, OR — when the free lane completes inside the submit
// window (typical for draft) — the finished GLB url inline with status:"done":
//   GET /api/forge?job=<job_id>   → { status, glb_url, ... }
//
// Pricing is per-tier and lives in one place (api/_lib/forge-tiers.js): draft
// $0.05, standard $0.15, high $0.50. The 402 challenge quotes the price for the
// requested tier. GET /api/x402/forge (no payment) returns the price catalog so
// developers can discover cost before paying.
//
// Generation is submitted AFTER verify but BEFORE settle: if the text-to-image
// or reconstruction submit fails, settlement never runs and the buyer isn't
// charged. The job token is the upstream prediction id, identical to what the
// free endpoint issues, so a single poll path serves both.
//
// Network: Solana mainnet (USDC) only. verifyPayment / settlePayment in
// x402-spec.js route per network. Base is offered solely as a dev/preview
// failsafe when X402_PAY_TO_SOLANA is unset; production sets it, so the live
// route quotes Solana only.

import { wrap, cors, error, json, rateLimited, readBody } from '../_lib/http.js';
import {
	NETWORK_BASE_MAINNET,
	NETWORK_SOLANA_MAINNET,
	send402,
	verifyPayment,
	settlePayment,
	encodePaymentResponseHeader,
	permit2VariantOf,
	resolveResourceUrl,
} from '../_lib/x402-spec.js';
import { env } from '../_lib/env.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import {
	PAYMENT_IDENTIFIER,
	checkCache,
	claimSlotOrRespond,
	extractIdFromHeader,
	hashPaymentProof,
	hashRequestPayload,
	paymentIdentifierExtension,
	releaseSlot,
	storeResponse,
	writeCachedResponse,
	writeConflict,
} from '../_lib/x402/payment-identifier-server.js';
import { installAccessControl } from '../_lib/x402/access-control.js';
import { withService } from '../_lib/x402/bazaar-helpers.js';
import { assertSafePublicUrl } from '../_lib/ssrf-guard.js';
import { textToImage } from '../_mcp3d/text-to-image.js';
import { createRegenProvider } from '../_providers/replicate.js';
import { createNvidiaProvider } from '../_providers/nvidia.js';
import { encodeJobToken } from '../_lib/forge-job-token.js';
import {
	TIER_IDS,
	DEFAULT_TIER,
	resolveTier,
	priceAtomicsForTier,
	priceUsdcForTier,
	estimateEtaSeconds,
	preferFreeReconstruct,
	buildCatalog,
} from '../_lib/forge-tiers.js';
import {
	FORGE_SERVICE_NAME,
	FORGE_TAGS,
	FORGE_ASPECT_RATIOS,
	FORGE_MAX_VIEWS,
	FORGE_ROUTE_DESCRIPTION,
	FORGE_INPUT_SCHEMA,
	FORGE_BAZAAR,
} from '../_lib/forge-listing.js';
import { llmComplete } from '../_lib/llm.js';
import { randomUUID } from 'node:crypto';
import {
	attachX402Provenance,
	createCreation,
	forgeStoreEnabled,
	hashClient,
	materializeCreation,
} from '../_lib/forge-store.js';

const ROUTE = '/api/x402/forge';
const REQUIRED_SCOPE = 'x402:bypass';
const accessControl = installAccessControl({ requiredScope: REQUIRED_SCOPE });
const routeConfig = { path: ROUTE, method: 'POST', requiredScope: REQUIRED_SCOPE };

const VALID_ASPECT = new Set(FORGE_ASPECT_RATIOS);
const HTTP_URL_RE = /^https:\/\/[^\s]+$/i;
const MAX_VIEWS = FORGE_MAX_VIEWS;
// The reconstruct lane: serves image→3D (NVIDIA's hosted preview can't take user
// photos) and the text→3D fallback when the free NVIDIA NIM lane is unavailable.
const BACKEND = 'trellis';

// ── Content-generation health probe (mode:"health_check") ───────────────────────
// A full text→3D job is slow ($0.05, tens of seconds) — too heavy to canary on a
// tight schedule. This lightweight mode exercises the generative AI lanes at the
// floor price ($0.001) without reconstruction:
//   type:"text"  — one real LLM text completion; proves prompt understanding alive.
//   type:"image" — one real text→image call through the provider chain (NIM FLUX →
//                  Vertex Imagen → Replicate backstop) and persists the result to
//                  R2 CDN, proving the full image generation + CDN upload path.
// Both types return a measured verdict the autonomous loop alerts on.
const HEALTH_CHECK_PRICE_ATOMIC = 1000; // $0.001 USDC
// Text latency SLA: LLM completion is fast; >5s means the provider is degraded.
const HEALTH_CHECK_BUDGET_MS = 5000;
// Image latency SLA: image generation takes longer; >30s means a hung provider.
const HEALTH_CHECK_IMAGE_BUDGET_MS = 30_000;
const HEALTH_CHECK_DEFAULT_PROMPT = 'Write one sentence about Solana.';
const HEALTH_CHECK_IMAGE_DEFAULT_PROMPT = 'A simple blue circle.';

// Discovery/listing metadata is defined once in ../_lib/forge-listing.js and
// imported by BOTH this live 402 challenge and the api/wk.js discovery mirror, so
// the two can never drift. Re-exposed under the endpoint's local names to keep
// the challenge/handler code below unchanged.
const ROUTE_DESCRIPTION = FORGE_ROUTE_DESCRIPTION;
const INPUT_SCHEMA = FORGE_INPUT_SCHEMA;
const ROUTE_BAZAAR = FORGE_BAZAAR;

function buildRequirements(resourceUrl, priceAtomics) {
	const amount = String(priceAtomics);
	// The paid Forge settles in USDC on Solana mainnet ONLY. Base/EVM is
	// intentionally not offered — every quote on this route is a Solana 402.
	if (env.X402_PAY_TO_SOLANA) {
		return [
			{
				scheme: 'exact',
				network: NETWORK_SOLANA_MAINNET,
				amount,
				payTo: env.X402_PAY_TO_SOLANA,
				asset: env.X402_ASSET_MINT_SOLANA,
				maxTimeoutSeconds: 60,
				resource: resourceUrl,
				extra: { name: 'USDC', decimals: 6, feePayer: env.X402_FEE_PAYER_SOLANA },
			},
		];
	}
	// Failsafe for a dev/preview deploy where Solana isn't configured: fall back to
	// Base so the route never dead-ends with an empty 402. Production sets
	// X402_PAY_TO_SOLANA, so this branch never runs there and the route stays
	// Solana-only in the live product.
	const eip3009 = {
		scheme: 'exact',
		network: NETWORK_BASE_MAINNET,
		amount,
		payTo: env.X402_PAY_TO_BASE,
		asset: env.X402_ASSET_ADDRESS_BASE,
		maxTimeoutSeconds: 60,
		resource: resourceUrl,
		extra: { name: 'USD Coin', version: '2', decimals: 6 },
	};
	const out = [eip3009];
	const permit2 = permit2VariantOf(eip3009);
	if (permit2) out.push(permit2);
	return out;
}

// Submit the real generation job and return its poll token (or the finished GLB
// when the lane completes inline). Text→3D runs on the free NVIDIA NIM TRELLIS
// lane first; if that lane is unconfigured or unavailable it degrades to the
// FLUX→TRELLIS reconstruct lane so a paid call never dead-ends. Image→3D always
// reconstructs (NVIDIA's hosted preview is text-only). Throws on any submit
// failure so the caller can avoid settling payment.
export async function submitGeneration({ prompt, imageUrls, isImageMode, aspect, tier }) {
	// Text prompts → the free NVIDIA NIM TRELLIS lane first (zero vendor cost).
	if (!isImageMode) {
		const viaNvidia = await submitTextViaNvidia({ prompt, tier });
		if (viaNvidia) return viaNvidia;
		// NIM unconfigured / unreachable / over capacity — fall through to the
		// reconstruct lanes so the paid call still produces a model.
	}
	// Free-first: prefer the free HuggingFace Spaces reconstruct lane BEFORE the
	// paid Replicate default, so a paid call never spends on — or dead-ends against
	// — the paid account while a free lane can serve it. Reversible via
	// FORGE_PREFER_FREE=false. Returns null when the lane is unavailable (no
	// HF_TOKEN) or it fails, so the call falls through to the Replicate reconstruct.
	if (preferFreeReconstruct()) {
		const viaHf = await submitViaHuggingFace({ prompt, imageUrls, isImageMode, aspect, tier });
		if (viaHf) return viaHf;
	}
	return submitViaReconstruct({ prompt, imageUrls, isImageMode, aspect, tier });
}

// Free HuggingFace Spaces reconstruct lane — the free-first alternative to the
// paid Replicate reconstruct. Text→3D synthesizes a reference view first (free
// NVIDIA FLUX where configured); image→3D reconstructs the caller's views
// directly. HF blocks until the GLB is ready, so completion is synchronous — we
// persist the result to R2 (the Space file URL is ephemeral) and hand back a
// durable url with status:"done". Returns null when the lane is unavailable / it
// fails, so submitGeneration falls through to Replicate. Never throws: a free-lane
// hiccup must degrade, not fail the whole paid call.
async function submitViaHuggingFace({ prompt, imageUrls, isImageMode, aspect, tier }) {
	let provider;
	try {
		const mod = await import('../_providers/huggingface.js');
		provider = mod.createRegenProvider();
	} catch (err) {
		console.warn(`[x402/forge] free HuggingFace lane unavailable: ${err?.message || err}`);
		return null;
	}

	try {
		let referenceImageUrl;
		let views;
		if (isImageMode) {
			// Caller-supplied views are fetched by the upstream Space — SSRF-guard
			// them before forwarding, same as the reconstruct lane.
			for (const u of imageUrls) await assertSafePublicUrl(u);
			views = imageUrls;
			referenceImageUrl = imageUrls[0];
		} else {
			const synthesized = await textToImage(prompt, { aspectRatio: aspect });
			referenceImageUrl = synthesized.imageUrl;
			views = [referenceImageUrl];
		}

		const submitted = await provider.submit({
			mode: 'reconstruct',
			sourceUrl: referenceImageUrl,
			params: { images: views, prompt: prompt || undefined },
		});
		const finished = await provider.status(submitted.extJobId);
		const glbUrl = finished?.resultGlbUrl;
		if (!glbUrl) throw new Error('HuggingFace returned no GLB');

		const backend = 'huggingface';
		return {
			job_id: null,
			status: 'done',
			poll_url: null,
			glb_url: (await persistRemoteGlb(glbUrl)) || glbUrl,
			mode: isImageMode ? 'image_to_3d' : 'text_to_3d',
			tier: resolveTier(tier).id,
			backend,
			eta_seconds: estimateEtaSeconds({ backendId: BACKEND, tier }),
			price_usdc: priceUsdcForTier(tier),
		};
	} catch (err) {
		console.warn(`[x402/forge] free HuggingFace lane failed: ${err?.message || err}`);
		return null;
	}
}

// Copy a generated GLB into R2 so the buyer's url survives the Space's ephemeral
// file storage; fail-soft (returns null) so the caller can hand back the raw HF
// url rather than fail a delivered generation over a copy hiccup.
async function persistRemoteGlb(url) {
	try {
		const res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
		if (!res.ok) return null;
		const buf = Buffer.from(await res.arrayBuffer());
		if (!buf.length) return null;
		const { putObject, publicUrl } = await import('../_lib/r2.js');
		const key = `forge/huggingface/${randomUUID()}.glb`;
		await putObject({ key, body: buf, contentType: 'model/gltf-binary' });
		return publicUrl(key);
	} catch {
		return null;
	}
}

// Free NVIDIA NIM native text→3D. Returns the finished/queued response shape, or
// null when the lane is unavailable so submitGeneration can fall back. Never
// throws: a free-lane hiccup must degrade, not fail the whole paid call.
async function submitTextViaNvidia({ prompt, tier }) {
	let provider;
	try {
		provider = createNvidiaProvider();
	} catch (err) {
		console.warn(`[x402/forge] free NVIDIA NIM lane unavailable: ${err?.message || err}`);
		return null;
	}

	let submitted;
	try {
		submitted = await provider.textTo3d({ prompt, tier });
	} catch (err) {
		console.warn(`[x402/forge] free NVIDIA NIM text→3D failed: ${err?.message || err}`);
		return null;
	}

	const backend = 'nvidia';
	const base = {
		mode: 'text_to_3d',
		tier: resolveTier(tier).id,
		backend,
		eta_seconds: estimateEtaSeconds({ backendId: backend, tier }),
		price_usdc: priceUsdcForTier(tier),
	};

	// Synchronous completion: NVCF already persisted the GLB to R2 inside the
	// submit window (typical for draft). Hand back the durable url directly — the
	// buyer's client renders it without polling.
	if (submitted?.resultGlbUrl) {
		return { job_id: null, status: 'done', poll_url: null, glb_url: submitted.resultGlbUrl, ...base };
	}

	// Async: wrap the NVCF request id in a signed forge token so the free poll
	// endpoint routes the status check back to the NIM provider.
	if (submitted?.taskId) {
		const token = encodeJobToken({ provider: 'nvidia', kind: submitted.kind, taskId: submitted.taskId });
		return {
			job_id: token,
			status: 'queued',
			poll_url: `/api/forge?job=${encodeURIComponent(token)}`,
			...base,
		};
	}

	// Neither a url nor a task id came back — treat as unavailable and fall back.
	console.warn('[x402/forge] NVIDIA NIM returned neither a GLB nor a task id; falling back');
	return null;
}

// FLUX→TRELLIS reconstruct lane: synthesize a reference image from the prompt
// (text fallback) or take the caller's reference views (image→3D), then
// reconstruct to a mesh on Replicate TRELLIS. The token is the upstream
// prediction id, pollable on GET /api/forge?job=.
async function submitViaReconstruct({ prompt, imageUrls, isImageMode, aspect, tier }) {
	let provider;
	try {
		provider = createRegenProvider();
	} catch {
		throw Object.assign(new Error('Generation is not configured on this deployment.'), {
			status: 503,
			code: 'unconfigured',
		});
	}

	let referenceImageUrl;
	let views;
	if (isImageMode) {
		// Caller-supplied views are fetched by the upstream reconstructor — guard
		// them against SSRF before we forward them, same as the MCP studio path.
		for (const u of imageUrls) await assertSafePublicUrl(u);
		views = imageUrls;
		referenceImageUrl = imageUrls[0];
	} else {
		const synthesized = await textToImage(prompt, { aspectRatio: aspect });
		referenceImageUrl = synthesized.imageUrl;
		views = [referenceImageUrl];
	}

	const job = await provider.submit({
		mode: 'reconstruct',
		sourceUrl: referenceImageUrl,
		params: { images: views, prompt: prompt || undefined },
	});

	const jobId = job.extJobId || job.jobId;
	if (!jobId) {
		throw Object.assign(new Error('Reconstruction submit returned no job id.'), {
			status: 502,
			code: 'submit_failed',
		});
	}
	return {
		job_id: jobId,
		status: 'queued',
		poll_url: `/api/forge?job=${encodeURIComponent(jobId)}`,
		mode: isImageMode ? 'image_to_3d' : 'text_to_3d',
		tier: resolveTier(tier).id,
		backend: BACKEND,
		eta_seconds: estimateEtaSeconds({ backendId: BACKEND, tier }),
		price_usdc: priceUsdcForTier(tier),
	};
}

// Run the content-generation health probe. Never throws — a provider outage is
// the very signal this probe exists to catch, so it always returns a settled
// verdict (generated:false) rather than failing the paid call.
//   healthType:"text"  — one fast LLM text completion, proves the prompt-
//                        understanding lane is alive within HEALTH_CHECK_BUDGET_MS.
//   healthType:"image" — one real text→image call through the free-first provider
//                        chain (NIM FLUX → Vertex Imagen → Replicate), uploads the
//                        result to R2 CDN, and returns the durable url — proving
//                        the full image generation + CDN upload path is alive.
export async function runForgeHealthCheck({ prompt, healthType = 'text' }) {
	if (healthType === 'image') return runForgeImageHealthCheck(prompt);
	const probePrompt = (prompt && prompt.length >= 3 ? prompt : HEALTH_CHECK_DEFAULT_PROMPT);
	const t0 = Date.now();
	try {
		const { text, provider, model, usage } = await llmComplete({
			system: 'You are a concise assistant. Reply in a single short sentence.',
			user: probePrompt,
			maxTokens: 64,
			// Bound each provider attempt to the SLA so a hung upstream can't stall the
			// probe; latency_ms still reports the real measured round-trip.
			timeoutMs: HEALTH_CHECK_BUDGET_MS,
			track: { tool: 'forge-health-check' },
		});
		const latencyMs = Date.now() - t0;
		const out = (text || '').trim();
		// Prefer the provider-reported output token count; fall back to a coarse
		// char/4 estimate only if usage is missing so the field is always populated.
		const tokenCount = usage?.output ?? Math.ceil(out.length / 4);
		return {
			mode: 'health_check',
			type: 'text',
			generated: out.length > 0,
			latency_ms: latencyMs,
			token_count: tokenCount,
			within_budget: latencyMs <= HEALTH_CHECK_BUDGET_MS,
			provider,
			model,
			sample: out.slice(0, 200),
		};
	} catch (err) {
		const latencyMs = Date.now() - t0;
		console.warn(`[x402/forge] health_check generation failed: ${err?.message || err}`);
		return {
			mode: 'health_check',
			type: 'text',
			generated: false,
			latency_ms: latencyMs,
			token_count: 0,
			within_budget: false,
			error: err?.code || 'generation_failed',
		};
	}
}

// Image generation health probe: one real text→image call through the free-first
// provider chain (NIM FLUX → Vertex Imagen → Replicate backstop), persisting the
// result to R2 CDN. The returned url proves the full generation + upload path is
// alive; a missing url means the image provider chain is down or unconfigured.
async function runForgeImageHealthCheck(prompt) {
	const probePrompt = prompt && prompt.length >= 3 ? prompt : HEALTH_CHECK_IMAGE_DEFAULT_PROMPT;
	const t0 = Date.now();
	try {
		const { imageUrl, model } = await textToImage(probePrompt, { aspectRatio: '1:1' });
		const latencyMs = Date.now() - t0;
		return {
			mode: 'health_check',
			type: 'image',
			generated: !!imageUrl,
			url: imageUrl || null,
			latency_ms: latencyMs,
			within_budget: latencyMs <= HEALTH_CHECK_IMAGE_BUDGET_MS,
			model: model || null,
		};
	} catch (err) {
		const latencyMs = Date.now() - t0;
		console.warn(`[x402/forge] health_check image generation failed: ${err?.message || err}`);
		return {
			mode: 'health_check',
			type: 'image',
			generated: false,
			url: null,
			latency_ms: latencyMs,
			within_budget: false,
			error: err?.code || 'generation_failed',
		};
	}
}

// Map a submitGeneration failure onto the right HTTP response. A provider 429 is
// a transient throttle (Replicate's create-prediction limit, tightest when the
// account runs low on credit). Because submit runs BEFORE settle, the payment
// was never taken — so we answer 429 with a Retry-After hint and say so plainly,
// rather than burying it as a generic 5xx the buyer can't reason about.
export function respondGenerationError(res, err) {
	if (err?.status === 429 || err?.code === 'rate_limited') {
		const retryAfter =
			Number.isFinite(err?.retryAfter) && err.retryAfter > 0 ? Math.ceil(err.retryAfter) : 5;
		res.setHeader('retry-after', String(retryAfter));
		// Own the buyer-facing copy here rather than echoing err.message: the
		// upstream throttle text can name the generator account's internal credit
		// balance, and only this payment boundary can truthfully promise the
		// payment wasn't taken (submit runs before settle).
		return error(
			res,
			429,
			'rate_limited',
			'Generation is briefly busy and your payment was not taken — retry in a few seconds.',
			{ retry_after: retryAfter },
		);
	}
	// The only reconstruct lane left was the platform's PAID vendor account and it
	// is out of credit. The vendor's raw "buy credit" message is our internal
	// billing state — never relay it to the buyer. Submit runs before settle, so
	// the payment was not taken; say so and answer with an honest unavailable state.
	if (isPaidCreditFailure(err)) {
		console.warn(`[x402/forge] paid reconstruct lane out of credit, no free lane: ${err?.message || err}`);
		res.setHeader('retry-after', '30');
		return error(
			res,
			503,
			'generation_unavailable',
			'Free 3D generation is temporarily unavailable and your payment was not taken — please retry shortly.',
			{ retry_after: 30 },
		);
	}
	// Catch-all. A 5xx here is a server/vendor fault whose raw message can carry
	// upstream provider detail (vendor error bodies, billing/credit text, a vendor
	// URL) — never relay it. Mask to neutral, actionable copy and keep the detail
	// in the server log. Submit runs before settle, so the payment was not taken.
	const status = err?.status || 502;
	if (status >= 500) {
		console.warn(`[x402/forge] generation failed (${status}): ${err?.message || err}`);
		return error(
			res,
			status,
			err?.code || 'generation_failed',
			'Generation could not complete and your payment was not taken — please retry shortly.',
		);
	}
	// A 4xx is a client-input fault (bad prompt/url) with a safe, actionable message.
	return error(res, status, err?.code || 'generation_failed', err?.message);
}

// A leaked paid-account billing/credit message from the platform's own vendor
// (e.g. Replicate "insufficient credit to run this model… purchase credit") is
// internal infra state, never shown to the buyer. The x402 forge lane is always
// platform-keyed (no BYOK), so any credit failure here is ours to absorb.
export function isPaidCreditFailure(err) {
	if (err?.providerStatus === 402) return true;
	const text = `${err?.message || ''} ${err?.providerDetail || ''}`.toLowerCase();
	return /insufficient credit|purchase credit|account\/billing|out of credit|not enough credit/.test(text);
}

// GET — free price/usage discovery. No payment, no generation.
function handleGet(req, res) {
	const url = new URL(req.url, 'http://localhost');
	// A stray ?job= on this route is a common mistake — point callers at the
	// free poll endpoint rather than 404-ing them.
	if (url.searchParams.get('job')) {
		return json(res, 400, {
			error: 'wrong_endpoint',
			message: 'Poll generations on GET /api/forge?job=<id> (free), not here.',
		});
	}
	const catalog = buildCatalog();
	return json(res, 200, {
		route: ROUTE,
		description: ROUTE_DESCRIPTION,
		method: 'POST',
		input_schema: INPUT_SCHEMA,
		poll: 'GET /api/forge?job=<id>',
		pricing_usdc: catalog.tiers.map((t) => ({ tier: t.id, price_usdc: t.price_usdc })),
	});
}

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,POST,OPTIONS', origins: '*' })) return;

	if (req.method === 'GET') return handleGet(req, res);
	if (req.method !== 'POST') {
		res.setHeader('allow', 'GET, POST');
		return error(res, 405, 'method_not_allowed', 'use POST to generate, GET for pricing');
	}

	// Light rate limit on the public (pre-payment) path so the 402 challenge and
	// validation can't be hammered. Generation itself is paywalled.
	const rl = await limits.publicIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	// Read the raw body once so we can both validate and hash it for idempotency.
	// Must go through readBody: the Cloud Run server's body parsers drain the
	// request stream before handlers run (bytes preserved on req.rawBody), so a
	// direct stream read here yields an empty body in production.
	let rawBody = '';
	try {
		rawBody = (await readBody(req, 1_000_000)).toString('utf8');
	} catch (err) {
		return error(res, err.status || 400, 'body_read_failed', err.message || 'could not read request body');
	}
	// Re-expose the parsed body to parseRequest via a tiny shim (readJson reads
	// the stream, which is already consumed — parse here instead).
	let parsed;
	try {
		const bodyObj = rawBody ? JSON.parse(rawBody) : {};
		parsed = await parseRequestFromObject(bodyObj);
	} catch (err) {
		if (err.status) return error(res, err.status, err.code, err.message);
		return error(res, 400, 'invalid_json', 'Request body must be valid JSON.');
	}

	const resourceUrl = resolveResourceUrl(req, ROUTE);
	// The health-check probe does no reconstruction, so it is priced at the floor
	// ($0.001) rather than the tier price the 3D generation lanes quote.
	const priceAtomics = parsed.isHealthCheck ? HEALTH_CHECK_PRICE_ATOMIC : priceAtomicsForTier(parsed.tier);
	const requirements = buildRequirements(resourceUrl, priceAtomics);
	const service = withService({
		serviceName: FORGE_SERVICE_NAME,
		tags: [...FORGE_TAGS],
	});
	const challenge = {
		resourceUrl,
		accepts: requirements,
		description: ROUTE_DESCRIPTION,
		bazaar: ROUTE_BAZAAR,
		extensions: { [PAYMENT_IDENTIFIER]: paymentIdentifierExtension(false) },
		serviceName: service.serviceName,
		tags: service.tags,
		iconUrl: service.iconUrl,
	};

	// Internal / subscription / OAuth callers bypass payment.
	const acResult = await accessControl(req, routeConfig);
	if (acResult?.abort) {
		if (acResult.headers)
			for (const [k, v] of Object.entries(acResult.headers)) res.setHeader(k, v);
		return error(
			res,
			acResult.status || 403,
			acResult.code || 'access_denied',
			acResult.reason || 'access denied',
		);
	}
	if (acResult?.grantAccess) {
		let result;
		if (parsed.isHealthCheck) {
			result = await runForgeHealthCheck(parsed);
		} else {
			try {
				result = await submitGeneration(parsed);
			} catch (err) {
				return respondGenerationError(res, err);
			}
		}
		if (acResult.headers)
			for (const [k, v] of Object.entries(acResult.headers)) res.setHeader(k, v);
		res.setHeader('x-payment-bypass', acResult.reason || 'granted');
		res.setHeader('cache-control', 'no-store');
		res.setHeader('content-type', 'application/json; charset=utf-8');
		res.end(JSON.stringify(result));
		return;
	}

	const paymentHeader = req.headers['x-payment'] || req.headers['payment-signature'];
	if (!paymentHeader) return send402(res, challenge);

	// A probe with no actual generation request can't be fulfilled even once paid.
	if (parsed.isProbe) {
		return error(res, 400, 'missing_input', 'Provide a prompt or image_urls to generate.');
	}

	// Idempotency: a retried payment (same id, same body) returns the SAME job
	// token instead of submitting a second generation and double-charging.
	const clientPaymentId = extractIdFromHeader(paymentHeader);
	const payloadHash = hashRequestPayload({ method: 'POST', url: ROUTE, body: rawBody });
	const paymentHash = hashPaymentProof(paymentHeader);
	// Always-on replay guard: the payment-identifier extension is client-opt-in,
	// so when the client omits it we fall back to the proof hash itself as the
	// dedup key (reproducible only by the original payer), making replay
	// protection unconditional. Same idiom as api/_lib/x402-paid-endpoint.js.
	const paymentId = clientPaymentId || (paymentHash ? `proof:${paymentHash}` : null);
	// Close the check-then-act window: N concurrent requests carrying the same
	// payment could all miss the cache, all run the paid work, and all settle
	// before the first response was stored. The NX claim admits exactly one;
	// the rest are answered inside claimSlotOrRespond (replay/conflict/in-flight).
	let ownsReservation = false;
	if (paymentId) {
		const lookup = await checkCache({ route: ROUTE, paymentId, payloadHash, paymentHash });
		if (lookup.kind === 'hit') return writeCachedResponse(res, lookup.entry);
		if (lookup.kind === 'conflict') {
			return writeConflict(res, {
				route: ROUTE,
				attemptedHash: lookup.attemptedHash,
				existingHash: lookup.existingHash,
				reason: lookup.reason,
			});
		}
		ownsReservation = await claimSlotOrRespond({ res, route: ROUTE, paymentId, payloadHash, paymentHash });
		if (!ownsReservation) return;
	}

	let verified;
	try {
		verified = await verifyPayment({ paymentHeader, requirements });
	} catch (err) {
		if (ownsReservation) await releaseSlot({ route: ROUTE, paymentId });
		if (err.status === 402) return send402(res, { ...challenge, error: err.message });
		return error(res, err.status || 502, err.code || 'verify_failed', err.message);
	}

	// Submit AFTER verify but BEFORE settle so a failed submit never charges.
	// The health-check probe is the exception: it never throws and always returns a
	// verdict (a generator outage is the signal the caller paid for), so it settles
	// unconditionally rather than refunding on a failed completion.
	let result;
	if (parsed.isHealthCheck) {
		result = await runForgeHealthCheck(parsed);
	} else {
		try {
			result = await submitGeneration(parsed);
		} catch (err) {
			if (ownsReservation) await releaseSlot({ route: ROUTE, paymentId });
			return respondGenerationError(res, err);
		}
	}

	let settled;
	try {
		settled = await settlePayment({ verified });
	} catch (err) {
		if (ownsReservation) await releaseSlot({ route: ROUTE, paymentId });
		return error(res, err.status || 502, err.code || 'settle_failed', err.message);
	}

	const paymentResponseHeader = encodePaymentResponseHeader(settled);
	const contentType = 'application/json; charset=utf-8';
	const body = JSON.stringify(result);

	res.setHeader('x-payment-response', paymentResponseHeader);
	res.setHeader('cache-control', 'no-store');
	res.setHeader('content-type', contentType);
	res.end(body);

	if (paymentId) {
		await storeResponse({
			route: ROUTE,
			paymentId,
			payloadHash,
			paymentHash,
			status: 200,
			body,
			contentType,
			paymentResponseHeader,
		});
	}

	// Gallery + provenance: every settled generation becomes a real forge_creations
	// row, so agent-economy output lands in the same community gallery as every
	// other lane, stamped with who paid, the settle signature, and the price.
	if (!parsed.isHealthCheck) {
		await recordPaidCreation({ parsed, result, settled, priceAtomics });
	}
});

// Record a settled paid generation into forge_creations with x402 provenance.
// Inline-done lanes (HF reconstruct, synchronous NIM) materialize immediately:
// the GLB is copied durable and the row goes straight to 'done', visible in the
// gallery within one feed refresh. Async lanes store the FULL job token as the
// job key; api/cron/forge-finalize decodes it and completes the row
// server-side, so the artifact lands even if the buyer never polls. Runs after
// the response is sent; every step is best-effort, and a store hiccup must never
// affect the buyer, who already has their result.
async function recordPaidCreation({ parsed, result, settled, priceAtomics }) {
	if (!forgeStoreEnabled() || !result || result.status === 'failed') return;
	try {
		const payer = settled?.payer || null;
		// One stable pseudo-identity per paying wallet: their creations group in
		// "recent" feeds the same way a browser's do, without inventing a user.
		const clientKey = hashClient(`x402:${payer || 'anon'}`);
		const jobKey = result.job_id || `x402-${randomUUID().replace(/-/g, '')}`;
		const created = await createCreation({
			clientKey,
			ipHash: null,
			prompt: parsed.prompt || (parsed.isImageMode ? 'image reconstruction (x402)' : ''),
			aspect: parsed.aspect,
			previewImageUrl: null,
			replicateJobId: jobKey,
			textToImageModel: null,
			viewsRequested: parsed.imageUrls?.length ?? 0,
			viewsUsed: null,
			multiview: (parsed.imageUrls?.length ?? 0) > 1,
			backend: result.backend ?? null,
			tier: result.tier ?? null,
			path: 'x402',
		});
		if (!created) return;
		await attachX402Provenance({
			replicateJobId: jobKey,
			clientKey,
			payer,
			txSig: settled?.transaction || null,
			priceAtomic: priceAtomics,
		});
		if (result.status === 'done' && result.glb_url) {
			await materializeCreation({ replicateJobId: jobKey, clientKey, glbUrl: result.glb_url });
		}
	} catch (err) {
		console.warn(`[x402/forge] gallery record failed (buyer unaffected): ${err?.message || err}`);
	}
}

// Validate a parsed body object (the stream is already consumed by the handler).
// Mirrors parseRequest but takes an object instead of the request stream.
async function parseRequestFromObject(body) {
	body = body && typeof body === 'object' ? body : {};
	const tier = TIER_IDS.includes(body.tier) ? body.tier : DEFAULT_TIER;
	const aspect = VALID_ASPECT.has(body.aspect_ratio) ? body.aspect_ratio : '1:1';

	let imageUrls = [];
	if (Array.isArray(body.image_urls)) imageUrls = body.image_urls;
	else if (typeof body.image_url === 'string') imageUrls = [body.image_url];
	const rawImageCount = Array.isArray(body.image_urls)
		? body.image_urls.length
		: imageUrls.length;
	imageUrls = imageUrls
		.filter((u) => typeof u === 'string' && HTTP_URL_RE.test(u))
		.slice(0, MAX_VIEWS);
	const isImageMode = imageUrls.length > 0;

	const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';

	// Health-check mode: a lightweight, real content-generation canary that never
	// reconstructs a mesh (see runForgeHealthCheck). It supplies its own default
	// prompt, so it is never an empty "probe" and bypasses the 3–1000 char prompt
	// rule that gates the 3D lanes. Supported types: "text" (LLM completion) and
	// "image" (text→image + CDN upload).
	const isHealthCheck = body.mode === 'health_check';
	if (isHealthCheck) {
		const healthType = body.type === 'image' ? 'image' : 'text';
		return { prompt, imageUrls: [], isImageMode: false, isProbe: false, isHealthCheck: true, healthType, tier, aspect };
	}

	const isProbe = !prompt && !isImageMode;

	if (!isImageMode && !isProbe && (prompt.length < 3 || prompt.length > 1000)) {
		throw Object.assign(
			new Error('Describe one subject in 3–1000 characters, or pass image_urls.'),
			{
				status: 400,
				code: 'invalid_prompt',
			},
		);
	}
	if (rawImageCount > 0 && imageUrls.length === 0) {
		throw Object.assign(new Error('image_urls must be public https URLs.'), {
			status: 400,
			code: 'invalid_image_urls',
		});
	}
	return { prompt, imageUrls, isImageMode, isProbe, tier, aspect };
}
