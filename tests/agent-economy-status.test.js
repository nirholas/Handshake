// GET /api/agent-economy/status, the live wallet read behind the A2A demo page.
//
// The invariant worth a test: `configured` reports CONFIGURATION, not RPC
// health. An agent whose env var is set stays configured:true with a null
// balance when Solana is unreachable, so the page can say "balance unavailable"
// instead of "wallet not set". Those two used to collapse into the same
// configured:false, because the address was only assigned after a successful
// balance read and Promise.allSettled swallowed the RPC error.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const BUYER = 'BUYERaddr1111111111111111111111111111111111';
const SELLER = 'SELLERaddr222222222222222222222222222222222';

const walletConfigMock = vi.fn();
const getSolBalanceMock = vi.fn();
const solUsdPriceMock = vi.fn();
vi.mock('../api/_lib/avatar-wallet.js', () => ({
	avatarWalletConfig: () => walletConfigMock(),
	loadAvatarKeypair: () => ({ publicKey: { toBase58: () => BUYER } }),
	getConnection: () => ({}),
	getSolBalance: (...a) => getSolBalanceMock(...a),
	solUsdPrice: () => solUsdPriceMock(),
	isValidPubkey: (a) => typeof a === 'string' && a.length > 30,
	explorerAccountUrl: (addr) => `https://solscan.io/account/${addr}`,
}));

const { default: status } = await import('../api/agent-economy/status.js');

const mkReq = () => ({ method: 'GET', url: '/api/agent-economy/status', headers: {} });
function mkRes() {
	return {
		statusCode: 200, headers: {}, body: undefined, writableEnded: false,
		setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
		writeHead(code, hdrs) { this.statusCode = code; Object.assign(this.headers, hdrs || {}); return this; },
		end(b) { this.body = b; this.writableEnded = true; },
	};
}
const payload = (res) => (res.body ? JSON.parse(res.body) : undefined);

beforeEach(() => {
	process.env.AVATAR_WALLET_SECRET = 'test-secret';
	process.env.AGENT_B_ADDRESS = SELLER;
	walletConfigMock.mockReset().mockReturnValue({ configured: true, network: 'mainnet' });
	solUsdPriceMock.mockReset().mockResolvedValue(200);
	getSolBalanceMock.mockReset().mockImplementation(async (_conn, addr) =>
		(addr === BUYER ? { sol: 0.5, lamports: 500_000_000 } : { sol: 2, lamports: 2_000_000_000 }));
});

describe('GET /api/agent-economy/status', () => {
	it('returns both live balances priced in USD', async () => {
		const res = mkRes();
		await status(mkReq(), res);

		expect(res.statusCode).toBe(200);
		expect(res.headers['cache-control']).toBe('no-store');
		const out = payload(res);
		expect(out.agentA).toEqual({
			configured: true, address: BUYER, sol: 0.5, lamports: 500_000_000,
			usd: 100, solPriceUsd: 200, network: 'mainnet',
			explorer: `https://solscan.io/account/${BUYER}`,
		});
		expect(out.agentB).toMatchObject({ configured: true, address: SELLER, sol: 2, usd: 400 });
	});

	it('stays configured with a null balance when the RPC read fails', async () => {
		getSolBalanceMock.mockRejectedValue(new Error('429 rate limited'));
		const res = mkRes();
		await status(mkReq(), res);

		const out = payload(res);
		expect(out.agentA).toMatchObject({ configured: true, address: BUYER, sol: null, usd: null });
		expect(out.agentB).toMatchObject({ configured: true, address: SELLER, sol: null });
	});

	it('reports configured:false only when the env var is absent', async () => {
		walletConfigMock.mockReturnValue({ configured: false, network: 'mainnet' });
		delete process.env.AGENT_B_ADDRESS;
		const res = mkRes();
		await status(mkReq(), res);

		expect(payload(res)).toEqual({ agentA: { configured: false }, agentB: { configured: false } });
		expect(getSolBalanceMock).not.toHaveBeenCalled();
	});

	it('ignores a malformed AGENT_B_ADDRESS instead of reporting a bad wallet', async () => {
		process.env.AGENT_B_ADDRESS = 'not-a-pubkey';
		const res = mkRes();
		await status(mkReq(), res);

		const out = payload(res);
		expect(out.agentB).toEqual({ configured: false });
		expect(out.agentA.configured).toBe(true);
	});
});
