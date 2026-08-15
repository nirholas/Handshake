// Boundary tests for the api/user batch: the guards that decide whether a
// request is allowed to change a credential or move funds, and the malformed
// input that used to escape as a 5xx.
//
// What is covered here, and why each case exists:
//
//   1. /api/user/x402-subscriptions POST (rotate + revoke) permanently changes
//      a live API credential on nothing but a session cookie. It shipped with
//      no CSRF proof while every sibling session-auth writer required one, so a
//      cross-site form POST could revoke a paying customer's key. The attacker
//      never reads the response; the write is the damage.
//   2. A native rotate mints the replacement BEFORE revoking the old key.
//      Revoking first meant any mint failure left the caller with nothing.
//   3. /api/user/wallet/fund-agent read the destination out of agent_identities
//      meta and handed it straight to `new PublicKey()`. A row whose stored
//      address is not decodable threw past every boundary as an opaque 500.
//   4. /api/user/wallet/history clamped `?limit` only at the top, so a negative
//      limit reached the RPC and came back as a 502 blamed on Solana.

import { Readable } from 'node:stream';
import { describe, it, expect, beforeEach, vi } from 'vitest';

const USER_ID = 'user-1';
const AGENT_ID = '11111111-1111-4111-8111-111111111111';
// Synthetic, deliberately: these cases assert address handling only, so a real
// third-party account would add a claim we do not mean.
const MASTER_WALLET = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU';
const MASTER_EVM = '0x1111111111111111111111111111111111111111';
const AGENT_WALLET = 'GDfnEsia2WLAW5t8yx2X5j2mkfA74i5kK8vY6C4nGRQe';

const authState = { session: { id: USER_ID } };
const csrfState = { ok: true };
const sqlState = { queue: [], calls: [] };
const rpcState = { sigLimit: null, balanceLamports: 5_000_000n, tokenAmount: '2500000', destAtaExists: true };
const keysState = { calls: [], createThrows: null };

vi.mock('../api/_lib/auth.js', () => ({
	getSessionUser: vi.fn(async () => authState.session),
}));

vi.mock('../api/_lib/db.js', () => ({
	// The bootstrap DDL in wallet/index.js runs before the reads a case primes,
	// so it must not eat a queued result. Everything else answers in order.
	sql: vi.fn(async (strings, ...values) => {
		const text = Array.isArray(strings) ? strings.join(' ? ') : String(strings);
		sqlState.calls.push({ text, values });
		if (/CREATE TABLE/i.test(text)) return [];
		return sqlState.queue.length ? sqlState.queue.shift() : [];
	}),
	isDbUnavailableError: () => false,
	isDbCapacityError: () => false,
	isStoragePressured: async () => ({ pressured: false }),
}));

vi.mock('../api/_lib/csrf.js', () => ({
	requireCsrf: vi.fn(async (_req, res) => {
		if (csrfState.ok) return true;
		res.statusCode = 403;
		res.end(JSON.stringify({ error: 'csrf_missing' }));
		return false;
	}),
}));

vi.mock('../api/_lib/rate-limit.js', () => ({
	limits: {
		authIp: vi.fn(async () => ({ success: true })),
		walletRead: vi.fn(async () => ({ success: true })),
		walletSimulate: vi.fn(async () => ({ success: true })),
		withdrawalPerUser: vi.fn(async () => ({ success: true })),
	},
	clientIp: vi.fn(() => '127.0.0.1'),
}));

vi.mock('../api/_lib/usage.js', () => ({ recordEvent: vi.fn(async () => {}) }));
vi.mock('../api/_lib/cache.js', () => ({
	cacheGet: vi.fn(async () => null),
	cacheSet: vi.fn(async () => {}),
}));

// A recovered keypair would mean a real signature. Every case below stops at
// simulate or at a guard, so reaching this mock at all is a test bug.
vi.mock('../api/_lib/agent-wallet.js', () => ({
	recoverSolanaAgentKeypair: vi.fn(async () => {
		throw new Error('test reached key recovery: no case here may sign');
	}),
	generateSolanaAgentWallet: vi.fn(async () => ({
		address: MASTER_WALLET,
		encrypted_secret: 'enc-sol',
	})),
	generateAgentWallet: vi.fn(async () => ({
		address: MASTER_EVM,
		encrypted_key: 'enc-evm',
	})),
	getSolanaAddressBalances: vi.fn(async () => ({
		native: 0.42,
		total_usd: 63,
		tokens: [{ mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', uiAmount: 12.5 }],
	})),
}));

vi.mock('../api/_lib/evm/rpc.js', () => ({
	evmFallbackProvider: vi.fn(async () => ({
		call: vi.fn(async () => '0x' + (7_000_000).toString(16).padStart(64, '0')),
	})),
}));

vi.mock('../api/_lib/provider-keys.js', async () => {
	const actual = await vi.importActual('../api/_lib/provider-keys.js');
	return {
		BYOK_PROVIDERS: actual.BYOK_PROVIDERS,
		// The real one needs JWT_SECRET. What matters at this boundary is that a
		// value is encrypted before it reaches the column and a null deletes the
		// entry, not which cipher ran.
		encryptProviderKey: vi.fn(async (v) => `enc(${v})`),
	};
});

const connection = {
	getBalance: vi.fn(async () => Number(rpcState.balanceLamports)),
	getMinimumBalanceForRentExemption: vi.fn(async () => 2_039_280),
	getTokenAccountBalance: vi.fn(async () => ({ value: { amount: rpcState.tokenAmount } })),
	getAccountInfo: vi.fn(async () => (rpcState.destAtaExists ? { lamports: 1 } : null)),
	getSignaturesForAddress: vi.fn(async (_pk, opts) => {
		rpcState.sigLimit = opts?.limit ?? null;
		return [];
	}),
	getParsedTransactions: vi.fn(async () => []),
};

vi.mock('../api/_lib/agent-pumpfun.js', () => ({
	solanaConnection: vi.fn(() => connection),
	solanaPublicConnection: vi.fn(() => connection),
}));

vi.mock('../api/_lib/x402/api-keys.js', () => ({
	createSubscription: vi.fn(async (args) => {
		keysState.calls.push('create');
		if (keysState.createThrows) throw keysState.createThrows;
		return {
			id: 'sub_new',
			key_prefix: 'x402_newprefix',
			token: 'x402_newplaintext',
			rate_limit_per_minute: args.rateLimitPerMinute,
		};
	}),
	revokeSubscription: vi.fn(async () => {
		keysState.calls.push('revoke');
		return { id: 'sub_old' };
	}),
}));

vi.mock('../api/_lib/aws-marketplace-bridge.js', () => ({
	issueSubscriptionForCustomer: vi.fn(async () => ({
		subscriptionId: 'sub_aws',
		keyPrefix: 'x402_aws',
		token: 'x402_awsplaintext',
		rateLimitPerMinute: 600,
	})),
	revokeSubscriptionForCustomer: vi.fn(async () => 'sub_old'),
}));

const subscriptionsHandler = (await import('../api/user/x402-subscriptions.js')).default;
const fundAgentHandler = (await import('../api/user/wallet/fund-agent.js')).default;
const historyHandler = (await import('../api/user/wallet/history.js')).default;
const walletHandler = (await import('../api/user/wallet/index.js')).default;
const providerKeysHandler = (await import('../api/user/provider-keys.js')).default;

function makeReq({ method, url, body = null }) {
	const raw = body === null ? null : JSON.stringify(body);
	const req = Readable.from(raw === null ? [] : [Buffer.from(raw)]);
	req.method = method;
	req.url = url;
	req.headers = { host: 'localhost', ...(raw === null ? {} : { 'content-type': 'application/json' }) };
	return req;
}

function makeRes() {
	return {
		statusCode: 200,
		headers: {},
		body: '',
		writableEnded: false,
		headersSent: false,
		getHeader(k) { return this.headers[k.toLowerCase()]; },
		setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
		end(chunk) { if (chunk !== undefined) this.body += chunk; this.writableEnded = true; },
	};
}

async function call(handler, { method = 'GET', url, body = null } = {}) {
	const req = makeReq({ method, url, body });
	const res = makeRes();
	await handler(req, res);
	return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
}

const NATIVE_SUB = {
	id: 'sub_old',
	name: 'my key',
	rate_limit_per_minute: 120,
	expires_at: null,
	revoked_at: null,
	meta: { source: 'native' },
	created_by: USER_ID,
};

beforeEach(() => {
	authState.session = { id: USER_ID };
	csrfState.ok = true;
	sqlState.queue = [];
	sqlState.calls = [];
	keysState.calls = [];
	keysState.createThrows = null;
	rpcState.sigLimit = null;
	rpcState.balanceLamports = 5_000_000n;
	rpcState.tokenAmount = '2500000';
	rpcState.destAtaExists = true;
});

describe('x402-subscriptions: CSRF on the write path', () => {
	it('refuses a revoke that carries no CSRF token, before touching the key', async () => {
		csrfState.ok = false;
		const { status } = await call(subscriptionsHandler, {
			method: 'POST',
			url: '/api/user/x402-subscriptions',
			body: { action: 'revoke', id: 'sub_old' },
		});
		expect(status).toBe(403);
		expect(keysState.calls).toEqual([]);
	});

	it('refuses a rotate that carries no CSRF token', async () => {
		csrfState.ok = false;
		const { status } = await call(subscriptionsHandler, {
			method: 'POST',
			url: '/api/user/x402-subscriptions',
			body: { action: 'rotate', id: 'sub_old' },
		});
		expect(status).toBe(403);
		expect(keysState.calls).toEqual([]);
	});

	it('leaves the read path ungated: listing works without a CSRF token', async () => {
		csrfState.ok = false;
		sqlState.queue.push([{ ...NATIVE_SUB, key_prefix: 'x402_old', created_at: '2026-08-01T00:00:00Z' }]);
		const { status, body } = await call(subscriptionsHandler, {
			method: 'GET',
			url: '/api/user/x402-subscriptions',
		});
		expect(status).toBe(200);
		expect(body.subscriptions).toHaveLength(1);
		expect(body.subscriptions[0].status).toBe('active');
	});

	it('still refuses a caller who is not signed in', async () => {
		authState.session = null;
		const { status, body } = await call(subscriptionsHandler, {
			method: 'POST',
			url: '/api/user/x402-subscriptions',
			body: { action: 'revoke', id: 'sub_old' },
		});
		expect(status).toBe(401);
		expect(body.error).toBe('unauthenticated');
	});
});

describe('x402-subscriptions: native rotate ordering', () => {
	it('mints the replacement before revoking the old key', async () => {
		sqlState.queue.push([NATIVE_SUB]);
		const { status, body } = await call(subscriptionsHandler, {
			method: 'POST',
			url: '/api/user/x402-subscriptions',
			body: { action: 'rotate', id: 'sub_old' },
		});
		expect(status).toBe(200);
		expect(keysState.calls).toEqual(['create', 'revoke']);
		expect(body.subscription.token).toBe('x402_newplaintext');
	});

	it('leaves the old key alive when the mint fails', async () => {
		keysState.createThrows = new Error('subscription name is required');
		sqlState.queue.push([NATIVE_SUB]);
		const { status, body } = await call(subscriptionsHandler, {
			method: 'POST',
			url: '/api/user/x402-subscriptions',
			body: { action: 'rotate', id: 'sub_old' },
		});
		expect(status).toBe(502);
		expect(body.error).toBe('rotate_failed');
		expect(keysState.calls).toEqual(['create']);
	});

	it('404s a subscription owned by somebody else rather than acting on it', async () => {
		sqlState.queue.push([{ ...NATIVE_SUB, created_by: 'someone-else' }]);
		const { status, body } = await call(subscriptionsHandler, {
			method: 'POST',
			url: '/api/user/x402-subscriptions',
			body: { action: 'revoke', id: 'sub_old' },
		});
		expect(status).toBe(404);
		expect(body.error).toBe('subscription_not_found');
		expect(keysState.calls).toEqual([]);
	});
});

describe('wallet/fund-agent: the agent address it was handed', () => {
	function primeWalletAndAgent(agentMeta) {
		sqlState.queue.push([{ solana_address: MASTER_WALLET, encrypted_solana_secret: 'enc' }]);
		sqlState.queue.push([{ id: AGENT_ID, meta: agentMeta }]);
	}

	it('names an undecodable stored address instead of throwing a 500', async () => {
		primeWalletAndAgent({ solana_address: 'not-a-real-solana-address' });
		const { status, body } = await call(fundAgentHandler, {
			method: 'POST',
			url: '/api/user/wallet/fund-agent',
			body: { agent_id: AGENT_ID, amount: 1, asset: 'USDC', simulate: true },
		});
		expect(status).toBe(422);
		expect(body.error).toBe('agent_wallet_invalid');
	});

	it('still simulates a real USDC transfer against a valid agent wallet', async () => {
		primeWalletAndAgent({ solana_address: AGENT_WALLET });
		const { status, body } = await call(fundAgentHandler, {
			method: 'POST',
			url: '/api/user/wallet/fund-agent',
			body: { agent_id: AGENT_ID, amount: 1.5, asset: 'USDC', simulate: true },
		});
		expect(status).toBe(200);
		expect(body.simulation.agent_wallet).toBe(AGENT_WALLET);
		expect(body.simulation.human_amount).toBe(1.5);
		expect(body.simulation.creates_token_account).toBe(false);
	});

	it('rejects an agent that has no wallet at all', async () => {
		primeWalletAndAgent({});
		const { status, body } = await call(fundAgentHandler, {
			method: 'POST',
			url: '/api/user/wallet/fund-agent',
			body: { agent_id: AGENT_ID, amount: 1, asset: 'USDC', simulate: true },
		});
		expect(status).toBe(400);
		expect(body.error).toBe('no_agent_wallet');
	});
});

describe('wallet/history: limit clamping', () => {
	it('clamps a negative limit instead of passing it to the RPC', async () => {
		sqlState.queue.push([{ solana_address: MASTER_WALLET }]);
		const { status } = await call(historyHandler, {
			method: 'GET',
			url: '/api/user/wallet/history?limit=-5',
		});
		expect(status).toBe(200);
		expect(rpcState.sigLimit).toBe(1);
	});

	it('still caps an oversized limit at 50', async () => {
		sqlState.queue.push([{ solana_address: MASTER_WALLET }]);
		const { status } = await call(historyHandler, {
			method: 'GET',
			url: '/api/user/wallet/history?limit=9999',
		});
		expect(status).toBe(200);
		expect(rpcState.sigLimit).toBe(50);
	});

	it('answers an empty history for a user with no master wallet', async () => {
		sqlState.queue.push([]);
		const { status, body } = await call(historyHandler, {
			method: 'GET',
			url: '/api/user/wallet/history',
		});
		expect(status).toBe(200);
		expect(body.history).toEqual([]);
	});
});

// The two suites below cover the success paths a local curl cannot reach:
// both need JWT_SECRET to derive an encryption key, and this worktree's env
// carries only the QA login and DATABASE_URL. Creating a real master wallet
// under a throwaway key would write an undecryptable row into the shared
// production database, so the coverage lives here instead.
describe('wallet index: create and read', () => {
	it('creates a master wallet and reports it as new', async () => {
		sqlState.queue.push([]); // no existing wallet
		sqlState.queue.push([{ solana_address: MASTER_WALLET, evm_address: MASTER_EVM, created_at: '2026-08-15T00:00:00Z' }]);
		const { status, body } = await call(walletHandler, {
			method: 'POST',
			url: '/api/user/wallet',
			body: {},
		});
		expect(status).toBe(201);
		expect(body.wallet.created).toBe(true);
		expect(body.wallet.solana_address).toBe(MASTER_WALLET);
		expect(body.wallet.evm_address).toBe(MASTER_EVM);
	});

	it('is idempotent: a second create returns the existing wallet, not a new one', async () => {
		sqlState.queue.push([{ solana_address: MASTER_WALLET, evm_address: MASTER_EVM, created_at: '2026-08-15T00:00:00Z' }]);
		const { status, body } = await call(walletHandler, {
			method: 'POST',
			url: '/api/user/wallet',
			body: {},
		});
		expect(status).toBe(200);
		expect(body.wallet.created).toBe(false);
		expect(sqlState.calls.some((c) => /INSERT INTO master_wallets/i.test(c.text))).toBe(false);
	});

	it('refuses a create with no CSRF token', async () => {
		csrfState.ok = false;
		const { status } = await call(walletHandler, { method: 'POST', url: '/api/user/wallet', body: {} });
		expect(status).toBe(403);
		expect(sqlState.calls.some((c) => /INSERT INTO master_wallets/i.test(c.text))).toBe(false);
	});

	it('reads live balances and totals SOL value with EVM USDC', async () => {
		sqlState.queue.push([{ solana_address: MASTER_WALLET, evm_address: MASTER_EVM, created_at: '2026-08-15T00:00:00Z' }]);
		const { status, body } = await call(walletHandler, { method: 'GET', url: '/api/user/wallet' });
		expect(status).toBe(200);
		expect(body.wallet.balances).toEqual({
			sol: 0.42,
			sol_usdc: 12.5,
			evm_usdc: 7,
			total_usd: 70,
		});
	});

	it('answers a null wallet rather than 404 for a user who has none', async () => {
		sqlState.queue.push([]);
		const { status, body } = await call(walletHandler, { method: 'GET', url: '/api/user/wallet' });
		expect(status).toBe(200);
		expect(body.wallet).toBeNull();
	});
});

describe('provider-keys: set, clear, and what never leaves', () => {
	it('reports which keys are set and never the values', async () => {
		sqlState.queue.push([{ provider_keys: { openai: 'enc(sk-live)' } }]);
		const { status, body } = await call(providerKeysHandler, { method: 'GET', url: '/api/user/provider-keys' });
		expect(status).toBe(200);
		expect(body.keys.openai).toEqual({ set: true });
		expect(body.keys.anthropic).toEqual({ set: false });
		expect(res_body_has_secret(body)).toBe(false);
	});

	it('encrypts a new value before it reaches the column', async () => {
		sqlState.queue.push([{ provider_keys: {} }]);
		const { status, body } = await call(providerKeysHandler, {
			method: 'PATCH',
			url: '/api/user/provider-keys',
			body: { openai: '  sk-plaintext  ' },
		});
		expect(status).toBe(200);
		expect(body.keys.openai).toEqual({ set: true });
		const update = sqlState.calls.find((c) => /UPDATE users SET provider_keys/i.test(c.text));
		expect(update.values[0]).toBe(JSON.stringify({ openai: 'enc(sk-plaintext)' }));
	});

	it('deletes the entry when a provider is set to null', async () => {
		sqlState.queue.push([{ provider_keys: { openai: 'enc(sk-old)', grok: 'enc(xai-old)' } }]);
		const { status, body } = await call(providerKeysHandler, {
			method: 'PATCH',
			url: '/api/user/provider-keys',
			body: { openai: null },
		});
		expect(status).toBe(200);
		expect(body.keys.openai).toEqual({ set: false });
		expect(body.keys.grok).toEqual({ set: true });
		const update = sqlState.calls.find((c) => /UPDATE users SET provider_keys/i.test(c.text));
		expect(JSON.parse(update.values[0])).toEqual({ grok: 'enc(xai-old)' });
	});

	it('rejects a non-string value with a 400 naming the field', async () => {
		const { status, body } = await call(providerKeysHandler, {
			method: 'PATCH',
			url: '/api/user/provider-keys',
			body: { openai: 123 },
		});
		expect(status).toBe(400);
		expect(body.error).toBe('validation_error');
		expect(body.error_description).toContain('openai');
	});

	it('refuses a write with no CSRF token', async () => {
		csrfState.ok = false;
		const { status } = await call(providerKeysHandler, {
			method: 'PATCH',
			url: '/api/user/provider-keys',
			body: { openai: 'sk-plaintext' },
		});
		expect(status).toBe(403);
		expect(sqlState.calls.some((c) => /UPDATE users SET provider_keys/i.test(c.text))).toBe(false);
	});
});

// The GET contract is that a stored ciphertext never appears in the response.
function res_body_has_secret(body) {
	return JSON.stringify(body).includes('enc(');
}
