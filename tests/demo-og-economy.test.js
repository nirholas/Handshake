// Regression cover for the two remaining /api/demo/* handlers.
//
// api/demo/coin/og.js: the brand card resolved the active coin twice. The
// condition read `mint || (await listActiveCoins()).length === 1 ? ... : null`,
// where `||` binds looser than `===`, so the guard ran listActiveCoins() and
// then resolveCoin() ran it again. Every un-parameterised share-card hit (the
// common case, since social scrapers fetch the bare URL) paid for two queries.
//
// api/demo/economy.js: `?status=1` returned before the rate limiter, so the
// branch that fans out to two Solana RPC balance reads plus a SOL price lookup
// was reachable without limit by any anonymous caller.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const MINT = 'THREEsynthetic1111111111111111111111111111';
const ORACLE = 'ORACLEaddr11111111111111111111111111111111';
const TRADER = 'TRADERaddr11111111111111111111111111111111';

// ── Shared doubles ─────────────────────────────────────────────────────────

vi.mock('@vercel/og', () => ({
	ImageResponse: class {
		constructor(node, opts) {
			this.node = node;
			this.status = 200;
			this.headers = new Map(Object.entries({ 'content-type': 'image/png', ...(opts?.headers || {}) }));
		}
		async arrayBuffer() {
			return new Uint8Array([0x89, 0x50, 0x4e, 0x47]).buffer;
		}
	},
}));

const sqlCalls = [];
vi.mock('../api/_lib/db.js', () => ({
	sql: (strings, ...values) => {
		sqlCalls.push({ text: strings.join('?'), values });
		return Promise.resolve([{ eligible: 3 }]);
	},
}));

const listActiveCoins = vi.fn();
const loadCoinByMint = vi.fn();
vi.mock('../api/_lib/coin/index.js', () => ({
	listActiveCoins: (...a) => listActiveCoins(...a),
	loadCoinByMint: (...a) => loadCoinByMint(...a),
}));

const publicIp = vi.fn(async () => ({ success: true, limit: 60, remaining: 59, reset: Date.now() + 60_000 }));
vi.mock('../api/_lib/rate-limit.js', () => ({
	limits: { publicIp: (...a) => publicIp(...a) },
	clientIp: () => '127.0.0.1',
}));

const getSolBalance = vi.fn(async () => ({ sol: 1.5, lamports: 1_500_000_000 }));
const sendSol = vi.fn(async () => 'SIGNATURE_SHOULD_NEVER_BE_REACHED');
vi.mock('../api/_lib/avatar-wallet.js', () => ({
	avatarWalletConfig: () => ({ configured: true, address: ORACLE, explorer: `https://solscan.io/account/${ORACLE}` }),
	loadAvatarKeypair: () => ({ publicKey: { toBase58: () => TRADER } }),
	getConnection: () => ({}),
	getSolBalance: (...a) => getSolBalance(...a),
	solUsdPrice: async () => 75,
	sendSol: (...a) => sendSol(...a),
	explorerTxUrl: (s) => `https://solscan.io/tx/${s}`,
	explorerAccountUrl: (a) => `https://solscan.io/account/${a}`,
	LAMPORTS_PER_SOL: 1_000_000_000,
}));

const trendingPools = vi.fn(async () => [{ name: 'SOL/USDC', priceUsd: 75, change24h: 1.2, pool: 'pool1' }]);
vi.mock('../api/_lib/market/ohlcv.js', () => ({ trendingPools: (...a) => trendingPools(...a) }));

const getSessionUser = vi.fn(async () => null);
const authenticateBearer = vi.fn(async () => null);
vi.mock('../api/_lib/auth.js', () => ({
	getSessionUser: (...a) => getSessionUser(...a),
	authenticateBearer: (...a) => authenticateBearer(...a),
	extractBearer: (req) => (req.headers?.authorization || '').replace(/^Bearer /, '') || null,
}));

const { default: og } = await import('../api/demo/coin/og.js');
const { default: economy } = await import('../api/demo/economy.js');

const COIN = {
	id: 7,
	mint: MINT,
	symbol: 'THREE',
	min_holder_balance: '1000',
	lottery_pot_lamports: '5000000000',
	reflection_pot_lamports: '2500000000',
};

function mkRes() {
	return {
		statusCode: 200,
		headers: {},
		chunks: [],
		body: undefined,
		headersSent: false,
		writableEnded: false,
		setHeader(k, v) {
			this.headers[k.toLowerCase()] = v;
		},
		getHeader(k) {
			return this.headers[k.toLowerCase()];
		},
		writeHead(code, hdrs) {
			this.statusCode = code;
			Object.assign(this.headers, hdrs || {});
			this.headersSent = true;
			return this;
		},
		write(c) {
			this.chunks.push(String(c));
			this.headersSent = true;
			return true;
		},
		end(b) {
			if (b !== undefined) this.body = b;
			this.writableEnded = true;
			this.headersSent = true;
		},
	};
}
const payload = (res) => {
	if (res.body === undefined) return undefined;
	try {
		return JSON.parse(res.body);
	} catch {
		return undefined;
	}
};

beforeEach(() => {
	// Production currently leaves this unset, which routes the trade stream down the
	// demo_mode branch (covered by its own case below). Set it here so the paid path
	// is exercised too, since that is the branch that signs a real transfer.
	process.env.AGENT_B_WALLET_SECRET = 'test-trader-secret';
	sqlCalls.length = 0;
	listActiveCoins.mockReset().mockResolvedValue([COIN]);
	loadCoinByMint.mockReset().mockResolvedValue(COIN);
	publicIp.mockClear();
	getSolBalance.mockClear();
	sendSol.mockClear();
	trendingPools.mockClear();
	getSessionUser.mockReset().mockResolvedValue(null);
	authenticateBearer.mockReset().mockResolvedValue(null);
});

describe('GET /api/demo/coin/og', () => {
	const mkReq = (qs = '') => ({ method: 'GET', url: `/api/demo/coin/og${qs}`, headers: {} });

	it('resolves the active coin exactly once when no mint is supplied', async () => {
		const res = mkRes();
		await og(mkReq(), res);
		expect(res.statusCode).toBe(200);
		// The pre-fix ternary called this twice for a single render.
		expect(listActiveCoins).toHaveBeenCalledTimes(1);
	});

	it('renders a PNG with a short cache for the live state card', async () => {
		const res = mkRes();
		await og(mkReq(`?mint=${MINT}`), res);
		expect(res.statusCode).toBe(200);
		expect(res.getHeader('content-type')).toBe('image/png');
		expect(res.getHeader('cache-control')).toContain('max-age=30');
		expect(Buffer.isBuffer(res.body)).toBe(true);
	});

	it('falls back to the brand card instead of erroring when the coin lookup throws', async () => {
		loadCoinByMint.mockRejectedValue(new Error('db unreachable'));
		const res = mkRes();
		await og(mkReq(`?mint=${MINT}`), res);
		expect(res.statusCode).toBe(200);
		expect(res.getHeader('content-type')).toBe('image/png');
	});

	it('405s a non-GET and 204s a preflight', async () => {
		const post = mkRes();
		await og({ ...mkReq(), method: 'POST' }, post);
		expect(post.statusCode).toBe(405);

		const preflight = mkRes();
		await og({ ...mkReq(), method: 'OPTIONS' }, preflight);
		expect(preflight.statusCode).toBe(204);
	});

	it('429s a rate-limited scraper before rendering or querying', async () => {
		publicIp.mockResolvedValueOnce({ success: false, limit: 60, remaining: 0, reset: Date.now() + 30_000 });
		const res = mkRes();
		await og(mkReq(), res);
		expect(res.statusCode).toBe(429);
		expect(payload(res).error).toBe('rate_limited');
		expect(res.getHeader('retry-after')).toBeDefined();
		expect(sqlCalls).toHaveLength(0);
	});
});

describe('GET /api/demo/economy', () => {
	const mkReq = (qs = '', headers = {}) => ({ method: 'GET', url: `/api/demo/economy${qs}`, headers });

	it('meters ?status=1 through the rate limiter', async () => {
		const res = mkRes();
		await economy(mkReq('?status=1'), res);
		expect(res.statusCode).toBe(200);
		// Pre-fix this branch returned before the limiter ever ran.
		expect(publicIp).toHaveBeenCalledTimes(1);
		expect(payload(res)).toMatchObject({ tradeSol: 0.001 });
	});

	it('429s ?status=1 when the limiter rejects, without hitting Solana RPC', async () => {
		publicIp.mockResolvedValueOnce({ success: false, limit: 60, remaining: 0, reset: Date.now() + 30_000 });
		const res = mkRes();
		await economy(mkReq('?status=1'), res);
		expect(res.statusCode).toBe(429);
		expect(payload(res).error).toBe('rate_limited');
		expect(getSolBalance).not.toHaveBeenCalled();
	});

	it('400s with a JSON error envelope when neither mode is requested', async () => {
		const res = mkRes();
		await economy(mkReq(''), res);
		expect(res.statusCode).toBe(400);
		expect(payload(res)).toMatchObject({ error: 'validation_error' });
	});

	it('401s an anonymous ?trade=1 without signing anything', async () => {
		const res = mkRes();
		await economy(mkReq('?trade=1'), res);
		expect(res.statusCode).toBe(401);
		expect(payload(res).error).toBe('unauthorized');
		// The spend path must be unreachable for an unauthenticated caller.
		expect(sendSol).not.toHaveBeenCalled();
	});

	it('streams the trade lifecycle for a signed-in caller with no artificial pacing', async () => {
		getSessionUser.mockResolvedValue({ id: 'user-1' });
		const started = Date.now();
		const res = mkRes();
		await economy(mkReq('?trade=1'), res);
		const elapsed = Date.now() - started;

		const stream = res.chunks.join('');
		expect(stream).toContain('event: thinking');
		expect(stream).toContain('event: paying');
		expect(stream).toContain('event: done');
		expect(sendSol).toHaveBeenCalledTimes(1);
		expect(trendingPools).toHaveBeenCalledTimes(1);
		// The handler used to sit on 2.2s of setTimeout pacing between events.
		expect(elapsed).toBeLessThan(500);
	});

	it('streams demo_mode with real market data when the trader wallet is unconfigured', async () => {
		// This is production's current state: AGENT_B_WALLET_SECRET is not set on the
		// Cloud Run service, so no payment can occur. The stream must say so plainly
		// and still deliver real market data rather than inventing a settlement.
		delete process.env.AGENT_B_WALLET_SECRET;
		getSessionUser.mockResolvedValue({ id: 'user-1' });
		const res = mkRes();
		await economy(mkReq('?trade=1'), res);

		const stream = res.chunks.join('');
		expect(stream).toContain('event: demo_mode');
		expect(sendSol).not.toHaveBeenCalled();
		expect(trendingPools).toHaveBeenCalledTimes(1);
		const done = JSON.parse(stream.split('event: done\ndata: ')[1].split('\n')[0]);
		expect(done).toMatchObject({ paid: false, demo: true });
		expect(done.markets).toHaveLength(1);
	});

	it('reports an underfunded trader wallet instead of attempting the transfer', async () => {
		getSessionUser.mockResolvedValue({ id: 'user-1' });
		getSolBalance.mockResolvedValue({ sol: 0, lamports: 0 });
		const res = mkRes();
		await economy(mkReq('?trade=1'), res);

		const stream = res.chunks.join('');
		expect(stream).toContain('underfunded');
		expect(sendSol).not.toHaveBeenCalled();
	});
});
