// War ticket — a short-lived, HMAC-signed pairing the Coin Wars arena trusts.
//
// Why this exists: ClashRoom is defined with filterBy(['matchKey']), so whoever
// joins a key FIRST also creates the room, and the room reads the two competing
// communities (mint, name, symbol, image) out of that first client's join
// options. Left unsigned, a fighter could open a room claiming any opponent they
// liked and post a league result against a community that never turned up.
//
// So the pairing is decided here, on the API side, by the matchmaker
// (multiplayer/src/war-matchmaking.js over the shared queue), and sealed into a
// ticket. The game server verifies it with nothing but a shared secret and takes
// the faction identities from the TICKET, never from the client. Same trust
// model as holder-pass.js, one layer up: the holder pass proves *you may fight
// for this coin*, the war ticket proves *this is a real match between these two*.
//
// Format: base64url(JSON(payload)) + '.' + base64url(HMAC-SHA256(body)).
// Payload: { k:'war', matchKey, network, a:{…}, b:{…}, iat, exp }. Verification
// lives in multiplayer/src/war-ticket.js, byte-for-byte compatible with sign().

import crypto from 'node:crypto';
import { mintMatchKey, parseMatchKey, orderMints } from '../../multiplayer/src/war-matchmaking.js';

// Lifetime of a ticket. Matches the pairing window in war-matchmaking.js
// (PAIR_TTL_MS) so a ticket never outlives the queue entry that produced it, and
// a player who parks the arena tab for an hour re-queues rather than dropping
// into a battle nobody else is still waiting for.
export const TICKET_TTL_S = 10 * 60;

const DEV_SECRET = 'three-ws-war-ticket-dev-secret';

let _warned = false;
function secret() {
	// WAR_RESULT_SECRET already exists for the result-reporting direction; reuse it
	// (then HOLDER_PASS_SECRET) so a deployment that has either one gets a working
	// arena without a third secret to provision.
	const s = process.env.WAR_TICKET_SECRET || process.env.WAR_RESULT_SECRET || process.env.HOLDER_PASS_SECRET;
	if (s) return s;
	if (process.env.NODE_ENV === 'production') {
		throw new Error(
			'[war-ticket] WAR_TICKET_SECRET (or WAR_RESULT_SECRET / HOLDER_PASS_SECRET) is required in production — refusing to mint tickets with the dev secret.',
		);
	}
	if (!_warned) {
		_warned = true;
		console.warn(
			'[war-ticket] no ticket secret set — using the insecure dev secret. ' +
				'Set WAR_TICKET_SECRET in production or a war pairing can be forged.',
		);
	}
	return DEV_SECRET;
}

function b64url(buf) {
	return Buffer.from(buf).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function hmac(body) {
	return b64url(crypto.createHmac('sha256', secret()).update(body).digest());
}

function faction(coin) {
	return {
		mint: String(coin?.mint || ''),
		name: clip(coin?.name, 48) || clip(coin?.symbol, 16) || 'Community',
		symbol: clip(coin?.symbol, 16),
		image: clip(coin?.image, 400),
	};
}

function clip(v, max) {
	return typeof v === 'string' ? v.replace(/[\u0000-\u001f]/g, '').trim().slice(0, max) : '';
}

/**
 * Seal one pairing into a ticket. The two factions are stored in the SAME
 * canonical order the matchKey encodes (lower mint is A), so every ticket for a
 * given key describes the same match no matter which side asked for it, and the
 * arena's A/B scoreboard reads identically in both worlds.
 * @param {{ matchKey: string, network?: string, coinA: object, coinB: object }} pairing
 * @returns {string|null} the ticket, or null when the pairing is not a real match
 */
export function signWarTicket({ matchKey, network = 'mainnet', coinA, coinB }) {
	const parsed = parseMatchKey(matchKey);
	if (!parsed) return null;
	const a = faction(coinA);
	const b = faction(coinB);
	if (!a.mint || !b.mint || a.mint === b.mint) return null;
	const [lo] = orderMints(a.mint, b.mint);
	// Canonical order: A is the lower mint, which is exactly what the key encodes.
	const [first, second] = lo === a.mint ? [a, b] : [b, a];
	if (first.mint !== parsed.mints[0] || second.mint !== parsed.mints[1]) return null;

	const now = Math.floor(Date.now() / 1000);
	const payload = {
		k: 'war',
		matchKey,
		network: parsed.network || String(network || 'mainnet'),
		a: first,
		b: second,
		iat: now,
		exp: now + TICKET_TTL_S,
	};
	const body = b64url(JSON.stringify(payload));
	return `${body}.${hmac(body)}`;
}

// Re-exported so the endpoint mints keys and tickets from one import, and so the
// key format has exactly one owner (war-matchmaking.js).
export { mintMatchKey, parseMatchKey };
