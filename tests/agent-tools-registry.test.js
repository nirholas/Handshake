import { describe, it, expect, vi, beforeEach } from 'vitest';

// The registry's upstreams are the mocked boundary; what is under test is the
// schema surface, argument validation, and result mapping.
const geckoFetch = vi.fn();
vi.mock('../api/_lib/coingecko.js', () => ({ geckoFetch: (...a) => geckoFetch(...a) }));

const getBalance = vi.fn();
vi.mock('../api/_lib/agent-pumpfun.js', () => ({
	solanaPublicConnection: () => ({ getBalance: (...a) => getBalance(...a) }),
}));

const assessTradeSafety = vi.fn();
vi.mock('../api/_lib/trade-firewall.js', () => ({
	assessTradeSafety: (...a) => assessTradeSafety(...a),
}));

const getSmartMoneyForMint = vi.fn();
vi.mock('../api/_lib/smart-money.js', () => ({
	getSmartMoneyForMint: (...a) => getSmartMoneyForMint(...a),
}));

const resolveSnsName = vi.fn();
vi.mock('../src/solana/sns.js', () => ({ resolveSnsName: (...a) => resolveSnsName(...a) }));

const { AGENT_TOOLS, agentToolSchemas, agentToolHandlers } = await import(
	'../api/_lib/agent-tools.js'
);

const SOL_MINT = 'So11111111111111111111111111111111111111112';

beforeEach(() => {
	geckoFetch.mockReset();
	getBalance.mockReset();
	assessTradeSafety.mockReset();
	getSmartMoneyForMint.mockReset();
	resolveSnsName.mockReset();
});

describe('agent tool registry', () => {
	it('exposes a valid OpenAI function schema for every tool', () => {
		const schemas = agentToolSchemas();
		expect(schemas.length).toBe(Object.keys(AGENT_TOOLS).length);
		for (const s of schemas) {
			expect(s.type).toBe('function');
			expect(s.function.name).toBeTruthy();
			expect(s.function.description.length).toBeGreaterThan(10);
			expect(s.function.parameters.type).toBe('object');
			expect(agentToolHandlers()[s.function.name]).toBeTypeOf('function');
		}
	});

	it('token_price maps a CoinGecko search + price into one result', async () => {
		geckoFetch
			.mockResolvedValueOnce({ coins: [{ id: 'solana', name: 'Solana', symbol: 'SOL' }] })
			.mockResolvedValueOnce({
				solana: { usd: 200, usd_24h_change: 3.2, usd_market_cap: 9e10 },
			});

		const out = await AGENT_TOOLS.token_price.handler({ query: 'sol' });
		expect(out).toMatchObject({ found: true, id: 'solana', priceUsd: 200, change24hPct: 3.2 });
	});

	it('token_price reports a miss instead of inventing a coin', async () => {
		geckoFetch.mockResolvedValueOnce({ coins: [] });
		const out = await AGENT_TOOLS.token_price.handler({ query: 'zzzznotacoin' });
		expect(out).toEqual({ found: false, query: 'zzzznotacoin' });
	});

	it('sol_balance validates the address before touching RPC', async () => {
		await expect(AGENT_TOOLS.sol_balance.handler({ address: 'not-base58!' })).rejects.toThrow(
			/base58/,
		);
		expect(getBalance).not.toHaveBeenCalled();

		getBalance.mockResolvedValue(2_500_000_000);
		const out = await AGENT_TOOLS.sol_balance.handler({ address: SOL_MINT });
		expect(out.sol).toBe(2.5);
	});

	it('token_safety forwards the firewall verdict fields verbatim', async () => {
		assessTradeSafety.mockResolvedValue({
			verdict: 'block',
			score: 12,
			simulated: true,
			reasons: ['sell simulation failed'],
			checks: [],
		});
		const out = await AGENT_TOOLS.token_safety.handler({ mint: SOL_MINT });
		expect(out).toMatchObject({ verdict: 'block', score: 12, simulated: true });
		expect(assessTradeSafety).toHaveBeenCalledWith(
			expect.objectContaining({ mint: SOL_MINT, side: 'buy' }),
		);
	});

	it('resolve_sol_name reports resolution honestly', async () => {
		resolveSnsName.mockResolvedValue(null);
		const out = await AGENT_TOOLS.resolve_sol_name.handler({ name: 'ghost.sol' });
		expect(out).toEqual({ name: 'ghost.sol', address: null, resolved: false });
	});

	it('smart_money validates the mint and passes the network through', async () => {
		getSmartMoneyForMint.mockResolvedValue({ mint: SOL_MINT, holders: 3 });
		await AGENT_TOOLS.smart_money.handler({ mint: SOL_MINT, network: 'devnet' });
		expect(getSmartMoneyForMint).toHaveBeenCalledWith(SOL_MINT, 'devnet');
	});
});
