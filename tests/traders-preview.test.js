// Contract tests for GET /api/traders/preview: the public wallet track-record
// read behind /claim-wallet.
//
// Four defects this endpoint shipped with, each pinned below:
//
//   1. A database fault was swallowed by walletProfile()'s blanket catch, so an
//      unreachable brain answered 200 `{known:false, claimable:false, coins:[]}`
//      with `Cache-Control: public, max-age=120, stale-while-revalidate=300`.
//      A 30-second Neon blip pinned "this wallet has no track record" over a
//      real trader's record for the life of the CDN entry. Same class of bug as
//      the Oracle read APIs in tests/oracle/api-db-outage.test.js; this endpoint
//      was missed by that sweep.
//   2. `network=devnet` answered with the wallet's MAINNET trades: only the
//      reputation read filtered on network, the coin read never did.
//   3. `claimable` required a wallet_reputation row, so a wallet with thousands
//      of indexed pump.fun trades rendered as "no record found" whenever the
//      rollup scorer hadn't graded it yet: which is the normal state for a
//      wallet the indexer just picked up.
//   4. Win/loss counted every non-positive pnl, so an untouched open bag was a
//      realized loss: a sniper holding 60 fresh positions read "0 wins / 60
//      losses" next to `win_rate_window: null`, and the server disagreed with
//      the client's own closed-only aggregate() on the same numbers.

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../api/_lib/http.js', async () => {
	const actual = await vi.importActual('../api/_lib/http.js');
	return {
		...actual,
		// wrap() is this contract's counterpart: it converts a propagated fault
		// into the shared 503 + Retry-After. Reduce it to identity so a test can
		// assert "the handler rejected" without the ops-alert and Sentry side
		// effects the real wrap() fires.
		wrap: (fn) => fn,
		cors: () => false,
		method: () => true,
		rateLimited: (res) => { res._rateLimited = true; },
		json: (res, status, body, headers = {}) => { res._json = { status, body, headers }; return res; },
		error: (res, status, code, message) => {
			res._json = { status, body: { error: code, error_description: message } };
			return res;
		},
	};
});

vi.mock('../api/_lib/rate-limit.js', () => ({
	limits: { publicIp: vi.fn(async () => ({ success: true })) },
	clientIp: () => '1.2.3.4',
}));

// The real classifier on a stubbed transport: the handler has to route on
// isDbUnavailableError() correctly, so mocking that function would test nothing.
// `dbQueue` answers the tagged-template reads in order (walletProfile issues the
// reputation read first, then the coin read); an Error entry rejects instead.
let dbQueue = [];
const dbCalls = [];
vi.mock('../api/_lib/db.js', async () => {
	const actual = await vi.importActual('../api/_lib/db.js');
	return {
		...actual,
		sql: (strings, ...values) => {
			dbCalls.push({ text: Array.isArray(strings) ? strings.join('?') : String(strings), values });
			const next = dbQueue.shift();
			if (next instanceof Error) return Promise.reject(next);
			return Promise.resolve(next || []);
		},
	};
});

import { isDbUnavailableError } from '../api/_lib/db.js';
import preview from '../api/traders/preview.js';

// Shaped the way the Neon driver actually throws a transport failure: the `name`
// is load-bearing, because db.js only reads a connection-level message as an
// outage on a NeonDbError. A plain Error with the same text would test nothing.
const CONN_ERROR = Object.assign(new Error('Error connecting to database: fetch failed'), {
	name: 'NeonDbError',
});
const NO_URL_ERROR = new Error('Missing required env var: DATABASE_URL');
const STATEMENT_ERROR = new Error('column "nope" does not exist');

const WALLET = 'H454CBvtoGr5H4Eycmw5WusfWLCRCF8bbv7tRWPt787p';
const LAMPORTS = 1e9;

function fakeRes() {
	return {
		statusCode: 200,
		_headers: {},
		setHeader(k, v) { this._headers[k.toLowerCase()] = v; },
		getHeader(k) { return this._headers[k.toLowerCase()]; },
		end() { this.writableEnded = true; },
	};
}

function fakeReq(url) {
	return { method: 'GET', url, headers: { host: 'three.ws' } };
}

// One pump_coin_wallets row, shaped the way the indexer writes it.
function coinRow(mint, { buySol = 1, sellSol = 0, bought = 1000, sold = 0, category = 'meme', creator = false } = {}) {
	return {
		mint,
		buy_count: 1,
		sell_count: sellSol > 0 ? 1 : 0,
		buy_lamports: String(buySol * LAMPORTS),
		sell_lamports: String(sellSol * LAMPORTS),
		base_bought: String(bought),
		base_sold: String(sold),
		is_creator: creator,
		first_seen_at: '2026-08-01T00:00:00.000Z',
		last_seen_at: '2026-08-01T00:10:00.000Z',
		symbol: mint.slice(0, 4),
		name: mint,
		image_uri: null,
		category,
		quality_score: 50,
		narrative: null,
		graduated: null,
		rugged: null,
		ath_multiple: null,
		last_market_cap_usd: null,
	};
}

const REP_ROW = {
	wallet: WALLET,
	coins_traded: 72, early_entries: 72, wins: 72, early_wins: 72, duds: 0, dumps: 0,
	creator_count: 0, creator_wins: 0,
	win_rate: 100, early_win_rate: 100, dump_rate: 0, smart_money_score: 100,
	label: 'smart_money',
	first_seen_at: '2026-07-29T11:25:01.117Z',
	last_active_at: '2026-08-06T09:05:01.633Z',
};

async function run(url) {
	const res = fakeRes();
	await preview(fakeReq(url), res);
	return res;
}

beforeEach(() => {
	dbQueue = [];
	dbCalls.length = 0;
});

describe('the classifier the outage contract branches on', () => {
	it('separates a connectivity failure from a statement fault', () => {
		expect(isDbUnavailableError(CONN_ERROR)).toBe(true);
		expect(isDbUnavailableError(NO_URL_ERROR)).toBe(true);
		expect(isDbUnavailableError(STATEMENT_ERROR)).toBe(false);
	});
});

describe('GET /api/traders/preview: input validation', () => {
	it('rejects a missing wallet with a 400 JSON error, never a stack trace', async () => {
		const res = await run('/api/traders/preview');
		expect(res._json.status).toBe(400);
		expect(res._json.body.error).toBe('invalid_wallet');
		expect(dbCalls).toHaveLength(0);
	});

	it('rejects base-58 lookalikes and injection-shaped input before any query', async () => {
		for (const bad of ['abc', '0OIl0OIl0OIl0OIl0OIl0OIl0OIl0OIl', "' or 1=1--", 'A'.repeat(5000)]) {
			const res = await run(`/api/traders/preview?wallet=${encodeURIComponent(bad)}`);
			expect(res._json.status).toBe(400);
		}
		expect(dbCalls).toHaveLength(0);
	});
});

describe('GET /api/traders/preview: outage honesty', () => {
	it('propagates a connectivity failure instead of publishing an empty record', async () => {
		dbQueue = [CONN_ERROR];
		await expect(run(`/api/traders/preview?wallet=${WALLET}`)).rejects.toThrow(/connecting to database/);
	});

	it('propagates an unset DATABASE_URL rather than answering "wallet not indexed"', async () => {
		dbQueue = [NO_URL_ERROR];
		await expect(run(`/api/traders/preview?wallet=${WALLET}`)).rejects.toThrow(/DATABASE_URL/);
	});

	it('propagates a fault on the coin read too, after the reputation read succeeded', async () => {
		// A half-answered profile is the worst outcome of all: it would publish a
		// graded reputation next to an empty ledger and cache that for two minutes.
		dbQueue = [[REP_ROW], CONN_ERROR];
		await expect(run(`/api/traders/preview?wallet=${WALLET}`)).rejects.toThrow(/connecting to database/);
	});

	it('propagates a statement fault as well, because there is no partial answer worth caching', async () => {
		dbQueue = [STATEMENT_ERROR];
		await expect(run(`/api/traders/preview?wallet=${WALLET}`)).rejects.toThrow(/does not exist/);
	});
});

describe('GET /api/traders/preview: network scoping', () => {
	it('scopes the coin read to the requested network, not just the reputation read', async () => {
		dbQueue = [[], []];
		await run(`/api/traders/preview?wallet=${WALLET}&network=devnet`);
		expect(dbCalls).toHaveLength(2);
		const [rep, coins] = dbCalls;
		expect(rep.values).toContain('devnet');
		expect(coins.text).toMatch(/i\.network/);
		expect(coins.values).toContain('devnet');
	});

	it('falls back to mainnet for an unknown network rather than trusting the caller', async () => {
		dbQueue = [[], []];
		const res = await run(`/api/traders/preview?wallet=${WALLET}&network=pwned`);
		expect(res._json.body.network).toBe('mainnet');
		expect(dbCalls[1].values).toContain('mainnet');
	});
});

describe('GET /api/traders/preview: claimability', () => {
	it('is claimable on indexed trades alone, before the rollup has graded the wallet', async () => {
		dbQueue = [[], [coinRow('MintAAAA')]];
		const res = await run(`/api/traders/preview?wallet=${WALLET}`);
		expect(res._json.status).toBe(200);
		expect(res._json.body.known).toBe(false);
		expect(res._json.body.profile).toBeNull();
		expect(res._json.body.claimable).toBe(true);
	});

	it('is claimable on a graded reputation alone, before the coin ledger loads any rows', async () => {
		dbQueue = [[REP_ROW], []];
		const res = await run(`/api/traders/preview?wallet=${WALLET}`);
		expect(res._json.body.known).toBe(true);
		expect(res._json.body.claimable).toBe(true);
	});

	it('reports a genuinely unseen wallet as neither known nor claimable', async () => {
		dbQueue = [[], []];
		const res = await run(`/api/traders/preview?wallet=${WALLET}`);
		expect(res._json.body.known).toBe(false);
		expect(res._json.body.claimable).toBe(false);
		expect(res._json.body.summary.total_coins).toBe(0);
	});
});

describe('GET /api/traders/preview: realized vs open accounting', () => {
	// Three positions, hand-computed:
	//   WIN   bought 1 SOL, sold 3 SOL, fully exited  → closed, +2 SOL, roi +2
	//   LOSS  bought 2 SOL, sold 1 SOL, fully exited  → closed, −1 SOL, roi −0.5
	//   OPEN  bought 4 SOL, sold nothing, bag intact  → open, realized −4 SOL
	const LEDGER = [
		coinRow('MintWIN', { buySol: 1, sellSol: 3, bought: 1000, sold: 1000 }),
		coinRow('MintLOSS', { buySol: 2, sellSol: 1, bought: 1000, sold: 1000, category: 'ai' }),
		coinRow('MintOPEN', { buySol: 4, sellSol: 0, bought: 1000, sold: 0 }),
	];

	it('counts only closed positions as wins and losses', async () => {
		dbQueue = [[REP_ROW], LEDGER];
		const { summary } = (await run(`/api/traders/preview?wallet=${WALLET}`))._json.body;
		expect(summary.total_coins).toBe(3);
		expect(summary.closed_coins).toBe(2);
		expect(summary.open_positions).toBe(1);
		expect(summary.wins_in_window).toBe(1);
		expect(summary.losses_in_window).toBe(1);
		expect(summary.win_rate_window).toBe(0.5);
	});

	it('reports realized PnL separately from the buy-inclusive net', async () => {
		dbQueue = [[REP_ROW], LEDGER];
		const { summary } = (await run(`/api/traders/preview?wallet=${WALLET}`))._json.body;
		// Realized: +2 from the winner, −1 from the loser. The open bag's 4 SOL
		// buy is not a realized loss and must not touch this number.
		expect(summary.realized_pnl_sol).toBe(1);
		// Net still books every lamport in and out: (3+1+0) − (1+2+4) = −3.
		expect(summary.net_pnl_sol).toBe(-3);
		expect(summary.total_buy_sol).toBe(7);
		expect(summary.total_sell_sol).toBe(4);
		expect(summary.total_volume_sol).toBe(11);
	});

	it('buckets closed positions by realized return and leaves open bags out', async () => {
		dbQueue = [[REP_ROW], LEDGER];
		const { summary } = (await run(`/api/traders/preview?wallet=${WALLET}`))._json.body;
		// +2× lands in x2, −50% lands in down, the open bag is in neither.
		expect(summary.distribution).toEqual({ x5: 0, x2: 1, up: 0, down: 1, rug: 0 });
	});

	it('marks a fully-held position open and a fully-exited one closed', async () => {
		dbQueue = [[REP_ROW], LEDGER];
		const { coins } = (await run(`/api/traders/preview?wallet=${WALLET}`))._json.body;
		const byMint = Object.fromEntries(coins.map((c) => [c.mint, c]));
		expect(byMint.MintOPEN.open).toBe(true);
		expect(byMint.MintOPEN.base_held).toBe(1000);
		expect(byMint.MintWIN.open).toBe(false);
		expect(byMint.MintWIN.base_held).toBe(0);
		expect(byMint.MintWIN.pnl_sol).toBe(2);
		expect(byMint.MintWIN.roi).toBe(2);
	});

	it('serves a successful read from the CDN and normalizes every timestamp', async () => {
		dbQueue = [[REP_ROW], LEDGER];
		const res = await run(`/api/traders/preview?wallet=${WALLET}`);
		expect(res._json.headers['Cache-Control']).toMatch(/max-age=120/);
		expect(res._json.body.profile.label).toBe('smart_money');
		expect(res._json.body.profile.first_seen_at).toBe('2026-07-29T11:25:01.117Z');
		for (const c of res._json.body.coins) {
			expect(c.first_seen_at).toBe('2026-08-01T00:00:00.000Z');
			expect(c.hold_ms).toBe(600000);
		}
	});
});
