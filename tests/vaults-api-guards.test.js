// The /api/vaults write routes take caller-supplied ids and amounts and hand them
// straight to a uuid column or to BigInt(). Before this file, a single malformed
// field ("vaultId":"not-a-uuid", "shares":"abc") raised a NeonDbError / SyntaxError
// that the wrapper turned into a 500 with a support ref, on four separate routes;
// a non-uuid agentId leaked the raw Postgres code 22P02 back to the caller as the
// error code. These tests pin the boundary: malformed input answers 4xx JSON, the
// good path still reaches the settlement layer untouched, and the owner's terms
// PATCH can never write a NaN into an integer column.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const VAULT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const AGENT = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const USER = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const MINT = 'FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump';

const authWriteMock = vi.fn();
const resolveUserIdMock = vi.fn();
const loadOwnedAgentMock = vi.fn();
vi.mock('../api/_lib/vault-auth.js', () => ({
	authWrite: (...a) => authWriteMock(...a),
	resolveUserId: (...a) => resolveUserIdMock(...a),
	loadOwnedAgent: (...a) => loadOwnedAgentMock(...a),
	loadAgent: vi.fn(async () => ({ id: AGENT, name: 'Anchor', description: null, image: null })),
	assertReputationVerified: vi.fn(async () => true),
	traderBadge: vi.fn(async () => null),
}));

const getVaultMock = vi.fn();
const updateVaultTermsMock = vi.fn();
vi.mock('../api/_lib/vault-store.js', () => ({
	getVault: (...a) => getVaultMock(...a),
	updateVaultTerms: (...a) => updateVaultTermsMock(...a),
	recordVaultEvent: vi.fn(async () => ({})),
	getOpenPositions: vi.fn(async () => []),
	getBacker: vi.fn(async () => null),
	listBackers: vi.fn(async () => []),
	setVaultStatus: vi.fn(async () => ({})),
	createVault: vi.fn(async () => ({ id: VAULT })),
	listVaults: vi.fn(async () => []),
	listBackedVaults: vi.fn(async () => []),
}));

const depositToVaultMock = vi.fn(async () => ({ status: 'settled', shares: '1' }));
const redeemFromVaultMock = vi.fn(async () => ({ status: 'settled', net_atomics: '1' }));
const claimVaultFeesMock = vi.fn(async () => ({ status: 'settled', atomics: '1' }));
vi.mock('../api/_lib/vault-transfer.js', () => ({
	depositToVault: (...a) => depositToVaultMock(...a),
	redeemFromVault: (...a) => redeemFromVaultMock(...a),
	claimVaultFees: (...a) => claimVaultFeesMock(...a),
}));

const vaultTradeMock = vi.fn(async () => ({ status: 'filled', signature: 'sig' }));
vi.mock('../api/_lib/vault-trade.js', () => ({ vaultTrade: (...a) => vaultTradeMock(...a) }));

vi.mock('../api/_lib/vault-wallet.js', () => ({
	generateVaultWallet: vi.fn(async () => ({ address: 'Vau1t', encrypted_secret: 'enc' })),
	computeVaultNav: vi.fn(async () => ({ navAtomics: 0n, freeAtomics: 0n, usdcAtomics: 0n, priced: true, positions: [] })),
}));

vi.mock('../api/_lib/rate-limit.js', () => ({
	limits: { tradePerUser: vi.fn(async () => ({ success: true, reset: 1_000 })) },
	clientIp: () => '203.0.113.9',
}));

const { default: depositHandler } = await import('../api/vaults/deposit.js');
const { default: redeemHandler } = await import('../api/vaults/redeem.js');
const { default: tradeHandler } = await import('../api/vaults/trade.js');
const { default: claimFeesHandler } = await import('../api/vaults/claim-fees.js');
const { default: vaultsHandler } = await import('../api/vaults/index.js');
const { default: vaultDetailHandler } = await import('../api/vaults/[id].js');

function mkReq({ method = 'POST', url = '/api/vaults', body = null, headers = {} } = {}) {
	const hdrs = { ...headers };
	if (body != null && !hdrs['content-type']) hdrs['content-type'] = 'application/json';
	return {
		method, url, headers: hdrs,
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
		statusCode: 200, headers: {}, body: undefined, writableEnded: false, headersSent: false,
		setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
		end(b) { this.body = b; this.writableEnded = true; this.headersSent = true; },
	};
}
const parse = (res) => (res.body ? JSON.parse(res.body) : undefined);

async function call(handler, req) {
	const res = mkRes();
	await handler(req, res);
	return { res, out: parse(res) };
}

const OPEN_VAULT = {
	id: VAULT, agent_id: AGENT, owner_user_id: USER, network: 'mainnet', status: 'open',
	performance_fee_bps: 1000, max_drawdown_bps: 2500, per_backer_cap_atomics: null,
	max_per_trade_atomics: '5000000', daily_budget_atomics: '50000000',
	total_shares: '0', peak_share_price_e6: '1000000', accrued_fee_atomics: '0',
	halt_reason: null, paused_at: null, created_at: new Date('2026-08-01T00:00:00Z'),
	vault_address: 'Vau1t',
};

beforeEach(() => {
	vi.clearAllMocks();
	authWriteMock.mockResolvedValue({ userId: USER, session: false });
	resolveUserIdMock.mockResolvedValue({ userId: USER, session: false });
	loadOwnedAgentMock.mockResolvedValue({
		id: AGENT, user_id: USER, name: 'Anchor',
		meta: { solana_address: 'Ag3nt', encrypted_solana_secret: 'enc' },
	});
	getVaultMock.mockResolvedValue(OPEN_VAULT);
	// The real store returns a row whose numeric(40,0) columns are plain strings,
	// so the handler's JSON response never sees a BigInt.
	updateVaultTermsMock.mockImplementation(async (_id, patch) => ({
		...OPEN_VAULT,
		performance_fee_bps: patch.performanceFeeBps ?? OPEN_VAULT.performance_fee_bps,
		max_drawdown_bps: patch.maxDrawdownBps ?? OPEN_VAULT.max_drawdown_bps,
		max_per_trade_atomics: String(patch.maxPerTradeAtomics ?? OPEN_VAULT.max_per_trade_atomics),
		daily_budget_atomics: String(patch.dailyBudgetAtomics ?? OPEN_VAULT.daily_budget_atomics),
	}));
});

describe('malformed ids never reach a uuid column', () => {
	it('POST /api/vaults/deposit rejects a non-uuid vaultId and backerAgentId with 400', async () => {
		const a = await call(depositHandler, mkReq({ url: '/api/vaults/deposit', body: { vaultId: 'not-a-uuid', backerAgentId: AGENT, usdc: 1 } }));
		expect(a.res.statusCode).toBe(400);
		expect(a.out.error).toBe('validation_error');

		const b = await call(depositHandler, mkReq({ url: '/api/vaults/deposit', body: { vaultId: VAULT, backerAgentId: 'nope', usdc: 1 } }));
		expect(b.res.statusCode).toBe(400);
		expect(b.out.error).toBe('validation_error');

		expect(getVaultMock).not.toHaveBeenCalled();
		expect(depositToVaultMock).not.toHaveBeenCalled();
	});

	it('POST /api/vaults/redeem rejects a non-uuid vaultId with 400', async () => {
		const { res, out } = await call(redeemHandler, mkReq({ url: '/api/vaults/redeem', body: { vaultId: 'not-a-uuid' } }));
		expect(res.statusCode).toBe(400);
		expect(out.error).toBe('validation_error');
		expect(redeemFromVaultMock).not.toHaveBeenCalled();
	});

	it('POST /api/vaults/trade rejects a non-uuid vaultId and a non-address mint with 400', async () => {
		const a = await call(tradeHandler, mkReq({ url: '/api/vaults/trade', body: { vaultId: 'not-a-uuid', side: 'buy', mint: MINT, usdc: 1 } }));
		expect(a.res.statusCode).toBe(400);

		const b = await call(tradeHandler, mkReq({ url: '/api/vaults/trade', body: { vaultId: VAULT, side: 'buy', mint: 'x', usdc: 1 } }));
		expect(b.res.statusCode).toBe(400);
		expect(b.out.error_description).toMatch(/mint/);
		expect(vaultTradeMock).not.toHaveBeenCalled();
	});

	it('POST /api/vaults/claim-fees rejects a non-uuid vaultId and toAgentId with 400', async () => {
		const a = await call(claimFeesHandler, mkReq({ url: '/api/vaults/claim-fees', body: { vaultId: 'not-a-uuid', toAgentId: AGENT } }));
		expect(a.res.statusCode).toBe(400);
		const b = await call(claimFeesHandler, mkReq({ url: '/api/vaults/claim-fees', body: { vaultId: VAULT, toAgentId: 'nope' } }));
		expect(b.res.statusCode).toBe(400);
		expect(claimVaultFeesMock).not.toHaveBeenCalled();
	});

	it('POST /api/vaults rejects a non-uuid agentId instead of leaking the Postgres 22P02 code', async () => {
		const { res, out } = await call(vaultsHandler, mkReq({ body: { agentId: 'nope', maxPerTradeUsdc: 1, dailyBudgetUsdc: 2 } }));
		expect(res.statusCode).toBe(400);
		expect(out.error).toBe('validation_error');
		expect(loadOwnedAgentMock).not.toHaveBeenCalled();
	});
});

describe('caller-supplied amounts are parsed at the boundary', () => {
	it('rejects a non-numeric shares value instead of throwing inside BigInt()', async () => {
		const { res, out } = await call(redeemHandler, mkReq({ url: '/api/vaults/redeem', body: { vaultId: VAULT, shares: 'abc' } }));
		expect(res.statusCode).toBe(400);
		expect(out.error_description).toMatch(/shares/);
		expect(redeemFromVaultMock).not.toHaveBeenCalled();
	});

	it('rejects a non-numeric sell amount on a vault the caller really owns', async () => {
		const { res, out } = await call(tradeHandler, mkReq({ url: '/api/vaults/trade', body: { vaultId: VAULT, side: 'sell', mint: MINT, amount: 'abc' } }));
		expect(res.statusCode).toBe(400);
		expect(out.error_description).toMatch(/amount/);
		expect(vaultTradeMock).not.toHaveBeenCalled();
	});

	it('passes a real redemption through untouched: "max" stays max, a number stays exact', async () => {
		await call(redeemHandler, mkReq({ url: '/api/vaults/redeem', body: { vaultId: VAULT } }));
		expect(redeemFromVaultMock).toHaveBeenLastCalledWith(expect.objectContaining({ vaultId: VAULT, userId: USER, shares: 'max' }));

		await call(redeemHandler, mkReq({ url: '/api/vaults/redeem', body: { vaultId: VAULT, shares: '2500000' } }));
		expect(redeemFromVaultMock).toHaveBeenLastCalledWith(expect.objectContaining({ shares: '2500000' }));
	});

	it('passes a real sell through as an exact BigInt of raw token units', async () => {
		const { res } = await call(tradeHandler, mkReq({ url: '/api/vaults/trade', body: { vaultId: VAULT, side: 'sell', mint: MINT, amount: '123456789' } }));
		expect(res.statusCode).toBe(200);
		expect(vaultTradeMock).toHaveBeenLastCalledWith(expect.objectContaining({ side: 'sell', mint: MINT, amountRaw: 123456789n }));
	});
});

describe('PATCH /api/vaults/:id terms', () => {
	const patchReq = (body) => mkReq({ method: 'PATCH', url: `/api/vaults/${VAULT}`, body });

	it('refuses a non-numeric bps term instead of writing NaN into an integer column', async () => {
		const a = await call(vaultDetailHandler, patchReq({ action: 'terms', performanceFeeBps: 'abc' }));
		expect(a.res.statusCode).toBe(400);
		const b = await call(vaultDetailHandler, patchReq({ action: 'terms', maxDrawdownBps: 'abc' }));
		expect(b.res.statusCode).toBe(400);
		expect(updateVaultTermsMock).not.toHaveBeenCalled();
	});

	it('refuses a non-positive spend term rather than silently ignoring it', async () => {
		const { res, out } = await call(vaultDetailHandler, patchReq({ action: 'terms', maxPerTradeUsdc: -5 }));
		expect(res.statusCode).toBe(400);
		expect(out.error_description).toMatch(/maxPerTradeUsdc/);
		expect(updateVaultTermsMock).not.toHaveBeenCalled();
	});

	it('refuses a per-trade ceiling above the daily budget, counting the terms already stored', async () => {
		// Stored budget is 50 USDC; a 60 USDC per-trade ceiling would let one trade
		// blow the whole day's limit.
		const { res } = await call(vaultDetailHandler, patchReq({ action: 'terms', maxPerTradeUsdc: 60 }));
		expect(res.statusCode).toBe(400);
		expect(updateVaultTermsMock).not.toHaveBeenCalled();
	});

	it('clamps a legal-but-extreme fee into bounds and applies it', async () => {
		const { res } = await call(vaultDetailHandler, patchReq({ action: 'terms', performanceFeeBps: 9999 }));
		expect(res.statusCode).toBe(200);
		expect(updateVaultTermsMock).toHaveBeenCalledWith(VAULT, expect.objectContaining({ performanceFeeBps: 5000 }));
	});

	it('applies a matched per-trade + daily budget raise', async () => {
		const { res } = await call(vaultDetailHandler, patchReq({ action: 'terms', maxPerTradeUsdc: 60, dailyBudgetUsdc: 600 }));
		expect(res.statusCode).toBe(200);
		expect(updateVaultTermsMock).toHaveBeenCalledWith(VAULT, expect.objectContaining({
			maxPerTradeAtomics: 60_000_000n, dailyBudgetAtomics: 600_000_000n,
		}));
	});

	it('answers 404 for a malformed vault id in the path, never a database error', async () => {
		const { res, out } = await call(vaultDetailHandler, mkReq({ method: 'PATCH', url: '/api/vaults/not-a-uuid', body: { action: 'pause' } }));
		expect(res.statusCode).toBe(404);
		expect(out.error).toBe('not_found');
		expect(getVaultMock).not.toHaveBeenCalled();
	});
});
