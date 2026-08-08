// Unit tests for Coin Wars matchmaking: the pure pairing math that decides which
// two communities meet in one arena (multiplayer/src/war-matchmaking.js), and the
// signed ticket that stops a fighter from inventing the opponent
// (api/_lib/war-ticket.js signs, multiplayer/src/war-ticket.js verifies).
//
// Both are dependency-free, so they run without Redis, a Colyseus room, or a
// browser — the same isolation clash.js and war-standings.js already rely on.

import { describe, it, expect } from 'vitest';
import {
	joinQueue, leaveQueue, waitingCommunities, mintMatchKey, parseMatchKey,
	matchKeyNames, sideOf, entryLive, orderMints, QUEUE_TTL_MS, PAIR_TTL_MS,
} from '../multiplayer/src/war-matchmaking.js';
import { signWarTicket } from '../api/_lib/war-ticket.js';
import { verifyWarTicket } from '../multiplayer/src/war-ticket.js';

// Two synthetic mints of a realistic length. ALPHA sorts below BRAVO, so ALPHA is
// always faction A — that ordering is the whole point of the key format.
const ALPHA = 'ALPHAsynthetic11111111111111111111111111111';
const BRAVO = 'BRAVOsynthetic11111111111111111111111111111';
const CHARLIE = 'CHARLIEsynthetic111111111111111111111111111';

const coin = (mint, symbol) => ({ mint, name: `${symbol} Community`, symbol, image: '' });
const T0 = 1_770_000_000_000;

describe('matchKey format', () => {
	it('is identical whichever community mints it', () => {
		const one = mintMatchKey({ mintA: ALPHA, mintB: BRAVO, slot: T0 });
		const two = mintMatchKey({ mintA: BRAVO, mintB: ALPHA, slot: T0 });
		expect(one).toBe(two);
	});

	it('names its two communities and nobody else', () => {
		const key = mintMatchKey({ mintA: ALPHA, mintB: BRAVO, slot: T0 });
		expect(matchKeyNames(key, ALPHA, BRAVO)).toBe(true);
		expect(matchKeyNames(key, BRAVO, ALPHA)).toBe(true);
		expect(matchKeyNames(key, ALPHA, CHARLIE)).toBe(false);
	});

	it('puts the lower mint on side a', () => {
		const key = mintMatchKey({ mintA: BRAVO, mintB: ALPHA, slot: T0 });
		expect(orderMints(BRAVO, ALPHA)).toEqual([ALPHA, BRAVO]);
		expect(sideOf(key, ALPHA)).toBe('a');
		expect(sideOf(key, BRAVO)).toBe('b');
		expect(sideOf(key, CHARLIE)).toBe(null);
	});

	it('gives a rematch its own key so a finished room never absorbs it', () => {
		const first = mintMatchKey({ mintA: ALPHA, mintB: BRAVO, slot: T0 });
		const second = mintMatchKey({ mintA: ALPHA, mintB: BRAVO, slot: T0 + 60_000 });
		expect(second).not.toBe(first);
	});

	it('refuses a community fighting itself, or a mint that is not one', () => {
		expect(mintMatchKey({ mintA: ALPHA, mintB: ALPHA, slot: T0 })).toBe(null);
		expect(mintMatchKey({ mintA: 'short', mintB: BRAVO, slot: T0 })).toBe(null);
	});

	it('rejects a hand-crafted key', () => {
		expect(parseMatchKey('w1:mainnet:' + ALPHA + ':' + BRAVO)).toBe(null);       // too few parts
		expect(parseMatchKey('w9:mainnet:' + ALPHA + ':' + BRAVO + ':abc')).toBe(null); // wrong version
		expect(parseMatchKey('w1:mainnet:' + BRAVO + ':' + ALPHA + ':abc')).toBe(null); // unordered mints
		expect(parseMatchKey(42)).toBe(null);
	});
});

describe('joinQueue', () => {
	it('parks the first community and pairs the second', () => {
		const first = joinQueue({ queue: [], coin: coin(ALPHA, 'ALPHA'), now: T0 });
		expect(first.status).toBe('waiting');
		expect(first.matchKey).toBe(null);
		expect(first.waiting).toBe(1);

		const second = joinQueue({ queue: first.queue, coin: coin(BRAVO, 'BRAVO'), now: T0 + 1000 });
		expect(second.status).toBe('matched');
		expect(second.matchKey).toBeTruthy();
		expect(second.opponent.mint).toBe(ALPHA);
		expect(second.side).toBe('b');
	});

	it('hands the first community the same key when it polls back', () => {
		const first = joinQueue({ queue: [], coin: coin(ALPHA, 'ALPHA'), now: T0 });
		const second = joinQueue({ queue: first.queue, coin: coin(BRAVO, 'BRAVO'), now: T0 + 1000 });
		const poll = joinQueue({ queue: second.queue, coin: coin(ALPHA, 'ALPHA'), now: T0 + 2000 });

		expect(poll.status).toBe('paired');
		expect(poll.matchKey).toBe(second.matchKey);
		expect(poll.side).toBe('a');
		expect(poll.opponent.mint).toBe(BRAVO);
	});

	it('never pairs a community with itself', () => {
		const first = joinQueue({ queue: [], coin: coin(ALPHA, 'ALPHA'), now: T0 });
		const again = joinQueue({ queue: first.queue, coin: coin(ALPHA, 'ALPHA'), now: T0 + 5000 });
		expect(again.status).toBe('waiting');
		expect(again.queue).toHaveLength(1);
	});

	it('pairs the community that has waited longest', () => {
		// Two unpaired entries at once is a real state: concurrent writers on
		// different worlds can both take a place in line before either pairs.
		const queue = [
			{ ...coin(CHARLIE, 'CHAR'), network: 'mainnet', at: T0 + 5000, matchKey: null, opponent: null },
			{ ...coin(ALPHA, 'ALPHA'), network: 'mainnet', at: T0, matchKey: null, opponent: null },
		];
		const matched = joinQueue({ queue, coin: coin(BRAVO, 'BRAVO'), now: T0 + 9000 });
		expect(matched.status).toBe('matched');
		expect(matched.opponent.mint).toBe(ALPHA);
		// CHARLIE is untouched and still looking for a fight.
		expect(waitingCommunities({ queue: matched.queue, now: T0 + 9001 }).map((c) => c.mint)).toEqual([CHARLIE]);
	});

	it('ignores a community that walked away', () => {
		const stale = joinQueue({ queue: [], coin: coin(ALPHA, 'ALPHA'), now: T0 });
		const later = joinQueue({ queue: stale.queue, coin: coin(BRAVO, 'BRAVO'), now: T0 + QUEUE_TTL_MS + 1 });
		expect(later.status).toBe('waiting');
		expect(later.queue.map((e) => e.mint)).toEqual([BRAVO]);
	});

	it('keeps a pairing claimable for longer than a bare wait', () => {
		const paired = { mint: ALPHA, at: T0, matchKey: 'w1:mainnet:x:y:z' };
		const waiting = { mint: BRAVO, at: T0 };
		expect(entryLive(waiting, T0 + QUEUE_TTL_MS + 1)).toBe(false);
		expect(entryLive(paired, T0 + QUEUE_TTL_MS + 1)).toBe(true);
		expect(entryLive(paired, T0 + PAIR_TTL_MS + 1)).toBe(false);
	});

	it('refuses a mint that is not one', () => {
		const res = joinQueue({ queue: [], coin: { mint: 'nope' }, now: T0 });
		expect(res.status).toBe('invalid');
	});

	it('keeps networks apart', () => {
		const main = joinQueue({ queue: [], coin: coin(ALPHA, 'ALPHA'), network: 'mainnet', now: T0 });
		const dev = joinQueue({ queue: main.queue, coin: coin(BRAVO, 'BRAVO'), network: 'devnet', now: T0 + 1000 });
		expect(dev.status).toBe('waiting');
	});
});

describe('leaveQueue / waitingCommunities', () => {
	it('drops the leaver and prunes the stale in one pass', () => {
		const queue = [
			{ ...coin(ALPHA, 'ALPHA'), network: 'mainnet', at: T0, matchKey: null, opponent: null },
			{ ...coin(CHARLIE, 'CHAR'), network: 'mainnet', at: T0 - QUEUE_TTL_MS - 1, matchKey: null, opponent: null },
		];
		// ALPHA walks away; CHARLIE's entry was already dead and goes with it.
		expect(leaveQueue({ queue, mint: ALPHA, now: T0 + 10 })).toEqual([]);
	});

	it('lists only communities still looking for an opponent', () => {
		const first = joinQueue({ queue: [], coin: coin(ALPHA, 'ALPHA'), now: T0 });
		expect(waitingCommunities({ queue: first.queue, now: T0 + 10 })).toHaveLength(1);
		const second = joinQueue({ queue: first.queue, coin: coin(BRAVO, 'BRAVO'), now: T0 + 1000 });
		// Both are now paired, so neither is still waiting for someone.
		expect(waitingCommunities({ queue: second.queue, now: T0 + 1010 })).toHaveLength(0);
	});
});

describe('war ticket', () => {
	const key = mintMatchKey({ mintA: ALPHA, mintB: BRAVO, slot: T0 });

	it('round-trips a pairing in canonical order', () => {
		// Signed from BRAVO's side; the ticket still lists ALPHA as faction A,
		// because that is what the key encodes and what the arena scoreboard reads.
		const token = signWarTicket({ matchKey: key, coinA: coin(BRAVO, 'BRAVO'), coinB: coin(ALPHA, 'ALPHA') });
		const payload = verifyWarTicket(token);
		expect(payload).toBeTruthy();
		expect(payload.a.mint).toBe(ALPHA);
		expect(payload.b.mint).toBe(BRAVO);
		expect(payload.matchKey).toBe(key);
	});

	it('rejects a tampered signature', () => {
		const token = signWarTicket({ matchKey: key, coinA: coin(ALPHA, 'ALPHA'), coinB: coin(BRAVO, 'BRAVO') });
		expect(verifyWarTicket(token.slice(0, -2) + 'xx')).toBe(null);
	});

	it('rejects a tampered payload', () => {
		const token = signWarTicket({ matchKey: key, coinA: coin(ALPHA, 'ALPHA'), coinB: coin(BRAVO, 'BRAVO') });
		const [body, sig] = token.split('.');
		const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
		payload.b.mint = CHARLIE;
		const forged = `${Buffer.from(JSON.stringify(payload)).toString('base64url')}.${sig}`;
		expect(verifyWarTicket(forged)).toBe(null);
	});

	it('refuses to sign a pairing its key does not describe', () => {
		expect(signWarTicket({ matchKey: key, coinA: coin(ALPHA, 'ALPHA'), coinB: coin(CHARLIE, 'CHAR') })).toBe(null);
		expect(signWarTicket({ matchKey: 'not-a-key', coinA: coin(ALPHA, 'ALPHA'), coinB: coin(BRAVO, 'BRAVO') })).toBe(null);
	});

	it('rejects junk', () => {
		expect(verifyWarTicket('')).toBe(null);
		expect(verifyWarTicket(null)).toBe(null);
		expect(verifyWarTicket('a.b')).toBe(null);
	});
});
