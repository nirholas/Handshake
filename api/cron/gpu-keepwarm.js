// @ts-check
// GET /api/cron/gpu-keepwarm: hold the scale-to-zero GPU workers open during
// peak hours so a user's first generation of the hour does not pay a cold start.
//
// A Cloud Run GPU service with minScale=0 releases its container after an idle
// window, and the next request pays the worker's full spin-up budget (45s for
// TripoSG, 60s for TRELLIS, 75s for Hunyuan3D, per BACKENDS.coldStartSeconds in
// api/_lib/forge-tiers.js). A cheap authenticated GET every 10 minutes keeps the
// container resident, which is strictly cheaper than raising minScale because it
// only spends GPU during the hours people actually generate.
//
// WHY THIS IS AN ALLOWLIST AND NOT "every worker with minScale=0":
// Cloud Run GPU quota is per accelerator AND per region, and it caps CONCURRENT
// INSTANCES, not services. In us-central1 the granted NvidiaL4 no-zonal quota is
// 3, and the always-on floors (model-trellis minScale=1, model-rig minScale=1)
// already hold 2 of them. Pinning a third L4 worker warm would leave zero spare,
// so model-trellis (the workhorse lane, minScale 1 / maxScale 3) could never
// burst above its floor. Trading the primary lane's burst headroom for a
// fallback lane's cold start is a bad deal, so an L4 worker in us-central1 is
// only listed here once that quota grant grows. Lanes in their own region, or on
// an accelerator with spare quota, carry no such contention and are warmed now.
//
// Set FORGE_KEEPWARM_LANES (comma-separated lane ids) to override the default
// set without a deploy, which is the one-flag change to make when quota lands.
// An id in that list that matches no lane is reported as unknown_lanes and drops
// the tick's `ok` to false, so a typo cannot silently warm nothing.

import { json, method, wrapCron } from '../_lib/http.js';
import { requireCron } from '../_lib/cron-auth.js';

// Every self-host GPU lane that scales to zero. `safeByDefault` records whether
// warming it contends for a pool that a busier lane needs first (see above).
export const KEEPWARM_LANES = [
	{
		id: 'text2motion',
		urlEnv: 'GCP_TEXT2MOTION_URL',
		region: 'us-east4',
		accelerator: 'nvidia-l4',
		safeByDefault: true,
		reason: 'only GPU service in us-east4, so warming it contends with nothing',
	},
	{
		id: 'triposg',
		urlEnv: 'GCP_TRIPOSG_URL',
		region: 'us-central1',
		accelerator: 'nvidia-l4',
		safeByDefault: false,
		reason: 'us-central1 L4 grant is 3 and trellis+rig floors hold 2; warming this would cap the trellis lane at its floor',
	},
];

const PING_TIMEOUT_MS = 8_000;
// A worker that answers this fast was already resident; slower means this ping
// is what booted it, which is exactly the cold start a user would have paid.
const WARM_LATENCY_MS = 1_200;

/**
 * Resolve the override string into the lanes to warm this tick. An id that
 * matches no lane is reported rather than dropped: FORGE_KEEPWARM_LANES exists to
 * be edited without a deploy, and a typo in it would otherwise warm nothing at
 * all while the tick still answered `ok: true`, which is a silent outage of the
 * exact thing this cron prevents.
 * @param {string | undefined} raw
 * @returns {{ lanes: typeof KEEPWARM_LANES, unknown: string[], source: 'default'|'override' }}
 */
export function resolveKeepwarmLanes(raw) {
	const ids = String(raw || '').trim();
	if (!ids) {
		return { lanes: KEEPWARM_LANES.filter((l) => l.safeByDefault), unknown: [], source: 'default' };
	}
	const wanted = ids.split(',').map((s) => s.trim()).filter(Boolean);
	const known = new Set(KEEPWARM_LANES.map((l) => l.id));
	return {
		lanes: KEEPWARM_LANES.filter((l) => wanted.includes(l.id)),
		unknown: wanted.filter((id) => !known.has(id)),
		source: 'override',
	};
}

// One authenticated GET against the worker root. Cloud Run answers anything
// below 500 as soon as a container is up and routable, so a 404 at the root is a
// success: it proves the worker is serving. Mirrors the probe in
// api/_lib/forge-lane-health.js so both agree on what "warm" means.
async function pingLane(lane, key) {
	const url = process.env[lane.urlEnv];
	if (!url) return { id: lane.id, status: 'unconfigured' };
	const started = Date.now();
	try {
		const res = await fetch(url, {
			headers: { authorization: `Bearer ${key}` },
			signal: AbortSignal.timeout(PING_TIMEOUT_MS),
		});
		const latencyMs = Date.now() - started;
		if (res.status >= 500) return { id: lane.id, status: 'down', http: res.status, latencyMs };
		return {
			id: lane.id,
			status: 'ok',
			http: res.status,
			latencyMs,
			// false means this ping paid the boot, so the next real request will not.
			wasWarm: latencyMs <= WARM_LATENCY_MS,
		};
	} catch (err) {
		return {
			id: lane.id,
			status: 'unreachable',
			latencyMs: Date.now() - started,
			error: String(err?.message || err).slice(0, 120),
		};
	}
}

export default wrapCron(async (req, res) => {
	if (!method(req, res, ['GET'])) return;
	if (!requireCron(req, res)) return;

	const key = process.env.GCP_RECONSTRUCTION_KEY;
	if (!key) {
		// Nothing to authenticate with, so report a clean skip rather than a
		// failure: this deployment simply has no self-host workers wired.
		return json(res, 200, { ok: true, skipped: 'no_reconstruction_key', lanes: [] });
	}

	const { lanes, unknown } = resolveKeepwarmLanes(process.env.FORGE_KEEPWARM_LANES);
	if (unknown.length) {
		console.warn(`[gpu-keepwarm] FORGE_KEEPWARM_LANES names ${unknown.length} unknown lane(s): ${unknown.join(', ')}`);
	}
	const selected = new Set(lanes.map((l) => l.id));
	const results = await Promise.all(lanes.map((l) => pingLane(l, key)));

	const booted = results.filter((r) => r.status === 'ok' && r.wasWarm === false).map((r) => r.id);
	if (booted.length) {
		console.log(`[gpu-keepwarm] booted from cold: ${booted.join(', ')}`);
	}
	const broken = results.filter((r) => r.status === 'down' || r.status === 'unreachable');
	if (broken.length) {
		console.warn(`[gpu-keepwarm] unreachable: ${broken.map((r) => `${r.id}(${r.status})`).join(', ')}`);
	}

	return json(res, 200, {
		ok: unknown.length === 0,
		checked: results.length,
		warm: results.filter((r) => r.wasWarm).length,
		booted,
		unknown_lanes: unknown,
		skipped_for_quota: KEEPWARM_LANES.filter((l) => !l.safeByDefault && !selected.has(l.id)).map((l) => ({
			id: l.id,
			reason: l.reason,
		})),
		lanes: results,
	});
});
