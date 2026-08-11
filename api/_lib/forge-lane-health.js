// Lightweight liveness/warmth for the self-host GPU lanes — the signal the
// health-aware router consults so a cold or down worker is skipped BEFORE submit.
//
// forge-health.js already runs a heavy, everything-at-once health report (every
// backend + the limiter + the world + LLM providers, 60s cache) for the status
// dashboard. The router needs something cheaper and tighter: just "can our own
// GPU workers serve a generation right now, and are they warm?" — answered from
// a short per-instance cache so the hot generation path pays no probe latency in
// the common case.
//
// Two independent signals fold into each lane's status:
//   1. A recent submit failure recorded a cooldown in the SHARED cache
//      (provider-health.js) — cross-instance memory that a lane just failed, so
//      every instance skips it until the window expires. This is authoritative:
//      a cooled lane is reported `down` without spending a probe.
//   2. A cheap authenticated GET against the worker root. Cloud Run answers
//      anything <500 the moment a container is up and routable; unreachable /
//      timeout / 5xx means a submit would fail. Round-trip latency doubles as a
//      warmth signal — a scale-to-zero container that just spun up answers slowly.
//
// Only self-host (provider === 'gcp') lanes are probed; the free external lanes
// (NVIDIA NIM, HuggingFace) carry their own circuit breakers in the handler and
// are reported `unknown` here unless a cooldown marks them down, so the router
// never blocks on telemetry it doesn't have.
//
// Everything is best-effort and fail-open: a probe error or cache miss degrades
// to `unknown`, which the router treats as usable — exactly the pre-health
// behaviour.

import { BACKENDS, isSelfHostBackend } from './forge-tiers.js';
import { providersInCooldown, markProviderCooldown } from './provider-health.js';

// Self-host worker URLs are env-gated; the URL env is the lane's first requiresEnv
// entry, the bearer is the shared GCP_RECONSTRUCTION_KEY (second entry).
function readEnv(name) {
	if (typeof process !== 'undefined' && process.env?.[name]) return process.env[name];
	return null;
}

// Cooldown key for a lane's recent-failure breaker. Distinct namespace from the
// LLM/NIM keys so a self-host worker outage can't collide with another lane's.
export function laneCooldownKey(backendId) {
	return `forge-lane:${backendId}`;
}

// Record that a self-host lane just failed at submit, so subsequent requests on
// any instance skip it until the window expires. Fire-and-forget; never throws.
const LANE_COOLDOWN_SECONDS = 90;
export async function markLaneUnhealthy(backendId, seconds = LANE_COOLDOWN_SECONDS) {
	if (!backendId) return;
	await markProviderCooldown(laneCooldownKey(backendId), seconds).catch(() => {});
}

const PROBE_TIMEOUT_MS = 2_500;
// A reachable worker that answers within this is warm; slower means it is most
// likely a scale-to-zero container spinning up, so the lane is reported cold and
// the caller widens the ETA by the lane's cold-start budget.
const WARM_LATENCY_MS = 1_200;
// Per-instance snapshot cache — short enough that a worker coming back is picked
// up within a poll cycle, long enough that a burst of generations shares one probe.
const SNAPSHOT_TTL_MS = 20_000;

let snapshotCache = null; // { at, byId }

// Probe one self-host worker: authenticated GET against its /health route.
// Returns a status record. The URL/key being absent is reported `unknown`
// (env-gating already keeps an unconfigured lane out of routing) rather than
// `down`.
//
// This probed the service ROOT until 2026-08-11 and read anything under 500 as
// a healthy lane. No worker serves its root, so the probe scored a 404 as "ok"
// and logged a warning in the worker's own log on every generation; worse, a
// worker whose weight load had FAILED answered that 404 identically to a
// working one, so routing kept sending generations at a lane that could only
// fail them. /health carries the real state, at the same cost.
async function probeSelfHostLane(backendId) {
	const meta = BACKENDS[backendId];
	const urlEnv = meta?.requiresEnv?.[0];
	const url = urlEnv ? readEnv(urlEnv) : null;
	const key = readEnv('GCP_RECONSTRUCTION_KEY');
	if (!url || !key) return { id: backendId, status: 'unknown', warm: false };

	const started = Date.now();
	let res;
	try {
		res = await fetch(`${url.replace(/\/+$/, '')}/health`, {
			headers: { authorization: `Bearer ${key}` },
			signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
		});
	} catch {
		return { id: backendId, status: 'down', warm: false };
	}
	const latencyMs = Date.now() - started;
	if (res.status >= 500) return { id: backendId, status: 'down', warm: false, latencyMs };
	const warm = latencyMs <= WARM_LATENCY_MS;
	// A worker that publishes no health body is still routable: fail open on the
	// old "reachable means ok" rule rather than dropping a working lane.
	const body = res.status < 400 ? await res.json().catch(() => null) : null;
	if (!body || typeof body !== 'object') return { id: backendId, status: 'ok', warm, latencyMs };
	// A failed model load is terminal for this revision: every generation routed
	// here would come back failed.
	if (body.load_error) return { id: backendId, status: 'down', warm: false, latencyMs };
	// Field name varies by worker generation (Hunyuan3D: ready/pipeline_loaded,
	// TripoSG: model_loaded). Still-loading is reachable but never warm: the
	// caller widens its ETA by the lane's cold-start budget instead of promising
	// a fast turnaround the worker cannot deliver.
	const readiness = [body.ready, body.pipeline_loaded, body.model_loaded].find((v) => typeof v === 'boolean');
	if (readiness === false) return { id: backendId, status: 'ok', warm: false, latencyMs };
	return { id: backendId, status: 'ok', warm, latencyMs };
}

// Health snapshot for a set of candidate lane ids. Self-host lanes are probed
// (cooldown short-circuits the probe); other lanes are reported from cooldown
// state only. Cached per instance for SNAPSHOT_TTL_MS so a burst of generations
// shares one probe round and the hot path usually pays nothing.
//
// Returns { byId: { [id]: { status, warm, latencyMs? } }, statusMap: { [id]: status } }.
// `statusMap` is the shape resolveBackendIdWithHealth() consumes directly.
export async function laneHealthSnapshot(candidateIds = [], { force = false } = {}) {
	const ids = [...new Set(candidateIds)].filter((id) => BACKENDS[id]);
	if (!ids.length) return { byId: {}, statusMap: {} };

	if (!force && snapshotCache && Date.now() - snapshotCache.at < SNAPSHOT_TTL_MS) {
		// Serve cached entries; probe only ids we haven't seen this window.
		const missing = ids.filter((id) => !(id in snapshotCache.byId));
		if (!missing.length) return project(ids, snapshotCache.byId);
		const fresh = await probeMany(missing);
		snapshotCache = { at: snapshotCache.at, byId: { ...snapshotCache.byId, ...fresh } };
		return project(ids, snapshotCache.byId);
	}

	const byId = await probeMany(ids);
	snapshotCache = { at: Date.now(), byId };
	return project(ids, byId);
}

async function probeMany(ids) {
	// One shared cooldown read covers every candidate (the cache layer coalesces).
	const cooling = await providersInCooldown(ids.map(laneCooldownKey)).catch(() => new Map());
	const entries = await Promise.all(
		ids.map(async (id) => {
			// A cooled lane is authoritatively down — skip the probe entirely.
			if (cooling.has(laneCooldownKey(id))) return [id, { id, status: 'down', warm: false, cooled: true }];
			if (isSelfHostBackend(id)) return [id, await probeSelfHostLane(id)];
			// External free lane (NVIDIA/HF): no cheap warmth probe here (they have
			// their own breakers in the handler) — report unknown so the router never
			// blocks on it.
			return [id, { id, status: 'unknown', warm: false }];
		}),
	);
	return Object.fromEntries(entries);
}

function project(ids, byId) {
	const out = {};
	const statusMap = {};
	for (const id of ids) {
		const rec = byId[id] || { id, status: 'unknown', warm: false };
		out[id] = rec;
		statusMap[id] = rec.status;
	}
	return { byId: out, statusMap };
}

// Test hook — the snapshot is cached per instance; tests need a clean slate.
export function resetLaneHealthCache() {
	snapshotCache = null;
}
