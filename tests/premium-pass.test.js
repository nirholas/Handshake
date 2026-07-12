// Coverage for api/_lib/premium.js — the monthly premium pass.
//
// Guards the money paths:
//   - USD → asset conversion for all three assets ($THREE discount included),
//   - quote creation builds a deserializable unsigned Solana transaction,
//   - on-chain verification (balance-delta, signer check, SOL + SPL lanes,
//     failed/pending transactions),
//   - activation: period append on renewal, key mint vs extend, SIWX grants,
//     and idempotency when the same tx is claimed twice.
//
// DB, oracles, RPC, key mint, and SIWX storage are mocked; @solana/web3.js and
// @solana/spl-token run for real so the built transaction is genuine.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Keypair, VersionedTransaction } from '@solana/web3.js';

const TREASURY = 'wwwwwDxFWRn7grgr3Esrsg5C6NvDoDHSA4gaCffccrU';
const THREE_MINT = 'FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const BUYER = Keypair.generate().publicKey.toBase58();

const db = vi.hoisted(() => ({ handlers: [], calls: [] }));
const rpcMock = vi.hoisted(() => ({ getParsedTransaction: null }));
const siwxCalls = vi.hoisted(() => []);
const keyMints = vi.hoisted(() => []);

vi.mock('../api/_lib/db.js', () => ({
	sql: async (strings, ...values) => {
		const text = strings.join(' $ ').replace(/\s+/g, ' ');
		db.calls.push({ text, values });
		for (const h of db.handlers) {
			if (h.match.test(text)) return h.result(values, text);
		}
		return [];
	},
}));
vi.mock('../api/_lib/env.js', () => ({
	env: {
		X402_PAY_TO_SOLANA: 'wwwwwDxFWRn7grgr3Esrsg5C6NvDoDHSA4gaCffccrU',
		X402_ASSET_MINT_SOLANA: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
		THREE_TOKEN_MINT: 'FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump',
		THREE_TOKEN_DECIMALS: 6,
	},
}));
vi.mock('../api/_lib/sol-price.js', () => ({ solPriceUsd: async () => 150 }));
vi.mock('../api/_lib/token/price.js', () => ({
	getTokenPriceUsd: async () => ({ priceUsd: 0.002, source: 'test-oracle' }),
}));
vi.mock('../api/_lib/x402/api-keys.js', () => ({
	createSubscription: async (opts) => {
		keyMints.push(opts);
		return { id: `sub_${keyMints.length}`, key_prefix: 'x402_live_TESTKE', token: 'x402_live_TESTKEY_PLAINTEXT' };
	},
	revokeSubscription: async () => ({}),
}));
vi.mock('../api/_lib/siwx-storage.js', () => ({
	siwxStorage: { recordPayment: async (...args) => { siwxCalls.push(args); } },
}));
vi.mock('../api/_lib/solana/connection.js', () => ({
	solanaConnection: () => ({
		getLatestBlockhash: async () => ({ blockhash: '9sHcv6xwn9YkB8nxTUGKDwPwNnmqVp5oAXxU8Fdkm4J6' }),
	}),
}));
vi.mock('../api/_lib/solana/rpc-fallback.js', () => ({
	rpcFallbackFromEnv: () => ({ withFallback: (fn) => fn(rpcMock) }),
}));

const premium = await import('../api/_lib/premium.js');

beforeEach(() => {
	db.handlers.length = 0;
	db.calls.length = 0;
	siwxCalls.length = 0;
	keyMints.length = 0;
	rpcMock.getParsedTransaction = null;
	delete process.env.PREMIUM_PASS_USD;
	delete process.env.PREMIUM_PASS_THREE_DISCOUNT;
	for (const t of ['DEVELOPER', 'PRO', 'ENTERPRISE']) {
		delete process.env[`PREMIUM_PRICE_${t}`];
		delete process.env[`PREMIUM_RATE_LIMIT_${t}`];
	}
});

// ── Plan catalog ─────────────────────────────────────────────────────────────

describe('plans', () => {
	it('exposes three tiers with ascending price and throughput', () => {
		const plans = premium.listPlans();
		expect(plans.map((p) => p.id)).toEqual(['developer', 'pro', 'enterprise']);
		expect(plans.map((p) => p.usd)).toEqual([19.99, 99, 499]);
		expect(plans.map((p) => p.rateLimitPerMinute)).toEqual([120, 600, 2000]);
		expect(plans.map((p) => p.commercial)).toEqual([false, true, true]);
	});

	it('maps the legacy plan id "premium" (pre-tier rows) to developer', () => {
		expect(premium.planById('premium').id).toBe('developer');
		expect(premium.planById(undefined).id).toBe('developer');
	});

	it('rejects unknown plan ids', () => {
		expect(() => premium.planById('mega')).toThrow(/plan must be one of/);
	});

	it('per-tier env overrides reprice live', () => {
		process.env.PREMIUM_PRICE_PRO = '49';
		process.env.PREMIUM_RATE_LIMIT_PRO = '900';
		const pro = premium.planById('pro');
		expect(pro.usd).toBe(49);
		expect(pro.rateLimitPerMinute).toBe(900);
	});
});

// ── Pricing ──────────────────────────────────────────────────────────────────

describe('priceAsset', () => {
	it('USDC is parity: developer $19.99 → 19990000 atomics', async () => {
		const p = await premium.priceAsset('USDC');
		expect(p.atomics).toBe(19_990_000n);
		expect(p.priceSource).toBe('parity');
	});

	it('SOL converts at the oracle price', async () => {
		const p = await premium.priceAsset('SOL');
		expect(p.atomics).toBe(BigInt(Math.ceil((19.99 / 150) * 1e9)));
		expect(p.assetUsd).toBe(150);
	});

	it('$THREE gets the discount: $19.99 −20% at $0.002 → ~7,996 THREE', async () => {
		const p = await premium.priceAsset('THREE');
		// 19.99 * 0.8 = 15.992 → rounded to 15.99 USD, / 0.002 = 7995 THREE
		expect(p.usd).toBe(15.99);
		expect(p.atomics).toBe(BigInt(Math.ceil((15.99 / 0.002) * 1e6)));
	});

	it('prices the requested tier, not just the entry one', async () => {
		const p = await premium.priceAsset('USDC', premium.planById('pro'));
		expect(p.atomics).toBe(99_000_000n);
	});

	it('rejects unknown assets and malformed wallets', async () => {
		await expect(premium.priceAsset('DOGE')).rejects.toMatchObject({ code: 'bad_asset' });
		expect(() => premium.assertWallet('not-a-wallet')).toThrow();
	});
});

// ── Quote ────────────────────────────────────────────────────────────────────

describe('createQuote', () => {
	it('persists the locked quote and returns a deserializable unsigned tx', async () => {
		db.handlers.push({
			match: /insert into premium_quotes/,
			result: (values) => [{
				id: 'q-1', wallet: BUYER, plan: 'premium', asset: 'THREE',
				amount_atomics: values[3], usd_price: values[4], expires_at: 'soon',
			}],
		});
		const { quote, tx_base64 } = await premium.createQuote({ wallet: BUYER, asset: 'THREE' });
		expect(quote.id).toBe('q-1');
		const tx = VersionedTransaction.deserialize(Buffer.from(tx_base64, 'base64'));
		// buyer is the fee payer; ATA-idempotent + transferChecked instructions
		expect(tx.message.staticAccountKeys[0].toBase58()).toBe(BUYER);
		expect(tx.message.compiledInstructions.length).toBe(2);
	});

	it('native SOL quote is a single SystemProgram transfer', async () => {
		db.handlers.push({
			match: /insert into premium_quotes/,
			result: () => [{ id: 'q-sol', wallet: BUYER, asset: 'SOL', amount_atomics: '66600000', usd_price: 9.99, expires_at: 'soon' }],
		});
		const { tx_base64 } = await premium.createQuote({ wallet: BUYER, asset: 'SOL' });
		const tx = VersionedTransaction.deserialize(Buffer.from(tx_base64, 'base64'));
		expect(tx.message.compiledInstructions.length).toBe(1);
	});
});

// ── Verification ─────────────────────────────────────────────────────────────

function parsedSplTx({ delta = 1000n, signer = BUYER, err = null, mint = THREE_MINT, owner = TREASURY } = {}) {
	return {
		meta: {
			err,
			preTokenBalances: [{ mint, owner, uiTokenAmount: { amount: '5000' } }],
			postTokenBalances: [{ mint, owner, uiTokenAmount: { amount: String(5000n + delta) } }],
		},
		transaction: { message: { accountKeys: [{ pubkey: signer, signer: true }, { pubkey: TREASURY, signer: false }] } },
	};
}

describe('verifyPassPayment', () => {
	const quote = { wallet: BUYER, asset: 'THREE', amount_atomics: '1000' };

	it('accepts a landed SPL transfer that covers the quote', async () => {
		rpcMock.getParsedTransaction = async () => parsedSplTx({ delta: 1000n });
		expect(await premium.verifyPassPayment(quote, 'sig')).toEqual({ ok: true });
	});

	it('rejects when the treasury delta is short', async () => {
		rpcMock.getParsedTransaction = async () => parsedSplTx({ delta: 999n });
		const v = await premium.verifyPassPayment(quote, 'sig');
		expect(v.ok).toBe(false);
		expect(v.reason).toContain('need 1000');
	});

	it('rejects when the quoted wallet did not sign (someone else’s tx)', async () => {
		rpcMock.getParsedTransaction = async () => parsedSplTx({ signer: Keypair.generate().publicKey.toBase58() });
		const v = await premium.verifyPassPayment(quote, 'sig');
		expect(v.ok).toBe(false);
		expect(v.reason).toContain('did not sign');
	});

	it('reports pending (not failure) while the tx is unconfirmed', async () => {
		rpcMock.getParsedTransaction = async () => null;
		const v = await premium.verifyPassPayment(quote, 'sig');
		expect(v.ok).toBe(false);
		expect(v.pending).toBe(true);
	});

	it('rejects a reverted transaction', async () => {
		rpcMock.getParsedTransaction = async () => parsedSplTx({ err: { InstructionError: [0, 'Custom'] } });
		const v = await premium.verifyPassPayment(quote, 'sig');
		expect(v.ok).toBe(false);
	});

	it('verifies native SOL by lamport delta to the treasury', async () => {
		rpcMock.getParsedTransaction = async () => ({
			meta: { err: null, preBalances: [500, 100], postBalances: [400, 200] },
			transaction: { message: { accountKeys: [{ pubkey: BUYER, signer: true }, { pubkey: TREASURY, signer: false }] } },
		});
		const solQuote = { wallet: BUYER, asset: 'SOL', amount_atomics: '100' };
		expect(await premium.verifyPassPayment(solQuote, 'sig')).toEqual({ ok: true });
		const short = await premium.verifyPassPayment({ ...solQuote, amount_atomics: '101' }, 'sig');
		expect(short.ok).toBe(false);
	});
});

// ── Activation ───────────────────────────────────────────────────────────────

const QUOTE = {
	id: 'q-1', wallet: BUYER, plan: 'premium', asset: 'THREE',
	amount_atomics: '3995000000', usd_price: 7.99, user_id: null,
};

describe('activatePass', () => {
	it('first purchase: claims the quote, mints a key, inserts the pass, records SIWX grants', async () => {
		db.handlers.push(
			{ match: /update premium_quotes/, result: () => [{ id: 'q-1' }] },
			{ match: /select \* from premium_passes where wallet/, result: () => [] },
			{ match: /insert into premium_passes/, result: (v) => [{ id: 'pass-1', wallet: BUYER, expires_at: v[10] }] },
		);
		const out = await premium.activatePass({ quote: QUOTE, txSignature: 'sig-1' });
		expect(out.pass.id).toBe('pass-1');
		expect(out.apiKey).toBe('x402_live_TESTKEY_PLAINTEXT');
		expect(out.renewed).toBe(false);
		expect(keyMints[0].meta).toMatchObject({ source: 'premium-pass', wallet: BUYER });
		// one SIWX grant per premium resource, TTL ≈ 30 days
		expect(siwxCalls.length).toBe(premium.PREMIUM_RESOURCES.length);
		const [resource, address, opts] = siwxCalls[0];
		expect(premium.PREMIUM_RESOURCES).toContain(resource);
		expect(address).toBe(BUYER);
		expect(opts.ttlSeconds).toBeGreaterThan(29 * 86400);
	});

	it('renewal: appends the period at the previous expiry and extends the existing key', async () => {
		const prevExpiry = new Date(Date.now() + 5 * 86400_000).toISOString();
		db.handlers.push(
			{ match: /update premium_quotes/, result: () => [{ id: 'q-1' }] },
			{ match: /select \* from premium_passes where wallet/, result: () => [{ id: 'pass-0', wallet: BUYER, expires_at: prevExpiry, api_subscription_id: 'sub_prev' }] },
			{ match: /update x402_subscriptions/, result: () => [{ id: 'sub_prev' }] },
			{ match: /insert into premium_passes/, result: (v) => [{ id: 'pass-2', started_at: v[9], expires_at: v[10] }] },
		);
		const out = await premium.activatePass({ quote: QUOTE, txSignature: 'sig-2' });
		expect(out.renewed).toBe(true);
		expect(out.apiKey).toBeNull(); // existing key extended, no new plaintext
		expect(keyMints.length).toBe(0);
		// the new period starts where the old one ended — no lost days
		expect(new Date(out.pass.started_at).toISOString()).toBe(prevExpiry);
		expect(new Date(out.pass.expires_at).getTime()).toBe(new Date(prevExpiry).getTime() + 30 * 86400_000);
	});

	it('same tx claimed twice returns the already-issued pass, never a second key', async () => {
		db.handlers.push(
			{ match: /update premium_quotes/, result: () => [] }, // claim lost
			{ match: /select \* from premium_passes where tx_signature/, result: () => [{ id: 'pass-1', wallet: BUYER }] },
		);
		const out = await premium.activatePass({ quote: QUOTE, txSignature: 'sig-1' });
		expect(out.pass.id).toBe('pass-1');
		expect(out.apiKey).toBeNull();
		expect(keyMints.length).toBe(0);
	});

	it('a pro purchase mints a 600/min key labelled with the tier', async () => {
		db.handlers.push(
			{ match: /update premium_quotes/, result: () => [{ id: 'q-pro' }] },
			{ match: /select \* from premium_passes where wallet/, result: () => [] },
			{ match: /insert into premium_passes/, result: () => [{ id: 'pass-pro' }] },
		);
		await premium.activatePass({ quote: { ...QUOTE, id: 'q-pro', plan: 'pro' }, txSignature: 'sig-pro' });
		expect(keyMints[0].rateLimitPerMinute).toBe(600);
		expect(keyMints[0].name).toContain('Pro');
		expect(keyMints[0].meta.plan).toBe('pro');
	});

	it('an upgrade purchase retiers the existing key to the new rate limit', async () => {
		const prevExpiry = new Date(Date.now() + 5 * 86400_000).toISOString();
		let retieredTo = null;
		db.handlers.push(
			{ match: /update premium_quotes/, result: () => [{ id: 'q-up' }] },
			{ match: /select \* from premium_passes where wallet/, result: () => [{ id: 'pass-0', wallet: BUYER, expires_at: prevExpiry, api_subscription_id: 'sub_prev' }] },
			{ match: /update x402_subscriptions/, result: (values) => { retieredTo = values.find((v) => typeof v === 'number'); return [{ id: 'sub_prev' }]; } },
			{ match: /insert into premium_passes/, result: () => [{ id: 'pass-up' }] },
		);
		await premium.activatePass({ quote: { ...QUOTE, id: 'q-up', plan: 'enterprise' }, txSignature: 'sig-up' });
		expect(retieredTo).toBe(2000);
	});

	it('a claimed quote with no matching pass is a hard conflict', async () => {
		db.handlers.push(
			{ match: /update premium_quotes/, result: () => [] },
			{ match: /select \* from premium_passes where tx_signature/, result: () => [] },
		);
		await expect(premium.activatePass({ quote: QUOTE, txSignature: 'sig-x' }))
			.rejects.toMatchObject({ code: 'quote_used' });
	});
});
