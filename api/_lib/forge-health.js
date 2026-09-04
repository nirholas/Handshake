// Live forge backend health — the truth behind the catalog's `configured` flag.
//
// `configured: true` only means "the env var exists". Two production outages
// hid behind it (a Replicate account throttle and a misrouted Hunyuan3D
// worker), so this module probes each platform backend's upstream with a
// cheap, zero-cost request and reports what a generation would actually hit.
//
// Statuses:
//   ok           — auth + quota gates passed; a generation should start.
//   degraded     — upstream is throttling (transient 429); retries may work.
//   down         — auth/billing failure or worker unreachable; will not work.
//   byok         — needs the caller's own key; probed at request time, not here.
//   unconfigured — required env absent on this deployment.
//
// Probes never spend vendor money: Replicate is probed with an invalid
// version (the 4xx arrives after the auth/quota gates), NVIDIA with a status
// lookup of a synthetic request id, GCP workers with a bare authenticated GET.
//
// Results are cached briefly per lambda instance so the UI and uptime checks
// can poll without hammering vendors.

import { BACKENDS, backendIsConfigured } from './forge-tiers.js';
import { env } from './env.js';
import { getRedisBurn } from './redis-usage.js';
import { probeLlmHealth } from './llm-health.js';
import { readGenerationMetrics } from './forge-events.js';
import { providersInCooldown } from './provider-health.js';

const PROBE_TIMEOUT_MS = 4_000;
const CACHE_TTL_MS = 60_000;

// A real, stable, cheap model — this pipeline's own default text→image model
// (see text-to-image.js DEFAULT_TXT2IMG_MODEL) — used to probe Replicate's
// actual billing/quota gate. See the long comment on probeReplicate() below
// for why a real model is required here (a fake version/model short-circuits
// on request-shape or version-lookup validation before billing is ever
// checked, hiding a real out-of-credit account behind a false "ok").
const REPLICATE_PROBE_MODEL_URL = 'https://api.replicate.com/v1/models/black-forest-labs/flux-schnell/predictions';
const NVCF_STATUS_URL = 'https://api.nvcf.nvidia.com/v2/nvcf/pexec/status';
// Valid UUID shape that no real NVCF request will ever have — auth is checked
// before the id is resolved, so 404 proves the key works.
const NVCF_PROBE_ID = '00000000-0000-4000-8000-000000000000';
// Must match NIM_TRELLIS_COOLDOWN_KEY in api/forge.js — the flag its real
// generation path sets (markProviderCooldown) when an actual text→3D submit to
// the NVIDIA invoke endpoint fails. See probeNvidia() below for why this probe
// cross-checks it.
const NVIDIA_LANE_COOLDOWN_KEY = 'forge-nim-trellis';

function readEnv(name) {
	if (typeof process !== 'undefined' && process.env?.[name]) return process.env[name];
	return null;
}

function result(id, status, message, extra = {}) {
	return { id, status, message, ...extra };
}

// fetch with a hard timeout; resolves to the Response or null on network error.
async function probeFetch(url, options = {}) {
	try {
		return await fetch(url, { ...options, signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
	} catch {
		return null;
	}
}

// Replicate (the `trellis` lane): an invalid-version prediction submit clears
// the auth and account-quota gates without creating billable work — a REAL
// model reference rejected on its input schema (422) means a real submit
// would have been accepted; that same rejection arrives instead as 402 when
// the account is out of credit, which is the signal this probe is for.
//
// Bug fixed 2026-07-08 (found live during a forge_free outage investigation):
// the previous probe posted `{ version: 'forge-health-probe-invalid-version' }`
// with NO `model`/`input` — Replicate's own request-shape validation ("input is
// required") rejects that with 422 BEFORE the billing/quota gate is ever
// reached, so a genuinely out-of-credit account still probed `ok`. Verified
// live against the real (currently out-of-credit) production token: the old
// probe body returned 422 "input is required"; the SAME token against a real
// model (`black-forest-labs/flux-schnell`, this pipeline's own default
// text→image model — see text-to-image.js DEFAULT_TXT2IMG_MODEL) with a
// deliberately-empty `input: {}` returned 402 "Insufficient credit" instantly,
// with no prediction id in the body — i.e. billing IS checked before input
// validation for a real model, and rejection there creates no billable work
// (confirmed: neither response contains a prediction id). So probing a real
// model with empty input reaches the actual gate this health check exists to
// verify, at zero cost either way.
async function probeReplicate() {
	const id = 'trellis';
	const token = readEnv('REPLICATE_API_TOKEN');
	if (!token) return result(id, 'unconfigured', 'REPLICATE_API_TOKEN is not set on this deployment.');
	const started = Date.now();
	const res = await probeFetch(REPLICATE_PROBE_MODEL_URL, {
		method: 'POST',
		headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
		body: JSON.stringify({ input: {} }),
	});
	const latency = Date.now() - started;
	if (!res) return result(id, 'down', 'Replicate is unreachable.', { latency_ms: latency });
	if (res.status === 401 || res.status === 403) {
		return result(id, 'down', 'Replicate rejected the platform API token.', { http_status: res.status, latency_ms: latency });
	}
	if (res.status === 402) {
		return result(id, 'down', 'The Replicate account is out of credit.', { http_status: res.status, latency_ms: latency });
	}
	if (res.status === 429) {
		return result(id, 'degraded', 'Replicate is throttling this account — generations will be rejected until the quota clears (check billing).', { http_status: res.status, latency_ms: latency });
	}
	// 400/404/422 — the empty input was rejected on schema AFTER auth and
	// billing/quota, which is exactly what the probe wants to see.
	if (res.status >= 400 && res.status < 500) {
		return result(id, 'ok', 'Replicate accepted authentication; generations should start.', { latency_ms: latency });
	}
	return result(id, 'down', `Replicate returned an unexpected HTTP ${res.status}.`, { http_status: res.status, latency_ms: latency });
}

// NVIDIA NIM (the free `nvidia` lane): a status lookup of a synthetic request
// id authenticates without invoking the model — 404 proves the key is live.
async function probeNvidia() {
	const id = 'nvidia';
	const key = readEnv('NVIDIA_API_KEY');
	if (!key) return result(id, 'unconfigured', 'NVIDIA_API_KEY is not set on this deployment.');
	const started = Date.now();
	const res = await probeFetch(`${NVCF_STATUS_URL}/${NVCF_PROBE_ID}`, {
		headers: { authorization: `Bearer ${key}`, accept: 'application/json' },
	});
	const latency = Date.now() - started;
	if (!res) return result(id, 'down', 'NVIDIA NIM is unreachable.', { latency_ms: latency });
	if (res.status === 401 || res.status === 403) {
		return result(id, 'down', 'NVIDIA rejected the platform API key.', { http_status: res.status, latency_ms: latency });
	}
	if (res.status === 429) {
		return result(id, 'degraded', 'NVIDIA NIM is throttling — the free lane may queue.', { http_status: res.status, latency_ms: latency });
	}
	// Auth passing only proves the key works — it says nothing about the actual
	// generate (invoke) endpoint, which is a separate NVCF route this cheap probe
	// deliberately never calls (probes here must never spend vendor money). Root
	// cause of a real incident (live 2026-07-08): the invoke endpoint was
	// returning 504 "errored" on every real submit while this status-lookup probe
	// stayed green the whole time, so `?health=1` reported the lane `ok` during a
	// full outage. Cross-check the SAME cooldown flag the real generation path
	// (api/forge.js runNvidiaTextLane) sets on a failed submit, so a currently
	// degraded invoke path shows up here too instead of only surfacing once a
	// caller's own request has already timed out.
	const cooling = await providersInCooldown([NVIDIA_LANE_COOLDOWN_KEY]).catch(() => new Map());
	if (cooling.has(NVIDIA_LANE_COOLDOWN_KEY)) {
		return result(
			id,
			'degraded',
			'NVIDIA NIM authenticated, but a recent real generation failed and the free lane is cooling down — requests may fail over to a paid lane.',
			{ latency_ms: latency },
		);
	}
	// 404 (synthetic id not found) or any 2xx means the key authenticated.
	return result(id, 'ok', 'NVIDIA NIM accepted authentication; the free lane is live.', { latency_ms: latency });
}

// Hugging Face Spaces (the free `huggingface` image→3D lane): a whoami-v2
// lookup authenticates the token without touching a Space — no GPU, no queue,
// no billable work. 200 proves the token is live; 401/403 means a submit would
// be rejected. We can't cheaply probe Space queue depth, so an authenticated
// token reports ok with the honest caveat that queue waits vary.
const HF_WHOAMI_URL = 'https://huggingface.co/api/whoami-v2';

async function probeHuggingFace() {
	const id = 'huggingface';
	const token = readEnv('HF_TOKEN');
	if (!token) return result(id, 'unconfigured', 'HF_TOKEN is not set on this deployment.');
	const started = Date.now();
	const res = await probeFetch(HF_WHOAMI_URL, {
		headers: { authorization: `Bearer ${token}` },
	});
	const latency = Date.now() - started;
	if (!res) return result(id, 'down', 'Hugging Face is unreachable.', { latency_ms: latency });
	if (res.status === 401 || res.status === 403) {
		return result(id, 'down', 'Hugging Face rejected the platform token.', { http_status: res.status, latency_ms: latency });
	}
	if (res.status === 429) {
		return result(id, 'degraded', 'Hugging Face is rate-limiting — the free Spaces may queue.', { http_status: res.status, latency_ms: latency });
	}
	if (res.ok) {
		return result(id, 'ok', 'Hugging Face accepted the token; the free Spaces lane is reachable (queue waits vary).', { latency_ms: latency });
	}
	return result(id, 'down', `Hugging Face returned an unexpected HTTP ${res.status}.`, { http_status: res.status, latency_ms: latency });
}

// Self-hosted Cloud Run workers (Hunyuan3D, TripoSG): an authenticated GET
// against the worker's own /health route.
//
// This probe used to GET the service ROOT and call anything under 500 "ok".
// That was wrong twice over. Routability is not readiness: every one of these
// workers binds its port and answers immediately, then loads multi-GiB weights
// in a background thread, so a worker whose model load has already FAILED
// (/health carries a populated load_error) still answered a root GET and still
// read green here: exactly the "misrouted Hunyuan3D worker" class of outage
// this module exists to catch. It was also pure noise: no worker serves the
// root, so each probe logged a 404 in the worker's own logs, once a minute,
// forever.
//
// /health is unauthenticated on these workers and reports the real state
// (ready / pipeline_loaded / model_loaded / load_error). The bearer header is
// still sent so the probe keeps working if a worker ever gates the route.
//
// Verdicts:
//   load_error populated        → down     (a generation cannot succeed)
//   ready/loaded flag is false  → degraded (up, weights still streaming in;
//                                           a submit queues until ready)
//   otherwise 2xx/3xx           → ok
// A 4xx means the worker is routable but exposes no health contract; that is
// still reachable, so it stays ok with the readiness caveat in the message.
function gcpWorkerProbe(id, urlEnv, labelOverride = null) {
	return async function probeGcpWorker() {
		const label = labelOverride || BACKENDS[id]?.label || id;
		const url = readEnv(urlEnv);
		const key = readEnv('GCP_RECONSTRUCTION_KEY');
		if (!url || !key) {
			return result(id, 'unconfigured', `The ${label} worker is not configured on this deployment.`);
		}
		const started = Date.now();
		const res = await probeFetch(`${url.replace(/\/+$/, '')}/health`, {
			headers: { authorization: `Bearer ${key}` },
		});
		const latency = Date.now() - started;
		if (!res) return result(id, 'down', `The ${label} worker is unreachable.`, { latency_ms: latency });
		if (res.status >= 500) {
			return result(id, 'down', `The ${label} worker returned HTTP ${res.status}.`, { http_status: res.status, latency_ms: latency });
		}
		if (res.status >= 400) {
			return result(id, 'ok', `The ${label} worker is reachable, but exposes no health contract.`, { http_status: res.status, latency_ms: latency });
		}
		const body = await res.json().catch(() => null);
		if (!body || typeof body !== 'object') {
			return result(id, 'ok', `The ${label} worker is reachable.`, { latency_ms: latency });
		}
		if (body.load_error) {
			return result(id, 'down', `The ${label} worker failed to load its model: ${body.load_error}`, { latency_ms: latency });
		}
		// Field name varies by worker generation: Hunyuan3D reports `ready` +
		// `pipeline_loaded`, TripoSG reports `model_loaded`. Read whichever the
		// worker actually publishes; a worker that publishes none is not held to
		// a readiness bar it never claimed.
		const readiness = [body.ready, body.pipeline_loaded, body.model_loaded].find((v) => typeof v === 'boolean');
		if (readiness === false) {
			return result(id, 'degraded', `The ${label} worker is up but still loading its model; a generation will queue until it is ready.`, { latency_ms: latency });
		}
		return result(id, 'ok', `The ${label} worker is reachable.`, { latency_ms: latency });
	};
}

function byokResult(id) {
	const label = BACKENDS[id]?.label || id;
	return result(id, 'byok', `${label} uses your own API key — availability is checked when you generate.`);
}

const PROBES = {
	nvidia: probeNvidia,
	huggingface: probeHuggingFace,
	trellis: probeReplicate,
	hunyuan3d: gcpWorkerProbe('hunyuan3d', 'GCP_HUNYUAN3D_URL'),
	triposg: gcpWorkerProbe('triposg', 'GCP_TRIPOSG_URL'),
	// The self-hosted TRELLIS worker is the DEFAULT image backend for the draft and
	// standard tiers, and it was the one platform lane with no live probe: it fell
	// through to the env-presence branch below and reported a flat "ok" whenever
	// MODEL_TRELLIS_URL happened to be set. That is exactly the blind spot this
	// report exists to close. On 2026-09-02 the worker latched a failed model load
	// and answered every job with "pipeline unavailable" for 12 hours while this
	// endpoint still called it healthy, so 70 of 219 generations went terminal with
	// nothing flagging it. It publishes the same /health contract the other GCP
	// workers do, load_error included, so the shared probe reads it as down.
	trellis_selfhost: gcpWorkerProbe('trellis_selfhost', 'MODEL_TRELLIS_URL'),
};

// The editing lanes: everything the result panel offers AFTER a mesh exists
// (remesh/retopo, stylize, segment, background removal, text-to-motion, auto-rig
// and region retexture). None of them were in this report, which is precisely
// how the retexture lane sat dead: `GCP_TEXTURE_URL` was never set on the
// service, /api/studio/retexture-region answered 501 to every caller, and the
// health endpoint said the forge was fine because it only ever looked at the
// generation backends. A tool the UI shows a button for is a lane a user can
// hit, so it is probed like any other upstream.
//
// They all speak the same worker contract the generation workers do (GET
// /health behind GCP_RECONSTRUCTION_KEY), so the shared probe reads them
// unchanged, including the load_error and readiness branches.
const EDITING_WORKERS = [
	{ id: 'remesh', env: 'GCP_REMESH_URL', label: 'Remesh / retopology' },
	{ id: 'stylize', env: 'GCP_STYLIZE_URL', label: 'Stylize' },
	{ id: 'segment', env: 'GCP_SEGMENT_URL', label: 'Segment' },
	{ id: 'rembg', env: 'GCP_REMBG_URL', label: 'Background removal' },
	{ id: 'text2motion', env: 'GCP_TEXT2MOTION_URL', label: 'Text to motion' },
	{ id: 'rig', env: 'GCP_UNIRIG_URL', label: 'Auto-rig' },
	{ id: 'texture', env: 'GCP_TEXTURE_URL', label: 'Retexture' },
];

async function probeEditingLanes() {
	const entries = await Promise.all(
		EDITING_WORKERS.map((w) => gcpWorkerProbe(w.id, w.env, w.label)()),
	);
	return Object.fromEntries(entries.map((e) => [e.id, e]));
}

// The distributed rate-limiter store gates every paid lane: when Redis is
// unreachable (or the Upstash account is over quota) the cost-protecting
// limiters fail closed and ALL standard/high/image generations 429 — while
// every backend above still reports ok. A June 2026 outage hid exactly there,
// so the store is probed like any other upstream: one PING over the same REST
// credentials the limiter uses.
async function probeLimiterStore() {
	const id = 'limiter';
	const url = env.UPSTASH_REDIS_REST_URL;
	const token = env.UPSTASH_REDIS_REST_TOKEN;
	const isProduction = env.NODE_ENV === 'production' || env.VERCEL_ENV === 'production';
	if (!url || !token) {
		return isProduction
			? result(id, 'down', 'The rate-limiter store is unconfigured — paid generation lanes fail closed (every non-draft submit is denied).')
			: result(id, 'ok', 'No Redis configured; the permissive in-memory limiter is active outside production.');
	}
	const started = Date.now();
	const res = await probeFetch(url, {
		method: 'POST',
		headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
		body: JSON.stringify(['PING']),
	});
	const latency = Date.now() - started;
	if (!res) return result(id, 'down', 'The rate-limiter store is unreachable — paid generation lanes fail closed.', { latency_ms: latency });
	let body = null;
	try {
		body = await res.json();
	} catch {
		// fall through — a non-JSON body is judged by status code below
	}
	if (res.ok && body?.result === 'PONG') {
		return result(id, 'ok', 'The rate-limiter store answered PING; paid lanes are open.', { latency_ms: latency });
	}
	const detail = body?.error || `HTTP ${res.status}`;
	return result(id, 'down', `The rate-limiter store rejected commands (${detail}) — paid generation lanes fail closed.`, { http_status: res.status, latency_ms: latency });
}

// world.three.ws (Hyperfy multiplayer world) is a separate Cloud Run service,
// but a forge user who generates an avatar wants to walk it into the world — so
// the forge health report surfaces the world too. Two real outage modes:
// unprotected (every visitor can delete the scene) and a missing blueprint
// asset (the scene crashes on join — the 2026-06-12 void-fall). The patched
// /status enumerates blueprint assets with absolute URLs; we HEAD a bounded
// sample so this probe stays as cheap as the others.
const WORLD_STATUS_URL =
	(env.WORLD_URL ? env.WORLD_URL.replace(/\/+$/, '') : 'https://world.three.ws') + '/status';
const WORLD_ASSET_SAMPLE = 12;

async function probeWorld() {
	const id = 'world';
	const started = Date.now();
	const res = await probeFetch(WORLD_STATUS_URL, {
		headers: { accept: 'application/json', 'user-agent': 'threews-forge-health/1.0' },
	});
	const latency = Date.now() - started;
	if (!res) return result(id, 'down', 'world.three.ws is unreachable.', { latency_ms: latency });
	if (!res.ok) {
		return result(id, 'down', `world.three.ws /status returned HTTP ${res.status}.`, { http_status: res.status, latency_ms: latency });
	}
	let status = null;
	try {
		status = await res.json();
	} catch {
		return result(id, 'down', 'world.three.ws /status returned an unparseable body.', { latency_ms: latency });
	}
	const isProtected = status?.protected === true;
	const blueprints = Array.isArray(status?.blueprints) ? status.blueprints : [];
	const assetUrls = blueprints
		.map((b) => b?.assetUrl)
		.filter((u) => typeof u === 'string' && /^https?:\/\//.test(u))
		.slice(0, WORLD_ASSET_SAMPLE);
	const heads = await Promise.all(
		assetUrls.map((u) => probeFetch(u, { method: 'HEAD', redirect: 'follow' })),
	);
	const missing = heads.filter((h) => !h || !h.ok).length;
	const extra = { protected: isProtected, blueprint_count: blueprints.length, latency_ms: latency };
	if (missing > 0) {
		return result(id, 'down', `${missing} blueprint asset(s) are missing — the scene will crash on join.`, extra);
	}
	if (!isProtected) {
		return result(id, 'degraded', 'The world is unprotected — ADMIN_CODE is unset, so every visitor has build rights.', extra);
	}
	return result(id, 'ok', 'The world is protected and all sampled blueprint assets are present.', extra);
}

let cache = null; // { at: epoch-ms, payload }

// Probe every backend in the registry, in parallel, with per-instance caching.
export async function probeForgeHealth({ force = false } = {}) {
	if (!force && cache && Date.now() - cache.at < CACHE_TTL_MS) {
		return { ...cache.payload, cached: true };
	}

	const [entries, editing, limiter, llm, world, redis, metrics] = await Promise.all([
		Promise.all(
			Object.values(BACKENDS).map(async (b) => {
				if (b.byok) return byokResult(b.id);
				const probe = PROBES[b.id];
				if (!probe) {
					// A platform backend with no live probe falls back to env presence —
					// weaker, but never silently absent from the report.
					return backendIsConfigured(b.id)
						? result(b.id, 'ok', 'Configured (env-presence check only).')
						: result(b.id, 'unconfigured', 'Required environment is not set on this deployment.');
				}
				return probe();
			}),
		),
		// Every post-generation tool lane, probed live rather than assumed.
		probeEditingLanes(),
		probeLimiterStore(),
		// LLM providers gate every AI-driven generation surface (prompt rewriting,
		// agent responses). A dead provider chain degrades the product the same way
		// a dead 3D backend does, so it folds into the same overall verdict.
		probeLlmHealth(),
		// The multiplayer world is downstream of the forge (generate → walk it in),
		// so a down/unprotected world degrades the overall verdict too.
		probeWorld(),
		// Quota-burn reading for the SAME store probeLimiterStore() pings. That
		// probe answers "is Redis reachable?"; this answers "is Redis about to run
		// out of quota?" — the slow failure that took the platform down in June
		// 2026 while every reachability check still read green.
		getRedisBurn(),
		// Real generation outcomes over the last 24h (success rate, latency, per-backend
		// load) from the rolling counters forge-events.js writes. This is what a probe
		// can't tell you: the upstream can authenticate fine while real user generations
		// are quietly failing. Null when Redis is absent — the block is then omitted
		// rather than shown as a misleading all-zero outage.
		readGenerationMetrics().catch(() => null),
	]);

	const backends = Object.fromEntries(entries.map((e) => [e.id, e]));
	// llm carries an 'ok' | 'degraded' | 'down' overall plus per-provider verdicts.
	// A down world degrades overall to 'degraded' (never 'down' — the forge still
	// functions when the world is offline), which the cap below already enforces.
	// A critical Redis burn rate degrades overall too: it predicts the limiters
	// failing closed before they actually do, so it warns rather than waits.
	// A real success rate below 75% over a meaningful sample (≥20 terminal outcomes)
	// is a live outage the upstream auth probes can't see — surface it in the overall
	// verdict. Below the volume floor the rate is too noisy to act on, so it's ignored.
	const generationUnhealthy =
		metrics && metrics.total >= 20 && metrics.success_rate != null && metrics.success_rate < 0.75;

	const statuses = entries
		.map((e) => e.status)
		.concat(Object.values(editing).map((e) => e.status))
		.concat(
			limiter.status,
			llm.overall,
			world.status,
			redis.status === 'critical' ? 'down' : 'ok',
			generationUnhealthy ? 'degraded' : 'ok',
		);
	const overall = statuses.includes('down') || statuses.includes('degraded') ? 'degraded' : 'ok';

	const payload = {
		status: overall,
		generated_at: new Date().toISOString(),
		backends,
		editing,
		limiter,
		llm,
		world,
		redis,
		// Live generation outcomes (omitted when Redis is absent).
		...(metrics ? { metrics } : {}),
	};
	cache = { at: Date.now(), payload };
	return { ...payload, cached: false };
}

// Test hook — health is cached per lambda instance; tests need a clean slate.
export function resetForgeHealthCache() {
	cache = null;
}
