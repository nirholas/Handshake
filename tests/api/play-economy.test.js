// Unit tests for GET /api/play/economy, the public reference for the /play
// in-game economy.
//
// The whole point of that endpoint is that it CANNOT drift from the game: it
// imports the same tables WalkRoom prices trades with rather than restating
// them. So these tests assert equality against those source modules directly.
// A test that hardcoded "wood sells for 2" would defeat the design: it would
// pass while the reference and the game disagreed. Every assertion below is
// therefore a relationship between the response and the authoritative table,
// not a transcription of today's numbers.
//
// game-token.js is mocked (it constructs Solana clients and reads wallet env);
// the handler only needs its TOKEN_SYMBOL export, and spin-wheel.js pulls it in
// transitively for the payment path this endpoint never touches.

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../multiplayer/src/game-token.js', () => ({
	buildSpinPayment: vi.fn(),
	verifySpinPayment: vi.fn(),
	isWalletAddress: () => true,
	tokenConfigured: vi.fn(() => true),
	TOKEN_DECIMALS: 6,
	TOKEN_SYMBOL: '$THREE',
}));

const rlState = { success: true, limit: 60, remaining: 59, reset: 0 };
vi.mock('../../api/_lib/rate-limit.js', () => ({
	limits: { publicIp: vi.fn(async () => rlState) },
	clientIp: vi.fn(() => '127.0.0.1'),
}));

const handler = (await import('../../api/play/economy.js')).default;
const { SELL_PRICES, BUY_CATALOG, boutiqueListings } = await import('../../multiplayer/src/shop.js');
const { WHEEL_SEGMENTS, FREE_SPIN_COOLDOWN_MS, SPIN_COST_USD, MIN_AVG_LEVEL } = await import(
	'../../multiplayer/src/spin-wheel.js'
);
const { SKILLS, LEVEL_CAP, INV_SIZE, HOTBAR_SIZE } = await import('../../multiplayer/src/economy.js');

function mockRes() {
	const chunks = [];
	return {
		statusCode: 0,
		headers: {},
		setHeader(k, v) {
			this.headers[String(k).toLowerCase()] = v;
		},
		getHeader(k) {
			return this.headers[String(k).toLowerCase()];
		},
		writeHead(status, headers) {
			this.statusCode = status;
			for (const [k, v] of Object.entries(headers || {})) this.setHeader(k, v);
			return this;
		},
		end(body) {
			if (body) chunks.push(body);
			return this;
		},
		get body() {
			return chunks.join('');
		},
		get parsed() {
			return JSON.parse(chunks.join(''));
		},
	};
}

const mockReq = (method = 'GET') => ({
	method,
	url: '/api/play/economy',
	headers: { host: 'three.ws' },
	socket: { remoteAddress: '127.0.0.1' },
});

async function call(method = 'GET') {
	const res = mockRes();
	await handler(mockReq(method), res);
	return res;
}

beforeEach(() => {
	rlState.success = true;
});

describe('GET /api/play/economy', () => {
	it('serves the reference with a cacheable, session-free 200', async () => {
		const res = await call();
		expect(res.statusCode).toBe(200);
		// Pure config, no per-player state: it must be edge-cacheable or every
		// /play/economy visit becomes an origin hit for numbers that only change
		// on deploy.
		expect(res.getHeader('cache-control')).toMatch(/s-maxage=\d+/);
	});

	it('rejects non-GET methods', async () => {
		const res = await call('POST');
		expect(res.statusCode).toBe(405);
	});

	it('surfaces rate limiting rather than serving through it', async () => {
		rlState.success = false;
		const res = await call();
		expect(res.statusCode).toBe(429);
	});

	it('names both currencies and marks exactly one of them on-chain', async () => {
		const { currencies } = (await call()).parsed;
		expect(currencies.cash.onchain).toBe(false);
		expect(currencies.token.onchain).toBe(true);
		expect(currencies.token.chain).toBe('solana');
		// The separation is the design; a client must never have to guess which
		// currency a price is denominated in.
		expect(currencies.cash.label).not.toBe(currencies.token.label);
	});
});

describe('general store catalogs match the authoritative tables', () => {
	it('sells exactly the items SELL_PRICES lists, at those prices', async () => {
		const { generalStore } = (await call()).parsed;
		const fromApi = Object.fromEntries(generalStore.sell.map((r) => [r.item, r.price]));
		expect(fromApi).toEqual(SELL_PRICES);
		// Labels come from the server's own vocabulary, never invented here.
		for (const row of generalStore.sell) expect(row.label).toBeTruthy();
	});

	it('mirrors BUY_CATALOG entry for entry, including bundle quantities', async () => {
		const { generalStore } = (await call()).parsed;
		expect(generalStore.buy.map((r) => ({ item: r.item, qty: r.qty, price: r.price }))).toEqual(
			BUY_CATALOG.map((e) => ({ item: e.item, qty: e.qty, price: e.price })),
		);
	});

	it('derives a correct per-unit price for bundled entries', async () => {
		const { generalStore } = (await call()).parsed;
		for (const row of generalStore.buy) {
			expect(row.unitPrice).toBeCloseTo(row.price / row.qty, 2);
		}
	});

	it('never lists an item as both freely buyable and sellable at a profit', async () => {
		// The upstream tables deliberately exclude tools/weapons from SELL_PRICES so
		// no player can farm a buy-then-sell arbitrage. If someone ever adds an item
		// to both tables where selling beats the unit buy price, that loop reopens
		// and this test is the thing that notices.
		const { generalStore } = (await call()).parsed;
		const sellBy = Object.fromEntries(generalStore.sell.map((r) => [r.item, r.price]));
		for (const row of generalStore.buy) {
			const sell = sellBy[row.item];
			if (sell === undefined) continue;
			expect(sell).toBeLessThan(row.unitPrice);
		}
	});
});

describe('boutique', () => {
	it('lists every premium cosmetic the shop module sells, priced in $THREE', async () => {
		const { boutique } = (await call()).parsed;
		expect(boutique.listings.map((l) => l.id)).toEqual(boutiqueListings().map((l) => l.id));
		expect(boutique.currency).toBe('$THREE');
		expect(boutique.settlement).toBe('solana');
		for (const l of boutique.listings) {
			expect(l.price).toBeGreaterThan(0);
			expect(l.slotLabel).toBeTruthy();
		}
	});

	it('splits the take in basis points that total exactly one whole', async () => {
		const { boutique } = (await call()).parsed;
		expect(boutique.rewardsBps + boutique.treasuryBps).toBe(10000);
	});
});

describe('wheel paytable', () => {
	it('reports the real wedge count and gate constants', async () => {
		const { wheel } = (await call()).parsed;
		expect(wheel.wedges).toBe(WHEEL_SEGMENTS.length);
		expect(wheel.freeSpinCooldownMs).toBe(FREE_SPIN_COOLDOWN_MS);
		expect(wheel.paidSpinUsd).toBe(SPIN_COST_USD);
		expect(wheel.minAvgLevel).toBe(MIN_AVG_LEVEL);
		expect(wheel.freeSpinCooldownHours).toBe(Math.round(FREE_SPIN_COOLDOWN_MS / 3_600_000));
	});

	it('collapses duplicate wedges without losing or inventing probability', async () => {
		const { wheel } = (await call()).parsed;
		const totalWedges = wheel.paytable.reduce((a, r) => a + r.wedges, 0);
		const totalOdds = wheel.paytable.reduce((a, r) => a + r.oddsPct, 0);
		expect(totalWedges).toBe(WHEEL_SEGMENTS.length);
		// Summed from each wedge's own oddsPct, so this stays true even if the
		// wheel is ever re-weighted away from uniform.
		expect(totalOdds).toBeCloseTo(
			WHEEL_SEGMENTS.reduce((a, s) => a + s.oddsPct, 0),
			6,
		);
		expect(totalOdds).toBeCloseTo(100, 6);
	});

	it('gives each summarized row odds equal to its wedge count', async () => {
		const { wheel } = (await call()).parsed;
		for (const row of wheel.paytable) {
			const matching = WHEEL_SEGMENTS.filter(
				(s) =>
					s.kind === row.kind &&
					(s.item || null) === row.item &&
					(s.qty || 0) === row.qty &&
					(s.gold || 0) === row.gold,
			);
			expect(row.wedges).toBe(matching.length);
			expect(row.oddsPct).toBeCloseTo(
				matching.reduce((a, s) => a + s.oddsPct, 0),
				6,
			);
		}
	});

	it('leads with the richest cash prize so the headline outcome reads first', async () => {
		const { wheel } = (await call()).parsed;
		const cash = wheel.paytable.filter((r) => r.kind === 'gold');
		expect(wheel.paytable[0].kind).toBe('gold');
		expect(cash[0].gold).toBe(Math.max(...cash.map((r) => r.gold)));
	});
});

describe('progression constants', () => {
	it('reports the real skill set and caps', async () => {
		const { progression } = (await call()).parsed;
		expect(progression.skills).toEqual(SKILLS);
		expect(progression.levelCap).toBe(LEVEL_CAP);
		expect(progression.inventorySlots).toBe(INV_SIZE);
		expect(progression.hotbarSlots).toBe(HOTBAR_SIZE);
	});
});
