// Forge quality tiers + generation-backend registry — the single source of
// truth shared by the /api/forge endpoint, the public catalog the UI renders,
// and the per-provider param builders.
//
// Two orthogonal axes describe a generation request:
//
//   path  — how geometry is produced:
//             • "image"    → image-intermediate. Text is painted into a
//               reference image (FLUX/Imagen) then reconstructed to a mesh
//               (TRELLIS / Hunyuan3D). This is the existing fast default.
//             • "geometry" → geometry-first. A native 3D model emits mesh
//               geometry directly from the prompt (or a single photo) with no
//               synthesized intermediate view, so detail isn't capped by what
//               one image implies. Meshy / Tripo text-to-3D.
//             • "sketch"   → sketch-conditioned. A drawing + a prompt naming
//               what it depicts drive TripoSG-scribble (self-host) straight to
//               geometry. No photo, no intermediate view, no textures.
//
//   tier  — how much geometric budget to spend: draft / standard / high. Maps
//           to a target polygon count where the backend supports it, plus
//           texture richness. Higher tiers cost more credits and take longer.
//
// A backend declares which paths it serves, whether it needs a user-supplied
// (BYOK) key, and its per-(path,tier) cost/latency estimates so the UI can
// communicate the trade-off before the user commits.

export const PATHS = Object.freeze(['image', 'geometry', 'sketch']);
export const DEFAULT_PATH = 'image';
export const TIER_IDS = Object.freeze(['draft', 'standard', 'high']);
export const DEFAULT_TIER = 'standard';

// Polygon budget + texture richness per tier. `polycount` is the target the
// poly-aware backends (Meshy, Tripo) decimate toward — 100–300k is Meshy's
// accepted range; we stay inside it. `pbr`/`hd` only apply where the backend
// produces textures (the geometry path's optional refine, or image-to-3D).
// `priceUsdcAtomics` is the retail price of one generation at this tier when
// billed directly in USDC (6 decimals) — the single source of truth for the
// x402 paid generation endpoint (api/x402/forge.js) and the public catalog.
// It is a flat per-call price, independent of the BYOK vendor `credits` above
// (which estimate Meshy/Tripo spend on the bring-your-own-key path).
export const TIERS = Object.freeze({
	draft: Object.freeze({
		id: 'draft',
		label: 'Draft',
		blurb: 'Fast, low-poly. Good for blockout and iteration.',
		polycount: 12_000,
		pbr: false,
		hd: false,
		etaMultiplier: 0.6,
		priceUsdcAtomics: 50_000, // $0.05
	}),
	standard: Object.freeze({
		id: 'standard',
		label: 'Standard',
		blurb:
			'Balanced detail, photoreal reference views fused from multiple angles, 2K textures. The default for most assets.',
		polycount: 30_000,
		pbr: false,
		hd: false,
		etaMultiplier: 1,
		priceUsdcAtomics: 150_000, // $0.15
	}),
	high: Object.freeze({
		id: 'high',
		label: 'High',
		blurb:
			'Maximum geometric detail, multi-view fusion at the deepest sampler budget + PBR textures. Slower, pricier.',
		polycount: 200_000,
		pbr: true,
		hd: true,
		etaMultiplier: 2.2,
		priceUsdcAtomics: 500_000, // $0.50
	}),
});

export function resolveTier(id) {
	return TIERS[id] || TIERS[DEFAULT_TIER];
}

// USDC atomic price (6 decimals) for a generation at the given tier — the
// amount the x402 endpoint quotes in its 402 challenge.
export function priceAtomicsForTier(tier) {
	return resolveTier(tier?.id || tier).priceUsdcAtomics;
}

// Human-readable USD price (e.g. "0.15") derived from the atomic price, so the
// catalog and docs never hardcode a second copy of the number.
export function priceUsdcForTier(tier) {
	return (priceAtomicsForTier(tier) / 1_000_000).toFixed(2);
}

// USD price (string, e.g. "0.10") of a post-generation export option (Game-Ready),
// derived from its atomic price in OUTPUTS so the pricing catalog reads it from
// here rather than carrying a second copy. Throws for an unknown output id so a
// typo can never silently price an export at $0.
export function priceUsdcForOutput(outputId) {
	const o = OUTPUTS[outputId];
	if (!o) throw new Error(`unknown forge output: ${outputId}`);
	return (o.priceUsdcAtomics / 1_000_000).toFixed(2);
}

// Generation backends. `provider` selects the api/_providers/* client that
// talks to it. `byok` names the provider-key the caller must supply (false for
// platform-keyed backends). `requiresEnv` lists env vars that must be present
// for a platform backend to be live. `baseEta` is wall-clock seconds at the
// standard tier; the tier's etaMultiplier scales it. `credits` is the estimated
// vendor credit spend per (path → tier) — null when the backend bills by GPU
// time rather than credits (TRELLIS/Hunyuan via our own infra).
export const BACKENDS = Object.freeze({
	nvidia: Object.freeze({
		id: 'nvidia',
		label: 'TRELLIS (free)',
		vendor: 'Microsoft TRELLIS · NVIDIA NIM',
		paths: Object.freeze(['image']),
		byok: false,
		provider: 'nvidia',
		requiresEnv: Object.freeze(['NVIDIA_API_KEY']),
		polyControl: false,
		// NVIDIA's hosted TRELLIS preview only generates from text prompts — it
		// rejects every user-image input form (verified live 2026-06-11; see
		// tasks/nvidia-nim/probes/trellis.md). Photo submissions therefore route to
		// the standing image backend; this flag drives that routing and the catalog.
		userImages: false,
		// Grounded in the live T0.2 probe (tasks/nvidia-nim/probes/trellis.md): draft
		// text→3D returned synchronously in ~13 s end-to-end incl. R2 persist. With the
		// draft tier's 0.6 multiplier, baseEta 22 ≈ that observed wall-clock; NVCF keeps
		// the GPU warm, so there is no Replicate-style ~60 s cold start.
		baseEta: 22,
		credits: null,
		// Free NVIDIA NIM lane — no vendor credit cost. This is what makes it the
		// free-first draft default per platform policy.
		free: true,
		blurb: 'Free TRELLIS generation on NVIDIA NIM — the default lane for text prompts at draft and standard tiers; no vendor cost. Photo input uses the standing engine.',
	}),
	huggingface: Object.freeze({
		id: 'huggingface',
		label: 'Hunyuan3D / TRELLIS (free)',
		vendor: 'Hugging Face Spaces',
		paths: Object.freeze(['image']),
		byok: false,
		provider: 'huggingface',
		requiresEnv: Object.freeze(['HF_TOKEN']),
		polyControl: false,
		// Unlike NVIDIA's text-only hosted preview, this lane DOES take user photos —
		// it is the free option for image→3D, the counterpart to the free text lane.
		userImages: true,
		// Community GPU Spaces reached over Gradio's blocking /call API, with a
		// failover chain (Hunyuan3D 2.1 → Hunyuan3D 2 → TRELLIS → TripoSR). Queue
		// waits + cold starts dominate, so the ETA is generous; it blocks within the
		// 300s reconstruct budget like the Stable Fast 3D synchronous lane.
		baseEta: 90,
		credits: null,
		// Free image→3D — no vendor credit cost (HF Spaces' free GPU). One HF_TOKEN
		// unlocks the whole chain; this is what makes photo→3D free for users.
		free: true,
		blurb: 'Free photo→3D and the High-tier engine on community GPU Spaces — Hunyuan3D / TRELLIS / TripoSR with automatic failover, textured GLB. No vendor cost; queue waits vary.',
	}),
	trellis: Object.freeze({
		id: 'trellis',
		label: 'TRELLIS',
		vendor: 'Microsoft · Replicate',
		paths: Object.freeze(['image']),
		byok: false,
		provider: 'replicate',
		requiresEnv: Object.freeze(['REPLICATE_API_TOKEN']),
		polyControl: false,
		baseEta: 60,
		credits: null,
		blurb: 'Image-intermediate reconstruction on Replicate. A paid platform lane — selectable explicitly, and the last-resort fallback only on deployments with no free engine configured. Free deployments never route here automatically.',
	}),
	meshy: Object.freeze({
		id: 'meshy',
		label: 'Meshy 6',
		vendor: 'Meshy AI',
		paths: Object.freeze(['geometry', 'image']),
		byok: 'meshy',
		provider: 'meshy',
		requiresEnv: Object.freeze([]),
		polyControl: true,
		baseEta: 75,
		// Meshy bills 20 credits for a text-to-3D preview (geometry), 30 for
		// image-to-3D, +10 when PBR/HD texturing is enabled (high tier).
		credits: Object.freeze({
			geometry: Object.freeze({ draft: 20, standard: 20, high: 30 }),
			image: Object.freeze({ draft: 30, standard: 30, high: 40 }),
		}),
		blurb: 'Native text→geometry (preview) + image→3D. Quad topology, t-pose ready.',
	}),
	tripo: Object.freeze({
		id: 'tripo',
		label: 'Tripo v3.1',
		vendor: 'Tripo AI',
		paths: Object.freeze(['geometry', 'image']),
		byok: 'tripo',
		provider: 'tripo',
		requiresEnv: Object.freeze([]),
		polyControl: true,
		baseEta: 70,
		// Tripo bills credits per task type; texture/quad add-ons cost extra.
		credits: Object.freeze({
			geometry: Object.freeze({ draft: 20, standard: 20, high: 30 }),
			image: Object.freeze({ draft: 30, standard: 30, high: 40 }),
		}),
		blurb: 'Cleanest quad topology. Native text→model + image→model.',
	}),
	rodin: Object.freeze({
		id: 'rodin',
		label: 'Rodin (Hyper3D)',
		vendor: 'Deemos · Hyper3D',
		paths: Object.freeze(['geometry', 'image']),
		byok: 'rodin',
		provider: 'rodin',
		requiresEnv: Object.freeze([]),
		polyControl: true,
		baseEta: 80,
		// Rodin bills its own credits per generation; the exact schedule isn't
		// surfaced here, so leave the estimate null rather than show a wrong number.
		credits: null,
		blurb: 'Native text→geometry + image→3D. Quad topology with a real poly target.',
	}),
	hunyuan3d: Object.freeze({
		id: 'hunyuan3d',
		label: 'Hunyuan3D',
		vendor: 'Tencent · self-host',
		paths: Object.freeze(['image']),
		byok: false,
		provider: 'gcp',
		// Dedicated worker URL — NOT the avatar pipeline's GCP_RECONSTRUCTION_URL.
		// That service runs the face pipeline and rejects every non-face image, so
		// advertising this lane off the avatar env var made it look live while it
		// failed 100% of general prompts (verified in prod 2026-06-12).
		requiresEnv: Object.freeze(['GCP_HUNYUAN3D_URL', 'GCP_RECONSTRUCTION_KEY']),
		polyControl: true,
		baseEta: 120,
		// Cold-start budget: this is our own Cloud Run GPU worker scaled-to-zero by
		// default, so a request that lands on a cold container pays a one-time spin-up
		// (model load) on top of baseEta. Surfaced honestly in the ETA when the
		// liveness probe says the worker is not warm — never as a fake progress timer.
		coldStartSeconds: 75,
		credits: null,
		// Our own GPU worker — zero vendor credit cost, so it qualifies as a free lane
		// and participates in free-first routing as the second self-host image engine
		// behind TRELLIS. Image-conditioned, so it accepts user photos and the
		// FLUX-synthesized reference for text prompts.
		free: true,
		blurb: 'Free self-hosted high-poly reconstruction on our own GPU worker — image-conditioned geometry, zero vendor cost.',
	}),
	trellis_selfhost: Object.freeze({
		id: 'trellis_selfhost',
		label: 'TRELLIS (self-host)',
		vendor: 'Microsoft TRELLIS · self-host',
		paths: Object.freeze(['image']),
		byok: false,
		provider: 'gcp',
		// Our own TRELLIS NIM worker (workers/model-trellis on Cloud Run). Unlike
		// NVIDIA's hosted preview (text-only, userImages:false), a self-deployed
		// TRELLIS accepts real user images — so this is a NATIVE single-hop image→3D
		// lane (image → TRELLIS → GLB), no FLUX intermediate. Shares the worker
		// bearer secret with the other GCP workers.
		requiresEnv: Object.freeze(['MODEL_TRELLIS_URL', 'GCP_RECONSTRUCTION_KEY']),
		polyControl: false,
		userImages: true,
		baseEta: 60,
		// Cold-start budget for our own scale-to-zero Cloud Run GPU worker — added to
		// the ETA only when the liveness probe reports the worker cold, so a user
		// waiting on a spin-up sees an honest estimate rather than a stalled bar.
		coldStartSeconds: 60,
		credits: null,
		// Self-hosted on our own GPU — zero vendor credit cost, so it qualifies as a
		// free lane and is the preferred free image→3D engine when configured.
		free: true,
		blurb: 'Free native image→3D on our own TRELLIS worker — single-hop reconstruction (image → TRELLIS → GLB), textured GLB, no vendor cost.',
	}),
	triposg: Object.freeze({
		id: 'triposg',
		label: 'TripoSG',
		vendor: 'VAST AI · self-host',
		// Sketch-only: the scribble pipeline is conditioned on a drawing + prompt.
		// Photo/text submissions route to the standing image/geometry backends.
		paths: Object.freeze(['sketch']),
		byok: false,
		provider: 'gcp',
		requiresEnv: Object.freeze(['GCP_TRIPOSG_URL', 'GCP_RECONSTRUCTION_KEY']),
		// The worker decimates to the tier's poly budget (pymeshlab quadric
		// collapse), so the tier's polycount is a real target here.
		polyControl: true,
		baseEta: 45,
		// Cold-start budget for our own scale-to-zero sketch worker (see TRELLIS).
		coldStartSeconds: 45,
		// Sketch→3D runs only on our own GPU — zero vendor cost. Flagging it free
		// keeps the cost rollups honest (a sketch generation never bills a vendor)
		// even though `sketch` has a single lane with no free/paid alternative.
		free: true,
		credits: null,
		blurb: 'Sketch→3D — draw it, name it, get geometry. Untextured mesh; retexture or stylize after.',
	}),
	stability: Object.freeze({
		id: 'stability',
		label: 'Stable Fast 3D',
		vendor: 'Stability AI',
		paths: Object.freeze(['image']),
		byok: 'stability',
		provider: 'stability',
		requiresEnv: Object.freeze([]),
		polyControl: false,
		// Synchronous: returns the GLB on the submit call (no poll). Seconds, not
		// minutes — the baseEta reflects that.
		baseEta: 15,
		credits: null,
		blurb: 'Fast single-image→3D. Synchronous; textured GLB in seconds.',
	}),
	replicate_byok: Object.freeze({
		id: 'replicate_byok',
		label: 'Replicate (your account)',
		vendor: 'Replicate · BYOK',
		paths: Object.freeze(['image']),
		byok: 'replicate',
		provider: 'replicate',
		requiresEnv: Object.freeze([]),
		polyControl: false,
		baseEta: 60,
		credits: null,
		blurb: 'Run the TRELLIS image→3D reconstruction on your own Replicate account. Multi-view fusion.',
	}),
});

// Post-generation export options layered onto a finished model — surfaced in the
// catalog alongside tiers/backends so the UI can advertise them on the result
// view. Game-Ready drives the workers/remesh service (QuadriFlow quad retopology
// or silhouette-preserving low-poly) to turn any generated or uploaded mesh into
// an engine-ready asset, delivered as GLB + FBX. `baseEta` is wall-clock seconds
// for a single format; `priceUsdcAtomics` is the flat retail price (6 decimals),
// consistent with the tier pricing above.
export const OUTPUTS = Object.freeze({
	gameready: Object.freeze({
		id: 'gameready',
		label: 'Game-Ready',
		blurb: 'Clean retopology to a poly budget with PBR re-bake. Quad (QuadriFlow) or silhouette-preserving low-poly, exported as GLB + FBX for Unity & Unreal (source rig kept on request).',
		topologies: Object.freeze(['quad', 'tri']),
		formats: Object.freeze(['glb', 'fbx']),
		// Poly-budget presets surfaced as slider stops in the UI (target faces).
		polyPresets: Object.freeze([5_000, 15_000, 50_000]),
		textureSizes: Object.freeze([1024, 2048]),
		baseEta: 35,
		priceUsdcAtomics: 100_000, // $0.10
		requiresEnv: Object.freeze(['GCP_REMESH_URL', 'GCP_RECONSTRUCTION_KEY']),
	}),
});

// A platform export is "live" only when its worker env is present — same rule as
// the platform backends above.
export function outputIsConfigured(outputId) {
	const o = OUTPUTS[outputId];
	if (!o) return false;
	return o.requiresEnv.every((name) => Boolean(readEnv(name)));
}

// Standing per-path backend, used ONLY as a last resort when no FREE lane is
// configured for the path (e.g. a deployment with a Replicate key but no
// NVIDIA_API_KEY / HF_TOKEN). On a free-configured deployment the resolver below
// never returns these — every tier routes to a zero-vendor-cost lane first, per
// the platform's free-for-us policy. The image last-resort is the Replicate
// TRELLIS lane (which itself free-firsts to HF when it runs); geometry is Meshy
// (BYOK — the caller's own key, never ours); sketch is the self-host TripoSG worker.
export const DEFAULT_BACKEND_FOR_PATH = Object.freeze({
	image: 'trellis',
	geometry: 'meshy',
	sketch: 'triposg',
});

// Free-for-us routing: every tier defaults to a zero-vendor-cost engine. The
// tier picks WHICH free engine, so quality (and the price we charge the user)
// scales without us ever spending on a paid API:
//   • draft / standard → NVIDIA NIM TRELLIS — fast, free, native text→mesh.
//   • high             → HuggingFace Hunyuan3D — textured, higher-fidelity, free.
// These apply to text prompts and to the FLUX-synthesized reference the free
// lanes reconstruct from. Photo submissions can't use the text-only NVIDIA lane,
// so they fall to the free HuggingFace lane via FREE_FALLBACK_FOR_PATH below.
// Charging is orthogonal: the High tier stays $THREE hold-or-pay gated in the
// handler regardless of which free engine serves it — we charge for quality, not
// to recover vendor cost. Paid backends (Replicate/Meshy/Tripo) stay explicitly
// selectable at every tier.
export const FREE_DEFAULT_FOR_TIERS = Object.freeze({
	draft: Object.freeze({ image: 'nvidia' }),
	standard: Object.freeze({ image: 'nvidia' }),
	// High names our self-host Hunyuan3D worker — the highest-fidelity engine we
	// can run on our own GPUs. Until GCP_HUNYUAN3D_URL is configured the candidate
	// walk falls to the per-path chain (self-host TRELLIS first). The external
	// HuggingFace Spaces lane (the previous name here) stays in the fallback chain
	// but no longer leads: its Hunyuan Spaces sit GPU-quota-dead for most of the
	// day, so naming it made the tier a coin-flip.
	high: Object.freeze({ image: 'hunyuan3d' }),
});

// Free lanes to fall back to per path when the tier's named free engine can't
// serve this request — chiefly a photo submission at draft/standard (NVIDIA's
// hosted preview is text-only), which routes to a free reconstruct lane instead
// of a paid engine. First configured + capable lane wins, and our OWN GPU workers
// come first so the platform leans on the credits we control before any external
// free lane: self-hosted TRELLIS (native single-hop image→3D), then self-hosted
// Hunyuan3D, then the free HuggingFace Spaces lane. Every entry is env-gated, so
// the list degrades cleanly on deployments that configure only some of them.
export const FREE_FALLBACK_FOR_PATH = Object.freeze({
	image: Object.freeze(['trellis_selfhost', 'hunyuan3d', 'huggingface']),
});

// Our own GPU workers, by provider. A "self-host" lane runs on infrastructure we
// operate (Cloud Run + GPU) against substantial GCP credits, so it is the lane we
// most want to serve every request: zero per-call vendor cost and no BYOK
// dependency. Health-aware routing prefers a healthy self-host lane over any other
// free lane, which over any paid vendor.
export const SELF_HOST_PROVIDERS = Object.freeze(['gcp']);

export function isSelfHostBackend(backendId) {
	const b = BACKENDS[backendId];
	return Boolean(b && SELF_HOST_PROVIDERS.includes(b.provider));
}

export function isFreeBackend(backendId) {
	return BACKENDS[backendId]?.free === true;
}

// Cost class of a finished generation for the free-vs-paid serve rollups: a
// `free` lane (self-host or a free external preview) bills no vendor; anything
// else is `paid` (Replicate platform credits or a BYOK vendor key).
export function backendCostClass(backendId) {
	return isFreeBackend(backendId) ? 'free' : 'paid';
}

// Whether a free lane can serve this (path, userImages) request right now: it
// exists, is marked free (zero vendor cost), serves the path, is configured on
// this deployment, and — for photo submissions — accepts user images.
function freeLaneUsable(id, p, userImages) {
	const b = id && BACKENDS[id];
	return Boolean(
		b &&
		b.free === true &&
		b.paths.includes(p) &&
		backendIsConfigured(id) &&
		(!userImages || b.userImages !== false),
	);
}

// Ordered list of every free lane that could serve this (path, tier, userImages)
// request on this deployment, most-preferred first — the tier's named free engine
// (NVIDIA's native text→3D at draft/standard, HuggingFace's textured engine at
// high), then the per-path fallback chain (our self-host GPU workers, then the
// free external Spaces). De-duplicated; only configured + capable lanes survive.
// This is the single ordering both the env-only default and the health-aware
// resolver walk, so they can never drift apart.
export function freeLaneCandidates(p, tierId, userImages) {
	const ordered = [];
	const named = FREE_DEFAULT_FOR_TIERS[tierId]?.[p];
	if (named) ordered.push(named);
	for (const id of FREE_FALLBACK_FOR_PATH[p] || []) ordered.push(id);
	// FORGE_SELFHOST_PRIMARY: when our own Cloud Run GPU fleet is live, hoist the
	// self-host lanes ahead of every hosted free lane (NVIDIA NIM / HuggingFace) so
	// the platform spends the GCP credits it controls before any external free
	// allocation — and so image→3D, which the hosted NIM preview rejects, serves off
	// our own TRELLIS. Stable partition: it only reorders self-host ↑ / hosted ↓ and
	// preserves each group's internal order, leaving the hosted lanes intact as
	// fallthrough. A no-op on deployments without the worker URLs (those lanes are
	// filtered by freeLaneUsable anyway) and off by default — unset the flag to
	// restore today's tier-named ordering instantly.
	const prioritized = selfHostPrimary()
		? [...ordered.filter(isSelfHostBackend), ...ordered.filter((id) => !isSelfHostBackend(id))]
		: ordered;
	const seen = new Set();
	const out = [];
	for (const id of prioritized) {
		if (seen.has(id)) continue;
		seen.add(id);
		if (freeLaneUsable(id, p, userImages)) out.push(id);
	}
	return out;
}

// Resolve the default backend for a (path, tier) when the caller didn't name one.
// Free-for-us policy: the first configured free lane in the candidate ordering,
// and only the paid standing default when NO free lane is live on this deployment.
function defaultBackendFor(p, tierId, userImages) {
	const candidates = freeLaneCandidates(p, tierId, userImages);
	return candidates[0] || DEFAULT_BACKEND_FOR_PATH[p];
}

// Health-aware default resolver. Given a `health` map of laneId → 'ok' | 'down' |
// 'degraded' | undefined, walk the same candidate ordering as the env-only default
// and pick by preference order tempered by health, never the reverse — so our
// self-host GPU workers (which lead the ordering) keep precedence unless they are
// actually unhealthy:
//   1. The first lane that is healthy OR simply unknown. Missing telemetry never
//      demotes a preferred lane (the liveness layer reports external lanes as
//      'unknown' by design), but a probe-confirmed 'degraded' lane is skipped if a
//      later candidate is clean.
//   2. Otherwise the first lane not confirmed 'down' — accept a degraded lane,
//      still better than paying a vendor.
//   3. Only when every free lane is confirmed down, the paid standing default.
// With an empty/undefined health map this returns exactly what defaultBackendFor
// would, so callers with no telemetry are unaffected.
export function defaultBackendForHealthAware(p, tierId, userImages, health) {
	const candidates = freeLaneCandidates(p, tierId, userImages);
	if (!candidates.length) return DEFAULT_BACKEND_FOR_PATH[p];
	const statusOf = (id) => health?.[id];
	const preferred = candidates.find((id) => {
		const s = statusOf(id);
		return s === 'ok' || s == null || s === 'unknown';
	});
	if (preferred) return preferred;
	const usable = candidates.find((id) => statusOf(id) !== 'down');
	if (usable) return usable;
	// Every free lane is confirmed down — fall to the paid default rather than
	// dead-ending on a lane we know will fail.
	return DEFAULT_BACKEND_FOR_PATH[p];
}

// `userImages: true` = the request carries caller-supplied reference images, so
// the resolved default must be a backend that accepts them. An explicitly named
// backend is always honored here — the forge handler rejects an unsupported
// (backend, input) combination with a designed error at the boundary instead.
export function resolveBackendId({ path, tier, backend, userImages = false }) {
	const p = PATHS.includes(path) ? path : DEFAULT_PATH;
	if (backend && BACKENDS[backend] && BACKENDS[backend].paths.includes(p)) {
		return backend;
	}
	const tierId = tier?.id || tier || DEFAULT_TIER;
	return defaultBackendFor(p, tierId, userImages);
}

// Health-aware twin of resolveBackendId: an explicitly named backend is always
// honored (the handler owns rejecting an unsupported input combination), but an
// unnamed request consults the `health` map so a cold/down free lane is skipped
// in favour of the next healthy one before it ever reaches submit. `health` is a
// laneId → status map (see defaultBackendForHealthAware). Pure — the caller
// gathers the (cached) snapshot and passes it in, so this stays trivially
// testable and adds no I/O of its own.
export function resolveBackendIdWithHealth({ path, tier, backend, userImages = false, health }) {
	const p = PATHS.includes(path) ? path : DEFAULT_PATH;
	if (backend && BACKENDS[backend] && BACKENDS[backend].paths.includes(p)) {
		return backend;
	}
	const tierId = tier?.id || tier || DEFAULT_TIER;
	return defaultBackendForHealthAware(p, tierId, userImages, health);
}

function readEnv(name) {
	if (typeof process !== 'undefined' && process.env && process.env[name]) return process.env[name];
	return null;
}

// Free-first reconstruct ordering. When ON (the default), the forge prefers the
// free reconstruct lane (HuggingFace Spaces) over the paid Replicate default
// BEFORE it ever submits to the paid account — so a generation never spends on,
// nor dead-ends against, the paid lane while a free lane can serve it. The native
// free NVIDIA NIM text→3D lane is always tried first regardless; this governs the
// reconstruct step (image→3D, and the text→3D fallback after NIM). Reversible:
// set FORGE_PREFER_FREE=false to restore the fast paid-default ordering once the
// paid account is funded. Defaults ON because the platform's stance is free-first.
export function preferFreeReconstruct() {
	const v = readEnv('FORGE_PREFER_FREE');
	if (v == null || v === '') return true;
	return !/^(0|false|off|no)$/i.test(String(v).trim());
}

// Self-host-primary routing. When ON, freeLaneCandidates hoists our own Cloud Run
// GPU workers (SELF_HOST_PROVIDERS) ahead of the hosted free lanes for every path
// and tier, so once the fleet is deployed the platform serves generations off the
// GCP credits it controls instead of the rate-limited hosted NVIDIA NIM allocation.
// OFF by default (opt-in per the credit-window rollout) and reversible — unset
// FORGE_SELFHOST_PRIMARY to fall straight back to today's ordering with no redeploy.
export function selfHostPrimary() {
	const v = readEnv('FORGE_SELFHOST_PRIMARY');
	if (v == null || v === '') return false;
	return /^(1|true|on|yes)$/i.test(String(v).trim());
}

// Per-tier sampling/export budgets for the self-host TRELLIS worker
// (workers/model-trellis /infer `quality` field). One shared map so the submit
// site, the catalog, and tests can never disagree about what a tier buys:
//   • ss/slat steps — diffusion sampler budget for structure and appearance.
//     TRELLIS defaults to 12; quality keeps improving to ~50 at linear GPU cost.
//   • simplify — fraction of triangles REMOVED by GLB export decimation
//     (lower keeps more geometry).
//   • texture_size — baked texture resolution.
// GPU time runs against platform GCP credits (the L4 is already reserved at
// minScale 1), so tiers price the USER for quality, not us for compute.
// Draft stays at the worker's fast defaults for iteration speed.
export const SELFHOST_TRELLIS_QUALITY = Object.freeze({
	draft: Object.freeze({ ss_steps: 12, slat_steps: 12, simplify: 0.95, texture_size: 1024 }),
	standard: Object.freeze({ ss_steps: 25, slat_steps: 25, simplify: 0.9, texture_size: 2048 }),
	high: Object.freeze({ ss_steps: 45, slat_steps: 45, simplify: 0.85, texture_size: 2048 }),
});

export function selfhostQualityForTier(tierId) {
	return SELFHOST_TRELLIS_QUALITY[tierId] || SELFHOST_TRELLIS_QUALITY[DEFAULT_TIER];
}

// A platform backend is "live" only when its required env is present. BYOK
// backends are always selectable — liveness depends on the caller's key, which
// is resolved per-request, not here.
export function backendIsConfigured(backendId) {
	const b = BACKENDS[backendId];
	if (!b) return false;
	if (b.byok) return true;
	return b.requiresEnv.every((name) => Boolean(readEnv(name)));
}

// Estimated wall-clock seconds for a (backend, path, tier) combination —
// used to populate the client progress estimate and the catalog. When `cold` is
// true (the liveness probe reports a scale-to-zero self-host worker not warm), the
// lane's one-time spin-up budget is added so the ETA stays honest about a cold
// start instead of understating it; the client's real polling still drives actual
// progress, so this only widens the estimate — it never fabricates progress.
export function estimateEtaSeconds({ backendId, tier, cold = false }) {
	const b = BACKENDS[backendId];
	if (!b) return 90;
	const t = resolveTier(tier?.id || tier);
	const base = Math.round(b.baseEta * t.etaMultiplier);
	if (cold && b.coldStartSeconds > 0) return base + Math.round(b.coldStartSeconds);
	return base;
}

// The one-time cold-start budget (seconds) for a scale-to-zero self-host worker,
// or 0 for an always-warm / external lane. Lets a caller report `cold_start` and
// the widened ETA without re-deriving the number.
export function coldStartSecondsFor(backendId) {
	return BACKENDS[backendId]?.coldStartSeconds || 0;
}

// Estimated vendor credits for a (backend, path, tier) — null when the backend
// doesn't bill in credits.
export function estimateCredits({ backendId, path, tier }) {
	const b = BACKENDS[backendId];
	if (!b || !b.credits) return null;
	const p = PATHS.includes(path) ? path : DEFAULT_PATH;
	const byPath = b.credits[p];
	if (!byPath) return null;
	const tierId = (tier?.id || tier || DEFAULT_TIER);
	return byPath[tierId] ?? byPath[DEFAULT_TIER] ?? null;
}

// Build the public catalog the /forge UI renders: every tier, and every backend
// with its supported paths, BYOK requirement, live/configured flag, and the
// time+cost estimate matrix. No secrets — safe to serve unauthenticated.
export function buildCatalog() {
	return {
		paths: PATHS,
		default_path: DEFAULT_PATH,
		default_tier: DEFAULT_TIER,
		default_backend: DEFAULT_BACKEND_FOR_PATH,
		// Tier-aware defaults so the UI can show which engine a tier picks when the
		// user doesn't override it. Draft prefers the free lane where it's live.
		default_backend_for_tier: TIER_IDS.reduce((acc, tierId) => {
			acc[tierId] = PATHS.reduce((byPath, p) => {
				byPath[p] = resolveBackendId({ path: p, tier: tierId });
				return byPath;
			}, {});
			return acc;
		}, {}),
		tiers: TIER_IDS.map((id) => {
			const t = TIERS[id];
			return {
				id: t.id,
				label: t.label,
				blurb: t.blurb,
				polycount: t.polycount,
				pbr: t.pbr,
				hd: t.hd,
				price_usdc_atomics: t.priceUsdcAtomics,
				price_usdc: (t.priceUsdcAtomics / 1_000_000).toFixed(2),
			};
		}),
		backends: Object.values(BACKENDS).map((b) => ({
			id: b.id,
			label: b.label,
			vendor: b.vendor,
			paths: b.paths,
			byok: b.byok || null,
			poly_control: b.polyControl,
			free: Boolean(b.free),
			// False when the backend generates from text prompts only (NVIDIA's
			// hosted TRELLIS preview) — the UI must not offer it for photo input.
			user_images: b.userImages !== false,
			configured: backendIsConfigured(b.id),
			blurb: b.blurb,
			estimates: b.paths.reduce((acc, p) => {
				acc[p] = TIER_IDS.map((tierId) => ({
					tier: tierId,
					eta_seconds: estimateEtaSeconds({ backendId: b.id, tier: tierId }),
					credits: estimateCredits({ backendId: b.id, path: p, tier: tierId }),
				}));
				return acc;
			}, {}),
		})),
		// Post-generation export options (Game-Ready, …) the result view can offer.
		outputs: Object.values(OUTPUTS).map((o) => ({
			id: o.id,
			label: o.label,
			blurb: o.blurb,
			topologies: o.topologies,
			formats: o.formats,
			poly_presets: o.polyPresets,
			texture_sizes: o.textureSizes,
			eta_seconds: o.baseEta,
			price_usdc_atomics: o.priceUsdcAtomics,
			price_usdc: (o.priceUsdcAtomics / 1_000_000).toFixed(2),
			configured: outputIsConfigured(o.id),
		})),
	};
}

// Translate a resolved (path, tier) into the mesh-budget params the poly-aware
// providers (Meshy/Tripo) accept. Backends without poly control ignore these.
export function meshBudgetFor({ tier }) {
	const t = resolveTier(tier?.id || tier);
	return {
		targetPolycount: t.polycount,
		pbr: t.pbr,
		hd: t.hd,
	};
}
