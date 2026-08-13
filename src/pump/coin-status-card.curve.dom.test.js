// @vitest-environment jsdom
//
// DOM-level tests for the cluster-sourced lane of mountCoinStatus: the bonding
// curve read straight off Solana. This is the only market source that exists on
// devnet (where every free agent-token rehearsal launch lands) and the fallback
// on mainnet while pump.fun's indexer has not caught up to a fresh launch.
//
// fetch is stubbed at the global boundary and asserted on by URL, so these also
// pin WHICH endpoint each network talks to.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mountCoinStatus } from './coin-status-card.js';

// A three.ws-launched mint: the "3ws" brand mark leads the address (pump.fun's
// own launcher grinds a "pump" suffix instead — both carry a bonding curve).
const MINT = '3wsSynthetic11111111111111111111111111111';

function curveBody(overrides = {}) {
	return {
		mint: MINT,
		network: 'devnet',
		curve: { realSolReserves: '1200000000', complete: false },
		price: { marketCap: '32000000000', buyPricePerToken: '32' },
		graduation: { progressBps: 1500, solAccumulated: '1200000000' },
		...overrides,
	};
}

function coinBody() {
	return {
		mint: MINT,
		name: 'Indexed Coin',
		symbol: 'IDX',
		usd_market_cap: 34_500,
		total_supply: 1_000_000_000_000_000,
		complete: false,
		created_timestamp: Date.now() - 60_000,
	};
}

/** Route the stub by URL so a test asserts on real endpoint choice, not order. */
function routedFetch(routes) {
	return vi.fn((url) => {
		const href = String(url);
		for (const [needle, handler] of routes) {
			if (href.includes(needle)) return handler(href);
		}
		return Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({}) });
	});
}

const ok = (body) => () => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
const notFound = () => () => Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({}) });

let container;

beforeEach(() => {
	container = document.createElement('div');
	document.body.appendChild(container);
});

afterEach(() => {
	container.remove();
	vi.restoreAllMocks();
	vi.useRealTimers();
});

describe('mountCoinStatus — devnet lane', () => {
	it('reads the cluster curve and renders SOL-denominated market state', async () => {
		const fetchMock = routedFetch([['/api/pump/curve', ok(curveBody())]]);
		vi.stubGlobal('fetch', fetchMock);

		const handle = mountCoinStatus(container, MINT, {
			variant: 'chip',
			refreshMs: 0,
			network: 'devnet',
			meta: { symbol: 'RSL', name: 'Rehearsal' },
		});
		await vi.waitFor(() => expect(container.querySelector('.csc-sym')).toBeTruthy());

		expect(container.querySelector('.csc-sym').textContent).toBe('$RSL');
		expect(container.querySelector('.csc-mcap').textContent).toBe('◎32.00');
		expect(container.querySelector('.csc-price').textContent).toBe('◎0.000000032');
		expect(container.querySelector('.csc-grad').textContent).toBe('15% to grad');
		handle.destroy();
	});

	it('marks the coin DEVNET so real curve numbers never read as a live market', async () => {
		vi.stubGlobal('fetch', routedFetch([['/api/pump/curve', ok(curveBody())]]));
		const handle = mountCoinStatus(container, MINT, { variant: 'chip', refreshMs: 0, network: 'devnet' });
		await vi.waitFor(() => expect(container.querySelector('.csc-net')).toBeTruthy());

		expect(container.querySelector('.csc-net').textContent).toBe('DEVNET');
		handle.destroy();
	});

	it('never asks the mainnet-only indexer or the Oracle about a devnet coin', async () => {
		const fetchMock = routedFetch([['/api/pump/curve', ok(curveBody())]]);
		vi.stubGlobal('fetch', fetchMock);

		const handle = mountCoinStatus(container, MINT, { variant: 'card', refreshMs: 0, network: 'devnet' });
		await vi.waitFor(() => expect(container.querySelector('.csc-card-name')).toBeTruthy());

		const called = fetchMock.mock.calls.map(([u]) => String(u));
		expect(called.some((u) => u.includes('/api/pump/curve'))).toBe(true);
		expect(called.some((u) => u.includes('/api/pump/coin'))).toBe(false);
		expect(called.some((u) => u.includes('/api/oracle/coin'))).toBe(false);
		// Devnet SOL is not worth dollars, so no USD rate is fetched either.
		expect(called.some((u) => u.includes('jup.ag'))).toBe(false);
		handle.destroy();
	});

	it('links a devnet coin to the explorer, which is the only page it has', async () => {
		vi.stubGlobal('fetch', routedFetch([['/api/pump/curve', ok(curveBody())]]));
		const handle = mountCoinStatus(container, MINT, {
			variant: 'card',
			refreshMs: 0,
			network: 'devnet',
			showBuy: true,
		});
		await vi.waitFor(() => expect(container.querySelector('.csc-buy')).toBeTruthy());

		const link = container.querySelector('.csc-buy');
		expect(link.getAttribute('href')).toBe(`https://explorer.solana.com/address/${MINT}?cluster=devnet`);
		expect(link.textContent).toBe('Explorer →');
		handle.destroy();
	});

	it('shows the error state when the cluster has no curve for the mint', async () => {
		vi.stubGlobal('fetch', routedFetch([['/api/pump/curve', notFound()]]));
		const handle = mountCoinStatus(container, MINT, { variant: 'chip', refreshMs: 0, network: 'devnet' });
		await vi.waitFor(() => expect(container.querySelector('.csc-error')).toBeTruthy());
		handle.destroy();
	});
});

describe('mountCoinStatus — mainnet indexer fallback', () => {
	it('falls through to the bonding curve when the indexer does not know the coin', async () => {
		const fetchMock = routedFetch([
			['/api/pump/coin', notFound()],
			['/api/pump/curve', ok(curveBody({ network: 'mainnet' }))],
			['jup.ag', ok({ So11111111111111111111111111111111111111112: { usdPrice: 200 } })],
		]);
		vi.stubGlobal('fetch', fetchMock);

		const handle = mountCoinStatus(container, MINT, { variant: 'chip', refreshMs: 0 });
		await vi.waitFor(() => expect(container.querySelector('.csc-mcap')).toBeTruthy());

		// 32 SOL × $200 — real on-chain state, priced in dollars because mainnet
		// SOL has a dollar price.
		expect(container.querySelector('.csc-mcap').textContent).toBe('$6.4K');
		expect(container.querySelector('.csc-net')).toBeNull();
		handle.destroy();
	});

	it('prefers the indexer when it does know the coin', async () => {
		const fetchMock = routedFetch([
			['/api/pump/coin', ok(coinBody())],
			['/api/pump/curve', ok(curveBody({ network: 'mainnet' }))],
		]);
		vi.stubGlobal('fetch', fetchMock);

		const handle = mountCoinStatus(container, MINT, { variant: 'chip', refreshMs: 0 });
		await vi.waitFor(() => expect(container.querySelector('.csc-sym')).toBeTruthy());

		expect(container.querySelector('.csc-sym').textContent).toBe('$IDX');
		expect(container.querySelector('.csc-mcap').textContent).toBe('$34.5K');
		const called = fetchMock.mock.calls.map(([u]) => String(u));
		expect(called.some((u) => u.includes('/api/pump/curve'))).toBe(false);
		handle.destroy();
	});
});
