// Tests for the discretionary agent-wallet trade endpoint + its shared guardrails.
//
// Two layers:
//   1. The pure guard predicates + trade-limit normalization + the guard→HTTP
//      mapping in api/_lib/agent-trade-guards.js — the single source of truth the
//      sniper and the endpoint both call.
//   2. POST /api/agents/:id/trade end-to-end with the RPC, DB, custodial key, and
//      SOL price all mocked: auth + ownership gating, every guard rejection as a
//      structured 4xx, idempotent replay, paper-mode simulate, and a live buy that
//      signs + confirms — asserting no secret ever appears in the response.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Readable } from 'node:stream';
import { Keypair, PublicKey } from '@solana/web3.js';

// ── mocks ──────────────────────────────────────────────────────────────────────

const AGENT_KP = Keypair.generate();
const AGENT_ADDR = AGENT_KP.publicKey.toBase58();
const ENCRYPTED_SECRET = 'ENCRYPTED::do-not-leak::ZW5jcnlwdGVk';

const sqlState = {
	agent: null,
	existingCustody: null,
	claim: [{ id: 1 }],
	dailyLamports: '0',
	dailyUsd: 0,
	openTrades: 0,
	calls: [],
};

vi.mock('../api/_lib/db.js', () => ({
	sql: vi.fn(async (strings, ...values) => {
		const q = (typeof strings === 'string' ? strings : strings.join('?')).toLowerCase();
		sqlState.calls.push({ q, values });
		if (/from agent_identities/.test(q) && /select/.test(q)) {
			return sqlState.agent ? [sqlState.agent] : [];
		}
		if (/from agent_custody_events/.test(q) && /idempotency_key =/.test(q) && /select/.test(q)) {
			return sqlState.existingCustody ? [sqlState.existingCustody] : [];
		}
		if (/insert into agent_custody_events/.test(q)) return sqlState.claim;
		if (/sum\(amount_lamports\)/.test(q)) return [{ lamports: sqlState.dailyLamports }];
		if (/sum\(usd\)/.test(q)) return [{ usd: sqlState.dailyUsd }];
		if (/count\(\*\)/.test(q)) return [{ n: sqlState.openTrades }];
		return [];
	}),
	isDbUnavailableError: () => false,
	isDbCapacityError: () => false,
}));

vi.mock('../api/_lib/avatar-wallet.js', () => ({
	solUsdPrice: vi.fn(async () => 200),
	explorerTxUrl: (sig, net) => `https://explorer.example/tx/${sig}?cluster=${net}`,
}));

vi.mock('../api/_lib/audit.js', () => ({ logAudit: vi.fn() }));

// CSRF is enforced on the live (non-simulate) trade path; the token round-trip is
// covered by its own suite. Here we stub it to a pass so these tests exercise the
// trade logic, exactly as auth/rate-limit/db are mocked above.
vi.mock('../api/_lib/csrf.js', () => ({
	requireCsrf: vi.fn(async () => true),
	issueCsrf: vi.fn(async () => 'csrf-test-token'),
}));

const authState = { session: { id: 'owner-1' }, bearer: null };
vi.mock('../api/_lib/auth.js', () => ({
	getSessionUser: vi.fn(async () => authState.session),
	authenticateBearer: vi.fn(async () => authState.bearer),
	extractBearer: vi.fn(() => null),
}));

vi.mock('../api/_lib/rate-limit.js', () => ({
	limits: {
		tradePerUser: vi.fn(async () => ({ success: true })),
		authIp: vi.fn(async () => ({ success: true })),
		walletRead: vi.fn(async () => ({ success: true })),
	},
	clientIp: () => '127.0.0.1',
}));

vi.mock('../api/_lib/agent-wallet.js', () => ({
	ensureAgentWallet: vi.fn(async () => ({ address: AGENT_ADDR, created: false })),
	recoverSolanaAgentKeypair: vi.fn(async () => AGENT_KP),
}));

vi.mock('../workers/agent-sniper/amm-exit.js', () => ({
	buildAmmSellInstructions: vi.fn(async () => ({ instructions: [], expectedQuoteOut: 50_000_000n })),
	quoteAmmSell: vi.fn(async () => ({ expectedQuoteOut: 50_000_000n, minQuoteOut: 47_000_000n, priceImpactPct: 2 })),
}));

class FakeBN {
	constructor(v) { this.v = BigInt(v); }
	toString() { return this.v.toString(); }
}

const clientState = {
	buyImpact: 1,
	expectedBaseTokens: '1000000',
	sellImpact: 1,
	expectedQuoteOut: '50000000',
	buyThrows: null,
	sellThrows: null,
};

const connState = {
	balance: 5_000_000_000n, // 5 SOL
	sendSig: 'SIG_LIVE_123',
	confirmErr: null,
};

function fakeCtx() {
	const wsol = new PublicKey('So11111111111111111111111111111111111111112');
	return {
		BN: FakeBN,
		web3: { PublicKey },
		connection: {
			getBalance: vi.fn(async () => Number(connState.balance)),
			getLatestBlockhash: vi.fn(async () => ({ blockhash: PublicKey.default.toBase58(), lastValidBlockHeight: 100 })),
			sendRawTransaction: vi.fn(async () => connState.sendSig),
			confirmTransaction: vi.fn(async () => ({ value: { err: connState.confirmErr } })),
			getSignatureStatuses: vi.fn(async () => ({ value: [{ err: connState.confirmErr, confirmationStatus: 'confirmed', slot: 1 }], context: { slot: 1 } })),
			getBlockHeight: vi.fn(async () => 1),
			simulateTransaction: vi.fn(async () => ({ value: { err: null, unitsConsumed: 1234 } })),
			getSignatureStatus: vi.fn(async () => ({ value: { err: null, confirmationStatus: 'confirmed' } })),
		},
		client: {
			quoteForBuy: vi.fn(async () => {
				if (clientState.buyThrows) throw clientState.buyThrows;
				return { expectedBaseTokens: { toString: () => clientState.expectedBaseTokens }, quoteMint: wsol, priceImpactPct: clientState.buyImpact };
			}),
			buildBuyInstructions: vi.fn(async () => ({ instructions: [], expectedBaseTokens: { toString: () => clientState.expectedBaseTokens } })),
			quoteForSell: vi.fn(async () => {
				if (clientState.sellThrows) throw clientState.sellThrows;
				return { expectedQuoteOut: { toString: () => clientState.expectedQuoteOut }, quoteMint: wsol, priceImpactPct: clientState.sellImpact };
			}),
			buildSellInstructions: vi.fn(async () => ({ instructions: [], expectedQuoteOut: { toString: () => clientState.expectedQuoteOut } })),
		},
	};
}

vi.mock('../api/_lib/pump.js', () => ({
	getPumpTradeClient: vi.fn(async () => fakeCtx()),
	getConnection: vi.fn(() => fakeCtx().connection),
}));

// Keep the real ATA derivation + program ids; stub only the on-chain mint read.
vi.mock('@solana/spl-token', async (orig) => ({
	...(await orig()),
	getMint: vi.fn(async () => ({ decimals: 6 })),
}));

const guards = await import('../api/_lib/agent-trade-guards.js');
const { default: handler } = await import('../api/agents/agent-trade.js');

const AGENT_ID = '11111111-1111-4111-8111-111111111111';
const MINT = Keypair.generate().publicKey.toBase58();

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

function mockReq({ method = 'POST', url = '/', body = null } = {}) {
	const chunks = body != null ? [Buffer.from(JSON.stringify(body))] : [];
	const r = Readable.from(chunks);
	r.method = method;
	r.url = url;
	r.headers = { origin: 'http://localhost:3000', 'content-type': 'application/json' };
	return r;
}

function setAgent(meta = {}) {
	sqlState.agent = { id: AGENT_ID, user_id: 'owner-1', meta: { solana_address: AGENT_ADDR, encrypted_solana_secret: ENCRYPTED_SECRET, ...meta } };
}

async function execTrade(body) {
	const req = mockReq({ method: 'POST', url: `/api/agents/${AGENT_ID}/trade`, body });
	const res = mockRes();
	await handler(req, res, AGENT_ID, undefined);
	return res;
}

beforeEach(() => {
	sqlState.agent = null;
	sqlState.existingCustody = null;
	sqlState.claim = [{ id: 1 }];
	sqlState.dailyLamports = '0';
	sqlState.dailyUsd = 0;
	sqlState.openTrades = 0;
	sqlState.calls = [];
	authState.session = { id: 'owner-1' };
	authState.bearer = null;
	clientState.buyImpact = 1;
	clientState.expectedBaseTokens = '1000000';
	clientState.sellImpact = 1;
	clientState.expectedQuoteOut = '50000000';
	clientState.buyThrows = null;
	clientState.sellThrows = null;
	connState.balance = 5_000_000_000n;
	connState.sendSig = 'SIG_LIVE_123';
	connState.confirmErr = null;
	delete process.env.SNIPER_MODE;
	setAgent();
});

// ── pure guard predicates ────────────────────────────────────────────────────

describe('trade guard predicates', () => {
	it('checkPerTradeCap blocks an over-cap buy, passes at the cap', () => {
		expect(guards.checkPerTradeCap(100_000_000n, 50_000_000n)).toMatchObject({ reason: 'per_trade_cap' });
		expect(guards.checkPerTradeCap(50_000_000n, 50_000_000n)).toBeNull();
		expect(guards.checkPerTradeCap(100n, null)).toBeNull(); // no cap set
	});

	it('checkDailyBudgetLamports blocks when spent + amount exceeds budget', () => {
		expect(guards.checkDailyBudgetLamports(30n, 25n, 50n)).toMatchObject({ reason: 'daily_budget' });
		expect(guards.checkDailyBudgetLamports(25n, 25n, 50n)).toBeNull();
		expect(guards.checkDailyBudgetLamports(999n, 999n, null)).toBeNull();
	});

	it('checkConcurrency blocks at/over the cap', () => {
		expect(guards.checkConcurrency(3, 3)).toMatchObject({ reason: 'max_positions' });
		expect(guards.checkConcurrency(2, 3)).toBeNull();
		expect(guards.checkConcurrency(99, null)).toBeNull();
	});

	it('checkSolHeadroom blocks when the wallet cannot cover spend + fees', () => {
		expect(guards.checkSolHeadroom(1_000_000n, 0n, 3_000_000n)).toMatchObject({ reason: 'insufficient_sol' });
		expect(guards.checkSolHeadroom(10_000_000n, 5_000_000n, 3_000_000n)).toBeNull();
	});

	it('checkPriceImpact trips strictly above the max', () => {
		expect(guards.checkPriceImpact(16, 15)).toMatchObject({ reason: 'price_impact' });
		expect(guards.checkPriceImpact(15, 15)).toBeNull();
		expect(guards.checkPriceImpact(99, null)).toBeNull();
	});

	it('checkKillSwitch trips only when paused', () => {
		expect(guards.checkKillSwitch(true)).toMatchObject({ reason: 'kill_switch' });
		expect(guards.checkKillSwitch(false)).toBeNull();
	});

	it('tradeGuardResponse maps each reason to a 4xx with an actionable message', () => {
		const r = guards.tradeGuardResponse({ reason: 'per_tx_cap', detail: {} }); // unknown → generic 422
		expect(r.status).toBe(422);
		const cap = guards.tradeGuardResponse({ reason: 'per_trade_cap', detail: { amount_lamports: '100000000', cap_lamports: '50000000' } });
		expect(cap.status).toBe(422);
		expect(cap.code).toBe('per_trade_cap');
		expect(cap.message).toMatch(/per-trade cap/i);
		expect(guards.tradeGuardResponse({ reason: 'kill_switch', detail: {} }).status).toBe(403);
		expect(guards.tradeGuardResponse({ reason: 'insufficient_sol', detail: { wallet_lamports: '0', required_lamports: '3000000' } }).status).toBe(400);
	});
});

describe('normalizeTradeLimits', () => {
	it('applies sane defaults and clamps out-of-range knobs', () => {
		const n = guards.normalizeTradeLimits(undefined);
		expect(n.per_trade_sol).toBeNull();
		expect(n.daily_budget_sol).toBeNull();
		expect(n.max_price_impact_pct).toBe(15);
		expect(n.max_slippage_bps).toBe(1000);
		expect(n.kill_switch).toBe(false);

		const clamped = guards.normalizeTradeLimits({ max_price_impact_pct: 999, max_slippage_bps: 99999, per_trade_sol: -1, kill_switch: true });
		expect(clamped.max_price_impact_pct).toBe(100);
		expect(clamped.max_slippage_bps).toBe(10000);
		expect(clamped.per_trade_sol).toBeNull();
		expect(clamped.kill_switch).toBe(true);
	});

	it('getTradeLimits reads off meta.trade_limits', () => {
		const lim = guards.getTradeLimits({ trade_limits: { per_trade_sol: 0.25, kill_switch: true } });
		expect(lim.per_trade_sol).toBe(0.25);
		expect(lim.kill_switch).toBe(true);
	});
});

// ── endpoint: auth + ownership ───────────────────────────────────────────────

describe('POST /api/agents/:id/trade — auth & ownership', () => {
	it('rejects an unauthenticated caller with 401', async () => {
		authState.session = null;
		authState.bearer = null;
		const res = await execTrade({ side: 'buy', mint: MINT, amount: 0.1 });
		expect(res.statusCode).toBe(401);
		expect(res.json.error).toBe('unauthorized');
	});

	it('rejects a non-owner with 403', async () => {
		sqlState.agent.user_id = 'someone-else';
		const res = await execTrade({ side: 'buy', mint: MINT, amount: 0.1 });
		expect(res.statusCode).toBe(403);
		expect(res.json.error).toBe('forbidden');
	});

	it('404s an unknown agent', async () => {
		sqlState.agent = null;
		const res = await execTrade({ side: 'buy', mint: MINT, amount: 0.1 });
		expect(res.statusCode).toBe(404);
	});
});

// ── endpoint: input validation ───────────────────────────────────────────────

describe('POST /api/agents/:id/trade — input', () => {
	it('rejects a bad side', async () => {
		const res = await execTrade({ side: 'hodl', mint: MINT, amount: 0.1 });
		expect(res.statusCode).toBe(400);
		expect(res.json.error).toBe('invalid_side');
	});

	it('rejects an invalid mint', async () => {
		const res = await execTrade({ side: 'buy', mint: 'not-a-mint!', amount: 0.1 });
		expect(res.statusCode).toBe(400);
		expect(res.json.error).toBe('invalid_mint');
	});

	it('rejects a non-positive amount', async () => {
		const res = await execTrade({ side: 'buy', mint: MINT, amount: 0 });
		expect(res.statusCode).toBe(400);
		expect(res.json.error).toBe('invalid_amount');
	});
});

// ── endpoint: guard rejections (each a structured 4xx, never a 500) ──────────

describe('POST /api/agents/:id/trade — guard rejections', () => {
	it('kill switch → 403 kill_switch', async () => {
		setAgent({ trade_limits: { kill_switch: true } });
		const res = await execTrade({ side: 'buy', mint: MINT, amount: 0.1 });
		expect(res.statusCode).toBe(403);
		expect(res.json.error).toBe('kill_switch');
	});

	it('over per-trade cap → 422 per_trade_cap', async () => {
		setAgent({ trade_limits: { per_trade_sol: 0.05 } });
		const res = await execTrade({ side: 'buy', mint: MINT, amount: 0.1 });
		expect(res.statusCode).toBe(422);
		expect(res.json.error).toBe('per_trade_cap');
		expect(res.json.detail).toBeTruthy();
	});

	it('over daily budget → 422 daily_budget', async () => {
		setAgent({ trade_limits: { daily_budget_sol: 0.1 } });
		sqlState.dailyLamports = String(90_000_000n); // 0.09 SOL already today
		const res = await execTrade({ side: 'buy', mint: MINT, amount: 0.05 });
		expect(res.statusCode).toBe(422);
		expect(res.json.error).toBe('daily_budget');
	});

	it('price impact over the breaker → 422 price_impact', async () => {
		clientState.buyImpact = 40;
		const res = await execTrade({ side: 'buy', mint: MINT, amount: 0.1 });
		expect(res.statusCode).toBe(422);
		expect(res.json.error).toBe('price_impact');
	});

	it('insufficient SOL → 400 insufficient_sol', async () => {
		connState.balance = 0n;
		const res = await execTrade({ side: 'buy', mint: MINT, amount: 0.1 });
		expect(res.statusCode).toBe(400);
		expect(res.json.error).toBe('insufficient_sol');
	});

	it('over-cap concurrency → 409 max_positions', async () => {
		setAgent({ trade_limits: { max_concurrent: 1 } });
		sqlState.openTrades = 1;
		const res = await execTrade({ side: 'buy', mint: MINT, amount: 0.1 });
		expect(res.statusCode).toBe(409);
		expect(res.json.error).toBe('max_positions');
	});
});

// ── endpoint: idempotency ────────────────────────────────────────────────────

describe('POST /api/agents/:id/trade — idempotency', () => {
	it('replays a confirmed trade for the same key without re-executing', async () => {
		sqlState.existingCustody = { id: 9, status: 'confirmed', signature: 'PRIOR_SIG', meta: { side: 'buy' } };
		const res = await execTrade({ side: 'buy', mint: MINT, amount: 0.1, idempotency_key: 'k-1' });
		expect(res.statusCode).toBe(200);
		expect(res.json.data.replayed).toBe(true);
		expect(res.json.data.signature).toBe('PRIOR_SIG');
	});

	it('409s a same-key trade still in flight', async () => {
		sqlState.existingCustody = { id: 9, status: 'pending', signature: null, meta: {} };
		const res = await execTrade({ side: 'buy', mint: MINT, amount: 0.1, idempotency_key: 'k-2' });
		expect(res.statusCode).toBe(409);
		expect(res.json.error).toBe('trade_in_progress');
	});

	it('409s when the idempotency INSERT loses the race (ON CONFLICT → no row)', async () => {
		sqlState.claim = []; // conflict: another request already claimed
		const res = await execTrade({ side: 'buy', mint: MINT, amount: 0.1, idempotency_key: 'k-3' });
		expect(res.statusCode).toBe(409);
		expect(res.json.error).toBe('trade_in_progress');
	});
});

// ── endpoint: paper mode + live execution ────────────────────────────────────

describe('POST /api/agents/:id/trade — execution', () => {
	it('simulate buy runs the real quote path but never signs or records', async () => {
		const res = await execTrade({ side: 'buy', mint: MINT, amount: 0.1, simulate: true });
		expect(res.statusCode).toBe(200);
		expect(res.json.data.simulated).toBe(true);
		expect(res.json.data.expected_tokens_out || res.json.data.expected_out).toBeTruthy();
		// No idempotency INSERT in simulate mode.
		expect(sqlState.calls.some((c) => /insert into agent_custody_events/.test(c.q))).toBe(false);
	});

	it('honors SNIPER_MODE=simulate as the paper toggle', async () => {
		process.env.SNIPER_MODE = 'simulate';
		const res = await execTrade({ side: 'buy', mint: MINT, amount: 0.1 });
		expect(res.json.data.simulated).toBe(true);
	});

	it('live buy signs, confirms, records, and never leaks the secret', async () => {
		const res = await execTrade({ side: 'buy', mint: MINT, amount: 0.1, idempotency_key: 'live-1' });
		expect(res.statusCode).toBe(200);
		expect(res.json.data.replayed).toBe(false);
		// The protected execution engine derives the signature from the signed v0 tx
		// (bs58 of its first signature), not from sendRawTransaction's return — so it is
		// a real base58 signature echoed consistently into the explorer link (the same
		// value the custody row records), rather than the RPC mock's stand-in return.
		const sig = res.json.data.signature;
		expect(typeof sig).toBe('string');
		expect(sig).toMatch(/^[1-9A-HJ-NP-Za-km-z]{64,}$/);
		expect(res.json.data.explorer).toContain(sig);
		expect(res.json.data.tokens_received).toBe('1000000');
		expect(res.json.data.side).toBe('buy');
		// The decrypted secret must never surface in the response.
		expect(res._body).not.toContain(ENCRYPTED_SECRET);
		expect(res._body).not.toMatch(/encrypted_solana_secret/);
		// It did claim + confirm the ledger row.
		expect(sqlState.calls.some((c) => /insert into agent_custody_events/.test(c.q))).toBe(true);
		expect(sqlState.calls.some((c) => /update agent_custody_events/.test(c.q))).toBe(true);
	});

	it('a sell from a graduated curve routes through the AMM path', async () => {
		const grad = Object.assign(new Error('graduated'), { name: 'CoinGraduatedError' });
		clientState.sellThrows = grad;
		const ammExit = await import('../workers/agent-sniper/amm-exit.js');
		// Sell 100 tokens; resolveHolding reads the on-chain balance via the ctx
		// connection — give it a balance by stubbing getTokenAccountBalance.
		const { getPumpTradeClient } = await import('../api/_lib/pump.js');
		getPumpTradeClient.mockImplementationOnce(async () => {
			const ctx = fakeCtx();
			ctx.connection.getAccountInfo = vi.fn(async () => ({ owner: new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA') }));
			ctx.connection.getTokenAccountBalance = vi.fn(async () => ({ value: { amount: '1000000000' } }));
			return ctx;
		});
		const res = await execTrade({ side: 'sell', mint: MINT, amount: 'max', idempotency_key: 'sell-1' });
		expect(res.statusCode).toBe(200);
		expect(res.json.data.venue).toBe('amm');
		expect(ammExit.buildAmmSellInstructions).toHaveBeenCalled();
	});
});

// ── PUT /trade/limits input validation ───────────────────────────────────────
// normalizeTradeLimits coerces anything it cannot read into "no cap" (or the
// default), so before the boundary validated its input a typo like
// { per_trade_sol: -1 } DELETED the owner's existing per-trade ceiling and
// answered 200 as though it had tightened it. A spend guardrail must never be
// relaxed by a value the server could not parse.

describe('PUT /api/agents/:id/trade/limits — input validation', () => {
	async function putLimits(body) {
		const req = mockReq({ method: 'PUT', url: `/api/agents/${AGENT_ID}/trade/limits`, body });
		const res = mockRes();
		await handler(req, res, AGENT_ID, 'limits');
		return res;
	}

	function savedLimits() {
		const write = sqlState.calls.filter((c) => /update agent_identities set meta/.test(c.q)).pop();
		return write ? JSON.parse(write.values[0]).trade_limits : null;
	}

	it('rejects a negative cap instead of silently clearing it', async () => {
		const res = await putLimits({ per_trade_sol: -1 });
		expect(res.statusCode).toBe(400);
		expect(res.json.error).toBe('validation_error');
		expect(savedLimits()).toBeNull();
	});

	it('rejects an unparseable cap instead of silently clearing it', async () => {
		const res = await putLimits({ daily_budget_sol: 'abc' });
		expect(res.statusCode).toBe(400);
		expect(savedLimits()).toBeNull();
	});

	it('rejects max_concurrent below 1, which normalization would read as "no ceiling"', async () => {
		const res = await putLimits({ max_concurrent: 0 });
		expect(res.statusCode).toBe(400);
		expect(savedLimits()).toBeNull();
	});

	it('rejects a non-boolean kill switch', async () => {
		const res = await putLimits({ kill_switch: 'yes' });
		expect(res.statusCode).toBe(400);
		expect(savedLimits()).toBeNull();
	});

	it('rejects an out-of-range price-impact breaker', async () => {
		const res = await putLimits({ max_price_impact_pct: 500 });
		expect(res.statusCode).toBe(400);
		expect(savedLimits()).toBeNull();
	});

	it('accepts real caps, numeric strings, and an explicit null clear', async () => {
		const set = await putLimits({ per_trade_sol: 0.5, daily_budget_sol: '2', max_concurrent: 3, kill_switch: true });
		expect(set.statusCode).toBe(200);
		expect(set.json.data.limits.per_trade_sol).toBe(0.5);
		expect(set.json.data.limits.daily_budget_sol).toBe(2);
		expect(set.json.data.limits.max_concurrent).toBe(3);
		expect(set.json.data.limits.kill_switch).toBe(true);

		const cleared = await putLimits({ per_trade_sol: null });
		expect(cleared.statusCode).toBe(200);
		expect(cleared.json.data.limits.per_trade_sol).toBeNull();
	});
});
