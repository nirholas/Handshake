// @ts-check
// GET /api/cron/uptime-check — first-party synthetic uptime monitor.
//
// Every 5 minutes (vercel.json crons) this probes the platform's critical
// public surfaces from the outside (real HTTPS against APP_ORIGIN, exactly
// what a user or paying agent hits), records the results in the shared cache,
// and pages the ops Telegram channel on failure and recovery. /api/status
// serves the aggregates; /status renders them as the public status page.
//
// Storage layout (Upstash Redis via _lib/cache.js):
//   uptime:snapshots — rolling 24h of raw probe rounds (288 @ 5-min cadence)
//   uptime:daily     — 90 days of per-target daily aggregates {n, up, msSum}
//
// A concrete file here outranks the [name].js dynamic dispatcher for this
// path, which keeps this handler's import graph tiny — a monitor must not
// share a 10s cold start with ethers/viem/pump-sdk.

import { json, method, wrapCron } from '../_lib/http.js';
import { env } from '../_lib/env.js';
import { cacheGet, cacheSet } from '../_lib/cache.js';
import { sendOpsAlert } from '../_lib/alerts.js';
import { gatherSubsystemHealth } from '../_lib/ops/subsystem-health.js';
import { requireCron } from '../_lib/cron-auth.js';

// The surfaces that constitute "the platform is up". Each is a cheap public
// GET — no auth, no side effects, no spend.
export const UPTIME_TARGETS = [
	{ id: 'site', label: 'Website', path: '/' },
	{ id: 'api', label: 'Platform API', path: '/api/healthz' },
	{ id: 'explore', label: 'Explore feed', path: '/api/explore' },
	{
		id: 'x402',
		label: 'x402 paid-API discovery',
		path: '/.well-known/x402.json',
	},
	{ id: 'viewer', label: '3D viewer', path: '/app' },
];

const PROBE_TIMEOUT_MS = 10_000;
const SNAPSHOT_WINDOW = 288; // 24h at 5-minute cadence
const DAILY_WINDOW = 90;
const SNAPSHOTS_KEY = 'uptime:snapshots';
const DAILY_KEY = 'uptime:daily';
const SNAPSHOTS_TTL_S = 2 * 24 * 60 * 60;
const DAILY_TTL_S = 100 * 24 * 60 * 60;

// Internal-dependency health (cache/ring/helius/db/world), gathered here and
// parked so /api/status can render it without a per-request DB ping.
const SUBSYSTEMS_KEY = 'uptime:subsystems';
const SUBSYSTEMS_TTL_S = 60 * 60; // 12× the 5-min cadence — a couple skipped ticks won't blank it
// Escalation memory: how many consecutive ticks each subsystem has been
// unhealthy, so a degradation that *persists* re-pages instead of dedup'ing into
// silence after the first hour. Keyed short; it only needs to survive tick-to-tick.
const DEGRADE_STREAK_KEY = 'uptime:subsystems:streak';
const DEGRADE_STREAK_TTL_S = 6 * 60 * 60;
// Re-page a still-degraded subsystem every this many ticks (5-min cadence → ~1h).
const RE_ESCALATE_EVERY_TICKS = 12;

// ── Agent-economy watchdog state ─────────────────────────────────────────────
// The July 2026 stall went undetected for ~9 hours because nothing watched the
// economy AS a system: the heartbeat can be dead, an engine can fail or skip on
// a fixable reason, or the public money feed can flat-line — each invisible from
// the surface probes above. This watchdog reads the heartbeat snapshot parked by
// api/cron/economy-tick.js plus the public pulse feed, and escalates through the
// same streak machinery as subsystems (page on first sight, re-page hourly while
// it persists, announce recovery).
const ECONOMY_TICK_KEY = 'economy:last-tick';
const ECONOMY_STREAK_KEY = 'uptime:economy:streak';
const ECONOMY_HISTORY_KEY = 'economy:history';
const ECONOMY_HISTORY_WINDOW = 288; // 24h at 5-min cadence
const ECONOMY_HEARTBEAT_DEAD_MS = 10 * 60_000; // heartbeat fires every minute; 10 min silent = scheduler dead
const PULSE_SILENT_MS = 90 * 60_000; // the money feed should never be quiet this long
// Skip reasons that mean "an operator must act", as opposed to benign cadence
// skips ("not due this minute"). Matched against each engine's own reason string.
const ACTIONABLE_REASON =
	/disabled|not_configured|not configured|unset|base58|undecodable|db_at_storage_cap|insufficient|sol_floor|settle_unaffordable|treasury|invalid|schema_failed|redis_unavailable|rpc_|escrow/i;

// Targets whose probe path was corrected AFTER history had been recorded for
// them without a path stamp (`p`). Their un-stamped rows measured a URL that
// never existed (the July 2026 x402/viewer probes 404'd for days while the real
// surfaces were healthy), so they are purged; un-stamped rows for every other
// target are grandfathered as genuine.
const REPROBED_IDS = new Set(['x402', 'viewer']);

// Drop stored history recorded against a DIFFERENT probe path than the
// target's current one: it measured the old URL, not the service. Mutates
// `snapshots` (24h raw rounds) and `daily` (90-day aggregates) in place.
// Exported for tests.
export function purgeStaleHistory(snapshots, daily, targets = UPTIME_TARGETS) {
	for (const t of targets) {
		const stale = (rec) =>
			rec != null && rec.p !== t.path && (rec.p !== undefined || REPROBED_IDS.has(t.id));
		for (const snap of snapshots) {
			if (stale(snap.results?.[t.id])) delete snap.results[t.id];
		}
		for (const day of daily) {
			if (stale(day.targets?.[t.id])) delete day.targets[t.id];
		}
	}
}

async function probe(target, origin) {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
	const started = Date.now();
	try {
		const res = await fetch(origin + target.path, {
			redirect: 'follow',
			headers: { 'user-agent': 'threews-uptime/1.0' },
			signal: controller.signal,
		});
		return { ok: res.ok, status: res.status, ms: Date.now() - started };
	} catch (e) {
		return {
			ok: false,
			status: 0,
			ms: Date.now() - started,
			error: e?.name === 'AbortError' ? 'timeout' : e?.message || 'fetch failed',
		};
	} finally {
		clearTimeout(timer);
	}
}

export default wrapCron(async (req, res) => {
	if (!method(req, res, ['GET'])) return;
	if (!requireCron(req, res)) return;

	const origin = env.APP_ORIGIN || 'https://three.ws';
	const results = Object.fromEntries(
		await Promise.all(
			// `p` records WHICH path produced each result, so history recorded
			// against a since-corrected path can be told apart from history of the
			// service itself (see the purge below).
			UPTIME_TARGETS.map(async (t) => [t.id, { ...(await probe(t, origin)), p: t.path }]),
		),
	);
	const now = Date.now();

	// Rolling raw snapshots (24h window).
	const snapshots = (await cacheGet(SNAPSHOTS_KEY)) || [];
	const daily = (await cacheGet(DAILY_KEY)) || [];
	purgeStaleHistory(snapshots, daily, UPTIME_TARGETS);

	const previous = snapshots[snapshots.length - 1] || null;
	snapshots.push({ t: now, results });
	while (snapshots.length > SNAPSHOT_WINDOW) snapshots.shift();
	await cacheSet(SNAPSHOTS_KEY, snapshots, SNAPSHOTS_TTL_S);

	// Per-day aggregates (90-day window) — drives the status page uptime bars.
	const day = new Date(now).toISOString().slice(0, 10);
	let today = daily[daily.length - 1];
	if (!today || today.d !== day) {
		today = { d: day, targets: {} };
		daily.push(today);
		while (daily.length > DAILY_WINDOW) daily.shift();
	}
	for (const [id, r] of Object.entries(results)) {
		const agg = (today.targets[id] ||= { n: 0, up: 0, msSum: 0, p: r.p });
		agg.n += 1;
		if (r.ok) agg.up += 1;
		agg.msSum += r.ms;
	}
	await cacheSet(DAILY_KEY, daily, DAILY_TTL_S);

	// Alert on failures; announce recovery once the target answers again.
	// sendOpsAlert dedups per signature per hour, so a sustained outage pages
	// once an hour instead of every 5 minutes.
	for (const target of UPTIME_TARGETS) {
		const r = results[target.id];
		const prev = previous?.results?.[target.id];
		if (!r.ok) {
			sendOpsAlert(
				`DOWN: ${target.label}`,
				`${origin}${target.path}\n${r.error || `HTTP ${r.status}`} after ${r.ms}ms`,
				{ signature: `uptime:down:${target.id}` },
			);
		} else if (prev && !prev.ok) {
			sendOpsAlert(`RECOVERED: ${target.label}`, `${origin}${target.path} — ${r.ms}ms`, {
				signature: `uptime:recovered:${target.id}:${now}`,
			});
		}
	}

	// ── Internal subsystem health ─────────────────────────────────────────────
	// Reachability (above) says the door opens; this says the rooms behind it are
	// healthy. Gather, park for /api/status, and drive an escalation digest that
	// re-pages a *persistent* degradation rather than going quiet after dedup.
	let subsystems = null;
	try {
		subsystems = await gatherSubsystemHealth();
		await cacheSet(SUBSYSTEMS_KEY, subsystems, SUBSYSTEMS_TTL_S);
		await escalateSubsystems(subsystems);
	} catch (err) {
		console.warn('[uptime-check] subsystem health gather failed:', err?.message || err);
	}

	// ── Agent-economy watchdog ────────────────────────────────────────────────
	let economy = null;
	try {
		economy = await watchEconomy(origin);
	} catch (err) {
		console.warn('[uptime-check] economy watchdog failed:', err?.message || err);
	}

	const downCount = Object.values(results).filter((r) => !r.ok).length;
	return json(res, 200, {
		ok: downCount === 0 && (subsystems ? subsystems.status !== 'down' : true),
		down: downCount,
		results,
		subsystems: subsystems ? { status: subsystems.status, degraded: subsystems.degraded } : null,
		economy,
	});
});

// ── Agent-economy watchdog ──────────────────────────────────────────────────
// Classify one heartbeat engine result as a problem string, or null if healthy.
// Exported for tests.
export function classifyEngine(e) {
	if (!e || typeof e !== 'object' || !e.label) return null;
	if (e.ok !== true) return `${e.label}: ${e.error || `HTTP ${e.status}`}`;
	const reason = typeof e.reason === 'string' ? e.reason : '';
	if (reason && ACTIONABLE_REASON.test(reason)) return `${e.label}: ${reason}`;
	return null;
}

// Watch the economy AS a system: heartbeat freshness, per-engine actionable
// failures, and public money-feed silence. Streak-gated escalation (page on
// first sight, re-page every RE_ESCALATE_EVERY_TICKS while it persists, one
// recovery note when clear) so a weeks-long stall can't hide behind a single
// deduped alert — and a 5-minute blip can't page all night.
async function watchEconomy(origin) {
	const problems = [];

	// 1. Heartbeat freshness — economy-tick fires every minute; silence means the
	// scheduler itself is broken and EVERY engine below is untrustworthy/stale.
	const tick = await cacheGet(ECONOMY_TICK_KEY);
	const tickAgeMs = tick?.t ? Date.now() - tick.t : Number.POSITIVE_INFINITY;
	const heartbeatDead = tickAgeMs > ECONOMY_HEARTBEAT_DEAD_MS;
	if (heartbeatDead) {
		problems.push(
			`heartbeat: last economy-tick ${Number.isFinite(tickAgeMs) ? `${Math.round(tickAgeMs / 60_000)} min ago` : 'never'} — scheduler not firing (see docs/economy-heartbeat.md)`,
		);
	}

	// 2. Per-engine actionable problems from the last heartbeat fan-out.
	if (!heartbeatDead && Array.isArray(tick?.engines)) {
		for (const e of tick.engines) {
			const problem = classifyEngine(e);
			if (problem) problems.push(problem);
		}
	}

	// 3. Money-feed silence — the end-to-end signal. Engines can all report
	// "ran" while producing nothing on-chain; the public feed is the truth.
	let lastEventAgeMs = null;
	try {
		const r = await fetch(`${origin}/api/pulse?limit=1`, {
			headers: { 'user-agent': 'threews-uptime/1.0' },
			signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
		});
		const body = await r.json();
		const ts = body?.data?.events?.[0]?.ts;
		if (ts) lastEventAgeMs = Date.now() - new Date(ts).getTime();
	} catch { /* feed probe failure is covered by the surface probes above */ }
	if (lastEventAgeMs != null && lastEventAgeMs > PULSE_SILENT_MS) {
		problems.push(`money-feed: no on-chain agent activity for ${Math.round(lastEventAgeMs / 3_600_000 * 10) / 10}h`);
	}

	// Streak-gated digest: one alert naming every current problem, not a page per
	// engine. Fingerprint on the problem KEYS (label part) so a reason's wording
	// changing doesn't re-page, but a new engine joining does.
	const keys = problems.map((p) => p.split(':')[0].trim()).sort();
	const prev = (await cacheGet(ECONOMY_STREAK_KEY)) || { keys: [], streak: 0 };
	const same = JSON.stringify(keys) === JSON.stringify(prev.keys);
	const streak = problems.length ? (same ? prev.streak + 1 : 1) : 0;

	if (problems.length && (streak === 1 || streak % RE_ESCALATE_EVERY_TICKS === 0)) {
		const ageNote = streak === 1 ? 'new' : `ongoing ~${Math.round((streak * 5) / 60 * 10) / 10}h`;
		sendOpsAlert(
			`ECONOMY: ${problems.length} engine problem${problems.length === 1 ? '' : 's'}`,
			`${problems.join('\n')}\n(${ageNote}) → https://three.ws/status`,
			{ signature: `economy:digest:${keys.join(',')}:${Math.floor(streak / RE_ESCALATE_EVERY_TICKS)}` },
		);
	}
	if (!problems.length && prev.keys.length) {
		sendOpsAlert('RESOLVED: agent economy healthy', 'all engines running, money feed live', {
			signature: `economy:resolved:${Date.now()}`,
		});
	}
	await cacheSet(ECONOMY_STREAK_KEY, { keys, streak }, DEGRADE_STREAK_TTL_S);

	// 24h problem history so /status (and a debugging agent) can see WHEN a
	// stall started, not just that one exists now.
	const history = (await cacheGet(ECONOMY_HISTORY_KEY)) || [];
	history.push({
		t: Date.now(),
		problems: problems.length,
		heartbeatAgeS: Number.isFinite(tickAgeMs) ? Math.round(tickAgeMs / 1000) : null,
		lastEventAgeS: lastEventAgeMs != null ? Math.round(lastEventAgeMs / 1000) : null,
	});
	while (history.length > ECONOMY_HISTORY_WINDOW) history.shift();
	await cacheSet(ECONOMY_HISTORY_KEY, history, SNAPSHOTS_TTL_S);

	return { problems, streak, heartbeatDead, lastEventAgeMs };
}

// Config-drift + escalation digest. A subsystem that is degraded/down for the
// first time pages immediately (deduped 1h by sendOpsAlert). One that *stays*
// unhealthy re-pages every RE_ESCALATE_EVERY_TICKS so a half-armed ring or an
// unprotected world can't quietly persist for days behind a single stale alert.
// A subsystem that recovers pages a one-line "resolved". Streaks live in the
// cache so this survives across the stateless cron invocations.
async function escalateSubsystems(health) {
	const unhealthy = health.subsystems.filter((s) => s.status === 'down' || s.status === 'degraded');
	const prevStreaks = (await cacheGet(DEGRADE_STREAK_KEY)) || {};
	const nextStreaks = {};

	for (const s of unhealthy) {
		const streak = (prevStreaks[s.name] || 0) + 1;
		nextStreaks[s.name] = streak;
		// Page on the first tick, then once per RE_ESCALATE_EVERY_TICKS thereafter.
		const shouldPage = streak === 1 || streak % RE_ESCALATE_EVERY_TICKS === 0;
		if (!shouldPage) continue;
		const ageNote = streak === 1 ? 'new' : `degraded for ~${Math.round((streak * 5) / 60 * 10) / 10}h`;
		sendOpsAlert(
			`${s.status === 'down' ? 'DOWN' : 'DEGRADED'}: ${s.label}`,
			`${s.detail || ''}${s.hint ? `\n→ ${s.hint}` : ''}\n(${ageNote})`,
			// Rotate the signature each re-escalation window so the hourly dedup in
			// sendOpsAlert doesn't swallow the repeat, but hold it steady within a
			// window so a 5-min tick storm still collapses to one page.
			{ signature: `subsystem:${s.status}:${s.name}:${Math.floor(streak / RE_ESCALATE_EVERY_TICKS)}` },
		);
	}

	// Recovery notices: anything that was unhealthy last tick and isn't now.
	for (const name of Object.keys(prevStreaks)) {
		if (nextStreaks[name]) continue;
		const rec = health.subsystems.find((s) => s.name === name);
		sendOpsAlert(`RESOLVED: ${rec?.label || name}`, rec?.detail || 'recovered', {
			signature: `subsystem:resolved:${name}:${Date.now()}`,
		});
	}

	await cacheSet(DEGRADE_STREAK_KEY, nextStreaks, DEGRADE_STREAK_TTL_S);
}
