// Coverage for the R22 avatar-shop purchase lineage:
//
//   • api/_lib/cosmetics.js        — USDC pricing layer + catalog owned-merge
//   • api/_lib/cosmetics-ownership.js — durable ownership ledger (fail-closed
//                                       grant, graceful reads, idempotency)
//   • api/x402/cosmetic-purchase.js — input validation + the 402 challenge
//
// The on-chain settlement itself needs a funded wallet + facilitator and is
// verified against the real rail on deploy; here we lock down the boundary
// behaviour that must hold regardless: server-owned pricing, honest validation,
// fail-closed ownership, and a correctly-priced 402.

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import {
	buildCatalog, getCosmetic, priceUsdcAtomicsOf, priceUsdcDisplayOf,
} from '../api/_lib/cosmetics.js';

describe('cosmetics USDC pricing', () => {
	afterEach(() => { delete process.env.X402_PRICE_COSMETIC_LEGENDARY; });

	it('prices premium items by rarity and frees the base pack', () => {
		expect(priceUsdcAtomicsOf(getCosmetic('skin-crimson'))).toBe('500000');   // rare $0.50
		expect(priceUsdcAtomicsOf(getCosmetic('skin-whiteout'))).toBe('1500000'); // epic $1.50
		expect(priceUsdcAtomicsOf(getCosmetic('skin-midnight'))).toBe('3000000'); // legendary $3.00
		expect(priceUsdcAtomicsOf(getCosmetic('hat-baseball'))).toBe('0');        // free base item
		expect(priceUsdcDisplayOf(getCosmetic('skin-midnight'))).toBe('3.00');
	});

	it('honours an env price override', () => {
		process.env.X402_PRICE_COSMETIC_LEGENDARY = '4200000';
		expect(priceUsdcAtomicsOf(getCosmetic('skin-midnight'))).toBe('4200000');
	});

	it('surfaces both the $THREE value and the USDC charge in the catalog', () => {
		const midnight = buildCatalog({}).find((c) => c.id === 'skin-midnight');
		expect(midnight.currency).toBe('THREE');      // coin-facing copy stays $THREE
		expect(midnight.price).toBe(750);
		expect(midnight.priceUsdc).toBe('3.00');       // USDC is the settlement asset
		expect(midnight.priceUsdcAtomics).toBe('3000000');
		expect(midnight.owned).toBe(false);
	});

	it('reads a purchased premium item as owned when merged in', () => {
		const owned = buildCatalog({ ownedIds: ['skin-midnight'] }).find((c) => c.id === 'skin-midnight');
		expect(owned.owned).toBe(true);
		expect(owned.locked).toBe(false);
	});
});

// ── ownership ledger ─────────────────────────────────────────────────────────
// A tiny in-memory stand-in for Upstash Redis so we can exercise the SET-backed
// ledger without a live instance.
class FakeRedis {
	constructor() { this.sets = new Map(); }
	async sadd(key, member) {
		const s = this.sets.get(key) || new Set();
		const had = s.has(member);
		s.add(member); this.sets.set(key, s);
		return had ? 0 : 1;
	}
	async smembers(key) { return [...(this.sets.get(key) || [])]; }
	async sismember(key, m) { return this.sets.get(key)?.has(m) ? 1 : 0; }
	async expire() { return 1; }
}

async function loadOwnership({ withRedis }) {
	vi.resetModules();
	if (withRedis) {
		process.env.UPSTASH_REDIS_REST_URL = 'https://fake.upstash.io';
		process.env.UPSTASH_REDIS_REST_TOKEN = 'fake-token';
		const fake = new FakeRedis();
		vi.doMock('@upstash/redis', () => ({ Redis: class { constructor() { return fake; } } }));
	} else {
		delete process.env.UPSTASH_REDIS_REST_URL;
		delete process.env.UPSTASH_REDIS_REST_TOKEN;
		delete process.env.three_KV_REST_API_URL;
		delete process.env.KV_REST_API_URL;
		vi.doMock('@upstash/redis', () => ({ Redis: class {} }));
	}
	return import('../api/_lib/cosmetics-ownership.js');
}

describe('cosmetics ownership ledger', () => {
	// Each scenario re-imports the module fresh (resetModules) with its own
	// @upstash/redis doMock, so no cross-test mock leakage.
	beforeEach(() => { vi.resetModules(); });
	afterEach(() => { vi.resetModules(); });

	it('normalizeAccountId accepts wallets + guest ids, rejects junk', async () => {
		const { normalizeAccountId } = await loadOwnership({ withRedis: false });
		expect(normalizeAccountId('FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump'))
			.toBe('FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump');
		expect(normalizeAccountId('guest-ab12cd34')).toBe('guest-ab12cd34');
		expect(normalizeAccountId('a b/c')).toBe('');
		expect(normalizeAccountId('')).toBe('');
		expect(normalizeAccountId('x'.repeat(80))).toBe('');
	});

	it('grants idempotently and reads back when a store is configured', async () => {
		const lib = await loadOwnership({ withRedis: true });
		expect(lib.ownershipStoreConfigured()).toBe(true);
		expect(await lib.grantCosmeticOwnership('guest-1', 'skin-midnight')).toBe(true);  // newly owned
		expect(await lib.grantCosmeticOwnership('guest-1', 'skin-midnight')).toBe(false); // idempotent
		expect(await lib.readOwnedCosmetics('guest-1')).toEqual(['skin-midnight']);
		expect(await lib.ownsCosmetic('guest-1', 'skin-midnight')).toBe(true);
		expect(await lib.ownsCosmetic('guest-1', 'skin-crimson')).toBe(false);
	});

	it('fails closed on grant and degrades gracefully on read with no store', async () => {
		const lib = await loadOwnership({ withRedis: false });
		expect(lib.ownershipStoreConfigured()).toBe(false);
		await expect(lib.grantCosmeticOwnership('guest-1', 'skin-midnight')).rejects.toMatchObject({
			status: 503, code: 'ownership_store_unavailable',
		});
		expect(await lib.readOwnedCosmetics('guest-1')).toEqual([]);
		expect(await lib.ownsCosmetic('guest-1', 'skin-midnight')).toBe(false);
	});
});

// ── purchase endpoint boundary ───────────────────────────────────────────────
function mockReq(query, headers = {}) {
	return {
		method: 'GET',
		url: '/api/x402/cosmetic-purchase?' + new URLSearchParams(query).toString(),
		query,
		headers,
	};
}

function mockRes() {
	const res = { statusCode: 0, body: '', headers: {} };
	res.setHeader = (k, v) => { res.headers[k.toLowerCase()] = v; };
	res.getHeader = (k) => res.headers[k.toLowerCase()];
	res.status = (s) => { res.statusCode = s; return res; };
	res.end = (b) => { res.body = b || ''; res.writableEnded = true; };
	return res;
}

async function call(query, headers = {}) {
	const { default: handler } = await import('../api/x402/cosmetic-purchase.js');
	const req = mockReq(query, headers);
	const res = mockRes();
	await handler(req, res);
	let parsed; try { parsed = JSON.parse(res.body); } catch { parsed = res.body; }
	return { status: res.statusCode, parsed };
}

// A real payer presents an X-PAYMENT envelope; discovery probes never do. The
// endpoint keeps strict 400/404 validation for the former and serves a spec-valid
// 402 discovery challenge to the latter (x402scan/Bazaar registration contract).
const PAID = { 'x-payment': 'probe-authorization-envelope' };

describe('cosmetic-purchase endpoint boundary', () => {
	// Warm the heavy import chain (x402-paid-endpoint → @coinbase/x402 → Solana
	// toolchain) once, outside any single test's 45s budget. A cold import of
	// this handler takes 5–150s on loaded CI/Codespace hosts (see the note in
	// vitest.config.js); without this, the first test in the block flakes on
	// import latency alone. Env reads in the handler are lazy (api/_lib/env.js
	// getters), so importing before beforeEach sets X402_* vars is safe.
	beforeAll(async () => {
		await import('../api/x402/cosmetic-purchase.js');
	}, 240_000);

	beforeEach(() => {
		// Minimal x402 config so the 402 challenge can build a Solana accept — the
		// Solana leg needs both a payout address and a co-signing fee payer.
		process.env.X402_PAY_TO_SOLANA = 'THREEsynthetic1111111111111111111111111PayTo';
		process.env.X402_ASSET_MINT_SOLANA = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
		process.env.X402_FEE_PAYER_SOLANA = 'THREEsynthetic1111111111111111111111111PayTo';
	});

	it('rejects missing id / account for a real payer (X-PAYMENT present)', async () => {
		expect((await call({ account: 'guest-1' }, PAID)).status).toBe(400);
		expect((await call({ id: 'skin-midnight' }, PAID)).status).toBe(400);
	});

	it('404s an unknown cosmetic and 400s a free base item for a real payer', async () => {
		expect((await call({ id: 'nope', account: 'guest-1' }, PAID)).status).toBe(404);
		const free = await call({ id: 'hat-baseball', account: 'guest-1' }, PAID);
		expect(free.status).toBe(400);
		expect(free.parsed.error).toBe('not_purchasable');
	});

	it('serves a 402 discovery challenge to a credential-less probe (missing/placeholder/unknown params)', async () => {
		// x402scan hits the bare route or fills required strings with a placeholder;
		// the endpoint must answer 402, never 400/404, or registration drops it.
		for (const q of [{}, { account: 'guest-1' }, { id: 'string', account: 'string' }, { id: 'hat-baseball', account: 'guest-1' }]) {
			const r = await call(q);
			expect(r.status).toBe(402);
			expect(Array.isArray(r.parsed.accepts)).toBe(true);
			expect(r.parsed.accepts.length).toBeGreaterThan(0);
		}
	});

	it('issues a 402 priced in USDC for a premium cosmetic', async () => {
		const r = await call({ id: 'skin-midnight', account: 'guest-1' });
		expect(r.status).toBe(402);
		const sol = (r.parsed.accepts || []).find((a) => String(a.network).startsWith('solana'));
		expect(sol).toBeTruthy();
		expect(sol.amount).toBe('3000000'); // $3.00 USDC, server-owned price
		expect(sol.asset).toBe('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
	});
});
