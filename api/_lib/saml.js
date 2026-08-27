// SAML 2.0 Service Provider for three.ws.
//
// three.ws is the SP: platform users authenticate at an enterprise IdP (IBM
// Cloud App ID, Okta, Azure AD, …) and the IdP POSTs a signed assertion back to
// our ACS. We wrap @node-saml/node-saml for the protocol heavy-lifting —
// XML-DSig signature verification, audience/condition/clock checks, and
// InResponseTo replay protection — because hand-rolled SAML is precisely how SPs
// get owned by signature-wrapping attacks.
//
// The one piece node-saml can't provide on its own in a serverless deployment
// is shared state for InResponseTo: the /login lambda that issues an
// AuthnRequest and the /acs lambda that consumes the response are different
// instances, so request IDs live in Postgres (postgresCacheProvider) rather
// than process memory.

import { SAML, ValidateInResponseTo, generateServiceProviderMetadata } from '@node-saml/node-saml';
import { XMLParser } from 'fast-xml-parser';
import { env } from './env.js';
import { sql } from './db.js';
import { hmacSha256, constantTimeEquals, sha256 } from './crypto.js';
import { fetchUpstream } from './upstream-fetch.js';

// Request IDs are valid for one login round-trip; an hour is generous slack for
// a user who lands on the IdP, authenticates, and is redirected back. Must match
// the TTL the cache provider enforces in getAsync().
const REQUEST_ID_TTL_SEC = 60 * 60;
// How long a fetched IdP metadata document is trusted before re-fetching.
const METADATA_TTL_MS = 60 * 60 * 1000;

// ── SP endpoint URLs (all derived from APP_ORIGIN) ──────────────────────────

export function spEntityId() {
	return env.SAML_SP_ENTITY_ID;
}
export function acsUrl() {
	return `${env.APP_ORIGIN}/api/auth/saml/acs`;
}
export function sloCallbackUrl() {
	return `${env.APP_ORIGIN}/api/auth/saml/logout`;
}

// Cheap, fetch-free predicate for the /login UI flag — true when enough IdP
// config exists to attempt a connection. The real resolution (which may fetch
// metadata) happens in getSamlInstance().
export function samlConfigured() {
	return Boolean(
		(env.SAML_IDP_CERT && env.SAML_IDP_SSO_URL) || env.SAML_IDP_METADATA_URL,
	);
}

// ── IdP config resolution: explicit env fields, else parsed metadata URL ────

let _idpCache = null; // { entityId, ssoUrl, sloUrl, cert, expiresAt }

async function resolveIdpConfig() {
	// Explicit fields take precedence and need no network round-trip.
	if (env.SAML_IDP_CERT && env.SAML_IDP_SSO_URL) {
		return {
			entityId: env.SAML_IDP_ENTITY_ID || undefined,
			ssoUrl: env.SAML_IDP_SSO_URL,
			sloUrl: env.SAML_IDP_SLO_URL || undefined,
			cert: normalizeCert(env.SAML_IDP_CERT),
		};
	}
	const metadataUrl = env.SAML_IDP_METADATA_URL;
	if (!metadataUrl) return null;

	if (_idpCache && _idpCache.expiresAt > Date.now()) return _idpCache;
	const parsed = await fetchAndParseMetadata(metadataUrl);
	if (!parsed) return _idpCache || null; // serve stale config rather than break login on a transient fetch failure
	_idpCache = { ...parsed, expiresAt: Date.now() + METADATA_TTL_MS };
	return _idpCache;
}

async function fetchAndParseMetadata(url) {
	try {
		const res = await fetchUpstream(url, {
			headers: { accept: 'application/samlmetadata+xml, application/xml, text/xml' },
		}, { name: 'saml-idp-metadata', timeoutMs: 10_000, attempts: 3, okWhen: () => true });
		if (!res.ok) return null;
		return parseIdpMetadata(await res.text());
	} catch {
		return null;
	}
}

// Parse an IdP's SAML 2.0 metadata XML into the fields node-saml needs. Exported
// for the metadata-pasting setup path and for tests. Namespace prefixes (md:,
// ds:) are stripped so traversal is uniform across IdP vendors.
export function parseIdpMetadata(xml) {
	let doc;
	try {
		doc = new XMLParser({
			ignoreAttributes: false,
			attributeNamePrefix: '@_',
			removeNSPrefix: true,
		}).parse(xml);
	} catch {
		return null;
	}

	const descriptors = toArray(doc?.EntityDescriptor ?? doc?.EntitiesDescriptor?.EntityDescriptor);
	const entity = descriptors.find((e) => e?.IDPSSODescriptor) || descriptors[0];
	const idp = entity?.IDPSSODescriptor;
	if (!idp) return null;

	const ssoUrl = pickBinding(idp.SingleSignOnService);
	const sloUrl = pickBinding(idp.SingleLogoutService);

	const certs = [];
	for (const key of toArray(idp.KeyDescriptor)) {
		if (key['@_use'] && key['@_use'] !== 'signing') continue; // skip encryption-only keys
		for (const x509Data of toArray(key?.KeyInfo?.X509Data)) {
			for (const cert of toArray(x509Data?.X509Certificate)) {
				const body = typeof cert === 'object' ? cert?.['#text'] : cert;
				if (body) certs.push(normalizeCert(body));
			}
		}
	}

	if (!ssoUrl || certs.length === 0) return null;
	return {
		entityId: entity['@_entityID'] || undefined,
		ssoUrl,
		sloUrl: sloUrl || undefined,
		cert: certs.length === 1 ? certs[0] : certs,
	};
}

// Prefer the HTTP-Redirect endpoint (what we use for AuthnRequest / LogoutRequest);
// fall back to the first listed binding.
function pickBinding(service) {
	const list = toArray(service);
	const redirect = list.find((s) => String(s?.['@_Binding'] || '').includes('HTTP-Redirect'));
	return (redirect || list[0])?.['@_Location'] || null;
}

function toArray(v) {
	return v == null ? [] : Array.isArray(v) ? v : [v];
}

// node-saml accepts either PEM or a bare base64 body; normalize to base64 so
// metadata-sourced and env-sourced certs are handled identically.
function normalizeCert(c) {
	return String(c)
		.replace(/-----BEGIN CERTIFICATE-----/g, '')
		.replace(/-----END CERTIFICATE-----/g, '')
		.replace(/\s+/g, '');
}

// ── Postgres-backed InResponseTo cache (shared across serverless instances) ──

export const postgresCacheProvider = {
	async saveAsync(key, value) {
		// Best-effort sweep of abandoned login attempts so the table can't grow
		// unbounded from users who start SSO and never return.
		sql`delete from saml_request_ids where created_at < now() - ${`${REQUEST_ID_TTL_SEC * 2} seconds`}::interval`.catch(
			() => {},
		);
		const rows = await sql`
			insert into saml_request_ids (request_id, value)
			values (${key}, ${value})
			on conflict (request_id) do nothing
			returning extract(epoch from created_at) * 1000 as created_ms
		`;
		if (!rows[0]) return null; // key already present — don't overwrite
		return { value, createdAt: Number(rows[0].created_ms) };
	},
	async getAsync(key) {
		if (key == null) return null;
		const rows = await sql`
			select value from saml_request_ids
			where request_id = ${key}
			  and created_at > now() - ${`${REQUEST_ID_TTL_SEC} seconds`}::interval
			limit 1
		`;
		return rows[0]?.value ?? null;
	},
	async removeAsync(key) {
		if (key == null) return null;
		const rows = await sql`
			delete from saml_request_ids where request_id = ${key} returning request_id
		`;
		return rows[0]?.request_id ?? null;
	},
};

// ── SAML instance ───────────────────────────────────────────────────────────

// Build a configured SAML instance. Throws a 501 when the IdP isn't configured
// so callers can surface "not configured" rather than a generic crash.
export async function getSamlInstance() {
	const idp = await resolveIdpConfig();
	if (!idp || !idp.ssoUrl || !idp.cert) {
		throw Object.assign(new Error('SAML SSO is not configured'), {
			status: 501,
			code: 'not_configured',
		});
	}

	return new SAML({
		// SP identity
		issuer: spEntityId(),
		callbackUrl: acsUrl(),
		audience: spEntityId(),

		// IdP
		entryPoint: idp.ssoUrl,
		idpCert: idp.cert,
		...(idp.entityId ? { idpIssuer: idp.entityId } : {}),
		...(idp.sloUrl ? { logoutUrl: idp.sloUrl } : {}),

		// Security posture
		wantAssertionsSigned: env.SAML_WANT_ASSERTIONS_SIGNED,
		wantAuthnResponseSigned: env.SAML_WANT_RESPONSE_SIGNED,
		signatureAlgorithm: env.SAML_SIGNATURE_ALGORITHM,
		digestAlgorithm: env.SAML_SIGNATURE_ALGORITHM,
		identifierFormat: env.SAML_IDENTIFIER_FORMAT,
		acceptedClockSkewMs: env.SAML_CLOCK_SKEW_MS,
		validateInResponseTo: env.SAML_ALLOW_IDP_INITIATED
			? ValidateInResponseTo.ifPresent
			: ValidateInResponseTo.always,
		requestIdExpirationPeriodMs: REQUEST_ID_TTL_SEC * 1000,
		cacheProvider: postgresCacheProvider,
		disableRequestedAuthnContext: true,

		// Optional SP keypair — signs AuthnRequests and decrypts encrypted assertions.
		...(env.SAML_SP_PRIVATE_KEY
			? { privateKey: env.SAML_SP_PRIVATE_KEY, decryptionPvk: env.SAML_SP_PRIVATE_KEY }
			: {}),
		...(env.SAML_SP_CERT ? { publicCert: env.SAML_SP_CERT } : {}),
	});
}

// SP metadata XML for IdP registration. Deliberately does NOT require IdP config
// — you fetch this first to set up the IdP side, before pasting IdP details back.
export function generateSpMetadataXml() {
	const cert = env.SAML_SP_CERT || null;
	return generateServiceProviderMetadata({
		issuer: spEntityId(),
		callbackUrl: acsUrl(),
		logoutCallbackUrl: sloCallbackUrl(),
		decryptionCert: cert,
		publicCerts: cert,
		identifierFormat: env.SAML_IDENTIFIER_FORMAT,
		wantAssertionsSigned: env.SAML_WANT_ASSERTIONS_SIGNED,
		decryptionPvk: env.SAML_SP_PRIVATE_KEY || undefined,
		privateKey: env.SAML_SP_PRIVATE_KEY || undefined,
		signatureAlgorithm: env.SAML_SIGNATURE_ALGORITHM,
	});
}

// ── RelayState (signed; carries the post-login redirect) ────────────────────

export async function signRelayState(payload) {
	const data = Buffer.from(JSON.stringify(payload)).toString('base64url');
	const sig = await hmacSha256(env.JWT_SECRET, `saml-relay:${data}`);
	return `${data}.${sig}`;
}

export async function verifyRelayState(state) {
	if (!state || typeof state !== 'string') return null;
	const dot = state.lastIndexOf('.');
	if (dot < 0) return null;
	const data = state.slice(0, dot);
	const sig = state.slice(dot + 1);
	const expected = await hmacSha256(env.JWT_SECRET, `saml-relay:${data}`);
	if (!constantTimeEquals(sig, expected)) return null;
	try {
		return JSON.parse(Buffer.from(data, 'base64url').toString('utf8'));
	} catch {
		return null;
	}
}

// Only allow same-origin relative redirects so RelayState can't be used as an
// open-redirect vector. Rejects protocol-relative ("//evil.com") and absolute URLs.
export function safeNextPath(next, fallback = '/dashboard') {
	if (typeof next !== 'string' || !next.startsWith('/') || next.startsWith('//')) return fallback;
	return next;
}

// ── Identity extraction from a validated assertion ──────────────────────────

// IdPs scatter the same claim across wildly different attribute names (friendly
// name, OID, WS-Fed claim URI). Check the common spellings for each field.
const EMAIL_KEYS = [
	'email',
	'mail',
	'emailaddress',
	'urn:oid:0.9.2342.19200300.100.1.3',
	'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress',
	'http://schemas.xmlsoap.org/claims/EmailAddress',
];
const NAME_KEYS = [
	'displayName',
	'displayname',
	'name',
	'cn',
	'urn:oid:2.16.840.1.113730.3.1.241',
	'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name',
	'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/displayname',
];
const GIVEN_KEYS = [
	'givenName',
	'firstName',
	'urn:oid:2.5.4.42',
	'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/givenname',
];
const SUR_KEYS = [
	'sn',
	'surname',
	'lastName',
	'urn:oid:2.5.4.4',
	'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/surname',
];

function firstAttr(profile, keys) {
	for (const k of keys) {
		const v = profile?.[k];
		if (v == null) continue;
		const val = Array.isArray(v) ? v[0] : v;
		if (val != null && String(val).trim()) return String(val).trim();
	}
	return null;
}

export function extractSamlIdentity(profile) {
	const issuer = profile.issuer || null;
	const nameID = profile.nameID || null;
	const nameIDFormat = profile.nameIDFormat || null;

	let email = firstAttr(profile, EMAIL_KEYS);
	// Fall back to the NameID when it's an email (either explicitly emailAddress
	// format, or just shaped like one — many IdPs use email as the subject).
	if (!email && nameID && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(nameID)) {
		email = nameID;
	}
	if (email) email = email.toLowerCase();

	let name = firstAttr(profile, NAME_KEYS);
	if (!name) {
		const parts = [firstAttr(profile, GIVEN_KEYS), firstAttr(profile, SUR_KEYS)].filter(Boolean);
		name = parts.length ? parts.join(' ') : null;
	}

	return { issuer, nameID, nameIDFormat, email, name, sessionIndex: profile.sessionIndex || null };
}

// Stable synthetic-email seed for IdPs that don't release an email claim.
export async function subjectHash(issuer, nameID) {
	return (await sha256(`${issuer || ''}|${nameID}`)).slice(0, 24);
}
