// @vitest-environment jsdom
//
// The launch history on /agents/:id, the profile half of the agent-token lane.
//
// Every coin an agent launched through three.ws is registered in
// pump_agent_mints and read back by GET /api/pump/by-agent. The property under
// test is that each of those rows renders LIVE market state, on whichever
// cluster it was launched on:
//
//   · a mainnet coin reads pump.fun's indexer (falling back to its bonding
//     curve while the indexer catches up to a fresh mint), priced in USD;
//   · a devnet coin has no indexer anywhere, so it reads its bonding curve
//     straight off the cluster, priced in SOL and badged DEVNET.
//
// The devnet row used to render as a lifeless symbol-and-address line, which
// meant the free rehearsal path: the only path that proves this lane end to end
// without spending real money: produced no market data on the profile at all.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderLaunchHistory, destroyCoinStatus } from '../src/agent-detail.js';

const AGENT_ID = '77777777-7777-4777-8777-777777777777';
const DEVNET_MINT = '3wsRehearsal111111111111111111111111111111';
const MAINNET_MINT = '3wsLivecoin1111111111111111111111111111111';

function launches(coins) {
	return { ok: true, status: 200, json: () => Promise.resolve({ coins }) };
}

function curveBody(network) {
	return {
		ok: true,
		status: 200,
		json: () =>
			Promise.resolve({
				mint: network === 'devnet' ? DEVNET_MINT : MAINNET_MINT,
				network,
				curve: { realSolReserves: '1200000000', complete: false },
				price: { marketCap: '32000000000', buyPricePerToken: '32' },
				graduation: { progressBps: 1500, solAccumulated: '1200000000' },
			}),
	};
}

function indexedCoin() {
	return {
		ok: true,
		status: 200,
		json: () =>
			Promise.resolve({
				mint: MAINNET_MINT,
				symbol: 'LIVE',
				name: 'Live Coin',
				usd_market_cap: 34_500,
				total_supply: 1_000_000_000_000_000,
				complete: false,
				created_timestamp: Date.now() - 60_000,
			}),
	};
}

const DEVNET_ROW = {
	mint: DEVNET_MINT,
	network: 'devnet',
	name: 'Rehearsal',
	symbol: 'RSL',
	created_at: new Date(Date.now() - 3 * 60_000).toISOString(),
};
const MAINNET_ROW = {
	mint: MAINNET_MINT,
	network: 'mainnet',
	name: 'Live Coin',
	symbol: 'LIVE',
	created_at: new Date(Date.now() - 9 * 60_000).toISOString(),
};

/** Stub fetch by URL so the assertions pin real endpoint choice, not call order. */
function stubRoutes(routes) {
	const mock = vi.fn((url) => {
		const href = String(url);
		for (const [needle, handler] of routes) {
			if (href.includes(needle)) return Promise.resolve(handler());
		}
		return Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({}) });
	});
	vi.stubGlobal('fetch', mock);
	return mock;
}

let container;

beforeEach(() => {
	document.body.innerHTML = '<div id="ad-token-card" hidden><div id="host"></div></div>';
	container = document.getElementById('host');
});

afterEach(() => {
	destroyCoinStatus();
	vi.restoreAllMocks();
});

describe('renderLaunchHistory', () => {
	it('renders a devnet launch with live SOL-denominated curve state', async () => {
		stubRoutes([
			['/api/pump/by-agent', () => launches([DEVNET_ROW])],
			['/api/pump/curve', () => curveBody('devnet')],
		]);

		await renderLaunchHistory(container, { id: AGENT_ID });
		await vi.waitFor(() => expect(container.querySelector('.csc-mcap')).toBeTruthy());

		expect(container.querySelector('.csc-sym').textContent).toBe('$RSL');
		expect(container.querySelector('.csc-mcap').textContent).toBe('◎32.00');
		expect(container.querySelector('.csc-net').textContent).toBe('DEVNET');
	});

	it('sends each row to the market source its own cluster has', async () => {
		const fetchMock = stubRoutes([
			['/api/pump/by-agent', () => launches([DEVNET_ROW, MAINNET_ROW])],
			['/api/pump/curve', () => curveBody('devnet')],
			['/api/pump/coin', () => indexedCoin()],
		]);

		await renderLaunchHistory(container, { id: AGENT_ID });
		await vi.waitFor(() => expect(container.querySelectorAll('.csc-mcap').length).toBe(2));

		const called = fetchMock.mock.calls.map(([u]) => String(u));
		expect(called.some((u) => u.includes('/api/pump/curve') && u.includes('network=devnet'))).toBe(true);
		expect(called.some((u) => u.includes(`/api/pump/coin?mint=${MAINNET_MINT}`))).toBe(true);
		// The devnet mint must never be sent to the mainnet-only indexer.
		expect(called.some((u) => u.includes('/api/pump/coin') && u.includes(DEVNET_MINT))).toBe(false);
	});

	it('links a devnet row to the explorer and a mainnet row to its three.ws coin page', async () => {
		stubRoutes([
			['/api/pump/by-agent', () => launches([DEVNET_ROW, MAINNET_ROW])],
			['/api/pump/curve', () => curveBody('devnet')],
			['/api/pump/coin', () => indexedCoin()],
		]);

		await renderLaunchHistory(container, { id: AGENT_ID });

		const hrefs = [...container.querySelectorAll('a.ad-launch-row')].map((a) => a.getAttribute('href'));
		expect(hrefs).toContain(`https://explorer.solana.com/address/${DEVNET_MINT}?cluster=devnet`);
		expect(hrefs).toContain(`/launches/${MAINNET_MINT}`);
	});

	it('reveals the token card and the public feed link when any launch exists', async () => {
		stubRoutes([
			['/api/pump/by-agent', () => launches([DEVNET_ROW])],
			['/api/pump/curve', () => curveBody('devnet')],
		]);

		await renderLaunchHistory(container, { id: AGENT_ID });

		expect(document.getElementById('ad-token-card').hidden).toBe(false);
		const feed = container.querySelector('.ad-launch-feed-link');
		expect(feed.getAttribute('href')).toBe(`/launches?agent_id=${AGENT_ID}`);
	});

	it('renders nothing when the agent has never launched a coin', async () => {
		stubRoutes([['/api/pump/by-agent', () => launches([])]]);

		await renderLaunchHistory(container, { id: AGENT_ID });

		expect(container.querySelector('.ad-launch-history')).toBeNull();
		expect(document.getElementById('ad-token-card').hidden).toBe(true);
	});
});
