// Marketplace (Task 20) — the durable listing/payout store and the token quote
// primitives the on-chain settlement depends on. The store is exercised against a
// mocked @upstash/redis (same harness as player-store.test) so the durability +
// no-dupe invariants are proven without real credentials, and the token layer's
// quote sign/verify + 95/5 split are unit-checked.
//
// What matters for the task:
//   - a listing's escrow lives on the store, survives a simulated restart, and a
//     drained payout is removed atomically (delivered exactly once — no dupe/loss),
//   - a consumed on-chain signature is remembered so a token payment can't replay,
//   - a USD price quotes to a tamper-proof, expiring signed quote,
//   - the 95/5 split always sums back to the exact total.

import { describe, it, expect, beforeEach, vi } from 'vitest';

const redis = vi.hoisted(() => ({ store: new Map(), pingFails: false }));

vi.mock('@upstash/redis', () => ({
	Redis: class {
		async ping() { if (redis.pingFails) throw new Error('unreachable'); return 'PONG'; }
		async get(k) { return redis.store.has(k) ? redis.store.get(k) : null; }
		async set(k, v) { redis.store.set(k, v); return 'OK'; }
		async del(k) { return redis.store.delete(k) ? 1 : 0; }
	},
}));

async function freshStore({ durable = true } = {}) {
	vi.resetModules();
	if (durable) {
		process.env.UPSTASH_REDIS_REST_URL = 'http://mock-upstash';
		process.env.UPSTASH_REDIS_REST_TOKEN = 'mock-token';
	} else {
		delete process.env.UPSTASH_REDIS_REST_URL;
		delete process.env.UPSTASH_REDIS_REST_TOKEN;
	}
	return import('../multiplayer/src/marketplaceStore.js');
}

beforeEach(() => { redis.store.clear(); redis.pingFails = false; });

describe('MarketplaceStore — listings + escrow', () => {
	it('creates active listings and surfaces them by recency + by seller', async () => {
		const { marketplaceStore: m } = await freshStore({ durable: false });
		const a = m.create({ seller: 'alice', sellerName: 'Alice', type: 'gold', item: 'wood', qty: 50, priceGold: 100 });
		const b = m.create({ seller: 'bob', sellerName: 'Bob', type: 'goldForToken', goldAmount: 1000, priceUsd: 1.5, sellerWallet: 'bob' });
		expect(a.status).toBe('active');
		expect(m.activeListings().map((l) => l.id)).toContain(a.id);
		expect(m.listingsBySeller('alice')).toHaveLength(1);
		// Closing one drops it from the active board but keeps it on the seller's list.
		m.update(a.id, { status: 'cancelled', closedAt: Date.now() });
		expect(m.activeListings().map((l) => l.id)).not.toContain(a.id);
		expect(m.listingsBySeller('alice')).toHaveLength(1);
		expect(m.get(b.id).status).toBe('active');
	});

	it('delivers a queued payout exactly once (no dupe, no loss)', async () => {
		const { marketplaceStore: m } = await freshStore({ durable: false });
		m.enqueuePayout('alice', { gold: 250, reason: 'sold wood' });
		m.enqueuePayout('alice', { gold: 50, reason: 'sold fish' });
		expect(m.hasPendingPayouts('alice')).toBe(true);
		const first = m.drainPayouts('alice');
		expect(first.reduce((s, p) => s + p.gold, 0)).toBe(300);
		// A second drain (e.g. a presence nudge racing the login) yields nothing.
		expect(m.drainPayouts('alice')).toEqual([]);
		expect(m.hasPendingPayouts('alice')).toBe(false);
	});

	it('remembers a consumed tx signature so a token payment cannot replay', async () => {
		const { marketplaceStore: m } = await freshStore({ durable: false });
		expect(m.isSettled('sigABC')).toBe(false);
		m.markSettled('sigABC');
		expect(m.isSettled('sigABC')).toBe(true);
	});
});

describe('MarketplaceStore (durable / Upstash)', () => {
	it('persists active listings + payouts across a simulated restart', async () => {
		const a = await freshStore();
		await a.marketplaceStore.ready();
		const rec = a.marketplaceStore.create({ seller: 'alice', sellerName: 'Alice', type: 'gold', item: 'coal', qty: 12, priceGold: 80 });
		a.marketplaceStore.enqueuePayout('bob', { gold: 999, reason: 'sale' });
		a.marketplaceStore.markSettled('sig1');
		await a.marketplaceStore.flushAll();
		expect(redis.store.has('market:listings')).toBe(true);

		// Process B (fresh store, same Redis) hydrates the board on boot.
		const b = await freshStore();
		await b.marketplaceStore.ready();
		expect(b.marketplaceStore.get(rec.id)?.priceGold).toBe(80);
		expect(b.marketplaceStore.activeListings().map((l) => l.id)).toContain(rec.id);
		expect(b.marketplaceStore.hasPendingPayouts('bob')).toBe(true);
		expect(b.marketplaceStore.isSettled('sig1')).toBe(true);
	});
});

describe('Game token — quote sign/verify + split', () => {
	it('splits a total 95/5 with no remainder lost', async () => {
		const { splitAmount } = await import('../multiplayer/src/game-token.js');
		for (const total of [1_000_000n, 999_999n, 7n, 123_456_789n]) {
			const { seller, treasury } = splitAmount(total, 500);
			expect(seller + treasury).toBe(total);          // nothing created or lost
			expect(treasury).toBe((total * 500n) / 10000n);  // exact 5%
		}
	});

	it('signs a quote that verifies and rejects tampering', async () => {
		const { signQuote, verifyQuote } = await import('../multiplayer/src/game-token.js');
		const token = signQuote({ listingId: 'lst_1', buyer: 'B', sellerWallet: 'S', usd: 2, total: '1000000', sellerRaw: '950000', treasuryRaw: '50000' });
		const ok = verifyQuote(token);
		expect(ok?.listingId).toBe('lst_1');
		expect(ok?.sellerRaw).toBe('950000');
		// Any byte flipped in the body or signature fails the HMAC.
		expect(verifyQuote(token.slice(0, -1) + (token.slice(-1) === 'a' ? 'b' : 'a'))).toBeNull();
		expect(verifyQuote('not-a-token')).toBeNull();
	});

	it('classifies wallet vs guest account ids', async () => {
		const { isWalletAddress } = await import('../multiplayer/src/game-token.js');
		expect(isWalletAddress('FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump')).toBe(true);
		expect(isWalletAddress('g_abc123')).toBe(false);
		expect(isWalletAddress('')).toBe(false);
	});
});
