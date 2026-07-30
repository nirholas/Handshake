// @ts-check
// GET /api/cron/world-health — synthetic monitor for world.three.ws (Hyperfy).
//
// Two failure modes, both user-facing and both seen in production:
//   1. UNPROTECTED — the Cloud Run service is serving without ADMIN_CODE, so
//      every visitor joins with build rights and can delete the scene. This is
//      how the 2026-06-12 void-fall started. /status reports `protected`.
//   2. MISSING ASSET — a blueprint references an asset URL that 404s. When the
//      $scene script asset vanished on 2026-06-12 the ground unloaded and every
//      joiner fell into a black void. The patched /status enumerates every
//      content-hashed blueprint asset with an absolute URL; we HEAD each one.
//
// Runs every 15 minutes (vercel.json crons). Like uptime-check, this is a
// concrete handler so its import graph stays tiny — a monitor must not share a
// cold start with the heavy generation/pump SDKs behind the [name].js dispatcher.

import { json, method, wrapCron } from '../_lib/http.js';
import { env } from '../_lib/env.js';
import { sendOpsAlert } from '../_lib/alerts.js';
import { constantTimeEquals } from '../_lib/crypto.js';
import { cacheSet } from '../_lib/cache.js';

// Where this cron parks its last outcome so the platform health gatherer
// (api/_lib/ops/subsystem-health.js → /healthz + /status) can read it without
// re-probing the external world service on every page load. The world is a
// separate Cloud Run deploy, so its health can only be learned by this cron's
// cross-service probe; the cache is the hand-off.
export const WORLD_HEALTH_CACHE_KEY = 'world:health';
const WORLD_HEALTH_TTL_S = 60 * 60; // 1h: 4× the 15-min cadence, so a skipped tick doesn't blank it

const WORLD_STATUS_URL = process.env.WORLD_URL
	? `${process.env.WORLD_URL.replace(/\/+$/, '')}/status`
	: 'https://world.three.ws/status';
const FETCH_TIMEOUT_MS = 10_000;
const ASSET_TIMEOUT_MS = 8_000;
const ASSET_CONCURRENCY = 10;

// Vercel cron invokes with `Authorization: Bearer <CRON_SECRET>`; manual probes
// may use `X-Cron-Secret: <CRON_SECRET>`. Accept either, constant-time. 503 if
// the secret is unset (misconfiguration), 403 if presented and wrong/absent.
function requireCron(req, res) {
	const secret = process.env.CRON_SECRET || env.CRON_SECRET;
	if (!secret) {
		json(res, 503, { error: 'not_configured', error_description: 'CRON_SECRET unset' });
		return false;
	}
	const auth = req.headers['authorization'] || '';
	const bearer = auth.startsWith('Bearer ') ? auth.slice(7) : '';
	const header = req.headers['x-cron-secret'] || '';
	if (constantTimeEquals(bearer, secret) || constantTimeEquals(header, secret)) return true;
	json(res, 403, { error: 'forbidden', error_description: 'invalid cron secret' });
	return false;
}

// A 404/410 is the world's own answer: the asset is genuinely gone. Every other
// failure (timeout, socket error, 5xx, 429) describes the network or the CDN at
// this instant, not the scene, so it must not be reported as a missing asset.
function isAuthoritativeMiss(status) {
	return status === 404 || status === 410;
}

async function headOnce(url) {
	try {
		const res = await fetch(url, {
			method: 'HEAD',
			redirect: 'follow',
			headers: { 'user-agent': 'threews-world-health/1.0' },
			signal: AbortSignal.timeout(ASSET_TIMEOUT_MS),
		});
		return { ok: res.ok, status: res.status };
	} catch (e) {
		return { ok: false, status: 0, error: e?.name === 'TimeoutError' ? 'timeout' : 'unreachable' };
	}
}

// HEAD every asset URL with a bounded number in flight so the whole sweep
// finishes well inside the 10s cron budget even with a large scene. A transient
// failure is retried once before it counts: an 8s timeout on a cold CDN edge
// used to alert "World asset MISSING" and park a degraded verdict for the full
// cache hour, indistinguishable from a real 404.
async function headAll(urls, concurrency) {
	const results = new Array(urls.length);
	let cursor = 0;
	async function worker() {
		while (cursor < urls.length) {
			const i = cursor++;
			let out = await headOnce(urls[i]);
			if (!out.ok && !isAuthoritativeMiss(out.status)) {
				out = await headOnce(urls[i]);
				if (!out.ok) out.transient = !isAuthoritativeMiss(out.status);
			}
			results[i] = out;
		}
	}
	await Promise.all(Array.from({ length: Math.min(concurrency, urls.length) }, worker));
	return results;
}

export default wrapCron(async (req, res) => {
	if (!method(req, res, ['GET'])) return;
	if (!requireCron(req, res)) return;

	// 1. Pull /status. A timeout or non-2xx means the world is down outright.
	let status;
	try {
		const r = await fetch(WORLD_STATUS_URL, {
			headers: { 'user-agent': 'threews-world-health/1.0', accept: 'application/json' },
			signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
		});
		if (!r.ok) {
			sendOpsAlert('World DOWN', `${WORLD_STATUS_URL} returned HTTP ${r.status}`, {
				signature: 'world-health:status-http',
			});
			return json(res, 200, { status: 'down', protected: null, blueprintCount: 0, reason: `HTTP ${r.status}` });
		}
		status = await r.json();
	} catch (e) {
		const reason = e?.name === 'TimeoutError' ? 'timeout' : e?.message || 'unreachable';
		sendOpsAlert('World DOWN', `${WORLD_STATUS_URL} unreachable — ${reason}`, {
			signature: 'world-health:status-unreachable',
		});
		return json(res, 200, { status: 'down', protected: null, blueprintCount: 0, reason });
	}

	const isProtected = status?.protected === true;
	// `blueprints` is the patched-/status asset list ({id, assetUrl}); tolerate an
	// older revision that predates the patch by treating an absent list as empty.
	const blueprints = Array.isArray(status?.blueprints) ? status.blueprints : [];
	// One asset is shared by many blueprints (a scene of 136 entries resolves to
	// 17 distinct files), so sweep the distinct set: 8x fewer requests inside the
	// same 10s budget, and one broken file counts once instead of once per user.
	const blueprintIdsByAsset = new Map();
	for (const b of blueprints) {
		const u = b?.assetUrl;
		if (typeof u !== 'string' || !/^https?:\/\//.test(u)) continue;
		if (!blueprintIdsByAsset.has(u)) blueprintIdsByAsset.set(u, []);
		if (b?.id) blueprintIdsByAsset.get(u).push(b.id);
	}
	const assetUrls = [...blueprintIdsByAsset.keys()];

	const problems = [];

	// 2. Unprotected → every visitor can edit the world. The admin code was lost
	//    or a revision shipped without the secret mounted.
	if (!isProtected) {
		problems.push('world is UNPROTECTED — ADMIN_CODE is not set; every visitor has build rights');
		sendOpsAlert(
			'World UNPROTECTED',
			'world.three.ws is serving without ADMIN_CODE — every visitor has build rights. Re-run deploy/world/apply-hardening.sh.',
			{ signature: 'world-health:unprotected' },
		);
	}

	// 3. HEAD every referenced asset; a 404 will crash the scene on join.
	const checks = await headAll(assetUrls, ASSET_CONCURRENCY);
	const missing = [];
	const unreachable = [];
	checks.forEach((c, i) => {
		if (c.ok) return;
		const ids = blueprintIdsByAsset.get(assetUrls[i]) || [];
		const entry = {
			assetUrl: assetUrls[i],
			blueprintId: ids[0],
			blueprintIds: ids,
			status: c.status,
			error: c.error,
		};
		(c.transient ? unreachable : missing).push(entry);
	});
	// Reported but never escalated: the scene still loads for everyone whose edge
	// serves the file, so this is a CDN observation, not a broken world.
	if (unreachable.length) {
		problems.push(`${unreachable.length} blueprint asset(s) unreachable this tick`);
		console.warn(
			`[world-health] transient asset failures: ${unreachable
				.map((m) => `${m.assetUrl} (${m.error || `HTTP ${m.status}`})`)
				.join(', ')}`,
		);
	}
	if (missing.length) {
		problems.push(`${missing.length} blueprint asset(s) missing`);
		const detail = missing
			.map((m) => `${m.blueprintId || 'unknown'}: ${m.assetUrl} (${m.error || `HTTP ${m.status}`})`)
			.join('\n');
		sendOpsAlert('World asset MISSING', detail, {
			// Signature keyed to the set of missing URLs so a new gap re-alerts but
			// the same sustained outage dedups to once an hour.
			signature: `world-health:missing:${missing.map((m) => m.assetUrl).sort().join(',')}`,
		});
	}

	const outcome = !isProtected || missing.length ? 'degraded' : 'ok';
	if (outcome === 'ok') {
		console.log(`[world-health] ok, ${blueprints.length} blueprints, protected: true`);
	} else {
		console.warn(`[world-health] ${outcome} — ${problems.join('; ')}`);
	}

	// Park the outcome for the platform health gatherer. Best-effort: a cache
	// write failure here must never fail the monitor itself, so swallow it.
	await cacheSet(
		WORLD_HEALTH_CACHE_KEY,
		{ status: outcome, protected: isProtected, problems, missingCount: missing.length, checkedAt: Date.now() },
		WORLD_HEALTH_TTL_S,
	).catch(() => {});

	return json(res, 200, {
		status: outcome,
		protected: isProtected,
		blueprintCount: blueprints.length,
		assetCount: assetUrls.length,
		...(missing.length ? { missingAssets: missing } : {}),
		...(unreachable.length ? { unreachableAssets: unreachable } : {}),
	});
});
