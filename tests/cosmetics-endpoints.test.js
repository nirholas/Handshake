// Endpoint coverage for the five /api/cosmetics/* handlers:
//
//   GET  /api/cosmetics/catalog      the shop catalog (+ per-account ownership)
//   GET  /api/cosmetics/owned        an account's purchased premium cosmetics
//   GET  /api/cosmetics/earnings     one creator's settled cosmetic earnings
//   GET  /api/cosmetics/leaderboard  the platform-wide flex board
//   GET/POST /api/cosmetics/split    a coin's creator revenue-split config
//
// Each handler gets its success path AND its failure path: bad input, wrong
// method, and (for the two ledger-backed reads) an unreachable ledger, which the
// two endpoints deliberately treat differently. A collection degrades to an
// honest empty board; a creator's balance must NOT degrade to a fabricated zero.
//
// The Neon `sql` tag and the Upstash Redis client are mocked so the handlers run
// against deterministic rows without a DB or a Redis instance. Everything else
// (the catalog, the rarity weighting, the split math, the HTTP envelope) is the
// real implementation.

import { describe, it, expect, beforeEach, vi } from 'vitest';

// ---- mocks ----

// Tagged-template `sql` stand-in. Tests install a matcher that maps the collapsed
// query text to rows; anything unmatched returns []. Set `sqlThrows` to simulate
// an unreachable ledger.
let sqlRows = () => [];
let sqlThrows = null;
vi.mock('../api/_lib/db.js', () => ({
	sql: (strings, ...values) => {
		if (sqlThrows) return Promise.reject(sqlThrows);
		const text = strings.join('?').replace(/\s+/g, ' ').trim();
		return Promise.resolve(sqlRows(text, values));
	},
	databaseConfigured: () => true,
	isDbUnavailableError: () => false,
	isDbCapacityError: () => false,
	isStoragePressured: () => false,
}));

// The ownership ledger is one Redis SET per account.
let ownedSets = new Map();
let redisThrows = false;
vi.mock('../api/_lib/redis.js', () => ({
	getRedis: () => ({
		smembers: async (key) => {
			if (redisThrows) throw new Error('redis unreachable');
			return ownedSets.get(key) || [];
		},
		sismember: async (key, member) => ((ownedSets.get(key) || []).includes(member) ? 1 : 0),
		sadd: async () => 1,
		expire: async () => 1,
		get: async () => null,
		set: async () => 'OK',
		eval: async () => [1, 0, 0, 0],
	}),
	isRedisAuthError: () => false,
}));

// Creator resolution must not reach a live RPC or a coin lookup.
vi.mock('../api/_lib/coin/index.js', () => ({ loadCoinByMint: async () => null }));
vi.mock('../api/_lib/pump.js', () => ({
	getConnection: () => ({ getAccountInfo: async () => null }),
}));

let sigValid = false;
vi.mock('../api/_lib/siws.js', () => ({ verifySiwsSignature: () => sigValid }));

const { default: catalogHandler } = await import('../api/cosmetics/catalog.js');
const { default: ownedHandler } = await import('../api/cosmetics/owned.js');
const { default: earningsHandler } = await import('../api/cosmetics/earnings.js');
const { default: leaderboardHandler } = await import('../api/cosmetics/leaderboard.js');
const { default: splitHandler } = await import('../api/cosmetics/split.js');
const { splitConfigMessage, MAX_CREATOR_BPS } = await import('../api/_lib/cosmetics-economy.js');

// ---- harness ----

const THREE_MINT = 'FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump';
const CREATOR = '9wgvwps9qK5jNniC5RJdrYCfaV3CLKTnxYVqBjXwegEV';

function mkRes() {
	return {
		statusCode: 200,
		headers: {},
		body: undefined,
		writableEnded: false,
		headersSent: false,
		getHeader(k) { return this.headers[k.toLowerCase()]; },
		setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
		end(b) { this.body = b; this.writableEnded = true; },
	};
}

const parse = (res) => (res.body ? JSON.parse(res.body) : undefined);

async function call(handler, url, { method = 'GET', headers = {}, body } = {}) {
	const req = {
		method,
		url,
		headers: { host: 'three.ws', ...headers },
		socket: { remoteAddress: '127.0.0.1' },
	};
	if (body !== undefined) req.body = body;
	const res = mkRes();
	await handler(req, res);
	return res;
}

beforeEach(() => {
	sqlRows = () => [];
	sqlThrows = null;
	ownedSets = new Map();
	redisThrows = false;
	sigValid = false;
});

// ---- catalog ----

describe('GET /api/cosmetics/catalog', () => {
	it('serves the whole shop, publicly cacheable, with premium items locked for anonymous callers', async () => {
		const res = await call(catalogHandler, '/api/cosmetics/catalog');
		expect(res.statusCode).toBe(200);
		const { items, rarities } = parse(res);
		expect(items.length).toBeGreaterThan(0);
		expect(rarities).toEqual(['common', 'rare', 'epic', 'legendary']);
		expect(res.headers['cache-control']).toMatch(/^public, max-age=300/);
		expect(res.headers['access-control-allow-origin']).toBe('*');
		// Every priced item is locked until someone buys it.
		for (const item of items.filter((i) => i.premium)) {
			expect(item.locked).toBe(true);
			expect(item.owned).toBe(false);
		}
	});

	it('filters to one rarity tier and rejects an unknown one', async () => {
		const ok = await call(catalogHandler, '/api/cosmetics/catalog?rarity=epic');
		expect(ok.statusCode).toBe(200);
		const tiers = new Set(parse(ok).items.map((i) => i.rarity));
		expect([...tiers]).toEqual(['epic']);

		const bad = await call(catalogHandler, '/api/cosmetics/catalog?rarity=mythic');
		expect(bad.statusCode).toBe(400);
		expect(parse(bad).error).toBe('bad_rarity');
	});

	it('unlocks the items an identified account owns and keeps that response off shared caches', async () => {
		const anon = parse(await call(catalogHandler, '/api/cosmetics/catalog'));
		const premium = anon.items.find((i) => i.premium);
		ownedSets.set('cosmetics:owned:g_flexer', [premium.id]);

		const res = await call(catalogHandler, '/api/cosmetics/catalog?account=g_flexer');
		expect(res.statusCode).toBe(200);
		expect(res.headers['cache-control']).toBe('private, no-store');
		const mine = parse(res).items.find((i) => i.id === premium.id);
		expect(mine.owned).toBe(true);
		expect(mine.locked).toBe(false);
	});

	it('rejects a write with 405', async () => {
		const res = await call(catalogHandler, '/api/cosmetics/catalog', { method: 'POST' });
		expect(res.statusCode).toBe(405);
		expect(parse(res).error).toBe('method_not_allowed');
	});
});

// ---- owned ----

describe('GET /api/cosmetics/owned', () => {
	it('resolves the owned ids of an account into full catalog rows', async () => {
		const catalog = parse(await call(catalogHandler, '/api/cosmetics/catalog'));
		const premium = catalog.items.find((i) => i.premium);
		ownedSets.set('cosmetics:owned:g_flexer', [premium.id]);

		const res = await call(ownedHandler, '/api/cosmetics/owned?account=g_flexer');
		expect(res.statusCode).toBe(200);
		const out = parse(res);
		expect(out.account).toBe('g_flexer');
		expect(out.ownedIds).toEqual([premium.id]);
		expect(out.items).toHaveLength(1);
		expect(out.items[0]).toMatchObject({ id: premium.id, owned: true, currency: 'THREE' });
		expect(res.headers['cache-control']).toBe('no-store');
	});

	it('drops an id that is no longer in the catalog rather than rendering a ghost row', async () => {
		ownedSets.set('cosmetics:owned:g_flexer', ['retired-cosmetic-id']);
		const out = parse(await call(ownedHandler, '/api/cosmetics/owned?account=g_flexer'));
		expect(out.ownedIds).toEqual(['retired-cosmetic-id']);
		expect(out.items).toEqual([]);
	});

	it('degrades to an empty inventory when the ownership store is unreachable', async () => {
		redisThrows = true;
		const res = await call(ownedHandler, '/api/cosmetics/owned?account=g_flexer');
		expect(res.statusCode).toBe(200);
		expect(parse(res).items).toEqual([]);
	});

	it('rejects a missing or unusable account id with 400', async () => {
		for (const qs of ['', '?account=', '?account=ab', '?account=has%20a%20space']) {
			const res = await call(ownedHandler, `/api/cosmetics/owned${qs}`);
			expect(res.statusCode).toBe(400);
			expect(parse(res).error).toBe('account_required');
		}
	});
});

// ---- earnings ----

const EARNINGS_TOTALS = [{
	sales: 2, buyers: 2, earned: '500000', paid: '250000', pending: '250000',
	earned_30d: '250000', gross: '1000000',
	first_sale_at: '2026-06-01T00:00:00.000Z', last_sale_at: '2026-07-01T00:00:00.000Z',
}];

function earningsRows(text) {
	if (text.includes('count(distinct account)')) return EARNINGS_TOTALS;
	if (text.includes('group by mint')) return [{ mint: THREE_MINT, sales: 2, earned: '500000' }];
	if (text.includes('group by cosmetic_id, rarity')) {
		return [{ cosmetic_id: 'emote-headbang', rarity: 'rare', sales: 2, earned: '500000' }];
	}
	return [{
		cosmetic_id: 'emote-headbang', rarity: 'rare', mint: THREE_MINT, account: 'g_flexer',
		price_usdc_atomics: '500000', creator_cut_atomics: '250000', split_bps: 5000,
		payout_status: 'paid', payout_tx: 'sig', settled_at: '2026-07-01T00:00:00.000Z',
	}];
}

describe('GET /api/cosmetics/earnings', () => {
	it('sums the settled ledger into lifetime totals and breakdowns', async () => {
		sqlRows = earningsRows;
		const res = await call(earningsHandler, `/api/cosmetics/earnings?creator=${CREATOR}`);
		expect(res.statusCode).toBe(200);
		const out = parse(res);
		expect(out.creatorWallet).toBe(CREATOR);
		expect(out.currency).toBe('USDC');
		expect(out.totals).toMatchObject({ sales: 2, earnedUsdc: 0.5, paidUsdc: 0.25, pendingUsdc: 0.25, grossUsdc: 1 });
		expect(out.perCoin[0]).toEqual({ mint: THREE_MINT, sales: 2, earnedUsdc: 0.5 });
		expect(out.perCosmetic[0].name).toBe('Headbang');
		expect(out.recent[0].payoutStatus).toBe('paid');
		expect(res.headers['cache-control']).toBe('no-store');
	});

	it('reports a creator with no sales as real zeroes, not a 404', async () => {
		sqlRows = (text) => (text.includes('count(distinct account)')
			? [{ sales: 0, buyers: 0, earned: '0', paid: '0', pending: '0', earned_30d: '0', gross: '0', first_sale_at: null, last_sale_at: null }]
			: []);
		const res = await call(earningsHandler, `/api/cosmetics/earnings?creator=${CREATOR}`);
		expect(res.statusCode).toBe(200);
		expect(parse(res).totals.sales).toBe(0);
		expect(parse(res).recent).toEqual([]);
	});

	it('refuses to fabricate a zero balance when the ledger is unreachable', async () => {
		sqlThrows = new Error('connection terminated');
		const res = await call(earningsHandler, `/api/cosmetics/earnings?creator=${CREATOR}`);
		expect(res.statusCode).toBe(503);
		expect(parse(res).error).toBe('ledger_unavailable');
		// The failure must never look like settled financial data.
		expect(res.body).not.toContain('totals');
	});

	it('rejects a missing or malformed creator wallet with 400', async () => {
		for (const qs of ['', '?creator=', '?creator=not-a-wallet']) {
			const res = await call(earningsHandler, `/api/cosmetics/earnings${qs}`);
			expect(res.statusCode).toBe(400);
			expect(parse(res).error).toBe('creator_required');
		}
	});
});

// ---- leaderboard ----

const OWNER_ROWS = [
	{ cosmetic_id: 'emote-headbang', account: 'g_a', any_mint: THREE_MINT },
	{ cosmetic_id: 'emote-headbang', account: 'g_b', any_mint: THREE_MINT },
	{ cosmetic_id: 'skin-crimson', account: 'g_a', any_mint: null },
	{ cosmetic_id: 'no-such-cosmetic', account: 'g_c', any_mint: null },
];

function boardRows(text) {
	if (text.includes('array_agg(mint)')) return OWNER_ROWS;
	if (text.includes('group by creator_wallet')) return [{ creator_wallet: CREATOR, sales: 3, earned: '750000' }];
	return [{
		cosmetic_id: 'emote-headbang', rarity: 'rare', mint: THREE_MINT,
		account: 'g_a', price_usdc_atomics: '500000', settled_at: '2026-07-01T00:00:00.000Z',
	}];
}

describe('GET /api/cosmetics/leaderboard', () => {
	it('ranks rarest fits, collectors, creators and recent sales from settled rows', async () => {
		sqlRows = boardRows;
		const res = await call(leaderboardHandler, '/api/cosmetics/leaderboard');
		expect(res.statusCode).toBe(200);
		const out = parse(res);
		// The single-owner skin outranks the two-owner emote on scarcity.
		expect(out.rarestFits.map((f) => f.cosmeticId)).toEqual(['skin-crimson', 'emote-headbang']);
		// An id that no longer exists in the catalog is skipped entirely.
		expect(out.rarestFits.some((f) => f.cosmeticId === 'no-such-cosmetic')).toBe(false);
		expect(out.topCollectors[0]).toEqual({ account: 'g_a', flexScore: 8, fits: 2 });
		expect(out.topCreators[0]).toEqual({ wallet: CREATOR, sales: 3, earnedUsdc: 0.75 });
		expect(out.recent[0].name).toBe('Headbang');
		expect(res.headers['cache-control']).toMatch(/^public, max-age=15/);
	});

	it('clamps limit to the 1..50 band and ignores a non-numeric one', async () => {
		const seen = [];
		sqlRows = (text, values) => { seen.push(values[values.length - 1]); return boardRows(text); };
		await call(leaderboardHandler, '/api/cosmetics/leaderboard?limit=999');
		await call(leaderboardHandler, '/api/cosmetics/leaderboard?limit=-5');
		await call(leaderboardHandler, '/api/cosmetics/leaderboard?limit=abc');
		// Three calls, each issuing two limit-bearing queries after the owner scan.
		expect(seen.filter((v) => typeof v === 'number')).toEqual([50, 50, 1, 1, 12, 12]);
	});

	it('serves an honest empty board when the ledger is unreachable', async () => {
		sqlThrows = new Error('connection terminated');
		const res = await call(leaderboardHandler, '/api/cosmetics/leaderboard');
		expect(res.statusCode).toBe(200);
		expect(parse(res)).toEqual({ currency: 'USDC', rarestFits: [], topCollectors: [], topCreators: [], recent: [] });
	});

	it('rejects a write with 405', async () => {
		const res = await call(leaderboardHandler, '/api/cosmetics/leaderboard', { method: 'POST' });
		expect(res.statusCode).toBe(405);
	});
});

// ---- split ----

describe('/api/cosmetics/split', () => {
	it('serves the stored split of a coin with the exact message the creator must sign', async () => {
		sqlRows = (text) => (text.includes('from cosmetic_creator_splits')
			? [{ mint: THREE_MINT, creator_wallet: CREATOR, split_bps: 6000, updated_at: '2026-07-01T00:00:00.000Z' }]
			: []);
		const res = await call(splitHandler, `/api/cosmetics/split?mint=${THREE_MINT}`);
		expect(res.statusCode).toBe(200);
		const out = parse(res);
		expect(out).toMatchObject({ mint: THREE_MINT, creatorWallet: CREATOR, splitBps: 6000, isDefault: false, maxBps: MAX_CREATOR_BPS });
		expect(out.signTemplate.message).toBe(
			splitConfigMessage({ mint: THREE_MINT, bps: 6000, ts: out.signTemplate.ts }),
		);
		expect(res.headers['access-control-allow-credentials']).toBeUndefined();
	});

	it('falls open to a priceable default config when the config read fails', async () => {
		sqlThrows = new Error('connection terminated');
		const res = await call(splitHandler, `/api/cosmetics/split?mint=${THREE_MINT}`);
		expect(res.statusCode).toBe(200);
		expect(parse(res)).toMatchObject({ creatorWallet: null, splitBps: 0, source: 'none', maxBps: MAX_CREATOR_BPS });
	});

	it('rejects a missing or malformed mint on read with 400', async () => {
		for (const qs of ['', '?mint=', '?mint=nope']) {
			const res = await call(splitHandler, `/api/cosmetics/split${qs}`);
			expect(res.statusCode).toBe(400);
			expect(parse(res).error).toBe('bad_mint');
		}
	});

	it('refuses a write signed by anyone but the resolved coin creator', async () => {
		sigValid = true;
		sqlRows = (text) => (text.includes('from cosmetic_creator_splits') ? [{ creator_wallet: CREATOR }] : []);
		const ts = Math.floor(Date.now() / 1000);
		const res = await call(splitHandler, '/api/cosmetics/split', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: { mint: THREE_MINT, bps: 4000, ts, signature: 'sig', signer: '11111111111111111111111111111112' },
		});
		expect(res.statusCode).toBe(403);
		expect(parse(res).error).toBe('not_creator');
	});

	it('refuses a write whose signature does not verify against the creator wallet', async () => {
		sigValid = false;
		sqlRows = (text) => (text.includes('from cosmetic_creator_splits') ? [{ creator_wallet: CREATOR }] : []);
		const ts = Math.floor(Date.now() / 1000);
		const res = await call(splitHandler, '/api/cosmetics/split', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: { mint: THREE_MINT, bps: 4000, ts, signature: 'sig', signer: CREATOR },
		});
		expect(res.statusCode).toBe(401);
		expect(parse(res).error).toBe('bad_signature');
	});

	it('refuses a replayed (stale) signature', async () => {
		const res = await call(splitHandler, '/api/cosmetics/split', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: { mint: THREE_MINT, bps: 4000, ts: 1, signature: 'sig', signer: CREATOR },
		});
		expect(res.statusCode).toBe(400);
		expect(parse(res).error).toBe('stale_signature');
	});

	it('answers a non-JSON content-type with 415, not a misleading bad-payload 400', async () => {
		const res = await call(splitHandler, '/api/cosmetics/split', {
			method: 'POST',
			headers: { 'content-type': 'text/plain' },
			body: 'mint=x',
		});
		expect(res.statusCode).toBe(415);
		expect(parse(res).error).toBe('unsupported_media_type');
	});

	it('rejects an unsupported method with 405', async () => {
		const res = await call(splitHandler, '/api/cosmetics/split', { method: 'DELETE' });
		expect(res.statusCode).toBe(405);
	});
});
