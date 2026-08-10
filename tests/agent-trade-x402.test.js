// The agent-to-agent x402 pair: the Oracle's paid skill endpoint and the demo
// orchestrator that buys from it.
//
// Both move real SOL in production, so the paths that MUST NOT spend are the
// ones worth pinning:
//   • skill.js rejects a malformed signature before it ever reaches an RPC
//     (a junk `sig` used to cost three getTransaction round-trips plus two
//     seconds of back-off, and tripped the shared RPC pool's method breaker).
//   • a verified signature buys exactly one call, and is released again when
//     the analysis the buyer paid for could not be produced.
//   • demo.js never signs a transfer when the buyer is short, and never when
//     no analysis lane is configured to deliver what the payment buys.
//
// Every chain, model, cache, and rate-limit dependency is mocked: this suite
// touches no network and signs nothing.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import bs58 from 'bs58';

const BUYER = 'BuyerAgentAddress111111111111111111111111111';
const SELLER = 'SellerAgentAddress111111111111111111111111111';
const GOOD_SIG = bs58.encode(Buffer.alloc(64, 7));

vi.mock('../api/_lib/db.js', () => ({
	sql: vi.fn(async () => []),
	isDbUnavailableError: () => false,
	isDbCapacityError: () => false,
	isStoragePressured: () => false,
}));

const getTransaction = vi.fn();
const getSolBalance = vi.fn();
const sendSol = vi.fn();
vi.mock('../api/_lib/avatar-wallet.js', () => ({
	LAMPORTS_PER_SOL: 1_000_000_000,
	loadAvatarKeypair: (secret) => {
		if (secret === 'buyer-secret') return { publicKey: { toBase58: () => BUYER } };
		if (secret === 'seller-secret') return { publicKey: { toBase58: () => SELLER } };
		throw new Error('bad secret');
	},
	getConnection: () => ({ getTransaction: (...a) => getTransaction(...a) }),
	getSolBalance: (...a) => getSolBalance(...a),
	sendSol: (...a) => sendSol(...a),
	solUsdPrice: async () => 150,
	explorerTxUrl: (sig) => `https://solscan.io/tx/${sig}`,
}));

const watsonxConfig = vi.fn(() => ({ configured: false }));
vi.mock('../api/_lib/watsonx.js', () => ({
	watsonxConfig: (...a) => watsonxConfig(...a),
	watsonxChatComplete: vi.fn(),
}));

const llmComplete = vi.fn();
const providerChain = vi.fn(() => [{ name: 'openrouter', model: 'free/model-a' }]);
vi.mock('../api/_lib/llm.js', () => ({
	llmComplete: (...a) => llmComplete(...a),
	providerChain: (...a) => providerChain(...a),
	LlmUnavailableError: class extends Error {},
}));

const cache = new Map();
vi.mock('../api/_lib/cache.js', () => ({
	cacheGet: async (k) => (cache.has(k) ? cache.get(k) : null),
	cacheSet: async (k, v) => { cache.set(k, v); },
	cacheDel: async (k) => { cache.delete(k); },
}));

vi.mock('../api/_lib/rate-limit.js', () => ({
	clientIp: () => '198.51.100.7',
	limits: {
		publicIp: async () => ({ success: true }),
		authedReadIp: async () => ({ success: true }),
		avatarPayoutDaily: async () => ({ success: true }),
	},
}));

const { default: skillHandler } = await import('../api/agent-trade/skill.js');
const { default: demoHandler } = await import('../api/agent-trade/demo.js');

function mkReq(url) {
	return { method: 'GET', url, headers: {}, on() {}, destroy() {} };
}
function mkRes() {
	return {
		statusCode: 200,
		headers: {},
		body: '',
		chunks: [],
		writableEnded: false,
		setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
		flushHeaders() {},
		write(chunk) { this.chunks.push(String(chunk)); },
		end(b) { if (b != null) this.body = String(b); this.writableEnded = true; },
	};
}
const parse = (res) => (res.body ? JSON.parse(res.body) : undefined);
// Every SSE frame the handler wrote, decoded back into objects.
const events = (res) =>
	res.chunks
		.join('')
		.split('\n\n')
		.filter((f) => f.startsWith('data: '))
		.map((f) => JSON.parse(f.slice(6)));

// A confirmed transfer of `lamports` from BUYER to SELLER, fresh enough to pass
// the freshness window.
function paidTx({ lamports = 1_000_000, blockTime = Math.floor(Date.now() / 1000) } = {}) {
	return {
		blockTime,
		meta: { preBalances: [5_000_000_000, 0], postBalances: [5_000_000_000 - lamports, lamports] },
		transaction: {
			message: {
				staticAccountKeys: [{ toString: () => BUYER }, { toString: () => SELLER }],
			},
		},
	};
}

beforeEach(() => {
	cache.clear();
	getTransaction.mockReset();
	getSolBalance.mockReset();
	sendSol.mockReset();
	llmComplete.mockReset().mockResolvedValue({
		text: 'SOL liquidity is thinning into the weekly close.',
		model: 'free/model-a',
		provider: 'openrouter',
	});
	watsonxConfig.mockReset().mockReturnValue({ configured: false });
	providerChain.mockReset().mockReturnValue([{ name: 'openrouter', model: 'free/model-a' }]);
	process.env.AGENT_SELLER_SECRET = 'seller-secret';
	process.env.AGENT_BUYER_SECRET = 'buyer-secret';
	process.env.AGENT_TRADE_NETWORK = 'mainnet';
	process.env.AGENT_TRADE_PRICE_SOL = '0.001';
});

describe('GET /api/agent-trade/skill', () => {
	it('503s when the Oracle wallet is not configured', async () => {
		delete process.env.AGENT_SELLER_SECRET;
		const res = mkRes();
		await skillHandler(mkReq('/api/agent-trade/skill'), res);
		expect(res.statusCode).toBe(503);
		expect(parse(res).error).toBe('not_configured');
	});

	it('answers a payment-less call with the x402 price manifest', async () => {
		const res = mkRes();
		await skillHandler(mkReq('/api/agent-trade/skill?topic=solana'), res);
		expect(res.statusCode).toBe(402);
		expect(parse(res)).toMatchObject({
			x402: true,
			currency: 'SOL',
			recipient: SELLER,
			price: { sol: 0.001, lamports: 1_000_000 },
		});
		expect(getTransaction).not.toHaveBeenCalled();
	});

	it('rejects a malformed signature without touching the chain', async () => {
		for (const sig of ['not-a-signature', '0OIl', 'A'.repeat(200), bs58.encode(Buffer.alloc(32, 3))]) {
			const res = mkRes();
			await skillHandler(mkReq(`/api/agent-trade/skill?sig=${encodeURIComponent(sig)}`), res);
			expect(res.statusCode).toBe(402);
			expect(parse(res).error).toBe('bad_payment');
		}
		expect(getTransaction).not.toHaveBeenCalled();
	});

	it('delivers the analysis for a verified payment', async () => {
		getTransaction.mockResolvedValue(paidTx());
		const res = mkRes();
		await skillHandler(
			mkReq(`/api/agent-trade/skill?sig=${GOOD_SIG}&buyer=${BUYER}&topic=solana%20liquidity`),
			res,
		);
		expect(res.statusCode).toBe(200);
		expect(parse(res)).toMatchObject({
			ok: true,
			topic: 'solana liquidity',
			provider: 'openrouter',
			payment: { sig: GOOD_SIG, lamports: 1_000_000 },
		});
		expect(llmComplete).toHaveBeenCalledTimes(1);
	});

	it('lets one signature buy exactly one call', async () => {
		getTransaction.mockResolvedValue(paidTx());
		const first = mkRes();
		await skillHandler(mkReq(`/api/agent-trade/skill?sig=${GOOD_SIG}`), first);
		expect(first.statusCode).toBe(200);

		const replay = mkRes();
		await skillHandler(mkReq(`/api/agent-trade/skill?sig=${GOOD_SIG}`), replay);
		expect(replay.statusCode).toBe(402);
		expect(parse(replay).error).toBe('payment_replayed');
		expect(llmComplete).toHaveBeenCalledTimes(1);
	});

	it('rejects an underpayment', async () => {
		getTransaction.mockResolvedValue(paidTx({ lamports: 10_000 }));
		const res = mkRes();
		await skillHandler(mkReq(`/api/agent-trade/skill?sig=${GOOD_SIG}`), res);
		expect(res.statusCode).toBe(402);
		expect(parse(res).error).toBe('bad_payment');
		expect(llmComplete).not.toHaveBeenCalled();
	});

	it('rejects a payment whose buyer is not in the transaction', async () => {
		getTransaction.mockResolvedValue(paidTx());
		const res = mkRes();
		await skillHandler(
			mkReq(`/api/agent-trade/skill?sig=${GOOD_SIG}&buyer=SomeoneElse111111111111111111111111111111`),
			res,
		);
		expect(res.statusCode).toBe(402);
		expect(parse(res).error).toBe('bad_payment');
	});

	it('rejects a stale payment', async () => {
		getTransaction.mockResolvedValue(paidTx({ blockTime: Math.floor(Date.now() / 1000) - 3600 }));
		const res = mkRes();
		await skillHandler(mkReq(`/api/agent-trade/skill?sig=${GOOD_SIG}`), res);
		expect(res.statusCode).toBe(402);
		expect(parse(res).error).toBe('payment_expired');
	});

	it('releases the signature when the analysis the buyer paid for fails', async () => {
		getTransaction.mockResolvedValue(paidTx());
		llmComplete.mockRejectedValueOnce(new Error('every provider is down'));
		const failed = mkRes();
		await skillHandler(mkReq(`/api/agent-trade/skill?sig=${GOOD_SIG}`), failed);
		expect(failed.statusCode).toBe(502);
		expect(parse(failed).error).toBe('analysis_failed');

		// The buyer's SOL is spent, so their retry must not be read as a replay.
		const retry = mkRes();
		await skillHandler(mkReq(`/api/agent-trade/skill?sig=${GOOD_SIG}`), retry);
		expect(retry.statusCode).toBe(200);
	});
});

describe('GET /api/agent-trade/demo', () => {
	it('reports wallet configuration without opening a stream', async () => {
		const res = mkRes();
		await demoHandler(mkReq('/api/agent-trade/demo?check=1'), res);
		expect(res.statusCode).toBe(200);
		expect(parse(res)).toMatchObject({ configured: true, buyer: { address: BUYER } });
		expect(res.chunks).toHaveLength(0);
	});

	it('names the missing secrets when the demo wallets are unset', async () => {
		delete process.env.AGENT_BUYER_SECRET;
		delete process.env.AGENT_SELLER_SECRET;
		const res = mkRes();
		await demoHandler(mkReq('/api/agent-trade/demo'), res);
		const [ev] = events(res);
		expect(ev.code).toBe('not_configured');
		expect(ev.message).toContain('AGENT_BUYER_SECRET');
		expect(ev.message).toContain('AGENT_SELLER_SECRET');
		expect(sendSol).not.toHaveBeenCalled();
	});

	it('never signs a transfer the buyer cannot cover', async () => {
		getSolBalance.mockResolvedValue({ sol: 0, lamports: 0 });
		const res = mkRes();
		await demoHandler(mkReq('/api/agent-trade/demo'), res);
		const codes = events(res).map((e) => e.code).filter(Boolean);
		expect(codes).toContain('insufficient_funds');
		expect(sendSol).not.toHaveBeenCalled();
	});

	it('never spends SOL when no analysis lane can deliver the skill', async () => {
		getSolBalance.mockResolvedValue({ sol: 1, lamports: 1_000_000_000 });
		watsonxConfig.mockReturnValue({ configured: false });
		providerChain.mockReturnValue([]);
		const res = mkRes();
		await demoHandler(mkReq('/api/agent-trade/demo'), res);
		const codes = events(res).map((e) => e.code).filter(Boolean);
		expect(codes).toContain('analysis_unavailable');
		expect(sendSol).not.toHaveBeenCalled();
		expect(events(res).map((e) => e.type)).not.toContain('paying');
	});
});
