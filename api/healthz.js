// GET /api/healthz
// ----------------
// Lightweight liveness/readiness endpoint. Returns 200 with uptime + a small
// summary block compatible with the pump-dashboard's API status panel.
//
// Intentionally has no DB / RPC dependencies — this should stay green even
// when downstream systems are degraded so it's safe to wire to uptime probes.

import { cors, json, method, wrap } from './_lib/http.js';
import { countRecentPayments } from './_lib/x402/audit-log.js';

const STARTED_AT = Date.now();
const VERSION = process.env.VERCEL_GIT_COMMIT_SHA || process.env.npm_package_version || 'dev';

const CACHE_TTL_MS = 5 * 60 * 1000;
const RESEND_CACHE_TTL_MS = CACHE_TTL_MS;
let _resendCache = { value: null, expiresAt: 0 };
let _x402Cache = { value: null, expiresAt: 0 };

// Exported for tests so each case starts with a cold cache.
export function _resetResendCache() {
	_resendCache = { value: null, expiresAt: 0 };
}
export function _resetX402Cache() {
	_x402Cache = { value: null, expiresAt: 0 };
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

	// Check if PAY_TO addresses are configured
	const hasBase = !!process.env.X402_PAY_TO_BASE;
	const hasSolana = !!process.env.X402_PAY_TO_SOLANA || !!process.env.X402_PAY_TO;
	result.configured = hasBase || hasSolana;
	result.networks = [];
	if (hasBase) result.networks.push('base');
	if (hasSolana) result.networks.push('solana');

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

	// Recent payments from audit log
	result.recent_payments = await countRecentPayments(60);

	// SIWX reachability (just check if the table exists)
	try {
		const rows = await (await import('./_lib/db.js')).sql`
			SELECT 1 FROM siwx_payments LIMIT 1
		`;
		result.siwx = 'reachable';
	} catch {
		result.siwx = 'unavailable';
	}

	_x402Cache = { value: result, expiresAt: now + CACHE_TTL_MS };
	return result;
}

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS', origins: '*' })) return;
	if (!method(req, res, ['GET'])) return;

	const uptimeMs = Date.now() - STARTED_AT;
	const [resend, x402] = await Promise.all([probeResend(), probeX402()]);
	return json(res, 200, {
		status: 'ok',
		service: '3d-agent',
		version: VERSION,
		uptime: Math.floor(uptimeMs / 1000),
		uptimeMs,
		resend,
		x402,
		// Match the pump-dashboard health shape so the existing UI binding works
		// without conditional logic.
		monitor: { running: true, mode: 'serverless', claimsDetected: 0 },
		watches: { total: 0, active: 0 },
	}, { 'cache-control': 'public, max-age=2, s-maxage=2' });
});
