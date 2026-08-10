// Clash persistence must survive a Redis outage. A configured Upstash client
// can still throw at call time (transport blip, over-quota 4xx, rotated token);
// before this guard those throws propagated to the HTTP wrapper, which
// classifies them as "database unavailable" and 503s the whole request — taking
// the live Clash state + leaderboard reads dark on a recoverable hiccup. The
// store must instead degrade to its in-memory model and keep answering.
import { describe, it, expect, vi, beforeEach } from 'vitest';

// A configured-but-broken Redis: every command rejects, the way Upstash does
// when the REST endpoint is unreachable or the account is over quota.
const boom = () => Promise.reject(Object.assign(new Error('fetch failed'), { name: 'TypeError' }));
const throwingRedis = {
	incrby: boom, expire: boom, set: boom, get: boom,
	zincrby: boom, zrange: boom, zscore: boom, hmget: boom, hset: boom,
};

vi.mock('../api/_lib/redis.js', () => ({ getRedis: () => throwingRedis }));

let store;
beforeEach(async () => {
	vi.resetModules();
	store = await import('../api/_lib/clash-store.js');
});

const MINT = 'FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump';

describe('clash-store resilience under a Redis outage', () => {
	it('factionPowers degrades to an empty map instead of throwing', async () => {
		await expect(store.factionPowers(42)).resolves.toEqual({});
	});

	it('getRecords degrades to neutral records instead of throwing', async () => {
		const recs = await store.getRecords([MINT]);
		expect(recs[MINT]).toEqual({ w: 0, l: 0, d: 0, battles: 0, power: 0 });
	});

	it('topSoldiers degrades to an empty list instead of throwing', async () => {
		await expect(store.topSoldiers({ epoch: 42, mint: MINT })).resolves.toEqual([]);
	});

	it('getMomentum / walletPower degrade to neutral values', async () => {
		await expect(store.getMomentum(MINT)).resolves.toBeNull();
		await expect(store.walletPower({ epoch: 42, mint: MINT, wallet: MINT })).resolves.toBe(0);
	});

	it('setMomentum tolerates a write failure without throwing', async () => {
		await expect(store.setMomentum(MINT, 1.2)).resolves.toBeUndefined();
	});

	it('factionPower degrades to zero instead of throwing', async () => {
		await expect(store.factionPower(42, MINT)).resolves.toBe(0);
	});

	it('the price snapshot degrades to a cache miss and an absorbed write', async () => {
		await expect(store.getPrice(MINT)).resolves.toBeNull();
		await expect(
			store.setPrice(MINT, { spot: 1, at: 2, base: 1, baseAt: 2 }, 60),
		).resolves.toBeUndefined();
		// The write landed in the in-memory model, so the next read still answers.
		await expect(store.getPrice(MINT)).resolves.toEqual({ spot: 1, at: 2, base: 1, baseAt: 2 });
	});

	it('addPower falls back to the in-memory tally instead of throwing', async () => {
		const r = await store.addPower({ epoch: 42, mint: MINT, wallet: MINT, amount: 5, walletCap: 100 });
		expect(r.added).toBe(5);
		expect(r.walletTotal).toBe(5);
		expect(r.capped).toBe(false);
	});

	it('settleRound tolerates a Redis outage without throwing', async () => {
		const matchmake = (mints) => ({ battles: mints.length >= 2 ? [{ a: mints[0], b: mints[1] }] : [] });
		await expect(store.settleRound(7, matchmake)).resolves.toMatchObject({ settled: expect.any(Boolean) });
	});
});
