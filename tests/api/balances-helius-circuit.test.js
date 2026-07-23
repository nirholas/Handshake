// Circuit-breaker tests for the Helius path in api/_lib/balances.js.
//
// When Helius reports an exhausted plan quota ("max usage reached" / JSON-RPC
// -32429 / HTTP 429) the balance reads must stop calling Helius for the cooldown
// window and serve from the public-RPC fallback instead — otherwise every
// portfolio / networth / holder-gate read burns a doomed Helius round-trip and
// emits a duplicate warning (the 70+-line flood seen in production logs). Fetch
// is fully mocked; no network.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

let fetchCalls = [];
// URL-aware mock: routes by host so the multi-call fallback path (getBalance,
// getTokenAccountsByOwner, Jupiter prices) all resolve without a strict queue.
let heliusBehavior = 'quota'; // 'quota' | 'ok'
// What the public-RPC fallback returns for getTokenAccountsByOwner, per token
// program (the fallback must query BOTH: $THREE and other pump.fun mints are
// Token-2022, invisible to a classic-program-only query).
let fallbackTokenAccounts = []; // classic Tokenkeg program
let fallbackToken2022Accounts = []; // Token-2022 program
vi.stubGlobal('fetch', (url, opts) => {
	const u = String(url);
	fetchCalls.push(u);
	const ok = (status, body) => {
		const resp = {
			ok: status >= 200 && status < 300,
			status,
			statusText: '',
			headers: { get: () => 'application/json' },
			json: async () => body,
			text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
		};
		// The rotating fetch clones a failed response to scan its body for a quota
		// signal; mirror that surface like a real Response.
		resp.clone = () => resp;
		return Promise.resolve(resp);
	};
	if (u.includes('helius-rpc.com')) {
		if (heliusBehavior === 'quota') {
			return ok(429, { jsonrpc: '2.0', error: { code: -32429, message: 'max usage reached' } });
		}
		return ok(200, { result: { nativeBalance: { lamports: 0 }, items: [] } });
	}
	if (u.includes('lite-api.jup.ag')) return ok(200, {});
	if (u.includes('mainnet-beta.solana.com') || (opts && /getBalance|getTokenAccountsByOwner/.test(String(opts.body)))) {
		const body = opts ? String(opts.body) : '';
		if (body.includes('getTokenAccountsByOwner')) {
			const accounts = body.includes('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb')
				? fallbackToken2022Accounts
				: fallbackTokenAccounts;
			return ok(200, { result: { value: accounts } });
		}
		return ok(200, { result: { value: 0 } }); // getBalance
	}
	return ok(200, {});
});

import { getBalances, __resetBalancesBreaker } from '../../api/_lib/balances.js';
import { invalidateBalances } from '../../api/_lib/balances.js';

const ADDR_A = 'AaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAa';
const ADDR_B = 'BbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBb';

const heliusHits = () => fetchCalls.filter((u) => u.includes('helius-rpc.com')).length;

beforeEach(async () => {
	fetchCalls = [];
	heliusBehavior = 'quota';
	fallbackTokenAccounts = [];
	fallbackToken2022Accounts = [];
	process.env.HELIUS_API_KEY = 'test-key';
	__resetBalancesBreaker();
	// Distinct addresses per case dodge the 60s balance cache; clear to be safe.
	await invalidateBalances({ chain: 'solana', address: ADDR_A });
	await invalidateBalances({ chain: 'solana', address: ADDR_B });
});

afterEach(() => {
	delete process.env.HELIUS_API_KEY;
});

describe('balances Helius circuit breaker', () => {
	it('trips on a Helius quota error and skips Helius on the next read', async () => {
		// First read: Helius DAS 429s, breaker trips, falls back to public RPC.
		const a = await getBalances({ chain: 'solana', address: ADDR_A });
		expect(a.chain).toBe('solana');
		expect(heliusHits()).toBeGreaterThan(0); // it tried Helius once

		// Second read (new address → no cache hit): breaker is open, so Helius is
		// not contacted again — straight to the public-RPC fallback.
		fetchCalls = [];
		const b = await getBalances({ chain: 'solana', address: ADDR_B });
		expect(b.chain).toBe('solana');
		expect(heliusHits()).toBe(0);
	});

	it('still reads real token balances through the fallback chain while Helius quota is out', async () => {
		// The production regression behind "site shows You hold $0 of $THREE": with
		// Helius quota-exhausted, the fallback must surface the wallet's actual
		// holdings from BOTH token programs. $THREE is Token-2022, so a classic-
		// program-only query silently dropped it and zeroed every holder tier.
		fallbackTokenAccounts = [
			{
				account: {
					data: {
						parsed: {
							info: {
								mint: 'LEGACYsynthetic11111111111111111111111111111',
								tokenAmount: { uiAmount: 7, decimals: 6 },
							},
						},
					},
				},
			},
		];
		fallbackToken2022Accounts = [
			{
				account: {
					data: {
						parsed: {
							info: {
								mint: 'THREEsynthetic111111111111111111111111111111',
								tokenAmount: { uiAmount: 25000, decimals: 6 },
							},
						},
					},
				},
			},
		];
		const a = await getBalances({ chain: 'solana', address: ADDR_A });
		expect(a.chain).toBe('solana');
		expect(a.tokens).toHaveLength(2);
		const three = a.tokens.find((t) => t.mint === 'THREEsynthetic111111111111111111111111111111');
		expect(three?.amount).toBe(25000);
		const legacy = a.tokens.find((t) => t.mint === 'LEGACYsynthetic11111111111111111111111111111');
		expect(legacy?.amount).toBe(7);
	});

	it('uses Helius normally when the quota is healthy', async () => {
		heliusBehavior = 'ok';
		const a = await getBalances({ chain: 'solana', address: ADDR_A });
		expect(a.chain).toBe('solana');
		expect(heliusHits()).toBeGreaterThan(0);

		// Still healthy → still using Helius (DAS) on the next distinct read.
		fetchCalls = [];
		const b = await getBalances({ chain: 'solana', address: ADDR_B });
		expect(b.chain).toBe('solana');
		expect(heliusHits()).toBeGreaterThan(0);
	});
});
