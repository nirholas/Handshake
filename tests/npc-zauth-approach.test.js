// @vitest-environment jsdom
//
// Walking past a vendor must never take the screen. zauth is the only NPC in
// the catalog with an `onApproach` handler, and it used to open its RepoScan
// panel from proximity alone: crossing the plaza in /play threw a modal over
// the world nobody asked for. Approach now only greets and warms the live 402
// probe; the panel belongs to E and to clicks. This locks that split in.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

globalThis.self = globalThis;

const CHALLENGE = {
	x402Version: 2,
	accepts: [{ amount: '50000', network: 'solana:mainnet', asset: 'USDC' }],
};

function fakeNpc() {
	return { say: vi.fn(), emote: vi.fn(), _disposed: false };
}

let zauth;

beforeEach(async () => {
	globalThis.fetch = vi.fn(async () => new Response(JSON.stringify(CHALLENGE), {
		status: 402,
		headers: { 'content-type': 'application/json' },
	}));
	const { npcCatalogFor } = await import('../src/game/npc/npc-catalog.js');
	zauth = npcCatalogFor().find((n) => n.id === 'npc-zauth');
});

afterEach(() => {
	document.querySelector('.npc-svc-overlay')?.remove();
	document.body.innerHTML = '';
	vi.resetModules();
	vi.restoreAllMocks();
});

describe('zauth NPC walk-up', () => {
	it('is in the catalog with both an approach line and an E prompt', () => {
		expect(zauth).toBeTruthy();
		expect(typeof zauth.onApproach).toBe('function');
		expect(typeof zauth.onInteract).toBe('function');
		expect(zauth.prompt).toBeTruthy();
	});

	it('greets on approach without opening any panel', async () => {
		const npc = fakeNpc();
		zauth.onApproach({ npc, ui: {} });
		await Promise.resolve();
		expect(npc.say).toHaveBeenCalledTimes(1);
		expect(document.querySelector('.npc-svc-overlay')).toBeNull();
		expect(document.querySelector('.npc-svc-card.is-zauth')).toBeNull();
	});

	it('warms the live x402 challenge on approach so the panel opens priced', async () => {
		zauth.onApproach({ npc: fakeNpc(), ui: {} });
		expect(globalThis.fetch).toHaveBeenCalledTimes(1);
		const [url, init] = globalThis.fetch.mock.calls[0];
		expect(url).toBe('/api/zauth-reposcan');
		expect(init.method).toBe('POST');
	});

	it('opens the scanner only on interact, reusing the warmed challenge', async () => {
		zauth.onApproach({ npc: fakeNpc(), ui: {} });
		expect(document.querySelector('.npc-svc-overlay')).toBeNull();

		zauth.onInteract({ npc: fakeNpc(), ui: {} });
		expect(document.querySelector('.npc-svc-card.is-zauth')).toBeTruthy();
		// The probe is cached, so opening does not re-hit the endpoint.
		expect(globalThis.fetch).toHaveBeenCalledTimes(1);
	});
});
