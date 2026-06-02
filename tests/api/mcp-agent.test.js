import { describe, it, expect, beforeEach, vi } from 'vitest';

process.env.PUBLIC_APP_ORIGIN ||= 'https://three.ws';

// ── Per-user payer (money core) — mocked; we test orchestration, not fund movement ──
const payerState = {
	spendEnabled: true,
	walletStatus: null,
	payResult: null,
	payError: null,
};
vi.mock('../../api/_lib/x402-user-payer.js', () => ({
	resolveSpendEnabled: () => payerState.spendEnabled,
	getUserWalletStatus: vi.fn(async () => payerState.walletStatus),
	payExternalX402: vi.fn(async () => {
		if (payerState.payError) throw payerState.payError;
		return payerState.payResult;
	}),
}));

// ── Bazaar (live discovery) ──────────────────────────────────────────────────
const bazState = { search: vi.fn(async () => ({ resources: [], errors: [] })) };
vi.mock('../../api/_lib/x402/bazaar-client.js', async (orig) => {
	const real = await orig();
	return { ...real, Bazaar: class { search(...a) { return bazState.search(...a); } } };
});

// ── Rate limits ──────────────────────────────────────────────────────────────
const rl = { agent: { success: true, reset: 0 }, pay: { success: true, reset: 0 } };
vi.mock('../../api/_lib/rate-limit.js', () => ({
	limits: {
		mcpAgent: vi.fn(async () => rl.agent),
		mcpAgentPay: vi.fn(async () => rl.pay),
	},
	clientIp: vi.fn(() => '203.0.113.5'),
}));

vi.mock('../../api/_lib/usage.js', () => ({
	recordEvent: vi.fn(),
	logger: () => ({ info: () => {}, warn: () => {}, error: () => {} }),
}));

const payer = await import('../../api/_lib/x402-user-payer.js');
const { dispatch } = await import('../../api/_mcpagent/dispatch.js');

const ANON = { userId: null, rateKey: 'x402:anon', scope: '', source: 'x402' };
const USER = { userId: 'user-1', rateKey: 'user-1', scope: 'wallet:read', source: 'bearer' };
const call = (name, args, auth = USER) =>
	dispatch({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, auth);

beforeEach(() => {
	payerState.spendEnabled = true;
	payerState.walletStatus = null;
	payerState.payResult = null;
	payerState.payError = null;
	payer.payExternalX402.mockClear();
	payer.getUserWalletStatus.mockClear();
	bazState.search.mockClear();
	rl.agent = { success: true, reset: 0 };
	rl.pay = { success: true, reset: 0 };
});

describe('threews-agent MCP', () => {
	it('lists the wallet toolset', async () => {
		const r = await dispatch({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, USER);
		expect(r.result.tools.map((t) => t.name)).toEqual(['wallet_status', 'find_services', 'pay_and_call']);
	});

	it('wallet_status requires sign-in', async () => {
		const r = await call('wallet_status', {}, ANON);
		expect(r.result.isError).toBe(true);
		expect(r.result.structuredContent.signed_in).toBe(false);
		expect(payer.getUserWalletStatus).not.toHaveBeenCalled();
	});

	it('wallet_status reports balance + caps for a signed-in user', async () => {
		payerState.walletStatus = {
			provisioned: true,
			agent_id: 'a1',
			agent_name: 'Scout',
			address: 'SoLaddr',
			network: 'solana',
			balances: { sol: 0.2, usdc: 5 },
			spend_enabled: true,
			caps: { max_per_call_usdc: 0.1, max_per_hour_usdc: 1, max_per_day_usdc: 10 },
		};
		const r = await call('wallet_status', {});
		expect(payer.getUserWalletStatus).toHaveBeenCalledWith('user-1');
		expect(r.result.structuredContent).toMatchObject({ signed_in: true, address: 'SoLaddr', balances: { usdc: 5 } });
		expect(r.result.content[0].text).toContain('5 USDC');
	});

	it('find_services searches the live bazaar', async () => {
		bazState.search.mockResolvedValue({
			resources: [{ resource: 'https://svc.test', serviceName: 'Svc', minPriceLabel: '$0.01', networks: ['solana:*'], toolName: '' }],
			errors: [],
		});
		const r = await call('find_services', { query: 'weather' });
		expect(bazState.search).toHaveBeenCalledWith({ query: 'weather', type: 'http' });
		expect(r.result.structuredContent.services[0]).toMatchObject({ resource: 'https://svc.test', price: '$0.01' });
	});

	it('pay_and_call degrades to a pay link when spend is disabled', async () => {
		payerState.spendEnabled = false;
		const r = await call('pay_and_call', { resource_url: 'https://paid.test/x' });
		expect(payer.payExternalX402).not.toHaveBeenCalled();
		expect(r.result.structuredContent).toMatchObject({ paid: false, reason: 'spend_disabled' });
		expect(r.result.structuredContent.pay_link).toContain('https://three.ws/pay?resource=');
	});

	it('pay_and_call degrades to auth handoff for anon callers', async () => {
		const r = await call('pay_and_call', { resource_url: 'https://paid.test/x' }, ANON);
		expect(payer.payExternalX402).not.toHaveBeenCalled();
		expect(r.result.structuredContent.reason).toBe('auth_required');
	});

	it('pay_and_call pays and returns the result when enabled', async () => {
		payerState.payResult = { ok: true, payer: 'SoLaddr', result: { temp: 72 }, receipt: { tx: 'sig' } };
		const r = await call('pay_and_call', { resource_url: 'https://paid.test/weather', max_usd: 0.05 });
		expect(payer.payExternalX402).toHaveBeenCalledWith({
			userId: 'user-1',
			url: 'https://paid.test/weather',
			method: 'GET',
			body: undefined,
			maxUsd: 0.05,
		});
		expect(r.result.structuredContent).toMatchObject({ paid: true, payer: 'SoLaddr', result: { temp: 72 } });
	});

	it('pay_and_call surfaces payer errors with a friendly message + pay link', async () => {
		payerState.payError = Object.assign(new Error('boom'), { code: 'no_solana_wallet' });
		const r = await call('pay_and_call', { resource_url: 'https://paid.test/x' });
		expect(r.result.isError).toBe(true);
		expect(r.result.content[0].text).toContain('no Solana wallet');
		expect(r.result.structuredContent.reason).toBe('no_solana_wallet');
	});

	it('enforces the pay rate limit before spending', async () => {
		rl.pay = { success: false, reset: Date.now() + 30000 };
		const r = await call('pay_and_call', { resource_url: 'https://paid.test/x' });
		expect(r.error.code).toBe(-32000);
		expect(payer.payExternalX402).not.toHaveBeenCalled();
	});
});
