// api/portfolio/[action].js — the dispatcher behind /api/portfolio/{summary,
// history,asset,send}.
//
// Pins the boundaries an August 2026 endpoint audit found unguarded:
//   * `?days=abc` reached Postgres as `NaN days` and surfaced as a 500 with a
//     support ref, and reached CoinGecko as `days=NaN` on /asset.
//   * an amount that truncates to zero base units signed and broadcast a
//     transfer that moved nothing and still burned a fee.
//   * /asset answered `symbol: "SOL"` for an unknown Solana mint.
//   * /asset went blank (`market: null`) whenever CoinGecko throttled our
//     egress IP, instead of falling through to the platform's price lanes.
//   * every EVM lookup was hardcoded to Ethereum, so a Base contract (the chain
//     nearly every agent wallet runs on) missed at CoinGecko AND at DefiLlama.
//
// The upstreams (DB, RPC, CoinGecko, the price-fallback lanes) are stubbed at
// their module boundary; everything else in the handler runs for real.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { makeReq, makeRes } from '../_helpers/monetization.js';

const authState = { session: null };
vi.mock('../../api/_lib/auth.js', () => ({
	getSessionUser: vi.fn(async () => authState.session),
	isSameSiteOrigin: vi.fn(() => true),
	authenticateBearer: vi.fn(async () => null),
	extractBearer: vi.fn(() => null),
}));

vi.mock('../../api/_lib/csrf.js', () => ({ requireCsrf: vi.fn(async () => true) }));

vi.mock('../../api/_lib/rate-limit.js', () => ({
	limits: {
		walletRead: vi.fn(async () => ({ success: true })),
		strict: vi.fn(async () => ({ success: true })),
	},
	clientIp: vi.fn(() => '127.0.0.1'),
}));

const sqlState = { queries: [], agent: null, snapshots: [] };
vi.mock('../../api/_lib/db.js', () => ({
	sql: vi.fn(async (strings, ...values) => {
		const q = (typeof strings === 'string' ? strings : strings.join('?')).toLowerCase();
		sqlState.queries.push({ q, values });
		if (/from portfolio_snapshots/.test(q)) return sqlState.snapshots;
		if (/from agent_identities/.test(q)) return sqlState.agent ? [sqlState.agent] : [];
		return [];
	}),
	isDbUnavailableError: () => false,
	isDbCapacityError: () => false,
	isStoragePressured: () => false,
}));

const balanceState = { byAddress: {} };
vi.mock('../../api/_lib/balances.js', () => ({
	getBalances: vi.fn(async ({ address }) => balanceState.byAddress[address] || { native: { symbol: 'SOL', amount: 0, usd: 0 }, tokens: [] }),
	walletUsdTotal: vi.fn((bal) => Number(bal?.native?.usd || 0) + (bal?.tokens || []).reduce((s, t) => s + Number(t.usd || 0), 0)),
	invalidateBalances: vi.fn(),
}));

vi.mock('../../src/solana/sns.js', () => ({
	reverseLookupAddress: vi.fn(async () => null),
	resolveSolanaRecipient: vi.fn(async (r) => ({ address: r, resolved_from: null })),
}));

// CoinGecko is the throttled upstream the fallback lanes exist for, so these
// cases run with it failing unless a test opts in.
const geckoState = { meta: null, chart: null, fail: true, paths: [] };
vi.mock('../../api/_lib/coingecko.js', () => ({
	geckoFetch: vi.fn(async (path) => {
		geckoState.paths.push(path);
		if (geckoState.fail) throw Object.assign(new Error('CoinGecko 429'), { status: 429 });
		return /market_chart/.test(path) ? geckoState.chart : geckoState.meta;
	}),
	htmlToText: (s) => String(s || ''),
}));

const priceState = { sol: 0, solChange: null, token: null, coin: null };
// Every URL the contract-price lane requested, so a test can assert WHICH chain
// was asked rather than only that a price came back.
const llamaState = { urls: [], byUrl: {} };
vi.mock('../../api/_lib/sol-price.js', () => ({
	solPriceUsd: vi.fn(async () => priceState.sol),
	solChange24hPct: vi.fn(async () => priceState.solChange),
}));
vi.mock('../../api/_lib/market/token-market.js', () => ({
	fetchTokenMarketData: vi.fn(async () => priceState.token),
}));
vi.mock('../../api/_lib/market-fallbacks.js', () => ({
	fetchCoinPriceUsdOrNull: vi.fn(async () => priceState.coin),
}));
// Runs each source's real `parse` against a canned payload, so a test asserts
// the exact upstream URL the handler built (the chain prefix is the whole point).
vi.mock('../../src/shared/failover-fetch.js', () => ({
	fetchFirstOrNull: vi.fn(async (sources) => {
		for (const s of sources) {
			llamaState.urls.push(s.url);
			const payload = llamaState.byUrl[s.url];
			if (payload === undefined) continue;
			const out = await s.parse({ ok: true, status: 200, json: async () => payload });
			if (out != null) return out;
		}
		return null;
	}),
}));

// The signing path must never reach a real RPC or a real key.
const sendState = { signed: [], lamports: null, keyAudit: null };
vi.mock('../../api/_lib/agent-wallet.js', () => ({
	recoverAgentKey: vi.fn(async (_k, audit) => {
		sendState.keyAudit = audit;
		return '0x' + '11'.repeat(32);
	}),
	recoverSolanaAgentKeypair: vi.fn(async () => {
		const { Keypair } = await import('@solana/web3.js');
		return Keypair.generate();
	}),
}));
vi.mock('../../api/_lib/solana/connection.js', () => ({
	solanaConnection: vi.fn(() => ({
		getLatestBlockhash: async () => ({ blockhash: '11111111111111111111111111111111' }),
		getParsedAccountInfo: async () => ({ value: { data: { parsed: { info: { decimals: 6 } } } } }),
		getAccountInfo: async () => ({ lamports: 1 }),
		sendRawTransaction: async (raw) => {
			sendState.signed.push(raw);
			return 'sig-' + sendState.signed.length;
		},
	})),
}));
vi.mock('../../api/_lib/evm/rpc.js', () => ({ evmFallbackProvider: vi.fn(async () => ({})) }));
vi.mock('../../api/_lib/audit.js', () => ({ logAudit: vi.fn() }));

const { default: handler } = await import('../../api/portfolio/[action].js');

const USER = { id: 'user-portfolio-1' };
const AGENT_ID = '00000000-0000-4000-8000-00000000abcd';
const SOL_WALLET = 'So11111111111111111111111111111111111111112';

function res() {
	return makeRes();
}
function body(r) {
	return JSON.parse(r.body);
}

async function get(path, query) {
	const r = res();
	await handler(makeReq({ method: 'GET', url: path, query }), r);
	return r;
}

async function send(payload) {
	const r = res();
	await handler(
		makeReq({ method: 'POST', url: '/api/portfolio/send', query: { action: 'send' }, body: payload, headers: { origin: 'https://three.ws' } }),
		r,
	);
	return r;
}

beforeEach(() => {
	authState.session = USER;
	sqlState.queries = [];
	sqlState.agent = null;
	sqlState.snapshots = [];
	balanceState.byAddress = {};
	geckoState.fail = true;
	geckoState.meta = null;
	geckoState.chart = null;
	geckoState.paths = [];
	llamaState.urls = [];
	llamaState.byUrl = {};
	priceState.sol = 0;
	priceState.solChange = null;
	priceState.token = null;
	priceState.coin = null;
	sendState.signed = [];
	sendState.keyAudit = null;
});

describe('dispatcher + auth', () => {
	it('404s an unknown action', async () => {
		const r = await get('/api/portfolio/nope', { action: 'nope' });
		expect(r.statusCode).toBe(404);
		expect(body(r).error).toBe('not_found');
	});

	it('401s every action without a session', async () => {
		authState.session = null;
		for (const action of ['summary', 'history', 'asset']) {
			const r = await get(`/api/portfolio/${action}`, { action });
			expect(r.statusCode).toBe(401);
			expect(body(r).error).toBe('unauthorized');
		}
		const posted = await send({ agent_id: AGENT_ID, chain: 'solana', asset: 'native', recipient: SOL_WALLET, amount: '1' });
		expect(posted.statusCode).toBe(401);
		expect(body(posted).error).toBe('unauthorized');
	});

	it('405s a GET on the write action', async () => {
		const r = await get('/api/portfolio/send', { action: 'send' });
		expect(r.statusCode).toBe(405);
	});
});

describe('days window', () => {
	it('rejects a non-numeric window instead of handing Postgres NaN', async () => {
		const r = await get('/api/portfolio/history?days=abc', { action: 'history' });
		expect(r.statusCode).toBe(400);
		expect(body(r).error).toBe('validation_error');
		// The malformed value must never reach the database.
		expect(sqlState.queries.some((c) => /portfolio_snapshots/.test(c.q))).toBe(false);
	});

	it('rejects a fractional window on /asset too', async () => {
		const r = await get('/api/portfolio/asset?chain=solana&id=native&days=1.5', { action: 'asset' });
		expect(r.statusCode).toBe(400);
		expect(body(r).error).toBe('validation_error');
	});

	it('defaults when absent and clamps to 1..365', async () => {
		expect(body(await get('/api/portfolio/history', { action: 'history' })).days).toBe(90);
		expect(body(await get('/api/portfolio/history?days=0', { action: 'history' })).days).toBe(1);
		expect(body(await get('/api/portfolio/history?days=9999', { action: 'history' })).days).toBe(365);
	});
});

describe('asset pricing', () => {
	it('prices native SOL from the SOL spot lane when CoinGecko is throttled', async () => {
		priceState.sol = 42.5;
		priceState.solChange = -1.25;
		const r = await get('/api/portfolio/asset?chain=solana&id=native', { action: 'asset' });
		expect(r.statusCode).toBe(200);
		const b = body(r);
		expect(b.market.price_usd).toBe(42.5);
		expect(b.market.change_24h_pct).toBe(-1.25);
		expect(b.symbol).toBe('SOL');
	});

	it('prices an SPL mint from the token-market cascade, and revalues holdings with it', async () => {
		priceState.token = { price_usd: 2, price_change_24h: 10, market_cap: 1000, volume_24h: 50 };
		balanceState.byAddress[SOL_WALLET] = {
			native: { symbol: 'SOL', amount: 0, usd: 0 },
			tokens: [{ mint: 'MINT111', symbol: 'THREE', decimals: 6, amount: 5, usd: 1 }],
		};
		sqlState.agent = { id: AGENT_ID, name: 'A', wallet_address: null, chain_id: null, meta: { solana_address: SOL_WALLET } };
		const r = await get('/api/portfolio/asset?chain=solana&id=MINT111', { action: 'asset' });
		const b = body(r);
		expect(b.market.price_usd).toBe(2);
		expect(b.market.market_cap_usd).toBe(1000);
		// 5 tokens at $2 beats the $1 the balance provider guessed.
		expect(b.total_usd).toBe(10);
		expect(b.unit_price_usd).toBe(2);
	});

	it('labels an unpriceable mint with a short address, never the chain coin', async () => {
		const r = await get('/api/portfolio/asset?chain=solana&id=THREEsynthetic1111111111111111111111111111', { action: 'asset' });
		const b = body(r);
		expect(b.market).toBeNull();
		expect(b.symbol).not.toBe('SOL');
		expect(b.symbol).toBe('THRE..1111');
	});

	it('validates chain and id before anything else', async () => {
		expect((await get('/api/portfolio/asset?chain=bitcoin&id=native', { action: 'asset' })).statusCode).toBe(400);
		expect((await get('/api/portfolio/asset?chain=solana', { action: 'asset' })).statusCode).toBe(400);
	});

	it('rejects a malformed chain_id', async () => {
		const r = await get('/api/portfolio/asset?chain=evm&id=native&chain_id=abc', { action: 'asset' });
		expect(r.statusCode).toBe(400);
		expect(body(r).error).toBe('validation_error');
	});
});

// The EVM asset lane used to ask Ethereum about every contract, whatever chain
// the wallet was on. Base is the default for an agent wallet, so the single
// most common EVM holding on the platform came back unpriced and unlabelled.
describe('asset EVM chain routing', () => {
	const EVM_WALLET = '0x' + 'ab'.repeat(20);
	const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

	function withEvmWallet(chainId) {
		sqlState.agent = { id: AGENT_ID, name: 'A', wallet_address: EVM_WALLET, chain_id: chainId, meta: {} };
		balanceState.byAddress[EVM_WALLET] = {
			native: { symbol: 'ETH', amount: 0, usd: 0 },
			tokens: [{ contract: USDC_BASE, symbol: null, decimals: null, amount: 25, usd: 0 }],
		};
	}

	it('prices a Base contract on Base, not on Ethereum', async () => {
		withEvmWallet(8453);
		llamaState.byUrl[`https://coins.llama.fi/prices/current/base:${USDC_BASE.toLowerCase()}`] = {
			coins: { [`base:${USDC_BASE.toLowerCase()}`]: { price: 0.9996, symbol: 'USDC', decimals: 6 } },
		};
		const r = await get(`/api/portfolio/asset?chain=evm&id=${USDC_BASE}`, { action: 'asset' });
		expect(r.statusCode).toBe(200);
		const b = body(r);
		expect(b.chain_id).toBe(8453);
		expect(b.market.price_usd).toBe(0.9996);
		// Labelled from the price lane rather than the 0x83..2913 stub.
		expect(b.symbol).toBe('USDC');
		expect(b.decimals).toBe(6);
		// 25 USDC revalued at the lane's price, not the balance provider's $0.
		expect(b.total_usd).toBeCloseTo(24.99, 2);
		expect(llamaState.urls.some((u) => u.includes('ethereum:'))).toBe(false);
		expect(geckoState.paths.some((p) => p.startsWith('/coins/base/contract/'))).toBe(true);
	});

	it('honors a pinned chain_id over the wallet default', async () => {
		withEvmWallet(8453);
		const arb = '0xaf88d065e77c8cC2239327C5EDb3A432268e5831';
		llamaState.byUrl[`https://coins.llama.fi/prices/current/arbitrum:${arb.toLowerCase()}`] = {
			coins: { [`arbitrum:${arb.toLowerCase()}`]: { price: 1.0001, symbol: 'USDC', decimals: 6 } },
		};
		const b = body(await get(`/api/portfolio/asset?chain=evm&id=${arb}&chain_id=42161`, { action: 'asset' }));
		expect(b.chain_id).toBe(42161);
		expect(b.market.price_usd).toBe(1.0001);
		expect(geckoState.paths.some((p) => p.startsWith('/coins/arbitrum-one/contract/'))).toBe(true);
	});

	it('asks no upstream at all for a chain nobody indexes', async () => {
		withEvmWallet(84532);
		const b = body(await get(`/api/portfolio/asset?chain=evm&id=${USDC_BASE}`, { action: 'asset' }));
		expect(b.chain_id).toBe(84532);
		expect(b.market).toBeNull();
		expect(geckoState.paths).toHaveLength(0);
		expect(llamaState.urls).toHaveLength(0);
	});

	it('prices EVM native from the chain gas token, not always ETH', async () => {
		withEvmWallet(137);
		priceState.coin = 0.42;
		const b = body(await get('/api/portfolio/asset?chain=evm&id=native', { action: 'asset' }));
		expect(b.chain_id).toBe(137);
		expect(b.symbol).toBe('POL');
		expect(b.market.price_usd).toBe(0.42);
		// POL's coin id, not the retired `matic-network` and not `ethereum`.
		expect(geckoState.paths.some((p) => p.startsWith('/coins/polygon-ecosystem-token'))).toBe(true);
		expect(geckoState.paths.some((p) => p.startsWith('/coins/ethereum'))).toBe(false);
	});
});

describe('send', () => {
	const base = { agent_id: AGENT_ID, chain: 'solana', asset: 'native', recipient: SOL_WALLET };

	it('rejects a malformed body with a 400 and never loads an agent', async () => {
		const r = await send({ ...base, agent_id: 'not-a-uuid', amount: '1' });
		expect(r.statusCode).toBe(400);
		expect(body(r).error).toBe('validation_error');
		expect(sqlState.queries.some((c) => /from agent_identities/.test(c.q))).toBe(false);
	});

	it('404s an agent the caller does not own', async () => {
		sqlState.agent = null;
		const r = await send({ ...base, amount: '1' });
		expect(r.statusCode).toBe(404);
		expect(body(r).error).toBe('not_found');
	});

	it('refuses an amount that truncates to zero lamports, without signing', async () => {
		sqlState.agent = { id: AGENT_ID, name: 'A', wallet_address: null, chain_id: null, meta: { encrypted_solana_secret: 'enc' } };
		const r = await send({ ...base, amount: '0.0000000001' });
		expect(r.statusCode).toBe(400);
		expect(body(r).error).toBe('validation_error');
		expect(sendState.signed).toHaveLength(0);
	});

	it('signs and broadcasts a real amount', async () => {
		sqlState.agent = { id: AGENT_ID, name: 'A', wallet_address: null, chain_id: null, meta: { encrypted_solana_secret: 'enc' } };
		const r = await send({ ...base, amount: '0.25' });
		expect(r.statusCode).toBe(200);
		expect(body(r).tx_hash).toBe('sig-1');
		expect(sendState.signed).toHaveLength(1);
	});

	it('409s an agent with no key for the requested chain', async () => {
		sqlState.agent = { id: AGENT_ID, name: 'A', wallet_address: '0x' + '1'.repeat(40), chain_id: 8453, meta: {} };
		const r = await send({ ...base, chain: 'evm', recipient: '0x' + '2'.repeat(40), amount: '1' });
		expect(r.statusCode).toBe(409);
		expect(body(r).error).toBe('no_key');
	});

	it('attributes the EVM key use to the signed-in owner', async () => {
		sqlState.agent = { id: AGENT_ID, name: 'A', wallet_address: '0x' + '1'.repeat(40), chain_id: 8453, meta: { encrypted_wallet_key: 'enc' } };
		// The ethers Wallet has no provider transport here, so the broadcast fails;
		// the audit metadata is recorded before that, which is what this pins.
		await send({ ...base, chain: 'evm', recipient: '0x' + '2'.repeat(40), amount: '1' });
		expect(sendState.keyAudit?.userId).toBe(USER.id);
		expect(sendState.keyAudit?.agentId).toBe(AGENT_ID);
	});
});
