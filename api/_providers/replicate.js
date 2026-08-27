// Replicate provider for avatar regeneration jobs.
//
// Implements the contract documented in api/avatars/REGENERATE.md:
//   - submit(request)  → { jobId, eta, extJobId }
//   - status(extJobId) → { status, resultGlbUrl?, error? }
//
// Each regen `mode` maps to a Replicate model that takes a GLB or image and
// returns a regenerated GLB asset. The choice of model is configurable via
// env so the provider can be tuned without code changes:
//
//   REPLICATE_API_TOKEN              — required, from replicate.com/account
//   REPLICATE_RECONSTRUCT_MODEL      — version hash for image-to-3D (Phase 1 selfie pipeline)
//   REPLICATE_RESTYLE_MODEL          — version hash for text-to-3D / style transfer
//   REPLICATE_REMESH_MODEL           — version hash for mesh cleanup
//   REPLICATE_RETEX_MODEL            — version hash for re-texturing
//   REPLICATE_RERIG_MODEL            — version hash for rig regeneration (skeleton + skinning)
//
// ── Recommended commercial-OK models (2026-05) ──────────────────────────────
// Set REPLICATE_RECONSTRUCT_MODEL and REPLICATE_RESTYLE_MODEL to the version
// hash of `tencent/hunyuan-3d-3.1` (visit replicate.com/tencent/hunyuan-3d-3.1
// and copy the latest version id). Commercially licensed, image-to-textured-GLB
// in ~30-60s, best quality/price as of writing.
//
// For REPLICATE_RERIG_MODEL, deploy VAST-AI-Research/UniRig (MIT, SIGGRAPH 2025
// SOTA auto-rigging, weights on Hugging Face) via cog when it lands on
// Replicate, or run it on a dedicated GPU and proxy through the same protocol.
//
// Cheaper TripoSR fallback for reconstruct mode: `camenduru/tripo-sr` (~$0.0023
// per run, single-image, faster but no PBR textures).
//
// At submit time the provider POSTs to the Replicate predictions API. The
// returned prediction id is stored as `ext_job_id`. The status endpoint
// polls Replicate to translate the predictions API state into our 4-state
// machine.

import { fetchUpstream } from '../_lib/upstream-fetch.js';

const REPLICATE_BASE = 'https://api.replicate.com/v1';

function readEnv(name) {
	if (typeof process !== 'undefined' && process.env && process.env[name]) return process.env[name];
	return null;
}

const MODE_TO_ENV = Object.freeze({
	reconstruct: 'REPLICATE_RECONSTRUCT_MODEL',
	restyle: 'REPLICATE_RESTYLE_MODEL',
	remesh: 'REPLICATE_REMESH_MODEL',
	retex: 'REPLICATE_RETEX_MODEL',
	retex_region: 'REPLICATE_RETEX_REGION_MODEL',
	rerig: 'REPLICATE_RERIG_MODEL',
});

// Built-in defaults: commercial-OK models that are stable on Replicate so the
// provider works end-to-end as soon as REPLICATE_API_TOKEN is set, without
// the operator having to chase down version hashes. Override per-mode via the
// matching REPLICATE_*_MODEL env var when you want a different model.
//
// `firtoz/trellis` — Microsoft TRELLIS, image-to-textured-GLB, MIT license,
// 1.2B parameters, ~30–90s on Replicate's A100 fleet. Version-pinned to a
// known-good build; bump when Replicate publishes a newer one.
const DEFAULT_MODELS = Object.freeze({
	reconstruct: 'firtoz/trellis',
});

function modelForMode(mode) {
	const envName = MODE_TO_ENV[mode];
	if (!envName) return null;
	return readEnv(envName) || DEFAULT_MODELS[mode] || null;
}

// Models known to fuse more than one conditioning image into a single mesh
// (true multi-view reconstruction). `firtoz/trellis` (Microsoft TRELLIS) takes
// an `images` array and reconstructs from all supplied views; the Tencent
// Hunyuan3D multi-view variants do the same. Slug-matched (the :version suffix
// is ignored) so a pinned build of a known model still counts.
const MULTIVIEW_CAPABLE_SLUGS = Object.freeze([
	'firtoz/trellis',
	'tencent/hunyuan3d-2mv',
	'tencent/hunyuan-3d-2mv',
]);

// A dedicated multi-view model can be configured explicitly; when set it is
// assumed multi-view capable and preferred for >1-view reconstructions.
function multiviewModel() {
	return readEnv('REPLICATE_MULTIVIEW_MODEL') || null;
}

// Replicate serves the unversioned /models/{owner}/{name}/predictions endpoint
// for official models, but community models (firtoz/trellis included) 404 there
// unless a version is pinned. Resolve the model's latest published version once
// per process and retry through the version-pinned /predictions endpoint.
const _latestVersionCache = new Map();

async function resolveLatestVersion(owner, name, authHeaders) {
	const slug = `${owner}/${name}`;
	if (_latestVersionCache.has(slug)) return _latestVersionCache.get(slug);
	const res = await fetchUpstream(`${REPLICATE_BASE}/models/${owner}/${name}`, { headers: authHeaders }, { name: 'replicate', timeoutMs: 10_000, attempts: 2, okWhen: () => true });
	const data = await res.json().catch(() => ({}));
	if (!res.ok || !data?.latest_version?.id) {
		throw Object.assign(
			new Error(
				data?.detail || `replicate model ${slug} not found or has no published version`,
			),
			{ code: 'mode_unconfigured', status: 502, providerStatus: res.status },
		);
	}
	_latestVersionCache.set(slug, data.latest_version.id);
	return data.latest_version.id;
}

function isMultiviewCapable(modelRef) {
	if (!modelRef) return false;
	const slug = String(modelRef).split(':')[0].toLowerCase();
	return MULTIVIEW_CAPABLE_SLUGS.includes(slug);
}

// Pick the reconstruction model + whether it can fuse multiple views, given how
// many views the caller supplied. A dedicated REPLICATE_MULTIVIEW_MODEL wins for
// >1 view; otherwise the standard reconstruct model is used and multi-view is
// claimed only when that model is actually capable of it (so a single-view model
// like TripoSR never silently pretends to fuse views).
function resolveReconstruct(imageCount) {
	const reconstruct = modelForMode('reconstruct');
	if (imageCount > 1) {
		const mv = multiviewModel();
		if (mv) return { modelRef: mv, multiview: true };
		return { modelRef: reconstruct, multiview: isMultiviewCapable(reconstruct) };
	}
	return { modelRef: reconstruct, multiview: false };
}

// Keys that belong to OUR job/contract envelope and must never be forwarded to
// a Replicate model. Replicate validates prediction input against each model's
// OpenAPI schema; leaking these (or the multi-MB base64 image list) risks a 422
// that fails the whole reconstruction. We map the meaningful ones onto the
// model's real input fields (e.g. `images`) and drop the rest.
const INTERNAL_PARAM_KEYS = Object.freeze([
	'mode',
	'name',
	'description',
	'visibility',
	'bodyType',
	'style',
	'image',
	'images',
	'rig', // chain bookkeeping written by the reconstruct-finalize stage
]);

function stripInternal(params) {
	const out = {};
	for (const [key, value] of Object.entries(params || {})) {
		if (INTERNAL_PARAM_KEYS.includes(key)) continue;
		if (value === undefined) continue;
		out[key] = value;
	}
	return out;
}

// TRELLIS-family detection (firtoz/trellis and pinned-version variants). The
// :version suffix is ignored; a bare 64-hex version hash won't match, so an
// operator who pins TRELLIS by raw hash should also pass generate_model via
// params — the slug default below handles every normal case.
function isTrellisModel(modelRef) {
	const slug = String(modelRef || '').split(':')[0].toLowerCase();
	return /(^|\/)trellis$/.test(slug) || slug === 'firtoz/trellis';
}

// TRELLIS gates GLB extraction behind `generate_model`, which DEFAULTS TO FALSE
// — so the model "succeeds" yet returns no mesh unless we ask for one. It also
// renders a color video by default (we never consume it), so we disable the
// video/ply outputs to roughly halve GPU time and cost. These are defaults only:
// any caller-supplied param (texture_size, mesh_simplify, seed, …) overrides.
function trellisReconstructDefaults() {
	return {
		generate_model: true,
		generate_color: false,
		generate_normal: false,
		save_gaussian_ply: false,
	};
}

// Map our modes onto the input shape each model expects. Caller-supplied
// generation params (seed, texture_size, …) survive and win; internal envelope
// keys are stripped so they never reach the model schema.
//
// For `reconstruct` (image-to-3D) the canonical input across the Hunyuan3D
// family, TRELLIS and TripoSR is an `images` array of URIs — we always send
// that and never the singular `image`/`mode` fields the old payload leaked.
function buildInput({ mode, sourceUrl, params, images, modelRef }) {
	const clean = stripInternal(params);
	if (mode === 'reconstruct') {
		// `images` is the already-resolved view list (trimmed to what the chosen
		// model can fuse). Fall back to params.images / the source url so callers
		// that don't pre-resolve still work.
		const photos = Array.isArray(images)
			? images.filter((u) => typeof u === 'string' && u.length > 0)
			: Array.isArray(params?.images)
				? params.images.filter((u) => typeof u === 'string' && u.length > 0)
				: [];
		const primary = photos[0] || (typeof params?.image === 'string' ? params.image : sourceUrl);
		const finalImages = photos.length ? photos : primary ? [primary] : [];
		// Apply TRELLIS-only GLB-extraction flags when the chosen model is TRELLIS.
		// Sending these to a non-TRELLIS model (e.g. Hunyuan3D) would 422 against
		// its OpenAPI schema, so they're gated on the model slug. Caller params win.
		const modelDefaults = isTrellisModel(modelRef) ? trellisReconstructDefaults() : {};
		return { images: finalImages, ...modelDefaults, ...clean };
	}
	// remesh / retex / rerig / restyle operate on an existing GLB. Send the
	// source under the two field names cog GLB-pipelines commonly accept.
	return {
		source_url: sourceUrl,
		source_glb: sourceUrl,
		...clean,
	};
}

function translateStatus(replicateStatus) {
	switch (replicateStatus) {
		case 'starting':
		case 'queued':
			return 'queued';
		case 'processing':
			return 'running';
		case 'succeeded':
			return 'done';
		case 'failed':
		case 'canceled':
			return 'failed';
		default:
			return 'queued';
	}
}

// Extract the first plausible GLB url from a Replicate `output` field. Different
// models emit different shapes — sometimes a string, sometimes an array, sometimes
// a nested object — so we accept a small whitelist of common forms.
function extractGlbUrl(output) {
	if (!output) return null;
	if (typeof output === 'string') return output;
	if (Array.isArray(output)) {
		for (const v of output) {
			if (typeof v === 'string' && /\.glb(\?|$)/i.test(v)) return v;
		}
		// Fall back to the first stringy entry if nothing matched the .glb pattern.
		for (const v of output) {
			if (typeof v === 'string' && /^https?:\/\//.test(v)) return v;
		}
	}
	if (typeof output === 'object') {
		// `model_file` is TRELLIS's GLB key and must come first; the rest cover the
		// Hunyuan3D / TripoSR / generic cog shapes we also target.
		for (const key of ['model_file', 'glb', 'mesh', 'mesh_url', 'output_url', 'url', 'model']) {
			if (typeof output[key] === 'string') return output[key];
		}
	}
	return null;
}

// Replicate throttles prediction CREATION (not polling) with HTTP 429. The cap
// tightens hard when the account balance is under $5: Replicate drops the
// create-prediction limit to ~6/min with a burst of 1, so a single forge (one
// reconstruct create) can be throttled by any other in-flight create on the
// account even though the window resets within seconds. A 429 means the
// prediction was never created, so retrying is safe — no duplicate job, and a
// paid caller has not settled yet (submit runs before settle). We honor
// Retry-After, fall back to the "resets in ~Ns" hint Replicate puts in the body,
// and cap each wait so a paid request still settles inside its authorization
// window (x402 maxTimeoutSeconds: 60).
const THROTTLE_MAX_ATTEMPTS = 3;
const THROTTLE_MAX_WAIT_MS = 12_000;
const THROTTLE_DEFAULT_WAIT_MS = 2_000;

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

// Backoff (ms) before retrying a throttled create. Prefers the standard
// Retry-After header (seconds); falls back to the "resets in ~Ns" phrasing in
// the throttle body; otherwise a short sane default. Capped so one slow reset
// can't blow the settlement window.
function throttleDelayMs(response, data) {
	const header = response?.headers?.get?.('retry-after');
	const fromHeader = header ? Number.parseInt(header, 10) : NaN;
	if (Number.isFinite(fromHeader) && fromHeader >= 0) {
		return Math.min(fromHeader * 1000, THROTTLE_MAX_WAIT_MS);
	}
	const detail = typeof data?.detail === 'string' ? data.detail : '';
	const m = /resets? in ~?(\d+)\s*s/i.exec(detail);
	if (m) return Math.min(Number.parseInt(m[1], 10) * 1000, THROTTLE_MAX_WAIT_MS);
	return THROTTLE_DEFAULT_WAIT_MS;
}

// POST a prediction-create request, transparently retrying a 429 throttle with a
// bounded backoff. A network failure surfaces as `provider_unreachable`; the
// final response (ok, a 404 for the version-resolve fallback, or an exhausted
// 429) is returned for the caller to interpret. Both create sites in submit()
// route through this so the throttle resilience is uniform.
async function createPrediction(endpoint, body, authHeaders) {
	let last = null;
	for (let attempt = 0; attempt < THROTTLE_MAX_ATTEMPTS; attempt++) {
		let response;
		try {
			response = await fetchUpstream(endpoint, { method: 'POST', headers: authHeaders, body }, { name: 'replicate', timeoutMs: 30_000, attempts: 2, okWhen: () => true });
		} catch (err) {
			throw Object.assign(new Error(`replicate submit failed: ${err?.message}`), {
				code: 'provider_unreachable',
				status: 502,
			});
		}
		const data = await response.json().catch(() => ({}));
		if (response.status !== 429) return { response, data };
		last = { response, data };
		if (attempt < THROTTLE_MAX_ATTEMPTS - 1) await sleep(throttleDelayMs(response, data));
	}
	return last;
}

// `apiToken` overrides the platform REPLICATE_API_TOKEN — passed by the forge
// BYOK lane so a user can run the same reconstruction models on their own
// Replicate account. When omitted the provider uses the platform token.
export function createRegenProvider({ apiToken } = {}) {
	const token = apiToken || readEnv('REPLICATE_API_TOKEN');
	if (!token) {
		throw new Error('REPLICATE_API_TOKEN env var is required for the replicate provider');
	}

	const authHeaders = {
		authorization: `Bearer ${token}`,
		'content-type': 'application/json',
	};

	// Webhook target: when set, every submission asks Replicate to POST status
	// updates here instead of forcing the client to poll. The route lives at
	// /api/webhooks/replicate (vercel.json rewrite). Without this URL we fall
	// back to the old poll-on-status flow — both paths converge in the DB.
	const webhookUrl = readEnv('REPLICATE_WEBHOOK_URL')
		|| (readEnv('APP_ORIGIN') ? `${readEnv('APP_ORIGIN').replace(/\/$/, '')}/api/webhooks/replicate` : null);

	return {
		// True when a model is configured for `mode`. The reconstruct-finalize
		// auto-rig stage consults this before chaining a 'rerig' job, so rigging
		// stays dormant (mesh delivered as-is) until REPLICATE_RERIG_MODEL is set.
		supportsMode(mode) {
			return !!modelForMode(mode);
		},

		// True when this provider can fuse >1 reference image into one mesh —
		// either a dedicated REPLICATE_MULTIVIEW_MODEL is set, or the configured
		// reconstruct model is itself multi-view capable (TRELLIS by default).
		supportsMultiview() {
			return Boolean(multiviewModel()) || isMultiviewCapable(modelForMode('reconstruct'));
		},

		async submit(request) {
			// Resolve the model + view handling. For reconstruct, the model and
			// whether multi-view is honored depends on how many views were supplied;
			// other modes map straight to their configured model.
			let modelRef;
			let multiview = false;
			let viewsUsed = 0;
			let images;
			if (request.mode === 'reconstruct') {
				const supplied = Array.isArray(request.params?.images)
					? request.params.images.filter((u) => typeof u === 'string' && u.length > 0)
					: [];
				const requested = supplied.length || (request.sourceUrl ? 1 : 0);
				const resolved = resolveReconstruct(requested);
				modelRef = resolved.modelRef;
				multiview = resolved.multiview;
				// When the chosen model can't fuse views, condition on the primary
				// image only — never feed extra views a single-view model will ignore
				// or reject. This is the graceful downgrade the caller surfaces.
				images = multiview ? supplied : supplied.slice(0, 1);
				viewsUsed = images.length || (request.sourceUrl ? 1 : 0);
			} else {
				modelRef = modelForMode(request.mode);
			}

			if (!modelRef) {
				throw Object.assign(
					new Error(
						`replicate provider has no model configured for mode "${request.mode}" — set ${MODE_TO_ENV[request.mode] || 'the matching REPLICATE_*_MODEL env var'}`,
					),
					{ code: 'mode_unconfigured', status: 501 },
				);
			}

			const input = buildInput({
				mode: request.mode,
				sourceUrl: request.sourceUrl,
				params: request.params,
				images,
				modelRef,
			});

			// Two Replicate API shapes:
			//   • Version hash (64 hex chars): POST /predictions with { version, input }.
			//     Locks behavior to a known commit; required for community models that
			//     don't expose model-level prediction endpoints.
			//   • Model slug (owner/name[:version]): POST /models/{owner}/{name}/predictions
			//     with { input }. Resolves to the latest published version unless a
			//     :version suffix is provided. We use this for the built-in defaults so
			//     they don't go stale every time Replicate republishes.
			const isVersionHash = /^[a-f0-9]{40,64}$/i.test(modelRef);
			const slugMatch = modelRef.match(/^([a-z0-9-]+)\/([a-z0-9._-]+)(?::([a-f0-9]+))?$/i);

			// Webhook payload — Replicate POSTs the full Prediction object to
			// this URL on the configured events. We filter to "completed" only
			// (Replicate's term covers succeeded/failed/canceled) since the
			// client doesn't care about intermediate "processing" events; the
			// status endpoint still falls back to polling if a webhook is lost.
			const requestBody = { input };
			if (webhookUrl) {
				requestBody.webhook = webhookUrl;
				requestBody.webhook_events_filter = ['completed'];
			}

			let endpoint;
			let body;
			if (isVersionHash) {
				endpoint = `${REPLICATE_BASE}/predictions`;
				body = JSON.stringify({ ...requestBody, version: modelRef });
			} else if (slugMatch) {
				const [, owner, name, pinnedVersion] = slugMatch;
				endpoint = `${REPLICATE_BASE}/models/${owner}/${name}/predictions`;
				body = JSON.stringify(pinnedVersion ? { ...requestBody, version: pinnedVersion } : requestBody);
			} else {
				throw Object.assign(
					new Error(`replicate model reference "${modelRef}" is neither a version hash nor an owner/name slug`),
					{ code: 'mode_unconfigured', status: 500 },
				);
			}

			let { response, data } = await createPrediction(endpoint, body, authHeaders);

			// Community models 404 on the unversioned model-level endpoint even
			// though the model exists — resolve the latest published version and
			// retry through the version-pinned predictions endpoint.
			if (response.status === 404 && slugMatch && !isVersionHash) {
				const [, owner, name, pinnedVersion] = slugMatch;
				const version = pinnedVersion || (await resolveLatestVersion(owner, name, authHeaders));
				({ response, data } = await createPrediction(
					`${REPLICATE_BASE}/predictions`,
					JSON.stringify({ ...requestBody, version }),
					authHeaders,
				));
			}

			if (!response.ok) {
				// A 429 that survives the bounded retry is a real throttle the caller
				// can act on — classify it as a retryable rate limit (mirrors
				// text-to-image.js) so the paid forge endpoint returns 429 + a
				// Retry-After hint instead of a blind 502, and never settles a
				// payment it can't fulfill.
				if (response.status === 429) {
					// Replicate's throttle `detail` names the account's credit balance and
					// raw rate-limit numbers ("…less than $5.0 in credit…"). That's internal
					// infra state — never surface it to the buyer. Keep the real detail for
					// server logs (and on the error for callers that want it), hand the
					// caller a clean, retryable message, and still derive the backoff from
					// the raw body via throttleDelayMs.
					const providerDetail = data?.detail || data?.title || '';
					if (providerDetail) console.warn(`[replicate] create-prediction throttled: ${providerDetail}`);
					throw Object.assign(
						new Error('3D generation is briefly busy upstream — please retry in a few seconds.'),
						{
							code: 'rate_limited',
							status: 429,
							providerStatus: 429,
							providerDetail,
							retryAfter: Math.ceil(throttleDelayMs(response, data) / 1000),
						},
					);
				}
				throw Object.assign(
					new Error(data?.detail || data?.title || `replicate returned ${response.status}`),
					{ code: 'provider_error', status: 502, providerStatus: response.status },
				);
			}

			return {
				extJobId: data.id,
				eta: typeof data.eta === 'number' ? data.eta : undefined,
				rawStatus: data.status,
				backend: 'replicate',
				model: modelRef,
				multiview,
				viewsUsed,
			};
		},

		async status(extJobId) {
			if (!extJobId) {
				return { status: 'failed', error: 'missing ext_job_id' };
			}

			let response;
			try {
				response = await fetchUpstream(`${REPLICATE_BASE}/predictions/${encodeURIComponent(extJobId)}`, {
					headers: authHeaders,
				}, { name: 'replicate', timeoutMs: 15_000, attempts: 2, okWhen: () => true });
			} catch (err) {
				return { status: 'running', error: `provider poll failed: ${err?.message}` };
			}

			const data = await response.json().catch(() => ({}));
			if (!response.ok) {
				return {
					status: 'failed',
					error: data?.detail || `replicate returned ${response.status}`,
				};
			}

			const status = translateStatus(data.status);
			const result = {
				status,
				rawStatus: data.status,
			};

			if (status === 'done') {
				const glb = extractGlbUrl(data.output);
				if (glb) result.resultGlbUrl = glb;
				else result.error = 'model finished but no GLB found in output';
			}
			if (status === 'failed' && data.error) result.error = String(data.error);

			return result;
		},
	};
}
