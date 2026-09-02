// The second lock on /api/cron/*, applied at the edge before the handler runs.
//
// Cron auth is a per-file inline call to requireCron (api/_lib/cron-auth.js),
// which is correct and fail-closed today: tests/api/cron-auth-sweep.test.js
// invokes all 85 handlers unauthenticated every run and requires a closed
// status from each. But it is a convention, not a mechanism. The server's
// filesystem phase routes every api/cron/*.js file by existing, so ONE future
// handler that forgets the line is directly internet-invokable, and money-moving
// sweeps live in that directory (custody attestation, buybacks, treasury
// top-ups, wallet intents). This layer makes that single omission survivable:
// the request never reaches the handler at all.
//
// Two credentials are accepted, and both stay accepted permanently. This is
// defense in depth, not a migration with a cutover:
//
//   1. CRON_SECRET, exactly as the handlers validate it. The verdict comes from
//      isCronAuthorized() rather than a second comparison written here, so the
//      edge and the handler can never disagree about what a valid secret is.
//   2. A Google-signed OIDC identity token from the Cloud Scheduler service
//      account, which is what `gcloud scheduler jobs update http
//      --oidc-service-account-email` attaches. Unlike a bearer secret this one
//      cannot be replayed off a leaked env dump: it is short-lived, signed by
//      Google, and bound to one audience.
//
// Both halves of the OIDC identity are required, and the email half is the
// load-bearing one: ANY Google service account can mint an ID token for an
// arbitrary audience, so an audience match alone authenticates nobody. The
// token must carry a verified email in CRON_OIDC_SERVICE_ACCOUNT *and* an
// audience in CRON_OIDC_AUDIENCE. With either var unset the OIDC path is off
// and only the secret is accepted.
//
// What this layer must never do is invent a new fail-open. The one case where
// it stands aside is "no credential is configured at all" (no CRON_SECRET, no
// OIDC pair), which is a developer's machine: there the request falls through
// to the handler, whose requireCron answers the single canonical 503
// not_configured. Production, which has CRON_SECRET set, is closed here.

import { createRemoteJWKSet, jwtVerify } from 'jose';
import { isCronAuthorized } from '../api/_lib/cron-auth.js';

// Google's OIDC issuer and its published signing keys. Both spellings of the
// issuer are minted by Google for identity tokens and both are legitimate.
const GOOGLE_JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
const GOOGLE_ISSUERS = ['https://accounts.google.com', 'accounts.google.com'];

const CRON_PREFIX = '/api/cron/';

let _jwks = null;

/** The shared remote key set, created once and cached by jose thereafter. */
function googleJwks() {
	if (!_jwks) {
		_jwks = createRemoteJWKSet(new URL(GOOGLE_JWKS_URL), {
			// A key rotation must not cost every in-flight cron a 5xx, and a
			// hostile caller must not be able to turn unknown `kid`s into an
			// outbound request per attempt. jose's cooldown bounds the refetch
			// rate; the timeout bounds how long a Google blip can hold a request.
			cooldownDuration: 30_000,
			cacheMaxAge: 600_000,
			timeoutDuration: 4_000,
		});
	}
	return _jwks;
}

/** Test hook: forget the cached key set. */
export function _resetCronJwks() {
	_jwks = null;
}

function list(value) {
	return String(value || '')
		.split(',')
		.map((s) => s.trim())
		.filter(Boolean);
}

/**
 * The OIDC half of the gate, read per call so a Cloud Run env update takes
 * effect without a redeploy. `enabled` requires BOTH lists: an audience with no
 * service-account allowlist would accept a token any Google customer can mint.
 */
export function readCronOidcConfig(env = process.env) {
	const audiences = list(env.CRON_OIDC_AUDIENCE);
	const serviceAccounts = list(env.CRON_OIDC_SERVICE_ACCOUNT).map((s) => s.toLowerCase());
	return { audiences, serviceAccounts, enabled: audiences.length > 0 && serviceAccounts.length > 0 };
}

/**
 * The bearer credential, if the request carries one. Returned raw: the caller
 * decides whether it is a secret or a JWT.
 */
function bearer(req) {
	const auth = req.headers?.['authorization'];
	if (typeof auth !== 'string' || !auth.toLowerCase().startsWith('bearer ')) return '';
	return auth.slice(7).trim();
}

/**
 * Three dot-separated non-empty segments. Used only to decide whether a bearer
 * value is worth a signature verification: CRON_SECRET is also a bearer, and
 * running JWKS resolution over every wrong secret would let an unauthenticated
 * flood drive outbound requests.
 */
export function looksLikeJwt(token) {
	const parts = String(token || '').split('.');
	return parts.length === 3 && parts.every((p) => p.length > 0);
}

/**
 * Verify a Google OIDC identity token against the configured audience and
 * service account. Returns the authorized email, or null. Never throws: a
 * malformed token, an expired one, and a Google outage are all "not authorized
 * by this path", and the secret path has already had its turn.
 *
 * `keys` is injectable so tests verify a REAL RS256 signature against a real
 * local key set rather than stubbing the verification away.
 */
export async function verifyCronOidc(token, config, keys = googleJwks()) {
	if (!config.enabled || !looksLikeJwt(token)) return null;
	try {
		const { payload } = await jwtVerify(token, keys, {
			issuer: GOOGLE_ISSUERS,
			audience: config.audiences,
			clockTolerance: 60,
		});
		// Google marks service-account identity tokens email_verified:true. A
		// token without it is not the scheduler and is refused rather than
		// trusted on the email claim alone.
		if (payload.email_verified !== true) return null;
		const email = String(payload.email || '').toLowerCase();
		if (!email || !config.serviceAccounts.includes(email)) return null;
		return email;
	} catch {
		return null;
	}
}

/**
 * The verdict for one request, with no response side effects so it is directly
 * assertable. `allow` true means the request may proceed to its handler, which
 * runs its own requireCron regardless: this layer only ever removes callers.
 *
 * @returns {Promise<{allow: boolean, via: string, status?: number}>}
 */
export async function cronEdgeVerdict(req, { env = process.env, keys } = {}) {
	if (isCronAuthorized(req)) return { allow: true, via: 'cron-secret' };

	const config = readCronOidcConfig(env);
	const email = await verifyCronOidc(bearer(req), config, keys ?? googleJwks());
	if (email) return { allow: true, via: `oidc:${email}` };

	// Nothing configured anywhere: a developer's machine. Let the handler own
	// the 503 so "not configured" has exactly one spelling in the codebase.
	const secretConfigured = Boolean(env.CRON_SECRET);
	if (!secretConfigured && !config.enabled) return { allow: true, via: 'unconfigured' };

	return { allow: false, via: 'none', status: 401 };
}

/** Does this path route into api/cron/? */
export function isCronPath(pathname) {
	return typeof pathname === 'string' && pathname.startsWith(CRON_PREFIX) && pathname.length > CRON_PREFIX.length;
}

/**
 * Express middleware. Mounted before the route table so a rewritten dest cannot
 * carry an unauthenticated caller past it.
 */
export function cronEdgeAuth(options = {}) {
	return async (req, res, next) => {
		let pathname;
		try {
			pathname = new URL(req.url, 'http://internal').pathname;
		} catch {
			next();
			return;
		}
		if (!isCronPath(pathname)) {
			next();
			return;
		}
		let verdict;
		try {
			verdict = await cronEdgeVerdict(req, options);
		} catch (err) {
			// An unexpected fault in the gate itself is not a pass. The handler's
			// own requireCron would still refuse, but a gate that opens when it
			// breaks is not a gate.
			console.error('[cron-edge] verdict failed:', err?.message || err);
			verdict = { allow: false, via: 'error', status: 401 };
		}
		if (verdict.allow) {
			next();
			return;
		}
		res
			.status(verdict.status || 401)
			.set('cache-control', 'no-store')
			.json({ error: 'unauthorized', error_description: 'cron credential required' });
	};
}
