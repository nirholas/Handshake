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

// Map our 5 modes onto the input shape each model expects. The exact shape
// depends on the model; we default to a generic payload and let provider-side
// models pick the fields they care about. Caller-supplied params always win.
//
// For `reconstruct` (image-to-3D, no source GLB) we feed `image` from the
// caller's first photo and pass the full list through as `images` for models
// that accept multi-view. This matches the input contracts of the Hunyuan3D
// family and TripoSR — both ignore unrecognized fields.
function buildInput({ mode, sourceUrl, params }) {
	if (mode === 'reconstruct') {
		const photos = Array.isArray(params?.images) ? params.images : [];
		const primary = photos[0] || params?.image || sourceUrl;
		const base = {
			mode,
			image: primary,
			images: photos.length ? photos : undefined,
			prompt: typeof params?.prompt === 'string' ? params.prompt : undefined,
		};
		return { ...base, ...(params || {}) };
	}
	const base = {
		mode,
		source_url: sourceUrl,
		source_glb: sourceUrl,
		// Pass through every caller param; later spread wins so explicit
		// overrides take precedence over the defaults above.
		prompt: typeof params?.prompt === 'string' ? params.prompt : undefined,
	};
	return { ...base, ...(params || {}) };
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
		for (const key of ['glb', 'mesh', 'mesh_url', 'output_url', 'url', 'model']) {
			if (typeof output[key] === 'string') return output[key];
		}
	}
	return null;
}

export function createRegenProvider() {
	const token = readEnv('REPLICATE_API_TOKEN');
	if (!token) {
		throw new Error('REPLICATE_API_TOKEN env var is required for the replicate provider');
	}

	const authHeaders = {
		authorization: `Bearer ${token}`,
		'content-type': 'application/json',
	};

	return {
		async submit(request) {
			const modelRef = modelForMode(request.mode);
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

			let endpoint;
			let body;
			if (isVersionHash) {
				endpoint = `${REPLICATE_BASE}/predictions`;
				body = JSON.stringify({ version: modelRef, input });
			} else if (slugMatch) {
				const [, owner, name, pinnedVersion] = slugMatch;
				endpoint = `${REPLICATE_BASE}/models/${owner}/${name}/predictions`;
				body = JSON.stringify(pinnedVersion ? { version: pinnedVersion, input } : { input });
			} else {
				throw Object.assign(
					new Error(`replicate model reference "${modelRef}" is neither a version hash nor an owner/name slug`),
					{ code: 'mode_unconfigured', status: 500 },
				);
			}

			let response;
			try {
				response = await fetch(endpoint, {
					method: 'POST',
					headers: authHeaders,
					body,
				});
			} catch (err) {
				throw Object.assign(new Error(`replicate submit failed: ${err?.message}`), {
					code: 'provider_unreachable',
					status: 502,
				});
			}

			const data = await response.json().catch(() => ({}));
			if (!response.ok) {
				throw Object.assign(
					new Error(data?.detail || data?.title || `replicate returned ${response.status}`),
					{ code: 'provider_error', status: 502, providerStatus: response.status },
				);
			}

			return {
				extJobId: data.id,
				eta: typeof data.eta === 'number' ? data.eta : undefined,
				rawStatus: data.status,
			};
		},

		async status(extJobId) {
			if (!extJobId) {
				return { status: 'failed', error: 'missing ext_job_id' };
			}

			let response;
			try {
				response = await fetch(`${REPLICATE_BASE}/predictions/${encodeURIComponent(extJobId)}`, {
					headers: authHeaders,
				});
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
