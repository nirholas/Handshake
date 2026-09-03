// The satellite store: where a paired voice satellite lives, and the only
// module that touches its signing key.
//
// The same two invariants as api/_lib/home/store.js hold here and for the same
// reasons. A satellite row is never returned with `viewer_secret_enc` on it,
// and ownership is a `where user_id = $1` inside the query rather than a check
// in JavaScript after the row is in hand, so a wrong owner and a missing row
// are indistinguishable from outside.
//
// A pairing code is a bearer credential with a physical consequence: redeeming
// one attaches a microphone in somebody's house to an agent. Three properties
// are enforced here rather than by the caller, because a caller can forget.
//
//   * The code is stored as a SHA-256 hash and compared by hash.
//   * Redemption is a conditional UPDATE, so two racing claims cannot both win.
//   * Expiry is in the WHERE clause, not in a JavaScript date comparison after
//     the row has already been read.

import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';

import { sql } from '../db.js';
import { decryptSecret, encryptSecret } from '../secret-box.js';

/** How long a pairing code is good for. Long enough to paste, short enough to leak safely. */
export const CODE_TTL_MINUTES = 15;

/**
 * The code alphabet. No 0/O, no 1/I/L: a pairing code is read off a screen and
 * typed into a terminal, often from a phone, and the characters people confuse
 * are the ones that turn a working setup into "pairing failed".
 */
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

/** Generate a code in the shape `ABCD-EFGH`. */
export function generateCode() {
	let out = '';
	for (let i = 0; i < 8; i += 1) out += ALPHABET[randomInt(ALPHABET.length)];
	return `${out.slice(0, 4)}-${out.slice(4)}`;
}

/**
 * Normalize a code as typed. People paste it with the hyphen, without it, in
 * lower case, and with a trailing space from a terminal copy. All four are the
 * same code.
 */
export function normalizeCode(raw) {
	const cleaned = String(raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
	if (cleaned.length !== 8) return null;
	if (![...cleaned].every((c) => ALPHABET.includes(c))) return null;
	return `${cleaned.slice(0, 4)}-${cleaned.slice(4)}`;
}

const hashCode = (code) => createHash('sha256').update(code).digest('hex');

/** Columns that are safe to return. `viewer_secret_enc` is deliberately absent. */
const SAFE = sql`
	id, user_id, agent_id, name, area, version, wyoming_version,
	created_at, last_seen_at, revoked_at
`;

/**
 * Mint a pairing code for one agent.
 * @param {{ userId: string, agentId: string, name?: string|null }} input
 */
export async function createPairingCode({ userId, agentId, name = null }) {
	const code = generateCode();
	const [row] = await sql`
		insert into home_satellite_codes (code_hash, user_id, agent_id, name, expires_at)
		values (${hashCode(code)}, ${userId}, ${agentId}, ${name}, now() + ${`${CODE_TTL_MINUTES} minutes`}::interval)
		returning id, created_at, expires_at
	`;
	return { code, id: row.id, created_at: row.created_at, expires_at: row.expires_at };
}

/**
 * Redeem a code, creating the satellite it buys.
 *
 * Returns `{ ok: false, reason }` for every failure a stranger could provoke,
 * so the endpoint can answer "that code is not valid" without a stack trace and
 * without telling the caller which of the three failure modes it hit.
 *
 * @param {{ code: string, name?: string|null, area?: string|null, version?: string|null, wyomingVersion?: string|null }} input
 */
export async function claimPairingCode({ code, name = null, area = null, version = null, wyomingVersion = null }) {
	const normalized = normalizeCode(code);
	if (!normalized) return { ok: false, reason: 'malformed' };

	// Single use and expiry, decided by the database in one statement. A read
	// followed by a write would let two claims of the same code both observe it
	// unclaimed; here exactly one UPDATE returns a row.
	const [claimed] = await sql`
		update home_satellite_codes
		   set claimed_at = now()
		 where code_hash = ${hashCode(normalized)}
		   and claimed_at is null
		   and expires_at > now()
		returning id, user_id, agent_id, name
	`;
	if (!claimed) return { ok: false, reason: 'invalid' };

	const [agent] = await sql`
		select id, name from agent_identities
		where id = ${claimed.agent_id} and deleted_at is null
		limit 1
	`;
	if (!agent) return { ok: false, reason: 'agent_gone' };

	const secret = randomSecret();
	const [satellite] = await sql`
		insert into home_satellites (user_id, agent_id, name, area, viewer_secret_enc, version, wyoming_version)
		values (
			${claimed.user_id}, ${claimed.agent_id},
			${String(name || claimed.name || agent.name || 'three.ws agent').slice(0, 120)},
			${area ? String(area).slice(0, 120) : null},
			${await encryptSecret(secret)},
			${version ? String(version).slice(0, 40) : null},
			${wyomingVersion ? String(wyomingVersion).slice(0, 40) : null}
		)
		returning ${SAFE}
	`;

	await sql`update home_satellite_codes set satellite_id = ${satellite.id} where id = ${claimed.id}`;
	return { ok: true, satellite, secret, agent };
}

/**
 * Authenticate a satellite by the secret it was handed at claim time.
 * Returns the row plus its decrypted secret, or null.
 */
export async function authenticateSatellite(satelliteId, secret) {
	if (!satelliteId || !secret) return null;
	const [row] = await sql`
		select ${SAFE}, viewer_secret_enc
		from home_satellites
		where id = ${satelliteId} and revoked_at is null
		limit 1
	`;
	if (!row) return null;
	let stored;
	try {
		stored = await decryptSecret(row.viewer_secret_enc);
	} catch {
		return null;
	}
	// Constant time. The secret is a bearer credential for a microphone in a
	// house; leaking it one byte at a time through response timing is a real
	// attack even though the value is high entropy.
	const a = Buffer.from(stored, 'utf8');
	const b = Buffer.from(String(secret), 'utf8');
	if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
	const { viewer_secret_enc: _ignored, ...safe } = row;
	return { satellite: safe, secret: stored };
}

/** Record that a satellite checked in, and what it is running. */
export async function touchSatellite(id, { version = null, wyomingVersion = null } = {}) {
	await sql`
		update home_satellites
		   set last_seen_at = now(),
		       version = coalesce(${version ? String(version).slice(0, 40) : null}, version),
		       wyoming_version = coalesce(${wyomingVersion ? String(wyomingVersion).slice(0, 40) : null}, wyoming_version)
		 where id = ${id}
	`;
}

/** One satellite the caller owns, with its decrypted signing key. */
export async function getSatelliteForOwner(id, userId) {
	const [row] = await sql`
		select ${SAFE}, viewer_secret_enc
		from home_satellites
		where id = ${id} and user_id = ${userId} and revoked_at is null
		limit 1
	`;
	if (!row) return null;
	const { viewer_secret_enc, ...safe } = row;
	let secret = null;
	try {
		secret = await decryptSecret(viewer_secret_enc);
	} catch {
		secret = null;
	}
	return { satellite: safe, secret };
}

/** Every satellite the caller owns, newest first. */
export async function listSatellites(userId) {
	return sql`
		select s.id, s.agent_id, s.name, s.area, s.version, s.wyoming_version,
		       s.created_at, s.last_seen_at, a.name as agent_name
		from home_satellites s
		join agent_identities a on a.id = s.agent_id
		where s.user_id = ${userId} and s.revoked_at is null
		order by s.created_at desc
		limit 100
	`;
}

/** Codes minted by the caller that have not been redeemed and have not expired. */
export async function listPendingCodes(userId) {
	return sql`
		select c.id, c.agent_id, c.name, c.created_at, c.expires_at, a.name as agent_name
		from home_satellite_codes c
		join agent_identities a on a.id = c.agent_id
		where c.user_id = ${userId} and c.claimed_at is null and c.expires_at > now()
		order by c.created_at desc
		limit 20
	`;
}

/**
 * Revoke a satellite. The row stays so the audit trail stays; every path that
 * reads a satellite filters `revoked_at is null`, so the effect is immediate
 * and its identity can never be re-authenticated.
 */
export async function revokeSatellite(id, userId) {
	const [row] = await sql`
		update home_satellites
		   set revoked_at = now()
		 where id = ${id} and user_id = ${userId} and revoked_at is null
		returning id
	`;
	return !!row;
}

/** Withdraw an unclaimed pairing code. */
export async function revokePairingCode(id, userId) {
	const [row] = await sql`
		delete from home_satellite_codes
		 where id = ${id} and user_id = ${userId} and claimed_at is null
		returning id
	`;
	return !!row;
}

function randomSecret() {
	return randomBytes(32).toString('base64url');
}
