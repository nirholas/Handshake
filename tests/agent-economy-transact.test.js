// POST /api/agent-economy/transact, the agent-to-agent economy endpoint.
//
// The contract this locks down is about MONEY, so it is exercised against the
// real handler with only the two outside edges stubbed: the LLM provider chain
// and the Solana wallet. Four invariants:
//
//   1. A real completion is what gets sold: the seller's text is the model's,
//      never a canned line.
//   2. Delivery happens BEFORE payment. A dead model chain returns 503 and
//      sendSol() is never called, so Agent A cannot pay for nothing.
//   3. Service lookup is own-property only: `service: "constructor"` is a 400,
//      not a pseudo-service with an undefined price walking into the send path.
//   4. The global daily spend ceiling is consumed only when a send actually
//      fires. An unfunded wallet must not be able to drain the demo budget.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const llmCompleteMock = vi.fn();
vi.mock('../api/_lib/llm.js', () => ({
	llmComplete: (...a) => llmCompleteMock(...a),
	LlmUnavailableError: class LlmUnavailableError extends Error {},
}));

const sendSolMock = vi.fn();
const getSolBalanceMock = vi.fn();
const walletConfigMock = vi.fn();

// The shape avatar-wallet's getSolBalance actually resolves to.
const solBalance = (lamports) => ({ lamports, sol: lamports / 1_000_000_000 });
vi.mock('../api/_lib/avatar-wallet.js', () => ({
	avatarWalletConfig: () => walletConfigMock(),
	loadAvatarKeypair: () => ({ publicKey: { toBase58: () => 'BUYERaddr1111111111111111111111111111111111' } }),
	getConnection: () => ({}),
	getSolBalance: (...a) => getSolBalanceMock(...a),
	solUsdPrice: async () => 100,
	sendSol: (...a) => sendSolMock(...a),
	isValidPubkey: (a) => typeof a === 'string' && a.length > 30,
	explorerTxUrl: (sig) => `https://solscan.io/tx/${sig}`,
	explorerAccountUrl: (addr) => `https://solscan.io/account/${addr}`,
	LAMPORTS_PER_SOL: 1_000_000_000,
}));

const ipLimitMock = vi.fn();
const globalLimitMock = vi.fn();
vi.mock('../api/_lib/rate-limit.js', () => ({
	clientIp: () => '10.0.0.1',
	limits: {
		agentEconomyIp: (...a) => ipLimitMock(...a),
		agentEconomyGlobal: (...a) => globalLimitMock(...a),
	},
}));

const { default: transact } = await import('../api/agent-economy/transact.js');

function mkReq(body) {
	return {
		method: 'POST',
		url: '/api/agent-economy/transact',
		headers: { 'content-type': 'application/json' },
		on(event, cb) {
			if (event === 'data' && body != null) {
				const buf = Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
				queueMicrotask(() => { cb(buf); this._endCb?.(); });
			} else if (event === 'end') {
				this._endCb = cb;
				if (body == null) queueMicrotask(() => cb());
			}
		},
		destroy() {},
	};
}
function mkRes() {
	return {
		statusCode: 200, headers: {}, body: undefined, writableEnded: false,
		setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
		writeHead(code, hdrs) { this.statusCode = code; Object.assign(this.headers, hdrs || {}); return this; },
		end(b) { this.body = b; this.writableEnded = true; },
	};
}
const payload = (res) => (res.body ? JSON.parse(res.body) : undefined);

const FUNDED = { configured: true, network: 'mainnet', rpcUrl: 'https://rpc.test', defaultRecipient: null };

beforeEach(() => {
	process.env.AVATAR_WALLET_SECRET = 'test-secret';
	process.env.AGENT_B_ADDRESS = 'SELLERaddr222222222222222222222222222222222';
	llmCompleteMock.mockReset().mockImplementation(async ({ system }) => ({
		text: system ? 'Risk sits at 6. Liquidity is thinning and holder concentration is climbing.' : 'Oracle, price me a market read.',
	}));
	sendSolMock.mockReset().mockResolvedValue('SIGNATURE111');
	// Mirror the real avatar-wallet return shape, { lamports, sol }. Resolving a
	// bare number here is what let the endpoint compare an object to a number and
	// still pass this suite while the balance guard was dead in production.
	getSolBalanceMock.mockReset().mockResolvedValue(solBalance(5_000_000));
	walletConfigMock.mockReset().mockReturnValue(FUNDED);
	ipLimitMock.mockReset().mockResolvedValue({ success: true });
	globalLimitMock.mockReset().mockResolvedValue({ success: true });
});

describe('POST /api/agent-economy/transact', () => {
	it('sells the model completion and settles the payment on-chain', async () => {
		const res = mkRes();
		await transact(mkReq({ service: 'risk-score', topic: 'Solana DeFi' }), res);

		expect(res.statusCode).toBe(200);
		const out = payload(res);
		expect(out.service).toMatchObject({ slug: 'risk-score', name: 'Risk Score', priceUsd: 0.003 });
		expect(out.topic).toBe('Solana DeFi');
		expect(out.sellerSaid).toContain('Risk sits at 6');
		expect(out.buyerSaid).toBe('Oracle, price me a market read.');
		// $0.003 at $100/SOL is 30_000 lamports, above the 10_000-lamport floor.
		expect(out.transaction).toMatchObject({
			signature: 'SIGNATURE111',
			explorerUrl: 'https://solscan.io/tx/SIGNATURE111',
			sellerAddress: process.env.AGENT_B_ADDRESS,
			lamports: 30_000,
			usdAmount: 0.003,
			network: 'mainnet',
		});
		expect(sendSolMock).toHaveBeenCalledTimes(1);
		expect(globalLimitMock).toHaveBeenCalledTimes(1);
		// The seller's line is the model's own text, not a canned fallback.
		expect(out.sellerSaid).not.toMatch(/delivered\. The data is yours/);
	});

	it('never pays when the model chain is down: 503, no send, no budget consumed', async () => {
		llmCompleteMock.mockRejectedValue(Object.assign(new Error('chain exhausted'), { status: 502 }));
		const res = mkRes();
		await transact(mkReq({ service: 'market-analysis' }), res);

		expect(res.statusCode).toBe(503);
		expect(payload(res).error).toBe('delivery_unavailable');
		expect(sendSolMock).not.toHaveBeenCalled();
		expect(globalLimitMock).not.toHaveBeenCalled();
	});

	it('treats an empty completion as an undeliverable service', async () => {
		llmCompleteMock.mockResolvedValue({ text: '   ' });
		const res = mkRes();
		await transact(mkReq({ service: 'onchain-insight' }), res);

		expect(res.statusCode).toBe(503);
		expect(sendSolMock).not.toHaveBeenCalled();
	});

	it('still delivers when only the buyer line fails', async () => {
		llmCompleteMock.mockImplementation(async ({ system }) => {
			if (!system) throw new Error('buyer lane down');
			return { text: 'Momentum is holding. Watch the 4h close.' };
		});
		const res = mkRes();
		await transact(mkReq({ service: 'market-analysis' }), res);

		expect(res.statusCode).toBe(200);
		const out = payload(res);
		expect(out.buyerSaid).toBeNull();
		expect(out.sellerSaid).toContain('Momentum is holding');
		expect(sendSolMock).toHaveBeenCalledTimes(1);
	});

	it('rejects prototype-chain keys as unknown services without touching the wallet', async () => {
		for (const service of ['constructor', '__proto__', 'toString', 'valueOf']) {
			const res = mkRes();
			await transact(mkReq({ service }), res);
			expect(res.statusCode, service).toBe(400);
			expect(payload(res).error, service).toBe('unknown_service');
		}
		expect(llmCompleteMock).not.toHaveBeenCalled();
		expect(sendSolMock).not.toHaveBeenCalled();
		expect(globalLimitMock).not.toHaveBeenCalled();
	});

	it('reports insufficient balance without consuming the daily spend budget', async () => {
		getSolBalanceMock.mockResolvedValue(solBalance(1_000));
		const res = mkRes();
		await transact(mkReq({ service: 'risk-score' }), res);

		expect(res.statusCode).toBe(200);
		expect(payload(res).transaction).toEqual({
			error: 'insufficient_balance',
			message: "Fund Agent A's wallet to enable live transactions.",
		});
		expect(sendSolMock).not.toHaveBeenCalled();
		// The ceiling exists to cap real spend; an unfunded wallet must not drain it.
		expect(globalLimitMock).not.toHaveBeenCalled();
	});

	it('delivers the service but reports the wallet when it is unconfigured', async () => {
		walletConfigMock.mockReturnValue({ configured: false, network: 'mainnet', rpcUrl: 'https://rpc.test', defaultRecipient: null });
		const res = mkRes();
		await transact(mkReq({ service: 'market-analysis' }), res);

		const out = payload(res);
		expect(res.statusCode).toBe(200);
		expect(out.sellerSaid).toBeTruthy();
		expect(out.transaction.error).toBe('wallet_unconfigured');
		expect(sendSolMock).not.toHaveBeenCalled();
	});

	it('holds the send back once the daily ceiling is reached', async () => {
		globalLimitMock.mockResolvedValue({ success: false, limit: 500, remaining: 0, reset: Date.now() + 1000 });
		const res = mkRes();
		await transact(mkReq({ service: 'risk-score' }), res);

		expect(res.statusCode).toBe(200);
		expect(payload(res).transaction.error).toBe('rate_limited');
		expect(sendSolMock).not.toHaveBeenCalled();
	});

	it('rejects an unknown service and a bad body before any spend', async () => {
		const unknown = mkRes();
		await transact(mkReq({ service: 'not-a-service' }), unknown);
		expect(unknown.statusCode).toBe(400);
		expect(payload(unknown).error).toBe('unknown_service');

		const tooLong = mkRes();
		await transact(mkReq({ service: 'risk-score', topic: 'x'.repeat(121) }), tooLong);
		expect(tooLong.statusCode).toBe(400);
		expect(payload(tooLong).error).toBe('validation_error');

		expect(sendSolMock).not.toHaveBeenCalled();
	});
});
