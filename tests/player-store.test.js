// PlayerStore (Task 16) — account-keyed player persistence. Two tiers, mirroring
// block-store: a synchronous in-process cache and a durable Upstash Redis backing.
// Exercised against a mocked @upstash/redis so the durability contract is proven
// without real credentials:
//   - the sync API (loadPlayer/savePlayer/hasPlayer) round-trips the full profile,
//   - durability is claimed only after a real PING succeeds,
//   - a profile saved + flushed by one process is rehydrated by the next (the
//     cross-restart / cross-instance guarantee — the heart of Task 16),
//   - a brand-new account stays null so it is never falsely resurrected,
//   - an unreachable Redis degrades to memory-only without losing in-process state,
//   - a sustained write outage flips `durable` off (and recovers when writes land).

import { describe, it, expect, beforeEach, vi } from 'vitest';

// Hoisted so the (hoisted) vi.mock factory can close over it. Stands in for the
// Redis server — its contents survive a simulated restart (a fresh PlayerStore).
const redis = vi.hoisted(() => ({ store: new Map(), pingFails: false, setFails: 0 }));

vi.mock('@upstash/redis', () => ({
	Redis: class {
		async ping() { if (redis.pingFails) throw new Error('unreachable'); return 'PONG'; }
		async get(k) { return redis.store.has(k) ? redis.store.get(k) : null; }
		// Accepts (and ignores) the { ex } TTL option the store passes.
		async set(k, v) { if (redis.setFails > 0) { redis.setFails--; throw new Error('write failed'); } redis.store.set(k, v); return 'OK'; }
		async del(k) { return redis.store.delete(k) ? 1 : 0; }
	},
}));

// Spin up a fresh PlayerStore module ("a new process"). With creds set it wires
// the mocked Redis; without them it is memory-only.
async function freshStore({ durable = true } = {}) {
	vi.resetModules();
	if (durable) {
		process.env.UPSTASH_REDIS_REST_URL = 'http://mock-upstash';
		process.env.UPSTASH_REDIS_REST_TOKEN = 'mock-token';
	} else {
		delete process.env.UPSTASH_REDIS_REST_URL;
		delete process.env.UPSTASH_REDIS_REST_TOKEN;
	}
	return import('../multiplayer/src/playerStore.js');
}

// A representative full profile — the exact shape GameRoom persists: gold, name,
// quests (tutorial + dailies + badges), the inventory/hotbar/bank/skills profile
// blob, and owned/equipped cosmetics.
function sampleProfile() {
	return {
		name: 'Nico',
		gold: 4242,
		quests: { tutorial: { step: 5, done: true }, daily: { date: '2026-06-01', quests: [] }, badges: ['newcomer'] },
		profile: {
			inv: [{ item: 'wood', qty: 120 }, { item: 'fish', qty: 8 }],
			hotbar: [{ item: 'axe', qty: 1 }],
			bank: [{ item: 'coal', qty: 30 }],
			activeSlot: 2,
			xp: { combat: 1500, woodcutting: 3000, mining: 200, fishing: 75, cooking: 640 },
			hp: 88, maxHp: 100, mount: 'horse', realm: 'whisperwood', tx: 12, ty: 7,
		},
		cosmetics: { owned: ['hat_red', 'cape_blue', 'crown_gold'], equipped: 'crown_gold' },
	};
}

beforeEach(() => { redis.store.clear(); redis.pingFails = false; redis.setFails = 0; });

describe('PlayerStore — synchronous cache API', () => {
	it('round-trips the full profile through save → load', async () => {
		const s = await freshStore();
		await s.playerStoreReady();
		expect(s.loadPlayer('acct')).toBeNull();
		expect(s.hasPlayer('acct')).toBe(false);

		s.savePlayer('acct', sampleProfile());
		const got = s.loadPlayer('acct');
		expect(got.gold).toBe(4242);
		expect(got.profile.inv[0].qty).toBe(120);
		expect(got.profile.xp.cooking).toBe(640);
		expect(got.cosmetics.equipped).toBe('crown_gold');
		expect(got.quests.tutorial.done).toBe(true);
		expect(typeof got.savedAt).toBe('number'); // stamped for the cache sweep
		expect(s.hasPlayer('acct')).toBe(true);
	});

	it('supports the read-merge-write the GameRoom uses to persist one slice at a time', async () => {
		const s = await freshStore();
		await s.playerStoreReady();
		s.savePlayer('acct', sampleProfile());
		const prev = s.loadPlayer('acct') || {};
		s.savePlayer('acct', { ...prev, gold: 9999 });
		expect(s.loadPlayer('acct').gold).toBe(9999);
		expect(s.loadPlayer('acct').profile.inv[0].qty).toBe(120); // other fields preserved
	});
});

describe('PlayerStore (durable / Upstash)', () => {
	it('claims durability only after a verifying PING succeeds', async () => {
		const s = await freshStore();
		await s.playerStoreReady();
		expect(s.playerStore.durable).toBe(true);
	});

	it('persists a full profile across a simulated restart', async () => {
		// Process A: a player earns progress, then the session ends (flush).
		const a = await freshStore();
		await a.playerStoreReady();
		a.savePlayer('wallet:0xABC', sampleProfile());
		await a.flushPlayer('wallet:0xABC');
		expect(redis.store.size).toBe(1); // one atomic JSON value for the account
		expect(JSON.parse(redis.store.get('player:wallet:0xABC')).gold).toBe(4242);

		// Process B (fresh store, same Redis): the returning player must NOT look
		// brand-new — the cache is empty until hydrate pulls them back.
		const b = await freshStore();
		await b.playerStoreReady();
		expect(b.loadPlayer('wallet:0xABC')).toBeNull();
		const restored = await b.hydratePlayer('wallet:0xABC');
		expect(restored.gold).toBe(4242);
		expect(b.loadPlayer('wallet:0xABC').profile.inv[0].qty).toBe(120);
		expect(b.loadPlayer('wallet:0xABC').profile.xp.cooking).toBe(640);
		expect(b.loadPlayer('wallet:0xABC').profile.realm).toBe('whisperwood');
		expect(b.loadPlayer('wallet:0xABC').cosmetics.equipped).toBe('crown_gold');
		expect(b.loadPlayer('wallet:0xABC').quests.tutorial.done).toBe(true);
	});

	it('hydrates a never-seen account to null so a new player gets the starter kit, not a reset', async () => {
		const s = await freshStore();
		await s.playerStoreReady();
		expect(await s.hydratePlayer('wallet:0xNEW')).toBeNull();
		expect(s.loadPlayer('wallet:0xNEW')).toBeNull();
	});

	it('flushAll persists every dirty account on shutdown', async () => {
		const s = await freshStore();
		await s.playerStoreReady();
		s.savePlayer('a', { gold: 1 });
		s.savePlayer('b', { gold: 2 });
		await s.flushAllPlayers();
		expect(JSON.parse(redis.store.get('player:a')).gold).toBe(1);
		expect(JSON.parse(redis.store.get('player:b')).gold).toBe(2);
	});

	it('degrades to memory-only when Redis is unreachable, without losing in-process state', async () => {
		redis.pingFails = true;
		const s = await freshStore();
		await s.playerStoreReady();
		expect(s.playerStore.durable).toBe(false);
		s.savePlayer('acct', sampleProfile());
		expect(s.loadPlayer('acct').gold).toBe(4242); // cache still serves within the process
	});

	it('flips durability off after sustained write failures, then recovers', async () => {
		const s = await freshStore();
		await s.playerStoreReady();
		expect(s.playerStore.durable).toBe(true);
		s.savePlayer('acct', sampleProfile());
		redis.setFails = 3; // next three writes throw
		await s.flushPlayer('acct');
		await s.flushPlayer('acct');
		await s.flushPlayer('acct');
		expect(s.playerStore.durable).toBe(false);
		await s.flushPlayer('acct'); // writes land again
		expect(s.playerStore.durable).toBe(true);
		expect(JSON.parse(redis.store.get('player:acct')).gold).toBe(4242);
	});
});
