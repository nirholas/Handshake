// GET /api/ops/health — comprehensive internal platform health check.
//
// Returns live probe results for every critical subsystem + cron heartbeats
// from Redis. Requires x-ops-secret header (OPS_SECRET env var). If the env
// var is unset, falls back to CRON_SECRET so ops pages work without extra setup.

import { cors, error, json, wrap, rateLimited } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { cacheGet } from '../_lib/cache.js';
import { env } from '../_lib/env.js';
import { sql } from '../_lib/db.js';
import { authorizeOps } from '../_lib/ops-auth.js';

const PROBE_TIMEOUT_MS = 8_000;
const ORIGIN = env.APP_ORIGIN || 'https://three.ws';

// ── Subsystems to probe live ─────────────────────────────────────────────────
// Each probe hits a real endpoint from outside. Grouped by category.
const PROBES = [
	// Core
	{ id: 'site', cat: 'core', label: 'Website', path: '/', expect: 200 },
	{ id: 'api', cat: 'core', label: 'Platform API', path: '/api/healthz', expect: 200 },
	{ id: 'explore', cat: 'core', label: 'Explore feed', path: '/api/explore', expect: [200, 401] },
	// x402
	{ id: 'x402_discovery', cat: 'x402', label: 'x402 discovery', path: '/.well-known/x402.json', expect: 200 },
	{ id: 'x402_dance_tip', cat: 'x402', label: 'dance-tip endpoint', path: '/api/x402/dance-tip', expect: 402 },
	{ id: 'x402_mint_batch', cat: 'x402', label: 'mint-to-mesh-batch', path: '/api/x402/mint-to-mesh-batch', method: 'POST', expect: 402 },
	{ id: 'x402_pay', cat: 'x402', label: 'x402-pay handler', path: '/api/x402-pay', method: 'POST', expect: [200, 400, 401] },
	// Pumpfun / trading
	{ id: 'pump_action', cat: 'trading', label: 'Pump action API', path: '/api/pump/launches', expect: [200, 400, 401, 404] },
	{ id: 'oracle_feed', cat: 'trading', label: 'Oracle feed', path: '/api/oracle/feed', expect: [200, 401] },
	{ id: 'oracle_signal', cat: 'trading', label: 'Oracle signal', path: '/api/oracle/signal', expect: [200, 401] },
	// Agents
	{ id: 'agents_public', cat: 'agents', label: 'Public agents list', path: '/api/agents/public', expect: [200, 401] },
	{ id: 'agents_featured', cat: 'agents', label: 'Featured agents', path: '/api/agents/featured', expect: [200, 401] },
	// Marketplace
	{ id: 'marketplace', cat: 'marketplace', label: 'Marketplace API', path: '/api/marketplace/agents', expect: [200, 401] },
	// Forge / AI
	{ id: 'forge_gallery', cat: 'ai', label: 'Forge gallery', path: '/api/forge-gallery', expect: [200, 401] },
	// Tips / social
	{ id: 'club_tips', cat: 'social', label: 'Tips stream (probe)', path: '/api/club/tips-stream', method: 'HEAD', expect: [200, 400, 401, 426] },
	// Avatars
	{ id: 'avatars_featured', cat: 'avatars', label: 'Featured avatars', path: '/api/avatars/featured', expect: [200, 401] },
	// Auth
	{ id: 'auth', cat: 'auth', label: 'Auth endpoint', path: '/api/auth', expect: [200, 400, 401, 404, 405] },
	// Payments
	{ id: 'pay_session', cat: 'payments', label: 'Payment sessions', path: '/api/pay/session', expect: [200, 401] },
	// Notifications
	{ id: 'notifications', cat: 'core', label: 'Notifications', path: '/api/notifications', expect: [200, 401] },
];

// ── Crons we expect to have heartbeats ──────────────────────────────────────
// stale_after_ms: how long before we consider a missing heartbeat a problem.
const CRONS = [
	{ id: 'uptime-check', label: 'Uptime monitor', stale_after_ms: 15 * 60 * 1000 },
	{ id: 'pulse-tick', label: 'Pulse tick', stale_after_ms: 15 * 60 * 1000 },
	{ id: 'oracle-score', label: 'Oracle score', stale_after_ms: 20 * 60 * 1000 },
	{ id: 'oracle-digest', label: 'Oracle digest', stale_after_ms: 70 * 60 * 1000 },
	{ id: 'three-holders-snapshot', label: 'THREE holders snapshot', stale_after_ms: 70 * 60 * 1000 },
	{ id: 'payment-session-sweep', label: 'Payment session sweep', stale_after_ms: 15 * 60 * 1000 },
	{ id: 'flush-usage-events', label: 'Flush usage events', stale_after_ms: 20 * 60 * 1000 },
	{ id: 'reflect-sweep', label: 'Reflect sweep', stale_after_ms: 70 * 60 * 1000 },
	{ id: 'forge-seed-cron', label: 'Forge seed', stale_after_ms: 40 * 60 * 1000 },
	{ id: 'avaturn-seed-cron', label: 'Avaturn seed', stale_after_ms: 6 * 60 * 60 * 1000 },
	{ id: 'smart-money-rollup', label: 'Smart money rollup', stale_after_ms: 70 * 60 * 1000 },
	{ id: 'smart-money-graph', label: 'Smart money graph', stale_after_ms: 70 * 60 * 1000 },
	{ id: 'dead-man-switch', label: 'Dead man switch', stale_after_ms: 15 * 60 * 1000 },
	{ id: 'world-health', label: 'World health', stale_after_ms: 40 * 60 * 1000 },
	{ id: 'quota-check', label: 'Quota check', stale_after_ms: 40 * 60 * 1000 },
	{ id: 'recompute-reputation', label: 'Reputation recompute', stale_after_ms: 6 * 60 * 60 * 1000 },
	{ id: 'copy-fanout', label: 'Copy fanout', stale_after_ms: 40 * 60 * 1000 },
	{ id: 'mirror-fanout', label: 'Mirror fanout', stale_after_ms: 40 * 60 * 1000 },
	{ id: 'signal-fanout', label: 'Signal fanout', stale_after_ms: 40 * 60 * 1000 },
	{ id: 'strategy-fanout', label: 'Strategy fanout', stale_after_ms: 40 * 60 * 1000 },
	{ id: 'gmgn-seed', label: 'GMGN seed', stale_after_ms: 70 * 60 * 1000 },
	{ id: 'intel-learn', label: 'Intel learn', stale_after_ms: 40 * 60 * 1000 },
	{ id: 'wallet-intents', label: 'Wallet intents', stale_after_ms: 15 * 60 * 1000 },
	{ id: 'auto-rig-sweep', label: 'Auto rig sweep', stale_after_ms: 40 * 60 * 1000 },
	{ id: 'radar-watchlist', label: 'Radar watchlist', stale_after_ms: 40 * 60 * 1000 },
];

async function runProbe(probe) {
	const url = `${ORIGIN}${probe.path}`;
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
	const t0 = Date.now();
	try {
		const res = await fetch(url, {
			method: probe.method || 'GET',
			redirect: 'manual',
			signal: controller.signal,
			headers: { 'user-agent': 'threews-ops-health/1.0' },
		});
		const ms = Date.now() - t0;
		const expected = Array.isArray(probe.expect) ? probe.expect : [probe.expect];
		const ok = expected.includes(res.status);
		return { id: probe.id, cat: probe.cat, label: probe.label, ok, status: res.status, ms };
	} catch (err) {
		return { id: probe.id, cat: probe.cat, label: probe.label, ok: false, status: 0, ms: Date.now() - t0, err: err?.message };
	} finally {
		clearTimeout(timer);
	}
}

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS', origins: 'same' })) return;
	if (req.method?.toUpperCase() !== 'GET') return error(res, 405, 'method_not_allowed', 'GET only');

	const rl = await limits.authIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	// Same hardened gate as /api/admin/ops-alerts: admin session or a dedicated
	// OPS_SECRET, fail-closed in production, never CRON_SECRET.
	const auth = await authorizeOps(req);
	if (!auth.ok) return error(res, 401, 'unauthorized', 'admin session or x-ops-secret required');

	const t0 = Date.now();

	// Run all probes in parallel
	const probeResults = await Promise.all(PROBES.map(runProbe));

	// Load all cron heartbeats in parallel
	const heartbeats = await Promise.all(
		CRONS.map(async (cron) => {
			const hb = await cacheGet(`cron:heartbeat:${cron.id}`).catch(() => null);
			const now = Date.now();
			const lastRan = hb?.t ?? null;
			const msSince = lastRan ? now - lastRan : null;
			const stale = msSince === null || msSince > cron.stale_after_ms;
			return {
				id: cron.id,
				label: cron.label,
				ok: hb?.ok ?? null,
				lastRan,
				msSince,
				stale,
				lastErr: hb?.ok === false ? hb.err : null,
				durationMs: hb?.ms ?? null,
			};
		}),
	);

	// Cross-network payment circuit breaker — latest per-network status written
	// hourly by the autonomous loop (api/_lib/x402/circuit-breaker.js). A tripped
	// route or failed Solana settlement means the payment stack is degraded.
	const circuitBreaker = await loadCircuitBreaker();

	// Agent wallet balance — latest sample written every 10 min by the autonomous
	// loop (api/_lib/x402/wallet-balance-monitor.js). A low/unconfigured wallet
	// means autonomous calls are about to start failing on insufficient funds.
	const walletBalance = await loadWalletBalance();

	// Payment-proof idempotency audit — latest verdict written daily by the
	// autonomous loop (api/_lib/x402/pipelines/payment-proof-idempotency-audit.js).
	// A confirmed double-settlement means the x402 anti-replay guard is broken.
	const idempotencyAudit = await loadIdempotencyAudit();

	// API-key bypass security test — latest verdict written daily by the autonomous
	// loop (api/_lib/x402/pipelines/api-key-bypass-audit.js). A confirmed leak means
	// the X-API-Key bypass lane is granting free access to a missing/invalid key —
	// paid endpoints can be drained for free.
	const apiKeyBypassAudit = await loadApiKeyBypassAudit();

	// Builder-code attribution — latest per-endpoint verdict written every 6h by the
	// autonomous loop (api/_lib/x402/pipelines/builder-code-attribution.js). A gap
	// (a priced endpoint that stopped declaring three_d_agent, or a failed attributed
	// settlement) means on-chain volume is settling UNATTRIBUTED — lost builder rewards.
	const builderAttribution = await loadBuilderAttribution();

	// Spend-reservation leak rate — swept count written every 15 min by the
	// autonomous loop (api/_lib/x402/pipelines/spend-reservation-leak-detector.js).
	// A sustained rate of orphaned reservations means a reserve→finalize path is
	// crashing and silently starving agent spend caps.
	const reservationLeaks = await loadReservationLeaks();

	// Categorize probe results
	const byCategory = {};
	for (const r of probeResults) {
		if (!byCategory[r.cat]) byCategory[r.cat] = [];
		byCategory[r.cat].push(r);
	}

	const allProbesOk = probeResults.every((r) => r.ok);
	const allCronsOk = heartbeats.every((h) => !h.stale && h.ok !== false);
	// A missing breaker row (never run / table absent) is unknown, not failing —
	// don't fail health on a feature that hasn't booted. Only a present-and-degraded
	// breaker folds into the verdict.
	const breakerOk = circuitBreaker.ok !== false;
	// A low or unconfigured wallet degrades health (autonomous spend will fail);
	// a never-run monitor (ok:null) is unknown, not failing.
	const walletOk = walletBalance.ok !== false;
	// A confirmed double-settlement (ok:false) degrades health; a never-run audit
	// (ok:null) is unknown, not failing.
	const idempotencyOk = idempotencyAudit.ok !== false;
	// An attribution gap (ok:false) degrades health — lost builder rewards; a
	// never-run/stale tracker (ok:null) is unknown, not failing.
	const attributionOk = builderAttribution.ok !== false;
	// A confirmed bypass leak / broken bypass (ok:false) degrades health — the
	// paywall is granting free access or rejecting valid keys; a never-run/stale
	// audit (ok:null) is unknown, not failing.
	const apiKeyBypassOk = apiKeyBypassAudit.ok !== false;
	// A systemic reservation-leak rate (ok:false) degrades health — agent spend caps
	// are being starved by orphaned reservations; a never-run/clean sweep (ok:null/
	// ok:true) is fine.
	const reservationLeaksOk = reservationLeaks.ok !== false;
	const overallOk = allProbesOk && allCronsOk && breakerOk && walletOk && idempotencyOk && attributionOk && apiKeyBypassOk && reservationLeaksOk;

	const failingProbes = probeResults.filter((r) => !r.ok);
	const failingCrons = heartbeats.filter((h) => h.stale || h.ok === false);

	return json(res, overallOk ? 200 : 207, {
		ok: overallOk,
		checkedAt: t0,
		durationMs: Date.now() - t0,
		summary: {
			probes: { total: probeResults.length, ok: probeResults.filter((r) => r.ok).length, failing: failingProbes.length },
			crons: { total: heartbeats.length, ok: heartbeats.filter((h) => !h.stale && h.ok !== false).length, failing: failingCrons.length },
		},
		failing: {
			probes: failingProbes,
			crons: failingCrons,
		},
		probes: byCategory,
		crons: heartbeats,
		circuitBreaker,
		walletBalance,
		idempotencyAudit,
		apiKeyBypassAudit,
		builderAttribution,
		reservationLeaks,
	});
});

// Read the latest builder-code attribution verdict written every 6h by the
// autonomous loop (api/_lib/x402/pipelines/builder-code-attribution.js). ok:false
// when a priced endpoint is currently missing/mismatched on its three_d_agent
// declaration (a gap, so its settled volume earns no rewards) or the attributed
// settlement proof failed. A stale or never-run tracker is unknown (ok:null) so
// health doesn't trip on a cold or paused feature.
const ATTRIBUTION_STALE_AFTER_MS = 8 * 60 * 60 * 1000; // 8h (6h cadence + slack)

async function loadBuilderAttribution() {
	try {
		const rows = await sql`
			SELECT endpoint, challenged, matches, gap, declared_code, expected_code,
			       settled, echo_accepted, tx_signature, error,
			       extract(epoch FROM checked_at) * 1000 AS checked_at_ms
			FROM builder_code_attribution
			ORDER BY checked_at DESC
		`;
		if (!rows.length) return { ok: null, reason: 'no_data' };
		const now = Date.now();
		const newest = Math.max(...rows.map((r) => Number(r.checked_at_ms) || 0));
		const stale = !newest || now - newest > ATTRIBUTION_STALE_AFTER_MS;
		const gaps = rows.filter((r) => r.gap);
		// A settlement proof row (settled column true on the endpoint we pay) that
		// flipped echo_accepted=false means an attributed payment failed to settle.
		// The settlement-proof target is the dance-tip row. It FAILED only when the
		// tracker matched its attribution (so it actually attempted an attributed
		// payment) yet the echo was not accepted for a reason other than a missing
		// wallet — i.e. the attributed payment was rejected/never settled on-chain.
		const settleRow = rows.find((r) => /dance-tip/.test(r.endpoint));
		const settleFailed = !!(settleRow && settleRow.matches && settleRow.echo_accepted === false
			&& !/^wallet_unconfigured/.test(settleRow.error || ''));
		const ok = stale ? null : gaps.length === 0 && !settleFailed;
		return {
			ok,
			expectedCode: rows[0]?.expected_code || null,
			endpointsChallenged: rows.filter((r) => r.challenged).length,
			attributed: rows.filter((r) => r.matches).length,
			gaps: gaps.map((g) => ({ endpoint: g.endpoint, declaredCode: g.declared_code, error: g.error })),
			settleTx: settleRow?.tx_signature || null,
			lastChecked: newest || null,
			stale,
		};
	} catch (err) {
		if (/does not exist|relation .* does not exist/i.test(err?.message || '')) {
			return { ok: null, reason: 'table_absent' };
		}
		return { ok: null, reason: `query_failed:${err?.message || 'unknown'}` };
	}
}

// Read the latest payment-proof idempotency audit verdict written daily by the
// autonomous loop (api/_lib/x402/pipelines/payment-proof-idempotency-audit.js).
// ok:false ONLY on a confirmed double-settlement (the anti-replay guard failed);
// a stale or never-run audit is unknown (ok:null), not failing, so health doesn't
// trip on a cold or paused feature.
const IDEMPOTENCY_STALE_AFTER_MS = 48 * 60 * 60 * 1000; // 48h (daily cadence + slack)

async function loadIdempotencyAudit() {
	try {
		const [row] = await sql`
			SELECT route, verdict, double_settled, pass, first_tx, second_tx,
			       second_marker, payment_id,
			       extract(epoch FROM ts) * 1000 AS checked_at_ms
			FROM x402_idempotency_audit
			ORDER BY ts DESC
			LIMIT 1
		`;
		if (!row) return { ok: null, reason: 'no_data' };
		const checkedAt = row.checked_at_ms ? Number(row.checked_at_ms) : null;
		const stale = checkedAt === null || Date.now() - checkedAt > IDEMPOTENCY_STALE_AFTER_MS;
		// Only a confirmed double-settlement fails health. A stale audit is unknown
		// (loop stopped writing), and an inconclusive run (first call never settled)
		// is not evidence of a broken guard → ok:null.
		const ok = row.double_settled ? false : stale ? null : row.verdict === 'inconclusive' ? null : true;
		return {
			ok,
			verdict: row.verdict,
			doubleSettled: row.double_settled,
			pass: row.pass,
			route: row.route,
			firstTx: row.first_tx,
			secondTx: row.second_tx,
			secondMarker: row.second_marker,
			paymentId: row.payment_id,
			lastChecked: checkedAt,
			stale,
		};
	} catch (err) {
		if (/does not exist|relation .* does not exist/i.test(err?.message || '')) {
			return { ok: null, reason: 'table_absent' };
		}
		return { ok: null, reason: `query_failed:${err?.message || 'unknown'}` };
	}
}

// Read the latest API-key bypass security-test verdict written daily by the
// autonomous loop (api/_lib/x402/pipelines/api-key-bypass-audit.js). ok:false ONLY
// on a confirmed bypass leak (free access granted to a missing/invalid key) or a
// broken bypass (valid keys rejected); a stale, never-run, or inconclusive audit
// is unknown (ok:null), not failing, so health doesn't trip on a cold/paused feature.
const API_KEY_BYPASS_STALE_AFTER_MS = 48 * 60 * 60 * 1000; // 48h (daily cadence + slack)

async function loadApiKeyBypassAudit() {
	try {
		const [row] = await sql`
			SELECT route, verdict, pass, leak, leaks, valid_key_source,
			       paid_settled, amount_atomic,
			       extract(epoch FROM ts) * 1000 AS checked_at_ms
			FROM x402_api_key_bypass_audit
			ORDER BY ts DESC
			LIMIT 1
		`;
		if (!row) return { ok: null, reason: 'no_data' };
		const checkedAt = row.checked_at_ms ? Number(row.checked_at_ms) : null;
		const stale = checkedAt === null || Date.now() - checkedAt > API_KEY_BYPASS_STALE_AFTER_MS;
		// A confirmed leak or broken bypass fails health. A stale/inconclusive audit
		// is unknown (loop paused, or a valid key couldn't be acquired) → ok:null.
		const ok =
			row.verdict === 'bypass_leak' || row.verdict === 'bypass_broken'
				? false
				: stale || row.verdict === 'inconclusive'
					? null
					: true;
		return {
			ok,
			verdict: row.verdict,
			pass: row.pass,
			leak: row.leak,
			leaks: row.leaks,
			route: row.route,
			validKeySource: row.valid_key_source,
			paidSettled: row.paid_settled,
			lastChecked: checkedAt,
			stale,
		};
	} catch (err) {
		if (/does not exist|relation .* does not exist/i.test(err?.message || '')) {
			return { ok: null, reason: 'table_absent' };
		}
		return { ok: null, reason: `query_failed:${err?.message || 'unknown'}` };
	}
}

// Read the latest agent-wallet balance sample written every 10 min by the
// autonomous loop (api/_lib/x402/wallet-balance-monitor.js). A sample older than
// the staleness window means the monitor stopped writing; ok:null when it has
// never run (table absent / no rows) so health doesn't fail on a cold feature.
const WALLET_STALE_AFTER_MS = 30 * 60 * 1000; // 30m (10-min cadence + slack)

async function loadWalletBalance() {
	try {
		const [row] = await sql`
			SELECT address, configured, usdc, sol, low_balance, threshold_usdc,
			       usdc_delta, spend_rate_usdc_hr,
			       extract(epoch FROM ts) * 1000 AS checked_at_ms
			FROM agent_wallet_balance_log
			ORDER BY ts DESC
			LIMIT 1
		`;
		if (!row) return { ok: null, reason: 'no_data' };
		const checkedAt = row.checked_at_ms ? Number(row.checked_at_ms) : null;
		const stale = checkedAt === null || Date.now() - checkedAt > WALLET_STALE_AFTER_MS;
		// Degraded when the wallet is below threshold or unconfigured. A stale
		// sample is unknown (monitor stopped), not a balance failure → ok:null.
		const ok = stale ? null : !(row.low_balance || row.configured === false);
		return {
			ok,
			configured: row.configured,
			address: row.address,
			usdc: row.usdc != null ? Number(row.usdc) : null,
			sol: row.sol != null ? Number(row.sol) : null,
			lowBalance: row.low_balance,
			thresholdUsdc: row.threshold_usdc != null ? Number(row.threshold_usdc) : null,
			usdcDelta: row.usdc_delta != null ? Number(row.usdc_delta) : null,
			spendRateUsdcHr: row.spend_rate_usdc_hr != null ? Number(row.spend_rate_usdc_hr) : null,
			lastChecked: checkedAt,
			stale,
		};
	} catch (err) {
		if (/does not exist|relation .* does not exist/i.test(err?.message || '')) {
			return { ok: null, reason: 'table_absent' };
		}
		return { ok: null, reason: `query_failed:${err?.message || 'unknown'}` };
	}
}

// Read the spend-reservation leak rate written every 15 min by the autonomous
// loop (api/_lib/x402/pipelines/spend-reservation-leak-detector.js). A reservation
// claims agent spend-cap headroom that a crash between reserve and finalize/release
// can orphan; the detector sweeps and frees them. A few swept leaks is normal noise
// (an occasional crashed request), but a SUSTAINED rate means a reserve→finalize
// path is breaking and silently starving agent spend caps — that degrades health.
// Never-run / table-absent → ok:null so health doesn't fail on a cold feature.
const LEAK_WINDOW_MS = 60 * 60 * 1000; // count leaks swept in the last hour
// At/above this many leaks swept in the window, treat it as a systemic leak.
const LEAK_DEGRADE_THRESHOLD = Math.max(
	1,
	Number(process.env.X402_RESERVATION_LEAK_HEALTH_THRESHOLD || 25),
);

async function loadReservationLeaks() {
	try {
		const [row] = await sql`
			SELECT count(*)::int AS swept_recent,
			       coalesce(sum(usd), 0)::float8 AS usd_freed,
			       coalesce(sum(sol_amount), 0)::float8 AS sol_freed,
			       count(DISTINCT agent_id)::int AS agents_affected,
			       extract(epoch FROM max(swept_at)) * 1000 AS last_swept_ms
			FROM spend_reservation_leaks
			WHERE swept_at > now() - ${`${Math.round(LEAK_WINDOW_MS / 1000)} seconds`}::interval
		`;
		const sweptRecent = Number(row?.swept_recent || 0);
		const lastSwept = row?.last_swept_ms ? Number(row.last_swept_ms) : null;
		// Below threshold (including zero) is healthy; at/above is a systemic leak.
		const ok = sweptRecent >= LEAK_DEGRADE_THRESHOLD ? false : true;
		return {
			ok,
			sweptRecent,
			windowHours: Math.round(LEAK_WINDOW_MS / 3600000),
			threshold: LEAK_DEGRADE_THRESHOLD,
			usdFreed: Number(row?.usd_freed || 0),
			solFreed: Number(row?.sol_freed || 0),
			agentsAffected: Number(row?.agents_affected || 0),
			lastSwept,
		};
	} catch (err) {
		if (/does not exist|relation .* does not exist/i.test(err?.message || '')) {
			return { ok: null, reason: 'table_absent' };
		}
		return { ok: null, reason: `query_failed:${err?.message || 'unknown'}` };
	}
}

// Read the latest per-network circuit-breaker snapshot. The hourly breaker
// upserts one row per network into x402_circuit_breaker; a row older than the
// staleness window means the loop stopped writing. Returns ok:null when the
// feature has never run (table absent / no rows) so health doesn't fail on it.
const BREAKER_STALE_AFTER_MS = 2 * 60 * 60 * 1000; // 2h (hourly cadence + slack)

async function loadCircuitBreaker() {
	try {
		const rows = await sql`
			SELECT network, label, scheme, advertised, route_ok, settled,
			       receipt_valid, tx_signature, error,
			       extract(epoch FROM checked_at) * 1000 AS checked_at_ms
			FROM x402_circuit_breaker
			ORDER BY label ASC
		`;
		if (!rows.length) return { ok: null, reason: 'no_data', networks: [] };
		const now = Date.now();
		const networks = rows.map((r) => {
			const checkedAt = r.checked_at_ms ? Number(r.checked_at_ms) : null;
			const stale = checkedAt === null || now - checkedAt > BREAKER_STALE_AFTER_MS;
			return {
				network: r.network,
				label: r.label,
				scheme: r.scheme,
				advertised: r.advertised,
				routeOk: r.route_ok,
				settled: r.settled,
				receiptValid: r.receipt_valid,
				txSignature: r.tx_signature,
				error: r.error,
				lastChecked: checkedAt,
				stale,
			};
		});
		const routesOk = networks.every((n) => n.routeOk && !n.stale);
		// Solana is the network we actually settle on; its settlement is the
		// end-to-end proof. Base/BSC are route-verify only.
		const solana = networks.find((n) => /solana/i.test(n.label) || /solana/i.test(n.network));
		const settlementOk = solana ? solana.settled && !solana.stale : false;
		const ok = routesOk && settlementOk;
		return {
			ok,
			routesOk,
			settlementOk,
			solanaTx: solana?.txSignature || null,
			networks,
		};
	} catch (err) {
		// Table not yet created (first boot before the loop runs) → unknown, not failing.
		if (/does not exist|relation .* does not exist/i.test(err?.message || '')) {
			return { ok: null, reason: 'table_absent', networks: [] };
		}
		return { ok: null, reason: `query_failed:${err?.message || 'unknown'}`, networks: [] };
	}
}
