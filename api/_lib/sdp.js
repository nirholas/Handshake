// Shared client for the Solana Developer Platform (SDP) — the Solana
// Foundation's enterprise API for custodial wallets, SPL token issuance,
// payments, and compliance screening (https://platform.solana.com).
//
// Keeps SDP_API_KEY server-side and returns parsed JSON. Throws an Error
// tagged with { status, code, detail } so proxy/handlers map upstream
// failures to the right HTTP code without leaking the key. Never fabricates
// data — upstream errors surface verbatim.
//
// Auth: project-scoped API key in the Authorization header (Bearer). The
// `/health` and `/openapi.json` surfaces need no key, so health checks work
// even on a deployment that hasn't been wired with credentials yet.

// Production API host. Override with SDP_API_BASE to point at the sandbox or a
// self-hosted deployment (the SDP API is a Cloudflare Worker — see
// solana-foundation/solana-developer-platform). Sandbox vs. production is
// otherwise selected by which API key you use; the wire surface is identical.
const DEFAULT_BASE = 'https://api.solana.com';

// Versioned API segments the proxy is willing to forward (everything under
// `/v1`). The list mirrors the SDP Hono router's v1 mounts so we never forward
// to a path the upstream doesn't serve — and so this can't be turned into an
// open proxy to arbitrary hosts/paths. Keep in sync with the upstream
// `apps/sdp-api/src/app.ts` router.
export const SDP_V1_RESOURCES = Object.freeze([
	'organizations',
	'api-keys',
	'counterparties',
	'members',
	'auth',
	'projects',
	'rpc',
	'issuance',
	'wallets',
	'onboarding',
	'payments',
	'compliance',
]);

// Top-level (un-versioned) paths the upstream serves directly. `health` and
// `openapi.json` are unauthenticated; `llms.txt` is the machine-readable doc.
export const SDP_TOP_LEVEL = Object.freeze(['health', 'openapi.json', 'llms.txt']);

export function sdpConfigured() {
	return !!process.env.SDP_API_KEY;
}

export function sdpBase() {
	const raw = process.env.SDP_API_BASE || DEFAULT_BASE;
	return raw.replace(/\/+$/, '');
}

// True when `path` (no leading slash, no query) is a surface the upstream
// actually serves. Used by the proxy allowlist.
export function isSdpAllowedPath(path) {
	const clean = String(path || '').replace(/^\/+/, '');
	if (!clean || clean.includes('..')) return false;
	if (SDP_TOP_LEVEL.includes(clean)) return true;
	if (clean === 'health/ready') return true;
	if (clean.startsWith('v1/')) {
		const resource = clean.slice(3).split('/')[0];
		return SDP_V1_RESOURCES.includes(resource);
	}
	return false;
}

// Whether a given SDP path requires our server-side API key. Health and the
// public doc/spec surfaces don't, so they stay reachable on an unconfigured
// deployment (returning the upstream's real status rather than a fake 503).
export function sdpPathNeedsKey(path) {
	const clean = String(path || '').replace(/^\/+/, '');
	if (clean === 'health' || clean === 'health/ready') return false;
	if (clean === 'openapi.json' || clean === 'llms.txt') return false;
	return true;
}

// Core request. Returns { status, headers, body } where body is parsed JSON
// when the upstream sends JSON, otherwise the raw text. Throws (tagged with
// { status }) only on transport failure or missing-credential — HTTP error
// statuses from the upstream are returned, not thrown, so the proxy can relay
// the upstream's own error envelope and status code faithfully.
export async function sdpRequest(
	path,
	{ method = 'GET', query, body, headers = {}, timeoutMs = 15_000 } = {},
) {
	const clean = String(path || '').replace(/^\/+/, '');
	if (!isSdpAllowedPath(clean)) {
		throw Object.assign(new Error(`SDP path not allowed: ${clean}`), { status: 404 });
	}

	const needsKey = sdpPathNeedsKey(clean);
	const apiKey = process.env.SDP_API_KEY;
	if (needsKey && !apiKey) {
		throw Object.assign(
			new Error('Solana Developer Platform is not configured (set SDP_API_KEY)'),
			{ status: 503 },
		);
	}

	let url = `${sdpBase()}/${clean}`;
	if (query && typeof query === 'object') {
		const qs = new URLSearchParams();
		for (const [k, v] of Object.entries(query)) {
			if (v != null && v !== '') qs.set(k, String(v));
		}
		const s = qs.toString();
		if (s) url += `?${s}`;
	}

	const reqHeaders = { accept: 'application/json', ...headers };
	// Only the privileged routes carry our key. The public doc/health surfaces
	// are reachable unauthenticated, so attributing those fetches to our org key
	// would let an anonymous caller burn our upstream quota for nothing.
	if (needsKey && apiKey) reqHeaders.authorization = `Bearer ${apiKey}`;

	const init = { method, headers: reqHeaders, signal: AbortSignal.timeout(timeoutMs) };
	if (body != null && method !== 'GET' && method !== 'HEAD') {
		init.body = typeof body === 'string' ? body : JSON.stringify(body);
		reqHeaders['content-type'] = 'application/json';
	}

	let upstream;
	try {
		upstream = await fetch(url, init);
	} catch (e) {
		const reason = e?.name === 'TimeoutError' ? 'timed out' : e?.message || 'unreachable';
		throw Object.assign(new Error(`Solana Developer Platform ${reason}`), { status: 504 });
	}

	const ct = upstream.headers.get('content-type') || '';
	const raw = await upstream.text();
	let parsed = raw;
	if (ct.includes('application/json') && raw) {
		try {
			parsed = JSON.parse(raw);
		} catch {
			parsed = raw;
		}
	}

	return {
		status: upstream.status,
		contentType: ct,
		traceId: upstream.headers.get('x-sdp-trace-id') || null,
		body: parsed,
	};
}

// Convenience wrapper that throws on any non-2xx, surfacing the upstream's
// structured error ({ error: { code, message } }). Use from server-side code
// that wants a value-or-throw contract rather than the raw envelope.
export async function sdpCall(path, opts = {}) {
	const res = await sdpRequest(path, opts);
	if (res.status >= 200 && res.status < 300) return res.body;
	const err = res.body?.error;
	const message = err?.message || (typeof res.body === 'string' ? res.body : 'request failed');
	throw Object.assign(new Error(`SDP ${res.status}: ${String(message).slice(0, 300)}`), {
		status: res.status,
		code: err?.code || 'sdp_error',
		traceId: res.traceId,
	});
}

// ── Typed helpers for the common surfaces ────────────────────────────────────

export function sdpHealth() {
	return sdpCall('health');
}

export function sdpListWallets(query) {
	return sdpCall('v1/wallets', { query });
}

export function sdpGetWallet(walletId) {
	return sdpCall(`v1/wallets/${encodeURIComponent(walletId)}`);
}

export function sdpCreateWallet(payload, idempotencyKey) {
	return sdpCall('v1/wallets', {
		method: 'POST',
		body: payload,
		headers: idempotencyKey ? { 'idempotency-key': idempotencyKey } : {},
	});
}

export function sdpListTokens(query) {
	return sdpCall('v1/issuance/tokens', { query });
}

export function sdpCreateToken(payload, idempotencyKey) {
	return sdpCall('v1/issuance/tokens', {
		method: 'POST',
		body: payload,
		headers: idempotencyKey ? { 'idempotency-key': idempotencyKey } : {},
	});
}

export function sdpListTransfers(query) {
	return sdpCall('v1/payments/transfers', { query });
}

export function sdpCreateTransfer(payload, idempotencyKey) {
	return sdpCall('v1/payments/transfers', {
		method: 'POST',
		body: payload,
		headers: idempotencyKey ? { 'idempotency-key': idempotencyKey } : {},
	});
}

// Screen a Solana address against the SDP compliance providers.
// payload: { address, network?, intent? }.
export function sdpScreenAddress(payload) {
	return sdpCall('v1/compliance/address-screenings', { method: 'POST', body: payload });
}
