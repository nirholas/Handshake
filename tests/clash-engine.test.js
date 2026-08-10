// Coin Clash engine (api/_lib/clash.js) - the pure math every stateless
// instance has to agree on, plus the two secrets the HTTP surface trusts.
//
// Matchmaking is derived, not stored: if two boxes disagree on the bracket for
// a round, one of them settles the wrong battle. The enlist challenge and the
// war pass are the only things standing between a rally and a forged one, so
// their tamper paths matter as much as their happy paths.
import { describe, it, expect } from 'vitest';
import {
	epochAt,
	epochWindow,
	matchmake,
	battleId,
	momentumFactor,
	buildChallenge,
	verifyChallenge,
	signWarPass,
	verifyWarPass,
	priceIsStale,
	rollPrice,
	priceChangePct,
	PRICE_SPOT_TTL_MS,
	PRICE_BASELINE_MS,
	EPOCH_MS,
	MOMENTUM_MIN,
	MOMENTUM_MAX,
} from '../api/_lib/clash.js';

const THREE = 'FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump';
const WALLET = '8puvqEvxasTqFWoYT5eVVMDB5Bx7F3ANBuHorJyGYQnz';

describe('epoch math', () => {
	it('is monotonic and partitions time into fixed rounds', () => {
		const t = epochAt(1_700_000_000_000) * EPOCH_MS; // aligned to a round start
		expect(epochAt(t + EPOCH_MS)).toBe(epochAt(t) + 1);
		expect(epochAt(t)).toBe(epochAt(t + EPOCH_MS - 1));
	});

	it('reports the window and the time left inside it', () => {
		const epoch = epochAt(Date.now());
		const start = epoch * EPOCH_MS;
		const { end, msLeft } = epochWindow(epoch, start + 1000);
		expect(end).toBe(start + EPOCH_MS);
		expect(msLeft).toBe(EPOCH_MS - 1000);
	});

	it('clamps msLeft at zero once the round is over', () => {
		const epoch = epochAt(Date.now());
		expect(epochWindow(epoch, epoch * EPOCH_MS + EPOCH_MS * 2).msLeft).toBe(0);
	});
});

describe('matchmaking', () => {
	const pool = ['a', 'b', 'c', 'd', 'e', 'f'];

	it('is deterministic for a given roster and round', () => {
		expect(matchmake(pool, 99)).toEqual(matchmake(pool, 99));
	});

	it('pairs everyone exactly once with no bye on an even roster', () => {
		const { battles, bye } = matchmake(pool, 7);
		expect(bye).toBeNull();
		expect(battles).toHaveLength(3);
		expect(battles.flatMap((b) => [b.a, b.b]).sort()).toEqual([...pool].sort());
	});

	it('leaves exactly one faction with a bye on an odd roster', () => {
		const { battles, bye } = matchmake(pool.slice(0, 5), 7);
		expect(bye).toBeTruthy();
		expect(battles.flatMap((b) => [b.a, b.b])).not.toContain(bye);
	});

	it('rotates matchups across rounds instead of freezing one bracket', () => {
		const seen = new Set();
		for (let e = 0; e < 20; e++) {
			seen.add(JSON.stringify(matchmake(pool, e).battles.map((b) => b.id)));
		}
		expect(seen.size).toBeGreaterThan(1);
	});

	it('a roster too small to fight yields no battles', () => {
		expect(matchmake(['solo'], 1)).toEqual({ battles: [], bye: 'solo' });
		expect(matchmake([], 1)).toEqual({ battles: [], bye: null });
	});

	it('battle ids are order-independent so both sides resolve the same key', () => {
		expect(battleId(5, 'a', 'b')).toBe(battleId(5, 'b', 'a'));
		expect(battleId(5, 'a', 'b')).not.toBe(battleId(6, 'a', 'b'));
	});
});

describe('momentum factor', () => {
	it('a faction with no signals fights at the floor', () => {
		expect(momentumFactor({})).toBe(MOMENTUM_MIN);
	});

	it('stays inside the band even when every signal is maxed', () => {
		const f = momentumFactor({ members: 1e9, latestPostAt: Date.now(), priceChange: 5000 });
		expect(f).toBeLessThanOrEqual(MOMENTUM_MAX);
		expect(f).toBeGreaterThan(MOMENTUM_MIN);
	});

	it('a live market move raises the factor', () => {
		const base = { members: 500, latestPostAt: Date.now() };
		expect(momentumFactor({ ...base, priceChange: 40 })).toBeGreaterThan(momentumFactor(base));
	});

	it('a dump never drags a faction below the floor', () => {
		expect(momentumFactor({ priceChange: -90 })).toBe(MOMENTUM_MIN);
	});

	it('a stale community loses its recency credit', () => {
		const old = Date.now() - 30 * 24 * 3_600_000;
		expect(momentumFactor({ latestPostAt: old })).toBeLessThan(
			momentumFactor({ latestPostAt: Date.now() }),
		);
	});
});

describe('price snapshot', () => {
	const now = 1_700_000_000_000;

	it('treats a missing or aged snapshot as stale', () => {
		expect(priceIsStale(null, now)).toBe(true);
		expect(priceIsStale({ spot: 1, at: now - PRICE_SPOT_TTL_MS }, now)).toBe(true);
		expect(priceIsStale({ spot: 1, at: now - 1 }, now)).toBe(false);
	});

	it('seeds the baseline on the first priced sample, so the first move is flat', () => {
		const snap = rollPrice(null, 0.004, now);
		expect(snap).toEqual({ spot: 0.004, at: now, base: 0.004, baseAt: now });
		expect(priceChangePct(snap)).toBe(0);
	});

	it('measures a later spot against the retained baseline', () => {
		const seeded = rollPrice(null, 2, now);
		const later = rollPrice(seeded, 3, now + PRICE_SPOT_TTL_MS);
		expect(later.base).toBe(2);
		expect(priceChangePct(later)).toBeCloseTo(50, 6);
	});

	it('rolls the baseline forward once it is a day old', () => {
		const seeded = rollPrice(null, 2, now);
		const rolled = rollPrice(seeded, 3, now + PRICE_BASELINE_MS);
		expect(rolled.base).toBe(3);
		expect(rolled.baseAt).toBe(now + PRICE_BASELINE_MS);
		expect(priceChangePct(rolled)).toBe(0);
	});

	it('an unpriceable mint keeps no baseline and reports no move', () => {
		const snap = rollPrice(null, 0, now);
		expect(snap.base).toBe(0);
		expect(priceChangePct(snap)).toBeNull();
		expect(priceChangePct(null)).toBeNull();
	});
});

describe('enlist challenge', () => {
	const now = Date.now();

	it('round-trips a challenge bound to one wallet and one faction', () => {
		const { message } = buildChallenge({ wallet: WALLET, mint: THREE, now });
		expect(verifyChallenge({ message, wallet: WALLET, mint: THREE, now })).toBe(true);
	});

	it('rejects a challenge replayed for another wallet or another faction', () => {
		const { message } = buildChallenge({ wallet: WALLET, mint: THREE, now });
		expect(verifyChallenge({ message, wallet: 'someoneElse', mint: THREE, now })).toBe(false);
		expect(verifyChallenge({ message, wallet: WALLET, mint: 'OtherMint', now })).toBe(false);
	});

	it('rejects a tampered body even when the tag is left intact', () => {
		const { message } = buildChallenge({ wallet: WALLET, mint: THREE, now });
		const tampered = message.replace('soldier:', 'soldiers:');
		expect(verifyChallenge({ message: tampered, wallet: WALLET, mint: THREE, now })).toBe(false);
	});

	it('rejects an expired challenge and a future-dated one', () => {
		const { message } = buildChallenge({ wallet: WALLET, mint: THREE, now });
		expect(verifyChallenge({ message, wallet: WALLET, mint: THREE, now: now + 6 * 60_000 })).toBe(false);
		expect(verifyChallenge({ message, wallet: WALLET, mint: THREE, now: now - 5 * 60_000 })).toBe(false);
	});

	it('rejects anything that is not one of our messages', () => {
		expect(verifyChallenge({ message: 'sign this', wallet: WALLET, mint: THREE, now })).toBe(false);
		expect(verifyChallenge({ message: null, wallet: WALLET, mint: THREE, now })).toBe(false);
	});
});

describe('war pass', () => {
	it('round-trips the enlistment the rally path needs', () => {
		const pass = signWarPass({ wallet: WALLET, mint: THREE, amount: 1234.5, usd: 9.129 });
		expect(verifyWarPass(pass)).toMatchObject({
			wallet: WALLET,
			mint: THREE,
			amount: 1234.5,
			usd: 9.13,
			tier: 'clash',
		});
	});

	it('rejects a forged tag, a swapped body, and structural junk', () => {
		const pass = signWarPass({ wallet: WALLET, mint: THREE });
		const [body] = pass.split('.');
		expect(verifyWarPass(`${body}.notthetag`)).toBeNull();
		expect(verifyWarPass(`X${pass.slice(1)}`)).toBeNull();
		expect(verifyWarPass('nodot')).toBeNull();
		expect(verifyWarPass('')).toBeNull();
		expect(verifyWarPass(null)).toBeNull();
	});

	it('rejects a pass re-tagged for another surface', () => {
		const pass = signWarPass({ wallet: WALLET, mint: THREE });
		const [body, tag] = pass.split('.');
		const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
		const swapped = Buffer.from(JSON.stringify({ ...payload, tier: 'holder' })).toString('base64url');
		expect(verifyWarPass(`${swapped}.${tag}`)).toBeNull();
	});

	it('seals an expiry so a dumped holder cannot rally forever', () => {
		const pass = signWarPass({ wallet: WALLET, mint: THREE });
		const payload = verifyWarPass(pass);
		expect(payload.exp).toBeGreaterThan(Math.floor(Date.now() / 1000));
		expect(payload.exp - payload.iat).toBe(30 * 60);
	});
});
