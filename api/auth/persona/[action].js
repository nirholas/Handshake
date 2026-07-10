// /api/auth/persona/<action> — Persona Hub token issuance + verification.
//
// Persona Hub is three.ws's cross-app SSO: a user creates and stores their
// three.ws avatar once, and any tenant site embedding the `<three-ws-signin>`
// widget can request a short-lived token bearing that avatar's URL.
//
// Endpoints
// ─────────
//   POST /api/auth/persona/issue
//     Body: { tenant_origin: string, avatar_id?: string }
//     Auth: three.ws session (user must be signed in to three.ws)
//     Returns: { token, expires_in, avatar: { id, url, thumbnail_url, name } }
//
//     The token is a JWT signed with JWT_SECRET, audience set to the tenant
//     origin so the tenant can call /api/auth/persona/verify with that
//     audience and trust the result. Claims:
//       sub:       three.ws user id
//       aud:       tenant_origin
//       iss:       https://three.ws
//       scope:     "persona:read avatar:read"
//       token_use: "persona"
//       avatar:    { id, url, thumbnail_url, name }
//
//   GET /api/auth/persona/verify?token=…&audience=…
//     Unauthenticated. Verifies signature + issuer + audience + expiry.
//     Returns the claims if valid, 401 otherwise. Tenants call this from
//     their server to confirm the popup-issued token is real.
//
//   GET /api/auth/persona/me
//     Auth: three.ws session.
//     Returns the user's avatar catalog so the consent UI can render a
//     picker without a second round trip.

import { SignJWT, jwtVerify, importPKCS8, importSPKI, exportJWK } from 'jose';
import { getSessionUser } from '../../_lib/auth.js';
import { sql } from '../../_lib/db.js';
import { env } from '../../_lib/env.js';
import { publicUrl, thumbnailUrl } from '../../_lib/r2.js';
import { randomToken } from '../../_lib/crypto.js';
import { cors, json, error, method, readJson, wrap } from '../../_lib/http.js';

const PERSONA_TTL_SEC = 60 * 60 * 24; // 24h

// Persona Hub supports two signing modes:
//   - ES256 (preferred): when PERSONA_JWKS_PRIVATE_KEY_PEM is set, persona
//     tokens are signed with that EC P-256 private key and the public key is
//     published at /.well-known/jwks.json so tenants can verify offline.
//     Generate one with: `node scripts/generate-persona-key.mjs`.
//   - HS256 (fallback): JWT_SECRET shared secret; tenants must hit the
//     /verify endpoint since the secret can't be published.
//
// Verification accepts both, so existing tokens keep working through a key
// rollover.

let _hsKey;
function hsKey() {
	if (!_hsKey) _hsKey = new TextEncoder().encode(env.JWT_SECRET);
	return _hsKey;
}

let _esKeys = null; // { kid, alg, privateKey, publicKey, publicJwk }
async function esKeys() {
	if (_esKeys) return _esKeys;
	const pem = process.env.PERSONA_JWKS_PRIVATE_KEY_PEM;
	if (!pem) return null;
	const pkcs8 = pem.replace(/\\n/g, '\n');
	const privateKey = await importPKCS8(pkcs8, 'ES256');
	const publicPem = process.env.PERSONA_JWKS_PUBLIC_KEY_PEM
		? process.env.PERSONA_JWKS_PUBLIC_KEY_PEM.replace(/\\n/g, '\n')
		: null;
	let publicKey;
	if (publicPem) {
		publicKey = await importSPKI(publicPem, 'ES256');
	} else {
		// Without the explicit public key we derive a JWK from the private key's
		// public bits (jose's exportJWK on a private CryptoKey returns the public
		// JWK fields plus `d`; we drop `d` for publication).
		publicKey = privateKey;
	}
	const fullJwk = await exportJWK(publicKey);
	delete fullJwk.d;
	const publicJwk = {
		kty: fullJwk.kty,
		crv: fullJwk.crv,
		x: fullJwk.x,
		y: fullJwk.y,
		alg: 'ES256',
		use: 'sig',
		kid: process.env.PERSONA_JWKS_KID || 'persona-es256-1',
	};
	_esKeys = {
		kid: publicJwk.kid,
		alg: 'ES256',
		privateKey,
		publicKey,
		publicJwk,
	};
	return _esKeys;
}

// Tenant origin must be a valid https URL on a three.ws subdomain, or a
// localhost dev origin. Anything else is rejected — prevents arbitrary sites
// from minting tokens claiming the user's three.ws avatar.
function validateTenantOrigin(origin) {
	if (typeof origin !== 'string' || origin.length > 256) return null;
	let u;
	try {
		u = new URL(origin);
	} catch (_) {
		return null;
	}
	if (u.pathname !== '/' && u.pathname !== '') return null;
	if (u.search || u.hash) return null;

	const host = u.host.toLowerCase();
	const isHttps = u.protocol === 'https:';
	const isLocalhost = u.protocol === 'http:' && (host === 'localhost' || host.startsWith('localhost:') || host.startsWith('127.0.0.1'));
	const isThreeWs = host === 'three.ws' || host.endsWith('.three.ws');

	if (isLocalhost) return `${u.protocol}//${host}`;
	if (isHttps && isThreeWs) return `https://${host}`;
	return null;
}

async function loadAvatarForUser(userId, avatarId) {
	const rows = avatarId
		? await sql`select id, name, storage_key, thumbnail_key from avatars where owner_id = ${userId} and id = ${avatarId} and deleted_at is null limit 1`
		: await sql`select id, name, storage_key, thumbnail_key from avatars where owner_id = ${userId} and deleted_at is null order by created_at desc limit 1`;
	const row = rows[0];
	if (!row) return null;
	return {
		id: row.id,
		name: row.name,
		url: publicUrl(row.storage_key),
		thumbnail_url: thumbnailUrl(row.thumbnail_key),
	};
}

async function handleIssue(req, res) {
	if (cors(req, res, { methods: 'POST,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['POST'])) return;

	const user = await getSessionUser(req);
	if (!user) return error(res, 401, 'unauthorized', 'sign in to three.ws first');

	const body = await readJson(req);
	const tenantOrigin = validateTenantOrigin(body?.tenant_origin);
	if (!tenantOrigin) {
		return error(res, 400, 'invalid_request', 'tenant_origin must be a https three.ws subdomain or localhost dev origin');
	}

	const avatar = await loadAvatarForUser(user.id, body?.avatar_id);
	if (!avatar) {
		return error(res, 404, 'no_avatar', 'user has no avatar to share — create one at /create first');
	}

	const now = Math.floor(Date.now() / 1000);
	const es = await esKeys();
	const alg = es ? 'ES256' : 'HS256';
	const kid = es ? es.kid : env.JWT_KID;
	const signingKey = es ? es.privateKey : hsKey();

	const token = await new SignJWT({
		scope: 'persona:read avatar:read',
		token_use: 'persona',
		avatar,
	})
		.setProtectedHeader({ alg, kid, typ: 'JWT' })
		.setIssuer(env.ISSUER)
		.setSubject(user.id)
		.setAudience(tenantOrigin)
		.setIssuedAt(now)
		.setExpirationTime(now + PERSONA_TTL_SEC)
		.setJti(randomToken(16))
		.sign(signingKey);

	return json(res, 200, {
		token,
		expires_in: PERSONA_TTL_SEC,
		avatar,
		tenant_origin: tenantOrigin,
		alg,
	});
}

async function handleVerify(req, res) {
	if (cors(req, res, { methods: 'GET,OPTIONS', credentials: false })) return;
	if (!method(req, res, ['GET'])) return;

	const url = new URL(req.url, 'http://x');
	const token = url.searchParams.get('token');
	const audience = url.searchParams.get('audience');
	if (!token) return error(res, 400, 'invalid_request', 'token query param required');
	if (!audience) return error(res, 400, 'invalid_request', 'audience query param required');

	// Try ES256 first when configured, then fall back to HS256 so tokens
	// minted with the legacy shared-secret signer still verify during a key
	// rotation.
	let payload;
	const es = await esKeys();
	let lastErr = null;
	if (es) {
		try {
			({ payload } = await jwtVerify(token, es.publicKey, {
				issuer: env.ISSUER,
				audience,
				algorithms: ['ES256'],
			}));
		} catch (err) {
			lastErr = err;
		}
	}
	if (!payload) {
		try {
			({ payload } = await jwtVerify(token, hsKey(), {
				issuer: env.ISSUER,
				audience,
				algorithms: ['HS256'],
			}));
		} catch (hsErr) {
			const reason = (lastErr ?? hsErr)?.message || 'verification failed';
			return error(res, 401, 'invalid_token', reason);
		}
	}

	if (payload.token_use !== 'persona') {
		return error(res, 401, 'invalid_token', 'token is not a persona token');
	}

	return json(res, 200, {
		ok: true,
		sub: payload.sub,
		aud: payload.aud,
		scope: payload.scope,
		exp: payload.exp,
		avatar: payload.avatar,
	});
}

async function handleJwks(req, res) {
	if (cors(req, res, { methods: 'GET,OPTIONS', credentials: false })) return;
	if (!method(req, res, ['GET'])) return;
	const es = await esKeys();
	const keys = es ? [es.publicJwk] : [];
	res.setHeader('content-type', 'application/jwk-set+json; charset=utf-8');
	res.setHeader('cache-control', 'public, max-age=3600, s-maxage=86400');
	res.setHeader('access-control-allow-origin', '*');
	if (!keys.length) {
		res.setHeader(
			'x-three-ws-status',
			'no PERSONA_JWKS_PRIVATE_KEY_PEM configured; persona tokens are HS256, verify via /api/auth/persona/verify',
		);
	}
	res.statusCode = 200;
	res.end(JSON.stringify({ keys }));
}

async function handleMe(req, res) {
	if (cors(req, res, { methods: 'GET,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['GET'])) return;
	const user = await getSessionUser(req);
	if (!user) return error(res, 401, 'unauthorized', 'sign in to three.ws first');
	const rows = await sql`
		select id, name, storage_key, thumbnail_key, created_at, visibility
		from avatars
		where owner_id = ${user.id} and deleted_at is null
		order by created_at desc
		limit 50
	`;
	const avatars = rows.map((r) => ({
		id: r.id,
		name: r.name,
		url: publicUrl(r.storage_key),
		thumbnail_url: thumbnailUrl(r.thumbnail_key),
		created_at: r.created_at,
		visibility: r.visibility,
	}));
	return json(res, 200, {
		ok: true,
		user: { id: user.id, email: user.email ?? null },
		avatars,
	});
}

export default wrap(async (req, res) => {
	const action = req.query?.action ?? new URL(req.url, 'http://x').pathname.split('/').filter(Boolean).pop();
	if (action === 'issue') return handleIssue(req, res);
	if (action === 'verify') return handleVerify(req, res);
	if (action === 'me') return handleMe(req, res);
	if (action === 'jwks') return handleJwks(req, res);
	return error(res, 404, 'not_found', `unknown persona action: ${action}`);
});
