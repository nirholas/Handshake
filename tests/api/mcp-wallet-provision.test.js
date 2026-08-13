// provision_wallet + monetize_endpoint — the two-sided wallet tools on the
// agent-wallet MCP server (api/mcp-agent). We test orchestration: ownership,
// scope, idempotency, the mainnet-airdrop refusal, SSRF rejection of a private
// target_url, and the "no wallet → provision first" designed error. The wallet
// custody, registry DB, and SSRF resolver layers are mocked — we assert the
// tool wiring, not fund movement or real network I/O.

import { describe, it, expect, beforeEach, vi } from 'vitest';

process.env.PUBLIC_APP_ORIGIN ||= 'https://three.ws';

// ── DB (registry + agent lookup) ─────────────────────────────────────────────
const dbState = { agentRow: null, insertRow: null, insertError: null };
vi.mock('../../api/_lib/db.js', () => ({
	sql: vi.fn(async (strings) => {
		const q = Array.isArray(strings) ? strings.join(' ') : String(strings);
		if (q.includes('INSERT INTO agent_paid_services')) {
			if (dbState.insertError) throw dbState.insertError;
			return [dbState.insertRow];
		}
		if (q.includes('agent_identities')) return dbState.agentRow ? [dbState.agentRow] : [];
		return [];
	}),
	isDbUnavailableError: () => false,
	isDbCapacityError: () => false,
}));

// ── Wallet custody layer ─────────────────────────────────────────────────────
const walletState = { address: 'SoLagentAddr1111', created: true, sol: 0.5, usdc: 0 };
vi.mock('../../api/_lib/agent-wallet.js', () => ({
	getOrCreateAgentSolanaWallet: vi.fn(async () => ({
		address: walletState.address,
		created: walletState.created,
	})),
	getSolanaAddressBalances: vi.fn(async () => ({ sol: walletState.sol, usdc: walletState.usdc })),
}));

// ── SSRF resolver — deterministic, no real DNS ───────────────────────────────
vi.mock('../../api/_lib/ssrf.js', () => {
	class SsrfError extends Error {
		constructor(message, code = 'blocked') {
			super(message);
			this.name = 'SsrfError';
			this.code = code;
		}
	}
	return {
		SsrfError,
		assertPublicHttpsUrl: vi.fn(async (rawUrl) => {
			if (/localhost|127\.0\.0\.1|169\.254|(^|\/\/)10\.|internal\b/.test(rawUrl)) {
				throw new SsrfError('host resolves to private address', 'private_address');
			}
			return rawUrl;
		}),
	};
});

// ── Devnet faucet: the connection + confirmation the airdrop path uses ───────
// requestDevnetAirdrop imports these lazily, so the mocks stand in for the RPC
// without any devnet traffic. airdropState drives success vs. faucet failure.
const airdropState = { signature: 'FaucetSig1111', requestError: null, confirmError: null };
const requestAirdrop = vi.fn(async () => {
	if (airdropState.requestError) throw airdropState.requestError;
	return airdropState.signature;
});
vi.mock('../../api/_lib/agent-pumpfun.js', () => ({
	solanaConnection: vi.fn(() => ({ requestAirdrop })),
}));
vi.mock('../../api/_lib/solana/confirm.js', () => ({
	confirmOrThrow: vi.fn(async () => {
		if (airdropState.confirmError) throw airdropState.confirmError;
		return { value: { err: null } };
	}),
}));
// PublicKey only has to accept the fixture address; every other web3 export
// (LAMPORTS_PER_SOL, used to size the airdrop) stays real.
vi.mock('@solana/web3.js', async (orig) => ({
	...(await orig()),
	PublicKey: class {
		constructor(address) {
			this.address = address;
		}
		toBase58() {
			return this.address;
		}
	},
}));

// ── Imported-but-unused-here money core (must resolve) ───────────────────────
vi.mock('../../api/_lib/x402-user-payer.js', () => ({
	resolveSpendEnabled: () => true,
	getUserWalletStatus: vi.fn(async () => null),
	payExternalX402: vi.fn(async () => null),
}));

// ── Rate limits + usage ──────────────────────────────────────────────────────
vi.mock('../../api/_lib/rate-limit.js', () => ({
	limits: { mcpAgent: vi.fn(async () => ({ success: true, reset: 0 })) },
	clientIp: vi.fn(() => '203.0.113.9'),
}));
vi.mock('../../api/_lib/usage.js', () => ({
	recordEvent: vi.fn(),
	logger: () => ({ info: () => {}, warn: () => {}, error: () => {} }),
}));

const { dispatch } = await import('../../api/_mcpagent/dispatch.js');

const ANON = { userId: null, rateKey: 'x402:anon', scope: '', source: 'x402' };
const USER = {
	userId: 'user-1',
	rateKey: 'user-1',
	scope: 'wallet:read wallet:write services:write',
	source: 'bearer',
};
const READONLY = { userId: 'user-1', rateKey: 'user-1', scope: 'wallet:read', source: 'bearer' };

const AGENT_ID = '11111111-1111-1111-1111-111111111111';

const call = (name, args, auth = USER) =>
	dispatch({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, auth);

function ownedAgent(extra = {}) {
	return { id: AGENT_ID, user_id: 'user-1', meta: {}, wallet_address: null, ...extra };
}

beforeEach(() => {
	dbState.agentRow = ownedAgent();
	dbState.insertRow = null;
	dbState.insertError = null;
	walletState.created = true;
	walletState.sol = 0.5;
	walletState.usdc = 0;
	airdropState.requestError = null;
	airdropState.confirmError = null;
	requestAirdrop.mockClear();
});

describe('agent-wallet MCP — provisioning + earning', () => {
	it('exposes provision_wallet and monetize_endpoint in the catalog', async () => {
		const r = await dispatch({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, USER);
		const names = r.result.tools.map((t) => t.name);
		expect(names).toContain('provision_wallet');
		expect(names).toContain('monetize_endpoint');
	});

	// ── provision_wallet ────────────────────────────────────────────────────────

	it('provisions a wallet and returns address + balances', async () => {
		const r = await call('provision_wallet', { agent_id: AGENT_ID });
		expect(r.result.structuredContent).toMatchObject({
			ok: true,
			agent_id: AGENT_ID,
			address: 'SoLagentAddr1111',
			cluster: 'mainnet',
			created: true,
			sol_balance: 0.5,
			usdc_balance: 0,
		});
		expect(r.result.structuredContent.airdrop).toBeUndefined();
	});

	it('is idempotent — a second call returns the existing wallet (created:false)', async () => {
		walletState.created = false;
		const r = await call('provision_wallet', { agent_id: AGENT_ID });
		expect(r.result.structuredContent).toMatchObject({ ok: true, created: false, address: 'SoLagentAddr1111' });
	});

	it('rejects the anonymous x402 path with a designed sign-in error', async () => {
		const r = await call('provision_wallet', { agent_id: AGENT_ID }, ANON);
		expect(r.result.isError).toBe(true);
		expect(r.result.structuredContent.signed_in).toBe(false);
	});

	it("refuses an agent the caller doesn't own", async () => {
		dbState.agentRow = ownedAgent({ user_id: 'someone-else' });
		const r = await call('provision_wallet', { agent_id: AGENT_ID });
		expect(r.result.isError).toBe(true);
		expect(r.result.structuredContent.reason).toBe('forbidden');
	});

	it('reports a missing agent', async () => {
		dbState.agentRow = null;
		const r = await call('provision_wallet', { agent_id: AGENT_ID });
		expect(r.result.isError).toBe(true);
		expect(r.result.structuredContent.reason).toBe('agent_not_found');
	});

	it('NEVER airdrops on mainnet, even when airdrop:true', async () => {
		const r = await call('provision_wallet', { agent_id: AGENT_ID, cluster: 'mainnet', airdrop: true });
		expect(r.result.structuredContent.cluster).toBe('mainnet');
		// No airdrop attempted, no fabricated balance.
		expect(r.result.structuredContent.airdrop).toBeUndefined();
		expect(r.result.structuredContent.sol_balance).toBe(0.5);
		// Say so rather than dropping the argument in silence.
		expect(r.result.content[0].text).toContain('Airdrop skipped');
	});

	it('airdrops 1 SOL on devnet and reports the signature', async () => {
		walletState.sol = 1.5; // balances are read after the faucet lands
		const r = await call('provision_wallet', {
			agent_id: AGENT_ID,
			cluster: 'devnet',
			airdrop: true,
		});
		expect(requestAirdrop).toHaveBeenCalledTimes(1);
		expect(r.result.structuredContent).toMatchObject({
			ok: true,
			cluster: 'devnet',
			sol_balance: 1.5,
			airdrop: { ok: true, signature: 'FaucetSig1111', sol: 1 },
		});
		expect(r.result.content[0].text).toContain('Airdropped 1 SOL on devnet');
	});

	it('never touches the faucet on devnet unless airdrop is asked for', async () => {
		const r = await call('provision_wallet', { agent_id: AGENT_ID, cluster: 'devnet' });
		expect(requestAirdrop).not.toHaveBeenCalled();
		expect(r.result.structuredContent.airdrop).toBeUndefined();
	});

	it('still provisions when the faucet is rate limited, as a note not an error', async () => {
		airdropState.requestError = new Error('429 Too Many Requests: airdrop limit reached');
		const r = await call('provision_wallet', {
			agent_id: AGENT_ID,
			cluster: 'devnet',
			airdrop: true,
		});
		// The wallet is real and returned; only the faucet failed.
		expect(r.result.isError).toBeUndefined();
		expect(r.result.structuredContent).toMatchObject({
			ok: true,
			address: 'SoLagentAddr1111',
			airdrop: { ok: false, reason: 'faucet_rate_limited' },
		});
		expect(r.result.content[0].text).toContain('Devnet airdrop unavailable');
	});

	it('reports a faucet that never confirms as unavailable, not rate limited', async () => {
		airdropState.confirmError = new Error('transaction was not confirmed in time');
		const r = await call('provision_wallet', {
			agent_id: AGENT_ID,
			cluster: 'devnet',
			airdrop: true,
		});
		expect(r.result.structuredContent.airdrop).toMatchObject({
			ok: false,
			reason: 'faucet_unavailable',
		});
	});

	it('enforces the wallet:write scope', async () => {
		const r = await call('provision_wallet', { agent_id: AGENT_ID }, READONLY);
		expect(r.result.isError).toBe(true);
		expect(r.result.structuredContent).toMatchObject({ reason: 'insufficient_scope', required: 'wallet:write' });
	});

	// ── monetize_endpoint ────────────────────────────────────────────────────────

	it('publishes a priced, bazaar-listed endpoint (happy path)', async () => {
		dbState.agentRow = ownedAgent({ wallet_address: '0xAgentEvmWallet' });
		dbState.insertRow = {
			id: 'svc-1',
			slug: 'weather-api-abcd1234',
			name: 'Weather API',
			description: 'Live weather',
			price_atomics: '10000',
			network: 'base',
			bazaar_listed: true,
		};
		const r = await call('monetize_endpoint', {
			agent_id: AGENT_ID,
			name: 'Weather API',
			description: 'Live weather',
			price_usdc: 0.01,
			target_url: 'https://api.example.com/weather',
		});
		expect(r.result.structuredContent).toMatchObject({
			ok: true,
			service_id: 'svc-1',
			resource_url: 'https://three.ws/api/x402/service/weather-api-abcd1234',
			price_usdc: 0.01,
			network: 'base',
			bazaar_listed: true,
		});
	});

	it('refuses to list without a payout wallet — tells the caller to provision first', async () => {
		// Base network, agent has no EVM wallet_address.
		dbState.agentRow = ownedAgent({ wallet_address: null });
		const r = await call('monetize_endpoint', {
			agent_id: AGENT_ID,
			name: 'Svc',
			description: 'desc',
			price_usdc: 0.05,
			target_url: 'https://api.example.com/x',
			network: 'solana',
		});
		expect(r.result.isError).toBe(true);
		expect(r.result.structuredContent.reason).toBe('no_payout_wallet');
		expect(dbState.insertRow).toBeNull(); // nothing half-created
	});

	it('rejects a non-public (SSRF) target_url', async () => {
		dbState.agentRow = ownedAgent({ wallet_address: '0xAgentEvmWallet' });
		const r = await call('monetize_endpoint', {
			agent_id: AGENT_ID,
			name: 'Svc',
			description: 'desc',
			price_usdc: 0.05,
			target_url: 'https://169.254.169.254/latest/meta-data',
		});
		expect(r.result.isError).toBe(true);
		expect(r.result.structuredContent.reason).toBe('invalid_target_url');
	});

	it('rejects a non-positive price before any DNS / DB work', async () => {
		dbState.agentRow = ownedAgent({ wallet_address: '0xAgentEvmWallet' });
		const r = await call('monetize_endpoint', {
			agent_id: AGENT_ID,
			name: 'Svc',
			description: 'desc',
			price_usdc: 0,
			target_url: 'https://api.example.com/x',
		});
		// price_usdc: 0 fails the schema (exclusiveMinimum) → -32602 invalid params.
		expect(r.error?.code).toBe(-32602);
	});

	it('answers an exhausted slug allocation with a structured refusal', async () => {
		dbState.agentRow = ownedAgent({ wallet_address: '0xAgentEvmWallet' });
		// Every insert collides, so createPaidService burns its retries. The agent
		// gets the designed reason rather than the driver's unique-violation text.
		dbState.insertError = Object.assign(
			new Error('duplicate key value violates unique constraint "agent_paid_services_slug_key"'),
			{ code: '23505' },
		);
		const r = await call('monetize_endpoint', {
			agent_id: AGENT_ID,
			name: 'Weather API',
			description: 'Live weather',
			price_usdc: 0.01,
			target_url: 'https://api.example.com/weather',
		});
		expect(r.result.isError).toBe(true);
		expect(r.result.structuredContent).toMatchObject({
			ok: false,
			reason: 'slug_alloc_failed',
			network: 'base',
		});
		// The pg constraint name never reaches the caller.
		expect(JSON.stringify(r.result)).not.toContain('unique constraint');
	});

	it('requires sign-in for monetize_endpoint', async () => {
		const r = await call(
			'monetize_endpoint',
			{
				agent_id: AGENT_ID,
				name: 'Svc',
				description: 'desc',
				price_usdc: 0.05,
				target_url: 'https://api.example.com/x',
			},
			ANON,
		);
		expect(r.result.isError).toBe(true);
		expect(r.result.structuredContent.signed_in).toBe(false);
	});

	it('enforces the services:write scope', async () => {
		const r = await call(
			'monetize_endpoint',
			{
				agent_id: AGENT_ID,
				name: 'Svc',
				description: 'desc',
				price_usdc: 0.05,
				target_url: 'https://api.example.com/x',
			},
			READONLY,
		);
		expect(r.result.isError).toBe(true);
		expect(r.result.structuredContent).toMatchObject({ reason: 'insufficient_scope', required: 'services:write' });
	});
});
