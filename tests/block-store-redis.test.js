// BlockStore — the Upstash Redis (durable) tier. Exercised against a mocked
// @upstash/redis so the durability contract is proven without real credentials:
//   - durability is claimed only after a real PING succeeds,
//   - a build written by one process is reloaded by the next (cross-restart),
//   - an unreachable Redis degrades to memory-only without losing edits,
//   - a sustained write outage flips `durable` off so new rooms stop promising
//     persistence to builders.

import { describe, it, expect, beforeEach, vi } from 'vitest';

// Shared, hoisted so the (hoisted) vi.mock factory can close over it. Acts as the
// "Redis server" — its contents survive a simulated process restart (a fresh
// BlockStore), exactly like a real durable store.
const redis = vi.hoisted(() => ({ store: new Map(), pingFails: false, setFails: 0 }));

vi.mock('@upstash/redis', () => ({
	Redis: class {
		async ping() { if (redis.pingFails) throw new Error('unreachable'); return 'PONG'; }
		async get(k) { return redis.store.has(k) ? redis.store.get(k) : null; }
		async set(k, v) { if (redis.setFails > 0) { redis.setFails--; throw new Error('write failed'); } redis.store.set(k, v); return 'OK'; }
		async del(k) { return redis.store.delete(k) ? 1 : 0; }
	},
}));

// Spin up a fresh BlockStore (a "new process") that reads the mocked Redis.
async function freshStore() {
	vi.resetModules();
	process.env.UPSTASH_REDIS_REST_URL = 'http://mock-upstash';
	process.env.UPSTASH_REDIS_REST_TOKEN = 'mock-token';
	const mod = await import('../multiplayer/src/block-store.js');
	return mod.blockStore;
}

beforeEach(() => { redis.store.clear(); redis.pingFails = false; redis.setFails = 0; });

describe('BlockStore (durable / Upstash)', () => {
	it('claims durability only after a verifying PING succeeds', async () => {
		const s = await freshStore();
		await s.ready();
		expect(s.durable).toBe(true);
	});

	it('persists a build across a simulated restart', async () => {
		// Process A builds and flushes.
		const a = await freshStore();
		await a.ready();
		const mapA = await a.load('Mint1111111111111111111111111111111111111111');
		mapA.set('0,0,0', 3);
		mapA.set('1,2,3', 9);
		await a.flush('Mint1111111111111111111111111111111111111111');
		expect(redis.store.size).toBe(1); // one JSON value for the coin

		// Process B (fresh store, same Redis) rehydrates the build on first load.
		const b = await freshStore();
		await b.ready();
		const mapB = await b.load('Mint1111111111111111111111111111111111111111');
		expect(mapB.get('0,0,0')).toBe(3);
		expect(mapB.get('1,2,3')).toBe(9);
		expect(mapB.size).toBe(2);
	});

	it('clearing a world to empty deletes its durable key', async () => {
		const a = await freshStore();
		await a.ready();
		const coin = 'Mint2222222222222222222222222222222222222222';
		const map = await a.load(coin);
		map.set('0,0,0', 1);
		await a.flush(coin);
		expect(redis.store.size).toBe(1);
		map.clear();
		await a.flush(coin);
		expect(redis.store.size).toBe(0); // empty world → key removed, not left stale
	});

	it('degrades to memory-only when Redis is unreachable, without losing edits', async () => {
		redis.pingFails = true;
		const s = await freshStore();
		await s.ready();
		expect(s.durable).toBe(false);
		// The in-memory tier still works — builds survive within the process.
		const coin = 'Mint3333333333333333333333333333333333333333';
		const map = await s.load(coin);
		map.set('5,0,5', 7);
		const again = await s.load(coin);
		expect(again.get('5,0,5')).toBe(7);
	});

	it('flips durability off after sustained write failures', async () => {
		const s = await freshStore();
		await s.ready();
		expect(s.durable).toBe(true);
		const coin = 'Mint4444444444444444444444444444444444444444';
		const map = await s.load(coin);
		map.set('0,0,0', 2); // mutate the live map directly (no debounce timer)
		redis.setFails = 3;   // next three writes throw
		await s.flush(coin);
		await s.flush(coin);
		await s.flush(coin);
		expect(s.durable).toBe(false); // sustained outage → stop promising durability
		// Recovery: once writes land again, durability is restored.
		await s.flush(coin);
		expect(s.durable).toBe(true);
		expect(redis.store.size).toBe(1);
	});
});
