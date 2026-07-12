// @ts-check
// GET/POST /api/cron/economy-tick — the single-URL heartbeat for the whole
// agent-to-agent economy.
//
// WHY THIS EXISTS. The economy is driven by a handful of per-minute engines
// (ring settlements, x402 micropayments, the Money Pulse, the autonomous spend
// loop, the Labor Market). Each used to need its own Vercel cron entry, but the
// project declares ~78 crons and Vercel only schedules the first 40 on Pro (2/day
// on Hobby) — so most economy ticks were silently never scheduled. GitHub Actions
// (the documented failover) is permanently unavailable on this account. The net
// effect: nothing ticked the economy except deploys, and it flat-lined for hours
// to days at a time.
//
// This endpoint collapses all of that into ONE job. Point any external minute
// scheduler at it (Vercel Cron, Upstash QStash, cron-job.org, or a small always-on
// host running scripts/economy-heartbeat.mjs) with the CRON_SECRET bearer and the
// entire economy ticks from a single URL — no GitHub, no per-engine cron sprawl.
//
// Every target engine is internally idempotent: per-tick spend caps, per-endpoint
// cooldowns, and daily ceilings absorb over-calling, so it is safe to fire this
// every minute (or more often) regardless of each engine's native cadence.
//
// Real on-chain payments only — this dispatcher never moves money itself; it just
// invokes the engines that do, over the same authenticated path Vercel Cron uses.

import { json, method, wrapCron } from '../_lib/http.js';
import { env } from '../_lib/env.js';
import { constantTimeEquals } from '../_lib/crypto.js';
import { logger } from '../_lib/usage.js';
import { cacheSet } from '../_lib/cache.js';

const log = logger('economy-tick');

const ORIGIN = () => (env.APP_ORIGIN || 'https://three.ws').replace(/\/+$/, '');

// The engines that make the agent economy move. `path` is invoked with the same
// `Authorization: Bearer $CRON_SECRET` header Vercel Cron would send. `label` is
// for the summary. Order is best-effort only — all fire concurrently.
//
// EVERY engine below is internally cadence-gated and spend-capped (per-tick caps,
// per-endpoint cooldowns, hourly/daily ceilings, "already ran today" guards,
// treasury floors, circuit breakers). Firing them all every minute is therefore
// safe by design: an engine whose native cadence isn't due simply records a clean
// `skipped` run and returns cheaply. That is the whole point — the economy is
// *invoked* every minute; each engine decides whether this is its minute to act.
// Do NOT thin this list to "save" invocations: an engine left out here is an
// engine that silently never runs, because it lives past Vercel's 40-cron cutoff.
const TARGETS = [
	// ── Payments & x402 (agent-to-agent USDC) ──────────────────────────────
	{ label: 'ring-tick', path: '/api/cron/x402-ring-tick', method: 'GET' },
	{ label: 'x402-seed', path: '/api/cron/x402-seed-cron', method: 'GET' },
	{ label: 'x402-autonomous', path: '/api/cron/x402-autonomous-loop', method: 'GET' },
	{ label: 'ring-leak-scan', path: '/api/cron/x402-ring-leak-scan', method: 'GET' },
	{ label: 'wallets-leak-scan', path: '/api/cron/wallets-leak-scan', method: 'GET' },
	{ label: 'distribute-payments', path: '/api/cron/run-distribute-payments', method: 'GET' },
	{ label: 'payment-session-sweep', path: '/api/cron/payment-session-sweep', method: 'GET' },
	// ── Money Pulse, Labor Market & delegation (tips, autonomous spend, hiring) ─
	{ label: 'money-pulse', path: '/api/cron/pulse-tick', method: 'GET' },
	{ label: 'labor-market', path: '/api/labor/tick', method: 'POST' },
	{ label: 'index-delegations', path: '/api/cron/index-delegations', method: 'GET' },
	// ── Coin launches (pump.fun) ───────────────────────────────────────────
	{ label: 'launcher', path: '/api/cron/launcher-tick', method: 'GET' },
	{ label: 'launcher-claimer', path: '/api/cron/launcher-claimer', method: 'GET' },
	{ label: 'coin-intel', path: '/api/cron/coin-intel-observe', method: 'GET' },
	{ label: 'pumpfun-monitor', path: '/api/cron/pumpfun-monitor', method: 'GET' },
	{ label: 'pumpfun-graduations', path: '/api/cron/pumpfun-graduations-sync', method: 'GET' },
	{ label: 'coin-cycle', path: '/api/cron/run-coin-cycle', method: 'GET' },
	{ label: 'coin-payouts', path: '/api/cron/run-coin-payouts', method: 'GET' },
	// ── Autonomous / copy / strategy trading ───────────────────────────────
	{ label: 'copy-fanout', path: '/api/cron/copy-fanout', method: 'GET' },
	{ label: 'mirror-fanout', path: '/api/cron/mirror-fanout', method: 'GET' },
	{ label: 'signal-fanout', path: '/api/cron/signal-fanout', method: 'GET' },
	{ label: 'strategy-fanout', path: '/api/cron/strategy-fanout', method: 'GET' },
	{ label: 'dca', path: '/api/cron/run-dca', method: 'GET' },
	// ── Tips, payouts, subscriptions, royalties ────────────────────────────
	{ label: 'club-payouts', path: '/api/cron/club-payouts', method: 'GET' },
	{ label: 'subscriptions', path: '/api/cron/run-subscriptions', method: 'GET' },
	{ label: 'process-subscriptions', path: '/api/cron/process-subscriptions', method: 'GET' },
	{ label: 'settle-royalties', path: '/api/cron/settle-royalties', method: 'GET' },
	{ label: 'cosmetic-splits', path: '/api/cron/cosmetic-splits-sweep', method: 'GET' },
	// ── $THREE buyback (revenue → buy → treasury) ──────────────────────────
	{ label: 'buyback', path: '/api/cron/run-buyback', method: 'GET' },
	{ label: 'three-buyback', path: '/api/cron/run-three-buyback', method: 'GET' },
	// ── Funding root, treasury autopilot & reconciliation ──────────────────
	{ label: 'treasury-topup', path: '/api/cron/treasury-topup', method: 'GET' },
	{ label: 'economy-rebalance', path: '/api/cron/economy-rebalance', method: 'GET' },
	{ label: 'treasury-autopilot', path: '/api/cron/treasury-autopilot', method: 'GET' },
	{ label: 'treasury-sweepback', path: '/api/cron/treasury-sweepback', method: 'GET' },
	{ label: 'economy-reconcile', path: '/api/cron/economy-reconcile', method: 'GET' },
	{ label: 'reflect-sweep', path: '/api/cron/reflect-sweep', method: 'GET' },
	// ── $THREE market & holder state ───────────────────────────────────────
	{ label: 'three-market-refresh', path: '/api/cron/three-market-refresh', method: 'GET' },
	// three-holders-snapshot is deliberately NOT a target: it has its own */5
	// vercel cron, and driving it from this every-minute tick as well multiplied
	// the Helius DAS walk ~6× — the sustained 429 storm in the July 2026 log
	// export (≈400 rate-limit deferrals in 10h). One scheduler owns that scan.
];

const CALL_TIMEOUT_MS = 60_000;

function requireCron(req, res) {
	const secret = process.env.CRON_SECRET || env.CRON_SECRET;
	if (!secret) { json(res, 503, { error: 'not_configured', message: 'CRON_SECRET unset' }); return false; }
	const auth = req.headers['authorization'] || '';
	const presented = auth.startsWith('Bearer ') ? auth.slice(7) : '';
	if (!constantTimeEquals(presented, secret)) { json(res, 401, { error: 'unauthorized' }); return false; }
	return true;
}

// Fire one engine over HTTP with the cron bearer. A non-2xx, a 404 (the deployed
// build may lag a newly-added engine), or a timeout is reported per-target and
// never throws — one dead engine must not stop the others.
async function fireTarget(origin, secret, target) {
	const url = `${origin}${target.path}`;
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), CALL_TIMEOUT_MS);
	const started = Date.now();
	try {
		const res = await fetch(url, {
			method: target.method,
			headers: {
				authorization: `Bearer ${secret}`,
				'user-agent': 'threews-economy-tick/1.0',
				...(target.method === 'POST' ? { 'content-type': 'application/json' } : {}),
			},
			...(target.method === 'POST' ? { body: '{}' } : {}),
			signal: controller.signal,
		});
		let body = null;
		try { body = await res.json(); } catch { /* non-JSON or empty */ }
		return {
			label: target.label,
			ok: res.ok,
			status: res.status,
			ms: Date.now() - started,
			// Surface the engine's own skip reason so the summary is diagnostic. Some
			// engines (circulation) return the reason string IN `skipped` rather than
			// a separate `reason` field — keep the string, don't flatten it away.
			...(body && typeof body === 'object' && (body.reason || typeof body.skipped === 'string')
				? { reason: String(body.reason || body.skipped).slice(0, 200) } : {}),
			...(body && typeof body === 'object' && body.skipped ? { skipped: true } : {}),
		};
	} catch (err) {
		return {
			label: target.label,
			ok: false,
			status: 0,
			ms: Date.now() - started,
			error: err?.name === 'AbortError' ? 'timeout' : (err?.message || 'fetch_failed'),
		};
	} finally {
		clearTimeout(timer);
	}
}

export default wrapCron(async (req, res) => {
	if (!method(req, res, ['GET', 'POST'])) return;
	if (!requireCron(req, res)) return;

	const origin = ORIGIN();
	const secret = process.env.CRON_SECRET || env.CRON_SECRET;

	const results = await Promise.all(TARGETS.map((t) => fireTarget(origin, secret, t)));
	const fired = results.filter((r) => r.ok).length;
	const failed = results.filter((r) => !r.ok).length;

	log.info('economy_tick_complete', { origin, fired, failed, results });

	// Park the summary where the public /api/status endpoint can read it (its
	// `economy` section). Every past economy stall was diagnosed hours late, from
	// the symptom (a dead Money Pulse feed) instead of the cause, because the
	// heartbeat's liveness and each engine's skip reason were invisible from
	// outside. Per-engine label/ok/status/reason only — no wallets, no amounts, no
	// secrets. A cache fault never fails the tick.
	await cacheSet('economy:last-tick', { t: Date.now(), fired, failed, engines: results }, 24 * 60 * 60)
		.catch(() => {});

	// 200 as long as at least one engine responded OK; 502 only on a total outage
	// (bad secret / origin down / every engine failing) so an external scheduler's
	// own alerting can catch a real economy-wide failure.
	const allDown = fired === 0;
	return json(res, allDown ? 502 : 200, {
		ok: !allDown,
		origin,
		fired,
		failed,
		results,
	});
});
