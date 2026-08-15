// POST /api/trading/scan: the Trading Brain's assisted "what would my agent buy
// right now?" preview.
//
// The launch feed, the on-chain quote, the firewall, and the RPC connection are
// mocked; the entry gate (api/_lib/strategy-schema.js) is the real one, because
// the whole point of the endpoint is that the owner sees exactly what the
// autonomous runner would act on. Covered here: auth + ownership gating, input
// validation, the devnet honesty note, a mainnet success path that carries a real
// quote and firewall verdict per candidate, and the three regressions that made
// this handler worth auditing:
//
//   1. an owner-writable meta.solana_address that is not a valid pubkey used to
//      throw out of the handler and surface as a 500;
//   2. a creator-gated rule paid for a live creator lookup on every launch in the
//      feed page, including ones already rejected on age or market cap;
//   3. `scanned` reported the feed page size even though the loop stops early at
//      MAX_PRICED matches.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Readable } from 'node:stream';

const AGENT_ID = '11111111-2222-4333-8444-555555555555';
const OWNER_ID = 'owner-1';
const AGENT_ADDR = '3Bx1x2kzFqPVDqQxfCVJUmqB7B9ZBRRQ4h6sBLKKTBiN';
// Coin-agnostic synthetic mints: this endpoint scans whatever the live feed
// returns and promotes nothing. $THREE remains the only coin three.ws promotes.
const MINT_A = 'THREEsynthetic1111111111111111111111111AAAA';
const MINT_B = 'THREEsynthetic1111111111111111111111111BBBB';

const sqlState = { agent: null };
vi.mock('../api/_lib/db.js', () => ({
	sql: vi.fn(async () => (sqlState.agent ? [sqlState.agent] : [])),
	isDbUnavailableError: () => false,
	isDbCapacityError: () => false,
}));

const authState = { session: { id: OWNER_ID }, bearer: null };
vi.mock('../api/_lib/auth.js', () => ({
	getSessionUser: vi.fn(async () => authState.session),
	authenticateBearer: vi.fn(async () => authState.bearer),
	extractBearer: vi.fn(() => null),
}));

const rlState = { ip: { success: true }, owner: { success: true } };
vi.mock('../api/_lib/rate-limit.js', () => ({
	limits: {
		authedReadIp: vi.fn(async () => rlState.ip),
		tradingScan: vi.fn(async () => rlState.owner),
	},
	clientIp: () => '127.0.0.1',
}));

const feedState = { launches: [], throws: false, creatorCalls: [] };
vi.mock('../api/_lib/pump-launch-feed.js', () => ({
	recentPumpLaunches: vi.fn(async () => {
		if (feedState.throws) throw new Error('feed down');
		return feedState.launches;
	}),
	enrichCreatorStats: vi.fn(async (launch) => {
		feedState.creatorCalls.push(launch.mint);
		launch.creator_launches = 1;
		launch.creator_graduated = 1;
		return launch;
	}),
}));

const quoteState = { throwsFor: new Set() };
vi.mock('../api/agents/solana-trade.js', () => ({
	quoteTrade: vi.fn(async ({ mintStr }) => {
		if (quoteState.throwsFor.has(mintStr)) throw new Error('no curve for this mint');
		return {
			outUi: 1234.5,
			priceImpactPct: 0.42,
			venue: 'bonding_curve',
			minOutAtomics: '1172775000',
			decimals: 6,
			inAtomics: '100000000',
		};
	}),
}));

const firewallState = { seenPayers: [] };
vi.mock('../api/_lib/trade-firewall.js', () => ({
	assessTradeSafety: vi.fn(async ({ payer }) => {
		firewallState.seenPayers.push(payer ?? null);
		return { verdict: 'allow', score: 100, simulated: true, reasons: ['ok'] };
	}),
}));

vi.mock('../api/_lib/agent-pumpfun.js', () => ({
	solanaConnection: vi.fn(() => ({})),
}));

const handler = (await import('../api/trading/scan.js')).default;

function mockRes() {
	return {
		statusCode: 200,
		_headers: {},
		_body: '',
		setHeader(k, v) { this._headers[k.toLowerCase()] = v; },
		getHeader(k) { return this._headers[k.toLowerCase()]; },
		end(b) { this._body = b || ''; },
		get headersSent() { return false; },
		get writableEnded() { return false; },
		get json() { try { return JSON.parse(this._body); } catch { return null; } },
	};
}

function mockReq({ method = 'POST', body = null } = {}) {
	const chunks = body != null ? [Buffer.from(JSON.stringify(body))] : [];
	const r = Readable.from(chunks);
	r.method = method;
	r.url = '/api/trading/scan';
	r.headers = { origin: 'http://localhost:3000', 'content-type': 'application/json' };
	return r;
}

async function scan(body) {
	const res = mockRes();
	await handler(mockReq({ body }), res);
	return res;
}

// A launch the default rule accepts: fresh, quoted in SOL, with socials.
function freshLaunch(mint, over = {}) {
	return {
		mint,
		name: 'Synthetic Test Launch',
		symbol: 'SYNTH',
		created_at: Date.now() - 60_000,
		market_cap_usd: 5_000,
		liquidity_sol: 12,
		creator: `creator-of-${mint}`,
		twitter: 'https://x.com/example',
		...over,
	};
}

beforeEach(() => {
	sqlState.agent = { id: AGENT_ID, user_id: OWNER_ID, meta: { solana_address: AGENT_ADDR } };
	authState.session = { id: OWNER_ID };
	authState.bearer = null;
	rlState.ip = { success: true };
	rlState.owner = { success: true };
	feedState.launches = [];
	feedState.throws = false;
	feedState.creatorCalls = [];
	quoteState.throwsFor = new Set();
	firewallState.seenPayers = [];
});

describe('POST /api/trading/scan gating', () => {
	it('rejects an anonymous caller with 401', async () => {
		authState.session = null;
		const res = await scan({ agent_id: AGENT_ID });
		expect(res.statusCode).toBe(401);
		expect(res.json.error).toBe('unauthorized');
	});

	it('rejects a non-POST method with 405', async () => {
		const res = mockRes();
		await handler(mockReq({ method: 'GET' }), res);
		expect(res.statusCode).toBe(405);
	});

	it('rejects a missing or malformed agent_id with a structured 400', async () => {
		for (const body of [{}, { agent_id: 'not-a-uuid' }, { agent_id: 42 }]) {
			const res = await scan(body);
			expect(res.statusCode).toBe(400);
			expect(res.json.error).toBe('validation_error');
		}
	});

	it("404s on an agent the caller does not own", async () => {
		sqlState.agent = null;
		const res = await scan({ agent_id: AGENT_ID });
		expect(res.statusCode).toBe(404);
		expect(res.json.error).toBe('not_found');
	});

	it('applies a per-owner ceiling on top of the per-IP bucket', async () => {
		rlState.owner = { success: false, limit: 30, remaining: 0, reset: Date.now() + 1000 };
		const res = await scan({ agent_id: AGENT_ID });
		expect(res.statusCode).toBe(429);
		// The feed must not be touched once the owner bucket is empty.
		expect(feedState.creatorCalls).toEqual([]);
	});

	it('502s with a recoverable message when the live feed is unreachable', async () => {
		feedState.throws = true;
		const res = await scan({ agent_id: AGENT_ID });
		expect(res.statusCode).toBe(502);
		expect(res.json.error).toBe('feed_unavailable');
		expect(res.json.error_description).toMatch(/try again/i);
	});
});

describe('POST /api/trading/scan results', () => {
	it('is honest that live scanning is mainnet-only instead of returning an empty list', async () => {
		const res = await scan({ agent_id: AGENT_ID, config: { network: 'devnet' } });
		expect(res.statusCode).toBe(200);
		expect(res.json.data.network).toBe('devnet');
		expect(res.json.data.candidates).toEqual([]);
		expect(res.json.data.note).toMatch(/mainnet only/i);
	});

	it('prices each match with a real quote and firewall verdict', async () => {
		feedState.launches = [freshLaunch(MINT_A)];
		const res = await scan({ agent_id: AGENT_ID, config: {} });
		expect(res.statusCode).toBe(200);
		const { data } = res.json;
		expect(data.matched).toBe(1);
		const [cand] = data.candidates;
		expect(cand.mint).toBe(MINT_A);
		expect(cand.quote).toMatchObject({ venue: 'bonding_curve', out_ui: 1234.5, price_impact_pct: 0.42 });
		expect(cand.firewall).toMatchObject({ verdict: 'allow', score: 100, simulated: true });
		expect(cand.has_socials).toBe(true);
		expect(cand.amount_sol).toBe(data.amount_sol);
		expect(firewallState.seenPayers).toEqual([AGENT_ADDR]);
	});

	it('marks an unquotable coin as such rather than dropping or faking it', async () => {
		quoteState.throwsFor = new Set([MINT_A]);
		feedState.launches = [freshLaunch(MINT_A)];
		const res = await scan({ agent_id: AGENT_ID, config: {} });
		const [cand] = res.json.data.candidates;
		expect(cand.quote).toBeNull();
		expect(cand.firewall.verdict).toBe('warn');
		expect(cand.firewall.reasons[0]).toMatch(/could not quote/i);
	});

	it('reports the launches it actually examined, not the size of the feed page', async () => {
		// Ten matchable launches, but the loop stops at MAX_PRICED (6) because each
		// match costs a quote plus a firewall simulation. Claiming ten were scanned
		// would overstate the work behind the answer.
		feedState.launches = Array.from({ length: 10 }, (_, i) => freshLaunch(`${MINT_A}${i}`));
		const res = await scan({ agent_id: AGENT_ID, config: {} });
		expect(res.json.data.matched).toBe(6);
		expect(res.json.data.scanned).toBe(6);
		expect(res.json.data.feed_size).toBe(10);
	});

	it('examines the whole feed page when fewer than MAX_PRICED launches match', async () => {
		feedState.launches = [
			freshLaunch(MINT_A),
			freshLaunch(MINT_B, { created_at: Date.now() - 7 * 24 * 3600 * 1000 }),
		];
		const res = await scan({ agent_id: AGENT_ID, config: {} });
		expect(res.json.data.scanned).toBe(2);
		expect(res.json.data.feed_size).toBe(2);
		expect(res.json.data.matched).toBe(1);
	});

	it('does not 500 when the agent wallet address on the row is unparsable', async () => {
		// meta.solana_address is owner-writable through PATCH /api/agents/:id.
		sqlState.agent = { id: AGENT_ID, user_id: OWNER_ID, meta: { solana_address: 'not a pubkey' } };
		feedState.launches = [freshLaunch(MINT_A)];
		const res = await scan({ agent_id: AGENT_ID, config: {} });
		expect(res.statusCode).toBe(200);
		expect(res.json.data.matched).toBe(1);
		// The firewall owns pubkey resolution and downgrades a bad one to a skip.
		expect(firewallState.seenPayers).toEqual(['not a pubkey']);
	});
});

describe('POST /api/trading/scan creator-stat lookups', () => {
	const creatorRule = { entry: { min_creator_graduated: 1 } };

	it('buys a creator lookup only for launches the rest of the rule already likes', async () => {
		feedState.launches = [
			freshLaunch(MINT_A),
			// Rejected on age long before the creator gate can matter.
			freshLaunch(MINT_B, { created_at: Date.now() - 7 * 24 * 3600 * 1000 }),
		];
		const res = await scan({ agent_id: AGENT_ID, config: creatorRule });
		expect(res.statusCode).toBe(200);
		expect(feedState.creatorCalls).toEqual([MINT_A]);
		expect(res.json.data.matched).toBe(1);
	});

	it('never looks a creator up when the rule does not gate on creator stats', async () => {
		feedState.launches = [freshLaunch(MINT_A)];
		await scan({ agent_id: AGENT_ID, config: {} });
		expect(feedState.creatorCalls).toEqual([]);
	});

	it('re-checks the gate after enrichment and drops a creator that still fails', async () => {
		feedState.launches = [freshLaunch(MINT_A)];
		const res = await scan({ agent_id: AGENT_ID, config: { entry: { min_creator_graduated: 5 } } });
		expect(feedState.creatorCalls).toEqual([MINT_A]);
		expect(res.json.data.matched).toBe(0);
	});
});
