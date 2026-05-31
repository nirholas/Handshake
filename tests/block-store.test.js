// BlockStore — the per-coin build persistence layer. Without Redis env vars it
// runs memory-only, which is the documented production baseline (Cloud Run
// min=1/max=1): a build must outlive the room emptying within the process. These
// tests lock that guarantee and the honest `durable` reporting the HUD reads.

import { describe, it, expect, beforeEach } from 'vitest';

// Ensure no Redis credentials leak in from the environment for this suite.
delete process.env.UPSTASH_REDIS_REST_URL;
delete process.env.UPSTASH_REDIS_REST_TOKEN;

const { blockStore } = await import('../multiplayer/src/block-store.js');

describe('BlockStore (memory-only)', () => {
	it('reports not-durable without Redis configured', async () => {
		await blockStore.ready();
		expect(blockStore.durable).toBe(false);
	});

	it('keeps a coin world alive across reloads within the process', async () => {
		const coin = 'CoinAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
		const first = await blockStore.load(coin);
		blockStore.set(coin, '0,0,0', 3);
		blockStore.set(coin, '1,0,0', 5);

		// A fresh load (e.g. the room disposed and was recreated) returns the SAME
		// live map — the community's build is still there.
		const second = await blockStore.load(coin);
		expect(second).toBe(first);
		expect(second.get('0,0,0')).toBe(3);
		expect(second.get('1,0,0')).toBe(5);
		expect(second.size).toBe(2);
	});

	it('delete removes a cell from the persisted world', async () => {
		const coin = 'CoinBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
		await blockStore.load(coin);
		blockStore.set(coin, '2,2,2', 1);
		blockStore.delete(coin, '2,2,2');
		const map = await blockStore.load(coin);
		expect(map.has('2,2,2')).toBe(false);
	});

	it('isolates builds between coins', async () => {
		const a = 'CoinCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC';
		const z = 'CoinDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD';
		await blockStore.load(a);
		await blockStore.load(z);
		blockStore.set(a, '0,0,0', 9);
		const zMap = await blockStore.load(z);
		expect(zMap.has('0,0,0')).toBe(false);
	});

	it('set/delete on an unloaded coin is a safe no-op', () => {
		expect(() => blockStore.set('NeverLoadedCoin', '0,0,0', 1)).not.toThrow();
		expect(() => blockStore.delete('NeverLoadedCoin', '0,0,0')).not.toThrow();
	});
});
