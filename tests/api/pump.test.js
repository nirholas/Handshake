// Tests for pump.fun integration endpoints. SDKs and Solana RPC are fully
// mocked — no network, no chain. Verifies request/response shapes, auth,
// validation, and that the right SDK calls are issued in the right order.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Readable } from 'node:stream';

// ── Auth state ────────────────────────────────────────────────────────────
const authState = { session: null, bearer: null };
vi.mock('../../api/_lib/auth.js', () => ({
	getSessionUser: vi.fn(async () => authState.session),
	authenticateBearer: vi.fn(async () => authState.bearer),
	extractBearer: vi.fn(() => null),
}));

// ── SQL mock ──────────────────────────────────────────────────────────────
const sqlState = { queue: [], calls: [] };
vi.mock('../../api/_lib/db.js', () => ({
	sql: vi.fn(async (strings, ...values) => {
		sqlState.calls.push({ query: strings.join('?'), values });
		if (sqlState.queue.length === 0) return [];
		return sqlState.queue.shift();
	}),
}));

vi.mock('../../api/_lib/rate-limit.js', () => ({
	limits: { authIp: vi.fn(async () => ({ success: true })) },
	clientIp: vi.fn(() => '127.0.0.1'),
}));

vi.mock('../../api/_lib/crypto.js', () => ({
	randomToken: vi.fn(async (n) => 'a'.repeat((n || 16) * 2)),
}));

// ── pump-fun SDK mocks ────────────────────────────────────────────────────
const mockPumpAgentOffline = {
	create: vi.fn(async () => ({ programId: 'agent', keys: [], data: Buffer.alloc(0) })),
	acceptPayment: vi.fn(async () => ({ programId: 'pay', keys: [], data: Buffer.alloc(0) })),
	withdraw: vi.fn(async () => ({ programId: 'wd', keys: [], data: Buffer.alloc(0) })),
	updateBuybackBps: vi.fn(async () => ({ programId: 'bp', keys: [], data: Buffer.alloc(0) })),
	distributePayments: vi.fn(async () => [{ programId: 'd', keys: [], data: Buffer.alloc(0) }]),
	buybackTrigger: vi.fn(async () => ({ programId: 'b', keys: [], data: Buffer.alloc(0) })),
};
const mockPumpAgent = {
	getBalances: vi.fn(async () => ({
		paymentVault:  { address: 'PaymPda', balance: 1_000_000n }, // 1 USDC
		buybackVault:  { address: 'BuybkPda', balance: 0n },
		withdrawVault: { address: 'WdrwPda', balance: 0n },
	})),
};

vi.mock('../../api/_lib/pump.js', () => ({
	getConnection: vi.fn(() => ({})),
	solanaPubkey: vi.fn((s) => (s ? { toBase58: () => s, toString: () => s } : null)),
	getPumpSdk: vi.fn(async () => ({
		sdk: {
			fetchGlobal: async () => ({}),
			createInstruction: async () => ({ keys: [], data: Buffer.alloc(0) }),
			createAndBuyInstructions: async () => [{ keys: [], data: Buffer.alloc(0) }],
			createV2Instruction: async () => ({ keys: [], data: Buffer.alloc(0) }),
			createV2AndBuyInstructions: async () => [{ keys: [], data: Buffer.alloc(0) }],
			createV2AndBuyV2Instructions: async () => [{ keys: [], data: Buffer.alloc(0) }],
		},
		BN: function MockBN(v) { this.v = v; this.toString = () => String(v); },
		web3: { LAMPORTS_PER_SOL: 1_000_000_000 },
	})),
	getPumpSwapSdk: vi.fn(async () => ({ sdk: {}, BN: class {}, web3: {} })),
	getPumpAgent: vi.fn(async () => ({
		agent: mockPumpAgent,
		agentPda: { toString: () => 'AgentPda' },
		BN: class {},
		web3: {},
	})),
	getPumpAgentOffline: vi.fn(async () => ({
		offline: mockPumpAgentOffline,
		BN: function MockBN(v) {
			const inst = { v, toString: () => String(v) };
			return inst;
		},
		web3: {},
		agentPda: { toString: () => 'AgentPda' },
	})),
	verifySignature: vi.fn(async () => ({
		transaction: { message: { accountKeys: [{ pubkey: { toString: () => 'MintPubkey1111111111111111111111111111' } }] } },
		meta: {},
	})),
	buildUnsignedTxBase64: vi.fn(async () => 'BASE64TX'),
}));

// ── helpers ───────────────────────────────────────────────────────────────
function makeReq({ method = 'GET', url = '/', headers = {}, body = null } = {}) {
	const base = body ? Readable.from([Buffer.from(JSON.stringify(body))]) : Readable.from([]);
	base.method = method;
	base.url = url;
	base.headers = {
		host: 'localhost',
		...(body ? { 'content-type': 'application/json' } : {}),
		...headers,
	};
	return base;
}
function makeRes() {
	return {
		statusCode: 200, headers: {}, body: '', writableEnded: false,
		setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
		end(chunk) { if (chunk !== undefined) this.body += chunk; this.writableEnded = true; },
	};
}
async function invoke(handler, opts) {
	const req = makeReq(opts); const res = makeRes();
	await handler(req, res);
	return { res, json: res.body ? JSON.parse(res.body) : null };
}
function resetAll() {
	authState.session = null; authState.bearer = null;
	sqlState.queue = []; sqlState.calls = [];
	mockPumpAgentOffline.create.mockClear();
	mockPumpAgentOffline.acceptPayment.mockClear();
	mockPumpAgentOffline.withdraw.mockClear();
	mockPumpAgentOffline.updateBuybackBps.mockClear();
	mockPumpAgentOffline.distributePayments.mockClear();
	mockPumpAgentOffline.buybackTrigger.mockClear();
	mockPumpAgent.getBalances.mockClear();
}

// ── Tests ─────────────────────────────────────────────────────────────────
const mintB58 = 'MintPubkey1111111111111111111111111111';
const walletB58 = 'WalletPubkey111111111111111111111111111';
const ataB58 = 'AtaPubkey1111111111111111111111111111111';

describe('GET /api/pump/balances', () => {
	beforeEach(resetAll);

	it('returns three vault balances', async () => {
		const { default: handler } = await import('../../api/pump/balances.js');
		const { res, json } = await invoke(handler, {
			method: 'GET',
			url: `/api/pump/balances?mint=${mintB58}&network=devnet`,
		});
		expect(res.statusCode).toBe(200);
		expect(json.balances.payment.balance).toBe('1000000');
		expect(json.balances.buyback.balance).toBe('0');
		expect(json.balances.withdraw.balance).toBe('0');
		expect(mockPumpAgent.getBalances).toHaveBeenCalledOnce();
	});

	it('400s on bad mint', async () => {
		const { default: handler } = await import('../../api/pump/balances.js');
		const pumpMod = await import('../../api/_lib/pump.js');
		pumpMod.solanaPubkey.mockReturnValueOnce(null); // invalid mint
		const { res, json } = await invoke(handler, {
			method: 'GET', url: '/api/pump/balances?mint=bad',
		});
		expect(res.statusCode).toBe(400);
		expect(json.error).toBe('validation_error');
	});
});

describe('POST /api/pump/launch-prep', () => {
	beforeEach(resetAll);

	it('rejects unauthenticated', async () => {
		const { default: handler } = await import('../../api/pump/launch-prep.js');
		const { res } = await invoke(handler, {
			method: 'POST', url: '/api/pump/launch-prep',
			body: { agent_id: '00000000-0000-0000-0000-000000000001',
				wallet_address: walletB58, name: 'X', symbol: 'X', uri: 'https://x/m.json' },
		});
		expect(res.statusCode).toBe(401);
	});

	it('builds unsigned tx for valid request', async () => {
		authState.session = { id: 'user-1' };
		sqlState.queue = [
			[{ id: 'wallet-1' }],                  // wallet check
			[{ id: 'agent-1', name: 'Foo' }],      // agent check
			[],                                     // insert pending
		];
		const { default: handler } = await import('../../api/pump/launch-prep.js');
		const { res, json } = await invoke(handler, {
			method: 'POST', url: '/api/pump/launch-prep',
			body: {
				agent_id: '00000000-0000-0000-0000-000000000001',
				wallet_address: walletB58,
				name: 'Foo', symbol: 'FOO', uri: 'https://x/m.json',
				network: 'devnet', buyback_bps: 500,
			},
		});
		expect(res.statusCode).toBe(201);
		expect(json.tx_base64).toBe('BASE64TX');
		expect(json.buyback_bps).toBe(500);
		expect(mockPumpAgentOffline.create).toHaveBeenCalledOnce();
		expect(mockPumpAgentOffline.create.mock.calls[0][0].buybackBps).toBe(500);
	});
});

describe('POST /api/pump/accept-payment-prep', () => {
	beforeEach(resetAll);

	it('builds acceptPayment ix and persists pending row', async () => {
		authState.session = { id: 'user-1' };
		sqlState.queue = [
			[{ id: 'mint-1', mint: mintB58, network: 'devnet', buyback_bps: 500 }], // mint lookup
			[{ id: 'pay-1', invoice_id: '1234', start_time: '2026-01-01', end_time: '2026-01-02', status: 'pending' }],
		];
		const { default: handler } = await import('../../api/pump/accept-payment-prep.js');
		const { res, json } = await invoke(handler, {
			method: 'POST', url: '/api/pump/accept-payment-prep',
			body: {
				mint: mintB58, payer_wallet: walletB58, amount_usdc: 1.5,
				user_token_account: ataB58, network: 'devnet', duration_seconds: 60,
				skill_id: 'optimize',
			},
		});
		expect(res.statusCode).toBe(201);
		expect(json.tx_base64).toBe('BASE64TX');
		expect(json.amount_atomics).toBe('1500000');
		expect(mockPumpAgentOffline.acceptPayment).toHaveBeenCalledOnce();
	});

	it('404s if mint not registered', async () => {
		authState.session = { id: 'user-1' };
		sqlState.queue = [[]]; // mint lookup empty
		const { default: handler } = await import('../../api/pump/accept-payment-prep.js');
		const { res, json } = await invoke(handler, {
			method: 'POST', url: '/api/pump/accept-payment-prep',
			body: {
				mint: mintB58, payer_wallet: walletB58, amount_usdc: 1,
				user_token_account: ataB58, network: 'devnet',
			},
		});
		expect(res.statusCode).toBe(404);
		expect(json.error).toBe('not_found');
	});
});

describe('POST /api/pump/accept-payment-confirm', () => {
	beforeEach(resetAll);

	it('marks payment confirmed when tx verifies', async () => {
		authState.session = { id: 'user-1' };
		sqlState.queue = [
			[{ id: 'pay-1', mint: mintB58, network: 'devnet', invoice_id: '1234', status: 'pending' }],
			[], // update
		];
		const { default: handler } = await import('../../api/pump/accept-payment-confirm.js');
		const { res, json } = await invoke(handler, {
			method: 'POST', url: '/api/pump/accept-payment-confirm',
			body: {
				payment_id: '00000000-0000-0000-0000-000000000001',
				tx_signature: 'a'.repeat(88),
			},
		});
		expect(res.statusCode).toBe(200);
		expect(json.ok).toBe(true);
	});
});

describe('POST /api/pump/withdraw-prep', () => {
	beforeEach(resetAll);

	it('builds withdraw ix for owner', async () => {
		authState.session = { id: 'user-1' };
		sqlState.queue = [[{
			id: 'mint-1', mint: mintB58, user_id: 'user-1',
			agent_authority: walletB58, network: 'devnet',
		}]];
		const { default: handler } = await import('../../api/pump/withdraw-prep.js');
		const { res, json } = await invoke(handler, {
			method: 'POST', url: '/api/pump/withdraw-prep',
			body: {
				mint: mintB58, authority_wallet: walletB58, receiver_ata: ataB58,
				network: 'devnet',
			},
		});
		expect(res.statusCode).toBe(201);
		expect(json.tx_base64).toBe('BASE64TX');
		expect(mockPumpAgentOffline.withdraw).toHaveBeenCalledOnce();
	});

	it('forbids non-owner', async () => {
		authState.session = { id: 'other-user' };
		sqlState.queue = [[{
			id: 'mint-1', mint: mintB58, user_id: 'user-1',
			agent_authority: walletB58, network: 'devnet',
		}]];
		const { default: handler } = await import('../../api/pump/withdraw-prep.js');
		const { res } = await invoke(handler, {
			method: 'POST', url: '/api/pump/withdraw-prep',
			body: {
				mint: mintB58, authority_wallet: walletB58, receiver_ata: ataB58,
				network: 'devnet',
			},
		});
		expect(res.statusCode).toBe(403);
	});
});

describe('GET /api/pump/by-agent', () => {
	beforeEach(resetAll);

	it('returns null when no mint exists', async () => {
		sqlState.queue = [[]];
		const { default: handler } = await import('../../api/pump/by-agent.js');
		const { res, json } = await invoke(handler, {
			method: 'GET',
			url: '/api/pump/by-agent?agent_id=00000000-0000-0000-0000-000000000001',
		});
		expect(res.statusCode).toBe(200);
		expect(json.data).toBe(null);
	});

	it('returns mint with stats and burns', async () => {
		sqlState.queue = [
			[{ id: 'mint-1', mint: mintB58, network: 'mainnet', name: 'Foo', symbol: 'FOO', buyback_bps: 500, agent_authority: walletB58 }],
			[{ confirmed_payments: 3, unique_payers: 2, total_atomics: '1500000', last_payment_at: '2026-04-29T10:00:00Z' }],
			[{ runs: 1, total_burned: '50000', last_burn_at: '2026-04-29T11:00:00Z' }],
		];
		const { default: handler } = await import('../../api/pump/by-agent.js');
		const { res, json } = await invoke(handler, {
			method: 'GET',
			url: '/api/pump/by-agent?agent_id=00000000-0000-0000-0000-000000000001',
		});
		expect(res.statusCode).toBe(200);
		expect(json.data.mint).toBe(mintB58);
		expect(json.data.stats.confirmed_payments).toBe(3);
		expect(json.data.burns.total_burned).toBe('50000');
	});

	it('400s without agent_id', async () => {
		const { default: handler } = await import('../../api/pump/by-agent.js');
		const { res } = await invoke(handler, { method: 'GET', url: '/api/pump/by-agent' });
		expect(res.statusCode).toBe(400);
	});
});

describe('POST /api/pump/withdraw-confirm', () => {
	beforeEach(resetAll);

	it('confirms withdraw tx for owner', async () => {
		authState.session = { id: 'user-1' };
		sqlState.queue = [
			[{ id: 'mint-1', mint: mintB58, user_id: 'user-1', agent_authority: walletB58, network: 'mainnet' }],
		];
		const pumpMod = await import('../../api/_lib/pump.js');
		pumpMod.verifySignature.mockResolvedValueOnce({
			transaction: { message: { accountKeys: [
				{ pubkey: { toString: () => mintB58 } },
				{ pubkey: { toString: () => walletB58 } },
			] } },
			meta: {},
			slot: 12345,
			blockTime: 1714492800,
		});
		const { default: handler } = await import('../../api/pump/withdraw-confirm.js');
		const { res, json } = await invoke(handler, {
			method: 'POST',
			url: '/api/pump/withdraw-confirm',
			body: {
				mint: mintB58,
				network: 'mainnet',
				tx_signature: 'a'.repeat(88),
			},
		});
		expect(res.statusCode).toBe(200);
		expect(json.ok).toBe(true);
		expect(json.slot).toBe(12345);
	});

	it('forbids non-owner', async () => {
		authState.session = { id: 'other' };
		sqlState.queue = [
			[{ id: 'mint-1', mint: mintB58, user_id: 'user-1', agent_authority: walletB58, network: 'mainnet' }],
		];
		const { default: handler } = await import('../../api/pump/withdraw-confirm.js');
		const { res } = await invoke(handler, {
			method: 'POST',
			url: '/api/pump/withdraw-confirm',
			body: { mint: mintB58, network: 'mainnet', tx_signature: 'a'.repeat(88) },
		});
		expect(res.statusCode).toBe(403);
	});
});

describe('pump-pricing helpers', () => {
	beforeEach(resetAll);

	it('priceFor returns null for unknown tools', async () => {
		const { priceFor, isFreeTool } = await import('../../api/_lib/pump-pricing.js');
		expect(priceFor('nonexistent_tool')).toBe(null);
		expect(isFreeTool('list_my_avatars')).toBe(true);
	});

	it('priceFor returns price for paid tools', async () => {
		const { priceFor } = await import('../../api/_lib/pump-pricing.js');
		const p = priceFor('optimize_model');
		expect(p).not.toBe(null);
		expect(p.amount_usdc).toBeGreaterThan(0);
	});

	it('findActiveSubscription queries on (mint, network, payer, tool)', async () => {
		sqlState.queue = [
			[{ id: 'sub-1', invoice_id: '42', amount_atomics: '1000000', end_time: '2099-01-01', tool_name: 'optimize_model' }],
		];
		const { findActiveSubscription } = await import('../../api/_lib/pump-pricing.js');
		const sub = await findActiveSubscription({
			mint: mintB58,
			network: 'mainnet',
			payerWallet: walletB58,
			toolName: 'optimize_model',
		});
		expect(sub).not.toBe(null);
		expect(sub.invoice_id).toBe('42');
	});

	it('findActiveSubscription returns null when no row', async () => {
		sqlState.queue = [[]];
		const { findActiveSubscription } = await import('../../api/_lib/pump-pricing.js');
		const sub = await findActiveSubscription({
			mint: mintB58,
			network: 'mainnet',
			payerWallet: walletB58,
			toolName: 'optimize_model',
		});
		expect(sub).toBe(null);
	});
});

describe('GET /.well-known/x402', () => {
	beforeEach(resetAll);

	it('advertises pump-agent-payments scheme', async () => {
		const { default: handler } = await import('../../api/wk-x402.js');
		const { res, json } = await invoke(handler, { method: 'GET', url: '/.well-known/x402' });
		expect(res.statusCode).toBe(200);
		expect(json.schemes).toContain('pump-agent-payments');
		expect(json.pump_agent_payments.prep).toBe('/api/pump/accept-payment-prep');
	});
});
