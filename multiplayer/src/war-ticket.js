// War ticket verification, the game-server half of Coin Wars matchmaking.
//
// The API's matchmaker (api/wars.js over war-matchmaking.js) pairs two coin
// communities and seals the pairing into an HMAC-signed ticket
// (api/_lib/war-ticket.js). This process re-derives the signature with the same
// shared secret and checks it, so ClashRoom can take the two competing factions
// from the TICKET rather than from whichever client happened to create the room.
//
// Without this the room would trust client-supplied faction identities: whoever
// joined a matchKey first would define both sides of a battle whose result lands
// in the league ledger. Keep byte-for-byte compatible with the signer.

import crypto from 'node:crypto';
import { parseMatchKey } from './war-matchmaking.js';

const DEV_SECRET = 'three-ws-war-ticket-dev-secret';

let _warned = false;
function secret() {
	const s = process.env.WAR_TICKET_SECRET || process.env.WAR_RESULT_SECRET || process.env.HOLDER_PASS_SECRET;
	if (s) return s;
	// Fail closed in production: verifying against a publicly-known secret would
	// let anyone open an arena naming any two communities.
	if (process.env.NODE_ENV === 'production') {
		throw new Error(
			'[war-ticket] WAR_TICKET_SECRET (or WAR_RESULT_SECRET / HOLDER_PASS_SECRET) is required in production, refusing to verify tickets with the dev secret.',
		);
	}
	if (!_warned) {
		_warned = true;
		console.warn('[war-ticket] no ticket secret set, verifying with the insecure dev secret (development only).');
	}
	return DEV_SECRET;
}

function b64url(buf) {
	return Buffer.from(buf).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function hmac(body) {
	return b64url(crypto.createHmac('sha256', secret()).update(body).digest());
}

function safeEqual(a, b) {
	const ba = Buffer.from(a);
	const bb = Buffer.from(b);
	if (ba.length !== bb.length) return false;
	return crypto.timingSafeEqual(ba, bb);
}

function okFaction(f) {
	return !!f && typeof f.mint === 'string' && f.mint.length >= 32 && f.mint.length <= 64
		&& typeof f.name === 'string' && typeof f.symbol === 'string' && typeof f.image === 'string';
}

/**
 * Verify a war ticket and return its pairing, or null when the token is missing,
 * malformed, tampered with, expired, or does not describe the match its own key
 * names (a ticket signed for one matchup can never open another).
 * @param {unknown} token
 * @returns {{ matchKey:string, network:string, a:object, b:object, iat:number, exp:number } | null}
 */
export function verifyWarTicket(token) {
	if (typeof token !== 'string' || token.length < 16 || token.length > 4096) return null;
	const dot = token.indexOf('.');
	if (dot <= 0) return null;
	const body = token.slice(0, dot);
	const sig = token.slice(dot + 1);
	if (!safeEqual(sig, hmac(body))) return null;

	let payload;
	try {
		payload = JSON.parse(Buffer.from(body.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
	} catch {
		return null;
	}
	if (!payload || typeof payload !== 'object' || payload.k !== 'war') return null;
	if (typeof payload.exp !== 'number' || payload.exp * 1000 < Date.now()) return null;
	const now = Date.now() / 1000;
	if (typeof payload.iat !== 'number' || payload.iat > now + 60) return null;
	// Reject a tampered lifetime the same way holder passes do: a ticket may never
	// outlive the issuer's TTL even if the signature somehow verified.
	if (payload.exp - payload.iat > 15 * 60) return null;
	if (!okFaction(payload.a) || !okFaction(payload.b)) return null;
	if (payload.a.mint === payload.b.mint) return null;

	// The key and the payload must agree. This is the check that makes the ticket
	// meaningful: the room is keyed by matchKey, so a ticket whose factions differ
	// from the ones its key encodes would let a signed pairing be replayed into a
	// different arena.
	const parsed = parseMatchKey(payload.matchKey);
	if (!parsed) return null;
	if (parsed.mints[0] !== payload.a.mint || parsed.mints[1] !== payload.b.mint) return null;
	if (typeof payload.network !== 'string' || payload.network !== parsed.network) return null;

	return payload;
}
