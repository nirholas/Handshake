// War matchmaking, the pure pairing math behind the Coin Wars portal.
//
// A player standing in their coin's world presses "Enter the war". That queues
// their community. When a SECOND community is waiting, the two are paired and
// both sides are handed the SAME `matchKey`, which is what actually puts them in
// one arena: ClashRoom is defined with filterBy(['matchKey']), so every fighter
// carrying a given key lands in the same room instance.
//
// This module owns three things and nothing else:
//   • the matchKey format (mint it, parse it, verify it names two given mints)
//   • the queue fold: given the current queue and a joining community, decide
//     whether this is a pairing or a wait, and produce the next queue
//   • the staleness rule that keeps a queue from pairing someone who walked away
//
// Pure and dependency-free, like clash.js and war-standings.js, so the pairing
// rules are unit-testable without Redis, a room, or a browser. The API layer
// (api/_lib/wars-store.js) supplies the stored queue and persists what comes
// back; ClashRoom trusts the key only after the signed ticket (war-ticket.js)
// proves the API minted it.

// How long a queued community stays live. Long enough to survive a slow avatar
// load and a holder-pass round trip, short enough that a player who closed the
// tab is not still "waiting" when someone else walks up two minutes later.
export const QUEUE_TTL_MS = 90_000;

// How long a pairing stays claimable after it is made. A paired entry lives a
// little longer than an unpaired one so the second side can poll, load the arena
// page, and join without the pairing evaporating underneath them.
export const PAIR_TTL_MS = 10 * 60_000;

const KEY_VERSION = 'w1';
const MINT_RE = /^[A-Za-z0-9]{32,64}$/;

// Canonical faction order for a pair of mints. Both sides of a match derive the
// SAME key regardless of who queued first, which is the whole point: the key is
// the rendezvous, so it cannot depend on arrival order.
export function orderMints(mintA, mintB) {
	return mintA < mintB ? [mintA, mintB] : [mintB, mintA];
}

/**
 * Mint the rendezvous key for one battle between two communities.
 * `slot` disambiguates repeat matchups: the same two coins fighting again later
 * get a different key, so the ledger's per-matchKey uniqueness still holds and a
 * finished room never absorbs the next battle's fighters.
 * @param {{network?:string, mintA:string, mintB:string, slot:number|string}} args
 * @returns {string|null} the key, or null when the inputs cannot name a match
 */
export function mintMatchKey({ network = 'mainnet', mintA, mintB, slot }) {
	if (!isMint(mintA) || !isMint(mintB) || mintA === mintB) return null;
	const net = cleanNetwork(network);
	const [lo, hi] = orderMints(mintA, mintB);
	const tag = slotTag(slot);
	if (!tag) return null;
	return `${KEY_VERSION}:${net}:${lo}:${hi}:${tag}`;
}

/**
 * Parse a matchKey back into the match it names. Returns null for anything this
 * module did not mint, so a hand-crafted key can never open a room.
 * @param {unknown} key
 * @returns {{network:string, mints:[string,string], slot:string}|null}
 */
export function parseMatchKey(key) {
	if (typeof key !== 'string' || key.length > 200) return null;
	const parts = key.split(':');
	if (parts.length !== 5) return null;
	const [version, network, lo, hi, slot] = parts;
	if (version !== KEY_VERSION) return null;
	if (!network || network !== cleanNetwork(network)) return null;
	if (!isMint(lo) || !isMint(hi) || lo >= hi) return null;
	if (!/^[a-z0-9]{1,16}$/.test(slot)) return null;
	return { network, mints: [lo, hi], slot };
}

// Does this key name a battle between exactly these two communities? ClashRoom
// asks this before trusting the faction identities a joining client declared, so
// a fighter cannot invent an opponent that the key does not describe.
export function matchKeyNames(key, mintA, mintB) {
	const parsed = parseMatchKey(key);
	if (!parsed) return false;
	const [lo, hi] = orderMints(String(mintA || ''), String(mintB || ''));
	return parsed.mints[0] === lo && parsed.mints[1] === hi;
}

// Which side of the key a mint sits on: 'a' is the lexicographically lower mint.
// Both the arena client and the portal read scores as A/B, so they need to agree
// with the room, which seats factions in the order the key implies.
export function sideOf(key, mint) {
	const parsed = parseMatchKey(key);
	if (!parsed) return null;
	if (parsed.mints[0] === mint) return 'a';
	if (parsed.mints[1] === mint) return 'b';
	return null;
}

// Is a queue entry still live at `now`? Paired entries get the longer window.
export function entryLive(entry, now) {
	if (!entry || typeof entry.at !== 'number') return false;
	const ttl = entry.matchKey ? PAIR_TTL_MS : QUEUE_TTL_MS;
	return now - entry.at < ttl;
}

/**
 * The queue fold. Given every stored entry and the community now asking to
 * fight, return the next queue and what to tell the caller.
 *
 * Four outcomes, in the order they are checked:
 *   'paired', this community was already matched by an earlier call (the
 *                other side queued first and paired with us); hand back the key.
 *   'matched', we just paired with a waiting community; both entries are
 *                stamped with the new key.
 *   'waiting', nobody else is queued; we are now the one waiting.
 *   'invalid', the community is not a coin we can seat.
 *
 * @param {object} args
 * @param {Array<object>} args.queue    stored entries (any staleness)
 * @param {object} args.coin            { mint, name, symbol, image }
 * @param {string} args.network
 * @param {number} args.now             epoch ms
 * @returns {{status:string, queue:Array<object>, entry:object|null, opponent:object|null,
 *            matchKey:string|null, side:string|null, waiting:number}}
 */
export function joinQueue({ queue = [], coin, network = 'mainnet', now = 0 }) {
	const mint = String(coin?.mint || '');
	const net = cleanNetwork(network);
	if (!isMint(mint)) {
		return { status: 'invalid', queue: liveOnly(queue, now), entry: null, opponent: null, matchKey: null, side: null, waiting: 0 };
	}

	const live = liveOnly(queue, now).filter((e) => e.network === net || !e.network);
	const mine = live.find((e) => e.mint === mint) || null;

	// Already paired by whoever queued second, nothing to do but report it.
	if (mine?.matchKey) {
		const rest = live.filter((e) => e.mint !== mint);
		return {
			status: 'paired',
			queue: live,
			entry: mine,
			opponent: mine.opponent || null,
			matchKey: mine.matchKey,
			side: sideOf(mine.matchKey, mint),
			waiting: rest.filter((e) => !e.matchKey).length,
		};
	}

	const identity = {
		mint,
		name: str(coin?.name, 48) || str(coin?.symbol, 16) || 'Community',
		symbol: str(coin?.symbol, 16),
		image: str(coin?.image, 400),
	};

	// The oldest unpaired community that is not us, first come, first fought.
	const rival = live
		.filter((e) => e.mint !== mint && !e.matchKey)
		.sort((x, y) => (x.at || 0) - (y.at || 0))[0] || null;

	if (rival) {
		const matchKey = mintMatchKey({ network: net, mintA: mint, mintB: rival.mint, slot: now });
		if (matchKey) {
			const rivalIdentity = { mint: rival.mint, name: rival.name, symbol: rival.symbol, image: rival.image };
			const nextMine = { ...identity, network: net, at: now, matchKey, opponent: rivalIdentity };
			const nextRival = { ...rival, network: net, at: now, matchKey, opponent: identity };
			const queueNext = live
				.filter((e) => e.mint !== mint && e.mint !== rival.mint)
				.concat([nextMine, nextRival]);
			return {
				status: 'matched',
				queue: queueNext,
				entry: nextMine,
				opponent: rivalIdentity,
				matchKey,
				side: sideOf(matchKey, mint),
				waiting: queueNext.filter((e) => !e.matchKey).length,
			};
		}
	}

	// Nobody to fight yet: take (or refresh) our place in line.
	const nextMine = { ...identity, network: net, at: now, matchKey: null, opponent: null };
	const queueNext = live.filter((e) => e.mint !== mint).concat([nextMine]);
	return {
		status: 'waiting',
		queue: queueNext,
		entry: nextMine,
		opponent: null,
		matchKey: null,
		side: null,
		waiting: queueNext.filter((e) => !e.matchKey).length,
	};
}

// Drop one community from the queue (they backed out of the portal). Returns the
// next queue; stale entries are pruned in the same pass so a cancel also tidies.
export function leaveQueue({ queue = [], mint, now = 0 }) {
	return liveOnly(queue, now).filter((e) => e.mint !== String(mint || ''));
}

// The queue as a player should see it: live, unpaired communities waiting for an
// opponent, oldest first. This is what the portal board renders as "waiting".
export function waitingCommunities({ queue = [], network = 'mainnet', now = 0 }) {
	const net = cleanNetwork(network);
	return liveOnly(queue, now)
		.filter((e) => !e.matchKey && (e.network === net || !e.network))
		.sort((x, y) => (x.at || 0) - (y.at || 0))
		.map((e) => ({ mint: e.mint, name: e.name, symbol: e.symbol, image: e.image, since: e.at }));
}

// --- internals --------------------------------------------------------------

function liveOnly(queue, now) {
	return (Array.isArray(queue) ? queue : []).filter((e) => entryLive(e, now));
}

function isMint(v) {
	return typeof v === 'string' && MINT_RE.test(v);
}

function cleanNetwork(v) {
	const s = String(v || 'mainnet').toLowerCase();
	return /^[a-z]{1,12}$/.test(s) ? s : 'mainnet';
}

function slotTag(slot) {
	const n = Number(slot);
	if (Number.isFinite(n) && n > 0) return Math.floor(n).toString(36).slice(-10);
	const s = String(slot || '').toLowerCase();
	return /^[a-z0-9]{1,16}$/.test(s) ? s : null;
}

function str(v, max) {
	return typeof v === 'string' ? v.replace(/[\u0000-\u001f]/g, '').trim().slice(0, max) : '';
}
