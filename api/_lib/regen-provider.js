// Avatar regeneration provider loader — shared by the regenerate / reconstruct
// endpoints, the reconstruct-finalize stage, and the Replicate webhook.
//
// Dynamically imports a provider module by name so we don't pay the cost of
// loading e.g. the Replicate SDK on every request when regeneration is unused.
// Cached per-process after first load.
//
// Provider name precedence (platform-level, env-configured):
//   1. Explicit env: AVATAR_REGEN_PROVIDER=replicate|huggingface|gcp
//   2. Inferred from credentials: REPLICATE_API_TOKEN → replicate,
//      GCP_RECONSTRUCTION_URL → gcp, HF_TOKEN → huggingface.
//
// BYOK providers (Meshy, Tripo) are NOT in this precedence chain — they are
// request-scoped (the caller supplies the key) and are loaded via
// getRegenProviderByName(). The reconstruct endpoint checks platform first and
// falls back to a user's stored BYOK key when the platform is unconfigured.

// Tier used when adapting BYOK geometry providers for the regen interface.
// Mirrors the forge "standard" tier: solid polycount, PBR textures, no HD
// surcharge so the selfie pipeline isn't pay-gated without warning.
const REGEN_TIER = Object.freeze({ polycount: 30_000, pbr: true, hd: false });

// BYOK provider names that support the reconstruct (image → 3D) mode.
export const BYOK_REGEN_PROVIDERS = Object.freeze(['meshy', 'tripo']);

// Wraps createMeshyProvider to speak the regen submit/status interface.
// ext_job_id is the raw Meshy task id — job.provider === 'meshy' tells the
// status handler which adapter to use, so no kind prefix is needed.
function createMeshyRegenAdapter(key) {
	let _meshy;
	async function meshy() {
		if (!_meshy) {
			const mod = await import('../_providers/meshy.js');
			_meshy = mod.createMeshyProvider(key);
		}
		return _meshy;
	}

	return {
		supportsMode(mode) {
			return mode === 'reconstruct';
		},
		supportsMultiview() {
			return false;
		},

		async submit({ mode, params, sourceUrl }) {
			if (mode !== 'reconstruct') {
				throw Object.assign(
					new Error(`meshy BYOK regen does not support mode "${mode}"`),
					{ code: 'mode_unconfigured', status: 501 },
				);
			}
			const images = Array.isArray(params?.images) ? params.images : [];
			const imageUrl = images[0] || sourceUrl;
			if (!imageUrl) {
				throw Object.assign(new Error('meshy regen: no image URL provided'), {
					code: 'invalid_request',
					status: 400,
				});
			}
			const provider = await meshy();
			const result = await provider.imageTo3d({
				imageUrl,
				prompt: params?.name || '',
				tier: REGEN_TIER,
			});
			// result.taskId is the Meshy task id; stored directly as ext_job_id.
			return {
				extJobId: result.taskId,
				eta: 90,
				backend: 'meshy',
			};
		},

		async status(extJobId) {
			if (!extJobId) return { status: 'failed', error: 'missing ext_job_id' };
			const provider = await meshy();
			// Meshy status always uses kind 'image-to-3d' for selfie submissions.
			return provider.status({ kind: 'image-to-3d', taskId: extJobId });
		},
	};
}

// Wraps createTripoProvider to speak the regen submit/status interface.
function createTripoRegenAdapter(key) {
	let _tripo;
	async function tripo() {
		if (!_tripo) {
			const mod = await import('../_providers/tripo.js');
			_tripo = mod.createTripoProvider(key);
		}
		return _tripo;
	}

	return {
		supportsMode(mode) {
			return mode === 'reconstruct';
		},
		supportsMultiview() {
			return false;
		},

		async submit({ mode, params, sourceUrl }) {
			if (mode !== 'reconstruct') {
				throw Object.assign(
					new Error(`tripo BYOK regen does not support mode "${mode}"`),
					{ code: 'mode_unconfigured', status: 501 },
				);
			}
			const images = Array.isArray(params?.images) ? params.images : [];
			const imageUrl = images[0] || sourceUrl;
			if (!imageUrl) {
				throw Object.assign(new Error('tripo regen: no image URL provided'), {
					code: 'invalid_request',
					status: 400,
				});
			}
			const provider = await tripo();
			const result = await provider.imageTo3d({ imageUrl, tier: REGEN_TIER });
			return {
				extJobId: result.taskId,
				eta: 60,
				backend: 'tripo',
			};
		},

		async status(extJobId) {
			if (!extJobId) return { status: 'failed', error: 'missing ext_job_id' };
			const provider = await tripo();
			return provider.status({ taskId: extJobId });
		},
	};
}

// Instantiate a named BYOK regen adapter with the given API key. Only the
// providers listed in BYOK_REGEN_PROVIDERS are supported here.
export function getRegenProviderByName(name, key) {
	if (!key) {
		throw Object.assign(new Error(`${name} regen: API key is required`), {
			code: 'missing_key',
			status: 400,
		});
	}
	switch (name) {
		case 'meshy':
			return { name, instance: createMeshyRegenAdapter(key) };
		case 'tripo':
			return { name, instance: createTripoRegenAdapter(key) };
		default:
			throw Object.assign(new Error(`unknown BYOK regen provider: ${name}`), {
				code: 'regen_provider_unknown',
				status: 501,
			});
	}
}

// Per-process provider instances, keyed by canonical name. A Map (not a single
// slot) so the failover path can hold several platform providers live at once
// without thrashing the cache between them.
const _platformProviderCache = new Map();

// Canonical platform provider names in paid → free precedence. Used both to
// resolve the single primary and to enumerate failover candidates.
const PLATFORM_PROVIDER_ORDER = Object.freeze(['replicate', 'gcp', 'huggingface']);

function canonicalProviderName(name) {
	const n = (name || '').trim().toLowerCase();
	return n === 'hf' ? 'huggingface' : n;
}

// True when the named platform provider has its required credentials present.
function platformProviderConfigured(name) {
	switch (canonicalProviderName(name)) {
		case 'replicate':
			return Boolean(process.env.REPLICATE_API_TOKEN);
		case 'gcp':
			// The gcp adapter needs both the service URL (endpoint) and the auth
			// key — requiring both here keeps a URL-only deploy out of the failover
			// rotation instead of enumerating a provider whose constructor throws.
			return Boolean(process.env.GCP_RECONSTRUCTION_URL && process.env.GCP_RECONSTRUCTION_KEY);
		case 'huggingface':
			return Boolean(process.env.HF_TOKEN);
		default:
			return false;
	}
}

export function resolveProviderName() {
	const explicit = canonicalProviderName(process.env.AVATAR_REGEN_PROVIDER);
	if (explicit) return explicit;
	// Auto-detect order is paid → free: prefer Replicate's pinned-version
	// reliability, then our own GCP Cloud Run service, then the HF Spaces queue
	// (free GPU but variable wait + cold starts).
	if (process.env.REPLICATE_API_TOKEN) return 'replicate';
	if (process.env.GCP_RECONSTRUCTION_URL) return 'gcp';
	if (process.env.HF_TOKEN) return 'huggingface';
	return 'none';
}

// Load (and cache) a single named platform provider instance. Dynamic-imports
// the adapter so an unused provider's SDK never loads. Throws with a classified
// code for an unknown name; provider constructors themselves throw when their
// credentials are missing.
async function loadPlatformProvider(rawName) {
	const name = canonicalProviderName(rawName);
	if (name === 'none' || !name) return { name: 'none', instance: null };
	if (_platformProviderCache.has(name)) {
		return { name, instance: _platformProviderCache.get(name) };
	}
	let instance;
	if (name === 'replicate') {
		instance = (await import('../_providers/replicate.js')).createRegenProvider();
	} else if (name === 'huggingface') {
		instance = (await import('../_providers/huggingface.js')).createRegenProvider();
	} else if (name === 'gcp') {
		instance = (await import('../_providers/gcp.js')).createRegenProvider();
	} else {
		throw Object.assign(new Error(`unknown AVATAR_REGEN_PROVIDER: ${name}`), {
			code: 'regen_provider_unknown',
			status: 501,
		});
	}
	_platformProviderCache.set(name, instance);
	return { name, instance };
}

export async function getRegenProvider() {
	const name = resolveProviderName();
	if (name === 'none' || !name) return { name, instance: null };
	return loadPlatformProvider(name);
}

// Resolve the first configured provider (in paid → free precedence) that
// actually supports `mode`. The plain getRegenProvider() returns only the single
// highest-precedence provider, which breaks rigging on the common production
// setup where Replicate is primary for `reconstruct` (its built-in TRELLIS
// default) but has no rerig model — meanwhile the self-hosted GCP UniRig pipeline
// CAN rig. Without this failover, every forged avatar comes out un-rigged because
// the rig gate asks Replicate (which can't) and gives up. Mirrors the MCP studio
// path's regenProvider(mode). Returns { name, instance } or { name:'none' }.
export async function getRegenProviderForMode(mode) {
	const candidates = await getRegenProviderCandidates();
	for (const candidate of candidates) {
		try {
			if (candidate.instance && candidate.instance.supportsMode(mode)) return candidate;
		} catch {
			// A provider whose supportsMode throws is treated as not-capable.
		}
	}
	return { name: 'none', instance: null };
}

// Enumerate every configured platform provider in priority order so the submit
// path can fail over from one to the next. The explicit AVATAR_REGEN_PROVIDER
// (if set and credentialed) leads; the credential-inferred order fills in the
// rest, de-duplicated. A provider whose constructor throws (bad config) is
// logged and skipped rather than blocking the others. Returns [] when nothing
// is configured.
export async function getRegenProviderCandidates() {
	const order = [];
	const seen = new Set();
	const push = (rawName) => {
		const name = canonicalProviderName(rawName);
		if (name && name !== 'none' && !seen.has(name) && platformProviderConfigured(name)) {
			seen.add(name);
			order.push(name);
		}
	};

	push(process.env.AVATAR_REGEN_PROVIDER);
	for (const name of PLATFORM_PROVIDER_ORDER) push(name);

	const out = [];
	for (const name of order) {
		try {
			const resolved = await loadPlatformProvider(name);
			if (resolved.instance) out.push(resolved);
		} catch (err) {
			console.warn('[regen] platform provider load failed:', name, '—', err?.message);
		}
	}
	return out;
}

// Resolve the provider for a job that's already in flight, routing by the
// provider name stored on the job row. BYOK providers (meshy, tripo) need the
// user's stored key to poll — fetched from the DB via the request session.
// Platform providers (replicate, gcp, huggingface) use env credentials as usual.
export async function getRegenProviderForJob(jobProvider, req) {
	if (!jobProvider) return { name: 'none', instance: null };

	// Platform providers: load the adapter for the provider THIS job was
	// submitted to, not whichever one currently leads the precedence order.
	// getRegenProvider() returns the primary, so the moment a second platform
	// credential is added (REPLICATE_API_TOKEN sits above gcp in
	// PLATFORM_PROVIDER_ORDER) every in-flight gcp job would be polled with the
	// Replicate adapter, handed a base64 gcp envelope as a prediction id. The
	// poll then reports a failure that has nothing to do with the real job, and
	// the capture the user is waiting on dies on a provider that never ran it.
	// The reconstruct/auto-rig sweeps already refuse to poll across a provider
	// mismatch; this makes the browser poll agree with them.
	if (['replicate', 'gcp', 'huggingface', 'hf'].includes(jobProvider)) {
		const name = canonicalProviderName(jobProvider);
		// Credentials rotated away since submission: report the job's own
		// provider with no instance so the caller leaves the row untouched and
		// the sweep ages it out with an honest reason, rather than polling a
		// different backend for an id it has never seen.
		if (!platformProviderConfigured(name)) return { name, instance: null };
		try {
			return await loadPlatformProvider(name);
		} catch (err) {
			console.warn('[regen] job provider load failed:', name, '-', err?.message);
			return { name, instance: null };
		}
	}

	// BYOK providers: re-resolve the user's stored key at poll time. The key
	// is never stored on the job row itself (it's a secret); the user's session
	// is the authority.
	if (BYOK_REGEN_PROVIDERS.includes(jobProvider)) {
		try {
			const { resolveProviderKey } = await import('./forge-provider-key.js');
			const key = await resolveProviderKey(req, null, jobProvider);
			if (!key) return { name: jobProvider, instance: null };
			return getRegenProviderByName(jobProvider, key);
		} catch {
			return { name: jobProvider, instance: null };
		}
	}

	return { name: 'none', instance: null };
}
