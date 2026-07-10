// GET /api/healthz
// ----------------
// Lightweight liveness/readiness endpoint. Returns 200 with uptime + a small
// summary block compatible with the pump-dashboard's API status panel.
//
// Core health is always green (no hard DB dependency). Optional sub-probes
// (Resend, x402) are cached for 5 minutes and fail gracefully — a DB outage
// degrades the `x402` block but never the top-level `status: 'ok'`.

import { cors, json, method, wrap } from './_lib/http.js';
import { countRecentPayments } from './_lib/x402/audit-log.js';
import { gatherSubsystemHealth } from './_lib/ops/subsystem-health.js';
import { nvidiaTtsConfigured, nvidiaAsrConfigured } from './_lib/ai-speech.js';
import { alertsConfigured } from './_lib/alerts.js';

const STARTED_AT = Date.now();
const VERSION = process.env.VERCEL_GIT_COMMIT_SHA || process.env.npm_package_version || 'dev';

const CACHE_TTL_MS = 5 * 60 * 1000;
const RESEND_CACHE_TTL_MS = CACHE_TTL_MS;
// The pumpfun-monitor cron runs every 3 min and upserts bot_heartbeat. Allow 2×
// the interval before declaring the worker stopped, so a single skipped tick
// doesn't flap the status.
const HEARTBEAT_FRESH_MS = 6 * 60 * 1000;
const MONITOR_CACHE_TTL_MS = 8 * 1000;
// Subsystem health is a live read of in-process breaker state + one DB ping.
// Cache it briefly so a burst of /healthz hits (dashboards poll it) doesn't fire
// a DB ping each — but keep the TTL short so a breaker tripping shows up fast.
const SUBSYSTEMS_CACHE_TTL_MS = 5 * 1000;
let _resendCache = { value: null, expiresAt: 0 };
let _x402Cache = { value: null, expiresAt: 0 };
let _monitorCache = { value: null, expiresAt: 0 };
let _subsystemsCache = { value: null, expiresAt: 0 };

// Exported for tests so each case starts with a cold cache.
export function _resetResendCache() {
	_resendCache = { value: null, expiresAt: 0 };
}
export function _resetX402Cache() {
	_x402Cache = { value: null, expiresAt: 0 };
}
export function _resetMonitorCache() {
	_monitorCache = { value: null, expiresAt: 0 };
}
export function _resetSubsystemsCache() {
	_subsystemsCache = { value: null, expiresAt: 0 };
}

// Live subsystem health (cache breaker, Helius breaker, ring invariants, DB
// ping, world). Cached SUBSYSTEMS_CACHE_TTL_MS. Defensive: gatherSubsystemHealth
// never throws, but wrap anyway so /healthz stays green even if it did.
async function probeSubsystems() {
	const now = Date.now();
	if (_subsystemsCache.value && _subsystemsCache.expiresAt > now) return _subsystemsCache.value;
	let value;
	try {
		value = await gatherSubsystemHealth();
	} catch {
		value = { status: 'unknown', checkedAt: now, counts: {}, degraded: [], subsystems: [] };
	}
	_subsystemsCache = { value, expiresAt: now + SUBSYSTEMS_CACHE_TTL_MS };
	return value;
}

// Real bot/monitor status, sourced from Postgres:
//   running  — a bot_heartbeat row written by the pumpfun-monitor cron within
//              the freshness window. When no row exists yet (or the DB is
//              unreachable, e.g. in unit tests) we fall back to the serverless
//              liveness signal: the function answering IS a liveness proof.
//   mode     — the worker's reported mode (the cron writes 'cron').
//   claimsDetected — count of real graduation events the monitor has recorded.
//   watches.total  — users with at least one alert rule armed (server-side
//                    watchers that fire even with no tab open).
async function probeMonitor() {
	const now = Date.now();
	if (_monitorCache.value && _monitorCache.expiresAt > now) return _monitorCache.value;

	let value;
	try {
		const { sql } = await import('./_lib/db.js');
		const [beat] = await sql`
			SELECT mode, last_beat_at FROM bot_heartbeat
			ORDER BY last_beat_at DESC LIMIT 1
		`;
		const [{ graduations }] = await sql`
			SELECT count(*)::int AS graduations FROM pumpfun_graduations
		`;
		const [{ watches }] = await sql`
			SELECT count(*)::int AS watches FROM pump_alert_rules WHERE enabled
		`;
		const beatMs = beat?.last_beat_at ? new Date(beat.last_beat_at).getTime() : 0;
		const fresh = beatMs > 0 && now - beatMs < HEARTBEAT_FRESH_MS;
		value = {
			monitor: {
				// If a heartbeat row exists, trust its freshness. If none exists yet,
				// the dedicated worker hasn't reported — report the serverless API's
				// own liveness rather than a false "stopped".
				running: beat ? fresh : true,
				mode: beat?.mode || 'serverless',
				claimsDetected: graduations,
			},
			watches: { total: watches, active: watches },
		};
	} catch {
		value = {
			monitor: { running: true, mode: 'serverless', claimsDetected: 0 },
			watches: { total: 0, active: 0 },
		};
	}

	_monitorCache = { value, expiresAt: now + MONITOR_CACHE_TTL_MS };
	return value;
}

async function probeResend() {
	const now = Date.now();
	if (_resendCache.value && _resendCache.expiresAt > now) {
		return _resendCache.value;
	}

	const key = process.env.RESEND_API_KEY;
	if (!key) {
		_resendCache = { value: 'missing', expiresAt: now + RESEND_CACHE_TTL_MS };
		return 'missing';
	}

	let result;
	try {
		const r = await fetch('https://api.resend.com/domains', {
			method: 'GET',
			headers: { Authorization: `Bearer ${key}` },
			signal: AbortSignal.timeout(3000),
		});
		if (r.ok) {
			result = 'configured';
		} else if (r.status === 401) {
			// Send-only ("restricted") keys legitimately can't list domains.
			const body = await r.text().catch(() => '');
			result = body.includes('restricted_api_key') ? 'configured' : 'key_invalid';
		} else if (r.status === 403) {
			result = 'configured';
		} else {
			result = 'key_invalid';
		}
	} catch {
		result = 'key_invalid';
	}

	_resendCache = { value: result, expiresAt: now + RESEND_CACHE_TTL_MS };
	return result;
}

async function probeX402() {
	const now = Date.now();
	if (_x402Cache.value && _x402Cache.expiresAt > now) {
		return _x402Cache.value;
	}

	const result = {};

	// Check if PAY_TO addresses are configured. A network counts as wired only
	// when EVERY field its 402 accept needs is present — the same gate
	// buildRequirements() applies before advertising it. Solana additionally
	// requires a fee payer (no default): without it the accept is dropped, so a
	// Solana-only paid endpoint (e.g. /api/x402/club-cover) fails closed with a
	// 500. Surfacing it here turns a silent door outage into a visible warning.
	const hasSolanaPayTo = !!process.env.X402_PAY_TO_SOLANA || !!process.env.X402_PAY_TO;
	const hasSolanaFeePayer = !!process.env.X402_FEE_PAYER_SOLANA;
	const hasBase = !!process.env.X402_PAY_TO_BASE;
	const hasSolana = hasSolanaPayTo && hasSolanaFeePayer;
	result.configured = hasBase || hasSolana;
	result.networks = [];
	if (hasBase) result.networks.push('base');
	if (hasSolana) result.networks.push('solana');
	result.warnings = [];
	if (hasSolanaPayTo && !hasSolanaFeePayer) {
		result.warnings.push(
			'solana_fee_payer_missing: X402_PAY_TO_SOLANA is set but X402_FEE_PAYER_SOLANA is not — ' +
				'Solana accepts are dropped, breaking Solana-only paid endpoints (club-cover, dance-tip).',
		);
	}

	// The 402 challenge advertises a Solana fee payer PUBKEY (X402_FEE_PAYER_SOLANA),
	// but a sponsor-mode settle can only complete if the matching SECRET is loaded
	// to co-sign — a config where the pubkey is set and the secret is not passes
	// every check above yet 502s on every settle (observed: club-cover's last
	// on-chain settles failed with `sponsor_key_unconfigured`). Probe the co-sign
	// key so that false-green stops reading as healthy. No key material is exposed:
	// loadFeePayerKeypair throws on missing/mismatched secret and we report only a
	// status word.
	if (hasSolana) {
		try {
			const { SELF_FACILITATOR_ENABLED, loadFeePayerKeypair } = await import('./_lib/x402/self-facilitator.js');
			if (!SELF_FACILITATOR_ENABLED) {
				result.sponsor_cosign = 'facilitator_disabled';
			} else {
				try {
					loadFeePayerKeypair();
					result.sponsor_cosign = 'ready';
				} catch (err) {
					const mismatch = /!=|expected 64 bytes|mismatch/i.test(String(err?.message || ''));
					result.sponsor_cosign = mismatch ? 'mismatch' : 'missing';
					result.warnings.push(
						`sponsor_cosign_${result.sponsor_cosign}: the Solana fee-payer pubkey is advertised but its ` +
							'co-signing secret cannot be loaded — sponsor-mode settlements 502 (club-cover, dance-tip). ' +
							'Set/repair X402_FEE_PAYER_SECRET_BASE58 in the deploy environment.',
					);
				}
			}
		} catch {
			result.sponsor_cosign = 'unknown';
		}
	}

	// Probe facilitator connectivity (cached at this level, 5 min TTL)
	const facilitatorUrl = process.env.X402_CDP_FACILITATOR_URL || process.env.X402_FACILITATOR_URL_BASE;
	if (facilitatorUrl) {
		try {
			const r = await fetch(facilitatorUrl + '/supported', {
				method: 'GET',
				headers: { accept: 'application/json' },
				signal: AbortSignal.timeout(5000),
			});
			result.facilitator = r.ok ? 'reachable' : 'error_' + r.status;
		} catch {
			result.facilitator = 'unreachable';
		}
	} else {
		result.facilitator = 'not_configured';
	}

	// Provider Hub (zauthx402) x402 telemetry — report whether the SDK
	// initialized so the integration is observable in prod. Booleans only:
	// no key material is surfaced on this public, unauthenticated endpoint.
	try {
		const { status: zauthStatus } = await import('./_lib/zauth.js');
		const z = zauthStatus();
		result.telemetry = {
			provider: 'zauthx402',
			configured: z.hasKey,
			initialized: z.initialized,
		};
	} catch {
		result.telemetry = { provider: 'zauthx402', configured: false, initialized: false };
	}

	// Recent payments from audit log
	result.recent_payments = await countRecentPayments(60);

	// Self-facilitator verify/settle outcomes (last 24h), grouped by reason
	// class. A paying buyer whose wallet mutates the prepared transaction gets a
	// deterministic verify 402 with everything else on this endpoint green —
	// without this block that failure mode is invisible outside the admin
	// dashboards. Only the reason prefix (before ':') is exposed: suffixes can
	// carry wallet addresses, the prefix is a fixed validator code.
	try {
		const { sql } = await import('./_lib/db.js');
		const rows = await sql`
			SELECT action, ok, split_part(coalesce(reject_reason, ''), ':', 1) AS reason,
			       count(*)::int AS n
			FROM x402_self_facilitator_log
			WHERE ts > now() - interval '24 hours'
			GROUP BY 1, 2, 3
			ORDER BY n DESC
			LIMIT 20
		`;
		const block = {
			verify: { ok: 0, rejected: 0, reject_reasons: {} },
			settle: { ok: 0, failed: 0, fail_reasons: {} },
		};
		for (const r of rows) {
			const side = r.action === 'settle' ? block.settle : block.verify;
			if (r.ok) {
				side.ok += r.n;
			} else if (r.action === 'settle') {
				side.failed += r.n;
				if (r.reason) side.fail_reasons[r.reason] = (side.fail_reasons[r.reason] || 0) + r.n;
			} else {
				side.rejected += r.n;
				if (r.reason) side.reject_reasons[r.reason] = (side.reject_reasons[r.reason] || 0) + r.n;
			}
		}
		result.self_facilitator = block;
	} catch {
		result.self_facilitator = 'unavailable';
	}

	// SIWX reachability (just check if the table exists)
	try {
		await (await import('./_lib/db.js')).sql`
			SELECT 1 FROM siwx_payments LIMIT 1
		`;
		result.siwx = 'reachable';
	} catch {
		result.siwx = 'unavailable';
	}

	// Ring spend status — surface whether the autonomous closed-loop spend path is
	// live as a dashboard field, so a fail-closed guard (or a deliberate pause) is
	// visible here instead of only as recurring cron error logs. checkRingInvariants
	// is a pure env read (no I/O); no key material is exposed, only flag names.
	// `paused` reflects the existing kill switch (X402_AUTONOMOUS_ENABLED=false),
	// which the loop honors before the guard check — a deliberate pause reads as
	// paused here, not as a violation.
	try {
		const { checkRingInvariants } = await import('./_lib/x402/ring-allowlist.js');
		const inv = checkRingInvariants();
		const paused = process.env.X402_AUTONOMOUS_ENABLED === 'false';
		result.ring = {
			spend_enabled: inv.ok && !paused,
			paused,
			violations: paused ? [] : inv.violations.map((v) => v.flag),
		};
	} catch {
		result.ring = { spend_enabled: false, status: 'unavailable' };
	}

	_x402Cache = { value: result, expiresAt: now + CACHE_TTL_MS };
	return result;
}

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS', origins: '*' })) return;
	if (!method(req, res, ['GET'])) return;

	const uptimeMs = Date.now() - STARTED_AT;
	const [resend, x402, monitorBlock, subsystems] = await Promise.all([
		probeResend(),
		probeX402(),
		probeMonitor(),
		probeSubsystems(),
	]);
	return json(res, 200, {
		// Top-level liveness stays 'ok' (this function answering IS liveness); the
		// `subsystems` block carries the real health verdict so a degraded
		// dependency is visible without ever making the liveness probe flap.
		status: 'ok',
		service: '3d-agent',
		version: VERSION,
		uptime: Math.floor(uptimeMs / 1000),
		uptimeMs,
		resend,
		x402,
		// Real bot/monitor status for the pump-dashboard stat cards (see
		// probeMonitor). Falls back to serverless liveness when no worker
		// heartbeat exists or the DB is unreachable.
		monitor: monitorBlock.monitor,
		watches: monitorBlock.watches,
		// Live internal-dependency health: the exact degradation the reachability
		// probe can't see (Redis on memory-fallback, ring half-armed, Helius
		// throttled, DB slow, world unprotected). See api/_lib/ops/subsystem-health.js.
		subsystems,
		// Productized speech package (api/v1/ai/tts, api/v1/ai/asr). Honest env-gate
		// status so a missing NVIDIA key shows here instead of only surfacing as a
		// 503 on the endpoint. Sync env reads — no upstream probe, no key material.
		speech: {
			tts: { configured: nvidiaTtsConfigured(), route: '/api/v1/ai/tts', requires: ['NVIDIA_API_KEY'] },
			asr: {
				configured: nvidiaAsrConfigured(),
				route: '/api/v1/ai/asr',
				requires: ['NVIDIA_API_KEY', 'NVIDIA_ASR_FUNCTION_ID'],
			},
		},
		// The real-time ops alert channel (api/_lib/alerts.js). It is a deliberate
		// silent no-op when unconfigured, so dev and tests need no secrets — but
		// that same silence in production means every 5xx report, browser-error
		// report, ring-leak CRITICAL, and low-balance warning goes nowhere with no
		// indication anything is wrong. Surface the gate here so a missing channel
		// is visible on the dashboard instead of only discoverable by reading code.
		alerts: {
			configured: alertsConfigured(),
			channel: 'telegram',
			requires: ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_ALERTS_CHAT_ID'],
			...(alertsConfigured() ? {} : {
				warning: 'ops alerts are a silent no-op — sendOpsAlert() calls (5xx faults, client errors, ring leaks, low-balance) are dropped',
			}),
		},
	}, { 'cache-control': 'public, max-age=2, s-maxage=2' });
});
