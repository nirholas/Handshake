/**
 * The platform half of the dial-out relay: pairing, transport, revocation.
 *
 * A house that only exists on a LAN cannot be dialled from Cloud Run, so it
 * dials us. `services/home-relay` terminates those sockets; the three.ws
 * integration inside Home Assistant opens them; this module is everything
 * three.ws itself needs to take part.
 *
 * Three responsibilities, and deliberately no more:
 *
 *   1. Pairing. Mint a short code, redeem it exactly once, hand back the
 *      relay address and this install's own token.
 *   2. Transport. Turn a relay connection row into the `createSocket` that
 *      `HomeBridge` needs, so the runtime treats a relayed house exactly like a
 *      dialled one.
 *   3. Revocation. Push a revoke to the relay so a disconnected home's socket
 *      drops immediately rather than at the next heartbeat.
 *
 * What this module never does is hold a Home Assistant credential. A relay
 * home's `home_connections.access_token_enc` is empty, on purpose, and that is
 * a product claim as much as a security one: connecting your house to three.ws
 * this way hands us nothing that would open it if we were breached.
 */

import { createHash, randomInt, timingSafeEqual } from 'node:crypto';

import { createRelayTransport } from '@three-ws/home-bridge';

import { sql } from '../db.js';
import { HOME_STATUS } from './store.js';
// The relay verifies these tokens with the same code that mints them. Two
// copies of an HMAC scheme is exactly the drift the vendoring rules exist to
// prevent, and the API image is built with `COPY . .` from the repo root, so
// services/ is present at runtime and one copy is enough.
import { mintInstallToken, newRelayId } from '../../../services/home-relay/src/token.js';

/** How long a pairing code is worth typing. Pairing is an activity, not a state. */
export const PAIRING_TTL_MS = 10 * 60 * 1000;

/** Wrong guesses before the code dies. Turns 40 bits into unguessable. */
export const MAX_PAIRING_ATTEMPTS = 5;

/**
 * Crockford base32 minus the characters people mistype into each other: no I,
 * L, O or U. A code is read off one screen and typed into another, so the
 * alphabet matters more than the entropy does.
 */
const CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const CODE_LENGTH = 8;

/** Coded outcomes, so the endpoint and the integration agree on what happened. */
export const PAIRING_ERR = Object.freeze({
	UNKNOWN_CODE: 'unknown_code',
	EXPIRED: 'expired',
	ALREADY_REDEEMED: 'already_redeemed',
	TOO_MANY_ATTEMPTS: 'too_many_attempts',
	PROTOCOL_TOO_OLD: 'protocol_too_old',
	NOT_CONFIGURED: 'not_configured',
});

export class PairingError extends Error {
	constructor(code, message, status) {
		super(message);
		this.name = 'PairingError';
		this.code = code;
		this.status = status;
	}
}

/** The relay protocol version this build of the platform speaks. */
export const RELAY_PROTOCOL_VERSION = 1;
export const MIN_AGENT_PROTOCOL = 1;

/**
 * Relay configuration, read at call time rather than at import time so a
 * deploy that adds the variables does not need a code change to pick them up.
 */
export function relayConfig() {
	return {
		url: process.env.HOME_RELAY_URL || '',
		serviceToken: process.env.HOME_RELAY_SERVICE_TOKEN || '',
		signingKey: process.env.HOME_RELAY_SIGNING_KEY || '',
	};
}

/**
 * True when this deployment can offer the dial-out path at all. The connect UI
 * branches on it: a platform without a relay says so plainly instead of showing
 * a pairing code that could never be redeemed.
 */
export function isRelayConfigured() {
	const { url, serviceToken, signingKey } = relayConfig();
	return Boolean(url && serviceToken.length >= 32 && signingKey.length >= 32);
}

function requireRelay() {
	const config = relayConfig();
	if (!isRelayConfigured()) {
		throw new PairingError(
			PAIRING_ERR.NOT_CONFIGURED,
			'This three.ws deployment has no home relay configured, so a home that is only on your network cannot be connected here yet.',
			503,
		);
	}
	return config;
}

// --------------------------------------------------------------------- codes

/**
 * A pairing code, formatted for reading aloud and typing: `ABCD-EFGH`.
 * `randomInt` is the CSPRNG, not `Math.random`: this is a credential, however
 * short-lived.
 */
export function generatePairingCode() {
	let raw = '';
	for (let i = 0; i < CODE_LENGTH; i += 1) raw += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
	return `${raw.slice(0, 4)}-${raw.slice(4)}`;
}

/**
 * Codes arrive typed by a human: lowercase, spaced, hyphenated at will. Reduce
 * every rendering to the one form the digest is taken over.
 */
export function normalizePairingCode(input) {
	return String(input || '')
		.toUpperCase()
		.replace(/[^0-9A-Z]/g, '');
}

export function hashPairingCode(code) {
	return createHash('sha256').update(`three.ws/home-pairing/${normalizePairingCode(code)}`).digest('hex');
}

// -------------------------------------------------------------------- pairing

/**
 * Begin pairing a LAN-only house.
 *
 * Creates the `home_connections` row up front, with `transport: 'relay'`, an
 * empty credential and a relay id, then mints a code that redeems into that
 * one row and no other. Creating the row first is what makes the code safe to
 * be short: it is not a ticket to "some house", it is a ticket to this one.
 *
 * @param {{ userId: string, label?: string }} input
 * @returns {Promise<{ home: object, code: string, expiresAt: string, relayUrl: string }>}
 */
export async function startPairing({ userId, label }) {
	const config = requireRelay();
	if (!userId) throw new Error('startPairing: userId is required');

	const relayId = newRelayId();
	const cleanLabel = normalizeLabel(label) || 'My home';

	// The direct path's createConnection() insists on a token, correctly: a
	// dialled home without one is a bug. A relayed home without one is the
	// design, so the relay row is written here instead, with the credential
	// columns explicitly empty rather than absent.
	const rows = await sql`
		insert into home_connections
			(user_id, label, base_url, access_token_enc, token_fingerprint,
			 transport, relay_id, capabilities, status, status_detail)
		values
			(${userId}, ${cleanLabel}, ${relayBaseUrl(relayId)}, '', '',
			 'relay', ${relayId}, '{}'::jsonb, ${HOME_STATUS.PENDING},
			 'Waiting for the three.ws integration in this home to pair.')
		returning id, user_id, label, base_url, transport, relay_id, capabilities, status, status_detail, created_at
	`;
	const home = rows[0];

	const code = generatePairingCode();
	const expiresAt = new Date(Date.now() + PAIRING_TTL_MS);
	await sql`
		insert into home_relay_pairings (home_id, user_id, code_hash, relay_id, expires_at)
		values (${home.id}, ${userId}, ${hashPairingCode(code)}, ${relayId}, ${expiresAt.toISOString()})
	`;

	return { home, code, expiresAt: expiresAt.toISOString(), relayUrl: config.url };
}

/**
 * Mint a fresh code for a home that is already pending, without creating a
 * second home. This is what "the code expired" recovers into: state 6 in the
 * connect flow, one button, no orphaned rows.
 */
export async function refreshPairing({ homeId, userId }) {
	const config = requireRelay();
	const rows = await sql`
		select id, relay_id, status
		from home_connections
		where id = ${homeId} and user_id = ${userId} and transport = 'relay' and revoked_at is null
	`;
	const home = rows[0];
	if (!home) throw new PairingError(PAIRING_ERR.UNKNOWN_CODE, 'That home is not connected to this account.', 404);

	// One live code per home: a stale one left redeemable would be a second,
	// invisible way in.
	await sql`delete from home_relay_pairings where home_id = ${homeId} and redeemed_at is null`;

	const code = generatePairingCode();
	const expiresAt = new Date(Date.now() + PAIRING_TTL_MS);
	await sql`
		insert into home_relay_pairings (home_id, user_id, code_hash, relay_id, expires_at)
		values (${homeId}, ${userId}, ${hashPairingCode(code)}, ${home.relay_id}, ${expiresAt.toISOString()})
	`;
	return { code, expiresAt: expiresAt.toISOString(), relayUrl: config.url, relayId: home.relay_id };
}

/**
 * Redeem a pairing code, from inside the house.
 *
 * This is the ONE unauthenticated endpoint in the home surface, because the
 * caller is a Home Assistant install that has no three.ws session and never
 * will. Everything that makes it safe is here: the code is single use under a
 * conditional update (so two racing redemptions cannot both win), it is
 * expiring, it is attempt-limited, and it only ever yields the one home it was
 * minted for.
 *
 * @param {{ code: string, protocol?: number, agent?: object }} input
 * @returns {Promise<{ relayId: string, relayUrl: string, installToken: string, label: string }>}
 */
export async function redeemPairing({ code, protocol, agent } = {}) {
	const config = requireRelay();
	const normalized = normalizePairingCode(code);
	if (normalized.length !== CODE_LENGTH) {
		throw new PairingError(PAIRING_ERR.UNKNOWN_CODE, 'That pairing code is not one three.ws issued.', 404);
	}
	if (protocol !== undefined && Number(protocol) < MIN_AGENT_PROTOCOL) {
		throw new PairingError(
			PAIRING_ERR.PROTOCOL_TOO_OLD,
			`This three.ws integration speaks relay protocol ${protocol}; the platform needs ${MIN_AGENT_PROTOCOL} or newer. Update it in HACS.`,
			426,
		);
	}

	const hash = hashPairingCode(normalized);
	const found = await sql`
		select id, home_id, user_id, relay_id, expires_at, redeemed_at, attempts
		from home_relay_pairings
		where code_hash = ${hash}
	`;
	const pairing = found[0];
	if (!pairing) {
		throw new PairingError(PAIRING_ERR.UNKNOWN_CODE, 'That pairing code is not one three.ws issued.', 404);
	}
	if (pairing.redeemed_at) {
		throw new PairingError(
			PAIRING_ERR.ALREADY_REDEEMED,
			'That pairing code has already been used. Generate a new one in three.ws.',
			409,
		);
	}
	if (pairing.attempts >= MAX_PAIRING_ATTEMPTS) {
		throw new PairingError(
			PAIRING_ERR.TOO_MANY_ATTEMPTS,
			'That pairing code was entered incorrectly too many times and is no longer valid. Generate a new one in three.ws.',
			429,
		);
	}
	if (new Date(pairing.expires_at).getTime() <= Date.now()) {
		throw new PairingError(PAIRING_ERR.EXPIRED, 'That pairing code expired. Generate a new one in three.ws.', 410);
	}

	// Single use, decided by the database rather than by this process: two
	// integrations racing on the same code both reach here, and exactly one
	// update matches.
	const claimed = await sql`
		update home_relay_pairings
		set redeemed_at = now(), redeemed_by = ${JSON.stringify(describeAgent(agent))}::jsonb
		where id = ${pairing.id} and redeemed_at is null
		returning id
	`;
	if (!claimed.length) {
		throw new PairingError(
			PAIRING_ERR.ALREADY_REDEEMED,
			'That pairing code has already been used. Generate a new one in three.ws.',
			409,
		);
	}

	const homes = await sql`
		update home_connections
		set status = ${HOME_STATUS.PENDING},
		    status_detail = 'Paired. Waiting for the first connection from this home.',
		    updated_at = now()
		where id = ${pairing.home_id} and revoked_at is null
		returning id, label, relay_id
	`;
	const home = homes[0];
	if (!home) {
		throw new PairingError(PAIRING_ERR.UNKNOWN_CODE, 'The home this code was for has been removed.', 404);
	}

	return {
		relayId: home.relay_id,
		relayUrl: config.url,
		installToken: mintInstallToken(
			{ relayId: home.relay_id, userId: pairing.user_id, homeId: home.id },
			config.signingKey,
		),
		label: home.label,
		protocol: RELAY_PROTOCOL_VERSION,
	};
}

/**
 * Count a wrong code against the pairing it was aimed at. A code that does not
 * exist has nothing to count against, which is the honest asymmetry: guessing
 * is bounded per live pairing, and there is nothing to bound when there is no
 * live pairing to guess at.
 */
export async function recordFailedAttempt(code) {
	const hash = hashPairingCode(code);
	await sql`update home_relay_pairings set attempts = attempts + 1 where code_hash = ${hash} and redeemed_at is null`;
}

/** The live code for a home, if there is one, for the connect UI's countdown. */
export async function pendingPairing(homeId, userId) {
	const rows = await sql`
		select expires_at, redeemed_at, attempts, created_at
		from home_relay_pairings
		where home_id = ${homeId} and user_id = ${userId}
		order by created_at desc
		limit 1
	`;
	const row = rows[0];
	if (!row || row.redeemed_at) return null;
	if (new Date(row.expires_at).getTime() <= Date.now()) return { expired: true, expiresAt: row.expires_at };
	return { expired: false, expiresAt: row.expires_at, attempts: row.attempts };
}

// ------------------------------------------------------------------ transport

/**
 * The `transport` a relayed home's `HomeBridge` needs.
 *
 * Everything above this call is identical to the direct path. That is the whole
 * design: `home-assistant-js-websocket` already takes a `createSocket`, so
 * reaching a house through the relay is a socket factory and not a second
 * client.
 *
 * @param {{ relay_id?: string, relayId?: string }} row a home_connections row
 */
export function relayTransportFor(row) {
	const config = requireRelay();
	const relayId = row?.relay_id || row?.relayId;
	if (!relayId) {
		throw new PairingError(
			PAIRING_ERR.UNKNOWN_CODE,
			'This home is set up for the three.ws integration but has no relay id. Reconnect it.',
			409,
		);
	}
	return createRelayTransport({ relayUrl: config.url, relayId, serviceToken: config.serviceToken });
}

// ----------------------------------------------------------------- revocation

/**
 * Drop a house's socket at the relay, now.
 *
 * Revocation is both-ended: three.ws stops opening sessions the moment the row
 * is revoked, and this makes the house's own socket go away rather than
 * lingering until its next heartbeat. Failure here is logged and swallowed on
 * purpose: the connection row is already revoked in the database, which is what
 * actually gates access, and a relay that is briefly unreachable must not make
 * "disconnect my home" fail.
 *
 * @returns {Promise<{ ok: boolean, detail?: string }>}
 */
export async function revokeAtRelay(relayId, { fetchImpl = fetch } = {}) {
	if (!relayId || !isRelayConfigured()) return { ok: false, detail: 'no relay configured' };
	const config = relayConfig();
	try {
		const res = await fetchImpl(new URL('/v1/revoke', toHttpUrl(config.url)).href, {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${config.serviceToken}` },
			body: JSON.stringify({ relayId }),
			signal: AbortSignal.timeout(8000),
		});
		if (!res.ok) return { ok: false, detail: `relay answered ${res.status}` };
		return { ok: true, ...(await res.json().catch(() => ({}))) };
	} catch (err) {
		return { ok: false, detail: err?.message || String(err) };
	}
}

/**
 * Is this house currently dialled in. The connect UI uses it to tell state 3
 * (paired and connected) apart from state 4 (the integration is offline)
 * without opening a session that would only fail.
 */
export async function relayStatus(relayId, { fetchImpl = fetch } = {}) {
	if (!relayId || !isRelayConfigured()) return { online: false, configured: false };
	const config = relayConfig();
	try {
		const url = new URL('/v1/status', toHttpUrl(config.url));
		url.searchParams.set('relay_id', relayId);
		const res = await fetchImpl(url.href, {
			headers: { authorization: `Bearer ${config.serviceToken}` },
			signal: AbortSignal.timeout(8000),
		});
		if (!res.ok) return { online: false, configured: true, detail: `relay answered ${res.status}` };
		return { configured: true, ...(await res.json()) };
	} catch (err) {
		return { online: false, configured: true, detail: err?.message || String(err) };
	}
}

/** Removes pairings that can never be redeemed again. Called by the sweep cron. */
export async function prunePairings({ olderThanHours = 24 } = {}) {
	const rows = await sql`
		delete from home_relay_pairings
		where (redeemed_at is not null and redeemed_at < now() - ${`${olderThanHours} hours`}::interval)
		   or (redeemed_at is null and expires_at < now() - ${`${olderThanHours} hours`}::interval)
		returning id
	`;
	return { pruned: rows.length };
}

// ---------------------------------------------------------------- small parts

/**
 * A relay home has no URL of ours to dial, but `home_connections.base_url` is
 * not null and is unique per user. `relay://<relay id>` satisfies both, is
 * unique by construction, and reads honestly in a row dump: this home is not
 * somewhere we can reach, it is somewhere that reaches us.
 */
export function relayBaseUrl(relayId) {
	return `relay://${relayId}`;
}

export function isRelayBaseUrl(baseUrl) {
	return typeof baseUrl === 'string' && baseUrl.startsWith('relay://');
}

function toHttpUrl(relayUrl) {
	const url = new URL(relayUrl);
	if (url.protocol === 'ws:') url.protocol = 'http:';
	if (url.protocol === 'wss:') url.protocol = 'https:';
	return url;
}

/**
 * What redeemed a code, bounded and typed. The integration supplies this and it
 * is therefore untrusted text: it is stored for the owner to read and is never
 * interpreted.
 */
function describeAgent(agent) {
	const trim = (value, max) => (typeof value === 'string' ? value.slice(0, max) : null);
	return {
		name: trim(agent?.name, 96) || 'unknown',
		version: trim(agent?.version, 32) || 'unknown',
		at: new Date().toISOString(),
	};
}

function normalizeLabel(label) {
	return String(label || '').trim().slice(0, 120);
}

/** Exported for the pairing endpoint's constant-time compare on a code echo. */
export function codesMatch(a, b) {
	const ha = createHash('sha256').update(normalizePairingCode(a)).digest();
	const hb = createHash('sha256').update(normalizePairingCode(b)).digest();
	return timingSafeEqual(ha, hb);
}
