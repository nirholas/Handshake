// Shared Google Cloud OAuth 2.0 access-token minting for every Vertex AI client.
//
// One service account, one token cache, used by both the Imagen text-to-image
// client (api/_mcp3d/vertex-imagen.js) and the Vertex Claude LLM transport
// (api/_lib/vertex-claude.js). Extracted so the JWT→OAuth exchange, the
// forgiving service-account-JSON parser, and the token cache live in exactly
// one place instead of being copied per Vertex surface.
//
// Two auth paths, in priority order:
//   1. GCP_SERVICE_ACCOUNT_JSON  — service account JSON string (Vercel-friendly)
//   2. Metadata server           — works on Cloud Run / GCE with attached SA
//
// The exchange uses the Web Crypto API (crypto.subtle), so it runs unchanged on
// Node 18+ and the Vercel edge runtime — no `google-auth-library` dependency.
//
// Never log the returned token or any service-account material.

import { fetchUpstream } from './upstream-fetch.js';

function readEnv(name) {
	if (typeof process !== 'undefined' && process.env?.[name]) return process.env[name];
	return null;
}

// Tokens are cached in-process so the token endpoint is not hit on every
// request. A refresh is attempted REFRESH_AHEAD_S before the token expires; if
// that refresh fails (the metadata server or oauth2.googleapis.com blipping)
// the cached token keeps being served while it still has more than
// HARD_MARGIN_S of validity left, so a token-endpoint outage never takes every
// Vertex call down for the four minutes a perfectly good token remains usable.
// The cloud-platform scope is broad enough to cover both Imagen (:predict) and
// Claude (:rawPredict / :streamRawPredict).
const REFRESH_AHEAD_S = 300;
const HARD_MARGIN_S = 60;
const _tokenCache = { token: null, refreshAt: 0, expiresAt: 0 };

function rememberToken(token, expiresInSeconds, now = Date.now()) {
	const ttlMs = Number(expiresInSeconds) * 1000;
	_tokenCache.token = token;
	_tokenCache.expiresAt = now + ttlMs - HARD_MARGIN_S * 1000;
	_tokenCache.refreshAt = Math.min(_tokenCache.expiresAt, now + ttlMs - REFRESH_AHEAD_S * 1000);
	return token;
}

/** Test hook: forget the cached token. */
export function _resetGcpTokenCache() {
	_tokenCache.token = null;
	_tokenCache.refreshAt = 0;
	_tokenCache.expiresAt = 0;
}

// Obtain a Google OAuth 2.0 access token, cached until shortly before expiry.
// Throws an error with code:'unconfigured' when no credentials are available so
// callers can branch to a fallback provider instead of hard-failing.
export async function getGcpAccessToken() {
	const now = Date.now();
	if (_tokenCache.token && now < _tokenCache.refreshAt) {
		return _tokenCache.token;
	}
	try {
		return await _mintToken(now);
	} catch (err) {
		if (err?.code === 'unconfigured') throw err;
		if (_tokenCache.token && Date.now() < _tokenCache.expiresAt) {
			const leftS = Math.round((_tokenCache.expiresAt - Date.now()) / 1000);
			console.warn(`[gcp-auth] token refresh failed (${err?.message || err}); serving the cached token for up to ${leftS}s more`);
			return _tokenCache.token;
		}
		throw err;
	}
}

async function _mintToken(now) {
	const saJson = readEnv('GCP_SERVICE_ACCOUNT_JSON');
	if (saJson && saJson.trim() && saJson.trim() !== '""') {
		return _tokenFromServiceAccount(parseServiceAccount(saJson));
	}

	// Fall back to the metadata server (Cloud Run / GCE).
	// The metadata server answers in milliseconds on GCP and does not exist
	// anywhere else: a short timeout keeps a local/dev boot from hanging on DNS.
	// Three bounded attempts ride out the momentary 5xx it returns under a
	// credential rotation; a host where it does not exist fails fast on DNS.
	let metaErr = null;
	const metaRes = await fetchUpstream(
		'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token',
		{ headers: { 'Metadata-Flavor': 'Google' } },
		{ name: 'gcp-metadata-token', timeoutMs: 3_000, attempts: 3 },
	).catch((err) => {
		metaErr = err;
		return null;
	});

	if (metaRes?.ok) {
		const data = await metaRes.json();
		return rememberToken(data.access_token, data.expires_in, now);
	}

	// A metadata server that answered before (a token is cached) but failed now
	// is an outage, not a misconfiguration: surface it so the stale-token grace
	// applies instead of the unconfigured branch.
	if (_tokenCache.token && metaErr) {
		throw Object.assign(new Error(`GCP metadata token refresh failed: ${metaErr.message}`), { code: 'metadata_unavailable' });
	}
	throw Object.assign(
		new Error('No GCP credentials found. Set GCP_SERVICE_ACCOUNT_JSON or run on GCE/Cloud Run.'),
		{ code: 'unconfigured' },
	);
}

// Escape raw control characters (newline, carriage return, tab) that appear
// *inside* JSON string literals, leaving structural whitespace and already-
// escaped sequences untouched. Walks the string tracking in-string state so it
// never mangles the JSON between tokens. Lets a multi-line key-file paste parse.
function escapeJsonControlChars(s) {
	let out = '';
	let inString = false;
	let escaped = false;
	for (let i = 0; i < s.length; i++) {
		const ch = s[i];
		if (escaped) {
			out += ch;
			escaped = false;
			continue;
		}
		if (ch === '\\') {
			out += ch;
			escaped = true;
			continue;
		}
		if (ch === '"') {
			inString = !inString;
			out += ch;
			continue;
		}
		if (inString && ch === '\n') out += '\\n';
		else if (inString && ch === '\r') out += '\\r';
		else if (inString && ch === '\t') out += '\\t';
		else out += ch;
	}
	return out;
}

// Service-account JSON pasted into a secrets UI routinely arrives mangled:
// wrapped in an extra layer of quotes, with escaped inner quotes (`{\"type\"…}`),
// or base64-encoded. Accept every common mangling; reject with a designed
// `unconfigured` error (instead of a raw JSON.parse crash) so callers can branch
// to a fallback provider.
export function parseServiceAccount(raw) {
	let v = raw.trim();
	if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
		v = v.slice(1, -1).trim();
	}
	const candidates = [v, v.replace(/\\"/g, '"')];
	// A multi-line paste of the raw key file leaves literal newlines/tabs/CRs
	// *inside* the private_key string — valid in a file, but `JSON.parse` rejects
	// raw control characters in a string literal ("Bad control character"). Add a
	// candidate that escapes only those control chars so the paste parses cleanly.
	candidates.push(escapeJsonControlChars(v), escapeJsonControlChars(v.replace(/\\"/g, '"')));
	if (/^[A-Za-z0-9+/=\s]+$/.test(v)) {
		try {
			candidates.push(Buffer.from(v, 'base64').toString('utf8'));
		} catch {
			// not base64 — fall through to the error below
		}
	}
	for (const candidate of candidates) {
		try {
			const sa = JSON.parse(candidate);
			if (sa && typeof sa === 'object' && sa.client_email && sa.private_key) return sa;
		} catch {
			// try the next decoding
		}
	}
	throw Object.assign(
		new Error(
			'GCP_SERVICE_ACCOUNT_JSON is set but is not a valid service-account JSON object (expected client_email + private_key). Re-paste the raw key file contents.',
		),
		{ code: 'unconfigured' },
	);
}

async function _tokenFromServiceAccount(sa) {
	// Build a JWT for the service account and exchange it for an access token.
	// Uses the Web Crypto API (available in Node 18+ and the Vercel edge runtime).
	const now = Math.floor(Date.now() / 1000);
	const header = { alg: 'RS256', typ: 'JWT' };
	const payload = {
		iss: sa.client_email,
		scope: 'https://www.googleapis.com/auth/cloud-platform',
		aud: 'https://oauth2.googleapis.com/token',
		iat: now,
		exp: now + 3600,
	};

	const b64url = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
	const signingInput = `${b64url(header)}.${b64url(payload)}`;

	// Import the RSA private key.
	const keyData = sa.private_key
		.replace(/-----BEGIN PRIVATE KEY-----/, '')
		.replace(/-----END PRIVATE KEY-----/, '')
		.replace(/\s/g, '');
	const keyBuffer = Buffer.from(keyData, 'base64');

	const cryptoKey = await crypto.subtle.importKey(
		'pkcs8',
		keyBuffer,
		{ name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
		false,
		['sign'],
	);

	const sigBuffer = await crypto.subtle.sign(
		'RSASSA-PKCS1-v1_5',
		cryptoKey,
		Buffer.from(signingInput),
	);
	const sig = Buffer.from(sigBuffer).toString('base64url');
	const jwt = `${signingInput}.${sig}`;

	// 8s per attempt, three attempts with jittered backoff on 429/5xx/network.
	// A 4xx is a definitive answer about the assertion (bad key, disabled
	// account) and is surfaced at once rather than retried into a quota.
	const tokenRes = await fetchUpstream('https://oauth2.googleapis.com/token', {
		method: 'POST',
		headers: { 'content-type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams({
			grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
			assertion: jwt,
		}),
	}, {
		name: 'google-oauth',
		timeoutMs: 8_000,
		attempts: 3,
		okWhen: (res) => res.ok || (res.status < 500 && res.status !== 429),
	}).catch((err) => {
		throw new Error(`GCP token exchange failed: ${err?.body || err?.message || err}`);
	});

	if (!tokenRes.ok) {
		const err = await tokenRes.text().catch(() => tokenRes.status);
		throw new Error(`GCP token exchange failed: ${err}`);
	}

	const data = await tokenRes.json();
	return rememberToken(data.access_token, data.expires_in);
}

// True when a service-account credential is present in the environment. Cloud
// Run / GCE metadata-server auth is not detectable synchronously, so this only
// reflects the explicit-credential path.
export function gcpAuthConfigured() {
	const saJson = readEnv('GCP_SERVICE_ACCOUNT_JSON');
	return Boolean(saJson && saJson.trim() && saJson.trim() !== '""');
}
