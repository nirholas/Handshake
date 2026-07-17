// Single source of truth for validating + fetching a provider-returned GLB URL
// across every auto-rig / reconstruct completion path: the Replicate webhook,
// the regenerate-status browser poll, the cron sweep, and the rig poller.
//
// Fetching a provider-supplied URL server-side is a classic SSRF sink — a forged
// or compromised provider payload could aim the fetch at cloud metadata
// (169.254.169.254), loopback, or an RFC1918 address, and the server would
// dutifully connect. Two layers defend it, and BOTH are always applied because
// neither alone is sufficient:
//
//   1. NARROW positive host allowlist (isAllowedProviderResultUrl): the URL must
//      be https on a host a provider actually serves results from, or on our own
//      R2/CDN public domain (the bare "unrigged" mesh the rig poller re-fetches,
//      which we wrote ourselves via publicUrl()).
//   2. BROAD negative SSRF guard (ssrf-guard.js): even an allowlisted host could
//      be DNS-poisoned or 30x-redirected toward a private IP, so the fetch
//      resolves + IP-pins the connection and re-validates every redirect hop.
//
// All IP/DNS/redirect logic lives in ssrf-guard.js — this module only adds the
// provider-host allowlist, the GLB-URL extraction, and the size ceiling on top.

import { env } from './env.js';
import { fetchSafePublicUrlPinned, SsrfBlockedError } from './ssrf-guard.js';

// Re-export so every caller imports the single error class from one place and
// the boundary catches can `instanceof`/`code === 'ssrf_blocked'` uniformly.
export { SsrfBlockedError };

// 64 MB ceiling on a fetched model — the ONE definition, shared by
// reconstruct-finalize.js and auto-rig.js (which each used to declare their own).
export const MAX_GLB_BYTES = 64 * 1024 * 1024;

// Per-request timeout so a hung provider host can't wedge a serverless
// invocation for its full max duration. Honored by fetchSafePublicUrlPinned via
// the AbortSignal we pass below.
const FETCH_TIMEOUT_MS = 30_000;

// Hosts a provider serves rigged/reconstructed GLBs from. Replicate delivers
// prediction outputs from these (pbxt.replicate.delivery is its CDN edge).
// Seeded from the webhook's original REPLICATE_RESULT_HOSTS. Our own R2/CDN
// public host is allowed too, but resolved at call time from env (see
// ownPublicHost) rather than hardcoded here.
export const PROVIDER_RESULT_HOSTS = [
	'replicate.delivery',
	'replicate.com',
	'pbxt.replicate.delivery',
];

// Our own R2/CDN public host is ALSO a legitimate provider-result source: the
// rig poller re-fetches the bare "unrigged" mesh we stored via publicUrl()
// (reconstruct-finalize's rig.unriggedUrl) through this same guarded helper.
// It's first-party, but routing every provider-result fetch through one path
// keeps the audit single-file, so its host must be allowlisted as well.
//
// Derived lazily from S3_PUBLIC_DOMAIN — accessing it via env throws when storage
// isn't configured, so resolving at call time (and swallowing the throw) keeps
// importing this module side-effect-free and lets a deployment without storage
// still load it. The IP guard in fetchProviderGlbBuffer still applies after this
// host check, so allowing our CDN host never opens a private-range hole.
function ownPublicHost() {
	try {
		const raw = env.S3_PUBLIC_DOMAIN; // throws when S3_PUBLIC_DOMAIN is unset
		if (!raw) return null;
		const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
		return new URL(withScheme).hostname.toLowerCase();
	} catch {
		return null;
	}
}

// Our own GPU workers (the `gcp` provider: avatar-reconstruction, unirig,
// remesh, stylize, model-*) upload their result GLBs to Cloud Storage and
// report plain `https://storage.googleapis.com/<bucket>/<object>` URLs. The
// host alone is NOT a safe allowlist entry: anyone can create a GCS bucket, so
// accepting the whole host would let a forged payload aim the fetch at an
// attacker-controlled object. Pin acceptance to OUR buckets (env
// GCS_RESULT_BUCKETS), matching both URL styles GCS serves:
//   path style:            https://storage.googleapis.com/<bucket>/<object>
//   virtual-hosted style:  https://<bucket>.storage.googleapis.com/<object>
function isOwnGcsResultUrl(u) {
	let buckets;
	try {
		buckets = env.GCS_RESULT_BUCKETS;
	} catch {
		return false;
	}
	if (!buckets?.length) return false;
	const host = u.hostname.toLowerCase();
	if (host === 'storage.googleapis.com') {
		const bucket = u.pathname.split('/').filter(Boolean)[0] ?? '';
		return buckets.includes(bucket);
	}
	if (host.endsWith('.storage.googleapis.com')) {
		return buckets.includes(host.slice(0, -'.storage.googleapis.com'.length));
	}
	return false;
}

// Narrow positive gate — exactly the webhook's original semantics: parse, require
// https, lowercase the host, and accept an exact or `.`-suffix match against the
// allowed hosts (the provider delivery hosts ∪ our own CDN host). Never throws;
// returns a boolean so callers can branch. The broad SSRF guard in
// fetchProviderGlbBuffer is the layer that throws.
export function isAllowedProviderResultUrl(raw) {
	let u;
	try {
		u = new URL(raw);
	} catch {
		return false;
	}
	if (u.protocol !== 'https:') return false;
	if (isOwnGcsResultUrl(u)) return true;
	const host = u.hostname.toLowerCase();
	const own = ownPublicHost();
	const allowed = own ? [...PROVIDER_RESULT_HOSTS, own] : PROVIDER_RESULT_HOSTS;
	return allowed.some((h) => host === h || host.endsWith(`.${h}`));
}

const HTTP_URL = /^https?:\/\//i;

// Pull a GLB URL out of a provider's prediction output, returning ONLY a string
// that is itself an http(s) URL. EVERY branch validates the scheme so a hostile
// output field — e.g. output: "file:///etc/passwd", { url: "gopher://x" }, a bare
// number, or { url: 169 } — can never become a fetch target. Non-string, empty,
// or non-http(s) input returns null. (The host allowlist + IP guard then reject
// anything that isn't on a trusted provider host.)
export function extractGlbUrl(output) {
	if (!output) return null;
	if (typeof output === 'string') {
		return HTTP_URL.test(output) ? output : null;
	}
	if (Array.isArray(output)) {
		// Prefer an explicit .glb, but only ever return an http(s) entry.
		for (const v of output) {
			if (typeof v === 'string' && HTTP_URL.test(v) && /\.glb(\?|$)/i.test(v)) return v;
		}
		for (const v of output) {
			if (typeof v === 'string' && HTTP_URL.test(v)) return v;
		}
		return null;
	}
	if (typeof output === 'object') {
		for (const key of ['glb', 'mesh', 'mesh_url', 'output_url', 'url', 'model']) {
			const v = output[key];
			if (typeof v === 'string' && HTTP_URL.test(v)) return v;
		}
	}
	return null;
}

// Throw when a URL isn't on an allowed provider host. Returns the raw string on
// success so callers can chain. Uses the shared SsrfBlockedError so the boundary
// catch in each completion path treats it identically to an ssrf-guard rejection
// (code === 'ssrf_blocked', status 400).
export function assertProviderResultUrl(raw) {
	if (!isAllowedProviderResultUrl(raw)) {
		throw new SsrfBlockedError('result url not on an allowed provider host');
	}
	return raw;
}

// The ONE place provider GLB bytes are fetched. Layers the host allowlist over
// the IP-pinned SSRF guard, enforces the 64 MB ceiling on both the advertised
// content-length and the actual body, and times out a hung host. The response is
// stored in R2 / forwarded downstream, so the PINNED variant is used — it
// connects to exactly the vetted IP (closing the DNS-rebinding window) and
// re-validates every redirect hop, matching ssrf-guard.js's own guidance for
// forwarded fetches. Error messages match the prior bare-fetch helpers
// (`fetch glb: <status>`, `glb too large: <n> bytes`) so existing logs/paths
// don't churn.
export async function fetchProviderGlbBuffer(url, { maxBytes = MAX_GLB_BYTES } = {}) {
	assertProviderResultUrl(url); // host allowlist — throws SsrfBlockedError before any socket
	// Pass maxBytes INTO the fetch so the ceiling is enforced while streaming — the
	// request is torn down the instant the body exceeds it, keeping peak memory
	// bounded. The post-fetch checks below remain as defense-in-depth (they now only
	// ever fire if a future refactor drops the streaming cap).
	const resp = await fetchSafePublicUrlPinned(
		url,
		{ signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) },
		{ allowHttp: false, maxBytes },
	);
	if (!resp.ok) throw new Error(`fetch glb: ${resp.status}`);
	const len = Number(resp.headers.get('content-length') || 0);
	if (len && len > maxBytes) throw new Error(`glb too large: ${len} bytes`);
	const buf = Buffer.from(await resp.arrayBuffer());
	if (buf.length > maxBytes) throw new Error(`glb too large: ${buf.length} bytes`);
	return buf;
}
