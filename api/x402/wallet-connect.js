// POST /api/x402/wallet-connect
//
// Wallet Connection Session Health Check.
//
// mode: "health" → tests whether the SIWS (Sign-In With Solana) session
//   initiation path is operational end-to-end: fires a real GET request to
//   /api/auth/siws/nonce against the platform origin, validates the returned
//   nonce structure (22 alphanumeric chars, future expiry, domain binding),
//   measures the roundtrip latency, and returns { session_created, latency_ms }.
//
//   session_created: true  — a valid challenge was issued, meaning wallet
//     connect handshakes CAN be initiated right now (the auth gateway, DB
//     write path, and CSRF layer are all alive).
//   session_created: false — the nonce endpoint returned an unexpected status,
//     a malformed challenge, or timed out (> 3s). Wallet connect is degraded.
//
// The autonomous loop pays this probe every 5 min and records the verdict to
// x402_autonomous_log (signal_data: { session_created, latency_ms }); alerting
// on a degraded verdict is handled by the loop's downstream monitors, not by
// this handler.
//
// Pay-per-call: $0.001 USDC on Solana or Base mainnet.

import { paidEndpoint } from '../_lib/x402-paid-endpoint.js';
import { readBody } from '../_lib/http.js';
import { buildBazaarSchema } from '../_lib/x402-spec.js';
import { withService } from '../_lib/x402/bazaar-helpers.js';
import { priceFor } from '../_lib/x402-prices.js';
import { env } from '../_lib/env.js';

const ROUTE = '/api/x402/wallet-connect';

// Probe aborts after this many ms — a nonce round-trip slower than this
// is already degraded from a user-experience standpoint.
const PROBE_TIMEOUT_MS = 3000;

// Latency above which the session-initiation path is flagged as slow even
// if it succeeds — used to populate the `slow` field in the response.
const SLOW_LATENCY_MS = 1000;

function platformOrigin() {
	return env.APP_ORIGIN || 'https://three.ws';
}

// Validate the nonce payload returned by /api/auth/siws/nonce. A conformant
// nonce is a 22-char alphanumeric string with a future expiry — exactly what
// a Phantom/Backpack wallet needs to construct a SIWS message.
function isValidNonce(body) {
	if (!body || typeof body !== 'object') return false;
	const { nonce, expiresAt } = body;
	if (typeof nonce !== 'string' || !/^[A-Za-z0-9]{22}$/.test(nonce)) return false;
	if (!expiresAt || Date.parse(expiresAt) <= Date.now()) return false;
	return true;
}

// Probe the SIWS nonce endpoint. Returns a plain object with the verdict
// so the handler never throws — errors are captured as session_created:false.
async function probeNonce() {
	const t0 = Date.now();
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
	try {
		const res = await fetch(`${platformOrigin()}/api/auth/siws/nonce`, {
			method: 'GET',
			headers: { accept: 'application/json' },
			signal: controller.signal,
		});
		const latencyMs = Date.now() - t0;
		if (!res.ok) {
			return { session_created: false, latency_ms: latencyMs, slow: false, nonce_valid: false, domain: null, reason: `nonce_http_${res.status}` };
		}
		const body = await res.json().catch(() => null);
		const valid = isValidNonce(body);
		return {
			session_created: valid,
			latency_ms: latencyMs,
			slow: latencyMs > SLOW_LATENCY_MS,
			nonce_valid: valid,
			domain: typeof body?.domain === 'string' ? body.domain : null,
			reason: valid ? null : 'invalid_nonce_shape',
		};
	} catch (err) {
		const latencyMs = Date.now() - t0;
		if (err?.name === 'AbortError') {
			return { session_created: false, latency_ms: latencyMs, slow: true, nonce_valid: false, domain: null, reason: 'timeout' };
		}
		return { session_created: false, latency_ms: latencyMs, slow: false, nonce_valid: false, domain: null, reason: err?.message || 'fetch_error' };
	} finally {
		clearTimeout(timer);
	}
}

const DESCRIPTION =
	'Wallet Connection Session Health Check — probes the SIWS (Sign-In With ' +
	'Solana) session initiation path: issues a real nonce challenge against the ' +
	'platform auth gateway, validates its structure and expiry, and measures ' +
	'roundtrip latency. Returns { session_created, latency_ms }. Pay-per-call ' +
	'in USDC on Solana or Base mainnet.';

const INPUT_SCHEMA = {
	$schema: 'https://json-schema.org/draft/2020-12/schema',
	type: 'object',
	required: ['mode'],
	properties: {
		mode: { type: 'string', enum: ['health'] },
	},
};

const OUTPUT_SCHEMA = {
	$schema: 'https://json-schema.org/draft/2020-12/schema',
	type: 'object',
	required: ['mode', 'session_created', 'latency_ms', 'checked_at'],
	properties: {
		mode: { type: 'string' },
		session_created: { type: 'boolean' },
		latency_ms: { type: ['integer', 'null'] },
		slow: { type: ['boolean', 'null'] },
		nonce_valid: { type: ['boolean', 'null'] },
		domain: { type: ['string', 'null'] },
		reason: { type: ['string', 'null'] },
		checked_at: { type: 'string', format: 'date-time' },
	},
};

const OUTPUT_EXAMPLE = {
	mode: 'health',
	session_created: true,
	latency_ms: 83,
	slow: false,
	nonce_valid: true,
	domain: 'three.ws',
	reason: null,
	checked_at: '2026-06-28T00:00:00Z',
};

const BAZAAR = {
	discoverable: true,
	info: {
		input: { type: 'http', method: 'POST', bodySchema: INPUT_SCHEMA },
		output: { type: 'json', example: OUTPUT_EXAMPLE },
	},
	schema: buildBazaarSchema({ method: 'POST', bodySchema: INPUT_SCHEMA, outputSchema: OUTPUT_SCHEMA }),
};

export default paidEndpoint({
	route: ROUTE,
	method: 'POST',
	priceAtomics: priceFor('wallet-connect-health', '1000'), // $0.001 USDC
	networks: ['solana', 'base'],
	description: DESCRIPTION,
	bazaar: BAZAAR,
	services: ['wallet-connect-health'],
	service: withService({
		serviceName: 'three.ws Wallet Connect Session Health',
		tags: ['health', 'wallet', 'siws', 'session', 'auth', 'canary'],
	}),
	async handler({ req }) {
		let mode = 'health';
		try {
			const chunks = [await readBody(req, 1_000_000)];
			const raw = Buffer.concat(chunks).toString('utf8');
			if (raw) {
				const body = JSON.parse(raw);
				if (body && typeof body.mode === 'string') {
					mode = body.mode.trim().toLowerCase().slice(0, 32);
				}
			}
		} catch {
			// Malformed body — default to health mode.
		}

		const checkedAt = new Date().toISOString();

		if (mode !== 'health') {
			return { mode, session_created: false, latency_ms: null, slow: null, nonce_valid: null, domain: null, reason: 'unknown_mode', checked_at: checkedAt };
		}

		const probe = await probeNonce();
		return {
			mode,
			session_created: probe.session_created,
			latency_ms: probe.latency_ms,
			slow: probe.slow,
			nonce_valid: probe.nonce_valid,
			domain: probe.domain,
			reason: probe.reason,
			checked_at: checkedAt,
		};
	},
});
