/**
 * Forge — browser-facing text/image → 3D model generator + auto-rigger.
 *
 *   POST /api/forge   { prompt, aspect_ratio?, path?, tier?, backend? }  → text→3D
 *   POST /api/forge   { image_urls[], prompt?, path?, tier?, backend? }  → image→3D
 *   POST /api/forge   { image_urls[sketch], prompt, path: 'sketch' }     → sketch→3D
 *   POST /api/forge?action=rig  { glb_url }                              → auto-rig
 *   GET  /api/forge?job=<id>                                             → poll a job
 *   GET  /api/forge?catalog                                              → tier/backend/cost matrix
 *
 * Two request axes select how a mesh is produced (see api/_lib/forge-tiers.js):
 *   • path  — "image" (image-intermediate: text→image→mesh via FLUX + TRELLIS,
 *             the fast default; or Hunyuan3D self-host), "geometry" (geometry-
 *             first: native text→mesh / image→mesh via Meshy or Tripo, no
 *             synthesized intermediate view, higher geometric ceiling), or
 *             "sketch" (a drawing + a prompt naming it → TripoSG-scribble,
 *             self-host; untextured geometry).
 *   • tier  — draft | standard | high — the target polygon budget + texture
 *             richness. The high tier yields a visibly denser mesh.
 * Every job result reports the path + tier + backend that produced it.
 *
 * The geometry providers are BYOK: the caller supplies their own Meshy/Tripo key
 * (request header `x-forge-provider-key`, or the signed-in user's stored key).
 * Without one, the geometry path returns a designed `needs_key` state.
 *
 * Optional output controls (every field off by default — see
 * api/_lib/forge-options.js — an old request that never sends any of these
 * behaves exactly as before):
 *   • seed              — integer, reproducible generation on lanes that expose one.
 *   • output_format      — "glb" (default) | "glb-draco" | "glb-meshopt": a real
 *     post-generation @gltf-transform compression pass (api/_lib/glb-compress.js).
 *   • texture_size / target_polycount — poly-aware backends only (Hunyuan3D,
 *     Meshy, Tripo, Rodin, TripoSG); ignored (never 422s) on TRELLIS.
 *   • director: true    — runs the same IBM Granite "art director" prompt
 *     rewrite the free MCP tools use before a text prompt synthesizes its
 *     reference image. Off by default; fails soft to the raw prompt.
 *   • force_regenerate: true — skip the result cache read for this call (the
 *     cache still gets refreshed with the new result).
 * A finished generation's metadata carries `quality` (api/_lib/glb-quality.js
 * — valid/flag/score/reasons) and, when compression was requested,
 * `compression` (mode + before/after byte counts). A flagged degenerate/low
 * result is retried once automatically on the lanes that complete inline
 * within one request (free NVIDIA NIM, HuggingFace Spaces, BYOK-sync).
 * Identical text→3D requests on a platform-keyed (never BYOK), non-high-tier
 * lane are served from a short-lived result cache (api/_lib/forge-cache.js)
 * instead of re-running the GPU pipeline; the response carries `cached: true`.
 *
 * This is the public, auth-free twin of the 3D Studio MCP server (api/mcp-3d.js).
 * No mock paths: if a selected backend isn't configured the endpoint returns a
 * clean 503/501 and the page renders a designed state — it never fabricates a
 * model.
 */

import { randomUUID } from 'node:crypto';
import { cors, json, method, readJson, wrap, rateLimited } from './_lib/http.js';
import { limits, clientIp } from './_lib/rate-limit.js';
import { textToImage } from './_mcp3d/text-to-image.js';
import { createRegenProvider } from './_providers/replicate.js';
import { createRegenProvider as createGcpProvider } from './_providers/gcp.js';
import { BYOK_PROVIDER_FACTORIES } from './_providers/byok-registry.js';
import {
	PATHS,
	DEFAULT_PATH,
	TIER_IDS,
	DEFAULT_TIER,
	BACKENDS,
	resolveTier,
	resolveBackendId,
	resolveBackendIdWithHealth,
	freeLaneCandidates,
	isSelfHostBackend,
	coldStartSecondsFor,
	estimateEtaSeconds,
	estimateCredits,
	preferFreeReconstruct,
	backendIsConfigured,
	buildCatalog,
} from './_lib/forge-tiers.js';
import { laneHealthSnapshot, markLaneUnhealthy } from './_lib/forge-lane-health.js';
import { resolveProviderKey } from './_lib/forge-provider-key.js';
import { validateForgeImage } from './_lib/forge-image-validate.js';
import { encodeJobToken, decodeJobToken } from './_lib/forge-job-token.js';
import {
	hashClient,
	hashIp,
	createCreation,
	materializeCreation,
	markFailed,
	findByJob,
} from './_lib/forge-store.js';
import { getSessionUser } from './_lib/auth.js';
import { constantTimeEquals } from './_lib/crypto.js';
import {
	forgeRequestHash,
	coalesceInFlight,
	registerInFlight,
	acquireBlockingSlot,
	providerSubmitAllowed,
	dailyPaidAllowed,
	SCALE_LIMITS,
} from './_lib/forge-scale.js';
import { env as _env } from './_lib/env.js';
import { verifyTierPass, TIERS } from './_lib/three-tier.js';
import { requireFeatureAccess } from './_lib/require-three.js';
import { priceForAction } from './_lib/pricing/catalog.js';
import {
	assertForgePayment,
	redeemForgePayment,
	releaseForgePayment,
} from './_lib/forge-high-payment.js';
import {
	chargeCreditsForAction,
	quoteCreditsForAction,
	getCreditAccount,
	refundCredits,
} from './_lib/credits.js';
import { markProviderCooldown, providersInCooldown } from './_lib/provider-health.js';
import { sanitizeJobError } from './_lib/provider-job-error.js';
import { normalizeForgeOptions, providerReconstructParams, summarizeForgeOptions } from './_lib/forge-options.js';
import { bindJobToOptions, optionsForJob } from './_lib/forge-job-options.js';
import {
	forgeResultCacheKey,
	getCachedForgeResult,
	putCachedForgeResult,
	bindJobToCacheKey,
	cacheKeyForJob,
} from './_lib/forge-cache.js';
import { shouldRetryForQuality } from './_lib/glb-quality.js';
import { directPrompt } from './_mcp-studio/forge-client.js';
import { MESH_DIRECTOR, resolveLogoPrompt } from './_lib/forge-director-prompts.js';

// Circuit-breaker key + window for the free NVIDIA NIM TRELLIS text→3D lane. The
// hosted NVCF gateway can degrade so a submit neither completes nor hands back a
// pollable id before our timeout — a single slow window otherwise makes every
// text prompt re-pay that full timeout before failing over to the reconstruct
// lane. A short cooldown (recorded on a health failure, checked before the lane
// runs) lets subsequent requests skip a degraded lane and go straight to a
// working one; it expires on its own so a recovered lane is retried promptly.
// Best-effort via the shared cache — a miss just means "not cooling".
const NIM_TRELLIS_COOLDOWN_KEY = 'forge-nim-trellis';
// Sideline the free NIM lane after a failure. The cooldown exists to avoid
// re-paying the expensive submit-timeout HANG, so a socket timeout / unreachable
// host (no HTTP status came back) earns the full window. A fast gateway 5xx (a
// 504/503 the gateway returned promptly — a cold-start/capacity blip the
// in-provider retry already rode) only earns a short window, so a single transient
// 504 doesn't sideline the free lane for two minutes and dump every text prompt on
// the paid lane. See nimCooldownSeconds().
const NIM_FORGE_COOLDOWN_SECONDS = 120;
const NIM_FORGE_GATEWAY_COOLDOWN_SECONDS = 30;

// The platform-keyed paid reconstruct lane (Replicate TRELLIS) recorded as down.
// Set only on an out-of-credit/billing failure — which won't self-heal until ops
// tops the account up, so the window is long (reason 'auth'). The NIM-cooldown
// router reads it to avoid skipping the free lane in favour of a dead paid lane.
const REPLICATE_PAID_COOLDOWN_KEY = 'forge-replicate-paid';
const REPLICATE_PAID_COOLDOWN_SECONDS = 300;

// Pick how long to cool the free NIM lane after a failure. A Retry-After hint
// (429) is honoured within bounds; an HTTP status that came back at all means the
// gateway answered (a fast fail) and earns the short window; no status means our
// socket timed out / the host was unreachable (the expensive hang) and earns the
// full window.
export function nimCooldownSeconds(err) {
	const retryAfter = Number(err?.retryAfter);
	if (Number.isFinite(retryAfter) && retryAfter > 0) {
		return Math.min(
			Math.max(Math.ceil(retryAfter), NIM_FORGE_GATEWAY_COOLDOWN_SECONDS),
			NIM_FORGE_COOLDOWN_SECONDS,
		);
	}
	if (typeof err?.providerStatus === 'number') return NIM_FORGE_GATEWAY_COOLDOWN_SECONDS;
	return NIM_FORGE_COOLDOWN_SECONDS;
}

// Holder perk (Lever 2): a presented, verified $THREE tier pass lifts the free
// generation ceiling by that tier's multiplier. The pass is pure-HMAC verifiable
// (no RPC/price feed), so this adds zero latency to the anonymous free lane. An
// absent or invalid pass simply leaves the multiplier at 1 (the base 60/h).
function freeLaneMultiplier(req, body) {
	const token = req.headers?.['x-three-tier-pass'] || body?.tier_pass || null;
	if (!token) return 1;
	const payload = verifyTierPass(token);
	if (!payload) return 1;
	const tier = TIERS.find((t) => t.level === payload.level);
	return tier?.rateMultiplier || 1;
}

// Returns true when the request carries the internal cron seed token, meaning
// the call comes from forge-seed-cron (server→server). These bypass the per-IP
// rate limit — they're metered by MAX_CONCURRENT_PENDING in the cron instead.
function isInternalSeedRequest(req) {
	const token = req.headers['x-forge-seed'];
	if (!token) return false;
	const secret = _env.CRON_SECRET;
	return !!secret && constantTimeEquals(token, secret);
}

// The free NVIDIA NIM (TRELLIS) provider is loaded lazily and dynamically: it
// ships in T1.1, so importing it statically would couple this whole endpoint to
// a module that may not exist yet. Dynamic import keeps every other backend
// working in the meantime; a missing module or absent NVIDIA_API_KEY surfaces as
// a clean backend_unconfigured 501 at the dispatch sites below.
async function loadNvidiaProvider() {
	const mod = await import('./_providers/nvidia.js');
	return mod.createNvidiaProvider();
}

const VALID_ASPECT = new Set(['1:1', '4:3', '3:4', '16:9', '9:16']);

// Multi-view reconstruction accepts up to four calibrated views of one object
// (front / back / left / right). More than that yields diminishing returns and
// risks overrunning the model's input budget.
const MAX_VIEWS = 4;

// Guard for caller-supplied reference image / source GLB URLs. http(s) only,
// bounded length — we forward these to the reconstruction/rig provider, so we
// never accept data: URLs or unbounded strings.
const HTTP_URL_RE = /^https?:\/\/[^\s]+$/i;

// A Replicate prediction id is a lowercase base32-ish token. Constrain the
// poll parameter to that shape so we never forward arbitrary strings upstream.
const JOB_ID_RE = /^[a-z0-9]{16,64}$/;

// Stable anonymous handle for the browser making the request (/forge has no
// login). Used to scope durable creations + the gallery to one client without
// trusting any of its other input.
function clientKeyFrom(req) {
	const raw = req.headers['x-forge-client'];
	return hashClient(Array.isArray(raw) ? raw[0] : raw);
}

// /forge is auth-free and the overwhelming majority of calls are anonymous —
// but when a caller DOES carry a session cookie (the browser /create/studio
// flow while logged in), attach their user_id to the durable creation so it
// surfaces on their public portfolio (/u/:username → "Models" tab). Resolved
// at most once per request; failures (no db, bad cookie) degrade to null,
// never block generation.
async function sessionUserIdFromReq(req) {
	if (Object.prototype.hasOwnProperty.call(req, '__twxSessionUserId')) return req.__twxSessionUserId;
	try {
		const user = await getSessionUser(req);
		req.__twxSessionUserId = user?.id ?? null;
	} catch {
		req.__twxSessionUserId = null;
	}
	return req.__twxSessionUserId;
}

// Resolve the requested generation path + quality tier from the body, falling
// back to the existing fast defaults (image-intermediate, standard tier).
function parsePath(body) {
	const p = typeof body?.path === 'string' ? body.path.trim() : '';
	return PATHS.includes(p) ? p : DEFAULT_PATH;
}
function parseTier(body) {
	const t = typeof body?.tier === 'string' ? body.tier.trim() : '';
	return TIER_IDS.includes(t) ? t : DEFAULT_TIER;
}

// "needs a BYOK key" — a designed, branchable state (mirrors rig_unconfigured)
// rather than a generic error, so the page can prompt for the key inline.
function needsKey(res, providerName) {
	const meta = BACKENDS[providerName];
	return json(res, 501, {
		error: 'needs_key',
		provider: providerName,
		message: `${meta?.label || providerName} needs your own API key. Add a ${meta?.byok || providerName} key to use it.`,
	});
}

// Normalize the caller's reference image input into an ordered, de-duplicated
// list of view URLs. Accepts the multi-view `image_urls: string[]` form and the
// legacy single `image_url: string` (backward compatible — a single string
// still works exactly as before). Empty/blank/duplicate entries are dropped.
function parseImageUrls(body) {
	let raw;
	if (Array.isArray(body?.image_urls)) raw = body.image_urls;
	else if (typeof body?.image_url === 'string') raw = [body.image_url];
	else raw = [];

	const seen = new Set();
	const out = [];
	for (const v of raw) {
		if (typeof v !== 'string') continue;
		const t = v.trim();
		if (!t || seen.has(t)) continue;
		seen.add(t);
		out.push(t);
	}
	return out;
}

function unconfigured(res) {
	return json(res, 503, {
		error: 'unconfigured',
		message:
			'Text-to-3D generation is not configured on this deployment. Set any one of NVIDIA_API_KEY or HF_TOKEN (free lanes) or REPLICATE_API_TOKEN (flux → TRELLIS) to enable it.',
	});
}

// Whether a thrown provider error means the upstream itself is unavailable —
// throttled, over-quota, unreachable, or 5xx — as opposed to a client/config
// fault. Both never-dead-end fallbacks (image→3D to the self-hosted Hunyuan3D
// worker, text→3D to the free NVIDIA NIM lane) degrade on exactly these so a
// generation rides out a transient upstream outage instead of failing the user.
function isUpstreamUnavailable(err) {
	return (
		err?.code === 'rate_limited' ||
		err?.providerStatus === 429 ||
		err?.code === 'provider_error' ||
		err?.code === 'provider_unreachable' ||
		(typeof err?.providerStatus === 'number' && err.providerStatus >= 500)
	);
}

// A leaked paid-account billing/credit message from the platform's OWN vendor
// (e.g. Replicate "You have insufficient credit to run this model… purchase
// credit") is internal infra state — surfacing it to the user is both useless
// (they can't fund our account) and a billing-state leak. Detect it so the
// boundary can answer with an honest, generic "temporarily unavailable" instead.
// BYOK callers are excluded at the call site: a credit message about THEIR OWN
// account is actionable, so it's surfaced verbatim.
function isPaidCreditFailure(err) {
	if (err?.providerStatus === 402) return true;
	const text = `${err?.message || ''} ${err?.providerDetail || ''}`.toLowerCase();
	return /insufficient credit|purchase credit|account\/billing|out of credit|not enough credit/.test(text);
}

// Free NVIDIA NIM TRELLIS text→3D lane, extracted so it serves two callers:
//   1. the draft default (backendId === 'nvidia'), and
//   2. the never-dead-end fallback the paid image-intermediate TRELLIS lane
//      degrades to when Replicate is unreachable / over-quota (HTTP 429/5xx).
// Returns true once it has written a 200 response, or false when the lane is
// itself unavailable (so the caller can fall through to the next lane). Prompt
// is required — NVCF is text-only; photo submissions never reach here.
async function runNvidiaTextLane({ req, res, ip, prompt, aspect, tier, path, opts = null, cacheKey = null }) {
	let submitted;
	try {
		const nv = await loadNvidiaProvider();
		submitted = await nv.textTo3d({ prompt, tier, seed: opts?.seed ?? undefined });
	} catch (err) {
		// A timed-out / unreachable / throttled / 5xx NIM lane is degraded — cool it
		// down so the next request skips the submit-timeout gamble and fails over
		// fast. A 4xx (bad input / key) is not a lane-health fault, so it never cools.
		if (isUpstreamUnavailable(err)) {
			markProviderCooldown(NIM_TRELLIS_COOLDOWN_KEY, nimCooldownSeconds(err)).catch(() => {});
		}
		console.warn(`[forge] free NVIDIA NIM lane unavailable: ${err?.message || err}`);
		return false;
	}

	const backendId = 'nvidia';
	const provenance = {
		mode: 'text_to_3d',
		path,
		tier: tier.id,
		backend: backendId,
		prompt: prompt || null,
		preview_image_url: null,
		reference_image_urls: [],
		eta_seconds: estimateEtaSeconds({ backendId, tier }),
		estimated_credits: estimateCredits({ backendId, path, tier }),
	};

	const clientKey = clientKeyFrom(req);
	// Synchronous completion: NVCF already persisted the GLB to R2. Record a
	// finished creation (a synthetic handle lets materialize copy + flip it to
	// done) and return it so the client skips polling entirely.
	if (!submitted.taskId && submitted.resultGlbUrl) {
		const syntheticJob = randomUUID().replace(/-/g, '');
		const creationId = await createCreation({
			clientKey,
			userId: await sessionUserIdFromReq(req),
			ipHash: hashIp(ip),
			prompt,
			aspect,
			previewImageUrl: null,
			replicateJobId: syntheticJob,
			textToImageModel: null,
			viewsRequested: 0,
			viewsUsed: null,
			multiview: false,
			backend: backendId,
			tier: tier.id,
			path,
		});
		let durable = await materializeCreation({
			replicateJobId: syntheticJob,
			clientKey,
			userId: await sessionUserIdFromReq(req),
			glbUrl: submitted.resultGlbUrl,
			quality: true,
			compress: opts?.compression && opts.compression !== 'none' ? opts.compression : null,
		});

		// One auto-retry on a flagged low-quality/degenerate output (CLAUDE.md: no
		// silent mediocrity). Only worth attempting when the free NIM lane already
		// completed synchronously once — a second synchronous completion is the
		// common case, so this stays a bounded, in-request retry rather than a
		// background job. Best-effort: any retry failure just keeps the first result.
		let retried = false;
		if (shouldRetryForQuality(durable?.quality)) {
			try {
				const nv = await loadNvidiaProvider();
				const retry = await nv.textTo3d({ prompt, tier, seed: opts?.seed ?? undefined });
				if (!retry.taskId && retry.resultGlbUrl) {
					const retryJob = randomUUID().replace(/-/g, '');
					await createCreation({
						clientKey,
						userId: await sessionUserIdFromReq(req),
						ipHash: hashIp(ip),
						prompt,
						aspect,
						previewImageUrl: null,
						replicateJobId: retryJob,
						textToImageModel: null,
						viewsRequested: 0,
						viewsUsed: null,
						multiview: false,
						backend: backendId,
						tier: tier.id,
						path,
					});
					const retryDurable = await materializeCreation({
						replicateJobId: retryJob,
						clientKey,
						userId: await sessionUserIdFromReq(req),
						glbUrl: retry.resultGlbUrl,
						quality: true,
						compress: opts?.compression && opts.compression !== 'none' ? opts.compression : null,
					});
					if (retryDurable) {
						durable = retryDurable;
						retried = true;
					}
				}
			} catch (err) {
				console.warn(`[forge] quality auto-retry (nvidia) failed, keeping first result: ${err?.message || err}`);
			}
		}

		if (cacheKey && durable?.glbUrl) {
			await putCachedForgeResult(cacheKey, {
				glb_url: durable.glbUrl,
				backend: backendId,
				tier: tier.id,
				path,
				quality: durable.quality || null,
			});
		}

		json(res, 200, {
			job_id: null,
			creation_id: durable?.id ?? creationId,
			status: 'done',
			glb_url: durable?.glbUrl ?? submitted.resultGlbUrl,
			durable: Boolean(durable),
			quality: durable?.quality || null,
			quality_retried: retried,
			compression: durable?.compression || null,
			options: opts?.hasOptions ? summarizeForgeOptions(opts) : undefined,
			...provenance,
		});
		return true;
	}

	// Async: wrap the NVCF request id in a forge token so the poll routes back to
	// the NIM provider, and store it as the job handle.
	const token = encodeJobToken({
		provider: 'nvidia',
		kind: submitted.kind,
		taskId: submitted.taskId,
	});
	const creationId = await createCreation({
		clientKey,
		userId: await sessionUserIdFromReq(req),
		ipHash: hashIp(ip),
		prompt,
		aspect,
		previewImageUrl: null,
		replicateJobId: submitted.taskId,
		textToImageModel: null,
		viewsRequested: 0,
		viewsUsed: null,
		multiview: false,
		backend: backendId,
		tier: tier.id,
		path,
	});
	if (cacheKey) await bindJobToCacheKey(token, cacheKey);
	if (opts) await bindJobToOptions(token, opts);
	json(res, 200, {
		job_id: token,
		creation_id: creationId,
		status: 'queued',
		options: opts?.hasOptions ? summarizeForgeOptions(opts) : undefined,
		...provenance,
	});
	return true;
}

// Free Hugging Face Spaces image→3D lane (Hunyuan3D / TRELLIS / TripoSR on free
// GPU Spaces — the same provider the avatar reconstruction pipeline runs). The
// platform photo→3D default is the Replicate TRELLIS lane; when that account is
// over-quota or unreachable a photo upload would otherwise dead-end, because the
// free NVIDIA NIM fallback is text-only. This lane gives image mode the same
// "never dead-end" guarantee text mode already has — gated on HF_TOKEN, so it is
// a transparent no-op on deployments that don't set it. The provider blocks
// until the GLB is ready (Space queue + inference, within the 300s budget), so
// this returns status:'done' synchronously like the NVIDIA sync branch — no
// poll handle to route. Returns true once a 200 is written, false when the lane
// is unavailable so the caller can surface its own error.
// One-shot guard so the "HuggingFace lane not configured" notice is logged once
// per process instead of on every forge request (a static env condition).
let _hfUnconfiguredWarned = false;

async function runHfImageLane({
	req,
	res,
	ip,
	imageUrls,
	prompt,
	aspect,
	tier,
	path,
	// Text→3D feeds this lane a FLUX-synthesized reference view, so provenance must
	// be able to report text_to_3d (+ the synthesis model) rather than always
	// image_to_3d. Defaults keep the original image→3D behavior for callers that
	// pass user photos.
	mode = 'image_to_3d',
	previewImageUrl = null,
	textToImageModel = null,
	opts = null,
	cacheKey = null,
}) {
	let provider;
	try {
		const mod = await import('./_providers/huggingface.js');
		provider = mod.createRegenProvider();
	} catch (err) {
		// HF_TOKEN absent or the Space chain is empty — the lane isn't available
		// on this deployment; fall through so the caller surfaces the real error.
		// A missing token is a STATIC deployment condition, not a per-request fault:
		// logging it on every forge call floods the function logs (it was the
		// single noisiest line). Warn once per process for the unconfigured case;
		// keep logging genuine transient init failures each time.
		if (err?.code === 'provider_unconfigured') {
			if (!_hfUnconfiguredWarned) {
				_hfUnconfiguredWarned = true;
				console.warn(`[forge] free HuggingFace image lane disabled (not configured): ${err?.message || err}`);
			}
		} else {
			console.warn(`[forge] free HuggingFace image lane unavailable: ${err?.message || err}`);
		}
		return false;
	}

	// The Space call BLOCKS this serverless worker for up to ~280s. Under an influx
	// that exhausts the Vercel worker pool and stalls /forge for everyone, so we cap
	// fleet-wide concurrent holds with a self-healing TTL lease. Over the cap the
	// lane reports "not served" (false) and the caller degrades — to the paid
	// reconstruct fallback on the free-first path, or a designed "free lane busy"
	// error on an explicit free pick — instead of piling onto an exhausted pool.
	const slot = await acquireBlockingSlot('hf', {
		max: SCALE_LIMITS.hfConcurrent,
		ttlMs: SCALE_LIMITS.hfSlotTtlMs,
	});
	if (!slot.ok) {
		console.warn('[forge] free HuggingFace lane at concurrency cap; shedding this request');
		return false;
	}

	let resultGlbUrl;
	try {
		const submitted = await provider.submit({
			mode: 'reconstruct',
			sourceUrl: imageUrls[0],
			params: { images: imageUrls, prompt: prompt || undefined, seed: opts?.seed ?? undefined },
		});
		// submit() blocks and packs the finished GLB into extJobId; status() echoes
		// it back without re-hitting the Space.
		const finished = await provider.status(submitted.extJobId);
		resultGlbUrl = finished?.resultGlbUrl;
		if (!resultGlbUrl) throw new Error('HuggingFace returned no GLB');
	} catch (err) {
		console.warn(`[forge] free HuggingFace image lane failed: ${err?.message || err}`);
		return false;
	} finally {
		await slot.release();
	}

	const backendId = 'huggingface';
	const isImageMode = mode === 'image_to_3d';
	const preview = previewImageUrl || imageUrls[0];
	const clientKey = clientKeyFrom(req);
	const syntheticJob = randomUUID().replace(/-/g, '');
	const creationId = await createCreation({
		clientKey,
		userId: await sessionUserIdFromReq(req),
		ipHash: hashIp(ip),
		prompt: prompt || (isImageMode ? 'image-to-3d' : ''),
		aspect,
		previewImageUrl: preview,
		replicateJobId: syntheticJob,
		textToImageModel: isImageMode ? null : textToImageModel,
		viewsRequested: imageUrls.length,
		viewsUsed: imageUrls.length,
		multiview: imageUrls.length > 1,
		backend: backendId,
		tier: tier.id,
		path,
	});
	// Best-effort copy to R2 so the model survives the Space's ephemeral file URL;
	// fail-soft to the raw HF url so the client still gets a model either way.
	const wantCompress = opts?.compression && opts.compression !== 'none' ? opts.compression : null;
	let durable = await materializeCreation({
		replicateJobId: syntheticJob,
		clientKey,
		userId: await sessionUserIdFromReq(req),
		glbUrl: resultGlbUrl,
		quality: true,
		compress: wantCompress,
	});

	// One auto-retry on a flagged low-quality/degenerate output. Only attempted
	// when a concurrency slot is free right now — the HF lane is capacity-capped,
	// so a busy fleet keeps the first (flagged) result rather than starving
	// other callers of their turn on the free Spaces.
	let retried = false;
	if (shouldRetryForQuality(durable?.quality)) {
		const retrySlot = await acquireBlockingSlot('hf', { max: SCALE_LIMITS.hfConcurrent, ttlMs: SCALE_LIMITS.hfSlotTtlMs });
		if (retrySlot.ok) {
			try {
				const retrySubmitted = await provider.submit({
					mode: 'reconstruct',
					sourceUrl: imageUrls[0],
					params: { images: imageUrls, prompt: prompt || undefined, seed: opts?.seed ?? undefined },
				});
				const retryFinished = await provider.status(retrySubmitted.extJobId);
				if (retryFinished?.resultGlbUrl) {
					const retryJob = randomUUID().replace(/-/g, '');
					await createCreation({
						clientKey,
						userId: await sessionUserIdFromReq(req),
						ipHash: hashIp(ip),
						prompt: prompt || (isImageMode ? 'image-to-3d' : ''),
						aspect,
						previewImageUrl: preview,
						replicateJobId: retryJob,
						textToImageModel: isImageMode ? null : textToImageModel,
						viewsRequested: imageUrls.length,
						viewsUsed: imageUrls.length,
						multiview: imageUrls.length > 1,
						backend: backendId,
						tier: tier.id,
						path,
					});
					const retryDurable = await materializeCreation({
						replicateJobId: retryJob,
						clientKey,
						userId: await sessionUserIdFromReq(req),
						glbUrl: retryFinished.resultGlbUrl,
						quality: true,
						compress: wantCompress,
					});
					if (retryDurable) {
						durable = retryDurable;
						retried = true;
					}
				}
			} catch (err) {
				console.warn(`[forge] quality auto-retry (huggingface) failed, keeping first result: ${err?.message || err}`);
			} finally {
				await retrySlot.release();
			}
		}
	}

	if (cacheKey && !isImageMode && durable?.glbUrl) {
		await putCachedForgeResult(cacheKey, {
			glb_url: durable.glbUrl,
			backend: backendId,
			tier: tier.id,
			path,
			quality: durable.quality || null,
		});
	}

	json(res, 200, {
		job_id: null,
		creation_id: durable?.id ?? creationId,
		status: 'done',
		glb_url: durable?.glbUrl ?? resultGlbUrl,
		durable: Boolean(durable),
		quality: durable?.quality || null,
		quality_retried: retried,
		compression: durable?.compression || null,
		options: opts?.hasOptions ? summarizeForgeOptions(opts) : undefined,
		mode,
		path,
		tier: tier.id,
		backend: backendId,
		prompt: prompt || null,
		preview_image_url: preview,
		reference_image_urls: isImageMode ? [imageUrls[0]] : [preview],
		text_to_image_model: isImageMode ? null : textToImageModel,
		eta_seconds: estimateEtaSeconds({ backendId, tier }),
		estimated_credits: estimateCredits({ backendId, path, tier }),
	});
	return true;
}

async function startJob(req, res) {
	const ip = clientIp(req);
	const body = await readJson(req, 8_000).catch(() => null);

	// Two reconstruction modes share this path:
	//   • image→3D — a caller supplies one or more reference views (image_url or
	//     image_urls[]); we reconstruct directly and skip the text-to-image stage.
	//     With >1 view the provider fuses them (multi-view conditioning). An
	//     optional prompt may still guide the model where it accepts one.
	//   • text→3D — no images; we synthesize the reference image from the prompt
	//     with FLUX first, then reconstruct.
	const imageUrls = parseImageUrls(body);
	const isImageMode = imageUrls.length > 0;
	const prompt = typeof body?.prompt === 'string' ? body.prompt.trim() : '';

	// Optional, additive output controls (seed, output_format/compression,
	// texture_size, target_polycount) — see _lib/forge-options.js. Every field is
	// off by default, so a request that never sends them behaves exactly as
	// before. An explicitly-present but invalid value is a 400 with an actionable
	// message; an absent field is never an error.
	const opts = normalizeForgeOptions(body);
	if (opts.errors.length) {
		return json(res, 400, {
			error: 'invalid_options',
			errors: opts.errors,
			message: opts.errors.map((e) => e.message).join(' '),
		});
	}

	// Resolve the generation path + tier + backend BEFORE the rate check so the
	// limiter can be lane-aware. The free NVIDIA NIM lane (draft, no vendor spend)
	// gets a generous fail-open bucket; the paid Replicate/BYOK lanes keep the
	// tight critical 12/h ceiling that protects real money. Both still gate the
	// expensive work below (image moderation, FLUX, reconstruction).
	let path = parsePath(body);
	const tier = resolveTier(parseTier(body));
	let backendId = resolveBackendId({ path, tier, backend: body?.backend, userImages: isImageMode });
	// Tracks whether the free NVIDIA NIM lane has already been attempted this
	// request, so the paid-lane fallback below never retries a lane that just
	// failed (draft already tries nvidia first; standard/high reach it only as a
	// last-resort fallback when Replicate is down).
	let nvidiaTried = false;
	// Set once the free NVIDIA NIM TRELLIS lane is known-degraded this request
	// (skipped on cooldown, or attempted and failed). The text→3D FLUX synthesis
	// below then skips the sibling NIM image lane too, so a degraded NVCF gateway
	// can't stack a second submit-timeout window on the same request.
	let nimGatewayDegraded = false;

	// Pay-per-use (Token Utility — consumption lever): set to { paymentId, refId,
	// settledAt, redeemed? } once a non-holder's settled $THREE payment is accepted
	// in lieu of holding. The payment is validated at the gate, claimed atomically
	// just before dispatch, and released if the generation fails before delivery.
	let paidHigh = null;

	// Prepaid-credit lane (pay_with:'credits'): set to { user, action, ref,
	// ledgerId?, chargedUsd? } once a signed-in user opts to spend their credit
	// balance instead of holding $THREE or paying per-call. Validated at the gate,
	// debited just before dispatch, refunded if the generation fails.
	let creditsCharge = null;

	// Fingerprint for in-flight request coalescing, set once the lane is resolved
	// below. Null disables coalescing (high tier, which is paid/gated per caller and
	// must never hand one payer's job to another).
	let requestHash = null;

	// The geometry path is BYOK-only — no free model does native text→geometry.
	// So when the caller didn't explicitly pick a backend and has no key for the
	// default geometry engine, transparently serve the free image lane (NVIDIA
	// NIM on draft, TRELLIS otherwise) instead of a dead "needs key" error. The
	// platform works with zero setup; Meshy/Tripo/Rodin stay fully selectable the
	// moment a key is present or a backend is explicitly chosen.
	const backendExplicit = Boolean(body?.backend && BACKENDS[body.backend]);
	if (path === 'geometry' && !backendExplicit) {
		const defaultByok = BACKENDS[backendId]?.byok;
		if (defaultByok && !(await resolveProviderKey(req, body, defaultByok))) {
			path = 'image';
			backendId = resolveBackendId({ path, tier, userImages: isImageMode });
		}
	}

	// Health-aware lane selection: when the caller didn't name a backend, consult a
	// cheap, cached liveness snapshot of the free lanes and skip any our probe (or a
	// recent submit failure) marks down — so a cold or unreachable self-host worker
	// is routed AROUND before submit, not failed-over after. Only the platform free
	// lanes (image/sketch) are candidates; geometry is BYOK and unaffected. Pure
	// best-effort: any snapshot error leaves the env-resolved backendId in place, so
	// a deployment with no telemetry behaves exactly as before. The snapshot is also
	// reused below to decide an honest cold-start ETA without a second probe.
	if (!backendExplicit && (path === 'image' || path === 'sketch')) {
		try {
			const candidates = freeLaneCandidates(path, tier.id, isImageMode);
			if (candidates.length) {
				const snap = await laneHealthSnapshot(candidates);
				const healthAware = resolveBackendIdWithHealth({
					path,
					tier,
					userImages: isImageMode,
					health: snap.statusMap,
				});
				if (BACKENDS[healthAware]) backendId = healthAware;
			}
		} catch (err) {
			console.warn(`[forge] lane-health routing skipped: ${err?.message || err}`);
		}
	}

	// Honest cold-start signal for a chosen self-host lane: true only when the
	// liveness probe reached the worker but it answered slowly (a scale-to-zero
	// container spinning up). Reuses the cached snapshot, so the common path pays no
	// extra probe. Used to widen the ETA + flag `cold_start` in the response — never
	// to fabricate progress; the client's real polling still drives actual status.
	const coldStartFor = async (id) => {
		if (!isSelfHostBackend(id) || !coldStartSecondsFor(id)) return false;
		try {
			const snap = await laneHealthSnapshot([id]);
			const rec = snap.byId[id];
			return Boolean(rec && rec.status === 'ok' && rec.warm === false);
		} catch {
			return false;
		}
	};

	// Content-addressed result cache (see _lib/forge-cache.js): a text→3D request
	// on a platform-keyed lane (never BYOK — that spends the caller's own account,
	// so it must never be replayed to a stranger) can be served instantly from a
	// prior identical generation instead of re-running the GPU pipeline. Captured
	// once, before any lane-failover churn reassigns `backendId` below, so the
	// same cache key is used to both look up and (on completion) store this
	// request's result — a failover to a different lane just means a miss, never
	// a wrong hit. `force_regenerate: true` skips the read (a fresh run is still
	// written back, keeping the cache warm). High tier is paid/gated per caller
	// and is never cached, matching the module's own privacy boundary.
	const cacheEligible = !isImageMode && tier.id !== 'high' && BACKENDS[backendId]?.byok === false;
	const forceRegenerate = body?.force_regenerate === true;
	const cacheKey = cacheEligible
		? forgeResultCacheKey({ path, tier, backend: backendId, prompt, options: opts })
		: null;
	if (cacheKey && !forceRegenerate) {
		const cached = await getCachedForgeResult(cacheKey);
		if (cached) {
			return json(res, 200, {
				job_id: null,
				creation_id: null,
				status: 'done',
				glb_url: cached.glb_url,
				durable: true,
				cached: true,
				cached_at: cached.cached_at,
				mode: 'text_to_3d',
				path: cached.path || path,
				tier: cached.tier || tier.id,
				backend: cached.backend || backendId,
				prompt: prompt || null,
				quality: cached.quality || null,
				options: opts.hasOptions ? summarizeForgeOptions(opts) : undefined,
			});
		}
	}

	// $THREE hold-to-access gate (Token Utility v1) — the High tier (200k poly +
	// PBR, textured) is the platform's premium quality tier. It now runs on a
	// free-for-us engine (HuggingFace Hunyuan3D) like every other tier, so this is
	// a pure monetization gate — we charge for higher quality, not to recover
	// vendor spend: reserved for holders (Bronze+, $25 hold) or a presented tier
	// pass, otherwise a hold-or-pay 402. BYOK backends are exempt (the caller pays
	// their own vendor key — key-gated, not hold-gated). Draft and Standard are
	// never gated, and internal cron seed jobs bypass it entirely.
	// requireFeatureAccess writes the 402 (three_hold_required) itself and returns
	// { ok:false }; on a holder it writes nothing and lets the job proceed.
	if (tier.id === 'high' && BACKENDS[backendId]?.byok === false && !isInternalSeedRequest(req)) {
		// Consumption lever: a non-holder may present a settled $THREE payment
		// (payment_id + the client nonce it was bound to) to satisfy the gate per
		// generation instead of holding. Validate it read-only here; the single-use
		// claim is taken atomically just before dispatch (see paidHigh below). A
		// missing/invalid proof falls through to the normal hold-or-pay 402.
		const payWith = typeof body?.pay_with === 'string' ? body.pay_with.toLowerCase() : '';
		const paymentId = typeof body?.payment_id === 'string' ? body.payment_id.trim() : '';
		const refId = typeof body?.ref_id === 'string' ? body.ref_id.trim() : '';
		if (payWith === 'credits') {
			// Prepaid-credit lane: a signed-in user spends their balance instead of
			// holding $THREE or paying per-call. Affordability is checked here; the
			// single-use debit happens just before dispatch and is refunded if the
			// job fails (see creditsCharge in the try/finally below).
			const creditUser = await getSessionUser(req).catch(() => null);
			if (!creditUser) {
				return json(res, 401, {
					error: 'unauthorized',
					feature: 'forge.high',
					top_up_url: '/credits',
					message: 'Sign in to pay with credits.',
				});
			}
			let priceUsd;
			try {
				priceUsd = (await quoteCreditsForAction({ user: creditUser, action: 'forge.high' })).usd;
			} catch {
				priceUsd = Number(priceForAction('forge.high').usd) || 0;
			}
			const acct = await getCreditAccount(creditUser.id);
			if (acct.balanceUsd < priceUsd) {
				return json(res, 402, {
					error: 'insufficient_credits',
					feature: 'forge.high',
					price_usd: priceUsd,
					balance_usd: acct.balanceUsd,
					top_up_url: '/credits',
					message: `Generating a High model costs $${priceUsd.toFixed(2)} in credits — your balance is $${acct.balanceUsd.toFixed(2)}. Top up to continue.`,
				});
			}
			creditsCharge = { user: creditUser, action: 'forge.high', ref: refId || randomUUID() };
		} else if (paymentId && refId) {
			try {
				const proof = await assertForgePayment({ paymentId, refId });
				paidHigh = { paymentId, refId, settledAt: proof.payment.settledAt };
			} catch (err) {
				// A presented-but-invalid proof is a designed, recoverable state: the
				// client can pay again (pay_per_use) or hold. Carry the price so the UI
				// can re-offer Pay without another round-trip.
				let usd = null;
				try {
					usd = Number(priceForAction('forge.high').usd) || null;
				} catch {
					usd = null;
				}
				return json(res, err.status || 402, {
					error: err.code || 'payment_invalid',
					feature: 'forge.high',
					get_three_url: '/three-token',
					pay_per_use: usd ? { action: 'forge.high', usd } : null,
					message: err.message || 'That $THREE payment could not be verified.',
				});
			}
		} else {
			const gate = await requireFeatureAccess(req, res, 'forge.high', { body });
			if (!gate.ok) return; // 402 three_hold_required already sent
		}
	}

	const backendMeta = BACKENDS[backendId];
	const isFreeLane = backendMeta?.free === true;
	if (!isInternalSeedRequest(req)) {
		const rl = isFreeLane
			? await limits.mcp3dGenerateFreeTiered(ip, freeLaneMultiplier(req, body))
			: await limits.mcp3dGenerate(ip);
		if (!rl.success) {
			return rateLimited(res, rl, 'Generation limit reached. Try again shortly.');
		}
		// Cost circuit breaker: a platform-wide hourly ceiling on PLATFORM-keyed paid
		// generation (the shared Replicate/self-host budget), on top of the per-IP cap
		// above. It stops the influx/abuse failure mode where many callers each stay
		// under their own cap but collectively drain spend. BYOK lanes spend the
		// caller's own key, so the platform-budget ceiling must never throttle them.
		// When it trips the free NVIDIA / HuggingFace lanes stay open — paid capacity
		// degrades, it never dead-ends.
		if (!isFreeLane && !backendMeta?.byok) {
			const globalRl = await limits.mcp3dGenerateGlobal();
			if (!globalRl.success) {
				return rateLimited(
					res,
					globalRl,
					'Paid 3D generation is at capacity right now — switch to a free engine (NVIDIA or Hugging Face), or try again shortly.',
				);
			}
			// Per-identity daily ceiling: closes the rotating-IP abuse path the per-IP
			// hourly cap and the global hourly cap leave open (one actor under every
			// per-request limit can still drain paid spend over a day). Keyed by the
			// forge client id. Free and BYOK lanes are never counted.
			const daily = await dailyPaidAllowed(clientKeyFrom(req), {
				limit: SCALE_LIMITS.paidDailyPerClient,
			});
			if (!daily.ok) {
				return json(res, 429, {
					error: 'daily_limit_reached',
					message:
						'You’ve reached today’s limit for paid generations. Free engines (NVIDIA, Hugging Face) stay open, or try again tomorrow.',
				});
			}
		}
	}

	if (isImageMode) {
		if (imageUrls.length > MAX_VIEWS) {
			return json(res, 400, {
				error: 'invalid_image_urls',
				message: `Provide between 1 and ${MAX_VIEWS} reference images.`,
			});
		}
		// Validate every view at the boundary before any of them reach the model.
		for (const u of imageUrls) {
			if (!HTTP_URL_RE.test(u) || u.length > 2048) {
				return json(res, 400, {
					error: 'invalid_image_url',
					message: 'Each reference image must be an http(s) URL under 2048 characters.',
				});
			}
		}
		if (prompt.length > 1000) {
			return json(res, 400, {
				error: 'invalid_prompt',
				message: 'Optional guidance prompt must be 1000 characters or fewer.',
			});
		}

		// Vision pre-check (Consumer 1 of the shared vision helper): catch a photo
		// that can't be reconstructed BEFORE it burns a generation slot. Validates
		// the primary view only. Fail-open — a vision outage returns ok:true and we
		// proceed exactly as before (validateForgeImage owns that contract). The
		// user can override a verdict they disagree with via `skip_validation:true`
		// (e.g. a stylized reference our checker is too cautious about).
		// The sketch path is exempt: a line drawing is exactly what the photo
		// checker is trained to reject, and exactly what TripoSG-scribble wants.
		if (body?.skip_validation !== true && path !== 'sketch') {
			// The forge client key is a hashed client-supplied header, NOT an OAuth
			// client — it has no row in oauth_clients, so it must never land in the
			// FK-constrained usage_events.client_id (that fails the insert and the
			// whole spend event is silently dropped). Attribute it via meta instead.
			const check = await validateForgeImage(imageUrls[0], { track: { meta: { forgeClient: clientKeyFrom(req) } } });
			if (!check.ok) {
				return json(res, 422, {
					error: 'image_not_usable',
					issue: check.issue,
					message: check.message,
					subject: check.subject || null,
					// Surfaced so the UI can offer a one-click "generate anyway".
					override: { field: 'skip_validation', value: true },
				});
			}
		}
	} else if (prompt.length < 3 || prompt.length > 1000) {
		return json(res, 400, {
			error: 'invalid_prompt',
			message:
				'Describe one subject in 3–1000 characters, or pass image_url / image_urls for image-to-3D.',
		});
	}
	const aspect = VALID_ASPECT.has(body?.aspect_ratio) ? body.aspect_ratio : '1:1';

	// Sketch→3D is single-view and prompt-conditioned: the drawing is the only
	// input image, and the prompt names what it depicts (TripoSG-scribble is a
	// text+scribble model — without the prompt it has nothing to disambiguate
	// rough strokes against).
	if (path === 'sketch') {
		if (!isImageMode) {
			return json(res, 400, {
				error: 'missing_sketch',
				message: 'Upload a drawing and pass it as image_urls[0] for sketch-to-3D.',
			});
		}
		if (imageUrls.length > 1) {
			return json(res, 400, {
				error: 'invalid_image_urls',
				message: 'Sketch-to-3D takes exactly one drawing.',
			});
		}
		if (prompt.length < 3) {
			return json(res, 400, {
				error: 'invalid_prompt',
				message: 'Say what the sketch depicts (3–1000 characters) — the sketch model is prompt-conditioned.',
			});
		}
	}

	// path / tier / backendId were resolved above (the rate limiter is lane-aware).
	// An explicitly selected text-only backend can't serve a photo submission —
	// say so plainly rather than failing upstream with an opaque 422.
	if (isImageMode && BACKENDS[backendId]?.userImages === false) {
		return json(res, 422, {
			error: 'backend_text_only',
			backend: backendId,
			message:
				`${BACKENDS[backendId].label} generates from text prompts only — NVIDIA's hosted preview doesn't accept uploaded photos. ` +
				'Drop the backend field to use the default photo engine, or pick TRELLIS, Meshy, or Tripo.',
		});
	}

	try {
		// Pay-per-use: claim the settled $THREE payment now — immediately before any
		// provider work, so every cheap failure above (rate limit, moderation, bad
		// input) left the payment reusable. The atomic claim (payment_id PRIMARY KEY)
		// is the single-use source of truth: a concurrent retry of the same payment
		// loses the race and is told the payment is already used. If anything below
		// fails before a model is delivered, the finally releases the claim.
		if (paidHigh && !paidHigh.redeemed) {
			const claim = await redeemForgePayment({
				paymentId: paidHigh.paymentId,
				refId: paidHigh.refId,
				settledAt: paidHigh.settledAt,
			});
			if (!claim.redeemed) {
				return json(res, 409, {
					error: 'payment_already_used',
					feature: 'forge.high',
					get_three_url: '/three-token',
					message:
						'This payment has already been used for a generation. Pay again to generate another High model.',
				});
			}
			paidHigh.redeemed = true;
		}

		// Prepaid-credit charge: debit now, immediately before provider work, so
		// every cheap failure above left the balance untouched. Idempotent on the
		// client ref; the finally refunds it if the job fails before delivery.
		if (creditsCharge && !creditsCharge.ledgerId) {
			try {
				const charged = await chargeCreditsForAction({
					user: creditsCharge.user,
					action: creditsCharge.action,
					refType: 'forge',
					refId: creditsCharge.ref,
					idempotencyKey: `forge:credits:${creditsCharge.ref}`,
					meta: { tier: 'high' },
				});
				creditsCharge.ledgerId = charged.ledgerId;
				creditsCharge.chargedUsd = charged.chargedUsd;
			} catch (err) {
				if (err.code === 'insufficient_credits') {
					return json(res, 402, {
						error: 'insufficient_credits',
						feature: 'forge.high',
						available_usd: err.available_usd,
						required_usd: err.required_usd,
						top_up_url: '/credits',
						message: err.message,
					});
				}
				throw err;
			}
		}

		// ── Sketch path (TripoSG-scribble, self-host) ───────────────────────────
		// The drawing + prompt go straight to the TripoSG worker's scribble
		// pipeline. Geometry only — no synthesized intermediate view, no textures;
		// the result panel's Retexture/Stylize tools pick up from there.
		if (path === 'sketch') {
			let gcp;
			try {
				gcp = createGcpProvider();
			} catch {
				return json(res, 501, {
					error: 'backend_unconfigured',
					backend: backendId,
					message: 'Sketch-to-3D is not configured on this deployment.',
				});
			}

			const sketchUrl = imageUrls[0];
			let job;
			try {
				job = await gcp.submit({
					mode: 'sketch',
					sourceUrl: sketchUrl,
					params: {
						prompt,
						target_polycount: opts.targetPolycount ?? tier.polycount,
						tier: tier.id,
						path,
						seed: opts.seed ?? undefined,
					},
				});
			} catch (err) {
				if (err?.code === 'mode_unconfigured') {
					return json(res, 501, {
						error: 'backend_unconfigured',
						backend: backendId,
						message:
							'Sketch-to-3D is not configured on this deployment (GCP_TRIPOSG_URL is not set).',
					});
				}
				// The sketch model is conditioned on the drawing — no other lane can
				// serve it, so there is nothing to fail over to. Cool the worker so the
				// next request skips it while it recovers, and return a designed,
				// retryable state instead of a raw provider error.
				if (isUpstreamUnavailable(err)) {
					await markLaneUnhealthy('triposg');
					console.warn(`[forge] self-host sketch lane unavailable: ${err?.message || err}`);
					res.setHeader('retry-after', '20');
					return json(res, 503, {
						error: 'generation_unavailable',
						backend: backendId,
						message:
							'The sketch-to-3D worker is warming up or briefly unavailable. Try again in a moment.',
						retry_after: 20,
					});
				}
				throw err;
			}

			// Wrap the GCP job envelope in a forge token so polling routes back to
			// the GCP provider — same idiom as the Hunyuan3D lane.
			const token = encodeJobToken({ provider: 'gcp', kind: null, taskId: job.extJobId });
			const creationId = await createCreation({
				clientKey: clientKeyFrom(req),
				userId: await sessionUserIdFromReq(req),
				ipHash: hashIp(ip),
				prompt,
				aspect: null,
				previewImageUrl: sketchUrl,
				replicateJobId: job.extJobId,
				textToImageModel: null,
				viewsRequested: 1,
				viewsUsed: 1,
				multiview: false,
				backend: backendId,
				tier: tier.id,
				path,
			});
			await bindJobToOptions(token, opts);

			const sketchCold = await coldStartFor(backendId);
			return json(res, 200, {
				job_id: token,
				creation_id: creationId,
				status: 'queued',
				mode: 'sketch_to_3d',
				path,
				tier: tier.id,
				backend: backendId,
				prompt,
				preview_image_url: sketchUrl,
				reference_image_urls: [sketchUrl],
				cold_start: sketchCold,
				eta_seconds: estimateEtaSeconds({ backendId, tier, cold: sketchCold }),
				estimated_credits: estimateCredits({ backendId, path, tier }),
				options: opts.hasOptions ? summarizeForgeOptions(opts) : undefined,
			});
		}

		// ── BYOK geometry-style providers (Meshy / Tripo / Rodin / Stability) ────
		// A native 3D model emits mesh geometry directly — from the prompt
		// (text→geometry) or a single photo (image→3D) — with no synthesized
		// intermediate view, so detail isn't capped by one image. These backends
		// have no platform key; the caller supplies their own. Dispatch is a
		// registry lookup on the backend's `byok` name (Replicate BYOK is handled
		// on the image-intermediate path below — it speaks a different interface).
		const byokProvider = BACKENDS[backendId].byok;
		const byokFactory = BYOK_PROVIDER_FACTORIES[byokProvider];
		if (byokFactory) {
			const key = await resolveProviderKey(req, body, byokProvider);
			if (!key) return needsKey(res, backendId);

			let gp;
			try {
				gp = byokFactory(key);
			} catch {
				return needsKey(res, backendId);
			}

			let submitted;
			let previewImageUrl = null;
			if (isImageMode) {
				// The native image→3D endpoints reconstruct from a single primary
				// view; multi-view fusion stays on the image/TRELLIS path.
				previewImageUrl = imageUrls[0];
				submitted = await gp.imageTo3d({
					imageUrl: previewImageUrl,
					prompt: prompt || undefined,
					tier,
				});
			} else if (typeof gp.textToGeometry === 'function') {
				submitted = await gp.textToGeometry({ prompt, tier });
			} else {
				// Image-only backend (e.g. Stable Fast 3D) asked to run text→3D.
				return json(res, 422, {
					error: 'backend_image_only',
					backend: backendId,
					message: `${BACKENDS[backendId].label} reconstructs from a reference image — attach one, or drop the backend to use a text→3D engine.`,
				});
			}

			const clientKey = clientKeyFrom(req);

			// Synchronous completion (Stable Fast 3D): the provider already persisted
			// the GLB to R2 and handed back a durable url — no task to poll. Record a
			// finished creation and return done so the client skips polling, exactly
			// like the NVIDIA NIM synchronous path.
			if (!submitted.taskId && submitted.resultGlbUrl) {
				const syntheticJob = randomUUID().replace(/-/g, '');
				const creationId = await createCreation({
					clientKey,
					userId: await sessionUserIdFromReq(req),
					ipHash: hashIp(ip),
					prompt: prompt || (isImageMode ? 'image-to-3d' : ''),
					aspect: isImageMode ? null : aspect,
					previewImageUrl,
					replicateJobId: syntheticJob,
					textToImageModel: null,
					viewsRequested: isImageMode ? imageUrls.length : 0,
					viewsUsed: isImageMode ? 1 : null,
					multiview: false,
					backend: backendId,
					tier: tier.id,
					path,
				});
				const durable = await materializeCreation({
					replicateJobId: syntheticJob,
					clientKey,
					userId: await sessionUserIdFromReq(req),
					glbUrl: submitted.resultGlbUrl,
					quality: true,
					compress: opts.compression !== 'none' ? opts.compression : null,
				});
				return json(res, 200, {
					job_id: null,
					creation_id: durable?.id ?? creationId,
					status: 'done',
					glb_url: durable?.glbUrl ?? submitted.resultGlbUrl,
					durable: Boolean(durable),
					quality: durable?.quality || null,
					compression: durable?.compression || null,
					options: opts.hasOptions ? summarizeForgeOptions(opts) : undefined,
					mode: isImageMode ? 'image_to_3d' : 'text_to_3d',
					path,
					tier: tier.id,
					backend: backendId,
					prompt: prompt || null,
					preview_image_url: previewImageUrl,
					reference_image_urls: isImageMode ? [imageUrls[0]] : [],
					eta_seconds: estimateEtaSeconds({ backendId, tier }),
					estimated_credits: estimateCredits({ backendId, path, tier }),
				});
			}

			const token = encodeJobToken({
				provider: byokProvider,
				kind: submitted.kind,
				taskId: submitted.taskId,
			});
			await bindJobToOptions(token, opts);

			// Store the upstream task id as the job handle so findByJob/materialize
			// resolve it on poll, exactly like the Replicate path.
			const creationId = await createCreation({
				clientKey,
				userId: await sessionUserIdFromReq(req),
				ipHash: hashIp(ip),
				prompt: prompt || (isImageMode ? 'image-to-3d' : ''),
				aspect: isImageMode ? null : aspect,
				previewImageUrl,
				replicateJobId: submitted.taskId,
				textToImageModel: null,
				viewsRequested: isImageMode ? imageUrls.length : 0,
				viewsUsed: isImageMode ? 1 : null,
				multiview: false,
				backend: backendId,
				tier: tier.id,
				path,
			});

			return json(res, 200, {
				job_id: token,
				creation_id: creationId,
				status: 'queued',
				mode: isImageMode ? 'image_to_3d' : 'text_to_3d',
				path,
				tier: tier.id,
				backend: backendId,
				prompt: prompt || null,
				preview_image_url: previewImageUrl,
				reference_image_urls: isImageMode ? [imageUrls[0]] : [],
				eta_seconds: estimateEtaSeconds({ backendId, tier }),
				estimated_credits: estimateCredits({ backendId, path, tier }),
			});
		}

			// ── Free NVIDIA NIM TRELLIS lane (platform-keyed; direct text→3D) ────────
			// TRELLIS on NIM emits the mesh natively from the prompt (no FLUX
			// intermediate view) and needs no BYOK key. It serves prompt submissions
			// on the image path as the free draft default; photo submissions never
			// resolve here (hosted preview is text-only — see the provider header).
			// The free NVIDIA NIM lane is a flaky synchronous upstream — NVCF can be
			// unreachable, accept the job but drop the request id, or finish with no
			// artifact, and a missing module/key throws on load. Per the free-first
			// "AI must never fail" policy none of these may surface as a dead 502: a
			// failure here transparently degrades to the platform image-intermediate
			// TRELLIS lane so the zero-setup free default still returns a model. Only
			// the unit cost changes, and only when NIM is down. Provenance reports the
			// lane that actually ran (trellis below), so the downgrade is never silent.
			if (backendId === 'nvidia') {
				nvidiaTried = true;
				// Skip the submit-timeout gamble when the lane is in a recent-failure
				// cooldown — go straight to the reconstruct lane instead of re-hanging.
				// BUT only when that reconstruct lane is a real destination: it free-firsts
				// to HuggingFace and then the paid Replicate account, so it's viable when HF
				// is configured OR the paid account isn't itself recorded out-of-credit. When
				// both are gone, skipping NIM would route straight into a dead paid lane and
				// 503 the user — so we ignore the cooldown and give the free lane a real shot.
				const cooldowns = await providersInCooldown([
					NIM_TRELLIS_COOLDOWN_KEY,
					REPLICATE_PAID_COOLDOWN_KEY,
				]);
				const trellisCooling = cooldowns.has(NIM_TRELLIS_COOLDOWN_KEY);
				const reconstructLaneViable =
					backendIsConfigured('huggingface') || !cooldowns.has(REPLICATE_PAID_COOLDOWN_KEY);
				if (trellisCooling && reconstructLaneViable) {
					console.warn('[forge] NVIDIA NIM TRELLIS lane in cooldown; routing to reconstruct lane');
					nimGatewayDegraded = true;
					backendId = 'trellis';
				} else if (await runNvidiaTextLane({ req, res, ip, prompt, aspect, tier, path, opts, cacheKey })) {
					return;
				} else {
					// nvidia failed → fall through to the image-intermediate TRELLIS path
					// below, which gives the prompt a second chance on Replicate. The NVCF
					// gateway is degraded, so the FLUX synthesis below skips its NIM lane too.
					nimGatewayDegraded = true;
					backendId = 'trellis';
				}
			}

			// ── Image-intermediate path (TRELLIS default, or Hunyuan3D self-host) ────
			// Hunyuan3D runs on its own Cloud Run worker (GCP_HUNYUAN3D_URL) — never
			// the avatar pipeline controller, whose face pipeline fails every
			// non-face image with "no face detected".
			// Replicate BYOK runs the same reconstruction models on the caller's own
			// Replicate account — resolve their token up front (distinct from the
			// platform-keyed TRELLIS default).
			let byokReplicateKey = null;
			if (backendId === 'replicate_byok') {
				byokReplicateKey = await resolveProviderKey(req, body, 'replicate');
				if (!byokReplicateKey) return needsKey(res, backendId);
			}

			let provider;
			try {
				if (backendId === 'hunyuan3d') {
					const hunyuanUrl = process.env.GCP_HUNYUAN3D_URL;
					if (!hunyuanUrl) throw new Error('GCP_HUNYUAN3D_URL is not set');
					provider = createGcpProvider({ reconstructUrl: hunyuanUrl });
				} else if (backendId === 'replicate_byok') {
					provider = createRegenProvider({ apiToken: byokReplicateKey });
				} else if (backendId === 'huggingface') {
					// The free HF Spaces lane is driven by runHfImageLane() below — it
					// creates its own provider. We deliberately do NOT build a Replicate
					// client here: creating one would 503 on a deployment that has no
					// REPLICATE_API_TOKEN, breaking an explicitly-chosen free engine.
				} else if (backendId === 'trellis_selfhost') {
					// Driven by the dedicated self-host TRELLIS lane below, which builds
					// its own GCP provider. Same reasoning as huggingface — never build a
					// Replicate client here, or a deployment without REPLICATE_API_TOKEN
					// would 503 on an explicitly-chosen free self-hosted engine.
				} else {
					provider = createRegenProvider();
				}
			} catch {
				// A selected-but-unconfigured self-host backend gets a branchable 501;
				// the default TRELLIS path keeps its existing "not configured" 503.
				if (backendId === 'hunyuan3d') {
					return json(res, 501, {
						error: 'backend_unconfigured',
						backend: 'hunyuan3d',
						message: 'Hunyuan3D self-host is not configured on this deployment.',
					});
				}
				if (backendId === 'replicate_byok') return needsKey(res, backendId);
				// The default TRELLIS (Replicate) provider couldn't be built — no
				// REPLICATE_API_TOKEN. That alone is NOT "unconfigured" when the free
				// HuggingFace Spaces lane is live: a degraded-from-NVIDIA text prompt, or
				// a photo→3D request, must still reconstruct on the free lane rather than
				// dead-ending at a 503. Leave `provider` undefined and fall through — the
				// free-first HF block below serves it, and the `!provider` guard further
				// down raises a designed unavailable state only if every free lane is gone
				// too. Mirrors the self-host TRELLIS failover (provider = undefined) above.
				if (backendId === 'trellis' && backendIsConfigured('huggingface')) {
					provider = undefined;
				} else {
					return unconfigured(res);
				}
		}

		// In-flight coalescing: if an identical (path, tier, backend, prompt, images)
		// request is already generating, hand its job back instead of running the
		// whole FLUX→reconstruct pipeline a second time. Collapses double-clicks and
		// viral-prompt bursts to one generation that N clients poll. Skipped for high
		// tier (paid/gated per caller) so a payment is never shared across users.
		if (tier.id !== 'high') {
			requestHash = forgeRequestHash({
				path,
				tier: tier.id,
				backend: backendId,
				prompt,
				images: isImageMode ? imageUrls : null,
			});
			const existing = await coalesceInFlight(requestHash);
			if (existing) {
				return json(res, 200, {
					job_id: existing,
					status: 'queued',
					coalesced: true,
					mode: isImageMode ? 'image_to_3d' : 'text_to_3d',
					path,
					tier: tier.id,
					backend: backendId,
					prompt: prompt || null,
					eta_seconds: estimateEtaSeconds({ backendId, tier }),
				});
			}
		}

		// Resolve the reference views: supplied directly (image→3D) or a single
		// view synthesized from the prompt (text→3D). `referenceImageUrl` is the
		// primary view — the durable preview + the synthesis target.
		let referenceImageUrl;
		let textToImageModel;
		let views;
		if (isImageMode) {
			views = imageUrls;
			referenceImageUrl = imageUrls[0];
			textToImageModel = null;
		} else {
			// Optional Granite art-director pass (off by default): rewrites the raw
			// prompt into a richer, single-subject spec (form, per-part materials,
			// one held style, composition constraints) before it drives the FLUX
			// reference image — the same director the free MCP tools use. Fail-soft:
			// any failure (chat lane down, timeout) silently keeps the raw prompt, so
			// opting in can only ever help, never break, a generation.
			let directedPrompt = prompt;
			if (body?.director === true) {
				// Known brand marks resolve deterministically before the LLM gets a
				// say: no model reliably knows a niche mark's geometry, and the
				// lexicon spec is already a tight single-subject description.
				const knownMark = resolveLogoPrompt(prompt);
				if (knownMark) {
					directedPrompt = knownMark.prompt;
				} else {
					const directed = await directPrompt(MESH_DIRECTOR, prompt).catch(() => null);
					if (directed) directedPrompt = directed;
				}
			}
			const synthesized = await textToImage(directedPrompt, {
				aspectRatio: aspect,
				skipNim: nimGatewayDegraded,
				seed: opts.seed ?? undefined,
			});
			referenceImageUrl = synthesized.imageUrl;
			textToImageModel = synthesized.model;
			views = [referenceImageUrl];
		}

		// Explicitly chosen free HuggingFace lane. Unlike the trellis free-first
		// path below — which degrades to the paid Replicate lane when the free
		// Spaces are down — an explicit pick of the FREE engine must never silently
		// fall through to a paid lane: that would spend credits the user
		// deliberately opted out of. So we run the free Spaces and, if every one is
		// busy/down, return a designed error the UI can act on (retry / switch engine).
		//
		// Self-hosted TRELLIS image-to-3D lane (platform-keyed; native single-hop).
		// Our own Microsoft TRELLIS worker (workers/model-trellis) reconstructs a
		// textured mesh DIRECTLY from the primary reference view -- the user's photo,
		// or the FLUX-synthesized view for a text prompt -- with no vendor cost. This
		// is the native single-hop image-to-3D NVIDIA's hosted preview can't do (it
		// rejects user images); a self-deployed NIM accepts them. Async like the
		// sketch lane: returns a poll token that routes back through the gcp provider's
		// status(). Reached on an explicit pick OR as the preferred free image lane
		// (FREE_FALLBACK_FOR_PATH) when MODEL_TRELLIS_URL is configured.
		if (backendId === 'trellis_selfhost') {
			let gcp;
			try {
				gcp = createGcpProvider();
			} catch {
				return json(res, 501, {
					error: 'backend_unconfigured',
					backend: 'trellis_selfhost',
					message: 'Self-hosted TRELLIS is not configured on this deployment.',
				});
			}

			let job;
			let selfHostTrellisFailed = false;
			try {
				job = await gcp.submit({
					mode: 'trellis',
					sourceUrl: referenceImageUrl,
					params: { images: views, seed: opts.seed ?? undefined },
				});
			} catch (err) {
				if (err?.code === 'mode_unconfigured') {
					return json(res, 501, {
						error: 'backend_unconfigured',
						backend: 'trellis_selfhost',
						message:
							'Self-hosted TRELLIS is not configured on this deployment (MODEL_TRELLIS_URL is not set).',
					});
				}
				// A genuine config/input fault surfaces as-is. An upstream blip (the
				// worker is cold, restarting, throttled, or briefly unreachable) must
				// not fail a request another lane can serve: cool this lane so the next
				// request skips it, then fail over below to our other self-host worker
				// (Hunyuan3D) or the standing reconstruct chain (which free-firsts to HF
				// and only then the paid lane). We already hold the reference views, so
				// the next lane reconstructs from exactly the same input.
				if (!isUpstreamUnavailable(err)) throw err;
				await markLaneUnhealthy('trellis_selfhost');
				console.warn(
					`[forge] self-host TRELLIS lane unavailable (${err?.providerStatus || err?.code}); failing over to the next image lane`,
				);
				selfHostTrellisFailed = true;
			}

			if (!selfHostTrellisFailed) {
				// Wrap the gcp job envelope in a forge token so polling routes back to the
				// gcp provider -- same idiom as the sketch and Hunyuan3D lanes.
				const token = encodeJobToken({ provider: 'gcp', kind: null, taskId: job.extJobId });
				const clientKey = clientKeyFrom(req);
				const creationId = await createCreation({
					clientKey,
					userId: await sessionUserIdFromReq(req),
					ipHash: hashIp(ip),
					prompt: prompt || (isImageMode ? 'image-to-3d' : ''),
					aspect: isImageMode ? null : aspect,
					previewImageUrl: referenceImageUrl,
					replicateJobId: job.extJobId,
					textToImageModel: isImageMode ? null : textToImageModel,
					viewsRequested: views.length,
					viewsUsed: job.viewsUsed ?? views.length,
					multiview: views.length > 1,
					backend: backendId,
					tier: tier.id,
					path,
				});
				if (cacheKey) await bindJobToCacheKey(token, cacheKey);
				await bindJobToOptions(token, opts);

				const cold = await coldStartFor(backendId);
				return json(res, 200, {
					job_id: token,
					creation_id: creationId,
					status: 'queued',
					mode: isImageMode ? 'image_to_3d' : 'text_to_3d',
					path,
					tier: tier.id,
					backend: backendId,
					prompt: prompt || null,
					preview_image_url: referenceImageUrl,
					reference_image_urls: isImageMode ? [imageUrls[0]] : [referenceImageUrl],
					text_to_image_model: isImageMode ? null : textToImageModel,
					cold_start: cold,
					options: opts.hasOptions ? summarizeForgeOptions(opts) : undefined,
					eta_seconds: estimateEtaSeconds({ backendId, tier, cold }),
					estimated_credits: estimateCredits({ backendId, path, tier }),
				});
			}

			// Fail over from the down self-host TRELLIS worker. Prefer our other
			// self-host GPU lane (Hunyuan3D) when it's wired; otherwise hand off to the
			// standing reconstruct chain (backend 'trellis'), which free-firsts to the
			// HuggingFace Spaces lane and only then the paid Replicate account. Falls
			// through (no return) into the lane blocks below; provenance reports the
			// lane that actually runs, so the failover is never silent.
			if (process.env.GCP_HUNYUAN3D_URL && process.env.GCP_RECONSTRUCTION_KEY) {
				backendId = 'hunyuan3d';
				provider = createGcpProvider({ reconstructUrl: process.env.GCP_HUNYUAN3D_URL });
			} else {
				backendId = 'trellis';
				try {
					provider = createRegenProvider();
				} catch {
					provider = undefined;
				}
			}
		}

		if (backendId === 'huggingface') {
			if (
				await runHfImageLane({
					req,
					res,
					ip,
					imageUrls: views,
					prompt,
					aspect,
					tier,
					path,
					mode: isImageMode ? 'image_to_3d' : 'text_to_3d',
					previewImageUrl: referenceImageUrl,
					textToImageModel,
					opts,
					cacheKey,
				})
			)
				return;
			return json(res, 502, {
				error: 'provider_busy',
				backend: 'huggingface',
				message:
					'The free 3D Spaces are all busy or warming up right now. Try again in a moment, or pick another engine.',
			});
		}

		// Free-first: exhaust the free reconstruct lane (HuggingFace Spaces) BEFORE
		// the paid Replicate default, so a forge call never spends on — or dead-ends
		// against — the paid account while a free lane can serve it. We already hold
		// the reference views (uploaded, or FLUX-synthesized above), so the free lane
		// reconstructs from exactly what Replicate would have. Scoped to the default
		// trellis lane: an explicitly chosen Hunyuan3D / Replicate-BYOK backend is
		// honored as picked. When the free lane is unavailable (no HF_TOKEN) or it
		// fails, we fall through to Replicate, which keeps its own fallback chain.
		// Reversible via FORGE_PREFER_FREE=false. Provenance reports backend:huggingface
		// so the chosen lane is never silent.
		if (preferFreeReconstruct() && backendId === 'trellis') {
			if (
				await runHfImageLane({
					req,
					res,
					ip,
					imageUrls: views,
					prompt,
					aspect,
					tier,
					path,
					mode: isImageMode ? 'image_to_3d' : 'text_to_3d',
					previewImageUrl: referenceImageUrl,
					textToImageModel,
					opts,
					cacheKey,
				})
			)
				return;
		}

		// Only poly-aware backends (Hunyuan3D self-host) accept a target budget;
		// TRELLIS validates its input schema and would 422 on an unknown field, so
		// the tier rides along as the recorded provenance only. `seed` is a
		// recognized generation param across the TRELLIS family and Hunyuan3D
		// alike (survives stripInternal() and overrides the provider's own
		// default), so it's forwarded unconditionally, not gated on polyControl.
		const reconstructParams = { images: views, prompt: prompt || undefined };
		if (opts.seed !== null) reconstructParams.seed = opts.seed;
		if (BACKENDS[backendId].polyControl) {
			reconstructParams.target_polycount = opts.targetPolycount ?? tier.polycount;
			reconstructParams.tier = tier.id;
			reconstructParams.path = path;
			if (opts.textureSize) reconstructParams.texture_size = opts.textureSize;
		}

		let job;
		try {
			// A self-host failover landed here with no paid provider configured (no
			// REPLICATE_API_TOKEN) and the free HF lane above didn't serve the request
			// — there is no reconstruct lane left. Raise it as upstream-unavailable so
			// the catch below runs the remaining free fallbacks (Hunyuan3D → HF) and,
			// if those are gone too, surfaces a designed unavailable state.
			if (!provider) {
				throw Object.assign(new Error('no reconstruct lane configured'), {
					code: 'provider_unreachable',
					status: 502,
				});
			}
			// Per-provider submit throttle: shed platform Replicate bursts to the free
			// lane BEFORE they hit the account quota and turn into fleet-wide 429s. Only
			// the platform-keyed default lane is capped — BYOK lanes spend the caller's
			// own quota. Over-cap is thrown as upstream-unavailable so the existing
			// fallback chain (self-host Hunyuan3D → free HuggingFace) absorbs it.
			if (
				backendId === 'trellis' &&
				!(await providerSubmitAllowed('replicate', {
					limit: SCALE_LIMITS.replicateSubmitLimit,
					windowS: SCALE_LIMITS.replicateSubmitWindowS,
				}))
			) {
				console.warn('[forge] platform Replicate submit throttle hit; shedding to free lane');
				throw Object.assign(new Error('platform submit throttle'), {
					code: 'rate_limited',
					providerStatus: 429,
				});
			}
			job = await provider.submit({
				mode: 'reconstruct',
				sourceUrl: referenceImageUrl,
				params: reconstructParams,
			});
		} catch (submitErr) {
			// Free fallback chain when the default TRELLIS lane (Replicate) is
			// over-quota or unreachable. Covers two modes:
			//   • image→3D: user photos can't fall to the text NIM lane (it's
			//     text-only), so we need a reconstruct-capable fallback here.
			//   • text→3D via NVIDIA fallback: NIM failed first (nvidiaTried=true),
			//     TRELLIS was the second attempt; we already have a synthesized
			//     referenceImageUrl from textToImage(), so the same reconstruct
			//     fallbacks apply. Without this branch the outer catch re-checks
			//     nvidiaTried=true and skips NIM, leaving the user with a 429.
			// Scoped to the default trellis backend only — an explicitly chosen
			// Hunyuan3D / BYOK backend that fails surfaces its own error. Provenance
			// always reports the lane that actually ran so any downgrade is visible.
			const upstreamGone =
				backendId === 'trellis' &&
				isUpstreamUnavailable(submitErr) &&
				(isImageMode || referenceImageUrl != null);
			if (!upstreamGone) throw submitErr;

			const mode3d = isImageMode ? 'image→3D' : 'text→3D (via synthesized image)';

			// Fallback #1 — self-hosted TRELLIS Cloud Run worker (workers/model-trellis),
			// when wired and not cooled. FREE_FALLBACK_FOR_PATH prefers it first among
			// the free image lanes, so this paid-lane failover walks the same order:
			// our own GPU (zero vendor cost) before any external free allocation. It
			// reconstructs single-hop from the referenceImageUrl we already hold.
			if (backendIsConfigured('trellis_selfhost')) {
				let selfHostUsable = true;
				try {
					const snap = await laneHealthSnapshot(['trellis_selfhost']);
					selfHostUsable = snap.byId.trellis_selfhost?.status !== 'down';
				} catch {
					// No telemetry → try the lane anyway; the submit catch below cools it.
				}
				if (selfHostUsable) {
					console.warn(
						`[forge] platform TRELLIS lane unavailable (${submitErr?.providerStatus || submitErr?.code}); degrading ${mode3d} to self-hosted TRELLIS`,
					);
					try {
						const gcp = createGcpProvider();
						job = await gcp.submit({
							mode: 'trellis',
							sourceUrl: referenceImageUrl,
							params: { images: views, seed: opts.seed ?? undefined },
						});
						backendId = 'trellis_selfhost';
						provider = gcp;
					} catch (selfErr) {
						// A config/input fault surfaces as-is; an upstream blip cools the
						// lane and falls through to the remaining reconstruct fallbacks.
						if (!isUpstreamUnavailable(selfErr)) throw selfErr;
						await markLaneUnhealthy('trellis_selfhost');
						console.warn(
							`[forge] self-host TRELLIS fallback unavailable (${selfErr?.providerStatus || selfErr?.code}); trying the next image lane`,
						);
					}
				}
			}

			// Fallback #2 — self-hosted Hunyuan3D Cloud Run worker, when wired.
			const hunyuanUrl = process.env.GCP_HUNYUAN3D_URL;
			if (!job && hunyuanUrl && process.env.GCP_RECONSTRUCTION_KEY) {
				console.warn(
					`[forge] platform TRELLIS lane unavailable (${submitErr?.providerStatus || submitErr?.code}); degrading ${mode3d} to self-hosted Hunyuan3D`,
				);
				backendId = 'hunyuan3d';
				provider = createGcpProvider({ reconstructUrl: hunyuanUrl });
				// Hunyuan3D is poly-aware — supply the tier budget the TRELLIS params omit.
				reconstructParams.target_polycount = opts.targetPolycount ?? tier.polycount;
				reconstructParams.tier = tier.id;
				reconstructParams.path = path;
				if (opts.textureSize) reconstructParams.texture_size = opts.textureSize;
				job = await provider.submit({
					mode: 'reconstruct',
					sourceUrl: referenceImageUrl,
					params: reconstructParams,
				});
			} else if (!job) {
				// Fallback #3 — free Hugging Face Spaces image→3D (gated on HF_TOKEN).
				// It blocks and writes its own status:'done' response; if it does, the
				// request is complete. Otherwise fall through to surface the real error.
				// For text mode, views=[referenceImageUrl] (the FLUX-synthesized image).
				console.warn(
					`[forge] platform TRELLIS lane unavailable (${submitErr?.providerStatus || submitErr?.code}); trying free HuggingFace ${mode3d} lane`,
				);
				if (
					await runHfImageLane({
						req,
						res,
						ip,
						imageUrls: views,
						prompt,
						aspect,
						tier,
						path,
						mode: isImageMode ? 'image_to_3d' : 'text_to_3d',
						previewImageUrl: referenceImageUrl,
						textToImageModel,
						opts,
						cacheKey,
					})
				) {
					return;
				}
				throw submitErr;
			}
		}

		// How the job was actually conditioned. The provider reports back which
		// backend handled it and how many views it fused — these can differ from
		// what was requested when a single-view model is configured and we fall
		// back to the primary view. Surfaced so a downgrade is never silent.
		const viewsRequested = views.length;
		const viewsUsed = typeof job.viewsUsed === 'number' ? job.viewsUsed : viewsRequested;
		const multiview = Boolean(job.multiview);

		// TRELLIS returns a bare Replicate prediction id (kept as the job handle
		// for backward compatibility); the GCP/Hunyuan3D provider returns its own
		// opaque envelope, which we wrap in a forge token so polling routes back to
		// the GCP provider. Replicate BYOK uses the same bare id but a distinct
		// token tag so polling re-resolves the caller's key (not the platform one).
		// Either way the upstream id is what the store keys on.
		const jobHandle =
			backendId === 'hunyuan3d' || backendId === 'trellis_selfhost'
				? encodeJobToken({ provider: 'gcp', kind: null, taskId: job.extJobId })
				: backendId === 'replicate_byok'
					? encodeJobToken({ provider: 'replicate_byok', kind: null, taskId: job.extJobId })
					: job.extJobId;

		// Record the generation the moment it starts so the prompt + reference
		// image survive even if the mesh step later fails. Fail-soft: a missing
		// store just means no durable copy + no gallery entry for this run.
		const creationId = await createCreation({
			clientKey: clientKeyFrom(req),
			userId: await sessionUserIdFromReq(req),
			ipHash: hashIp(ip),
			prompt: prompt || (isImageMode ? 'image-to-3d' : ''),
			aspect,
			previewImageUrl: referenceImageUrl,
			replicateJobId: job.extJobId,
			textToImageModel,
			viewsRequested,
			viewsUsed,
			multiview,
			backend: backendId,
			tier: tier.id,
			path,
		});

		// Publish this job as the canonical handle for its fingerprint so identical
		// requests in the next few minutes coalesce onto it instead of re-running the
		// GPU pipeline. First writer wins; best-effort (no-op without Redis).
		await registerInFlight(requestHash, jobHandle);
		// Cache-eligibility was fixed before any lane failover reassigned backendId;
		// a BYOK pick already disqualified it above, so it's always safe to bind
		// here for whichever platform lane actually ran.
		if (cacheKey) await bindJobToCacheKey(jobHandle, cacheKey);
		await bindJobToOptions(jobHandle, opts);

		// Honest cold-start: only a self-host worker reached cold widens the ETA
		// (a paid/external lane returns false). Covers the Hunyuan3D self-host
		// fallback this block serves after a self-host TRELLIS failover.
		const cold = await coldStartFor(backendId);
		return json(res, 200, {
			job_id: jobHandle,
			creation_id: creationId,
			status: 'queued',
			mode: isImageMode ? 'image_to_3d' : 'text_to_3d',
			path,
			tier: tier.id,
			backend: backendId,
			prompt: prompt || null,
			preview_image_url: referenceImageUrl,
			reference_image_urls: views,
			views_requested: viewsRequested,
			views_used: viewsUsed,
			multiview,
			text_to_image_model: textToImageModel,
			cold_start: cold,
			options: opts.hasOptions ? summarizeForgeOptions(opts) : undefined,
			eta_seconds: estimateEtaSeconds({ backendId, tier, cold }),
			estimated_credits: estimateCredits({ backendId, path, tier }),
		});
	} catch (err) {
		if (err?.code === 'unconfigured') return unconfigured(res);
		if (err?.code === 'invalid_key') {
			return json(res, 401, {
				error: 'invalid_key',
				message: err.message || 'The provider rejected this API key.',
			});
		}
		if (err?.code === 'insufficient_credits' && BACKENDS[backendId]?.byok) {
			// BYOK lane: the message names the CALLER'S own provider account, which
			// they can act on — surface it. The platform's own paid lane falls through
			// to the sanitized "temporarily unavailable" state below.
			return json(res, 402, {
				error: 'insufficient_credits',
				message: err.message || 'The provider account is out of credits.',
			});
		}
		// Last-resort free fallback: when the paid image-intermediate TRELLIS lane
		// (Replicate) is throttled, over-quota, unreachable, OR out of credit, a text
		// prompt must never dead-end — degrade to the free NVIDIA NIM lane so the
		// default "type a prompt → get a model" flow always returns something. The
		// credit-exhaustion case matters most here: the failure is the paid FLUX
		// synthesis step (textToImage throws code:'billing'/402, which is NOT
		// upstream-unavailable), but the NIM TRELLIS lane is native text→mesh and
		// needs no FLUX intermediate at all — so a dry Replicate account should hand
		// the prompt to the healthy free lane rather than skip straight to the 503.
		// Honors the free-first "AI must never fail" policy; provenance reports
		// backend:nvidia so the downgrade is visible, not silent. Image uploads have
		// no free reconstruct fallback here (NVCF is text-only — the HF lane already
		// absorbed them above), so they fall through to the designed states below.
		// `nvidiaTried` guards against re-running a lane that already failed this
		// request (the draft nvidia→trellis→nvidia loop).
		if (
			(isUpstreamUnavailable(err) || isPaidCreditFailure(err)) &&
			!isImageMode &&
			!nvidiaTried &&
			prompt
		) {
			nvidiaTried = true;
			// Don't degrade to NIM when it's already in a recent-failure cooldown — that
			// would just re-pay the submit timeout on a lane we know is down right now.
			const trellisCooling = (await providersInCooldown([NIM_TRELLIS_COOLDOWN_KEY])).has(
				NIM_TRELLIS_COOLDOWN_KEY,
			);
			if (!trellisCooling) {
				console.warn(
					`[forge] paid TRELLIS lane unavailable (${err?.providerStatus || err?.code}); degrading text→3D to free NVIDIA NIM`,
				);
				try {
					if (await runNvidiaTextLane({ req, res, ip, prompt, aspect, tier, path, opts, cacheKey })) return;
				} catch (fallbackErr) {
					console.warn(`[forge] NVIDIA NIM fallback also failed: ${fallbackErr?.message || fallbackErr}`);
				}
			}
		}

		// Upstream throttling is a transient 429, not a server fault — return it as
		// such with a retry hint so the page can show a "busy, try again" state.
		if (err?.code === 'rate_limited' || err?.providerStatus === 429) {
			const retryAfter = typeof err?.retryAfter === 'number' ? err.retryAfter : 10;
			res.setHeader('retry-after', String(retryAfter));
			// A `queued` throttle is our own rate gate pacing the request to the
			// upstream limit (not an upstream rejection) — tell the user it's in line so
			// a retry reads as "your turn is coming up", not "the system is failing".
			const queued = Boolean(err?.queued);
			return json(res, 429, {
				error: 'rate_limited',
				queued,
				message: queued
					? `Your generation is queued behind a few others — retry in ~${retryAfter}s to pick it up.`
					: 'The 3D generator is busy right now. Try again in a few seconds.',
				retry_after: retryAfter,
			});
		}
		// Free lanes are exhausted and the only remaining lane was the platform's
		// PAID vendor account, which is out of credit. The vendor's raw "buy credit"
		// message is our internal billing state and is useless to the user — answer
		// with an honest, generic unavailable state instead of leaking it. (BYOK lanes
		// kept their actionable account message via the insufficient_credits branch.)
		if (!BACKENDS[backendId]?.byok && isPaidCreditFailure(err)) {
			const creditDetail = err?.providerDetail ? ` — vendor: ${err.providerDetail}` : '';
			console.warn(
				`[forge] paid reconstruct lane out of credit and no free lane available: ${err?.message || err}${creditDetail}`,
			);
			// Record the paid lane as down (reason 'auth' — a billing fault that won't
			// self-heal until ops tops the account up). The NIM-cooldown router reads this
			// so the next text prompt keeps the free NIM lane in play instead of skipping
			// it to route into this now-known-dead paid lane.
			markProviderCooldown(
				REPLICATE_PAID_COOLDOWN_KEY,
				REPLICATE_PAID_COOLDOWN_SECONDS,
				'auth',
			).catch(() => {});
			res.setHeader('retry-after', '30');
			return json(res, 503, {
				error: 'generation_unavailable',
				message: 'Free 3D generation is temporarily unavailable. Please try again shortly.',
				retry_after: 30,
			});
		}
		return json(res, 502, {
			error: 'generation_failed',
			message: err?.message || 'The generator could not start this job.',
		});
	} finally {
		// A claimed pay-per-use payment that did NOT deliver a model — any non-2xx
		// exit (validation 4xx, unconfigured 5xx, provider failure) — is released so
		// the settled $THREE payment stays reusable on retry. A successful job (200)
		// keeps the claim, so one payment can never buy a second generation.
		if (paidHigh?.redeemed && res.statusCode >= 400) {
			await releaseForgePayment({ paymentId: paidHigh.paymentId }).catch(() => {});
		}
		// A charged prepaid generation that did NOT deliver (any non-2xx exit) is
		// refunded so credits are never spent on a failed job.
		if (creditsCharge?.ledgerId && creditsCharge.chargedUsd > 0 && res.statusCode >= 400) {
			await refundCredits({
				userId: creditsCharge.user.id,
				amountUsd: creditsCharge.chargedUsd,
				action: creditsCharge.action,
				refType: 'forge',
				refId: creditsCharge.ref,
				idempotencyKey: `forge:credits:refund:${creditsCharge.ledgerId}`,
				meta: { reason: 'generation_failed' },
			}).catch(() => {});
		}
	}
}

// Auto-rig an existing GLB mesh: skeleton + skin weights via the provider's
// `rerig` mode (VAST-AI UniRig by default). Takes a GLB URL, returns a job id
// that polls through the same GET ?job=<id> path — provider.status() is
// mode-agnostic, so the rigged GLB surfaces exactly like a reconstruction.
async function startRigJob(req, res) {
	const ip = clientIp(req);
	const rl = await limits.mcp3dGenerate(ip);
	if (!rl.success) {
		return rateLimited(res, rl, 'Rigging limit reached. Try again shortly.');
	}

	const body = await readJson(req, 8_000).catch(() => null);
	const glbUrl = typeof body?.glb_url === 'string' ? body.glb_url.trim() : '';
	if (!HTTP_URL_RE.test(glbUrl) || glbUrl.length > 2048) {
		return json(res, 400, {
			error: 'invalid_glb_url',
			message: 'glb_url must be an http(s) URL to a GLB mesh, under 2048 characters.',
		});
	}

	// Prefer the self-hosted GCP UniRig pipeline when it's configured — it supports
	// rerig out of the box via its /rig endpoint — and fall back to Replicate when
	// a REPLICATE_RERIG_MODEL is set. Mirrors the gcp-first resolution the MCP
	// studio path uses, so rigging works whenever ANY rerig-capable lane exists,
	// not only when the highest-precedence provider happens to be the rigger.
	let provider = null;
	let providerName = 'replicate';
	if (process.env.GCP_RECONSTRUCTION_KEY) {
		try {
			const gcp = createGcpProvider();
			if (gcp.supportsMode('rerig')) {
				provider = gcp;
				providerName = 'gcp';
			}
		} catch {
			// fall through to Replicate
		}
	}
	if (!provider) {
		try {
			const rep = createRegenProvider();
			if (rep.supportsMode('rerig')) {
				provider = rep;
				providerName = 'replicate';
			}
		} catch {
			return unconfigured(res);
		}
	}

	// Rigging stays dormant until a rerig lane is configured — surface a clean
	// 501 rather than a generic provider error so callers can branch on it.
	if (!provider) {
		return json(res, 501, {
			error: 'rig_unconfigured',
			message:
				'Auto-rigging is not configured on this deployment (set GCP_RECONSTRUCTION_URL + GCP_RECONSTRUCTION_KEY, or REPLICATE_RERIG_MODEL).',
		});
	}

	try {
		const job = await provider.submit({ mode: 'rerig', sourceUrl: glbUrl, params: {} });
		// GCP rig jobs poll through a token-encoded handle so /api/forge?action=status
		// routes back to the GCP worker; Replicate jobs use the bare prediction id.
		const jobToken =
			providerName === 'gcp'
				? encodeJobToken({ provider: 'gcp', kind: null, taskId: job.extJobId })
				: job.extJobId;
		const creationId = await createCreation({
			clientKey: clientKeyFrom(req),
			userId: await sessionUserIdFromReq(req),
			ipHash: hashIp(ip),
			prompt: 'auto-rig',
			aspect: null,
			previewImageUrl: null,
			replicateJobId: job.extJobId,
			textToImageModel: null,
		});
		return json(res, 200, {
			job_id: jobToken,
			creation_id: creationId,
			status: 'queued',
			mode: 'rig',
			source_glb_url: glbUrl,
			eta_seconds: typeof job.eta === 'number' ? job.eta : null,
		});
	} catch (err) {
		if (err?.code === 'mode_unconfigured') {
			return json(res, 501, { error: 'rig_unconfigured', message: err.message });
		}
		if (err?.code === 'rate_limited' || err?.providerStatus === 429) {
			res.setHeader('retry-after', '10');
			return json(res, 429, {
				error: 'rate_limited',
				message: 'The rigger is busy right now. Try again in a few seconds.',
				retry_after: 10,
			});
		}
		return json(res, 502, {
			error: 'rig_failed',
			message: err?.message || 'The rigger could not start this job.',
		});
	}
}

async function pollJob(req, res, jobId) {
	// A job handle is either a bare Replicate prediction id (legacy / image-
	// TRELLIS path) or a forge token encoding the geometry/GCP provider + the
	// upstream task id. Decode to learn which provider to poll.
	const token = decodeJobToken(jobId);
	if (!token && !JOB_ID_RE.test(jobId)) {
		return json(res, 400, { error: 'invalid_job', message: 'Malformed job id.' });
	}

	const rl = await limits.mcp3dStatus(clientIp(req));
	if (!rl.success) {
		return rateLimited(res, rl);
	}

	// A pipeline job token (POST /api/x402/pipeline) polls here too, but its record
	// is a multi-stage chain, not a single provider job. Hand it to the pipeline
	// engine, which advances the state machine one tick and returns per-stage
	// progress. Plain forge jobs (below) are unaffected.
	if (token?.provider === 'pipeline') {
		const { pollPipeline } = await import('./_lib/pipeline.js');
		return pollPipeline(res, token.taskId, jobId);
	}

	const provider = token?.provider || 'replicate';
	const upstreamId = token?.taskId || jobId;
	const clientKey = clientKeyFrom(req);

	// How this job was conditioned (path + tier + backend + view count), recorded
	// at submit time. Surfaced on every poll so a caller that only polls still
	// learns the provenance. Fail-soft: absent when the store is off.
	const meta = await findByJob({ replicateJobId: upstreamId, clientKey });
	const metaFields = meta
		? {
				views_requested: meta.views_requested ?? null,
				views_used: meta.views_used ?? null,
				multiview: meta.multiview ?? null,
				backend: meta.backend ?? null,
				tier: meta.tier ?? null,
				path: meta.path ?? null,
			}
		: {};

	// Poll the provider that owns this job. BYOK providers re-resolve the key per
	// poll (the client resends it, or it loads from the session store).
	let result;
	try {
		if (BYOK_PROVIDER_FACTORIES[provider]) {
			const key = await resolveProviderKey(req, null, provider);
			if (!key) {
				return json(res, 200, {
					job_id: jobId,
					status: 'failed',
					error: 'Your API key is required to check this job. Re-enter it and retry.',
					...metaFields,
				});
			}
			const gp = BYOK_PROVIDER_FACTORIES[provider](key);
			result = await gp.status({ kind: token.kind, taskId: upstreamId });
		} else if (provider === 'replicate_byok') {
			// Replicate BYOK polls the caller's own account (key name 'replicate').
			const key = await resolveProviderKey(req, null, 'replicate');
			if (!key) {
				return json(res, 200, {
					job_id: jobId,
					status: 'failed',
					error: 'Your API key is required to check this job. Re-enter it and retry.',
					...metaFields,
				});
			}
			let rep;
			try {
				rep = createRegenProvider({ apiToken: key });
			} catch {
				return unconfigured(res);
			}
			result = await rep.status(upstreamId);
		} else if (provider === 'nvidia') {
			let nv;
			try {
				nv = await loadNvidiaProvider();
			} catch {
				return json(res, 501, {
					error: 'backend_unconfigured',
					message: 'The free NVIDIA NIM 3D lane is not available on this deployment yet.',
				});
			}
			result = await nv.status({ taskId: upstreamId });
		} else if (provider === 'gcp') {
			// Serves every self-host lane (Hunyuan3D, TripoSG sketch) — the job
			// envelope carries the worker URL it was submitted to.
			let gcp;
			try {
				gcp = createGcpProvider();
			} catch {
				return json(res, 501, {
					error: 'backend_unconfigured',
					message: 'Self-hosted generation is not configured on this deployment.',
				});
			}
			result = await gcp.status(upstreamId);
		} else {
			let rep;
			try {
				rep = createRegenProvider();
			} catch {
				return unconfigured(res);
			}
			result = await rep.status(jobId);
		}
	} catch {
		// A transient poll error shouldn't fail the job — report running so the
		// client's loop retries.
		return json(res, 200, { job_id: jobId, status: 'running', ...metaFields });
	}

	if (result.status === 'done' && result.resultGlbUrl) {
		// The compression choice a caller requested at submit time (see
		// _lib/forge-job-options.js) — this poll is a LATER, separate invocation
		// with no access to that original request body, so it was bound to the
		// job handle then and is looked up now. Absent when nothing non-default
		// was requested, or Redis is unavailable — both fail open to uncompressed.
		const boundOpts = await optionsForJob(jobId);
		// Copy the mesh into our own storage so the model is permanent (provider
		// delivery URLs expire) and serve the durable CDN url. Falls back to the
		// provider url where the store is unavailable. Always scored for quality
		// (glb-quality.js) — free, deterministic, and the signal every lane's
		// completion should carry regardless of which provider produced it.
		const durable = await materializeCreation({
			replicateJobId: upstreamId,
			clientKey,
			userId: await sessionUserIdFromReq(req),
			glbUrl: result.resultGlbUrl,
			quality: true,
			compress: boundOpts?.compression || null,
		});
		// Populate the result cache this job was bound to at submit time (text→3D,
		// non-high-tier, platform-keyed lanes only — see forgeResultCacheKey). A
		// job with no binding (image mode, high tier, BYOK, or no options
		// requested) is a no-op here.
		const boundCacheKey = await cacheKeyForJob(jobId);
		if (boundCacheKey && durable?.glbUrl) {
			await putCachedForgeResult(boundCacheKey, {
				glb_url: durable.glbUrl,
				backend: meta?.backend || null,
				tier: meta?.tier || null,
				path: meta?.path || null,
				quality: durable.quality || null,
			});
		}
		return json(res, 200, {
			job_id: jobId,
			creation_id: durable?.id ?? meta?.id ?? null,
			status: 'done',
			glb_url: durable?.glbUrl ?? result.resultGlbUrl,
			durable: Boolean(durable),
			quality: durable?.quality || null,
			compression: durable?.compression || null,
			...metaFields,
		});
	}
	if (result.status === 'failed') {
		// Persist the RAW provider error for operators, but never relay it: the
		// adapter strings can name the vendor ("meshy task not found"), its billing
		// state, a task id, an IP, or a leaked key. Mask to neutral copy on the wire.
		await markFailed({ replicateJobId: upstreamId, clientKey, error: result.error });
		return json(res, 200, {
			job_id: jobId,
			status: 'failed',
			error: sanitizeJobError(result.error) || '3D generation hit a snag — please try again.',
			...metaFields,
		});
	}
	return json(res, 200, { job_id: jobId, status: result.status || 'running', ...metaFields });
}

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,POST,OPTIONS' })) return;
	if (!method(req, res, ['GET', 'POST'])) return;

	const url = new URL(req.url, 'http://localhost');

	if (req.method === 'POST') {
		// ?action=rig auto-rigs an existing GLB; the default POST reconstructs a
		// mesh from a prompt (text→3D) or a reference image (image→3D).
		if ((url.searchParams.get('action') || '').trim() === 'rig') {
			return startRigJob(req, res);
		}
		return startJob(req, res);
	}

	// ?catalog — the tier + backend + cost/time matrix the composer renders.
	// Public, no secrets; lets the UI communicate the time/cost trade-off and
	// which backends are live before the user commits. The payload only changes
	// on a redeploy (tiers/backends are static; `configured` reflects env
	// presence), so it is heavily CDN-cacheable — one of the hottest GETs on the
	// site (every /forge load), now served almost entirely from the edge instead
	// of recomputing per request. stale-while-revalidate keeps it instant even as
	// the cache refreshes in the background.
	if (url.searchParams.has('catalog')) {
		return json(res, 200, buildCatalog(), {
			'cache-control': 'public, max-age=60, s-maxage=600, stale-while-revalidate=86400',
		});
	}

	// ?health — live-probes every platform backend's upstream (auth + quota
	// gates, zero vendor spend) so the UI and uptime checks see what a
	// generation would actually hit, not just which env vars exist. Cached
	// briefly per instance; rate-limited like status polling.
	if (url.searchParams.has('health')) {
		const rl = await limits.mcp3dStatus(clientIp(req));
		if (!rl.success) return rateLimited(res, rl);
		const { probeForgeHealth } = await import('./_lib/forge-health.js');
		// The probe already memoizes per instance (60s TTL); a short edge cache
		// collapses an influx of identical health polls into one shared response
		// every ~30s instead of one origin probe per client. stale-while-revalidate
		// means a client never waits on a refresh — it sees the live status surface
		// update within ~30s while the CDN absorbs the load.
		return json(res, 200, await probeForgeHealth(), {
			'cache-control': 'public, max-age=15, s-maxage=30, stale-while-revalidate=120',
		});
	}

	const jobId = (url.searchParams.get('job') || '').trim();
	if (!jobId) {
		return json(res, 400, { error: 'missing_job', message: 'Pass ?job=<id> to poll a job.' });
	}
	return pollJob(req, res, jobId);
});
